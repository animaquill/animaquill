import { describe, it } from "vitest";
import { fuzzMoves } from "./fuzz-support.ts";

/** Disconnecting and connecting again, at random, see `fuzzMoves`. */
describe("connecting to the platform and disconnecting again, at random", () => {
  for (const seed of [21, 22, 23]) {
    it(`leaves the last project of the platform with everything (seed ${seed})`, async () => {
      await fuzzMoves(seed);
    }, 60_000);
  }
});
