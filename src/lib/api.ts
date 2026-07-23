import type {
  CardCondition,
  CardFinish,
  CatalogLanguage,
  CatalogCard,
  CollectionEvent,
  Locale,
  OidcSession,
  ParsedCardText,
  PriceQuote,
  RuntimeConfig,
  ServerRecognitionResult,
  ValuationPreference,
} from "./types";
import { selectPriceQuote } from "./value";
import { normalizeCurrency } from "./money";
import {
  CollectionMutationLockedError,
  CollectionSyncGenerationFenceError,
  isCollectionEvent,
} from "./db";

const defaultConfig: RuntimeConfig = {
  appName: "CardScope",
  recognition: {
    enabled: false,
    processing: "server",
    maxImageBytes: 2 * 1024 * 1024,
  },
  auth: { enabled: false, scope: "openid profile email" },
  sync: {
    enabled: false,
    retentionDays: 1826,
    maxBatchSize: 100,
    maxOperationBytes: 64 * 1024,
  },
  valuation: { marketQuotesEnabled: false },
};
const runtimeConfigCacheKey = "cardscope-runtime-config-v1";
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000;
export const DEFAULT_SYNC_REQUEST_BUDGET_BYTES = 1_750_000;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly retryAfterSeconds: number | undefined,
    message: string,
    readonly currentGeneration?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProtocolError";
  }
}

export class SyncBatchSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncBatchSizeError";
  }
}

