import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../server/app.js";
import {
  DisabledAuthenticator,
  type Authenticator,
} from "../../server/auth.js";
import { CatalogueService } from "../../server/catalog/service.js";
import type { CatalogueAdapter } from "../../server/catalog/adapters.js";
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
    catalogueSearch?: CatalogueAdapter["search"];
  } = {},
) {
  const config = testConfig();
  const store = new SqliteStore(":memory:");
  const search = vi.fn(
    options.catalogueSearch ??
      (async (_query, language) => [testCard({ language })]),
  );
  const catalogue = new CatalogueService({
    primary: testAdapter("tcgdex", {
      search,
      getCard: vi.fn(async () => testCard()),
    }),
    secondary: testAdapter("pokemon_tcg"),
    enabledSources: ["tcgdex", "pokemon_tcg"],
    cardImagesEnabled: true,
    cache: store,
    cacheFreshMs: 60_000,
    marketQuotesEnabled: true,
    clock: () => FIXED_NOW,
  });
  return {
    store,
    search,
    app: createApp({
      config,
      store,
      catalogue,
      authenticator: options.authenticator ?? authenticated,
    }),
  };
}

describe("CardScope API", () => {
  it("should expose health and a browser-vector-only public configuration", async () => {
    const { app, store } = testDependencies();
    try {
      const health = await app.request("/api/health");
      const config = await app.request("/api/config");

      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        status: "ok",
        service: "cardscope-api",
        database: { ok: true },
      });
      expect(await config.json()).toMatchObject({
        recognition: { enabled: false, processing: "browser-vector" },
      });
    } finally {
      store.close();
    }
  });

  it("should not expose a server image-upload recognition endpoint", async () => {
    const { app, store } = testDependencies();
    try {
      const response = await app.request("/api/recognition/cards", {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "not_found" },
      });
    } finally {
      store.close();
    }
  });

  it("should search the catalogue without retaining a query in the client", async () => {
    const { app, store, search } = testDependencies();
    try {
      const response = await app.request(
        "/api/catalog/cards?q=Pikachu&language=auto&limit=10",
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        query: "Pikachu",
        cards: [{ name: "Pikachu" }],
      });
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("should require authentication for cloud synchronization", async () => {
    const { app, store } = testDependencies({
      authenticator: new DisabledAuthenticator(),
    });
    try {
      const response = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation: null, operations: [] }),
      });

      expect(response.status).toBe(503);
    } finally {
      store.close();
    }
  });

  it("should establish a generation and accept an authenticated holding event", async () => {
    const { app, store } = testDependencies();
    try {
      const enrollment = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generation: null, operations: [] }),
      });
      const enrolled = (await enrollment.json()) as { generation: string };
      const operation = testOperation();
      const write = await app.request("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generation: enrolled.generation,
          operations: [operation],
        }),
      });

      expect(enrollment.status).toBe(200);
      expect(enrolled.generation).toBe("1");
      expect(write.status).toBe(200);
      expect(await write.json()).toMatchObject({
        generation: "1",
        acceptedOperationIds: [operation.id],
        events: [expect.objectContaining({ id: operation.id })],
      });
    } finally {
      store.close();
    }
  });
});
