import type {
  CardCondition,
  CardFinish,
  CatalogCard,
  CollectionActivity,
  CollectionEvent,
  CollectionSnapshot,
  Holding,
  Money,
  PriceQuote,
} from "./types";

export type AddHoldingInput = {
  card: CatalogCard;
  finish: CardFinish;
  condition: CardCondition;
  quantity?: number;
  unitCost?: Money;
  quote?: PriceQuote;
  note?: string;
  acquiredAt?: string;
};

export const MAX_HOLDING_QUANTITY = 100_000;
const PRICE_QUOTE_SNAPSHOT_KEYS = [
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
] as const satisfies readonly (keyof PriceQuote)[];
const CATALOG_CARD_SNAPSHOT_KEYS = [
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
] as const satisfies readonly (keyof CatalogCard)[];
const CARD_IMAGE_SNAPSHOT_KEYS = [
  "small",
  "large",
] as const satisfies readonly (keyof NonNullable<CatalogCard["images"]>)[];
const CARD_REFERENCE_SNAPSHOT_KEYS = [
  "perceptualHash",
  "rgbHash",
] as const satisfies readonly (keyof NonNullable<CatalogCard["reference"]>)[];

function snapshotAllowedObject(
  value: unknown,
  keys: readonly string[],
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const item = source[key];
    if (item !== undefined) snapshot[key] = item;
  }
  return snapshot;
}

export function snapshotPriceQuote(quote: PriceQuote): PriceQuote {
  return snapshotAllowedObject(quote, PRICE_QUOTE_SNAPSHOT_KEYS) as PriceQuote;
}

function catalogCardSnapshot(card: CatalogCard): CatalogCard {
  // A recognition candidate structurally extends CatalogCard with score
  // metadata. TypeScript permits that value at this boundary, but strict
  // event validation must never persist transient ranking fields. Svelte
  // state is also a deep Proxy, which structuredClone intentionally rejects.
  // Copy each nested JSON contract explicitly while retaining non-finite
  // numbers so runtime validation rejects them instead of coercing them.
  const snapshot = snapshotAllowedObject(
    card,
    CATALOG_CARD_SNAPSHOT_KEYS,
  ) as Record<string, unknown>;
  if (snapshot.images !== undefined) {
    snapshot.images = snapshotAllowedObject(
      snapshot.images,
      CARD_IMAGE_SNAPSHOT_KEYS,
    );
  }
  if (snapshot.quote !== undefined) {
    snapshot.quote = snapshotPriceQuote(snapshot.quote as PriceQuote);
  }
  if (Array.isArray(snapshot.quotes)) {
    snapshot.quotes = snapshot.quotes.map((quote) =>
      snapshotPriceQuote(quote as PriceQuote),
    );
  }
  if (
    snapshot.externalIds &&
    typeof snapshot.externalIds === "object" &&
    !Array.isArray(snapshot.externalIds)
  ) {
    snapshot.externalIds = Object.fromEntries(
      Object.entries(snapshot.externalIds),
    );
  }
  if (snapshot.reference !== undefined) {
    const reference = snapshotAllowedObject(
      snapshot.reference,
      CARD_REFERENCE_SNAPSHOT_KEYS,
    );
    if (
      reference &&
      typeof reference === "object" &&
      !Array.isArray(reference)
    ) {
      const plainReference = reference as Record<string, unknown>;
      if (Array.isArray(plainReference.rgbHash)) {
        plainReference.rgbHash = [...plainReference.rgbHash];
      }
    }
    snapshot.reference = reference;
  }
  return snapshot as CatalogCard;
}

export function normalizeHoldingQuantity(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_HOLDING_QUANTITY
  ) {
    throw new RangeError(
      `Holding quantity must be an integer between 1 and ${MAX_HOLDING_QUANTITY}`,
    );
  }
  return value;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function holdingSignature(
  cardId: string,
  finish: CardFinish,
  condition: CardCondition,
): string {
  return `${cardId}::${finish}::${condition}`;
}

