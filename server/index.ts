import { serve } from "@hono/node-server";

import { createRuntime } from "./app.js";
import { loadLocalEnvironment } from "./config.js";

loadLocalEnvironment();
const runtime = createRuntime();
const server = serve({
  fetch: runtime.app.fetch,
  hostname: runtime.config.host,
  port: runtime.config.port,
});

console.info(
  `CardScope API listening on http://${runtime.config.host}:${runtime.config.port}`,
);

function shutdown(signal: NodeJS.Signals): void {
  console.info(`Received ${signal}; shutting down CardScope API`);
  server.close(() => {
    runtime.close();
    process.exitCode = 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
