import Dexie, { type Table } from "dexie";
import { writable, type Readable } from "svelte/store";
import {
  createAddedEvent,
  createHolding,
  findDuplicate,
  MAX_HOLDING_QUANTITY,
  makeId,
  normalizeHoldingQuantity,
  replayCollection,
  snapshotPriceQuote,
  type AddHoldingInput,
} from "./collection";
import { normalizeCurrency } from "./money";
import type {
  CardCondition,
  CardFinish,
  CatalogCard,
  CollectionEvent,
  CollectionSnapshot,
  Holding,
  Money,
  PriceQuote,
} from "./types";

type ClientMeta = { key: string; value: string };
type UnknownRecord = Record<string, unknown>;
type ImportSource = "restore" | "remote";

type ImportOptions =
  | { source: "restore"; mode: "merge"; confirmed?: never; subject?: never }
  | { source: "restore"; mode: "replace"; confirmed: true; subject?: never }
  | { source: "remote"; subject: string };

class CardScopeDatabase extends Dexie {
  events!: Table<CollectionEvent, string>;
  meta!: Table<ClientMeta, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      events: "&id, occurredAt, holdingId, type, syncedAt",
      meta: "&key",
    });
  }
}

const emptySnapshot: CollectionSnapshot = {
  holdings: [],
  activities: [],
  eventCount: 0,
};
const EVENT_TYPES = new Set<CollectionEvent["type"]>([
  "holding.added",
  "holding.quantity-adjusted",
  "holding.updated",
  "holding.removed",
]);
const FINISHES = new Set<CardFinish>([
  "normal",
  "reverse",
  "holo",
  "first-edition",
  "other",
]);
const CONDITIONS = new Set<CardCondition>([
  "mint",
  "near-mint",
  "excellent",
  "good",
  "played",
  "poor",
]);

function syncNamespace(subject: string): string {
  return `sync:${encodeURIComponent(subject)}:`;
}

function cursorKey(subject: string): string {
  return `${syncNamespace(subject)}cursor`;
}

function ackKey(subject: string, eventId: string): string {
  return `${syncNamespace(subject)}ack:${eventId}`;
}

function ownerKey(eventId: string): string {
  return `sync-owner:${eventId}`;
}

const ANONYMOUS_DOMAIN = "collection-domain:anonymous";
const ACCOUNT_DOMAIN_PREFIX = "collection-domain:account:";

function accountDomain(subject: string): string {
  return `${ACCOUNT_DOMAIN_PREFIX}${encodeURIComponent(subject)}`;
}

function domainForSubject(subject: string | null): string {
  return subject === null ? ANONYMOUS_DOMAIN : accountDomain(subject);
}

function normalizeSubject(subject: string): string {
  const normalized = subject.trim();
  if (!normalized || normalized.length > 512)
    throw new Error("Invalid sync subject");
  return normalized;
}

export class CollectionRepository {
  private database: CardScopeDatabase | null = null;
  private readonly state = writable<CollectionSnapshot>(emptySnapshot);
  private deviceId = "";
  private activeSyncSubject: string | null = null;
  readonly snapshot: Readable<CollectionSnapshot> = {
    subscribe: this.state.subscribe,
  };

  constructor(private readonly databaseName = "cardscope") {}

  async init(): Promise<void> {
    if (this.database) return;
    this.database = new CardScopeDatabase(this.databaseName);
    const meta = await this.database.meta.get("device-id");
    this.deviceId = meta?.value ?? makeId("device");
    if (!meta)
      await this.database.meta.put({ key: "device-id", value: this.deviceId });
    await this.database.transaction(
      "rw",
      this.database.events,
      this.database.meta,
      async () => {
        const [events, metadata] = await Promise.all([
          this.database!.events.toArray(),
          this.database!.meta.toArray(),
        ]);
        const byKey = new Map(metadata.map((item) => [item.key, item.value]));
        const ownership: ClientMeta[] = [];
        for (const event of events) {
          const key = ownerKey(event.id);
          const existing = byKey.get(key);
          if (!existing) ownership.push({ key, value: ANONYMOUS_DOMAIN });
          else if (
            existing !== ANONYMOUS_DOMAIN &&
            !existing.startsWith(ACCOUNT_DOMAIN_PREFIX)
          ) {
            // Pre-domain builds stored a raw OIDC subject. Preserve that owner;
            // truly unowned legacy events above are migrated to anonymous.
            ownership.push({ key, value: accountDomain(existing) });
          }
        }
        if (ownership.length) await this.database!.meta.bulkPut(ownership);
      },
    );
    await this.refresh();
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.activeSyncSubject = null;
  }

