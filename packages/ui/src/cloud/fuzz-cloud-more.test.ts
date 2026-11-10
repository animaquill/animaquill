import { describe, it } from "vitest";
import { fuzzCloud } from "./fuzz-support.ts";

/** More seeds of fuzz-cloud.test.ts, in a file of its own so that they run at the same time. */
describe("syncing with the platform, at random", () => {
  for (const seed of [4, 5, 6]) {
    it(`keeps every window and the platform in step, and loses nothing (seed ${seed})`, async () => {
      await fuzzCloud(seed);
    }, 60_000);
  }
});
