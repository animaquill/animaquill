import { configDefaults, defineConfig } from "vitest/config";

/**
 * Tests that measure how long something takes are in `*.perf.test.ts`, and run on their own with
 * `pnpm test:perf`: on a busy machine they fail for no reason of their own, and they are slow.
 * CI runs them, see vitest.perf.config.ts.
 */
export const PERF = "packages/*/src/**/*.perf.test.{ts,tsx}";
/**
 * The server's tests run with its own settings, and with a database where there is one: `pnpm
 * test:server`, see packages/server/vitest.config.ts.
 */
export const SERVER = "packages/server/**";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, PERF, SERVER],
  },
});
