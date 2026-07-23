import type {
  CatalogueSource,
  Holding,
  PokemonCard,
  SyncOperation,
} from "../../shared/types.js";
import type { CatalogueAdapter } from "../../server/catalog/adapters.js";
import type { RuntimeConfig } from "../../server/config.js";

export const FIXED_NOW = new Date("2026-07-22T12:00:00.000Z");

export function testConfig(databasePath = ":memory:"): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    publicOrigin: "http://localhost:5173",
    databasePath,
    staticRoot: null,
    catalogue: {
      tcgdexBaseUrl: "https://tcgdex.example/v2",
      tcgdexCatalogEnabled: true,
      pokemonTcgBaseUrl: "https://pokemon-tcg.example/v2",
      pokemonTcgApiKey: "server-only-api-key",
      pokemonTcgCatalogEnabled: true,
      cardImagesEnabled: true,
      timeoutMs: 100,
      maxResponseBytes: 2 * 1024 * 1024,
      cacheFreshMs: 60_000,
      cacheMaxStaleMs: 86_400_000,
      cacheMaxEntries: 20_000,
      rateLimitPerMinute: 60,
      globalRateLimitPerMinute: 300,
      maxConcurrentRequests: 8,
      providerFailureThreshold: 3,
      providerCooldownMs: 60_000,
      marketQuotesEnabled: true,
      languages: ["en", "fr"],
    },
    oidc: {
      enabled: true,
      issuer: "https://auth.example",
      clientId: "pokemon-cards",
      audience: "pokemon-cards-api",
      jwksUri: "https://auth.example/keys-with-private-location",
    },
    sync: {
      retentionDays: 1_826,
      maxBatchSize: 200,
      maxOperationBytes: 64 * 1024,
      maxAccountEvents: 10_000,
      maxAccountBytes: 64 * 1024 * 1024,
      maxPullBytes: 1024 * 1024,
    },
    maintenance: {
      pruneIntervalMs: 60 * 60 * 1_000,
    },
  };
}

export function testCard(overrides: Partial<PokemonCard> = {}): PokemonCard {
  return {
    id: "pokemon-card:en:base1:58:pikachu",
    name: "Pikachu",
    number: "58",
    language: "en",
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
      small: "https://images.example/pikachu-small.webp",
      large: "https://images.example/pikachu-large.webp",
    },
    externalIds: { tcgdex: "base1-58" },
    sources: ["tcgdex"],
    quotes: [],
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

export function testAdapter(
  source: CatalogueSource,
  implementation: Partial<CatalogueAdapter> = {},
): CatalogueAdapter {
  return {
    source,
    async search() {
      return [];
    },
    async getCard() {
      return null;
    },
    ...implementation,
  };
}

export function testHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: "holding-1",
    cardId: testCard().id,
    quantity: 1,
    language: "en",
    condition: "near_mint",
    finish: "normal",
    acquisitionCost: null,
    acquisitionCurrency: null,
    acquiredAt: null,
    notes: null,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

export function testOperation(
  overrides: Partial<SyncOperation> = {},
): SyncOperation {
  const holding = testHolding();
  return {
    id: "operation-1",
    deviceId: "device-1",
    type: "holding.added",
    holdingId: holding.id,
    occurredAt: FIXED_NOW.toISOString(),
    payload: { holding: { ...holding } },
    ...overrides,
  } as SyncOperation;
}