export function createHolding(
  input: AddHoldingInput,
  occurredAt = new Date().toISOString(),
): Holding {
  const card = catalogCardSnapshot(input.card);
  return {
    id: makeId("holding"),
    cardId: card.id,
    card,
    quantity: normalizeHoldingQuantity(input.quantity ?? 1),
    finish: input.finish,
    condition: input.condition,
    unitCost: input.unitCost,
    quote:
      input.quote === undefined ? card.quote : snapshotPriceQuote(input.quote),
    note: input.note,
    acquiredAt: input.acquiredAt,
    addedAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function createAddedEvent(
  holding: Holding,
  deviceId: string,
): CollectionEvent {
  return {
    id: makeId("event"),
    type: "holding.added",
    holdingId: holding.id,
    occurredAt: holding.addedAt,
    deviceId,
    payload: { holding },
  };
}

export function replayCollection(
  events: CollectionEvent[],
): CollectionSnapshot {
  const holdings = new Map<string, Holding>();
  const sorted = [...events].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
  const activities: CollectionActivity[] = [];

  for (const event of sorted) {
    const existing = holdings.get(event.holdingId);
    if (event.type === "holding.added") {
      if (!existing)
        holdings.set(event.holdingId, structuredClone(event.payload.holding));
    } else if (
      event.type === "holding.quantity-adjusted" &&
      existing &&
      !existing.deletedAt
    ) {
      const nextQuantity = existing.quantity + event.payload.delta;
      if (
        !Number.isSafeInteger(nextQuantity) ||
        nextQuantity < 0 ||
        nextQuantity > MAX_HOLDING_QUANTITY
      ) {
        throw new RangeError("Quantity adjustment exceeds collection limits");
      }
      holdings.set(event.holdingId, {
        ...existing,
        quantity: nextQuantity,
        updatedAt: event.occurredAt,
        deletedAt: nextQuantity === 0 ? event.occurredAt : undefined,
      });
    } else if (
      event.type === "holding.updated" &&
      existing &&
      !existing.deletedAt
    ) {
      holdings.set(event.holdingId, {
        ...existing,
        finish: event.payload.finish ?? existing.finish,
        condition: event.payload.condition ?? existing.condition,
        unitCost:
          event.payload.unitCost === null
            ? undefined
            : (event.payload.unitCost ?? existing.unitCost),
        note:
          event.payload.note === null
            ? undefined
            : (event.payload.note ?? existing.note),
        quote:
          event.payload.quote === null
            ? undefined
            : (event.payload.quote ?? existing.quote),
        updatedAt: event.occurredAt,
      });
    } else if (event.type === "holding.removed" && existing) {
      holdings.set(event.holdingId, {
        ...existing,
        deletedAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
    }

    const current = holdings.get(event.holdingId);
    activities.push({
      id: event.id,
      holdingId: event.holdingId,
      type: event.type,
      occurredAt: event.occurredAt,
      cardName:
        event.type === "holding.added"
          ? event.payload.holding.card.name
          : (current?.card.name ?? "Unknown card"),
      quantityDelta:
        event.type === "holding.quantity-adjusted"
          ? event.payload.delta
          : undefined,
    });
  }

  return {
    holdings: [...holdings.values()]
      .filter((holding) => !holding.deletedAt && holding.quantity > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    activities: activities.reverse(),
    eventCount: events.length,
  };
}

export function findDuplicate(
  snapshot: CollectionSnapshot,
  input: AddHoldingInput,
): Holding | undefined {
  const signature = holdingSignature(
    input.card.id,
    input.finish,
    input.condition,
  );
  return snapshot.holdings.find(
    (holding) =>
      holdingSignature(holding.cardId, holding.finish, holding.condition) ===
        signature && copyMetadataMatches(holding, input),
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function metadataKey(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "undefined";
}

function copyMetadataMatches(
  holding: Holding,
  input: AddHoldingInput,
): boolean {
  return (
    metadataKey(holding.unitCost) === metadataKey(input.unitCost) &&
    metadataKey(holding.quote) ===
      metadataKey(input.quote ?? input.card.quote) &&
    holding.note === input.note &&
    holding.acquiredAt === input.acquiredAt &&
    holding.card.language === input.card.language
  );
}
