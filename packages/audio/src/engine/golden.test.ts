import { describe, expect, it } from "vitest";
import fixture from "../../../schema/fixtures/mix/cases.json" with { type: "json" };
import { hashOfMix, mixOfCase, type MixCase } from "./test-support.ts";

/**
 * The sound of a few plans does not change behind anyone's back (schema/fixtures/mix/cases.json):
 * the same engine gives the same samples, by their hash. On another platform sums that nearly
 * cancel can come out otherwise in their last place, which changes the hash and is no change of
 * the sound: there the samples kept in the fixture have to come within -90 dBFS.
 */
const TOLERANCE = 10 ** (-90 / 20);

describe("the mix of the fixed plans", () => {
  for (const mixCase of fixture.cases as unknown as MixCase[]) {
    it(`is what it was: ${mixCase.name}`, async () => {
      const mix = mixOfCase(mixCase);
      const peak = Math.max(...mix.left.map(Math.abs), ...mix.right.map(Math.abs));
      expect(peak).toBeGreaterThan(0.1);
      if ((await hashOfMix(mix)) === mixCase.sha256) return;
      const { every, left, right } = mixCase.samples;
      let largest = 0;
      for (const [channel, kept] of [left, right].entries()) {
        const data = channel === 0 ? mix.left : mix.right;
        for (const [index, value] of kept.entries()) {
          largest = Math.max(largest, Math.abs((data[index * every] ?? Number.NaN) - value));
        }
      }
      console.warn(`${mixCase.name}: another hash here, the samples differ by ${largest} at most`);
      expect(largest).toBeLessThan(TOLERANCE);
    });
  }
});
