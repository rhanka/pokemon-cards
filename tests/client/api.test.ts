import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCatalogCard,
  recognizeCardImage,
  searchCatalog,
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

    const result = await recognizeCardImage(image, "fr");

    const requestUrl = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "https://cards.example.test",
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(requestUrl.pathname).toBe("/api/recognition/cards");
    expect(requestUrl.searchParams.get("language")).toBe("fr");
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
            set: { id: "151", name: "151" },
            images: {},
          },
        ],
        metadata: { source: "tcgdex" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A French card can be scanned while the interface remains in English.
    const cards = await searchCatalog(parsed, "fr", "en");

    const requestUrl = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "https://cards.example.test",
    );
    expect(requestUrl.pathname).toBe("/api/catalog/cards");
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      q: "Pikachu 025/165",
      language: "fr",
      limit: "12",
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
        acceptedOperationIds: [],
        cursor: "501",
        hasMore: true,
        events: [remoteEvent],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncCollectionEvents(
      [localEvent],
      { accessToken: "access-token" },
      "500",
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/sync");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      cursor: "500",
      operations: [localEvent],
    });
    expect(result).toMatchObject({
      acceptedIds: [],
      cursor: "501",
      hasMore: true,
    });
    expect(result.remoteEvents[0].syncedAt).toEqual(expect.any(String));
    expect(result.remoteEvents[0]).not.toHaveProperty("sequence");
    expect(result.remoteEvents[0]).not.toHaveProperty("receivedAt");
  });
});
