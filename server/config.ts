import path from "node:path";
import { loadEnvFile } from "node:process";

import type { CardLanguage, PublicAppConfig } from "../shared/types.js";

export interface RuntimeConfig {
  host: string;
  port: number;
  publicOrigin: string;
  databasePath: string;
  staticRoot: string | null;
  catalogue: {
    tcgdexBaseUrl: string;
    tcgdexCatalogEnabled: boolean;
    pokemonTcgBaseUrl: string;
    pokemonTcgApiKey: string | null;
    pokemonTcgCatalogEnabled: boolean;
    cardImagesEnabled: boolean;
    timeoutMs: number;
    maxResponseBytes: number;
    cacheFreshMs: number;
    cacheMaxStaleMs: number;
    cacheMaxEntries: number;
    rateLimitPerMinute: number;
    globalRateLimitPerMinute: number;
    maxConcurrentRequests: number;
    providerFailureThreshold: number;
    providerCooldownMs: number;
    marketQuotesEnabled: boolean;
    languages: CardLanguage[];
  };
  oidc: {
    enabled: boolean;
    issuer: string | null;
    clientId: string;
    audience: string | null;
    jwksUri: string | null;
  };
  sync: {
    retentionDays: number;
    maxBatchSize: number;
    maxOperationBytes: number;
    maxAccountEvents: number;
    maxAccountBytes: number;
    maxPullBytes: number;
  };
  maintenance: {
    pruneIntervalMs: number;
  };
}

const DEFAULT_PORT = 8787;
const DEFAULT_RETENTION_DAYS = 1_826;
const MAX_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;

