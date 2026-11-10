import { describe, it } from "vitest";
import { fuzzCloud } from "./fuzz-support.ts";

/** See fuzz-support.ts. A failure can be found again from its seed. */
describe("syncing with the platform, at random", () => {
  for (const seed of [1, 2, 3]) {
    it(`keeps every window and the platform in step, and loses nothing (seed ${seed})`, async () => {
      await fuzzCloud(seed);
    }, 60_000);
  }
});