  async add(input: AddHoldingInput): Promise<Holding> {
    this.requireDatabase();
    const events = await this.eventsForDomain(
      domainForSubject(this.activeSyncSubject),
    );
    const snapshot = replayCollection(events);
    const quantity = normalizeHoldingQuantity(input.quantity ?? 1);
    const duplicate = findDuplicate(snapshot, input);
    if (duplicate) {
      if (duplicate.quantity + quantity > MAX_HOLDING_QUANTITY)
        throw new RangeError("Holding quantity exceeds collection limits");
      const event: CollectionEvent = {
        id: makeId("event"),
        type: "holding.quantity-adjusted",
        holdingId: duplicate.id,
        deviceId: this.deviceId,
        occurredAt: new Date().toISOString(),
        payload: { delta: quantity },
      };
      await this.append(event);
      return duplicate;
    }
    const holding = createHolding(input);
    await this.append(createAddedEvent(holding, this.deviceId));
    return holding;
  }

  async adjustQuantity(holdingId: string, delta: number): Promise<void> {
    if (
      !Number.isSafeInteger(delta) ||
      delta === 0 ||
      Math.abs(delta) > MAX_HOLDING_QUANTITY
    )
      throw new RangeError("Quantity adjustment exceeds collection limits");
    const snapshot = replayCollection(
      await this.eventsForDomain(domainForSubject(this.activeSyncSubject)),
    );
    const holding = snapshot.holdings.find((item) => item.id === holdingId);
    if (!holding)
      throw new Error(
        "Cannot modify a holding outside the active collection domain",
      );
    const nextQuantity = holding.quantity + delta;
    if (nextQuantity < 0 || nextQuantity > MAX_HOLDING_QUANTITY)
      throw new RangeError("Quantity adjustment exceeds collection limits");
    await this.append({
      id: makeId("event"),
      type: "holding.quantity-adjusted",
      holdingId,
      deviceId: this.deviceId,
      occurredAt: new Date().toISOString(),
      payload: { delta },
    });
  }

  async update(
    holdingId: string,
    patch: {
      finish?: CardFinish;
      condition?: CardCondition;
      unitCost?: Money | null;
      note?: string | null;
      quote?: PriceQuote | null;
    },
  ): Promise<void> {
    const normalizedPatch =
      patch.quote === undefined
        ? patch
        : {
            ...patch,
            quote:
              patch.quote === null ? null : snapshotPriceQuote(patch.quote),
          };
    await this.append({
      id: makeId("event"),
      type: "holding.updated",
      holdingId,
      deviceId: this.deviceId,
      occurredAt: new Date().toISOString(),
      payload: normalizedPatch,
    });
  }

  async remove(holdingId: string): Promise<void> {
    await this.append({
      id: makeId("event"),
      type: "holding.removed",
      holdingId,
      deviceId: this.deviceId,
      occurredAt: new Date().toISOString(),
      payload: {},
    });
  }

  async allEvents(): Promise<CollectionEvent[]> {
    return (
      await this.eventsForDomain(domainForSubject(this.activeSyncSubject))
    ).sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
  }

  async setSyncSubject(subject: string | null): Promise<boolean> {
    this.requireDatabase();
    const normalized = subject === null ? null : normalizeSubject(subject);
    const previous = this.activeSyncSubject;
    if (previous === normalized) return false;
    this.activeSyncSubject = normalized;
    await this.refresh();
    return previous !== null && normalized !== null && previous !== normalized;
  }

