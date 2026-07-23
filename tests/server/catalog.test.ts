import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogueProviderError,
  normalizePokemonTcgCard,
  PokemonTcgAdapter,
  TcgdexAdapter,
} from "../../server/catalog/adapters.js";
import { CatalogueService } from "../../server/catalog/service.js";
import { SqliteStore } from "../../server/store.js";
import { FIXED_NOW, testAdapter, testCard } from "./fixtures.js";

describe("catalogue adapters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should normalize sourced low, median and high quotes from Pokémon TCG API", () => {
    const card = normalizePokemonTcgCard(
      {
        id: "base1-58",
        name: "Pikachu",
        number: "58",
        supertype: "Pokémon",
        subtypes: ["Basic"],
        rarity: "Common",
        set: {
          id: "base1",
          name: "Base Set",
          series: "Base",
          printedTotal: 102,
          total: 102,
        },
        images: {
          small: "https://images.example/small.png",
          large: "https://images.example/large.png",
        },
        tcgplayer: {
          updatedAt: "2026/07/21",
          prices: {
            normal: { low: 1.2, mid: 2.3, high: 4.5, market: 2.1 },
            reverseHolofoil: { low: 7, mid: 8, high: 10, market: 8.5 },
          },
        },
        cardmarket: {
          updatedAt: "2026/07/20",
          prices: { lowPrice: 1.1, trendPrice: 2.2, reverseHoloSell: 6.4 },
        },
      },
      FIXED_NOW,
    );

    expect(card.id).toBe("pokemon-card:en:base1:58:pikachu");
    expect(card.externalIds).toEqual({ pokemon_tcg: "base1-58" });
    expect(card.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "pokemon_tcg",
          market: "tcgplayer",
          finish: "normal",
          currency: "USD",
          low: 1.2,
          median: 2.1,
          high: 4.5,
        }),
        expect.objectContaining({
          market: "tcgplayer",
          finish: "reverse_holo",
          low: 7,
          median: 8.5,
          high: 10,
        }),
        expect.objectContaining({
          market: "cardmarket",
          finish: "normal",
          currency: "EUR",
          low: 1.1,
          median: 2.2,
        }),
      ]),
    );
    expect(
      card.quotes.every((quote) => quote.observedAt && quote.staleAfter),
    ).toBe(true);
    expect(
      card.quotes.find((quote) => quote.market === "tcgplayer")?.observedAt,
    ).toBe("2026-07-21T00:00:00.000Z");
  });

  it("should omit market quotes when the provider timestamp is missing or invalid", () => {
    const withoutTrustworthyTime = normalizePokemonTcgCard(
      {
        id: "base1-58",
        name: "Pikachu",
        number: "58",
        set: { id: "base1", name: "Base Set" },
        tcgplayer: {
          prices: { normal: { low: 1.2, market: 2.1 } },
        },
        cardmarket: {
          updatedAt: "not-a-date",
          prices: { lowPrice: 1.1, trendPrice: 2.2 },
        },
      },
      FIXED_NOW,
    );

    expect(withoutTrustworthyTime.quotes).toEqual([]);
    expect(withoutTrustworthyTime.updatedAt).toBe(FIXED_NOW.toISOString());
  });

  it("should send the optional API key only to Pokémon TCG API", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = new PokemonTcgAdapter({
      baseUrl: "https://pokemon.example/v2",
      apiKey: "test-key",
      fetch: fetchMock,
    });

    await adapter.search("Pikachu", "en", 10);

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/cards?");
    expect(String(url)).toContain("pageSize=10");
    expect(request?.headers).toMatchObject({ "X-Api-Key": "test-key" });
  });

  it("should retry TCGdex without an erroneous set total and keep summary printings distinct", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "base1-4", localId: "4", name: "Pikachu" },
            { id: "base2-4", localId: "4", name: "Pikachu" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const adapter = new TcgdexAdapter({
      baseUrl: "https://tcgdex.example/v2",
      fetch: fetchMock,
      clock: () => FIXED_NOW,
    });

    const cards = await adapter.search("Pikachu 025/165", "en", 20);

    const preciseUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const fallbackUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(preciseUrl.searchParams.get("name")).toBe("Pikachu");
    expect(preciseUrl.searchParams.get("localId")).toBe("25");
    expect(preciseUrl.searchParams.get("set.cardCount.official")).toBe("165");
    expect(fallbackUrl.searchParams.get("name")).toBe("Pikachu");
    expect(fallbackUrl.searchParams.get("localId")).toBe("25");
    expect(fallbackUrl.searchParams.has("set.cardCount.official")).toBe(false);
    expect(cards.map((card) => card.set.id)).toEqual(["base1", "base2"]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  it("should search TCGdex by collector number and set total when OCR has no usable name", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify([
            { id: "base1-58", localId: "58", name: "Pikachu" },
            { id: "hgss4-58", localId: "58", name: "Bronzor" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new TcgdexAdapter({
      baseUrl: "https://tcgdex.example/v2",
      fetch: fetchMock,
      clock: () => FIXED_NOW,
    });

    const cards = await adapter.search("58/102", "en", 12);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.searchParams.has("name")).toBe(false);
    expect(requestUrl.searchParams.get("localId")).toBe("58");
    expect(requestUrl.searchParams.get("set.cardCount.official")).toBe("102");
    expect(cards.map((card) => card.name)).toEqual(["Pikachu", "Bronzor"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should combine parsed promo name and number in a Pokémon TCG API query", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "swshp-SWSH020",
                name: "Pikachu",
                number: "SWSH020",
                set: { id: "swshp", name: "SWSH Black Star Promos" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new PokemonTcgAdapter({
      baseUrl: "https://pokemon.example/v2",
      fetch: fetchMock,
      clock: () => FIXED_NOW,
    });

    const cards = await adapter.search("Pikachu SWSH020", "en", 20);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.searchParams.get("q")).toBe(
      'name:"Pikachu" number:"SWSH020"',
    );
    expect(cards[0]).toMatchObject({ name: "Pikachu", number: "SWSH020" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should reject an upstream response before parsing when its byte budget is exceeded", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: "x".repeat(256) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const adapter = new PokemonTcgAdapter({
      baseUrl: "https://pokemon.example/v2",
      maxResponseBytes: 64,
      fetch: fetchMock,
    });

    await expect(adapter.search("Pikachu", "en", 10)).rejects.toMatchObject({
      name: "CatalogueProviderError",
      source: "pokemon_tcg",
      message: "pokemon_tcg response exceeded the 64-byte limit",
    });
  });

  it("should bound repeated and oversized optional card fields", () => {
    const card = normalizePokemonTcgCard({
      id: "base1-58",
      name: "Pikachu",
      number: "58",
      supertype: "x".repeat(101),
      subtypes: Array.from({ length: 40 }, (_value, index) => `Type ${index}`),
      rarity: "Common",
      set: { id: "base1", name: "Base Set" },
      images: { small: `https://images.example/${"x".repeat(2_100)}` },
    });

    expect(card.supertype).toBeNull();
    expect(card.subtypes).toHaveLength(16);
    expect(card.images.small).toBeNull();
  });

  it("should abort a catalogue request when its provider timeout is reached", async () => {
    vi.useFakeTimers();
    const neverCompletes: typeof fetch = vi.fn(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const adapter = new TcgdexAdapter({
      baseUrl: "https://tcgdex.example/v2",
      timeoutMs: 50,
      fetch: neverCompletes,
    });

    const search = adapter.search("Pikachu", "en", 10);
    const rejection = expect(search).rejects.toMatchObject({
      name: "CatalogueProviderError",
      source: "tcgdex",
      message: "tcgdex request timed out",
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});

describe("catalogue service cache and fallback", () => {
  it("should strip unauthorised quotes and images from search, detail, and cache responses", async () => {
    const store = new SqliteStore(":memory:");
    const quotedCard = testCard({
      quotes: [
        {
          source: "tcgdex",
          sku: "base1-58:tcgplayer:normal",
          market: "tcgplayer",
          currency: "USD",
          condition: "unknown",
          finish: "normal",
          low: 1,
          median: 2,
          high: 3,
          volume: null,
          observedAt: FIXED_NOW.toISOString(),
          staleAfter: new Date(FIXED_NOW.getTime() + 86_400_000).toISOString(),
        },
      ],
    });
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", {
        search: vi.fn(async () => [quotedCard]),
        getCard: vi.fn(async () => quotedCard),
      }),
      secondary: testAdapter("pokemon_tcg"),
      enabledSources: ["tcgdex", "pokemon_tcg"],
      cardImagesEnabled: false,
      marketQuotesEnabled: false,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      const search = await service.search("Pikachu", "en", 20);
      const cachedSearch = await service.search("Pikachu", "en", 20);
      const detail = await service.getCard(quotedCard.id);
      const cachedDetail = await service.getCard(quotedCard.id);

      expect(search.cards[0]?.quotes).toEqual([]);
      expect(search.cards[0]?.images).toEqual({ small: null, large: null });
      expect(cachedSearch.cards[0]?.quotes).toEqual([]);
      expect(cachedSearch.cards[0]?.images).toEqual({
        small: null,
        large: null,
      });
      expect(detail.card.quotes).toEqual([]);
      expect(detail.card.images).toEqual({ small: null, large: null });
      expect(cachedDetail.card.images).toEqual({ small: null, large: null });
    } finally {
      store.close();
    }
  });

  it("should neither call providers nor serve existing cache when all sources are disabled", async () => {
    const store = new SqliteStore(":memory:");
    const card = testCard();
    const enabled = new CatalogueService({
      primary: testAdapter("tcgdex", {
        search: vi.fn(async () => [card]),
      }),
      secondary: testAdapter("pokemon_tcg"),
      enabledSources: ["tcgdex"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      clock: () => FIXED_NOW,
    });
    const primarySearch = vi.fn(async () => [card]);
    const secondarySearch = vi.fn(async () => [card]);
    const disabled = new CatalogueService({
      primary: testAdapter("tcgdex", { search: primarySearch }),
      secondary: testAdapter("pokemon_tcg", { search: secondarySearch }),
      enabledSources: [],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      await enabled.search("Pikachu", "en", 20);
      await expect(disabled.search("Pikachu", "en", 20)).rejects.toThrow(
        "Catalogue access is disabled until source rights are approved",
      );
      expect(primarySearch).not.toHaveBeenCalled();
      expect(secondarySearch).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("should skip a disabled primary source and use only an enabled secondary source", async () => {
    const store = new SqliteStore(":memory:");
    const primarySearch = vi.fn(async () => [testCard()]);
    const secondaryCard = testCard({
      externalIds: { pokemon_tcg: "base1-58" },
      sources: ["pokemon_tcg"],
    });
    const secondarySearch = vi.fn(async () => [secondaryCard]);
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", { search: primarySearch }),
      secondary: testAdapter("pokemon_tcg", { search: secondarySearch }),
      enabledSources: ["pokemon_tcg"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      const result = await service.search("Pikachu", "en", 20);
      expect(result.metadata.source).toBe("pokemon_tcg");
      expect(result.cards).toEqual([secondaryCard]);
      expect(primarySearch).not.toHaveBeenCalled();
      expect(secondarySearch).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("should use TCGdex first and serve a fresh cache hit without another request", async () => {
    const store = new SqliteStore(":memory:");
    const primarySearch = vi.fn(async () => [testCard()]);
    const secondarySearch = vi.fn(async () => []);
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", { search: primarySearch }),
      secondary: testAdapter("pokemon_tcg", { search: secondarySearch }),
      enabledSources: ["tcgdex", "pokemon_tcg"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      const first = await service.search("Pikachu", "en", 20);
      const second = await service.search("Pikachu", "en", 20);

      expect(first.metadata).toMatchObject({
        source: "tcgdex",
        cache: "miss",
        stale: false,
      });
      expect(second.metadata).toMatchObject({
        source: "tcgdex",
        cache: "hit",
        stale: false,
      });
      expect(primarySearch).toHaveBeenCalledTimes(1);
      expect(secondarySearch).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("should never persist a manual or OCR search phrase in a cache key", async () => {
    const store = new SqliteStore(":memory:");
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", { search: vi.fn(async () => []) }),
      secondary: testAdapter("pokemon_tcg"),
      enabledSources: ["tcgdex"],
      cardImagesEnabled: false,
      marketQuotesEnabled: false,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      await service.search("Private binder note 58/102", "en", 12);
      const keys = store.database
        .prepare("SELECT cache_key FROM catalogue_cache")
        .all() as Array<{ cache_key: string }>;

      expect(keys).toHaveLength(1);
      expect(keys[0].cache_key).toContain(":sha256:");
      expect(keys[0].cache_key).not.toContain("private");
      expect(keys[0].cache_key).not.toContain("58/102");
    } finally {
      store.close();
    }
  });

  it("should fall back to Pokémon TCG API when TCGdex fails", async () => {
    const store = new SqliteStore(":memory:");
    const card = testCard({
      externalIds: { pokemon_tcg: "base1-58" },
      sources: ["pokemon_tcg"],
    });
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", {
        search: vi.fn(async () => {
          throw new CatalogueProviderError("tcgdex", "provider unavailable");
        }),
      }),
      secondary: testAdapter("pokemon_tcg", {
        search: vi.fn(async () => [card]),
      }),
      enabledSources: ["tcgdex", "pokemon_tcg"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      clock: () => FIXED_NOW,
    });

    try {
      const result = await service.search("Pikachu", "en", 20);

      expect(result.cards).toEqual([card]);
      expect(result.metadata).toMatchObject({
        source: "pokemon_tcg",
        cache: "miss",
      });
    } finally {
      store.close();
    }
  });

  it("should return stale cached data when both providers fail during refresh", async () => {
    const store = new SqliteStore(":memory:");
    let now = new Date(FIXED_NOW);
    const primarySearch = vi
      .fn()
      .mockResolvedValueOnce([testCard()])
      .mockRejectedValueOnce(new CatalogueProviderError("tcgdex", "offline"));
    const secondarySearch = vi.fn(async () => {
      throw new CatalogueProviderError("pokemon_tcg", "offline");
    });
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", { search: primarySearch }),
      secondary: testAdapter("pokemon_tcg", { search: secondarySearch }),
      enabledSources: ["tcgdex", "pokemon_tcg"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      cacheFreshMs: 1_000,
      cacheMaxStaleMs: 10_000,
      clock: () => now,
    });

    try {
      await service.search("Pikachu", "en", 20);
      now = new Date(FIXED_NOW.getTime() + 2_000);
      const result = await service.search("Pikachu", "en", 20);

      expect(result.cards).toHaveLength(1);
      expect(result.metadata).toMatchObject({
        source: "tcgdex",
        cache: "stale",
        stale: true,
      });
      expect(result.metadata.warning).toContain("cached data");
    } finally {
      store.close();
    }
  });

  it("should open a provider circuit after repeated failures", async () => {
    const store = new SqliteStore(":memory:");
    const primarySearch = vi.fn(async () => {
      throw new CatalogueProviderError("tcgdex", "offline");
    });
    const secondarySearch = vi.fn(async () => [testCard()]);
    const service = new CatalogueService({
      primary: testAdapter("tcgdex", { search: primarySearch }),
      secondary: testAdapter("pokemon_tcg", { search: secondarySearch }),
      enabledSources: ["tcgdex", "pokemon_tcg"],
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
      cache: store,
      providerFailureThreshold: 2,
      providerCooldownMs: 60_000,
      clock: () => FIXED_NOW,
    });

    try {
      await service.search("Pikachu one", "en", 20);
      await service.search("Pikachu two", "en", 20);
      await service.search("Pikachu three", "en", 20);

      expect(primarySearch).toHaveBeenCalledTimes(2);
      expect(secondarySearch).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
    }
  });
});
