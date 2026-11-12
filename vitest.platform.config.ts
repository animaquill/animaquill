import { configDefaults, defineConfig } from "vitest/config";
import { PERF } from "./vitest.config.ts";

/**
 * All tests, and every change they make to a project checked as a platform checks it: none may be
 * turned away, see packages/core/src/platform-check.setup.ts. Every command they give keeps to what
 * the registry says of it, see packages/core/src/declared.setup.ts. `pnpm test:platform`, and in
 * `check`.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      PERF,
      // It changes what the checks of the format say, for the time of a test.
      "packages/core/src/read-folder-guard.test.ts",
    ],
    setupFiles: [
      "packages/core/src/platform-check.setup.ts",
      "packages/core/src/declared.setup.ts",
    ],
  },
});
