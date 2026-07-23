import { createHash } from "node:crypto";

import type {
  CardLanguage,
  CatalogueCardResult,
  CatalogueMetadata,
  CatalogueSearchResult,
  CatalogueSource,
  PokemonCard,
} from "../../shared/types.js";
import type { CacheEntry, SqliteStore } from "../store.js";
import { CatalogueProviderError, type CatalogueAdapter } from "./adapters.js";

interface CatalogueServiceOptions {
  primary: CatalogueAdapter;
  secondary: CatalogueAdapter;
  enabledSources: readonly CatalogueSource[];
  cardImagesEnabled: boolean;
  marketQuotesEnabled: boolean;
  cache: SqliteStore;
  cacheFreshMs?: number;
  cacheMaxStaleMs?: number;
  providerFailureThreshold?: number;
  providerCooldownMs?: number;
  clock?: () => Date;
}

interface ProviderCircuitState {
  failures: number;
  openedUntil: number;
}

export class CatalogueUnavailableError extends Error {
  constructor(message = "Catalogue providers are temporarily unavailable") {
    super(message);
    this.name = "CatalogueUnavailableError";
  }
}

export class CatalogueCardNotFoundError extends Error {
  constructor(readonly cardId: string) {
    super("Card was not found in the local catalogue index");
    this.name = "CatalogueCardNotFoundError";
  }
}

function cacheDate(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("Catalogue request was cancelled", "AbortError")
  );
}

function waitForCaller<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function searchKey(
  query: string,
  language: CardLanguage,
  limit: number,
  policy: string,
): string {
  const digest = createHash("sha256")
    .update(query.trim().toLocaleLowerCase("en-US"))
    .digest("hex");
  return `catalogue:${policy}:search:${language}:${limit}:sha256:${digest}`;
}

function cardKey(cardId: string, policy: string): string {
  return `catalogue:${policy}:card:${cardId}`;
}

function metadata(input: {
  source: CatalogueSource;
  cache: CatalogueMetadata["cache"];
  fetchedAt: string;
  staleAfter: string;
  warning?: string;
}): CatalogueMetadata {
  return {
    source: input.source,
    cache: input.cache,
    stale: input.cache === "stale",
    fetchedAt: input.fetchedAt,
    staleAfter: input.staleAfter,
    ...(input.warning ? { warning: input.warning } : {}),
  };
}

function samePrinting(candidate: PokemonCard, reference: PokemonCard): boolean {
  return (
    candidate.name.toLocaleLowerCase("en-US") ===
      reference.name.toLocaleLowerCase("en-US") &&
    candidate.number === reference.number &&
    candidate.set.id.toLocaleLowerCase("en-US") ===
      reference.set.id.toLocaleLowerCase("en-US")
  );
}

function mergeCards(
  reference: PokemonCard,
  refreshed: PokemonCard,
): PokemonCard {
  return {
    ...refreshed,
    id: reference.id,
    language: reference.language,
    externalIds: { ...reference.externalIds, ...refreshed.externalIds },
    sources: [...new Set([...reference.sources, ...refreshed.sources])],
  };
}

export class CatalogueService {
  private readonly primary: CatalogueAdapter;
  private readonly secondary: CatalogueAdapter;
  private readonly cache: SqliteStore;
  private readonly cacheFreshMs: number;
  private readonly cacheMaxStaleMs: number;
  private readonly providerFailureThreshold: number;
  private readonly providerCooldownMs: number;
  private readonly enabledSources: ReadonlySet<CatalogueSource>;
  private readonly cardImagesEnabled: boolean;
  private readonly marketQuotesEnabled: boolean;
  private readonly cachePolicy: string;
  private readonly clock: () => Date;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly circuits = new Map<CatalogueSource, ProviderCircuitState>();

  constructor(options: CatalogueServiceOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.cache = options.cache;
    this.cacheFreshMs = options.cacheFreshMs ?? 24 * 60 * 60 * 1_000;
    this.cacheMaxStaleMs = options.cacheMaxStaleMs ?? 30 * 24 * 60 * 60 * 1_000;
    this.providerFailureThreshold = options.providerFailureThreshold ?? 3;
    this.providerCooldownMs = options.providerCooldownMs ?? 60_000;
    this.enabledSources = new Set(options.enabledSources);
    this.cardImagesEnabled = options.cardImagesEnabled === true;
    this.marketQuotesEnabled = options.marketQuotesEnabled === true;
    this.cachePolicy = [
      [...this.enabledSources].sort().join(",") || "none",
      this.cardImagesEnabled ? "images" : "no-images",
      this.marketQuotesEnabled ? "quotes" : "no-quotes",
    ].join(":");
    this.clock = options.clock ?? (() => new Date());
  }