export function isRetryableSyncError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  if (
    error instanceof SyncProtocolError ||
    error instanceof SyncBatchSizeError
  ) {
    return false;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError";
  }
  // fetch rejects transport failures as TypeError in browsers.
  if (error instanceof TypeError) return true;
  if (
    error instanceof CollectionMutationLockedError ||
    error instanceof CollectionSyncGenerationFenceError
  )
    return true;
  return false;
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
  session?: OidcSession,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (session?.accessToken)
    headers.set("authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let code: string | undefined;
    let currentGeneration: string | undefined;
    let message = `Request failed (${response.status})`;
    try {
      const parsed = object(JSON.parse(detail));
      const apiError = object(parsed.error);
      code = string(apiError.code);
      currentGeneration = positiveSafeIntegerString(
        apiError.currentGeneration,
        false,
      );
      message = string(apiError.message) ?? message;
    } catch {
      if (detail) message = detail;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiRequestError(
      response.status,
      code,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      message,
      currentGeneration,
    );
  }
  return response;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveSafeIntegerString(
  value: unknown,
  allowZero: boolean,
): string | undefined {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0)
    ? value
    : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCondition(value: unknown): CardCondition | undefined {
  const conditions: Record<string, CardCondition | undefined> = {
    mint: "mint",
    near_mint: "near-mint",
    lightly_played: "excellent",
    moderately_played: "good",
    heavily_played: "played",
    damaged: "poor",
    unknown: undefined,
  };
  return conditions[string(value) ?? ""];
}

function normalizeFinish(value: unknown): CardFinish | undefined {
  const finishes: Record<string, CardFinish | undefined> = {
    normal: "normal",
    holo: "holo",
    reverse_holo: "reverse",
    first_edition: "first-edition",
    first_edition_holo: "first-edition",
    promo: "other",
    unknown: undefined,
  };
  return finishes[string(value) ?? ""];
}

function normalizeQuote(input: unknown): PriceQuote | undefined {
  if (!input || typeof input !== "object") return undefined;
  const quote = object(input);
  const observedAt = string(quote.observedAt ?? quote.observed_at);
  const staleAfter = string(quote.staleAfter ?? quote.stale_after);
  const source = string(quote.source);
  const currency = normalizeCurrency(string(quote.currency) ?? "USD");
  if (!source || !observedAt || !staleAfter || !currency) return undefined;
  const rawCondition = string(quote.condition);
  return {
    id: string(quote.id),
    source,
    sourceUrl: string(quote.sourceUrl ?? quote.source_url),
    market: string(quote.market) ?? "unknown",
    currency,
    sku: string(quote.sku),
    condition: normalizeCondition(quote.condition),
    conditionIncluded: Boolean(rawCondition && rawCondition !== "unknown"),
    finish: normalizeFinish(quote.finish),
    low: numberOrNull(quote.low),
    marketPrice: numberOrNull(
      quote.marketPrice ?? quote.market_price ?? quote.mid ?? quote.median,
    ),
    high: numberOrNull(quote.high),
    volume: numberOrNull(quote.volume),
    liquidity:
      (string(quote.liquidity) as PriceQuote["liquidity"]) ?? "unknown",
    observedAt,
    staleAfter,
  };
}

function normalizeCard(
  input: unknown,
  locale: Locale,
  valuationPreference?: ValuationPreference,
): CatalogCard | null {
  const card = object(input);
  const id = string(card.id ?? card.uid);
  const name = string(card.name);
  if (!id || !name) return null;
  const images = object(card.images ?? card.image);
  const set = object(card.set);
  const quoteInputs = Array.isArray(card.quotes)
    ? card.quotes
    : card.quote
      ? [card.quote]
      : [];
  const quotes = quoteInputs
    .map(normalizeQuote)
    .filter((quote): quote is PriceQuote => quote !== undefined);
  const reference = object(card.reference ?? card.fingerprint);
  return {
    id,
    name,
    number: string(card.number),
    printedNumber: string(
      card.printedNumber ?? card.printed_number ?? card.localId,
    ),
    setId: string(card.setId ?? card.set_id ?? set.id),
    setName: string(card.setName ?? card.set_name ?? set.name),
    language: (string(card.language) as CatalogCard["language"]) ?? undefined,
    rarity: string(card.rarity),
    releaseDate: string(card.releaseDate ?? card.release_date),
    images: {
      small: string(images.small ?? images.thumbnail ?? card.imageUrl),
      large: string(images.large ?? images.high ?? card.imageUrlHigh),
    },
    quote: selectPriceQuote(
      quotes,
      locale,
      "normal",
      undefined,
      valuationPreference,
    ),
    quotes,
    externalIds: object(card.externalIds ?? card.external_ids) as Record<
      string,
      string
    >,
    reference: {
      perceptualHash: string(
        reference.perceptualHash ?? reference.perceptual_hash,
      ),
      rgbHash: Array.isArray(reference.rgbHash ?? reference.rgb_hash)
        ? ((reference.rgbHash ?? reference.rgb_hash) as number[])
        : undefined,
    },
  };
}

function sanitizeRemoteCollectionEvent(
  input: unknown,
  syncedAt: string,
): CollectionEvent | null {
  const event = object(input);
  const id = string(event.id);
  const holdingId = string(event.holdingId);
  const occurredAt = string(event.occurredAt);
  const deviceId = string(event.deviceId);
  const type = string(event.type);
  const serverSequence = positiveSafeInteger(event.sequence);
  const receivedAt = string(event.receivedAt);
  if (
    !id ||
    !holdingId ||
    !occurredAt ||
    !deviceId ||
    serverSequence === undefined ||
    !receivedAt ||
    !isIsoTimestamp(receivedAt) ||
    !event.payload ||
    typeof event.payload !== "object"
  ) {
    return null;
  }
  const payload = object(event.payload);
  const base = {
    id,
    holdingId,
    occurredAt,
    deviceId,
    serverSequence,
    syncedAt,
  };
  let sanitized: CollectionEvent;
  switch (type) {
    case "holding.added":
      if (
        !hasOnlyObjectKeys(payload, ["holding"]) ||
        !payload.holding ||
        typeof payload.holding !== "object"
      ) {
        return null;
      }
      sanitized = {
        ...base,
        type,
        payload: {
          holding: payload.holding as Extract<
            CollectionEvent,
            { type: "holding.added" }
          >["payload"]["holding"],
        },
      };
      break;
    case "holding.quantity-adjusted":
      if (
        !hasOnlyObjectKeys(payload, ["delta"]) ||
        typeof payload.delta !== "number"
      ) {
        return null;
      }
      sanitized = { ...base, type, payload: { delta: payload.delta } };
      break;
    case "holding.updated": {
      if (
        !hasOnlyObjectKeys(payload, [
          "finish",
          "condition",
          "unitCost",
          "note",
          "quote",
        ])
      ) {
        return null;
      }
      const update: Extract<
        CollectionEvent,
        { type: "holding.updated" }
      >["payload"] = {};
      if ("finish" in payload)
        update.finish = payload.finish as typeof update.finish;
      if ("condition" in payload)
        update.condition = payload.condition as typeof update.condition;
      if ("unitCost" in payload)
        update.unitCost = payload.unitCost as typeof update.unitCost;
      if ("note" in payload) update.note = payload.note as typeof update.note;
      if ("quote" in payload)
        update.quote = payload.quote as typeof update.quote;
      sanitized = { ...base, type, payload: update };
      break;
    }
    case "holding.removed":
      if (
        !hasOnlyObjectKeys(payload, ["reason"]) ||
        ("reason" in payload && typeof payload.reason !== "string")
      ) {
        return null;
      }
      sanitized = {
        ...base,
        type,
        payload:
          typeof payload.reason === "string" ? { reason: payload.reason } : {},
      };
      break;
    default:
      return null;
  }
  return isCollectionEvent(sanitized) ? sanitized : null;
}

function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const raw = object(input);
  const auth = object(raw.auth ?? raw.oidc);
  const recognition = object(raw.recognition);
  const sync = object(raw.sync);
  const valuation = object(raw.valuation);
  return {
    appName: string(raw.appName ?? raw.app_name) ?? defaultConfig.appName,
    recognition: {
      enabled:
        recognition.enabled === undefined
          ? defaultConfig.recognition.enabled
          : Boolean(recognition.enabled),
      processing: "server",
      maxImageBytes:
        typeof recognition.maxImageBytes === "number"
          ? recognition.maxImageBytes
          : typeof recognition.max_image_bytes === "number"
            ? recognition.max_image_bytes
            : defaultConfig.recognition.maxImageBytes,
    },
    auth: {
      enabled: Boolean(auth.enabled),
      issuer: string(auth.issuer ?? auth.authority),
      clientId: string(auth.clientId ?? auth.client_id),
      audience: string(auth.audience),
      scope: string(auth.scope) ?? defaultConfig.auth.scope,
    },
    sync: {
      enabled: Boolean(sync.enabled ?? auth.enabled),
      retentionDays:
        typeof sync.retentionDays === "number"
          ? sync.retentionDays
          : typeof sync.retention_days === "number"
            ? sync.retention_days
            : defaultConfig.sync.retentionDays,
      maxBatchSize:
        positiveSafeInteger(sync.maxBatchSize ?? sync.max_batch_size) ??
        defaultConfig.sync.maxBatchSize,
      maxOperationBytes:
        positiveSafeInteger(
          sync.maxOperationBytes ?? sync.max_operation_bytes,
        ) ?? defaultConfig.sync.maxOperationBytes,
    },
    valuation: {
      marketQuotesEnabled: Boolean(valuation.marketQuotesEnabled),
    },
  };
}

