import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../server/app.js";
import {
  AuthenticationError,
  DisabledAuthenticator,
  type Authenticator,
} from "../../server/auth.js";
import { CatalogueService } from "../../server/catalog/service.js";
import { SqliteStore } from "../../server/store.js";
import { isCollectionEvent } from "../../src/lib/db.js";
import {
  CatalogueProviderError,
  type CatalogueAdapter,
} from "../../server/catalog/adapters.js";
import {
  RecognitionBusyError,
  type RecognitionEngine,
} from "../../server/recognition.js";
import {
  FIXED_NOW,
  testAdapter,
  testCard,
  testConfig,
  testOperation,
} from "./fixtures.js";

const authenticated: Authenticator = {
  async authenticate() {
    return {
      subject: "user-123",
      email: "collector@example.com",
      claims: { sub: "user-123" },
    };
  },
};

function testDependencies(
  options: {
    authenticator?: Authenticator;
    staticRoot?: string | null;
    configure?: (config: ReturnType<typeof testConfig>) => void;
    recognizer?: RecognitionEngine;
    catalogueSearch?: CatalogueAdapter["search"];
  } = {},
) {
  const config = testConfig();
  config.staticRoot = options.staticRoot ?? null;
  options.configure?.(config);
  const store = new SqliteStore(":memory:");
  const card = testCard();
  const detailCard = testCard({
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
  const catalogueSearch = vi.fn(
    options.catalogueSearch ?? (async () => [card]),
  );
  const catalogue = new CatalogueService({
    primary: testAdapter("tcgdex", {
      search: catalogueSearch,
      getCard: vi.fn(async () => detailCard),
    }),
    secondary: testAdapter("pokemon_tcg"),
    enabledSources: [
      ...(config.catalogue.tcgdexCatalogEnabled ? (["tcgdex"] as const) : []),
      ...(config.catalogue.pokemonTcgCatalogEnabled
        ? (["pokemon_tcg"] as const)
        : []),
    ],
    cardImagesEnabled: config.catalogue.cardImagesEnabled,
    cache: store,
    cacheFreshMs: 60_000,
    marketQuotesEnabled: config.catalogue.marketQuotesEnabled,
    clock: () => FIXED_NOW,
  });
  const authenticator = options.authenticator ?? authenticated;
  const recognizer: RecognitionEngine = options.recognizer ?? {
    async recognize() {
      return {
        evidence: {
          name: "Pikachu",
          number: "58",
          setTotal: "102",
          query: "Pikachu 58/102",
          confidence: 0.95,
          signals: ["collector-number", "set-total", "card-name"],
        },
        visualMatches: [],
        engine: "tesseract",
        modelVersion: "test-engine",
        durationMs: 12,
        photoRetained: false,
      };
    },
    async close() {},
  };
  return {
    store,
    catalogueSearch,
    app: createApp({
      config,
      store,
      catalogue,
      authenticator,
      recognizer,
    }),
  };
}

async function bootstrapGeneration(
  app: ReturnType<typeof testDependencies>["app"],
): Promise<string> {
  const response = await app.request("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: null, operations: [] }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { generation: string };
  return body.generation;
}

describe("CardScope API", () => {
  it("should expose health and public configuration without server credentials", async () => {
    const { app, store } = testDependencies();
    try {
      const healthResponse = await app.request("/api/health");
      const configResponse = await app.request("/api/config");
      const health = await healthResponse.json();
      const publicConfigText = await configResponse.text();
      const publicConfig = JSON.parse(publicConfigText);

      expect(healthResponse.status).toBe(200);
      expect(health).toMatchObject({
        status: "ok",
        service: "cardscope-api",
        database: { ok: true },
      });
      expect(healthResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(healthResponse.headers.get("referrer-policy")).toBe("no-referrer");
      expect(healthResponse.headers.get("x-frame-options")).toBe("DENY");
      expect(healthResponse.headers.get("permissions-policy")).toBe(
        "camera=(self), microphone=(), geolocation=()",
      );
      expect(healthResponse.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
      expect(healthResponse.headers.get("content-security-policy")).toContain(
        "worker-src 'self' blob:",
      );
      expect(healthResponse.headers.get("content-security-policy")).toContain(
        "style-src-elem 'self' 'unsafe-inline'",
      );
      expect(healthResponse.headers.get("content-security-policy")).toContain(
        "connect-src 'self' https://auth.example https://assets.tcgdex.net https://images.pokemontcg.io",
      );
      expect(
        healthResponse.headers.get("strict-transport-security"),
      ).toBeNull();
      expect(configResponse.status).toBe(200);
      expect(publicConfig).toMatchObject({
        auth: {
          enabled: true,
          issuer: "https://auth.example",
          clientId: "pokemon-cards",
          audience: "pokemon-cards-api",
        },
        sync: { enabled: true, retentionDays: 1_826 },
        catalogue: { primary: "tcgdex", secondary: "pokemon_tcg" },
      });
      expect(publicConfigText).not.toContain("server-only-api-key");
      expect(publicConfigText).not.toContain("keys-with-private-location");
    } finally {
      store.close();
    }
  });

  it("should bound anonymous catalogue requests and include retry guidance", async () => {
    const { app, store } = testDependencies({
      configure(config) {
        config.catalogue.rateLimitPerMinute = 2;
      },
    });
    try {
      const first = await app.request(
        "/api/catalog/cards?q=Pikachu&language=en",
      );
      const second = await app.request(
        "/api/catalog/cards?q=Raichu&language=en",
      );
      const limited = await app.request(
        "/api/catalog/cards?q=Pichu&language=en",
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({
        error: { code: "catalogue_rate_limited" },
      });
    } finally {
      store.close();
    }
  });

  it("should accept a bounded JPEG for transient server recognition", async () => {
    const recognize = vi.fn(async () => ({
      evidence: {
        name: "Pikachu",
        number: "58",
        setTotal: "102",
        query: "Pikachu 58/102",
        confidence: 0.95,
        signals: ["collector-number", "set-total", "card-name"],
      },
      visualMatches: [],
      engine: "tesseract" as const,
      modelVersion: "test-engine",
      durationMs: 12,
      photoRetained: false as const,
    }));
    const { app, store } = testDependencies({
      recognizer: { recognize, async close() {} },
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    try {
      const response = await app.request("/api/recognition/cards?language=en", {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(recognize).toHaveBeenCalledOnce();
      expect(body).toMatchObject({
        evidence: { name: "Pikachu", number: "58" },
        cards: [{ name: "Pikachu", number: "58" }],
        engine: "tesseract",
        photoRetained: false,
      });
      expect(JSON.stringify(body)).not.toContain("rawText");
    } finally {
      store.close();
    }
  });

  it("should search both languages in parallel and interleave a bounded deduplicated result", async () => {
    let active = 0;
    let maximumActive = 0;
    const english = Array.from({ length: 13 }, (_, index) =>
      testCard({
        id: `pokemon-card:en:set:${index}:card-${index}`,
        name: `Card ${index}`,
        number: String(index),
      }),
    );
    const french = Array.from({ length: 13 }, (_, index) =>
      testCard({
        id: `pokemon-card:fr:set:${index}:carte-${index}`,
        name: `Carte ${index}`,
        number: String(index),
        language: "fr",
      }),
    );
    french[1] = french[0];
    const { app, store, catalogueSearch } = testDependencies({
      catalogueSearch: async (_query, language) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return language === "fr" ? french : english;
      },
    });
    try {
      const response = await app.request("/api/recognition/cards", {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(maximumActive).toBe(2);
      expect(catalogueSearch).toHaveBeenCalledTimes(2);
      expect(
        catalogueSearch.mock.calls.map((call) => [call[1], call[2]]),
      ).toEqual([
        ["en", 12],
        ["fr", 12],
      ]);
      expect(body.cards).toHaveLength(23);
      expect(body.cards.length).toBeLessThanOrEqual(24);
      expect(
        body.cards
          .slice(0, 3)
          .map((card: { language: string }) => card.language),
      ).toEqual(["en", "fr", "en"]);
      expect(
        body.cards.filter((card: { id: string }) => card.id === french[0].id),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("should fail closed when either automatic language search is unavailable", async () => {
    const { app, store, catalogueSearch } = testDependencies({
      catalogueSearch: async (_query, language) => {
        if (language === "fr") {
          throw new CatalogueProviderError("tcgdex", "French catalogue down");
        }
        return [testCard()];
      },
    });
    try {
      const response = await app.request(
        "/api/recognition/cards?language=auto",
        {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "catalogue_unavailable" },
      });
      expect(catalogueSearch).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("should propagate request cancellation to the recognition engine", async () => {
    let receivedSignal: AbortSignal | undefined;
    let startedRecognition!: () => void;
    const started = new Promise<void>((resolve) => {
      startedRecognition = resolve;
    });
    const recognize = vi.fn(
      async (
        _image: Uint8Array,
        options?: { signal?: AbortSignal },
      ): Promise<never> => {
        receivedSignal = options?.signal;
        startedRecognition();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const { app, store } = testDependencies({
      recognizer: { recognize, async close() {} },
    });
    const controller = new AbortController();
    try {
      const request = new Request("http://cards.test/api/recognition/cards", {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      });
      Object.defineProperty(request, "signal", {
        configurable: true,
        value: controller.signal,
      });
      const responsePromise = app.fetch(request);
      await started;
      controller.abort();
      const response = await responsePromise;

      expect(receivedSignal?.aborted).toBe(true);
      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({
        error: { code: "recognition_cancelled" },
      });
    } finally {
      store.close();
    }
  });

  it("should enforce the end-to-end recognition deadline", async () => {
    vi.useFakeTimers();
    let startedRecognition!: () => void;
    const started = new Promise<void>((resolve) => {
      startedRecognition = resolve;
    });
    const recognize = vi.fn(
      async (
        _image: Uint8Array,
        options?: { signal?: AbortSignal },
      ): Promise<never> => {
        startedRecognition();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const { app, store } = testDependencies({
      recognizer: { recognize, async close() {} },
    });
    try {
      const responsePromise = app.request(
        "/api/recognition/cards?language=auto",
        {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      );
      await started;
      await vi.advanceTimersByTimeAsync(35_000);
      const response = await responsePromise;

      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        error: { code: "recognition_timeout" },
      });
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("should keep the end-to-end deadline while catalogue lookup is pending", async () => {
    vi.useFakeTimers();
    const { app, store, catalogueSearch } = testDependencies({
      catalogueSearch: async () => new Promise<never>(() => undefined),
    });
    try {
      const responsePromise = app.request(
        "/api/recognition/cards?language=auto",
        {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      );
      await vi.waitFor(() => {
        expect(catalogueSearch).toHaveBeenCalledTimes(2);
      });
      await vi.advanceTimersByTimeAsync(35_000);
      const response = await responsePromise;

      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        error: { code: "recognition_timeout" },
      });
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("should fail closed for disabled, invalid, oversized, or busy recognition", async () => {
    const busy: RecognitionEngine = {
      async recognize() {
        throw new RecognitionBusyError();
      },
      async close() {},
    };
    const { app, store } = testDependencies({
      recognizer: busy,
      configure(config) {
        config.recognition.maxImageBytes = 8;
      },
    });
    try {
      const wrongMedia = await app.request(
        "/api/recognition/cards?language=en",
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array([1]),
        },
      );
      const oversized = await app.request(
        "/api/recognition/cards?language=en",
        {
          method: "POST",
          headers: {
            "content-type": "image/jpeg",
            "content-length": "9",
          },
          body: new Uint8Array(9),
        },
      );
      const busyResponse = await app.request(
        "/api/recognition/cards?language=fr",
        {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      );

      expect(wrongMedia.status).toBe(415);
      expect(oversized.status).toBe(413);
      expect(busyResponse.status).toBe(429);
      expect(busyResponse.headers.get("retry-after")).toBe("10");
      expect(await busyResponse.json()).toMatchObject({
        error: { code: "recognition_busy" },
      });
    } finally {
      store.close();
    }

    const disabled = testDependencies({
      configure(config) {
        config.recognition.enabled = false;
      },
    });
    try {
      const response = await disabled.app.request(
        "/api/recognition/cards?language=en",
        {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "recognition_disabled" },
      });
    } finally {
      disabled.store.close();
    }
  });

  it("should refund busy client quota while retaining the global upload bound", async () => {
    let attempts = 0;
    const recognize = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) throw new RecognitionBusyError();
      return {
        evidence: {
          name: "Pikachu",
          number: "58",
          setTotal: "102",
          query: "Pikachu 58/102",
          confidence: 0.95,
          signals: ["collector-number", "set-total", "card-name"],
        },
        visualMatches: [],
        engine: "tesseract" as const,
        modelVersion: "test-engine",
        durationMs: 12,
        photoRetained: false as const,
      };
    });
    const { app, store } = testDependencies({
      recognizer: { recognize, async close() {} },
      configure(config) {
        config.recognition.rateLimitPerMinute = 1;
        config.recognition.globalRateLimitPerMinute = 3;
        config.recognition.maxConcurrentUploads = 1;
      },
    });
    const request = (client = "198.51.100.10") =>
      app.request("/api/recognition/cards?language=en", {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          "x-forwarded-for": client,
        },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      });

    try {
      const firstBusy = await request();
      const secondBusy = await request();
      const accepted = await request();
      const globallyLimited = await request("198.51.100.20");

      expect((await firstBusy.json()).error.code).toBe("recognition_busy");
      expect((await secondBusy.json()).error.code).toBe("recognition_busy");
      expect(accepted.status).toBe(200);
      expect(globallyLimited.status).toBe(429);
      expect(await globallyLimited.json()).toMatchObject({
        error: { code: "recognition_rate_limited" },
      });
      expect(recognize).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
    }
  });

  it("should enable HSTS only for an HTTPS public origin", async () => {
    const { app, store } = testDependencies({
      configure(config) {
        config.publicOrigin = "https://cards.example.test";
      },
    });
    try {
      const response = await app.request("/api/health");
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    } finally {
      store.close();
    }
  });

  it("should search the catalogue and refresh a card detail through app.request", async () => {
    const { app, store } = testDependencies();
    try {
      const searchResponse = await app.request(
        "/api/catalog/cards?q=Pikachu&language=en&limit=10",
      );
      const search = await searchResponse.json();
      const cardId = search.cards[0].id as string;
      const detailResponse = await app.request(
        `/api/catalog/cards/${encodeURIComponent(cardId)}`,
      );
      const detail = await detailResponse.json();

      expect(searchResponse.status).toBe(200);
      expect(search).toMatchObject({
        query: "Pikachu",
        metadata: { source: "tcgdex", cache: "miss", stale: false },
      });
      expect(detailResponse.status).toBe(200);
      expect(detail.card).toMatchObject({ id: cardId, name: "Pikachu" });
      expect(detail.card.quotes[0]).toMatchObject({
        low: 1,
        median: 2,
        high: 3,
      });
    } finally {
      store.close();
    }
  });

  it("should validate and idempotently synchronize authenticated holding events", async () => {
    const { app, store } = testDependencies();
    const added = testOperation();
    const operations = [
      added,
      {
        id: "operation-2",
        deviceId: "device-1",
        type: "holding.quantity-adjusted",
        holdingId: added.holdingId,
        occurredAt: "2026-07-22T12:01:00.000Z",
        payload: { delta: 2 },
      },
      {
        id: "operation-3",
        deviceId: "device-1",
        type: "holding.updated",
        holdingId: added.holdingId,
        occurredAt: "2026-07-22T12:02:00.000Z",
        payload: { note: "Binder A" },
      },
      {
        id: "operation-4",
        deviceId: "device-1",
        type: "holding.removed",
        holdingId: added.holdingId,
        occurredAt: "2026-07-22T12:03:00.000Z",
        payload: { reason: "sold" },
      },
    ];
    try {
      expect(operations.every(isCollectionEvent)).toBe(true);
      const generation = await bootstrapGeneration(app);
      const firstResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: null, generation, operations }),
      });
      const first = await firstResponse.json();
      const duplicateResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor: first.cursor,
          generation: first.generation,
          operations,
        }),
      });
      const duplicate = await duplicateResponse.json();
      const pullResponse = await app.request(
        `/api/sync?cursor=${first.cursor}&generation=${first.generation}`,
      );
      const pull = await pullResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(first).toMatchObject({
        acceptedOperationIds: operations.map((operation) => operation.id),
        generation: "1",
        hasMore: false,
      });
      expect(first.events).toHaveLength(4);
      expect(first.events.map((event: { type: string }) => event.type)).toEqual(
        [
          "holding.added",
          "holding.quantity-adjusted",
          "holding.updated",
          "holding.removed",
        ],
      );
      expect(first.events[2].payload).toEqual({ note: "Binder A" });
      expect(duplicateResponse.status).toBe(200);
      expect(duplicate.generation).toBe("1");
      expect(duplicate.acceptedOperationIds).toEqual(
        operations.map((operation) => operation.id),
      );
      expect(duplicate.events).toEqual([]);
      expect(pullResponse.status).toBe(200);
      expect(pull.generation).toBe("1");
      expect(pull.events).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("should reject a conflicting reuse of an operation identifier", async () => {
    const { app, store } = testDependencies();
    const original = testOperation();
    const conflicting = testOperation({
      payload: {
        holding: {
          ...(original.payload as { holding: Record<string, unknown> }).holding,
          quantity: 2,
        },
      },
    });

    try {
      const generation = await bootstrapGeneration(app);
      const first = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations: [original] }),
      });
      const conflict = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations: [conflicting] }),
      });

      expect(first.status).toBe(200);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: {
          code: "sync_operation_conflict",
          operationId: original.id,
        },
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it("should atomically require empty enrollment and keep its exact retry idempotent", async () => {
    const { app, store } = testDependencies();
    const adopted = testOperation({ id: "operation-adopted" });
    const unrelated = testOperation({
      id: "operation-unrelated",
      holdingId: "holding-unrelated",
      payload: {
        holding: {
          ...(adopted.payload as { holding: Record<string, unknown> }).holding,
          id: "holding-unrelated",
        },
      },
    });

    try {
      const generation = await bootstrapGeneration(app);
      const firstResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation,
          requireEmpty: true,
          operations: [adopted],
        }),
      });
      const first = await firstResponse.json();
      const retryResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor: first.cursor,
          generation,
          requireEmpty: true,
          operations: [adopted],
        }),
      });
      const conflictResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation,
          requireEmpty: true,
          operations: [unrelated],
        }),
      });

      expect(firstResponse.status).toBe(200);
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toMatchObject({
        acceptedOperationIds: [adopted.id],
        events: [],
      });
      expect(conflictResponse.status).toBe(409);
      expect(await conflictResponse.json()).toEqual({
        error: {
          code: "sync_enrollment_conflict",
          message: "Cloud enrollment requires an empty remote collection",
          currentEventCount: 1,
        },
      });
      expect(
        store.database.prepare("SELECT operation_id FROM sync_events").all(),
      ).toEqual([{ operation_id: adopted.id }]);
    } finally {
      store.close();
    }
  });

  it("should reject malformed sync events before writing them", async () => {
    const { app, store } = testDependencies();
    const operation = {
      id: "operation-invalid",
      deviceId: "device-1",
      type: "holding.quantity-adjusted",
      holdingId: "holding-1",
      occurredAt: FIXED_NOW.toISOString(),
      payload: { delta: 1.5 },
    };

    try {
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation: "1", operations: [operation] }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ code: "invalid_request" });
      expect(body.error.details[0].path).toContain("delta");
    } finally {
      store.close();
    }
  });

  it("should reject malformed or unsafe sync generations", async () => {
    const { app, store } = testDependencies();

    try {
      for (const generation of ["0", "01", "9007199254740992", 1]) {
        const response = await app.request("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation, operations: [] }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "invalid_request" },
        });
      }

      const pullResponse = await app.request("/api/sync?generation=01");
      expect(pullResponse.status).toBe(400);
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should reject a sync body larger than 2 MiB before JSON parsing", async () => {
    const { app, store } = testDependencies();
    const oversizedBody = JSON.stringify({
      operations: [],
      padding: "x".repeat(2 * 1024 * 1024),
    });

    try {
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedBody,
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: {
          code: "payload_too_large",
          message: "Sync request body must not exceed 2 MiB",
        },
      });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(self), microphone=(), geolocation=()",
      );
    } finally {
      store.close();
    }
  });

  it("should reject an individually oversized sync operation without writing it", async () => {
    const { app, store } = testDependencies({
      configure(config) {
        config.sync.maxOperationBytes = 512;
      },
    });
    const baseOperation = testOperation();
    const operation = testOperation({
      payload: {
        holding: {
          ...(
            baseOperation.payload as {
              holding: Record<string, unknown>;
            }
          ).holding,
          note: "x".repeat(1_000),
        },
      },
    });

    try {
      const generation = await bootstrapGeneration(app);
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations: [operation] }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: { code: "operation_too_large", operationId: operation.id },
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should reject a client-unreplayable holding snapshot before persistence", async () => {
    const { app, store } = testDependencies();
    const operation = testOperation();
    const holding = (
      operation.payload as {
        holding: { card: Record<string, unknown> };
      }
    ).holding;
    delete holding.card.name;

    try {
      const generation = await bootstrapGeneration(app);
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations: [operation] }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should share an exact client/server identifier and added-holding contract", async () => {
    const { app, store } = testDependencies();
    const whitespaceId = testOperation({ id: " operation-with-spaces " });
    const oversizedId = testOperation({ id: "x".repeat(161) });
    const deletedHolding = structuredClone(testOperation());
    (
      deletedHolding.payload as {
        holding: Record<string, unknown>;
      }
    ).holding.deletedAt = "2026-07-22T12:00:00.000Z";
    const invalid = [whitespaceId, oversizedId, deletedHolding];

    try {
      expect(invalid.map(isCollectionEvent)).toEqual([false, false, false]);
      const generation = await bootstrapGeneration(app);
      for (const operation of invalid) {
        const response = await app.request("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation, operations: [operation] }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "invalid_request" },
        });
      }
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should reject an account event quota atomically", async () => {
    const { app, store } = testDependencies({
      configure(config) {
        config.sync.maxAccountEvents = 1;
      },
    });
    const first = testOperation({ id: "operation-1" });
    const second = testOperation({
      id: "operation-2",
      holdingId: "holding-2",
      payload: {
        holding: {
          ...(first.payload as { holding: Record<string, unknown> }).holding,
          id: "holding-2",
        },
      },
    });
    const operations = [first, second];

    try {
      const generation = await bootstrapGeneration(app);
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations }),
      });

      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({
        error: { code: "sync_storage_limit", limit: "events" },
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should advance generation on delete and reject stale devices", async () => {
    const { app, store } = testDependencies();
    const operation = testOperation();
    const staleOperation = testOperation({ id: "operation-stale" });

    try {
      const generation = await bootstrapGeneration(app);
      const createResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation, operations: [operation] }),
      });
      expect((await createResponse.json()).generation).toBe("1");

      const firstResponse = await app.request("/api/sync", {
        method: "DELETE",
      });
      const first = await firstResponse.json();
      const staleResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation: "1",
          operations: [staleOperation],
        }),
      });
      const omittedResponse = await app.request("/api/sync");
      const currentResponse = await app.request("/api/sync?generation=2");
      const secondResponse = await app.request("/api/sync", {
        method: "DELETE",
      });
      const second = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(first).toEqual({
        deleted: true,
        accountExisted: true,
        generation: "2",
        message:
          "Cloud sync events were deleted from the active database. This does not guarantee erasure from filesystem snapshots or backups, which follow their own retention policies.",
      });
      expect(staleResponse.status).toBe(409);
      expect(await staleResponse.json()).toEqual({
        error: {
          code: "sync_generation_mismatch",
          message: "Sync generation 2 is required for this account",
          currentGeneration: "2",
        },
      });
      expect(omittedResponse.status).toBe(200);
      expect(await omittedResponse.json()).toMatchObject({
        generation: "2",
        events: [],
      });
      expect(currentResponse.status).toBe(200);
      expect(await currentResponse.json()).toMatchObject({
        generation: "2",
        events: [],
      });
      expect(secondResponse.status).toBe(200);
      expect(second).toMatchObject({
        deleted: true,
        accountExisted: true,
        generation: "3",
      });
      expect(
        store.database
          .prepare(
            `SELECT COUNT(*) AS count, MAX(generation) AS generation
             FROM sync_accounts`,
          )
          .get(),
      ).toMatchObject({ count: 1, generation: 3 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should return generation two when deleting an account that was never synced", async () => {
    const { app, store } = testDependencies();

    try {
      const response = await app.request("/api/sync", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        deleted: true,
        accountExisted: false,
        generation: "2",
      });
      expect(
        store.database
          .prepare(
            `SELECT generation
             FROM sync_accounts
             WHERE user_id = ?`,
          )
          .get("user-123"),
      ).toEqual({ generation: 2 });
    } finally {
      store.close();
    }
  });

  it("should require a valid bearer principal when OIDC mode is enabled", async () => {
    const unauthorized: Authenticator = {
      async authenticate() {
        throw new AuthenticationError();
      },
    };
    const { app, store } = testDependencies({ authenticator: unauthorized });

    try {
      const response = await app.request("/api/sync");
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.error.code).toBe("unauthorized");
    } finally {
      store.close();
    }
  });

  it("should make cloud sync explicitly unavailable when OIDC is disabled", async () => {
    const { app, store } = testDependencies({
      authenticator: new DisabledAuthenticator(),
    });

    try {
      const response = await app.request("/api/sync");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: { code: "sync_disabled" },
      });
    } finally {
      store.close();
    }
  });

  it("should rate-limit authenticated sync per subject and prohibit response caching", async () => {
    const { app, store } = testDependencies();

    try {
      for (let request = 0; request < 60; request += 1) {
        const response = await app.request("/api/sync");
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const limited = await app.request("/api/sync");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("cache-control")).toBe("no-store");
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toEqual({
        error: {
          code: "sync_rate_limited",
          message: "Cloud sync request rate exceeded",
        },
      });
    } finally {
      store.close();
    }
  });

  it("should serve built assets and the SPA fallback without intercepting unknown API routes", async () => {
    const staticRoot = mkdtempSync(path.join(tmpdir(), "cardscope-static-"));
    mkdirSync(path.join(staticRoot, "assets"));
    writeFileSync(
      path.join(staticRoot, "index.html"),
      "<main>CardScope shell</main>",
    );
    writeFileSync(
      path.join(staticRoot, "assets", "app.js"),
      "globalThis.cardscope = true;",
    );
    const { app, store } = testDependencies({ staticRoot });

    try {
      const assetResponse = await app.request("/assets/app.js");
      const routeResponse = await app.request("/collection/pikachu");
      const unknownApiResponse = await app.request("/api/does-not-exist");

      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain("cardscope = true");
      expect(assetResponse.headers.get("cache-control")).toContain("immutable");
      expect(routeResponse.status).toBe(200);
      expect(await routeResponse.text()).toContain("CardScope shell");
      expect(unknownApiResponse.status).toBe(404);
      expect(await unknownApiResponse.json()).toMatchObject({
        error: { code: "not_found" },
      });
    } finally {
      store.close();
      rmSync(staticRoot, { recursive: true, force: true });
    }
  });
});
