import type { PlannedEffect } from "@animaquill/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EFFECT_SIDE, effectInputSize } from "./size.ts";
import { temperatureGains } from "./temperature.ts";

/**
 * How the compositor runs effects: one after the other, each on what the one before made, with
 * canvases that only count what happens to them; and how large the picture is that they get.
 */

let runs: { type: string; input: unknown; canvas: unknown; values: unknown }[] = [];
let failing = "";

class FakeCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return new Proxy({}, { get: () => () => {}, set: () => true });
  }
}

vi.stubGlobal("OffscreenCanvas", FakeCanvas);
vi.mock("./built-in.ts", () => ({
  effectCodeOf: (type: string) =>
    type === "unknown"
      ? undefined
      : (aq: {
          canvas: unknown;
          render: (draw: (frame: Record<string, unknown>) => void) => void;
        }) =>
          aq.render((frame) => {
            if (type === failing) throw new Error("broken");
            runs.push({ type, input: frame["input"], canvas: aq.canvas, values: frame["values"] });
          }),
}));

const { EffectRunner } = await import("./run.ts");

afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  runs = [];
  failing = "";
});

const step = (id: string, type: string, values: Record<string, unknown> = {}) => ({
  effect: { id, type } as PlannedEffect,
  values,
});

describe("effects", () => {
  it("work one after the other, each on what the one before made", () => {
    const runner = new EffectRunner();
    const input = runner.input(100, 50);
    const made = runner.run(
      [step("a", "crop", { left: 0.5 }), step("b", "blur"), step("c", "blur")],
      input.canvas,
      { time: 0, pixelRatio: 1 },
    );
    expect(runs.map(({ type }) => type)).toEqual(["crop", "blur", "blur"]);
    expect(runs[0]?.input).toBe(input.canvas);
    expect(runs[1]?.input).toBe(runs[0]?.canvas);
    // The same kind twice takes two canvases, so that one does not draw over what it reads.
    expect(runs[2]?.input).toBe(runs[1]?.canvas);
    expect(runs[2]?.canvas).not.toBe(runs[1]?.canvas);
    expect(made.canvas).toBe(runs[2]?.canvas);
    expect(runs[0]?.values).toEqual({ left: 0.5 });
  });

  it("go without one that is not there or fails, and the picture goes on", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failing = "blur";
    const runner = new EffectRunner();
    const input = runner.input(10, 10);
    const made = runner.run(
      [step("a", "unknown"), step("b", "blur"), step("c", "crop")],
      input.canvas,
      {
        time: 0,
        pixelRatio: 1,
      },
    );
    expect(runs.map(({ type }) => type)).toEqual(["crop"]);
    expect(runs[0]?.input).toBe(input.canvas);
    expect(made.canvas).toBe(runs[0]?.canvas);
  });

  it("give the picture as it is with nothing to do", () => {
    const runner = new EffectRunner();
    const input = runner.input(10, 10);
    expect(runner.run([], input.canvas, { time: 0, pixelRatio: 1 }).canvas).toBe(input.canvas);
  });
});

describe("the picture that effects get", () => {
  const picture = { width: 1920, height: 1080 };

  it("is as large as the box is on the picture", () => {
    // A box of the stage, drawn a third as large, and turned: the turn changes nothing.
    const turn = Math.PI / 6;
    const scale = 1 / 3;
    const matrix = [Math.cos(turn) * scale, Math.sin(turn) * scale, 0, 0, 0, 0] as const;
    expect(effectInputSize(matrix, { width: 1920, height: 1080 }, picture)).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("gets fewer pixels for a box far larger than the picture, and never more than a canvas has", () => {
    const zoomed = effectInputSize([10, 0, 0, 10, 0, 0], { width: 1920, height: 1080 }, picture);
    expect(zoomed.width * zoomed.height).toBeLessThanOrEqual(4 * 1920 * 1080 + 4000);
    expect(zoomed.width / zoomed.height).toBeCloseTo(16 / 9, 2);
    const long = effectInputSize([1, 0, 0, 1, 0, 0], { width: 100_000, height: 10 }, picture);
    expect(long.width).toBeLessThanOrEqual(MAX_EFFECT_SIDE);
    expect(long.height).toBeGreaterThanOrEqual(1);
  });
});

describe("色温", () => {
  it("changes nothing at the middle, and warms with red and cools with blue", () => {
    expect(temperatureGains(0, 0)).toEqual([1, 1, 1]);
    expect(temperatureGains(1, 0)).toEqual([1.25, 1, 0.75]);
    expect(temperatureGains(-1, 0)).toEqual([0.75, 1, 1.25]);
    expect(temperatureGains(0, 1)).toEqual([1.125, 0.75, 1.125]);
    expect(temperatureGains(5, 0)).toEqual(temperatureGains(1, 0));
  });
});