function cachedRuntimeConfig(): RuntimeConfig | null {
  try {
    const cached = localStorage.getItem(runtimeConfigCacheKey);
    return cached ? parseRuntimeConfig(JSON.parse(cached)) : null;
  } catch {
    return null;
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await apiFetch("/api/config", {
      signal: AbortSignal.timeout(3_500),
    });
    const config = parseRuntimeConfig(await response.json());
    try {
      localStorage.setItem(runtimeConfigCacheKey, JSON.stringify(config));
    } catch {
      // Public configuration caching is a progressive offline enhancement.
    }
    return config;
  } catch {
    return cachedRuntimeConfig() ?? defaultConfig;
  }
}

export async function recognizeCardImage(
  image: Blob,
  locale: Locale,
  signal?: AbortSignal,
): Promise<ServerRecognitionResult> {
  const params = new URLSearchParams({ language: "auto" });
  const deadline = AbortSignal.timeout(40_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await apiFetch(
    `/api/recognition/cards?${params.toString()}`,
    {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: image,
      signal: requestSignal,
    },
  );
  const raw = (await response.json()) as Omit<
    ServerRecognitionResult,
    "cards"
  > & { cards?: unknown[] };
  return {
    ...raw,
    cards: (Array.isArray(raw.cards) ? raw.cards : [])
      .map((card) => normalizeCard(card, locale))
      .filter((card): card is CatalogCard => card !== null),
  };
}

export async function searchCatalog(
  parsed: ParsedCardText,
  cardLanguage: CatalogLanguage | "auto",
  locale: Locale,
  signal?: AbortSignal,
  valuationPreference?: ValuationPreference,
): Promise<CatalogCard[]> {
  const params = new URLSearchParams({
    q: parsed.query,
    language: cardLanguage,
    limit: cardLanguage === "auto" ? "24" : "12",
  });
  const response = await apiFetch(`/api/catalog/cards?${params.toString()}`, {
    signal: signal ?? AbortSignal.timeout(8_000),
  });
  const body: unknown = await response.json();
  const root = object(body);
  const values = Array.isArray(body)
    ? body
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.cards)
        ? root.cards
        : Array.isArray(root.results)
          ? root.results
          : [];
  return values
    .map((card) => normalizeCard(card, locale, valuationPreference))
    .filter((card): card is CatalogCard => card !== null)
    .map((card) => ({
      ...card,
      language:
        card.language ?? (cardLanguage === "auto" ? undefined : cardLanguage),
    }));
}

