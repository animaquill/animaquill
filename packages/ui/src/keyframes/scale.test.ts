import { compileChannel, sample, type Channel } from "@animaquill/core";
import { BUILT_IN_PROPERTIES, type Animation, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { perPixel, rangeOfChannel, scaleOf, unionOf, valueIn, yIn } from "./scale.ts";

const X = BUILT_IN_PROPERTIES["transform.x"] as PropertySpec;
const OPACITY = BUILT_IN_PROPERTIES["opacity"] as PropertySpec;

const channel = (animation: Animation): Channel => {
  const compiled = compileChannel(animation, "number");
  if (!compiled) throw new Error("no channel");
  return compiled;
};

describe("where values go in a row", () => {
  it("puts the highest value at the top and the lowest at the bottom, with room for a key", () => {
    const scale = scaleOf({ min: 0, max: 300 }, X, 24);
    expect(scale.padding).toBe(7);
    expect(yIn(scale, 300)).toBe(7);
    expect(yIn(scale, 0)).toBe(17);
    expect(yIn(scale, 150)).toBe(12);
    // A taller row has more room, and somewhat more of it around.
    const tall = scaleOf({ min: 0, max: 300 }, X, 120);
    expect(tall.padding).toBe(12);
    expect(yIn(tall, 300)).toBe(12);
    expect(yIn(tall, 0)).toBe(108);
    expect(scaleOf({ min: 0, max: 1 }, X, 480).padding).toBe(16);
  });

  it("goes back from a height to a value, also past the row", () => {
    const scale = scaleOf({ min: -10, max: 10 }, X, 120);
    for (const value of [-10, -3, 0, 7.5, 10, 25, -40]) {
      expect(valueIn(scale, yIn(scale, value))).toBeCloseTo(value, 9);
    }
    expect(perPixel(scale)).toBeCloseTo(20 / 96, 9);
  });

  it("puts one value in the middle, with as much around it as its property goes through", () => {
    const flat = scaleOf({ min: 40, max: 40 }, X, 24);
    expect(yIn(flat, 40)).toBe(12);
    expect(flat.high - flat.low).toBe(1080);
    const share = scaleOf({ min: 0.5, max: 0.5 }, OPACITY, 24);
    expect(yIn(share, 0.5)).toBe(12);
    expect(share.high - share.low).toBe(1);
    const plain = scaleOf({ min: 3, max: 3 }, { path: "param.n", type: "number" }, 24);
    expect(plain.high - plain.low).toBe(6);
    expect(scaleOf({ min: 0, max: 0 }, { path: "param.n", type: "number" }, 24).high).toBe(1);
  });

  it("takes in what a drag held on to", () => {
    expect(unionOf({ min: 0, max: 10 }, { min: -5, max: 5 })).toEqual({ min: -5, max: 10 });
    expect(unionOf({ min: 0, max: 10 }, undefined)).toEqual({ min: 0, max: 10 });
  });
});

describe("what a row covers", () => {
  it("is its keys, and exactly where a bezier goes past them", () => {
    expect(
      rangeOfChannel(
        channel({
          keys: [
            { time: "0", value: 3 },
            { time: "1", value: -2 },
          ],
        }),
      ),
    ).toEqual({ min: -2, max: 3 });
    const overshoot = channel({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.34, 1.56] },
        { time: "1", value: 10, in: [0.64, 1] },
      ],
    });
    const range = rangeOfChannel(overshoot);
    // As high as the curve itself gets, which a fine look along it finds too.
    let highest = 0;
    for (let step = 0; step <= 10_000; step += 1) {
      highest = Math.max(highest, sample(overshoot, step / 10_000) as number);
    }
    expect(range?.max).toBeGreaterThan(10);
    expect(range?.max).toBeCloseTo(highest, 4);
    expect(range?.min).toBe(0);
  });

  it("is only the keys where they hold or go straight", () => {
    const range = rangeOfChannel(
      channel({
        keys: [
          { time: "0", value: 5, interp: "hold" },
          { time: "1", value: 1 },
          { time: "2", value: 9 },
        ],
      }),
    );
    expect(range).toEqual({ min: 1, max: 9 });
  });

  it("of one value is that value, and there is none for what is not a number", () => {
    expect(rangeOfChannel({ kind: "still", value: 4 })).toEqual({ min: 4, max: 4 });
    expect(rangeOfChannel({ kind: "still", value: "a" })).toBeUndefined();
  });
});
