import type {
  CardFinish,
  CardLanguage,
  CardQuote,
  CatalogueSource,
  PokemonCard,
  QuoteMarket,
} from "../../shared/types.js";

export interface CatalogueAdapter {
  readonly source: CatalogueSource;
  search(
    query: string,
    language: CardLanguage,
    limit: number,
  ): Promise<PokemonCard[]>;
  getCard(
    externalId: string,
    language: CardLanguage,
  ): Promise<PokemonCard | null>;
}

export class CatalogueProviderError extends Error {
  constructor(
    readonly source: CatalogueSource,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CatalogueProviderError";
  }
}

type JsonRecord = Record<string, unknown>;

interface AdapterOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  clock?: () => Date;
}

interface PokemonTcgAdapterOptions extends AdapterOptions {
  apiKey?: string | null;
}

type RequestHeaders = Record<string, string>;

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_CARDS = 50;
const MAX_CARD_SUBTYPES = 16;
const MAX_PRICE_VARIANTS = 16;
const MAX_ID_LENGTH = 160;
const MAX_NAME_LENGTH = 160;
const MAX_NUMBER_LENGTH = 64;
const MAX_LABEL_LENGTH = 200;
const MAX_SHORT_LABEL_LENGTH = 100;
const MAX_URL_LENGTH = 2_048;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function records(value: unknown, maximum = MAX_PROVIDER_CARDS): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const result: JsonRecord[] = [];
  for (const item of value.slice(0, maximum)) {
    const parsed = record(item);
    if (parsed) result.push(parsed);
  }
  return result;
}