export async function getCatalogCard(
  cardId: string,
  cardLanguage: CatalogLanguage,
  locale: Locale,
  options: { valuationPreference?: ValuationPreference } = {},
): Promise<CatalogCard> {
  const params = new URLSearchParams({ language: cardLanguage });
  const response = await apiFetch(
    `/api/catalog/cards/${encodeURIComponent(cardId)}?${params.toString()}`,
    {
      signal: AbortSignal.timeout(8_000),
    },
  );
  const body: unknown = await response.json();
  const root = object(body);
  const card = normalizeCard(
    root.card ?? body,
    locale,
    options.valuationPreference,
  );
  if (!card) throw new Error("Catalogue card response is invalid");
  return { ...card, language: card.language ?? cardLanguage };
}

export async function syncCollectionEvents(
  events: CollectionEvent[],
  session: OidcSession,
  cursor?: string | null,
  generation?: string | null,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    requireEmpty?: boolean;
  } = {},
): Promise<{
  acceptedIds: string[];
  remoteEvents: CollectionEvent[];
  cursor: string;
  hasMore: boolean;
  generation: string;
}> {
  const normalizedCursor =
    cursor === undefined || cursor === null
      ? null
      : positiveSafeIntegerString(cursor, true);
  const normalizedGeneration =
    generation === undefined || generation === null
      ? null
      : positiveSafeIntegerString(generation, false);
  if (cursor !== undefined && cursor !== null && normalizedCursor === undefined)
    throw new SyncProtocolError("Sync cursor is invalid");
  if (
    generation !== undefined &&
    generation !== null &&
    normalizedGeneration === undefined
  )
    throw new SyncProtocolError("Sync generation is invalid");
  const operationIds = events.map((event) => event.id);
  if (
    operationIds.some((id) => !id) ||
    new Set(operationIds).size !== operationIds.length
  ) {
    throw new SyncProtocolError(
      "Sync operation ids must be non-empty and unique",
    );
  }
  const requestBody: Record<string, unknown> = {
    cursor: normalizedCursor,
    generation: normalizedGeneration,
    operations: events.map(operationForSync),
  };
  if (options.requireEmpty) requestBody.requireEmpty = true;
  const response = await apiFetch(
    "/api/sync",
    {
      method: "POST",
      body: JSON.stringify(requestBody),
      signal: syncRequestSignal(options.signal, options.timeoutMs),
    },
    session,
  );
  const body = await strictJsonObject(response, "Sync response");
  const accepted = body.acceptedOperationIds;
  const remote = body.events;
  const responseCursor = positiveSafeIntegerString(body.cursor, true);
  const responseGeneration = positiveSafeIntegerString(body.generation, false);
  if (
    !Array.isArray(accepted) ||
    !accepted.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(accepted).size !== accepted.length ||
    !sameStringSet(accepted, operationIds)
  ) {
    throw new SyncProtocolError(
      "Sync response must acknowledge exactly the submitted operations",
    );
  }
  if (!Array.isArray(remote))
    throw new SyncProtocolError("Sync response events are invalid");
  if (!responseCursor)
    throw new SyncProtocolError("Sync response cursor is invalid");
  if (!responseGeneration)
    throw new SyncProtocolError("Sync response generation is invalid");
  if (typeof body.hasMore !== "boolean")
    throw new SyncProtocolError("Sync response pagination flag is invalid");
  if (
    typeof body.retentionUntil !== "string" ||
    !isIsoTimestamp(body.retentionUntil)
  ) {
    throw new SyncProtocolError("Sync response retention deadline is invalid");
  }
  const syncedAt = new Date().toISOString();
  const remoteEvents = remote.map((value) =>
    sanitizeRemoteCollectionEvent(value, syncedAt),
  );
  if (remoteEvents.some((event) => event === null))
    throw new SyncProtocolError("Sync response contains an invalid event");
  return {
    acceptedIds: accepted,
    remoteEvents: remoteEvents as CollectionEvent[],
    cursor: responseCursor,
    hasMore: body.hasMore,
    generation: responseGeneration,
  };
}

