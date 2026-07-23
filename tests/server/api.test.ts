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
  const catalogue = new CatalogueService({
    primary: testAdapter("tcgdex", {
      search: vi.fn(async () => [card]),
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
  return {
    store,
    app: createApp({ config, store, catalogue, authenticator }),
  };
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
        payload: { note: "Binder A", futureClientField: { preserved: true } },
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
      const firstResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: null, operations }),
      });
      const first = await firstResponse.json();
      const duplicateResponse = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: first.cursor, operations }),
      });
      const duplicate = await duplicateResponse.json();
      const pullResponse = await app.request(
        `/api/sync?cursor=${first.cursor}`,
      );
      const pull = await pullResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(first).toMatchObject({
        acceptedOperationIds: operations.map((operation) => operation.id),
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
      expect(first.events[2].payload).toEqual({
        note: "Binder A",
        futureClientField: { preserved: true },
      });
      expect(duplicateResponse.status).toBe(200);
      expect(duplicate.acceptedOperationIds).toEqual([]);
      expect(duplicate.events).toEqual([]);
      expect(pullResponse.status).toBe(200);
      expect(pull.events).toEqual([]);
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
        body: JSON.stringify({ operations: [operation] }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ code: "invalid_request" });
      expect(body.error.details[0].path).toContain("delta");
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
    const operation = testOperation({
      payload: { holding: { notes: "x".repeat(1_000) } },
    });

    try {
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: [operation] }),
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

  it("should reject an account event quota atomically", async () => {
    const { app, store } = testDependencies({
      configure(config) {
        config.sync.maxAccountEvents = 1;
      },
    });
    const operations = [
      testOperation({ id: "operation-1" }),
      testOperation({ id: "operation-2" }),
    ];

    try {
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations }),
      });

      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({
        error: { code: "sync_storage_limit", limit: "events" },
      });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("should logically delete authenticated cloud sync data with an idempotent response", async () => {
    const { app, store } = testDependencies();
    const operation = testOperation();

    try {
      await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: [operation] }),
      });

      const firstResponse = await app.request("/api/sync", {
        method: "DELETE",
      });
      const first = await firstResponse.json();
      const secondResponse = await app.request("/api/sync", {
        method: "DELETE",
      });
      const second = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(first).toEqual({
        deleted: true,
        accountExisted: true,
        message:
          "Cloud sync events were deleted from the active database. This does not guarantee erasure from filesystem snapshots or backups, which follow their own retention policies.",
      });
      expect(secondResponse.status).toBe(200);
      expect(second).toMatchObject({ deleted: true, accountExisted: false });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_accounts")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM sync_events")
          .get(),
      ).toMatchObject({ count: 0 });
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
      expect(await response.json()).toMatchObject({
        error: { code: "sync_disabled" },
      });
    } finally {
      store.close();
    }
  });

  it("should serve built assets and the SPA fallback without intercepting unknown API routes", async () => {
    const staticRoot = mkdtempSync(path.join(tmpdir(), "cardscope-static-"));
    mkdirSync(path.join(staticRoot, "assets"));
    mkdirSync(path.join(staticRoot, "ocr", "v6"), { recursive: true });
    writeFileSync(
      path.join(staticRoot, "index.html"),
      "<main>CardScope shell</main>",
    );
    writeFileSync(
      path.join(staticRoot, "assets", "app.js"),
      "globalThis.cardscope = true;",
    );
    writeFileSync(path.join(staticRoot, "ocr", "v6", "worker.min.js"), "");
    const { app, store } = testDependencies({ staticRoot });

    try {
      const assetResponse = await app.request("/assets/app.js");
      const ocrResponse = await app.request("/ocr/v6/worker.min.js");
      const routeResponse = await app.request("/collection/pikachu");
      const unknownApiResponse = await app.request("/api/does-not-exist");

      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain("cardscope = true");
      expect(assetResponse.headers.get("cache-control")).toContain("immutable");
      expect(ocrResponse.status).toBe(200);
      expect(ocrResponse.headers.get("cache-control")).toContain("immutable");
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