  async unsyncedEvents(
    subject: string,
    limit = 100,
  ): Promise<CollectionEvent[]> {
    const normalized = normalizeSubject(subject);
    if (this.activeSyncSubject !== normalized) return [];
    const domain = accountDomain(normalized);
    const database = this.requireDatabase();
    return database.transaction(
      "r",
      database.events,
      database.meta,
      async () => {
        const [events, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const meta = new Map(metadata.map((item) => [item.key, item.value]));
        return events
          .filter((event) => {
            const owner = meta.get(ownerKey(event.id));
            return owner === domain && !meta.has(ackKey(normalized, event.id));
          })
          .sort(
            (left, right) =>
              left.occurredAt.localeCompare(right.occurredAt) ||
              left.id.localeCompare(right.id),
          )
          .slice(0, limit);
      },
    );
  }

  async markSynced(
    subject: string,
    ids: string[],
    syncedAt = new Date().toISOString(),
  ): Promise<void> {
    const normalized = normalizeSubject(subject);
    if (this.activeSyncSubject !== normalized)
      throw new Error("Cannot acknowledge an inactive account domain");
    const domain = accountDomain(normalized);
    if (!isIsoDate(syncedAt)) throw new Error("Invalid sync timestamp");
    const uniqueIds = [...new Set(ids)];
    const database = this.requireDatabase();
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        const events = await database.events.bulkGet(uniqueIds);
        const metadata: ClientMeta[] = [];
        for (let index = 0; index < uniqueIds.length; index += 1) {
          const event = events[index];
          if (!event) continue;
          const existingOwner = await database.meta.get(ownerKey(event.id));
          if (!existingOwner || existingOwner.value !== domain) {
            throw new Error(
              "Cannot acknowledge another account's collection event",
            );
          }
          metadata.push(
            { key: ownerKey(event.id), value: domain },
            { key: ackKey(normalized, event.id), value: syncedAt },
          );
          await database.events.update(event.id, { syncedAt });
        }
        if (metadata.length) await database.meta.bulkPut(metadata);
      },
    );
    await this.refresh();
  }

  async getSyncCursor(subject: string): Promise<string | null> {
    const normalized = normalizeSubject(subject);
    return (
      (await this.requireDatabase().meta.get(cursorKey(normalized)))?.value ??
      null
    );
  }

  async setSyncCursor(subject: string, cursor: string): Promise<void> {
    const normalized = normalizeSubject(subject);
    if (!/^\d+$/.test(cursor)) throw new Error("Invalid sync cursor");
    await this.requireDatabase().meta.put({
      key: cursorKey(normalized),
      value: cursor,
    });
  }

  /** Clears one cloud account's cursor and acknowledgements, while retaining ownership. */
  async resetSyncState(subject: string): Promise<void> {
    const normalized = normalizeSubject(subject);
    if (this.activeSyncSubject !== normalized)
      throw new Error("Cannot reset an inactive account domain");
    const domain = accountDomain(normalized);
    const database = this.requireDatabase();
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        const metadata = await database.meta.toArray();
        const keys = metadata
          .filter((item) => item.key.startsWith(syncNamespace(normalized)))
          .map((item) => item.key);
        if (keys.length) await database.meta.bulkDelete(keys);
        const ownerByEvent = new Map(
          metadata
            .filter((item) => item.key.startsWith("sync-owner:"))
            .map((item) => [item.key.slice("sync-owner:".length), item.value]),
        );
        const eventIds = (await database.events.toArray())
          .filter((event) => ownerByEvent.get(event.id) === domain)
          .map((event) => event.id);
        await Promise.all(
          eventIds.map((id) =>
            database.events.update(id, { syncedAt: undefined }),
          ),
        );
      },
    );
    await this.refresh();
  }

  async importEvents(
    events: unknown[],
    options: ImportOptions,
  ): Promise<number> {
    const source: ImportSource = options.source;
    const replace = options.source === "restore" && options.mode === "replace";
    if (
      options.source === "restore" &&
      options.mode === "replace" &&
      options.confirmed !== true
    )
      throw new Error("Replacing a collection requires explicit confirmation");
    const subject =
      options.source === "remote" ? normalizeSubject(options.subject) : null;
    if (subject && this.activeSyncSubject !== subject)
      throw new Error("Cannot import into an inactive account domain");
    const domain = subject
      ? accountDomain(subject)
      : domainForSubject(this.activeSyncSubject);
    const validated = validateCollectionEvents(events);
    if (!validated.length && source === "remote") return 0;
    const importedAt = new Date().toISOString();
    const normalized = validated.map((event) => {
      const copy = structuredClone(event);
      if (source === "remote") copy.syncedAt = importedAt;
      else delete copy.syncedAt;
      return copy;
    });
    const database = this.requireDatabase();
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        const [existing, existingMetadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          existingMetadata.map((item) => [item.key, item.value]),
        );
        const incomingIds = new Set<string>();
        for (const event of normalized) {
          if (incomingIds.has(event.id))
            throw new Error(`Duplicate collection event id: ${event.id}`);
          incomingIds.add(event.id);
          const owner = metadataByKey.get(ownerKey(event.id));
          if (owner && owner !== domain) {
            throw new Error(
              "Collection event collides with another account domain",
            );
          }
        }

        // Replay the exact prospective state before the first persistent write.
        // Any structural/clone failure aborts the transaction without a partial import.
        const currentDomainEvents = existing.filter(
          (event) => metadataByKey.get(ownerKey(event.id)) === domain,
        );
        const prospective = new Map(
          (replace ? [] : currentDomainEvents).map((event) => [
            event.id,
            event,
          ]),
        );
        for (const event of normalized) prospective.set(event.id, event);
        replayCollection([...prospective.values()]);

        if (replace && currentDomainEvents.length) {
          await database.events.bulkDelete(
            currentDomainEvents.map((event) => event.id),
          );
          await database.meta.bulkDelete(
            currentDomainEvents.map((event) => ownerKey(event.id)),
          );
        }
        if (normalized.length) {
          await database.events.bulkPut(normalized);
          await database.meta.bulkPut(
            normalized.map((event) => ({
              key: ownerKey(event.id),
              value: domain,
            })),
          );
        }
        if (source === "remote" && subject) {
          const metadata = normalized.map((event) => ({
            key: ackKey(subject, event.id),
            value: importedAt,
          }));
          await database.meta.bulkPut(metadata);
        } else if (this.activeSyncSubject) {
          const syncKeys = existingMetadata
            .filter((item) =>
              item.key.startsWith(syncNamespace(this.activeSyncSubject!)),
            )
            .map((item) => item.key);
          if (syncKeys.length) await database.meta.bulkDelete(syncKeys);
          const currentIds = [...prospective.keys()];
          await Promise.all(
            currentIds.map((id) =>
              database.events.update(id, { syncedAt: undefined }),
            ),
          );
        }
      },
    );
    await this.refresh();
    return normalized.length;
  }

  /** Atomically appends a parsed CSV batch after every generated event validates. */
  async importHoldings(inputs: AddHoldingInput[]): Promise<number> {
    if (!inputs.length) return 0;
    const database = this.requireDatabase();
    const domain = domainForSubject(this.activeSyncSubject);
    const generated: CollectionEvent[] = [];
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        const [existing, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const ownerById = new Map(
          metadata
            .filter((item) => item.key.startsWith("sync-owner:"))
            .map((item) => [item.key.slice("sync-owner:".length), item.value]),
        );
        const prospective = existing.filter(
          (event) => ownerById.get(event.id) === domain,
        );
        const baseTime = Date.now();
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const quantity = normalizeHoldingQuantity(input.quantity ?? 1);
          const occurredAt = new Date(baseTime + index).toISOString();
          const snapshot = replayCollection(prospective);
          const duplicate = findDuplicate(snapshot, input);
          if (duplicate && duplicate.quantity + quantity > MAX_HOLDING_QUANTITY)
            throw new RangeError("Holding quantity exceeds collection limits");
          const event: CollectionEvent = duplicate
            ? {
                id: makeId("event"),
                type: "holding.quantity-adjusted",
                holdingId: duplicate.id,
                deviceId: this.deviceId,
                occurredAt,
                payload: { delta: quantity },
              }
            : createAddedEvent(createHolding(input, occurredAt), this.deviceId);
          validateCollectionEvents([event]);
          prospective.push(event);
          generated.push(event);
        }
        replayCollection(prospective);
        await database.events.bulkAdd(generated);
        await database.meta.bulkPut(
          generated.map((event) => ({
            key: ownerKey(event.id),
            value: domain,
          })),
        );
      },
    );
    await this.refresh();
    return inputs.length;
  }

  private async append(event: CollectionEvent): Promise<void> {
    validateCollectionEvents([event]);
    const database = this.requireDatabase();
    const domain = domainForSubject(this.activeSyncSubject);
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        if (event.type !== "holding.added") {
          const origins = await database.events
            .where("holdingId")
            .equals(event.holdingId)
            .filter((candidate) => candidate.type === "holding.added")
            .toArray();
          const owners = await Promise.all(
            origins.map((origin) => database.meta.get(ownerKey(origin.id))),
          );
          if (!owners.some((owner) => owner?.value === domain)) {
            throw new Error(
              "Cannot modify a holding outside the active collection domain",
            );
          }
        }
        await database.events.add(event);
        await database.meta.put({ key: ownerKey(event.id), value: domain });
      },
    );
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const events = await this.eventsForDomain(
      domainForSubject(this.activeSyncSubject),
    );
    this.state.set(replayCollection(events));
  }

  private async eventsForDomain(domain: string): Promise<CollectionEvent[]> {
    const database = this.requireDatabase();
    const [events, metadata] = await Promise.all([
      database.events.toArray(),
      database.meta.toArray(),
    ]);
    const ownerById = new Map(
      metadata
        .filter((item) => item.key.startsWith("sync-owner:"))
        .map((item) => [item.key.slice("sync-owner:".length), item.value]),
    );
    return events.filter((event) => ownerById.get(event.id) === domain);
  }

  private requireDatabase(): CardScopeDatabase {
    if (!this.database)
      throw new Error("Collection repository is not initialized");
    return this.database;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isString(value: unknown, maxLength = 4096): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isOptionalString(
  value: unknown,
  maxLength = 4096,
): value is string | undefined {
  return value === undefined || isString(value, maxLength);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isFiniteNumber(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum
  );
}

function isNullablePrice(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["amount", "currency"]) &&
    isFiniteNumber(value.amount) &&
    normalizeCurrency(value.currency) === value.currency
  );
}

