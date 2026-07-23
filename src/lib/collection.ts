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
  return {
    id: makeId("holding"),
    cardId: input.card.id,
    card: input.card,
    quantity: normalizeHoldingQuantity(input.quantity ?? 1),
    finish: input.finish,
    condition: input.condition,
    unitCost: input.unitCost,
    quote: input.quote ?? input.card.quote,
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
