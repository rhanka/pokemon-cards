import type { SyncOperation } from "../../shared/types.js";

export const SYNC_STORAGE_VERSION = 1;

export type JsonObject = Record<string, unknown>;

export interface CompactedSyncOperation {
  payload: JsonObject;
  cardSnapshot: JsonObject | null;
  quoteSnapshot: JsonObject | null;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function quoteBundle(holding: JsonObject, card: JsonObject): JsonObject | null {
  const bundle: JsonObject = {};
  if (Object.hasOwn(holding, "quote")) bundle.holdingQuote = holding.quote;
  if (Object.hasOwn(card, "quote")) bundle.cardQuote = card.quote;
  if (Object.hasOwn(card, "quotes")) bundle.cardQuotes = card.quotes;
  return Object.keys(bundle).length > 0 ? bundle : null;
}

/**
 * Remove catalogue and quote snapshots from the account-owned event row.
 *
 * The snapshots are content-addressed by the store and shared globally. The
 * remaining payload retains user-owned fields such as condition, acquisition
 * cost and notes. Redundant holding fields are omitted only when they can be
 * reconstructed losslessly from the operation envelope.
 */
export function compactSyncOperation(
  operation: SyncOperation,
): CompactedSyncOperation {
  const payload = { ...operation.payload };

  if (operation.type === "holding.added") {
    const holding = object(payload.holding);
    const card = holding ? object(holding.card) : null;
    if (!holding || !card) {
      return { payload, cardSnapshot: null, quoteSnapshot: null };
    }

    const compactHolding = { ...holding };
    const cardSnapshot = { ...card };
    const quoteSnapshot = quoteBundle(holding, card);
    delete compactHolding.card;
    delete compactHolding.quote;
    delete cardSnapshot.quote;
    delete cardSnapshot.quotes;

    if (compactHolding.id === operation.holdingId) delete compactHolding.id;
    if (
      typeof cardSnapshot.id === "string" &&
      compactHolding.cardId === cardSnapshot.id
    ) {
      delete compactHolding.cardId;
    }
    if (compactHolding.addedAt === operation.occurredAt)
      delete compactHolding.addedAt;
    if (compactHolding.updatedAt === operation.occurredAt)
      delete compactHolding.updatedAt;

    return {
      payload: { ...payload, holding: compactHolding },
      cardSnapshot,
      quoteSnapshot,
    };
  }

  if (operation.type === "holding.updated") {
    const quoteSnapshot = object(payload.quote);
    if (quoteSnapshot) delete payload.quote;
    return { payload, cardSnapshot: null, quoteSnapshot };
  }

  return { payload, cardSnapshot: null, quoteSnapshot: null };
}

export function rehydrateSyncOperation(
  envelope: Omit<SyncOperation, "payload">,
  payload: JsonObject,
  cardSnapshot: JsonObject | null,
  quoteSnapshot: JsonObject | null,
): SyncOperation {
  const hydratedPayload = { ...payload };

  if (envelope.type === "holding.added" && cardSnapshot) {
    const compactHolding = object(hydratedPayload.holding) ?? {};
    const quoteBundle = quoteSnapshot ?? {};
    const card = { ...cardSnapshot };
    if (Object.hasOwn(quoteBundle, "cardQuote"))
      card.quote = quoteBundle.cardQuote;
    if (Object.hasOwn(quoteBundle, "cardQuotes"))
      card.quotes = quoteBundle.cardQuotes;
    hydratedPayload.holding = {
      id: envelope.holdingId,
      cardId:
        typeof compactHolding.cardId === "string"
          ? compactHolding.cardId
          : cardSnapshot.id,
      addedAt:
        typeof compactHolding.addedAt === "string"
          ? compactHolding.addedAt
          : envelope.occurredAt,
      updatedAt:
        typeof compactHolding.updatedAt === "string"
          ? compactHolding.updatedAt
          : envelope.occurredAt,
      ...compactHolding,
      card,
      ...(Object.hasOwn(quoteBundle, "holdingQuote")
        ? { quote: quoteBundle.holdingQuote }
        : {}),
    };
  } else if (envelope.type === "holding.updated" && quoteSnapshot) {
    hydratedPayload.quote = quoteSnapshot;
  }

  return {
    ...envelope,
    payload: hydratedPayload,
  } as SyncOperation;
}
