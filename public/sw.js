/* global self, caches, URL, fetch */

const CACHE = "cardscope-shell-v2";
const STATIC_SHELL = ["/manifest.webmanifest", "/icon.svg"];
const AUTH_QUERY_PARAMETERS = new Set([
  "code",
  "state",
  "session_state",
  "iss",
  "error",
  "error_description",
  "access_token",
  "id_token",
]);

function containsAuthParameters(url) {
  return [...AUTH_QUERY_PARAMETERS].some((name) => url.searchParams.has(name));
}

function shouldBypass(request) {
  const url = new URL(request.url);
  return (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/auth/callback" ||
    url.pathname.startsWith("/auth/callback/") ||
    containsAuthParameters(url)
  );
}

function discoverBuiltAssets(html) {
  const assets = new Set();
  const attribute = /(?:src|href)=["']([^"']+)["']/giu;
  for (const match of html.matchAll(attribute)) {
    const url = new URL(match[1], self.location.origin);
    if (
      url.origin === self.location.origin &&
      !containsAuthParameters(url) &&
      /\.(?:css|js)$/u.test(url.pathname)
    ) {
      assets.add(`${url.pathname}${url.search}`);
    }
  }
  return [...assets];
}

async function installShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch("/", {
    cache: "reload",
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error("Unable to install the CardScope offline shell");
  const html = await response.clone().text();
  const builtAssets = discoverBuiltAssets(html);
  // The unique cache version and hashed Vite asset URLs make the install
  // atomic: a failed update never activates and the previous shell survives.
  await cache.addAll([...STATIC_SHELL, ...builtAssets]);
  await cache.put("/", response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (shouldBypass(event.request)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(event.request, copy)),
          );
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        throw new Error("Resource is not available offline");
      }),
  );
});
