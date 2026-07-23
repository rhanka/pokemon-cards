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

const defaultConfig: RuntimeConfig = {
  appName: "CardScope",
  recognition: {
    enabled: false,
    processing: "server",
    maxImageBytes: 2 * 1024 * 1024,
  },
  auth: { enabled: false, scope: "openid profile email" },
  sync: { enabled: false, retentionDays: 1826 },
  valuation: { marketQuotesEnabled: false },
};

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly retryAfterSeconds: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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
    let message = `Request failed (${response.status})`;
    try {
      const parsed = object(JSON.parse(detail));
      const apiError = object(parsed.error);
      code = string(apiError.code);
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
  if (
    !id ||
    !holdingId ||
    !occurredAt ||
    !deviceId ||
    !event.payload ||
    typeof event.payload !== "object"
  ) {
    return null;
  }
  const payload = object(event.payload);
  const base = { id, holdingId, occurredAt, deviceId, syncedAt };
  switch (type) {
    case "holding.added":
      if (!payload.holding || typeof payload.holding !== "object") return null;
      return {
        ...base,
        type,
        payload: {
          holding: payload.holding as Extract<
            CollectionEvent,
            { type: "holding.added" }
          >["payload"]["holding"],
        },
      };
    case "holding.quantity-adjusted":
      if (typeof payload.delta !== "number") return null;
      return { ...base, type, payload: { delta: payload.delta } };
    case "holding.updated": {
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
      return { ...base, type, payload: update };
    }
    case "holding.removed":
      return {
        ...base,
        type,
        payload:
          typeof payload.reason === "string" ? { reason: payload.reason } : {},
      };
    default:
      return null;
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await apiFetch("/api/config", {
      signal: AbortSignal.timeout(3_500),
    });
    const raw = object(await response.json());
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
      },
      valuation: {
        marketQuotesEnabled: Boolean(valuation.marketQuotesEnabled),
      },
    };
  } catch {
    return defaultConfig;
  }
}

export async function recognizeCardImage(
  image: Blob,
  cardLanguage: CatalogLanguage,
  signal?: AbortSignal,
): Promise<ServerRecognitionResult> {
  const params = new URLSearchParams({ language: cardLanguage });
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
      .map((card) => normalizeCard(card, cardLanguage))
      .filter((card): card is CatalogCard => card !== null),
  };
}

export async function searchCatalog(
  parsed: ParsedCardText,
  cardLanguage: CatalogLanguage,
  locale: Locale,
  signal?: AbortSignal,
  valuationPreference?: ValuationPreference,
): Promise<CatalogCard[]> {
  const params = new URLSearchParams({
    q: parsed.query,
    language: cardLanguage,
    limit: "12",
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
    .map((card) => ({ ...card, language: card.language ?? cardLanguage }));
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
): Promise<{
  acceptedIds: string[];
  remoteEvents: CollectionEvent[];
  cursor: string;
  hasMore: boolean;
}> {
  const response = await apiFetch(
    "/api/sync",
    {
      method: "POST",
      body: JSON.stringify({ cursor: cursor ?? null, operations: events }),
    },
    session,
  );
  const body = object(await response.json());
  const accepted =
    body.acceptedOperationIds ?? body.acceptedIds ?? body.accepted_ids;
  const remote = body.events ?? body.remoteEvents ?? body.remote_events;
  const syncedAt = new Date().toISOString();
  return {
    acceptedIds: Array.isArray(accepted)
      ? accepted.filter((id): id is string => typeof id === "string")
      : [],
    remoteEvents: Array.isArray(remote)
      ? remote
          .map((value) => sanitizeRemoteCollectionEvent(value, syncedAt))
          .filter((event): event is CollectionEvent => event !== null)
      : [],
    cursor: string(body.cursor) ?? cursor ?? "0",
    hasMore: Boolean(body.hasMore ?? body.has_more),
  };
}

export async function deleteCloudCollection(
  session: OidcSession,
): Promise<void> {
  await apiFetch("/api/sync", { method: "DELETE" }, session);
}