function isPriceQuote(value: unknown): value is PriceQuote {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "id",
      "source",
      "sourceUrl",
      "market",
      "currency",
      "sku",
      "condition",
      "conditionIncluded",
      "finish",
      "low",
      "marketPrice",
      "high",
      "volume",
      "liquidity",
      "observedAt",
      "staleAfter",
    ])
  ) {
    return false;
  }
  return Boolean(
    isOptionalString(value.id) &&
    isString(value.source) &&
    isOptionalString(value.sourceUrl) &&
    isString(value.market) &&
    normalizeCurrency(value.currency) === value.currency &&
    isOptionalString(value.sku) &&
    (value.condition === undefined ||
      CONDITIONS.has(value.condition as CardCondition)) &&
    (value.conditionIncluded === undefined ||
      typeof value.conditionIncluded === "boolean") &&
    (value.finish === undefined || FINISHES.has(value.finish as CardFinish)) &&
    isNullablePrice(value.low) &&
    isNullablePrice(value.marketPrice) &&
    isNullablePrice(value.high) &&
    (value.volume === undefined ||
      value.volume === null ||
      isFiniteNumber(value.volume)) &&
    (value.liquidity === undefined ||
      ["high", "medium", "low", "unknown"].includes(String(value.liquidity))) &&
    isIsoDate(value.observedAt) &&
    isIsoDate(value.staleAfter),
  );
}

