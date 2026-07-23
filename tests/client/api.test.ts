import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  deleteCloudCollection,
  getCatalogCard,
  loadRuntimeConfig,
  recognizeCardImage,
  searchCatalog,
  selectSyncEventBatch,
  SyncBatchSizeError,
  SyncProtocolError,
  syncCollectionEvents,
} from "../../src/lib/api";
import type { CollectionEvent, ParsedCardText } from "../../src/lib/types";
import { saveValuationPreference } from "../../src/lib/value";

const parsed: ParsedCardText = {
  rawText: "Pikachu\n025/165",
  name: "Pikachu",
  number: "025",
  setTotal: "165",
  query: "Pikachu 025/165",
  confidence: 0.9,
  signals: ["card-name", "collector-number"],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("client API adapter", () => {
  it("should reuse only the last public runtime configuration on an offline reload", async () => {
    const publicConfig = {
      appName: "CardScope",
      recognition: {
        enabled: true,
        processing: "server",
        maxImageBytes: 2_097_152,
      },
      auth: {
        enabled: true,
        issuer: "https://auth.sent-tech.ca",
        clientId: "pokemon-cards",
        audience: "https://pokemon.sent-tech.ca/api",
      },
      sync: {
        enabled: true,
        retentionDays: 1_826,
        maxBatchSize: 37,
        maxOperationBytes: 32_768,
      },
      valuation: { marketQuotesEnabled: false },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(publicConfig))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const online = await loadRuntimeConfig();
    const offline = await loadRuntimeConfig();

    expect(online).toMatchObject({
      auth: {
        enabled: true,
        issuer: "https://auth.sent-tech.ca",
        audience: "https://pokemon.sent-tech.ca/api",
      },
      sync: {
        enabled: true,
        maxBatchSize: 37,
        maxOperationBytes: 32_768,
      },
    });
    expect(offline).toEqual(online);
    expect(localStorage.getItem("cardscope-runtime-config-v1")).not.toContain(
      "secret",
    );
  });

  it("should upload a cropped JPEG to the server recognition contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        evidence: {
          name: "Pikachu",
          number: "58",
          setTotal: "102",
          query: "Pikachu 58/102",
          confidence: 0.95,
          signals: ["card-name", "collector-number"],
        },
        cards: [
          {
            id: "pokemon-card:fr:base1:58:pikachu",
            name: "Pikachu",
            number: "58",
            language: "fr",
            set: { id: "base1", name: "Set de Base" },
            images: {},
          },
        ],
        visualMatches: [],
        engine: "tesseract",
        modelVersion: "test",
        durationMs: 10,
        photoRetained: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    });

    const result = await recognizeCardImage(image, "en");

    const requestUrl = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "https://cards.example.test",
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(requestUrl.pathname).toBe("/api/recognition/cards");
    expect(requestUrl.searchParams.get("language")).toBe("auto");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("content-type")).toBe(
      "image/jpeg",
    );
    expect(request?.body).toBe(image);
    expect(result).toMatchObject({
      evidence: { name: "Pikachu", number: "58" },
      cards: [{ name: "Pikachu", language: "fr" }],
      photoRetained: false,
    });
  });

  it("should call the exact catalogue search contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        cards: [
          {
            id: "fr:151:025:pikachu",
            name: "Pikachu",
            number: "025",
            language: "fr",
            set: { id: "151", name: "151" },
            images: {},
          },
        ],
        metadata: { source: "tcgdex" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Both printed languages are searched independently from the English UI.
    const cards = await searchCatalog(parsed, "auto", "en");

    const requestUrl = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "https://cards.example.test",
    );
    expect(requestUrl.pathname).toBe("/api/catalog/cards");
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      q: "Pikachu 025/165",
      language: "auto",
      limit: "24",
    });
    expect(cards[0]).toMatchObject({
      id: "fr:151:025:pikachu",
      name: "Pikachu",
      setName: "151",
      language: "fr",
    });
  });

  it("should hydrate detail and prefer the locale market without conflating finish or condition", async () => {
    const quoteBase = {
      source: "tcgdex",
      sku: "sku",
      low: 5,
      median: 7,
      high: 9,
      volume: 12,
      observedAt: "2026-07-21T12:00:00.000Z",
      staleAfter: "2026-07-28T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          card: {
            id: "card-1",
            name: "Pikachu",
            number: "025",
            set: { id: "151", name: "151" },
            images: {},
            quotes: [
              {
                ...quoteBase,
                market: "tcgplayer",
                currency: "USD",
                finish: "normal",
                condition: "near_mint",
              },
              {
                ...quoteBase,
                market: "cardmarket",
                currency: "EUR",
                finish: "normal",
                condition: "unknown",
              },
              {
                ...quoteBase,
                market: "cardmarket",
                currency: "EUR",
                finish: "reverse_holo",
                condition: "near_mint",
                median: 14,
              },
            ],
          },
        }),
      ),
    );

    saveValuationPreference({ market: "cardmarket", currency: "EUR" });
    const card = await getCatalogCard("card-1", "fr", "en");

    expect(card.quote).toMatchObject({
      market: "cardmarket",
      currency: "EUR",
      finish: "normal",
      conditionIncluded: false,
    });
    expect(card.language).toBe("fr");
    expect(card.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finish: "reverse", marketPrice: 14 }),
      ]),
    );
  });

  it("should post event operations with a cursor and mark downloaded events as synced locally", async () => {
    const localEvent: CollectionEvent = {
      id: "event-1",
      type: "holding.quantity-adjusted",
      holdingId: "holding-1",
      deviceId: "device-1",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { delta: 1 },
    };
    const remoteEvent = {
      ...localEvent,
      id: "event-remote",
      deviceId: "device-2",
      sequence: 501,
      receivedAt: "2026-07-22T12:00:01.000Z",
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        acceptedOperationIds: ["event-1"],
        cursor: "501",
        generation: "3",
        hasMore: true,
        retentionUntil: "2031-07-22T12:00:00.000Z",
        events: [remoteEvent],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncCollectionEvents(
      [localEvent],
      { accessToken: "access-token" },
      "500",
      "2",
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/sync");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      cursor: "500",
      generation: "2",
      operations: [localEvent],
    });
    expect(result).toMatchObject({
      acceptedIds: ["event-1"],
      cursor: "501",
      generation: "3",
      hasMore: true,
    });
    expect(result.remoteEvents[0].syncedAt).toEqual(expect.any(String));
    expect(result.remoteEvents[0].serverSequence).toBe(501);
    expect(result.remoteEvents[0]).not.toHaveProperty("sequence");
    expect(result.remoteEvents[0]).not.toHaveProperty("receivedAt");
  });

  it("should reject incomplete or fabricated sync acknowledgements", async () => {
    const localEvent: CollectionEvent = {
      id: "event-1",
      type: "holding.quantity-adjusted",
      holdingId: "holding-1",
      deviceId: "device-1",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { delta: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          acceptedOperationIds: [],
          cursor: "1",
          generation: "1",
          hasMore: false,
          retentionUntil: "2031-07-22T12:00:00.000Z",
          events: [],
        }),
      ),
    );

    await expect(
      syncCollectionEvents([localEvent], { accessToken: "access-token" }),
    ).rejects.toBeInstanceOf(SyncProtocolError);
  });

  it("should reject an empty or partially invalid successful sync body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          acceptedOperationIds: [],
          cursor: "1",
          generation: "1",
          hasMore: false,
          retentionUntil: "2031-07-22T12:00:00.000Z",
          events: [
            {
              id: "remote-1",
              type: "holding.quantity-adjusted",
              holdingId: "holding-1",
              deviceId: "device-2",
              occurredAt: "not-a-date",
              sequence: 1,
              receivedAt: "2026-07-22T12:00:01.000Z",
              payload: { delta: 1 },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncCollectionEvents([], { accessToken: "access-token" }),
    ).rejects.toBeInstanceOf(SyncProtocolError);
    await expect(
      syncCollectionEvents([], { accessToken: "access-token" }),
    ).rejects.toBeInstanceOf(SyncProtocolError);
  });

  it("should propagate caller cancellation to the bounded sync request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sync = syncCollectionEvents(
      [],
      { accessToken: "access-token" },
      null,
      null,
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();

    await expect(sync).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("should select a bounded batch by count and serialized byte budget", () => {
    const events: CollectionEvent[] = [
      {
        id: "small",
        type: "holding.removed",
        holdingId: "holding-1",
        deviceId: "device-1",
        occurredAt: "2026-07-22T12:00:00.000Z",
        payload: {},
      },
      {
        id: "large",
        type: "holding.removed",
        holdingId: "holding-2",
        deviceId: "device-1",
        occurredAt: "2026-07-22T12:00:01.000Z",
        payload: { reason: "x".repeat(2_000) },
      },
    ];

    expect(selectSyncEventBatch(events, 1)).toEqual([events[0]]);
    expect(selectSyncEventBatch(events, 100, 500)).toEqual([events[0]]);
    expect(() => selectSyncEventBatch([events[1]], 100, 500)).toThrow(
      SyncBatchSizeError,
    );
  });

  it("should expose the current generation when a stale device is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "sync_generation_mismatch",
              message: "Collection generation changed",
              currentGeneration: "4",
            },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      syncCollectionEvents([], { accessToken: "access-token" }, "0", "3"),
    ).rejects.toMatchObject({
      status: 409,
      code: "sync_generation_mismatch",
      currentGeneration: "4",
    });
  });

  it("should never expose a malformed generation from an error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "sync_generation_mismatch",
              currentGeneration: "9007199254740992",
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = await syncCollectionEvents(
      [],
      { accessToken: "access-token" },
      "0",
      "3",
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).currentGeneration).toBeUndefined();
  });

  it("should retain the new generation returned by account deletion", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ deleted: true, generation: "5" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteCloudCollection({ accessToken: "access-token" }),
    ).resolves.toEqual({ generation: "5" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("should reject an unsafe generation returned by account deletion", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ deleted: true, generation: "9007199254740992" }),
        ),
    );

    await expect(
      deleteCloudCollection({ accessToken: "access-token" }),
    ).rejects.toBeInstanceOf(SyncProtocolError);
  });
});
