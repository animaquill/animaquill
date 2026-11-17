import { compileChannel, sample, type Channel } from "@animaquill/core";
import type { Animation } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { traceCurve, type Place } from "./paint.ts";

/** What a curve drew, point by point, from a path that only writes down where it went. */
function traced(animation: Animation, left: number, right: number) {
  const channel = compileChannel(animation, "number") as Channel;
  const points: { x: number; y: number }[] = [];
  const path = {
    moveTo: (x: number, y: number) => points.push({ x, y }),
    lineTo: (x: number, y: number) => points.push({ x, y }),
    bezierCurveTo: () => {
      throw new Error("not a bezier");
    },
  } as unknown as Path2D;
  // 100 pixels a second, and a value is as high as it says.
  const place: Place = { x: (clock) => clock * 100, clockAt: (x) => x / 100, y: (value) => value };
  traceCurve(path, channel, place, left, right);
  return { channel, points };
}

const between = (from: object, more: object = {}): Animation => ({
  keys: [
    { time: "0", value: 0, ...from },
    { time: "1", value: 100 },
  ],
  ...more,
});

describe("the curve of a row", () => {
  it.each([
    ["bounces", { interp: "preset", preset: "bounceOut" }],
    ["swings", { interp: "preset", preset: "elasticOut" }],
    ["springs", { interp: "spring", spring: { stiffness: 300, damping: 8 } }],
  ])("%s the way it is worked out, point by point", (_, ease) => {
    const { channel, points } = traced(between(ease), 0, 100);
    const inside = points.filter(({ x }) => x > 0 && x < 100);
    expect(inside.length).toBeGreaterThan(40);
    for (const { x, y } of inside) expect(y).toBeCloseTo(sample(channel, x / 100) as number, 9);
    expect(points.at(-1)).toEqual({ x: 100, y: 100 });
  });

  it("overshoots where it swings past the next key", () => {
    const { points } = traced(between({ interp: "preset", preset: "elasticOut" }), 0, 100);
    expect(Math.max(...points.map(({ y }) => y))).toBeGreaterThan(110);
  });

  it("goes in steps, flat between them and straight up at them", () => {
    const steps = { interp: "preset", preset: "stepsEnd", presetParams: { steps: 4 } };
    const { points } = traced(between(steps), 0, 100);
    const levels = new Set(points.map(({ y }) => y));
    expect([...levels].toSorted((a, b) => a - b)).toEqual([0, 25, 50, 75, 100]);
    for (let index = 1; index < points.length; index += 1) {
      const [a, b] = [points[index - 1], points[index]] as [Point, Point];
      // Every line is level or upright.
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it("jumps where a spring has not come to rest by the next key", () => {
    const slow = { interp: "spring", spring: { stiffness: 1, damping: 0.5 } };
    const { points } = traced(between(slow), 0, 100);
    const end = points.filter(({ x }) => x === 100);
    expect(end.length).toBe(2);
    expect((end[0] as Point).y).toBeLessThan(80);
    expect((end[1] as Point).y).toBe(100);
  });

  it("shakes all the way when it has noise", () => {
    const shaking = between(
      {},
      { modifiers: [{ type: "noise", amount: 10, frequency: 3, seed: 2 }] },
    );
    const { channel, points } = traced(shaking, -50, 150);
    expect(points[0]?.x).toBe(-50);
    expect(points.at(-1)?.x).toBe(150);
    for (const { x, y } of points) expect(y).toBeCloseTo(sample(channel, x / 100) as number, 9);
    expect(points.some(({ x, y }) => x > 100 && y !== 100)).toBe(true);
  });
});

interface Point {
  readonly x: number;
  readonly y: number;
}
