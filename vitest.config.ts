import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Vitest 4 bundles jsdom test files for the client environment, which
    // rejects Node built-ins such as `node:sqlite`; server tests run in Node.
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["tests/server/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          environment: "jsdom",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/server/**"],
        },
      },
    ],
  },
});