export function loadLocalEnvironment(file = ".env"): boolean {
  try {
    loadEnvFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function normalizedUrl(value: string, name: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (normalized === "::1" || normalized === "[::1]") return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(
    ipv4 &&
    ipv4.slice(1).every((part) => Number(part) <= 255) &&
    Number(ipv4[1]) === 127,
  );
}

export function oidcUrlUsesLoopback(value: string): boolean {
  return isLoopbackHostname(new URL(value).hostname);
}

export function normalizedOidcUrl(value: string, name: string): string {
  const normalized = normalizedUrl(value, name);
  const url = new URL(normalized);
  if (url.protocol === "https:") return normalized;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    return normalized;
  throw new Error(
    `${name} must use HTTPS except for localhost or loopback development`,
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const oidcEnabled = parseBoolean(env.OIDC_REQUIRED, false, "OIDC_REQUIRED");
  const oidcIssuer = env.OIDC_ISSUER?.trim()
    ? normalizedOidcUrl(env.OIDC_ISSUER.trim(), "OIDC_ISSUER")
    : null;
  const clientId = env.OIDC_CLIENT_ID?.trim() || "pokemon-cards";
  const audience = env.OIDC_AUDIENCE?.trim() || null;
  const oidcJwksUri = env.OIDC_JWKS_URI?.trim()
    ? normalizedOidcUrl(env.OIDC_JWKS_URI.trim(), "OIDC_JWKS_URI")
    : null;

  if (oidcEnabled && !oidcIssuer) {
    throw new Error("OIDC_ISSUER is required when OIDC_REQUIRED=true");
  }
  if (oidcEnabled && !audience) {
    throw new Error("OIDC_AUDIENCE is required when OIDC_REQUIRED=true");
  }
  if (
    oidcIssuer &&
    oidcJwksUri &&
    new URL(oidcJwksUri).protocol === "http:" &&
    !oidcUrlUsesLoopback(oidcIssuer)
  ) {
    throw new Error(
      "OIDC_JWKS_URI may use HTTP only with a localhost or loopback OIDC_ISSUER",
    );
  }

  const dataDir = path.resolve(env.DATA_DIR?.trim() || "./data");

  const maxOperationBytes = parseInteger(
    env.SYNC_MAX_OPERATION_BYTES,
    64 * 1024,
    "SYNC_MAX_OPERATION_BYTES",
    1_024,
  );
  const maxPullBytes = parseInteger(
    env.SYNC_MAX_PULL_BYTES,
    1024 * 1024,
    "SYNC_MAX_PULL_BYTES",
    4_096,
  );
  if (maxPullBytes < maxOperationBytes + 2_048) {
    throw new Error(
      "SYNC_MAX_PULL_BYTES must exceed SYNC_MAX_OPERATION_BYTES by at least 2048 bytes",
    );
  }
  const catalogMaxResponseBytes = parseInteger(
    env.CATALOG_MAX_RESPONSE_BYTES,
    2 * 1024 * 1024,
    "CATALOG_MAX_RESPONSE_BYTES",
    1_024,
  );
  if (catalogMaxResponseBytes > MAX_CATALOG_RESPONSE_BYTES) {
    throw new Error(
      `CATALOG_MAX_RESPONSE_BYTES must not exceed ${MAX_CATALOG_RESPONSE_BYTES}`,
    );
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parseInteger(env.PORT, DEFAULT_PORT, "PORT", 1),
    publicOrigin: normalizedUrl(
      env.PUBLIC_ORIGIN?.trim() || "http://localhost:5173",
      "PUBLIC_ORIGIN",
    ),
    databasePath: path.join(dataDir, "cardscope.sqlite"),
    staticRoot: path.resolve(env.STATIC_ROOT?.trim() || "./dist"),
    catalogue: {
      tcgdexBaseUrl: normalizedUrl(
        env.TCGDEX_BASE_URL?.trim() || "https://api.tcgdex.net/v2",
        "TCGDEX_BASE_URL",
      ),
      tcgdexCatalogEnabled: parseBoolean(
        env.TCGDEX_CATALOG_ENABLED,
        false,
        "TCGDEX_CATALOG_ENABLED",
      ),
      pokemonTcgBaseUrl: normalizedUrl(
        env.POKEMON_TCG_BASE_URL?.trim() || "https://api.pokemontcg.io/v2",
        "POKEMON_TCG_BASE_URL",
      ),
      pokemonTcgApiKey: env.POKEMON_TCG_API_KEY?.trim() || null,
      pokemonTcgCatalogEnabled: parseBoolean(
        env.POKEMON_TCG_CATALOG_ENABLED,
        false,
        "POKEMON_TCG_CATALOG_ENABLED",
      ),
      cardImagesEnabled: parseBoolean(
        env.CARD_IMAGES_ENABLED,
        false,
        "CARD_IMAGES_ENABLED",
      ),
      timeoutMs: parseInteger(
        env.CATALOG_TIMEOUT_MS,
        4_000,
        "CATALOG_TIMEOUT_MS",
        100,
      ),
      maxResponseBytes: catalogMaxResponseBytes,
      cacheFreshMs: parseInteger(
        env.CATALOG_CACHE_FRESH_MS,
        24 * 60 * 60 * 1_000,
        "CATALOG_CACHE_FRESH_MS",
        1_000,
      ),
      cacheMaxStaleMs: parseInteger(
        env.CATALOG_CACHE_MAX_STALE_MS,
        30 * 24 * 60 * 60 * 1_000,
        "CATALOG_CACHE_MAX_STALE_MS",
        1_000,
      ),
      cacheMaxEntries: parseInteger(
        env.CATALOG_CACHE_MAX_ENTRIES,
        20_000,
        "CATALOG_CACHE_MAX_ENTRIES",
        100,
      ),
      rateLimitPerMinute: parseInteger(
        env.CATALOG_RATE_LIMIT_PER_MINUTE,
        60,
        "CATALOG_RATE_LIMIT_PER_MINUTE",
        1,
      ),
      globalRateLimitPerMinute: parseInteger(
        env.CATALOG_GLOBAL_RATE_LIMIT_PER_MINUTE,
        300,
        "CATALOG_GLOBAL_RATE_LIMIT_PER_MINUTE",
        1,
      ),
      maxConcurrentRequests: parseInteger(
        env.CATALOG_MAX_CONCURRENT_REQUESTS,
        8,
        "CATALOG_MAX_CONCURRENT_REQUESTS",
        1,
      ),
      providerFailureThreshold: parseInteger(
        env.CATALOG_PROVIDER_FAILURE_THRESHOLD,
        3,
        "CATALOG_PROVIDER_FAILURE_THRESHOLD",
        1,
      ),
      providerCooldownMs: parseInteger(
        env.CATALOG_PROVIDER_COOLDOWN_MS,
        60_000,
        "CATALOG_PROVIDER_COOLDOWN_MS",
        1_000,
      ),
      marketQuotesEnabled: parseBoolean(
        env.MARKET_QUOTES_ENABLED,
        false,
        "MARKET_QUOTES_ENABLED",
      ),
      languages: ["en", "fr"],
    },
    oidc: {
      enabled: oidcEnabled,
      issuer: oidcIssuer,
      clientId,
      audience,
      jwksUri: oidcJwksUri,
    },
    sync: {
      retentionDays: parseInteger(
        env.SYNC_RETENTION_DAYS,
        DEFAULT_RETENTION_DAYS,
        "SYNC_RETENTION_DAYS",
        1,
      ),
      maxBatchSize: parseInteger(
        env.SYNC_MAX_BATCH_SIZE,
        200,
        "SYNC_MAX_BATCH_SIZE",
        1,
      ),
      maxOperationBytes,
      maxAccountEvents: parseInteger(
        env.SYNC_MAX_ACCOUNT_EVENTS,
        10_000,
        "SYNC_MAX_ACCOUNT_EVENTS",
        1,
      ),
      maxAccountBytes: parseInteger(
        env.SYNC_MAX_ACCOUNT_BYTES,
        64 * 1024 * 1024,
        "SYNC_MAX_ACCOUNT_BYTES",
        4_096,
      ),
      maxPullBytes,
    },
    maintenance: {
      pruneIntervalMs: parseInteger(
        env.PRUNE_INTERVAL_MS,
        60 * 60 * 1_000,
        "PRUNE_INTERVAL_MS",
        10_000,
      ),
    },
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicAppConfig {
  return {
    auth: {
      enabled: config.oidc.enabled,
      issuer: config.oidc.issuer,
      clientId: config.oidc.clientId,
      audience: config.oidc.audience,
    },
    sync: {
      enabled: config.oidc.enabled,
      retentionDays: config.sync.retentionDays,
      maxBatchSize: config.sync.maxBatchSize,
    },
    catalogue: {
      languages: [...config.catalogue.languages],
      primary: "tcgdex",
      secondary: "pokemon_tcg",
    },
    privacy: {
      photosUploadedByDefault: false,
    },
  };
}
