import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadConfig,
  loadLocalEnvironment,
  toPublicConfig,
} from "../../server/config.js";

describe("OIDC runtime configuration", () => {
  it("loads an optional local .env file without requiring one in production", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cardscope-env-"));
    const file = path.join(directory, ".env");
    const key = "CARDSCOPE_TEST_ENV_FILE";
    const previous = process.env[key];
    delete process.env[key];
    writeFileSync(file, `${key}=loaded\n`);
    try {
      expect(loadLocalEnvironment(file)).toBe(true);
      expect(process.env[key]).toBe("loaded");
      expect(loadLocalEnvironment(path.join(directory, "missing"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for every catalogue data class unless explicitly enabled", () => {
    expect(loadConfig({}).catalogue).toMatchObject({
      tcgdexCatalogEnabled: false,
      pokemonTcgCatalogEnabled: false,
      cardImagesEnabled: false,
      marketQuotesEnabled: false,
      maxResponseBytes: 2 * 1024 * 1024,
      cacheMaxBytes: 256 * 1024 * 1024,
    });
    expect(
      loadConfig({
        TCGDEX_CATALOG_ENABLED: "true",
        POKEMON_TCG_CATALOG_ENABLED: "true",
        CARD_IMAGES_ENABLED: "true",
        MARKET_QUOTES_ENABLED: "true",
      }).catalogue,
    ).toMatchObject({
      tcgdexCatalogEnabled: true,
      pokemonTcgCatalogEnabled: true,
      cardImagesEnabled: true,
      marketQuotesEnabled: true,
    });
    expect(() => loadConfig({ MARKET_QUOTES_ENABLED: "yes" })).toThrow(
      "MARKET_QUOTES_ENABLED must be either true or false",
    );
    expect(() =>
      loadConfig({ CATALOG_MAX_RESPONSE_BYTES: String(16 * 1024 * 1024 + 1) }),
    ).toThrow("CATALOG_MAX_RESPONSE_BYTES must not exceed 16777216");
    expect(() =>
      loadConfig({ CATALOG_CACHE_MAX_BYTES: String(1024 * 1024 * 1024 + 1) }),
    ).toThrow("CATALOG_CACHE_MAX_BYTES must not exceed 1073741824");
  });

  it("bounds and publishes server recognition only with an authorised catalogue", () => {
    expect(loadConfig({}).recognition.enabled).toBe(false);
    expect(
      toPublicConfig(loadConfig({ RECOGNITION_ENABLED: "true" })).recognition
        .enabled,
    ).toBe(false);
    expect(
      toPublicConfig(
        loadConfig({
          RECOGNITION_ENABLED: "true",
          TCGDEX_CATALOG_ENABLED: "true",
        }),
      ).recognition,
    ).toMatchObject({
      enabled: true,
      processing: "server",
      maxImageBytes: 2 * 1024 * 1024,
    });
    expect(
      toPublicConfig(loadConfig({ MARKET_QUOTES_ENABLED: "true" })).valuation,
    ).toEqual({ marketQuotesEnabled: true });
    expect(() => loadConfig({ RECOGNITION_MAX_PIXELS: "4000001" })).toThrow(
      "RECOGNITION_MAX_PIXELS must not exceed 4000000",
    );
    expect(() => loadConfig({ RECOGNITION_TIMEOUT_MS: "45001" })).toThrow(
      "RECOGNITION_TIMEOUT_MS must not exceed 45000",
    );
    expect(() =>
      loadConfig({ RECOGNITION_MAX_CONCURRENT_UPLOADS: "5" }),
    ).toThrow("RECOGNITION_MAX_CONCURRENT_UPLOADS must not exceed 4");
  });

  it("rejects insecure remote OIDC endpoints but permits loopback development", () => {
    expect(() =>
      loadConfig({ OIDC_ISSUER: "http://auth.example.test" }),
    ).toThrow("OIDC_ISSUER must use HTTPS");
    expect(() =>
      loadConfig({ OIDC_JWKS_URI: "http://keys.example.test/jwks.json" }),
    ).toThrow("OIDC_JWKS_URI must use HTTPS");
    expect(
      loadConfig({
        OIDC_REQUIRED: "true",
        OIDC_ISSUER: "http://127.0.0.1:8080",
        OIDC_JWKS_URI: "http://localhost:8080/jwks.json",
        OIDC_AUDIENCE: "cardscope-api",
      }).oidc,
    ).toMatchObject({
      issuer: "http://127.0.0.1:8080",
      jwksUri: "http://localhost:8080/jwks.json",
    });
  });

  it("fails closed when cloud sync is enabled without an API audience", () => {
    expect(() =>
      loadConfig({
        OIDC_REQUIRED: "true",
        OIDC_ISSUER: "https://auth.example.test",
      }),
    ).toThrow("OIDC_AUDIENCE is required");
  });

  it("publishes the exact configured audience to the public client", () => {
    const config = loadConfig({
      OIDC_REQUIRED: "true",
      OIDC_ISSUER: "https://auth.example.test",
      OIDC_CLIENT_ID: "cardscope-public",
      OIDC_AUDIENCE: "cardscope-api",
    });

    expect(toPublicConfig(config).auth).toEqual({
      enabled: true,
      issuer: "https://auth.example.test",
      clientId: "cardscope-public",
      audience: "cardscope-api",
    });
  });
});
