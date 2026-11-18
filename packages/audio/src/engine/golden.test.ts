import { describe, expect, it } from "vitest";
import fixture from "../../../schema/fixtures/mix/cases.json" with { type: "json" };
import { hashOfMix, mixOfCase, type MixCase } from "./test-support.ts";

/**
 * The sound of a few plans does not change behind anyone's back: the same engine gives the same
 * samples, by their hash (schema/fixtures/mix/cases.json).
 */
describe("the mix of the fixed plans", () => {
  for (const mixCase of fixture.cases as unknown as MixCase[]) {
    it(`is what it was: ${mixCase.name}`, async () => {
      const mix = mixOfCase(mixCase);
      const peak = Math.max(...mix.left.map(Math.abs), ...mix.right.map(Math.abs));
      expect(peak).toBeGreaterThan(0.1);
      expect(await hashOfMix(mix)).toBe(mixCase.sha256);
    });
  }
});
