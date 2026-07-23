export const CARD_LANGUAGES = ["en", "fr"] as const;

export type CardLanguage = (typeof CARD_LANGUAGES)[number];

export type CatalogueSource = "tcgdex" | "pokemon_tcg";

export type QuoteSource = CatalogueSource;

export type QuoteMarket = "tcgplayer" | "cardmarket" | "tcgdex";

export type CardCondition =
  | "unknown"
  | "mint"
  | "near_mint"
  | "lightly_played"
  | "moderately_played"
  | "heavily_played"
  | "damaged";

export type CardFinish =
  | "unknown"
  | "normal"
  | "holo"
  | "reverse_holo"
  | "first_edition"
  | "first_edition_holo"
  | "promo";

export interface CardQuote {
  source: QuoteSource;
  sku: string;
  market: QuoteMarket;
  currency: string;
  condition: CardCondition;
  finish: CardFinish;
  low: number | null;
  median: number | null;
  high: number | null;
  volume: number | null;
  observedAt: string;
  staleAfter: string;
}

export interface CardSet {
  id: string;
  name: string;
  series: string | null;
  printedTotal: number | null;
  total: number | null;
}

export interface CardImages {
  small: string | null;
  large: string | null;
}

/**
 * `id` is a source-independent business key derived from language, set,
 * collector number and name. Provider identifiers are retained as mappings.
 */
export interface PokemonCard {
  id: string;
  name: string;
  number: string | null;
  language: CardLanguage;
  supertype: string | null;
  subtypes: string[];
  rarity: string | null;
  set: CardSet;
  images: CardImages;
  externalIds: Partial<Record<CatalogueSource, string>>;
  sources: CatalogueSource[];
  quotes: CardQuote[];
  updatedAt: string;
}

export interface CatalogueMetadata {
  source: CatalogueSource;
  cache: "hit" | "miss" | "stale";
  stale: boolean;
  fetchedAt: string;
  staleAfter: string;
  warning?: string;
}

export interface CatalogueSearchResult {
  cards: PokemonCard[];
  query: string;
  metadata: CatalogueMetadata;
}

export interface CatalogueCardResult {
  card: PokemonCard;
  metadata: CatalogueMetadata;
}

export interface Holding {
  id: string;
  cardId: string;
  quantity: number;
  language: CardLanguage;
  condition: CardCondition;
  finish: CardFinish;
  acquisitionCost: number | null;
  acquisitionCurrency: string | null;
  acquiredAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OpaqueSyncObject = Record<string, unknown>;

interface SyncOperationBase {
  id: string;
  deviceId: string;
  holdingId: string;
  occurredAt: string;
  syncedAt?: string;
}

export interface HoldingAddedEvent extends SyncOperationBase {
  type: "holding.added";
  payload: {
    holding: OpaqueSyncObject;
    [key: string]: unknown;
  };
}

export interface QuantityAdjustedEvent extends SyncOperationBase {
  type: "holding.quantity-adjusted";
  payload: {
    delta: number;
    [key: string]: unknown;
  };
}

export interface HoldingUpdatedEvent extends SyncOperationBase {
  type: "holding.updated";
  payload: OpaqueSyncObject;
}

export interface HoldingRemovedEvent extends SyncOperationBase {
  type: "holding.removed";
  payload: OpaqueSyncObject;
}

export type SyncOperation =
  | HoldingAddedEvent
  | QuantityAdjustedEvent
  | HoldingUpdatedEvent
  | HoldingRemovedEvent;

export interface SyncRequest {
  cursor?: string | null;
  operations: SyncOperation[];
}

export type SyncEvent = SyncOperation & {
  sequence: number;
  receivedAt: string;
};

export interface SyncResponse {
  acceptedOperationIds: string[];
  cursor: string;
  events: SyncEvent[];
  hasMore: boolean;
  retentionUntil: string;
}

export interface RecognitionCandidate {
  cardId: string;
  score: number;
  visualScore: number | null;
  ocrScore: number | null;
  hashScore: number | null;
}

export interface OcrLine {
  text: string;
  confidence: number;
}

export interface ParsedCardText {
  rawText: string;
  name?: string;
  number?: string;
  setTotal?: string;
  query: string;
  confidence: number;
  signals: string[];
}

export type RecognitionEvidence = Omit<ParsedCardText, "rawText">;

export interface ServerRecognitionResult {
  evidence: RecognitionEvidence;
  cards: PokemonCard[];
  visualMatches: Array<{
    cardId: string;
    similarity: number;
    provider: "server-model";
  }>;
  engine: "tesseract" | "onnx";
  modelVersion: string | null;
  durationMs: number;
  photoRetained: false;
}

export interface RecognitionResult {
  candidates: RecognitionCandidate[];
  acceptedCardId: string | null;
  abstained: boolean;
  modelVersion: string | null;
  durationMs: number;
}

export interface PublicAppConfig {
  recognition: {
    enabled: boolean;
    processing: "server";
    maxImageBytes: number;
  };
  auth: {
    enabled: boolean;
    issuer: string | null;
    clientId: string;
    audience: string | null;
  };
  sync: {
    enabled: boolean;
    retentionDays: number;
    maxBatchSize: number;
  };
  catalogue: {
    languages: CardLanguage[];
    primary: CatalogueSource;
    secondary: CatalogueSource;
  };
  valuation: {
    marketQuotesEnabled: boolean;
  };
  privacy: {
    photosUploadedForRecognition: boolean;
    photosRetained: false;
  };
}
