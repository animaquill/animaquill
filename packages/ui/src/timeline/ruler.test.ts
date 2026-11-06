import { describe, expect, it } from "vitest";
import { rulerSteps } from "./ruler.ts";

describe("ruler", () => {
  it("labels every frame when zoomed in all the way", () => {
    expect(rulerSteps(200, 30).major).toBe(1);
  });

  it("goes to seconds, minutes and hours as it zooms out", () => {
    expect(rulerSteps(4, 30).major).toBe(30);
    expect(rulerSteps(0.05, 30).major % 1800).toBe(0);
    expect(rulerSteps(0.0005, 30).major % 108_000).toBe(0);
  });

  it("keeps labels apart at every zoom level", () => {
    for (let pixels = 0.001; pixels < 500; pixels *= 1.3) {
      const { major } = rulerSteps(pixels, 30);
      expect(major * pixels).toBeGreaterThanOrEqual(110);
    }
  });

  it("makes ticks that divide the labels, and that do not turn into a band", () => {
    for (let pixels = 0.001; pixels < 500; pixels *= 1.3) {
      const { major, minor } = rulerSteps(pixels, 30);
      expect(major % minor).toBe(0);
      expect(minor * pixels).toBeGreaterThanOrEqual(7);
    }
  });

  it("works with frame rates that half a second does not divide", () => {
    for (const nominal of [24, 25, 30, 50, 60, 120]) {
      for (let pixels = 0.001; pixels < 500; pixels *= 1.7) {
        const { major, minor } = rulerSteps(pixels, nominal);
        expect(Number.isInteger(major)).toBe(true);
        expect(Number.isInteger(minor)).toBe(true);
      }
    }
  });

  it("never gets stuck on a very long timeline", () => {
    expect(rulerSteps(1e-9, 30).major).toBeGreaterThan(0);
  });
});
