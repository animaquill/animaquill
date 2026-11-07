import type { Animation, Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { compileChannel, sample } from "./curve.ts";
import { hasAutoTangents, withAutoTangents } from "./tangents.ts";

const auto = (time: string, value: number, extra: Partial<Key> = {}): Key => ({
  time,
  value,
  tangent: "auto",
  interp: "bezier",
  out: [0.5, 0.5],
  ...extra,
});

/** The value at many moments between two of them, as the curve works it out. */
function valuesBetween(animation: Animation, from: number, to: number): number[] {
  const channel = compileChannel(animation, "number");
  if (!channel) throw new Error("no channel");
  return Array.from({ length: 101 }, (_, step) => {
    const value = sample(channel, from + ((to - from) * step) / 100);
    return value as number;
  });
}

describe("automatic handles", () => {
  it("leave keys alone when none of them is automatic, and say so by being the same", () => {
    const keys: Animation = {
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.9, 0.1] },
        { time: "1", value: 10, tangent: "aligned" },
      ],
    };
    expect(withAutoTangents(keys)).toBe(keys);
    expect(hasAutoTangents(keys)).toBe(false);
    expect(hasAutoTangents(3)).toBe(false);
  });

  it("go smoothly through a key on the way up, without swinging past the keys around it", () => {
    const worked = withAutoTangents({
      keys: [auto("0", 0), auto("1", 10), auto("3", 30), auto("4", 31, { interp: undefined })],
    });
    const middle = worked.keys[1] as Key;
    // The same slope on either side: what comes in leaves the same way.
    const comingIn = ((1 - (middle.in?.[1] ?? 1)) * 10) / ((1 - (middle.in?.[0] ?? 1)) * 1);
    const goingOn = ((middle.out?.[1] ?? 0) * 20) / ((middle.out?.[0] ?? 0) * 2);
    expect(comingIn).toBeCloseTo(goingOn, 4);
    expect(goingOn).toBeGreaterThan(0);
    // It only goes up, and stays between its keys.
    const values = valuesBetween(worked, 0, 4);
    values.forEach((value, index) => {
      if (index > 0) expect(value).toBeGreaterThanOrEqual((values[index - 1] as number) - 1e-9);
    });
    expect(Math.max(...valuesBetween(worked, 1, 3))).toBeLessThanOrEqual(30 + 1e-9);
  });

  it("are flat on a peak, in a valley and at the ends", () => {
    const worked = withAutoTangents({
      keys: [auto("0", 0), auto("1", 10), auto("2", 5), auto("3", 8, { interp: undefined })],
    });
    const [first, peak, valley, last] = worked.keys as [Key, Key, Key, Key];
    expect(first.out).toEqual([0.333333, 0]);
    expect(peak.in).toEqual([0.666667, 1]);
    expect(peak.out).toEqual([0.333333, 0]);
    expect(valley.in).toEqual([0.666667, 1]);
    expect(valley.out).toEqual([0.333333, 0]);
    expect(last.in).toEqual([0.666667, 1]);
    expect(Math.max(...valuesBetween(worked, 0, 3))).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.min(...valuesBetween(worked, 1, 3))).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  it("only bend what is a bezier: a straight line and a hold stay what they are", () => {
    const keys: Animation = {
      keys: [
        { time: "0", value: 0 },
        auto("1", 10, { interp: "hold", out: undefined }),
        { time: "2", value: 20 },
      ],
    };
    const worked = withAutoTangents(keys);
    expect(worked).toBe(keys);
  });

  it("only change automatic keys, and what they work out stays as it is", () => {
    const worked = withAutoTangents({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.9, 0.9] },
        auto("1", 10),
        { time: "2", value: 20, in: [0.1, 0.1] },
      ],
    });
    expect(worked.keys[0]?.out).toEqual([0.9, 0.9]);
    expect(worked.keys[2]?.in).toEqual([0.1, 0.1]);
    expect(withAutoTangents(worked)).toBe(worked);
  });

  it("leave what is not numbers alone", () => {
    const words: Animation = {
      keys: [
        { time: "0", value: "a", tangent: "auto" },
        { time: "1", value: "b" },
      ],
    };
    expect(withAutoTangents(words)).toBe(words);
  });
});
