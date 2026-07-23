import Dexie, { type Table } from "dexie";
import { writable, type Readable } from "svelte/store";
import { collectionEventSchema } from "../../shared/collection-event-schema";
import {
  createAddedEvent,
  createHolding,
  findDuplicate,
  MAX_HOLDING_QUANTITY,
  makeId,
  nextCollectionEventTimestamp,
  normalizeHoldingQuantity,
  replayCollection,
  snapshotPriceQuote,
  validateAndReplayCollection,
  type AddHoldingInput,
} from "./collection";
import type {
  CardCondition,
  CardFinish,
  CollectionEvent,
  CollectionSnapshot,
  Holding,
  Money,
  PriceQuote,
} from "./types";

type ClientMeta = { key: string; value: string };
type ImportSource = "restore" | "remote";

type ImportOptions =
  | { source: "restore"; mode: "merge"; confirmed?: never; subject?: never }
  | { source: "restore"; mode: "replace"; confirmed: true; subject?: never }
  | {
      source: "remote";
      subject: string;
      generation: string;
    };

export class CollectionMutationLockedError extends Error {
  constructor() {
    super("Collection deletion is in progress");
    this.name = "CollectionMutationLockedError";
  }
}

export class CollectionEnrollmentPendingError extends Error {
  constructor() {
    super("Account enrollment is still being resolved");
    this.name = "CollectionEnrollmentPendingError";
  }
}

export class CollectionEnrollmentCorruptedError extends Error {
  constructor() {
    super("Pending account enrollment metadata is invalid");
    this.name = "CollectionEnrollmentCorruptedError";
  }
}

export class CollectionSyncGenerationFenceError extends Error {
  constructor() {
    super("The account generation changed while synchronization was in flight");
    this.name = "CollectionSyncGenerationFenceError";
  }
}

export class CollectionOperationTooLargeError extends Error {
  constructor(
    readonly operationId: string,
    readonly bytes: number,
    readonly maximumBytes: number,
  ) {
    super(
      `Collection operation ${operationId} is ${bytes} bytes; the sync limit is ${maximumBytes}`,
    );
    this.name = "CollectionOperationTooLargeError";
  }
}

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
function syncNamespace(subject: string): string {
  return `sync:${encodeURIComponent(subject)}:`;
}

function cursorKey(subject: string): string {
  return `${syncNamespace(subject)}cursor`;
}

function generationKey(subject: string): string {
  return `${syncNamespace(subject)}generation`;
}

function ackKey(subject: string, eventId: string): string {
  return `${syncNamespace(subject)}ack:${eventId}`;
}

function mutationLockKey(subject: string): string {
  return `${syncNamespace(subject)}mutation-lock`;
}

function enrollmentKey(subject: string): string {
  return `${syncNamespace(subject)}enrollment`;
}

function ownerKey(eventId: string): string {
  return `sync-owner:${eventId}`;
}

const ANONYMOUS_DOMAIN = "collection-domain:anonymous";
const ACCOUNT_DOMAIN_PREFIX = "collection-domain:account:";
const DEFAULT_MAX_SYNC_OPERATION_BYTES = 64 * 1024;

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

