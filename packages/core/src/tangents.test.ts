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

  describe("of vectors, whose parts share their handles", () => {
    const vector = (time: string, value: number[], extra: Partial<Key> = {}): Key => ({
      ...auto(time, 0, extra),
      value,
    });
    const part = (animation: Animation, index: number): Animation => ({
      keys: animation.keys.map((key) => ({
        ...key,
        value: (key.value as number[])[index] as number,
      })),
    });

    it("come out as for a number when only one part moves", () => {
      const numbers = [0, 10, 30, 31];
      const times = ["0", "1", "3", "4"];
      const worked = withAutoTangents({
        keys: times.map((time, index) =>
          vector(time, [numbers[index] as number, 5], index === 3 ? { interp: undefined } : {}),
        ),
      });
      const alone = withAutoTangents({
        keys: times.map((time, index) =>
          auto(time, numbers[index] as number, index === 3 ? { interp: undefined } : {}),
        ),
      });
      worked.keys.forEach((key, index) => {
        expect(key.in).toEqual(alone.keys[index]?.in);
        expect(key.out).toEqual(alone.keys[index]?.out);
      });
      expect(worked.keys[1]?.out?.[1]).toBeGreaterThan(0);
    });

    it("are flat where every part has a peak or a valley", () => {
      const worked = withAutoTangents({
        keys: [
          vector("0", [0, 0]),
          vector("1", [10, -4]),
          vector("2", [5, 2], { interp: undefined }),
        ],
      });
      expect(worked.keys[1]?.in).toEqual([0.666667, 1]);
      expect(worked.keys[1]?.out).toEqual([0.333333, 0]);
    });

    it("go in between where the parts disagree, weighed by how far each goes", () => {
      // x turns around at the middle key, y goes on rising, and y goes further.
      const keys = [vector("0", [0, 0]), vector("1", [2, 10]), vector("2", [0, 20])];
      const worked = withAutoTangents({
        keys: [...keys.slice(0, 2), { ...(keys[2] as Key), interp: undefined }],
      });
      const rising = withAutoTangents({
        keys: [auto("0", 0), auto("1", 10), auto("2", 20, { interp: undefined })],
      });
      const out = worked.keys[1]?.out?.[1] as number;
      expect(out).toBeGreaterThan(0);
      expect(out).toBeLessThan(rising.keys[1]?.out?.[1] as number);
      // No part swings past the keys around it.
      for (const index of [0, 1]) {
        const values = valuesBetween(part(worked, index), 0, 2);
        const ends = part(worked, index).keys.map(({ value }) => value as number);
        expect(Math.max(...values)).toBeLessThanOrEqual(Math.max(...ends) + 1e-9);
        expect(Math.min(...values)).toBeGreaterThanOrEqual(Math.min(...ends) - 1e-9);
      }
    });

    it("leave vectors alone whose keys do not have the same parts", () => {
      const uneven: Animation = { keys: [vector("0", [0, 0]), vector("1", [1, 2, 3])] };
      expect(withAutoTangents(uneven)).toBe(uneven);
    });
  });
});
