import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../server/app.js";
import { AuthenticationError, type Authenticator } from "../../server/auth.js";
import { CatalogueService } from "../../server/catalog/service.js";
import { SqliteStore } from "../../server/store.js";
import { FIXED_NOW, testAdapter, testConfig } from "./fixtures.js";

// Regression for GHSA-jpvv-r467-5p4w (backslash path bypass) and
// GHSA-rmxm-3fg6-px4f / GHSA-5r4p-p66f-jhc7 (serveStatic double decode).
// Requests go through a real @hono/node-server socket with raw paths, because
// the WHATWG URL parser used by `app.request()` normalises backslashes.

const SECRET = "OUTSIDE_STATIC_ROOT_SECRET";
const SPA_INDEX = "<!doctype html><title>spa-index</title>";

const protectedVariants = [
  "/public/..\\api/sync",
  "/..\\api/sync",
  "/assets/..\\..\\api/sync",
  "/%5capi/sync",
  "/%5Capi/sync",
  "/%255capi/sync",
  "/public/..%5capi/sync",
  "/public/..%255capi/sync",
  "/%2561pi/sync",
  "/%2541pi/sync",
  "/api%5csync",
  "/api%255csync",
];

const traversalVariants = [
  "/..\\secret.txt",
  "/assets/..\\..\\secret.txt",
  "/..%5csecret.txt",
  "/..%5Csecret.txt",
  "/..%255csecret.txt",
  "/assets/..%5c..%5csecret.txt",
  "/assets/%252e%252e/%252e%252e/secret.txt",
  "/%2e%2e/secret.txt",
  "/%252e%252e%255csecret.txt",
];

function rawGet(
  port: number,
  rawPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: rawPath },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("static serving path hardening", () => {
  let workDir: string;
  let server: ServerType;
  let port: number;
  let store: SqliteStore;
  const authenticate = vi.fn<Authenticator["authenticate"]>(async () => {
    throw new AuthenticationError("Bearer token required");
  });

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "cardscope-static-"));
    const staticRoot = path.join(workDir, "site");
    mkdirSync(path.join(staticRoot, "assets"), { recursive: true });
    mkdirSync(path.join(staticRoot, "public"), { recursive: true });
    writeFileSync(path.join(staticRoot, "index.html"), SPA_INDEX);
    writeFileSync(path.join(staticRoot, "assets", "app.js"), "export {};");
    writeFileSync(path.join(workDir, "secret.txt"), SECRET);

    store = new SqliteStore(":memory:");
    const catalogue = new CatalogueService({
      primary: testAdapter("tcgdex"),
      secondary: testAdapter("pokemon_tcg"),
      enabledSources: ["tcgdex"],
      cardImagesEnabled: false,
      cache: store,
      cacheFreshMs: 60_000,
      marketQuotesEnabled: false,
      clock: () => FIXED_NOW,
    });
    const app = createApp({
      config: { ...testConfig(), staticRoot },
      store,
      catalogue,
      authenticator: { authenticate },
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("should keep the sync route behind authentication (control)", async () => {
    authenticate.mockClear();
    const response = await rawGet(port, "/api/sync");

    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("should serve files inside the static root (control)", async () => {
    const response = await rawGet(port, "/assets/app.js");

    expect(response.status).toBe(200);
    expect(response.body).toBe("export {};");
  });

  it.each(protectedVariants)(
    "should never reach the sync handler through %s",
    async (rawPath) => {
      const response = await rawGet(port, rawPath);

      // Either the auth middleware answers, or the request never matches the
      // API and falls back to the SPA shell; the handler is never reached.
      expect(response.status).not.toBe(500);
      expect(response.body).not.toMatch(/"(events|generation|cursor)"/);
      if (response.status === 200) expect(response.body).toBe(SPA_INDEX);
    },
  );

  it.each(traversalVariants)(
    "should never read outside the static root through %s",
    async (rawPath) => {
      const response = await rawGet(port, rawPath);

      expect(response.body).not.toContain(SECRET);
      if (response.status === 200) expect(response.body).toBe(SPA_INDEX);
    },
  );
});
