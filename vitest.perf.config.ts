import { configDefaults, defineConfig } from "vitest/config";
import { PERF, SERVER } from "./vitest.config.ts";

/** The tests that measure time, see vitest.config.ts. One at a time, so they do not slow each other. */
export default defineConfig({
  test: { include: [PERF], exclude: [...configDefaults.exclude, SERVER], fileParallelism: false },
});
