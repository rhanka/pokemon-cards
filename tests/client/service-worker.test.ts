import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerListener = (event: Record<string, unknown>) => void;

function response(body = "") {
  return {
    ok: true,
    clone: () => response(body),
    text: async () => body,
  };
}

function loadWorker(
  html = '<script type="module" src="/assets/app.abc123.js"></script>',
) {
  const listeners = new Map<string, WorkerListener>();
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    match: vi.fn().mockResolvedValue(undefined),
  };
  const fetch = vi.fn().mockResolvedValue(response(html));
  const self = {
    location: { origin: "https://cards.example.test" },
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: WorkerListener) =>
      listeners.set(type, listener),
  };
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  runInNewContext(source, { self, caches, fetch, URL, console });
  return { listeners, cache, caches, fetch };
}

describe("offline service worker", () => {
  it("should discover and cache same-origin built JS and CSS during its first install", async () => {
    const { listeners, cache } = loadWorker(`
      <link rel="stylesheet" href="/assets/app.abc123.css">
      <script type="module" src="/assets/app.def456.js"></script>
      <script src="https://cdn.example.test/external.js"></script>
      <script src="/assets/leak.js?code=secret"></script>
    `);
    let installation: Promise<unknown> | undefined;

    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => (installation = promise),
    });
    await installation;

    expect(cache.addAll).toHaveBeenCalledWith([
      "/manifest.webmanifest",
      "/icon.svg",
      "/assets/app.abc123.css",
      "/assets/app.def456.js",
    ]);
    expect(cache.put).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({ ok: true }),
    );
  });

  it.each([
    "https://catalog.example.test/image.png",
    "https://cards.example.test/api/health",
    "https://cards.example.test/auth/callback?code=secret&state=opaque",
    "https://cards.example.test/?id_token=secret",
  ])(
    "should bypass cross-origin, API, and authentication requests: %s",
    (url) => {
      const { listeners } = loadWorker();
      const respondWith = vi.fn();

      listeners.get("fetch")?.({
        request: { method: "GET", url, mode: "navigate" },
        respondWith,
      });

      expect(respondWith).not.toHaveBeenCalled();
    },
  );

  it("should handle and cache an ordinary same-origin asset request", () => {
    const { listeners } = loadWorker();
    const respondWith = vi.fn();

    listeners.get("fetch")?.({
      request: {
        method: "GET",
        url: "https://cards.example.test/assets/app.js",
        mode: "cors",
      },
      respondWith,
      waitUntil: vi.fn(),
    });

    expect(respondWith).toHaveBeenCalledOnce();
  });
});