  private visibleCard(card: PokemonCard): PokemonCard {
    const sources = card.sources.filter((source) =>
      this.enabledSources.has(source),
    );
    const externalIds = Object.fromEntries(
      Object.entries(card.externalIds).filter(([source]) =>
        this.enabledSources.has(source as CatalogueSource),
      ),
    );
    return {
      ...card,
      images: this.cardImagesEnabled
        ? card.images
        : { small: null, large: null },
      externalIds,
      sources,
      quotes: this.marketQuotesEnabled ? card.quotes : [],
    };
  }

  private visibleCards(cards: PokemonCard[]): PokemonCard[] {
    return cards.map((card) => this.visibleCard(card));
  }

  private enabledProviders(): CatalogueAdapter[] {
    return [this.primary, this.secondary].filter((provider) =>
      this.enabledSources.has(provider.source),
    );
  }

  private ensureCatalogueEnabled(): void {
    if (this.enabledProviders().length === 0) {
      throw new CatalogueUnavailableError(
        "Catalogue access is disabled until source rights are approved",
      );
    }
  }

  private async callProvider<T>(
    provider: CatalogueAdapter,
    operation: () => Promise<T>,
  ): Promise<T> {
    const now = this.clock().getTime();
    const state = this.circuits.get(provider.source) ?? {
      failures: 0,
      openedUntil: 0,
    };
    if (state.openedUntil > now) {
      throw new CatalogueProviderError(
        provider.source,
        `${provider.source} provider circuit is temporarily open`,
        429,
      );
    }
    if (state.openedUntil > 0) {
      state.failures = 0;
      state.openedUntil = 0;
    }

    try {
      const result = await operation();
      state.failures = 0;
      state.openedUntil = 0;
      this.circuits.set(provider.source, state);
      return result;
    } catch (error) {
      state.failures += 1;
      if (
        (error instanceof CatalogueProviderError && error.status === 429) ||
        state.failures >= this.providerFailureThreshold
      ) {
        state.openedUntil = now + this.providerCooldownMs;
      }
      this.circuits.set(provider.source, state);
      throw error;
    }
  }