function textValue(value: unknown, maximum = MAX_LABEL_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized !== "" && normalized.length <= maximum ? normalized : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function firstNumber(source: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function isoDate(value: unknown, fallback: Date): string {
  const source = textValue(value);
  if (!source) return fallback.toISOString();

  const parsed = new Date(source.replaceAll("/", "-"));
  return Number.isNaN(parsed.getTime())
    ? fallback.toISOString()
    : parsed.toISOString();
}

function upstreamQuoteDate(value: unknown): string | null {
  const source = textValue(value);
  if (!source) return null;

  const parsed = new Date(source.replaceAll("/", "-"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function plusDays(iso: string, days: number): string {
  return new Date(
    new Date(iso).getTime() + days * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export interface ParsedCardSearchQuery {
  name: string;
  number: string | null;
  setTotal: string | null;
}

interface CardSearchFilters {
  includeName: boolean;
  number: string | null;
  setTotal: string | null;
}

function normalizedCollectorNumber(value: string): string {
  return /^\d+$/.test(value) ? String(Number(value)) : value.toUpperCase();
}

export function parseCardSearchQuery(query: string): ParsedCardSearchQuery {
  const normalized = query.trim().replace(/\s+/g, " ");
  const fraction = normalized.match(
    /^(?:(.+?)\s+)?([a-z]*\d+[a-z]*)\s*\/\s*([a-z0-9-]+)$/i,
  );
  if (fraction) {
    return {
      name: fraction[1]?.trim() ?? "",
      number: normalizedCollectorNumber(fraction[2]),
      setTotal: normalizedCollectorNumber(fraction[3]),
    };
  }

  const promo = normalized.match(/^(.+?)\s+([a-z]+-?\d+[a-z]?)$/i);
  if (promo) {
    return {
      name: promo[1].trim(),
      number: normalizedCollectorNumber(promo[2]),
      setTotal: null,
    };
  }

  return { name: normalized, number: null, setTotal: null };
}

function cardSearchStrategies(
  parsed: ParsedCardSearchQuery,
): CardSearchFilters[] {
  const filterableTotal =
    parsed.setTotal && /^\d+$/.test(parsed.setTotal) ? parsed.setTotal : null;
  const candidates: CardSearchFilters[] = [
    {
      includeName: true,
      number: parsed.number,
      setTotal: filterableTotal,
    },
    {
      includeName: true,
      number: parsed.number,
      setTotal: null,
    },
    { includeName: true, number: null, setTotal: null },
    {
      includeName: false,
      number: parsed.number,
      setTotal: filterableTotal,
    },
    { includeName: false, number: parsed.number, setTotal: null },
  ];
  const seen = new Set<string>();
  return candidates.filter((filters) => {
    const effectiveName = filters.includeName ? parsed.name : "";
    if (!effectiveName && !filters.number) return false;
    const key = JSON.stringify([
      effectiveName,
      filters.number,
      filters.setTotal,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function makeCardId(input: {
  language: CardLanguage;
  setId: string;
  number: string | null;
  name: string;
}): string {
  return [
    "pokemon-card",
    input.language,
    slug(input.setId) || "unknown-set",
    slug(input.number ?? "") || "unknown-number",
    slug(input.name) || "unknown-name",
  ].join(":");
}

function finishForPriceKey(key: string): CardFinish {
  const normalized = key.slice(0, MAX_SHORT_LABEL_LENGTH).toLowerCase();
  if (normalized.includes("firstedition") && normalized.includes("holo")) {
    return "first_edition_holo";
  }
  if (normalized.includes("firstedition")) return "first_edition";
  if (normalized.includes("reverse")) return "reverse_holo";
  if (normalized.includes("holo")) return "holo";
  if (normalized.includes("promo")) return "promo";
  return "normal";
}

function priceQuote(input: {
  source: CatalogueSource;
  externalId: string;
  market: QuoteMarket;
  currency: string;
  finish: CardFinish;
  price: JsonRecord;
  observedAt: string;
}): CardQuote | null {
  const low = firstNumber(input.price, ["lowPrice", "low", "low_price"]);
  const median = firstNumber(input.price, [
    "marketPrice",
    "market",
    "trendPrice",
    "trend",
    "midPrice",
    "mid",
    "averageSellPrice",
    "avg",
  ]);
  const high = firstNumber(input.price, ["highPrice", "high", "high_price"]);
  const volume = firstNumber(input.price, ["volume", "sales", "count"]);

  if (low === null && median === null && high === null) return null;

  return {
    source: input.source,
    sku: `${input.externalId}:${input.market}:${input.finish}`,
    market: input.market,
    currency: input.currency,
    condition: "unknown",
    finish: input.finish,
    low,
    median,
    high,
    volume,
    observedAt: input.observedAt,
    staleAfter: plusDays(input.observedAt, 7),
  };
}

function tcgplayerQuotes(input: {
  source: CatalogueSource;
  externalId: string;
  pricing: JsonRecord | null;
  observedAt: string | null;
  currency?: string;
}): CardQuote[] {
  // A price without a provider observation time is not presented as current.
  // Fetch time is catalogue metadata, not evidence of when a market quote was observed.
  if (!input.pricing || !input.observedAt) return [];
  const quotes: CardQuote[] = [];
  for (const [variant, rawPrice] of Object.entries(input.pricing).slice(
    0,
    MAX_PRICE_VARIANTS,
  )) {
    const price = record(rawPrice);
    if (!price) continue;
    const quote = priceQuote({
      source: input.source,
      externalId: input.externalId,
      market: "tcgplayer",
      currency: input.currency ?? "USD",
      finish: finishForPriceKey(variant),
      price,
      observedAt: input.observedAt,
    });
    if (quote) quotes.push(quote);
  }
  return quotes;
}

function cardmarketQuotes(input: {
  source: CatalogueSource;
  externalId: string;
  pricing: JsonRecord | null;
  observedAt: string | null;
  currency?: string;
}): CardQuote[] {
  if (!input.pricing || !input.observedAt) return [];
  const quotes: CardQuote[] = [];
  const base = priceQuote({
    source: input.source,
    externalId: input.externalId,
    market: "cardmarket",
    currency: input.currency ?? "EUR",
    finish: "normal",
    price: input.pricing,
    observedAt: input.observedAt,
  });
  if (base) quotes.push(base);

  const reverseSource =
    record(input.pricing.reverse) ??
    (Object.keys(input.pricing).some((key) =>
      key.toLowerCase().includes("reverse"),
    )
      ? {
          low: input.pricing.reverseLow,
          trend: input.pricing.reverseTrend,
          avg: input.pricing.reverseHoloSell,
        }
      : null);
  if (reverseSource) {
    const reverse = priceQuote({
      source: input.source,
      externalId: input.externalId,
      market: "cardmarket",
      currency: input.currency ?? "EUR",
      finish: "reverse_holo",
      price: reverseSource,
      observedAt: input.observedAt,
    });
    if (reverse) quotes.push(reverse);
  }
  return quotes;
}

function endpoint(baseUrl: string, route: string): URL {
  return new URL(`${baseUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`);
}

async function fetchJson(input: {
  source: CatalogueSource;
  fetch: typeof fetch;
  url: URL;
  timeoutMs: number;
  maxResponseBytes: number;
  headers?: RequestHeaders;
}): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new CatalogueProviderError(
          input.source,
          `${input.source} request timed out`,
        ),
      );
    }, input.timeoutMs);
  });

  try {
    const request = (async () => {
      const response = await input.fetch(input.url, {
        headers: { Accept: "application/json", ...input.headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new CatalogueProviderError(
          input.source,
          `${input.source} returned HTTP ${response.status}`,
          response.status,
        );
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > input.maxResponseBytes
      ) {
        controller.abort();
        throw responseTooLarge(input.source, input.maxResponseBytes);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > input.maxResponseBytes) {
          controller.abort();
          throw responseTooLarge(input.source, input.maxResponseBytes);
        }
        return JSON.parse(text) as unknown;
      }

      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > input.maxResponseBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw responseTooLarge(input.source, input.maxResponseBytes);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    })();

    return await Promise.race([request, timeoutPromise]);
  } catch (error) {
    if (error instanceof CatalogueProviderError) throw error;
    throw new CatalogueProviderError(
      input.source,
      error instanceof Error ? error.message : `${input.source} request failed`,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function responseTooLarge(
  source: CatalogueSource,
  maximumBytes: number,
): CatalogueProviderError {
  return new CatalogueProviderError(
    source,
    `${source} response exceeded the ${maximumBytes}-byte limit`,
  );
}

function tcgdexImage(
  image: string | null,
  size: "low" | "high",
): string | null {
  if (!image) return null;
  if (/\.(?:avif|jpe?g|png|webp)$/i.test(image)) return image;
  const resolved = `${image.replace(/\/$/, "")}/${size}.webp`;
  return resolved.length <= MAX_URL_LENGTH ? resolved : null;
}

export function normalizeTcgdexCard(
  raw: unknown,
  language: CardLanguage,
  now = new Date(),
): PokemonCard {
  const card = record(raw);
  if (!card)
    throw new CatalogueProviderError(
      "tcgdex",
      "TCGdex returned an invalid card",
    );

  const externalId = textValue(card.id, MAX_ID_LENGTH);
  const name = textValue(card.name, MAX_NAME_LENGTH);
  if (!externalId || !name) {
    throw new CatalogueProviderError(
      "tcgdex",
      "TCGdex card is missing id or name",
    );
  }

  const set = record(card.set);
  const series = record(set?.serie);
  const cardCount = record(set?.cardCount);
  const externalSetSeparator = externalId.lastIndexOf("-");
  const inferredSetId =
    externalSetSeparator > 0
      ? externalId.slice(0, externalSetSeparator)
      : "unknown-set";
  const setId = textValue(set?.id, MAX_ID_LENGTH) ?? inferredSetId;
  const number =
    textValue(card.localId, MAX_NUMBER_LENGTH) ??
    textValue(card.number, MAX_NUMBER_LENGTH);
  const image = textValue(card.image, MAX_URL_LENGTH);
  const pricing = record(card.pricing);
  const tcgplayer = record(pricing?.tcgplayer);
  const cardmarket = record(pricing?.cardmarket);
  const tcgplayerObservedAt = upstreamQuoteDate(tcgplayer?.updated);
  const cardmarketObservedAt = upstreamQuoteDate(cardmarket?.updated);
  const quotes = [
    ...tcgplayerQuotes({
      source: "tcgdex",
      externalId,
      pricing: record(tcgplayer?.prices) ?? tcgplayer,
      observedAt: tcgplayerObservedAt,
      currency: textValue(tcgplayer?.unit, 8) ?? "USD",
    }),
    ...cardmarketQuotes({
      source: "tcgdex",
      externalId,
      pricing: record(cardmarket?.prices) ?? cardmarket,
      observedAt: cardmarketObservedAt,
      currency: textValue(cardmarket?.unit, 8) ?? "EUR",
    }),
  ];

  return {
    id: makeCardId({ language, setId, number, name }),
    name,
    number,
    language,
    supertype: textValue(card.category, MAX_SHORT_LABEL_LENGTH),
    subtypes: records(card.stages, MAX_CARD_SUBTYPES)
      .map((item) => textValue(item.name, MAX_SHORT_LABEL_LENGTH))
      .filter((item): item is string => item !== null),
    rarity: textValue(card.rarity, MAX_SHORT_LABEL_LENGTH),
    set: {
      id: setId,
      name: textValue(set?.name, MAX_LABEL_LENGTH) ?? setId,
      series: textValue(series?.name, MAX_LABEL_LENGTH),
      printedTotal: numberValue(cardCount?.official),
      total: numberValue(cardCount?.total),
    },
    images: {
      small: tcgdexImage(image, "low"),
      large: tcgdexImage(image, "high"),
    },
    externalIds: { tcgdex: externalId },
    sources: ["tcgdex"],
    quotes,
    updatedAt: isoDate(card.updated, now),
  };
}

export function normalizePokemonTcgCard(
  raw: unknown,
  now = new Date(),
): PokemonCard {
  const card = record(raw);
  if (!card) {
    throw new CatalogueProviderError(
      "pokemon_tcg",
      "Pokémon TCG API returned an invalid card",
    );
  }

  const externalId = textValue(card.id, MAX_ID_LENGTH);
  const name = textValue(card.name, MAX_NAME_LENGTH);
  if (!externalId || !name) {
    throw new CatalogueProviderError(
      "pokemon_tcg",
      "Pokémon TCG API card is missing id or name",
    );
  }

  const set = record(card.set);
  const images = record(card.images);
  const tcgplayer = record(card.tcgplayer);
  const tcgplayerObservedAt = upstreamQuoteDate(tcgplayer?.updatedAt);
  const cardmarket = record(card.cardmarket);
  const cardmarketObservedAt = upstreamQuoteDate(cardmarket?.updatedAt);
  const number = textValue(card.number, MAX_NUMBER_LENGTH);
  const setId = textValue(set?.id, MAX_ID_LENGTH) ?? "unknown-set";
  const quotes = [
    ...tcgplayerQuotes({
      source: "pokemon_tcg",
      externalId,
      pricing: record(tcgplayer?.prices),
      observedAt: tcgplayerObservedAt,
    }),
    ...cardmarketQuotes({
      source: "pokemon_tcg",
      externalId,
      pricing: record(cardmarket?.prices),
      observedAt: cardmarketObservedAt,
    }),
  ];

  return {
    id: makeCardId({ language: "en", setId, number, name }),
    name,
    number,
    language: "en",
    supertype: textValue(card.supertype, MAX_SHORT_LABEL_LENGTH),
    subtypes: Array.isArray(card.subtypes)
      ? card.subtypes
          .slice(0, MAX_CARD_SUBTYPES)
          .map((value) => textValue(value, MAX_SHORT_LABEL_LENGTH))
          .filter((item): item is string => item !== null)
      : [],
    rarity: textValue(card.rarity, MAX_SHORT_LABEL_LENGTH),
    set: {
      id: setId,
      name: textValue(set?.name, MAX_LABEL_LENGTH) ?? setId,
      series: textValue(set?.series, MAX_LABEL_LENGTH),
      printedTotal: numberValue(set?.printedTotal),
      total: numberValue(set?.total),
    },
    images: {
      small: textValue(images?.small, MAX_URL_LENGTH),
      large: textValue(images?.large, MAX_URL_LENGTH),
    },
    externalIds: { pokemon_tcg: externalId },
    sources: ["pokemon_tcg"],
    quotes,
    updatedAt: isoDate(cardmarket?.updatedAt ?? tcgplayer?.updatedAt, now),
  };
}

abstract class HttpCatalogueAdapter {
  abstract readonly source: CatalogueSource;
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly maxResponseBytes: number;
  protected readonly fetchImpl: typeof fetch;
  protected readonly clock: () => Date;

  constructor(options: AdapterOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new Error(
        `Catalogue response byte limit must be an integer between 1 and ${MAX_RESPONSE_BYTES}`,
      );
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  protected json(url: URL, headers?: RequestHeaders): Promise<unknown> {
    return fetchJson({
      source: this.source,
      fetch: this.fetchImpl,
      url,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      headers,
    });
  }
}

export class TcgdexAdapter
  extends HttpCatalogueAdapter
  implements CatalogueAdapter
{
  readonly source = "tcgdex" as const;

  async search(
    query: string,
    language: CardLanguage,
    limit: number,
  ): Promise<PokemonCard[]> {
    const parsed = parseCardSearchQuery(query);
    const request = async (filters: CardSearchFilters): Promise<unknown[]> => {
      const url = endpoint(this.baseUrl, `${language}/cards`);
      if (filters.includeName && parsed.name)
        url.searchParams.set("name", parsed.name);
      if (filters.number) url.searchParams.set("localId", filters.number);
      if (filters.setTotal && /^\d+$/.test(filters.setTotal)) {
        url.searchParams.set("set.cardCount.official", filters.setTotal);
      }
      url.searchParams.set("pagination:itemsPerPage", String(limit));
      const payload = await this.json(url);
      return Array.isArray(payload)
        ? payload.slice(0, Math.min(limit, MAX_PROVIDER_CARDS))
        : records(
            record(payload)?.data ?? record(payload)?.cards,
            Math.min(limit, MAX_PROVIDER_CARDS),
          );
    };
    let rawCards: unknown[] = [];
    for (const filters of cardSearchStrategies(parsed)) {
      rawCards = await request(filters);
      if (rawCards.length > 0) break;
    }
    return rawCards
      .slice(0, limit)
      .map((card) => normalizeTcgdexCard(card, language, this.clock()));
  }

  async getCard(
    externalId: string,
    language: CardLanguage,
  ): Promise<PokemonCard | null> {
    const url = endpoint(
      this.baseUrl,
      `${language}/cards/${encodeURIComponent(externalId)}`,
    );
    try {
      return normalizeTcgdexCard(await this.json(url), language, this.clock());
    } catch (error) {
      if (error instanceof CatalogueProviderError && error.status === 404)
        return null;
      throw error;
    }
  }
}

export class PokemonTcgAdapter
  extends HttpCatalogueAdapter
  implements CatalogueAdapter
{
  readonly source = "pokemon_tcg" as const;
  private readonly apiKey: string | null;

  constructor(options: PokemonTcgAdapterOptions) {
    super(options);
    this.apiKey = options.apiKey ?? null;
  }

  private headers(): RequestHeaders | undefined {
    return this.apiKey ? { "X-Api-Key": this.apiKey } : undefined;
  }

  async search(
    query: string,
    language: CardLanguage,
    limit: number,
  ): Promise<PokemonCard[]> {
    // The secondary catalogue is English-only, but keeping the requested language
    // in the adapter contract makes this limitation explicit to the caller.
    void language;
    const parsed = parseCardSearchQuery(query);
    const request = async (
      filters: CardSearchFilters,
    ): Promise<JsonRecord[]> => {
      const url = endpoint(this.baseUrl, "cards");
      const escapedName = filters.includeName
        ? parsed.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
        : "";
      const escapedNumber = filters.number
        ?.replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      const terms: string[] = [];
      if (escapedName) terms.push(`name:"${escapedName}"`);
      if (escapedNumber) terms.push(`number:"${escapedNumber}"`);
      if (filters.setTotal && /^\d+$/.test(filters.setTotal)) {
        terms.push(`set.printedTotal:${filters.setTotal}`);
      }
      url.searchParams.set("q", terms.join(" "));
      url.searchParams.set("pageSize", String(limit));
      const payload = record(await this.json(url, this.headers()));
      return records(payload?.data, Math.min(limit, MAX_PROVIDER_CARDS));
    };
    let cards: JsonRecord[] = [];
    for (const filters of cardSearchStrategies(parsed)) {
      cards = await request(filters);
      if (cards.length > 0) break;
    }
    return cards
      .slice(0, limit)
      .map((card) => normalizePokemonTcgCard(card, this.clock()));
  }

  async getCard(
    externalId: string,
    language: CardLanguage,
  ): Promise<PokemonCard | null> {
    void language;
    const url = endpoint(
      this.baseUrl,
      `cards/${encodeURIComponent(externalId)}`,
    );
    try {
      const payload = record(await this.json(url, this.headers()));
      return normalizePokemonTcgCard(payload?.data, this.clock());
    } catch (error) {
      if (error instanceof CatalogueProviderError && error.status === 404)
        return null;
      throw error;
    }
  }
}