function isCatalogCard(value: unknown): value is CatalogCard {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "id",
      "name",
      "number",
      "printedNumber",
      "setId",
      "setName",
      "language",
      "rarity",
      "releaseDate",
      "images",
      "quote",
      "quotes",
      "externalIds",
      "reference",
    ]) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isOptionalString(value.number) ||
    !isOptionalString(value.printedNumber) ||
    !isOptionalString(value.setId) ||
    !isOptionalString(value.setName) ||
    !isOptionalString(value.rarity) ||
    !isOptionalString(value.releaseDate)
  ) {
    return false;
  }
  if (
    value.language !== undefined &&
    !["en", "fr", "ja", "other"].includes(String(value.language))
  )
    return false;
  if (value.images !== undefined) {
    if (
      !isRecord(value.images) ||
      !hasOnlyKeys(value.images, ["small", "large"]) ||
      !isOptionalString(value.images.small, 16_384) ||
      !isOptionalString(value.images.large, 16_384)
    ) {
      return false;
    }
  }
  if (value.quote !== undefined && !isPriceQuote(value.quote)) return false;
  if (
    value.quotes !== undefined &&
    (!Array.isArray(value.quotes) || !value.quotes.every(isPriceQuote))
  )
    return false;
  if (
    value.externalIds !== undefined &&
    (!isRecord(value.externalIds) ||
      !Object.values(value.externalIds).every((item) => isString(item)))
  ) {
    return false;
  }
  if (value.reference !== undefined) {
    if (
      !isRecord(value.reference) ||
      !hasOnlyKeys(value.reference, ["perceptualHash", "rgbHash"]) ||
      !isOptionalString(value.reference.perceptualHash) ||
      (value.reference.rgbHash !== undefined &&
        (!Array.isArray(value.reference.rgbHash) ||
          value.reference.rgbHash.length > 4096 ||
          !value.reference.rgbHash.every((item) => isFiniteNumber(item))))
    ) {
      return false;
    }
  }
  return true;
}

