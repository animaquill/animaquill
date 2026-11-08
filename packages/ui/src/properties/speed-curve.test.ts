import { describe, expect, it } from "vitest";
import { curveOfPreset, presetOf, withHandle, writtenCurve } from "./speed-curve.ts";

describe("the speed curve of a transition", () => {
  it("knows the presets by their numbers, also after a file wrote them", () => {
    expect(presetOf(undefined)).toBe("linear");
    expect(presetOf([0.42, 0, 1, 1])).toBe("easeIn");
    expect(presetOf([0, 0, 0.58, 1])).toBe("easeOut");
    expect(presetOf([0.42, 0, 0.58, 1])).toBe("easeInOut");
    expect(presetOf([0.4, 0, 0.58, 1])).toBeUndefined();
    expect(presetOf([0.3, 0.3, 0.6, 0.6])).toBe("linear");
    expect(curveOfPreset("linear")).toBeUndefined();
    expect(curveOfPreset("easeInOut")).toEqual([0.42, 0, 0.58, 1]);
  });

  it("moves one handle, and keeps it within the time and, without overshoot, within 0 and 1", () => {
    expect(withHandle([0.42, 0, 0.58, 1], 0, 0.25, 0.1, false)).toEqual([0.25, 0.1, 0.58, 1]);
    expect(withHandle([0.42, 0, 0.58, 1], 1, 1.4, 1.3, false)).toEqual([0.42, 0, 1, 1]);
    expect(withHandle([0.42, 0, 0.58, 1], 1, -0.2, -0.5, true)).toEqual([0.42, 0, 0, -0.5]);
    expect(withHandle(undefined, 0, 0.123456, 0.9, false)).toEqual([0.123, 0.9, 2 / 3, 2 / 3]);
  });

  it("writes nothing for a curve that is an even speed", () => {
    expect(writtenCurve([0.25, 0.25, 0.5, 0.5])).toBeUndefined();
    expect(writtenCurve([0.25, 0, 0.5, 0.5])).toEqual([0.25, 0, 0.5, 0.5]);
  });
});
