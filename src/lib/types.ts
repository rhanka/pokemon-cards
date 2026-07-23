export type Locale = "en" | "fr";

export type AppView = "scanner" | "collection" | "insights" | "settings";

export type RestoreMode = "merge" | "replace";

export type CardLanguage = "en" | "fr" | "ja" | "other";

// The catalogue currently guarantees French and English records. Keep this
// separate from the interface locale: the language printed on a card is a
// property of the holding, not a display preference.
export type CatalogLanguage = Extract<CardLanguage, "en" | "fr">;

export type CardFinish =
  "normal" | "reverse" | "holo" | "first-edition" | "other";

export type CardCondition =
  "mint" | "near-mint" | "excellent" | "good" | "played" | "poor";

export type Money = {
  amount: number;
  currency: string;
};

export type PriceQuote = {
  id?: string;
  source: string;
  sourceUrl?: string;
  market: string;
  currency: string;
  sku?: string;
  condition?: CardCondition;
  conditionIncluded?: boolean;
  finish?: CardFinish;
  low: number | null;
  marketPrice: number | null;
  high: number | null;
  volume?: number | null;
  liquidity?: "high" | "medium" | "low" | "unknown";
  observedAt: string;
  staleAfter: string;
};

export type CardImage = {
  small?: string;
  large?: string;
};

export type CatalogCard = {
  id: string;
  name: string;
  number?: string;
  printedNumber?: string;
  setId?: string;
  setName?: string;
  language?: CardLanguage;
  rarity?: string;
  releaseDate?: string;
  images?: CardImage;
  quote?: PriceQuote;
  quotes?: PriceQuote[];
  externalIds?: Record<string, string>;
  reference?: {
    perceptualHash?: string;
    rgbHash?: number[];
  };
};

export type OcrLine = {
  text: string;
  confidence: number;
};

export type ParsedCardText = {
  rawText: string;
  name?: string;
  number?: string;
  setTotal?: string;
  query: string;
  confidence: number;
  signals: string[];
};

export type ImageFingerprint = {
  perceptualHash: string;
  rgbHash: number[];
};

export type VisualMatch = {
  cardId: string;
  similarity: number;
  provider: "local-model" | "reference-image";
};

export type RecognitionCandidate = CatalogCard & {
  score: number;
  scoreParts: {
    number: number;
    name: number;
    visual: number | null;
    catalogue: number;
  };
  matchReasons: string[];
};

export type RecognitionDecision = {
  status: "confident" | "review" | "no-match";
  candidates: RecognitionCandidate[];
  best?: RecognitionCandidate;
  score: number;
  margin: number;
};

export type RuntimeConfig = {
  appName: string;
  auth: {
    enabled: boolean;
    issuer?: string;
    clientId?: string;
    audience?: string;
    scope: string;
  };
  vision: {
    enabled: boolean;
    moduleUrl?: string;
    modelUrl?: string;
    indexUrl?: string;
    modelVersion?: string;
  };
  sync: {
    enabled: boolean;
    retentionDays: number;
  };
};

export type Holding = {
  id: string;
  cardId: string;
  card: CatalogCard;
  quantity: number;
  finish: CardFinish;
  condition: CardCondition;
  unitCost?: Money;
  quote?: PriceQuote;
  note?: string;
  acquiredAt?: string;
  addedAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type HoldingAddedEvent = {
  id: string;
  type: "holding.added";
  holdingId: string;
  occurredAt: string;
  deviceId: string;
  payload: { holding: Holding };
  syncedAt?: string;
};

export type QuantityAdjustedEvent = {
  id: string;
  type: "holding.quantity-adjusted";
  holdingId: string;
  occurredAt: string;
  deviceId: string;
  payload: { delta: number };
  syncedAt?: string;
};

export type HoldingUpdatedEvent = {
  id: string;
  type: "holding.updated";
  holdingId: string;
  occurredAt: string;
  deviceId: string;
  payload: {
    finish?: CardFinish;
    condition?: CardCondition;
    unitCost?: Money | null;
    note?: string | null;
    quote?: PriceQuote | null;
  };
  syncedAt?: string;
};

export type HoldingRemovedEvent = {
  id: string;
  type: "holding.removed";
  holdingId: string;
  occurredAt: string;
  deviceId: string;
  payload: { reason?: string };
  syncedAt?: string;
};

export type CollectionEvent =
  | HoldingAddedEvent
  | QuantityAdjustedEvent
  | HoldingUpdatedEvent
  | HoldingRemovedEvent;

export type CollectionActivity = {
  id: string;
  holdingId: string;
  type: CollectionEvent["type"];
  occurredAt: string;
  cardName: string;
  quantityDelta?: number;
};

export type CollectionSnapshot = {
  holdings: Holding[];
  activities: CollectionActivity[];
  eventCount: number;
};

export type CurrencyTotal = {
  currency: string;
  low: number | null;
  market: number | null;
  high: number | null;
  cost: number | null;
  costCoverage: "complete" | "partial" | "none";
  net: number | null;
};

export type ValuationPreference = {
  market: string;
  currency: string;
};

export type CollectionTotals = {
  cards: number;
  unique: number;
  currencies: CurrencyTotal[];
};

export type ReviewReason =
  | "missing-price"
  | "stale-price"
  | "low-liquidity"
  | "unknown-liquidity"
  | "missing-cost";

export type ReviewItem = {
  holding: Holding;
  reasons: ReviewReason[];
  priority: number;
};

export type OidcSession = {
  accessToken: string;
  expiresAt?: number;
  profile?: Record<string, unknown>;
};
