import { defineConfig } from "vitest/config";
import { PERF } from "./vitest.config.ts";

/** The tests that measure time, see vitest.config.ts. One at a time, so they do not slow each other. */
export default defineConfig({
  test: { include: [PERF], fileParallelism: false },
});