  async search(
    query: string,
    language: CardLanguage,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<CatalogueSearchResult> {
    if (signal?.aborted) throw abortReason(signal);
    this.ensureCatalogueEnabled();
    const now = this.clock();
    const key = searchKey(query, language, limit, this.cachePolicy);
    const cachedEntry = this.cache.getCache<PokemonCard[]>(key, now);
    const cached =
      cachedEntry && this.enabledSources.has(cachedEntry.source)
        ? cachedEntry
        : null;
    if (cached?.status === "fresh") {
      return {
        cards: this.visibleCards(cached.value),
        query,
        metadata: metadata({
          source: cached.source,
          cache: "hit",
          fetchedAt: cached.fetchedAt,
          staleAfter: cached.staleAfter,
        }),
      };
    }

    const pending = this.inFlight.get(key) as
      Promise<CatalogueSearchResult> | undefined;
    if (pending) return waitForCaller(pending, signal);

    const request = this.fetchSearch(
      query,
      language,
      limit,
      key,
      cached,
      now,
    ).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return waitForCaller(request, signal);
  }

  private async fetchSearch(
    query: string,
    language: CardLanguage,
    limit: number,
    key: string,
    staleCache: CacheEntry<PokemonCard[]> | null,
    now: Date,
  ): Promise<CatalogueSearchResult> {
    let result: { cards: PokemonCard[]; source: CatalogueSource } | null = null;
    const failures: unknown[] = [];

    for (const provider of this.enabledProviders()) {
      try {
        const cards = await this.callProvider(provider, () =>
          provider.search(query, language, limit),
        );
        if (!result || cards.length > 0)
          result = { cards, source: provider.source };
        if (cards.length > 0) break;
      } catch (error) {
        failures.push(error);
      }
    }

    if (!result) {
      if (staleCache) {
        return {
          cards: this.visibleCards(staleCache.value),
          query,
          metadata: metadata({
            source: staleCache.source,
            cache: "stale",
            fetchedAt: staleCache.fetchedAt,
            staleAfter: staleCache.staleAfter,
            warning: "Catalogue providers unavailable; showing cached data.",
          }),
        };
      }
      throw new CatalogueUnavailableError(
        failures.length > 0
          ? "All enabled catalogue providers are temporarily unavailable"
          : "Catalogue search could not be completed",
      );
    }

    const fetchedAt = now.toISOString();
    const staleAfter = cacheDate(now, this.cacheFreshMs);
    const expiresAt = cacheDate(now, this.cacheMaxStaleMs);
    const visibleCards = this.visibleCards(result.cards);
    this.cache.putCache({
      key,
      value: visibleCards,
      source: result.source,
      fetchedAt,
      staleAfter,
      expiresAt,
    });

    for (const card of visibleCards)
      this.rememberSearchCard(card, result.source, now);

    return {
      cards: visibleCards,
      query,
      metadata: metadata({
        source: result.source,
        cache: "miss",
        fetchedAt,
        staleAfter,
      }),
    };
  }

  private rememberSearchCard(
    card: PokemonCard,
    source: CatalogueSource,
    now: Date,
  ): void {
    const key = cardKey(card.id, this.cachePolicy);
    const existing = this.cache.getCache<PokemonCard>(key, now);
    if (existing?.status === "fresh") return;

    this.cache.putCache({
      key,
      value: card,
      source,
      fetchedAt: now.toISOString(),
      // Search responses are often summaries, so force a detail refresh on first read.
      staleAfter: now.toISOString(),
      expiresAt: cacheDate(now, this.cacheMaxStaleMs),
    });
  }

  async getCard(cardId: string): Promise<CatalogueCardResult> {
    this.ensureCatalogueEnabled();
    const now = this.clock();
    const key = cardKey(cardId, this.cachePolicy);
    const cachedEntry = this.cache.getCache<PokemonCard>(key, now);
    const cached =
      cachedEntry && this.enabledSources.has(cachedEntry.source)
        ? cachedEntry
        : null;
    if (!cached) throw new CatalogueCardNotFoundError(cardId);
    if (cached.status === "fresh") {
      return {
        card: this.visibleCard(cached.value),
        metadata: metadata({
          source: cached.source,
          cache: "hit",
          fetchedAt: cached.fetchedAt,
          staleAfter: cached.staleAfter,
        }),
      };
    }

    const pending = this.inFlight.get(key) as
      Promise<CatalogueCardResult> | undefined;
    if (pending) return pending;

    const request = this.fetchCard(cached.value, key, cached, now).finally(
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchCard(
    reference: PokemonCard,
    key: string,
    staleCache: CacheEntry<PokemonCard>,
    now: Date,
  ): Promise<CatalogueCardResult> {
    const failures: unknown[] = [];
    let refreshed: PokemonCard | null = null;
    let source: CatalogueSource = staleCache.source;

    const primaryId = reference.externalIds[this.primary.source];
    if (primaryId && this.enabledSources.has(this.primary.source)) {
      try {
        refreshed = await this.callProvider(this.primary, () =>
          this.primary.getCard(primaryId, reference.language),
        );
        source = this.primary.source;
      } catch (error) {
        failures.push(error);
      }
    }

    const secondaryId = reference.externalIds[this.secondary.source];
    if (
      !refreshed &&
      secondaryId &&
      this.enabledSources.has(this.secondary.source)
    ) {
      try {
        refreshed = await this.callProvider(this.secondary, () =>
          this.secondary.getCard(secondaryId, reference.language),
        );
        source = this.secondary.source;
      } catch (error) {
        failures.push(error);
      }
    }

    if (
      !refreshed &&
      !secondaryId &&
      this.enabledSources.has(this.secondary.source)
    ) {
      try {
        const candidates = await this.callProvider(this.secondary, () =>
          this.secondary.search(reference.name, reference.language, 20),
        );
        refreshed =
          candidates.find((candidate) => samePrinting(candidate, reference)) ??
          null;
        if (refreshed) source = this.secondary.source;
      } catch (error) {
        failures.push(error);
      }
    }

    if (!refreshed) {
      return {
        card: this.visibleCard(reference),
        metadata: metadata({
          source: staleCache.source,
          cache: "stale",
          fetchedAt: staleCache.fetchedAt,
          staleAfter: staleCache.staleAfter,
          warning:
            failures.length > 0
              ? "Catalogue providers unavailable; showing cached card data."
              : "No fresher card data is currently available.",
        }),
      };
    }

    const card = this.visibleCard(mergeCards(reference, refreshed));
    const fetchedAt = now.toISOString();
    const staleAfter = cacheDate(now, this.cacheFreshMs);
    this.cache.putCache({
      key,
      value: card,
      source,
      fetchedAt,
      staleAfter,
      expiresAt: cacheDate(now, this.cacheMaxStaleMs),
    });

    return {
      card,
      metadata: metadata({ source, cache: "miss", fetchedAt, staleAfter }),
    };
  }
}