function isHolding(value: unknown): value is Holding {
  if (!isRecord(value)) return false;
  return Boolean(
    hasOnlyKeys(value, [
      "id",
      "cardId",
      "card",
      "quantity",
      "finish",
      "condition",
      "unitCost",
      "quote",
      "note",
      "acquiredAt",
      "addedAt",
      "updatedAt",
      "deletedAt",
    ]) &&
    isString(value.id) &&
    isString(value.cardId) &&
    isCatalogCard(value.card) &&
    value.card.id === value.cardId &&
    Number.isSafeInteger(value.quantity) &&
    isFiniteNumber(value.quantity, 1) &&
    value.quantity <= MAX_HOLDING_QUANTITY &&
    FINISHES.has(value.finish as CardFinish) &&
    CONDITIONS.has(value.condition as CardCondition) &&
    (value.unitCost === undefined || isMoney(value.unitCost)) &&
    (value.quote === undefined || isPriceQuote(value.quote)) &&
    isOptionalString(value.note, 20_000) &&
    (value.acquiredAt === undefined || isIsoDate(value.acquiredAt)) &&
    isIsoDate(value.addedAt) &&
    isIsoDate(value.updatedAt) &&
    (value.deletedAt === undefined || isIsoDate(value.deletedAt)),
  );
}

export function isCollectionEvent(value: unknown): value is CollectionEvent {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "id",
      "type",
      "holdingId",
      "occurredAt",
      "deviceId",
      "payload",
      "syncedAt",
    ]) ||
    !isString(value.id) ||
    !EVENT_TYPES.has(value.type as CollectionEvent["type"]) ||
    !isString(value.holdingId) ||
    !isIsoDate(value.occurredAt) ||
    !isString(value.deviceId) ||
    !isRecord(value.payload) ||
    (value.syncedAt !== undefined && !isIsoDate(value.syncedAt))
  ) {
    return false;
  }
  switch (value.type) {
    case "holding.added":
      return (
        hasOnlyKeys(value.payload, ["holding"]) &&
        isHolding(value.payload.holding) &&
        value.payload.holding.id === value.holdingId
      );
    case "holding.quantity-adjusted":
      return (
        hasOnlyKeys(value.payload, ["delta"]) &&
        typeof value.payload.delta === "number" &&
        Number.isSafeInteger(value.payload.delta) &&
        Math.abs(value.payload.delta) <= MAX_HOLDING_QUANTITY &&
        value.payload.delta !== 0
      );
    case "holding.updated":
      return Boolean(
        hasOnlyKeys(value.payload, [
          "finish",
          "condition",
          "unitCost",
          "note",
          "quote",
        ]) &&
        (value.payload.finish === undefined ||
          FINISHES.has(value.payload.finish as CardFinish)) &&
        (value.payload.condition === undefined ||
          CONDITIONS.has(value.payload.condition as CardCondition)) &&
        (value.payload.unitCost === undefined ||
          value.payload.unitCost === null ||
          isMoney(value.payload.unitCost)) &&
        (value.payload.note === undefined ||
          value.payload.note === null ||
          isString(value.payload.note, 20_000)) &&
        (value.payload.quote === undefined ||
          value.payload.quote === null ||
          isPriceQuote(value.payload.quote)),
      );
    case "holding.removed":
      return (
        hasOnlyKeys(value.payload, ["reason"]) &&
        isOptionalString(value.payload.reason, 4096)
      );
    default:
      return false;
  }
}

export function validateCollectionEvents(events: unknown[]): CollectionEvent[] {
  const validated: CollectionEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isCollectionEvent(event))
      throw new Error(`Invalid collection event at index ${index}`);
    validated.push(event);
  }
  return validated;
}

export const collectionRepository = new CollectionRepository();