function parseMutationLock(
  value: string,
): { owner: string; expiresAt: number } | null {
  try {
    const parsed = JSON.parse(value) as {
      owner?: unknown;
      expiresAt?: unknown;
    };
    return typeof parsed.owner === "string" &&
      parsed.owner.length > 0 &&
      typeof parsed.expiresAt === "number" &&
      Number.isSafeInteger(parsed.expiresAt)
      ? { owner: parsed.owner, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

type PendingEnrollment = {
  claimedIds: string[];
  attemptedIds: string[];
};

function parsePendingEnrollment(value: string): PendingEnrollment | null {
  try {
    const parsed = JSON.parse(value) as {
      claimedIds?: unknown;
      attemptedIds?: unknown;
    };
    if (
      !Array.isArray(parsed.claimedIds) ||
      !Array.isArray(parsed.attemptedIds) ||
      !parsed.claimedIds.every(
        (id): id is string => typeof id === "string" && id.length > 0,
      ) ||
      !parsed.attemptedIds.every(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    ) {
      return null;
    }
    const claimedIds = [...new Set(parsed.claimedIds)];
    const attemptedIds = [...new Set(parsed.attemptedIds)];
    const claimed = new Set(claimedIds);
    if (claimedIds.length === 0 || attemptedIds.some((id) => !claimed.has(id)))
      return null;
    return { claimedIds, attemptedIds };
  } catch {
    return null;
  }
}

export class CollectionRepository {
  private database: CardScopeDatabase | null = null;
  private readonly state = writable<CollectionSnapshot>(emptySnapshot);
  private readonly instanceId = makeId("repository");
  private readonly changeChannel: BroadcastChannel | null;
  private deviceId = "";
  private activeSyncSubject: string | null = null;
  private maxSyncOperationBytes = DEFAULT_MAX_SYNC_OPERATION_BYTES;
  readonly snapshot: Readable<CollectionSnapshot> = {
    subscribe: this.state.subscribe,
  };

  constructor(private readonly databaseName = "cardscope") {
    this.changeChannel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(`cardscope:${databaseName}`);
    this.changeChannel?.addEventListener("message", (event) => {
      if (
        event.data?.type === "collection-changed" &&
        event.data?.sender !== this.instanceId &&
        this.database
      ) {
        void this.refresh().catch(() => undefined);
      }
    });
  }

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

  setSyncOperationByteLimit(maximumBytes: number): void {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 2 * 1024 * 1024
    ) {
      throw new RangeError("Invalid sync operation byte limit");
    }
    this.maxSyncOperationBytes = maximumBytes;
  }

  close(): void {
    this.changeChannel?.close();
    this.database?.close();
    this.database = null;
    this.activeSyncSubject = null;
  }

  async add(input: AddHoldingInput): Promise<Holding> {
    const quantity = normalizeHoldingQuantity(input.quantity ?? 1);
    const database = this.requireDatabase();
    const domain = domainForSubject(this.activeSyncSubject);
    let result: Holding | null = null;
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        await this.assertMutationAllowed(database, false, true);
        const [events, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          metadata.map((item) => [item.key, item.value]),
        );
        const current = events.filter(
          (candidate) => metadataByKey.get(ownerKey(candidate.id)) === domain,
        );
        const snapshot = validateAndReplayCollection(current);
        const duplicate = findDuplicate(snapshot, input);
        let event: CollectionEvent;
        if (duplicate) {
          if (duplicate.quantity + quantity > MAX_HOLDING_QUANTITY)
            throw new RangeError("Holding quantity exceeds collection limits");
          event = {
            id: makeId("event"),
            type: "holding.quantity-adjusted",
            holdingId: duplicate.id,
            deviceId: this.deviceId,
            occurredAt: nextCollectionEventTimestamp(duplicate.updatedAt),
            payload: { delta: quantity },
          };
          result = duplicate;
        } else {
          const holding = createHolding(input, nextCollectionEventTimestamp());
          event = createAddedEvent(holding, this.deviceId);
          result = holding;
        }
        validateCollectionEvents([event]);
        this.assertSyncOperationSize(event);
        validateAndReplayCollection([...current, event]);
        await database.events.add(event);
        await database.meta.put({
          key: ownerKey(event.id),
          value: domain,
        });
      },
    );
    await this.refresh();
    this.notifyPeers();
    if (!result) throw new Error("Collection add transaction made no progress");
    return result;
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
      occurredAt: nextCollectionEventTimestamp(holding.updatedAt),
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
    const snapshot = replayCollection(
      await this.eventsForDomain(domainForSubject(this.activeSyncSubject)),
    );
    const holding = snapshot.holdings.find((item) => item.id === holdingId);
    if (!holding)
      throw new Error(
        "Cannot modify a holding outside the active collection domain",
      );
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
      occurredAt: nextCollectionEventTimestamp(holding.updatedAt),
      payload: normalizedPatch,
    });
  }

  async remove(holdingId: string): Promise<void> {
    const snapshot = replayCollection(
      await this.eventsForDomain(domainForSubject(this.activeSyncSubject)),
    );
    const holding = snapshot.holdings.find((item) => item.id === holdingId);
    if (!holding)
      throw new Error(
        "Cannot modify a holding outside the active collection domain",
      );
    await this.append({
      id: makeId("event"),
      type: "holding.removed",
      holdingId,
      deviceId: this.deviceId,
      occurredAt: nextCollectionEventTimestamp(holding.updatedAt),
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

  async eventCountForSubject(subject: string | null): Promise<number> {
    const normalized = subject === null ? null : normalizeSubject(subject);
    return (await this.eventsForDomain(domainForSubject(normalized))).length;
  }

  async eventsForSubject(subject: string | null): Promise<CollectionEvent[]> {
    const normalized = subject === null ? null : normalizeSubject(subject);
    return this.eventsForDomain(domainForSubject(normalized));
  }

  async refreshActiveSnapshot(): Promise<void> {
    await this.refresh();
  }

  /**
   * Atomically adopts the anonymous, offline-capable event log into one
   * authenticated account. Ownership is moved rather than copied, so a logout
   * cannot expose a stale duplicate of data that now belongs to an account.
   */
  async claimAnonymousEvents(
    subject: string,
    options: { trackEnrollment?: boolean } = {},
  ): Promise<number> {
    const normalized = normalizeSubject(subject);
    if (this.activeSyncSubject !== normalized)
      throw new Error("Cannot enroll into an inactive account domain");
    const database = this.requireDatabase();
    const targetDomain = accountDomain(normalized);
    let claimed = 0;
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        await this.assertMutationAllowed(database);
        const [events, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          metadata.map((item) => [item.key, item.value]),
        );
        const anonymous = events.filter(
          (event) => metadataByKey.get(ownerKey(event.id)) === ANONYMOUS_DOMAIN,
        );
        if (!anonymous.length) return;
        for (const event of anonymous) this.assertSyncOperationSize(event);
        const anonymousIds = new Set(anonymous.map((event) => event.id));
        const account = events.filter(
          (event) => metadataByKey.get(ownerKey(event.id)) === targetDomain,
        );

        // Validate the complete merged history before the first write. Dexie
        // rolls the transaction back if replay detects an invalid quantity or
        // another event-log invariant.
        validateAndReplayCollection([...account, ...anonymous]);

        await database.meta.bulkPut(
          anonymous.map((event) => ({
            key: ownerKey(event.id),
            value: targetDomain,
          })),
        );
        await Promise.all(
          anonymous.map((event) =>
            database.events.update(event.id, { syncedAt: undefined }),
          ),
        );
        const staleAckKeys = metadata
          .filter(
            (item) =>
              item.key.startsWith(syncNamespace(normalized)) &&
              anonymousIds.has(
                item.key.slice(`${syncNamespace(normalized)}ack:`.length),
              ),
          )
          .map((item) => item.key);
        if (staleAckKeys.length) await database.meta.bulkDelete(staleAckKeys);
        if (options.trackEnrollment) {
          await database.meta.put({
            key: enrollmentKey(normalized),
            value: JSON.stringify({
              claimedIds: anonymous.map((event) => event.id),
              attemptedIds: [],
            } satisfies PendingEnrollment),
          });
        }
        claimed = anonymous.length;
      },
    );
    if (claimed) {
      await this.refresh();
      this.notifyPeers();
    }
    return claimed;
  }

  async getPendingEnrollment(
    subject: string,
  ): Promise<PendingEnrollment | null> {
    const normalized = normalizeSubject(subject);
    const item = await this.requireDatabase().meta.get(
      enrollmentKey(normalized),
    );
    if (!item) return null;
    const pending = parsePendingEnrollment(item.value);
    if (!pending) throw new CollectionEnrollmentCorruptedError();
    return pending;
  }

  async setPendingEnrollmentAttempt(
    subject: string,
    eventIds: string[],
  ): Promise<void> {
    const normalized = normalizeSubject(subject);
    const ids = [...new Set(eventIds)];
    if (!ids.length) throw new Error("Enrollment attempt cannot be empty");
    const database = this.requireDatabase();
    await database.transaction("rw", database.meta, async () => {
      await this.assertMutationAllowed(database);
      const item = await database.meta.get(enrollmentKey(normalized));
      const pending = item ? parsePendingEnrollment(item.value) : null;
      if (item && !pending) throw new CollectionEnrollmentCorruptedError();
      if (!item || !pending)
        throw new Error("Pending enrollment metadata is unavailable");
      if (
        pending.attemptedIds.length > 0 &&
        (pending.attemptedIds.length !== ids.length ||
          pending.attemptedIds.some((id, index) => id !== ids[index]))
      ) {
        throw new Error(
          "Enrollment retry batch changed before acknowledgement",
        );
      }
      await database.meta.put({
        key: enrollmentKey(normalized),
        value: JSON.stringify({ ...pending, attemptedIds: ids }),
      });
    });
  }

  async completePendingEnrollment(subject: string): Promise<void> {
    const normalized = normalizeSubject(subject);
    const database = this.requireDatabase();
    await database.transaction("rw", database.meta, async () => {
      await this.assertMutationAllowed(database);
      await database.meta.delete(enrollmentKey(normalized));
    });
  }

  /**
   * Roll back only an enrollment rejected before the server accepted its first
   * operation. Explicit IDs fence unrelated account events from this move.
   */
  async returnClaimedEventsToAnonymous(
    subject: string,
    eventIds: string[],
    options: { allowMutationLockOwner?: boolean } = {},
  ): Promise<number> {
    const normalized = normalizeSubject(subject);
    if (this.activeSyncSubject !== normalized)
      throw new Error("Cannot roll back enrollment for an inactive account");
    const database = this.requireDatabase();
    const targetDomain = accountDomain(normalized);
    const ids = [...new Set(eventIds)];
    let restored = 0;
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        await this.assertMutationAllowed(
          database,
          options.allowMutationLockOwner === true,
        );
        const enrollment = await database.meta.get(enrollmentKey(normalized));
        if (!enrollment) return;
        const pending = parsePendingEnrollment(enrollment.value);
        if (!pending) throw new CollectionEnrollmentCorruptedError();
        if (
          pending.claimedIds.length !== ids.length ||
          pending.claimedIds.some((id, index) => id !== ids[index])
        ) {
          throw new Error(
            "Enrollment rollback does not match the pending claim",
          );
        }
        for (const id of ids) {
          const [event, owner] = await Promise.all([
            database.events.get(id),
            database.meta.get(ownerKey(id)),
          ]);
          if (!event || owner?.value !== targetDomain) continue;
          await database.meta.put({
            key: ownerKey(id),
            value: ANONYMOUS_DOMAIN,
          });
          await database.meta.delete(ackKey(normalized, id));
          await database.events.update(id, { syncedAt: undefined });
          restored += 1;
        }
        await database.meta.delete(enrollmentKey(normalized));
      },
    );
    if (restored) {
      await this.refresh();
      this.notifyPeers();
    }
    return restored;
  }

  /**
   * Cross-tab lease used while deleting a central collection. Every mutation
   * consults the same IndexedDB record before it appends an event.
   */
  async lockAccountMutations(
    subject: string,
    ttlMs = 30_000,
  ): Promise<() => Promise<void>> {
    const normalized = normalizeSubject(subject);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000)
      throw new RangeError("Invalid mutation lock duration");
    const database = this.requireDatabase();
    const key = mutationLockKey(normalized);
    const releaseBrowserLock =
      await this.acquireBrowserDeletionLock(normalized);
    try {
      await database.transaction("rw", database.meta, async () => {
        const current = await database.meta.get(key);
        const parsed = current ? parseMutationLock(current.value) : null;
        if (
          parsed &&
          parsed.owner !== this.instanceId &&
          parsed.expiresAt > Date.now()
        ) {
          throw new CollectionMutationLockedError();
        }
        await database.meta.put({
          key,
          value: JSON.stringify({
            owner: this.instanceId,
            expiresAt: Date.now() + ttlMs,
          }),
        });
      });
    } catch (error) {
      await releaseBrowserLock();
      throw error;
    }
    this.notifyPeers();
    return async () => {
      try {
        await database.transaction("rw", database.meta, async () => {
          const current = await database.meta.get(key);
          const parsed = current ? parseMutationLock(current.value) : null;
          if (parsed?.owner === this.instanceId)
            await database.meta.delete(key);
        });
        this.notifyPeers();
      } finally {
        await releaseBrowserLock();
      }
    };
  }

  /**
   * Clears one account's device cache after the server has acknowledged an
   * explicit erasure. This prevents the next automatic sync from resurrecting
   * deleted server data.
   */
  async clearAccountData(
    subject: string,
    options: {
      confirmed: true;
      preserveMutationLock?: boolean;
      expectedGeneration?: string | null;
      replacementGeneration?: string;
    },
  ): Promise<number | null> {
    if (options.confirmed !== true)
      throw new Error("Clearing account data requires explicit confirmation");
    const normalized = normalizeSubject(subject);
    if (
      options.replacementGeneration !== undefined &&
      (!/^[1-9]\d*$/.test(options.replacementGeneration) ||
        !Number.isSafeInteger(Number(options.replacementGeneration)))
    )
      throw new Error("Invalid replacement sync generation");
    if (this.activeSyncSubject !== normalized)
      throw new Error("Cannot clear an inactive account domain");
    const database = this.requireDatabase();
    const domain = accountDomain(normalized);
    let deleted = 0;
    let generationMatched = true;
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        await this.assertMutationAllowed(database, true);
        if ("expectedGeneration" in options) {
          const current =
            (await database.meta.get(generationKey(normalized)))?.value ?? null;
          if (current !== options.expectedGeneration) {
            generationMatched = false;
            return;
          }
        }
        const [events, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          metadata.map((item) => [item.key, item.value]),
        );
        const accountEventIds = events
          .filter((event) => metadataByKey.get(ownerKey(event.id)) === domain)
          .map((event) => event.id);
        const accountEventIdSet = new Set(accountEventIds);
        const metadataKeys = metadata
          .filter(
            (item) =>
              (item.key.startsWith(syncNamespace(normalized)) &&
                (!options.preserveMutationLock ||
                  item.key !== mutationLockKey(normalized))) ||
              (item.key.startsWith("sync-owner:") &&
                accountEventIdSet.has(item.key.slice("sync-owner:".length))),
          )
          .map((item) => item.key);
        if (accountEventIds.length)
          await database.events.bulkDelete(accountEventIds);
        if (metadataKeys.length) await database.meta.bulkDelete(metadataKeys);
        if (options.replacementGeneration)
          await database.meta.put({
            key: generationKey(normalized),
            value: options.replacementGeneration,
          });
        deleted = accountEventIds.length;
      },
    );
    if (!generationMatched) return null;
    await this.refresh();
    this.notifyPeers();
    return deleted;
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
        const pending = events
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
        for (const event of pending) this.assertSyncOperationSize(event);
        return pending;
      },
    );
  }

  async markSynced(
    subject: string,
    ids: string[],
    syncedAt = new Date().toISOString(),
    options: { generation?: string } = {},
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
        await this.assertMutationAllowed(database);
        if (options.generation)
          await this.assertSyncGeneration(
            database,
            normalized,
            options.generation,
          );
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
    this.notifyPeers();
  }

  async getSyncCursor(subject: string): Promise<string | null> {
    const normalized = normalizeSubject(subject);
    return (
      (await this.requireDatabase().meta.get(cursorKey(normalized)))?.value ??
      null
    );
  }

  async setSyncCursor(
    subject: string,
    cursor: string,
    options: { generation?: string } = {},
  ): Promise<void> {
    const normalized = normalizeSubject(subject);
    if (!/^\d+$/.test(cursor)) throw new Error("Invalid sync cursor");
    const database = this.requireDatabase();
    await database.transaction("rw", database.meta, async () => {
      await this.assertMutationAllowed(database, true);
      if (options.generation)
        await this.assertSyncGeneration(
          database,
          normalized,
          options.generation,
        );
      await database.meta.put({
        key: cursorKey(normalized),
        value: cursor,
      });
    });
  }

  async getSyncGeneration(subject: string): Promise<string | null> {
    const normalized = normalizeSubject(subject);
    return (
      (await this.requireDatabase().meta.get(generationKey(normalized)))
        ?.value ?? null
    );
  }

  async setSyncGeneration(
    subject: string,
    generation: string,
    options: { expectedCurrent: string | null } | undefined = undefined,
  ): Promise<void> {
    const normalized = normalizeSubject(subject);
    if (!/^[1-9]\d*$/.test(generation))
      throw new Error("Invalid sync generation");
    const parsed = Number(generation);
    if (!Number.isSafeInteger(parsed))
      throw new Error("Invalid sync generation");
    const database = this.requireDatabase();
    await database.transaction("rw", database.meta, async () => {
      await this.assertMutationAllowed(database, true);
      const current =
        (await database.meta.get(generationKey(normalized)))?.value ?? null;
      if (options && current !== options.expectedCurrent)
        throw new CollectionSyncGenerationFenceError();
      if (
        current !== null &&
        Number.parseInt(generation, 10) < Number.parseInt(current, 10)
      )
        throw new CollectionSyncGenerationFenceError();
      await database.meta.put({
        key: generationKey(normalized),
        value: generation,
      });
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
        await this.assertMutationAllowed(database);
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
    this.notifyPeers();
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
    if (replace && this.activeSyncSubject)
      throw new Error(
        "Replacing a signed-in collection requires a server generation change",
      );
    const subject =
      options.source === "remote" ? normalizeSubject(options.subject) : null;
    const generation =
      options.source === "remote" ? options.generation : undefined;
    if (
      generation !== undefined &&
      (!/^[1-9]\d*$/.test(generation) ||
        !Number.isSafeInteger(Number(generation)))
    )
      throw new Error("Invalid sync generation");
    if (subject && this.activeSyncSubject !== subject)
      throw new Error("Cannot import into an inactive account domain");
    const domain = subject
      ? accountDomain(subject)
      : domainForSubject(this.activeSyncSubject);
    const validated = validateCollectionEvents(events);
    for (const event of validated) this.assertSyncOperationSize(event);
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
        await this.assertMutationAllowed(database, false, source === "restore");
        if (subject && generation)
          await this.assertSyncGeneration(database, subject, generation);
        const [existing, existingMetadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          existingMetadata.map((item) => [item.key, item.value]),
        );
        const existingById = new Map(
          existing.map((event) => [event.id, event]),
        );
        const incomingIds = new Set<string>();
        const persisted: CollectionEvent[] = [];
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
          const current = existingById.get(event.id);
          if (
            current &&
            collectionEventIdentity(current) !== collectionEventIdentity(event)
          ) {
            throw new Error(
              `Collection event id has conflicting content: ${event.id}`,
            );
          }
          if (!current || source === "remote") {
            persisted.push(
              current && source === "remote"
                ? {
                    ...current,
                    ...event,
                    serverSequence:
                      event.serverSequence ?? current.serverSequence,
                  }
                : event,
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
        for (const event of persisted) prospective.set(event.id, event);
        validateAndReplayCollection([...prospective.values()]);

        if (replace && currentDomainEvents.length) {
          await database.events.bulkDelete(
            currentDomainEvents.map((event) => event.id),
          );
          await database.meta.bulkDelete(
            currentDomainEvents.map((event) => ownerKey(event.id)),
          );
        }
        if (persisted.length) {
          await database.events.bulkPut(persisted);
          await database.meta.bulkPut(
            persisted.map((event) => ({
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
        }
      },
    );
    await this.refresh();
    this.notifyPeers();
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
        await this.assertMutationAllowed(database, false, true);
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
        let lastOccurredAt = prospective.reduce(
          (latest, event) =>
            event.occurredAt > latest ? event.occurredAt : latest,
          "",
        );
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const quantity = normalizeHoldingQuantity(input.quantity ?? 1);
          const occurredAt = nextCollectionEventTimestamp(lastOccurredAt);
          lastOccurredAt = occurredAt;
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
          this.assertSyncOperationSize(event);
          prospective.push(event);
          generated.push(event);
        }
        validateAndReplayCollection(prospective);
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
    this.notifyPeers();
    return inputs.length;
  }

  private async append(event: CollectionEvent): Promise<void> {
    validateCollectionEvents([event]);
    this.assertSyncOperationSize(event);
    const database = this.requireDatabase();
    const domain = domainForSubject(this.activeSyncSubject);
    let persistedEvent = event;
    await database.transaction(
      "rw",
      database.events,
      database.meta,
      async () => {
        await this.assertMutationAllowed(database, false, true);
        const [events, metadata] = await Promise.all([
          database.events.toArray(),
          database.meta.toArray(),
        ]);
        const metadataByKey = new Map(
          metadata.map((item) => [item.key, item.value]),
        );
        const current = events.filter(
          (candidate) => metadataByKey.get(ownerKey(candidate.id)) === domain,
        );
        if (event.type !== "holding.added") {
          const active = validateAndReplayCollection(current).holdings.find(
            (holding) => holding.id === event.holdingId,
          );
          if (active) {
            persistedEvent = {
              ...event,
              occurredAt: nextCollectionEventTimestamp(active.updatedAt),
            } as CollectionEvent;
          }
        }
        validateAndReplayCollection([...current, persistedEvent]);
        await database.events.add(persistedEvent);
        await database.meta.put({
          key: ownerKey(persistedEvent.id),
          value: domain,
        });
      },
    );
    await this.refresh();
    this.notifyPeers();
  }

  private async refresh(): Promise<void> {
    const events = await this.eventsForDomain(
      domainForSubject(this.activeSyncSubject),
    );
    this.state.set(replayCollection(events));
  }

  private assertSyncOperationSize(event: CollectionEvent): void {
    const operation = { ...event };
    delete operation.serverSequence;
    delete operation.syncedAt;
    const bytes = new TextEncoder().encode(
      JSON.stringify(operation),
    ).byteLength;
    if (bytes > this.maxSyncOperationBytes) {
      throw new CollectionOperationTooLargeError(
        event.id,
        bytes,
        this.maxSyncOperationBytes,
      );
    }
  }

  private notifyPeers(): void {
    this.changeChannel?.postMessage({
      type: "collection-changed",
      sender: this.instanceId,
    });
  }

  private browserMutationLockName(subject: string): string {
    return `cardscope:${this.databaseName}:${encodeURIComponent(subject)}`;
  }

  private async acquireBrowserDeletionLock(
    subject: string,
  ): Promise<() => Promise<void>> {
    const locks = globalThis.navigator?.locks;
    if (!locks) return async () => undefined;
    let reportAcquired: (acquired: boolean) => void = () => undefined;
    const acquired = new Promise<boolean>((resolve) => {
      reportAcquired = resolve;
    });
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const request = locks.request(
      this.browserMutationLockName(subject),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        reportAcquired(lock !== null);
        if (lock) await hold;
      },
    );
    if (!(await acquired)) {
      await request;
      throw new CollectionMutationLockedError();
    }
    return async () => {
      releaseHold();
      await request;
    };
  }

  private async assertMutationAllowed(
    database: CardScopeDatabase,
    allowOwner = false,
    blockDuringEnrollment = false,
  ): Promise<void> {
    if (!this.activeSyncSubject) return;
    if (
      blockDuringEnrollment &&
      (await database.meta.get(enrollmentKey(this.activeSyncSubject)))
    )
      throw new CollectionEnrollmentPendingError();
    const key = mutationLockKey(this.activeSyncSubject);
    const item = await database.meta.get(key);
    const lock = item ? parseMutationLock(item.value) : null;
    if (!item) return;
    if (!lock) {
      await database.meta.delete(key);
      return;
    }
    if (allowOwner && lock.owner === this.instanceId) return;

    const locks = globalThis.navigator?.locks;
    if (locks) {
      const available = await Dexie.waitFor(
        locks.request(
          this.browserMutationLockName(this.activeSyncSubject),
          { mode: "shared", ifAvailable: true },
          (browserLock) => browserLock !== null,
        ),
      );
      if (available) {
        await database.meta.delete(key);
        return;
      }
      throw new CollectionMutationLockedError();
    }
    if (lock.expiresAt > Date.now()) throw new CollectionMutationLockedError();
    await database.meta.delete(key);
  }

  private async assertSyncGeneration(
    database: CardScopeDatabase,
    subject: string,
    expected: string,
  ): Promise<void> {
    const current = await database.meta.get(generationKey(subject));
    if (current?.value !== expected)
      throw new CollectionSyncGenerationFenceError();
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, item]) =>
          item !== undefined && key !== "syncedAt" && key !== "serverSequence",
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function collectionEventIdentity(event: CollectionEvent): string {
  return JSON.stringify(canonicalValue(event));
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isCollectionEvent(value: unknown): value is CollectionEvent {
  return collectionEventSchema.safeParse(value).success;
}

export function validateCollectionEvents(events: unknown[]): CollectionEvent[] {
  const validated: CollectionEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const parsed = collectionEventSchema.safeParse(events[index]);
    if (!parsed.success)
      throw new Error(`Invalid collection event at index ${index}`);
    validated.push(parsed.data as CollectionEvent);
  }
  return validated;
}

export const collectionRepository = new CollectionRepository();
