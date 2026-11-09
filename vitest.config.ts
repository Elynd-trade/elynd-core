import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against the TypeScript sources of every workspace package (no build needed),
// except apps/mcp, whose end-to-end test spawns the built server (npm run build first).
export default defineConfig({
  resolve: {
    alias: {
      "@elynd/strategy": pkg("strategy"),
      "@elynd/indicators": pkg("indicators"),
      "@elynd/hyperliquid": pkg("hyperliquid"),
      "@elynd/risk": pkg("risk"),
      "@elynd/agenthub": pkg("agenthub"),
      "@elynd/runner": pkg("runner"),
      "@elynd/erc8004": pkg("erc8004"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