export async function deleteCloudCollection(
  session: OidcSession,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ generation: string }> {
  const response = await apiFetch(
    "/api/sync",
    {
      method: "DELETE",
      signal: syncRequestSignal(options.signal, options.timeoutMs),
    },
    session,
  );
  const body = await strictJsonObject(response, "Sync deletion response");
  const generation = positiveSafeIntegerString(body.generation, false);
  if (!generation || body.deleted !== true)
    throw new SyncProtocolError("Sync deletion response is invalid");
  return { generation };
}

export function selectSyncEventBatch(
  events: CollectionEvent[],
  maxEvents = 100,
  maxRequestBytes = DEFAULT_SYNC_REQUEST_BUDGET_BYTES,
): CollectionEvent[] {
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0)
    throw new RangeError("maxEvents must be a positive safe integer");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0)
    throw new RangeError("maxRequestBytes must be a positive safe integer");
  const selected: CollectionEvent[] = [];
  for (const event of events) {
    if (selected.length >= maxEvents) break;
    const candidate = [...selected, event];
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        cursor: String(Number.MAX_SAFE_INTEGER),
        generation: String(Number.MAX_SAFE_INTEGER),
        requireEmpty: true,
        operations: candidate.map(operationForSync),
      }),
    ).byteLength;
    if (bytes <= maxRequestBytes) {
      selected.push(event);
      continue;
    }
    if (selected.length === 0) {
      throw new SyncBatchSizeError(
        `Sync operation ${event.id} exceeds the request byte budget`,
      );
    }
    break;
  }
  return selected;
}

function operationForSync(event: CollectionEvent): CollectionEvent {
  const operation = { ...event };
  delete operation.serverSequence;
  delete operation.syncedAt;
  return operation;
}

function syncRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Sync timeout must be a positive safe integer");
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function strictJsonObject(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SyncProtocolError(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SyncProtocolError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function hasOnlyObjectKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
