import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";

import { createRuntime } from "./app.js";
import { loadLocalEnvironment } from "./config.js";
import { createShutdownHandler } from "./shutdown.js";

loadLocalEnvironment();
const runtime = createRuntime();
const server = serve({
  fetch: runtime.app.fetch,
  hostname: runtime.config.host,
  port: runtime.config.port,
}) as HttpServer;
// Bound slow uploads before they can occupy all recognition admission slots.
// Node's requestTimeout covers receiving the request, not the OCR response.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

console.info(
  `CardScope API listening on http://${runtime.config.host}:${runtime.config.port}`,
);

const shutdown = createShutdownHandler({
  server,
  closeRuntime: runtime.close,
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
