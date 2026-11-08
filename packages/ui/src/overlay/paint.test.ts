import { describe, expect, it } from "vitest";
import type { OverlaySnapshot } from "./editor.ts";
import type { Mark } from "./extension.ts";
import { paintOverlay } from "./paint.ts";

interface Call {
  readonly name: string;
  readonly args: readonly number[];
}

/** A canvas that only says what was drawn on it. */
function canvas(width: number, height: number) {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: number[]) =>
      calls.push({ name, args });
  const context = {
    canvas: { width, height },
    ...Object.fromEntries(
      [
        "beginPath",
        "moveTo",
        "lineTo",
        "arc",
        "closePath",
        "rect",
        "stroke",
        "fill",
        "setLineDash",
        "setTransform",
        "clearRect",
        "save",
        "restore",
        "translate",
        "rotate",
      ].map((name) => [name, record(name)]),
    ),
  };
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const theme = { line: "#00f", fill: "#fff", halo: "#000", path: "#fa0", muted: "#ccc" };

const draw = (...marks: Mark[]) => {
  const { context, calls } = canvas(960, 540);
  const snapshot: OverlaySnapshot = {
    scene: { marks, grips: [], bodies: [], target: undefined },
    hovered: undefined,
    dragging: undefined,
  };
  paintOverlay(context, theme, snapshot, 1);
  return calls;
};

const places = (calls: readonly Call[]) =>
  calls.filter(({ name }) => name === "moveTo" || name === "lineTo").map(({ args }) => args);

describe("drawing what is far larger than the picture", () => {
  it("draws only what shows of a ring of a million pixels, in a few steps", () => {
    const calls = draw({ kind: "ring", at: { x: 480, y: 1e6 + 300 }, radius: 1e6 });
    expect(calls.some(({ name, args }) => name === "arc" && (args[2] ?? 0) > 1e4)).toBe(false);
    const steps = places(calls);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.length).toBeLessThan(2000);
    for (const [x = 0, y = 0] of steps) {
      expect(Math.abs(x - 480)).toBeLessThan(1000);
      expect(Math.abs(y - 270)).toBeLessThan(1000);
    }
  });

  it("draws nothing of a ring away from the picture or all around it", () => {
    for (const ring of [
      { at: { x: 5000, y: 5000 }, radius: 100 },
      { at: { x: 480, y: 270 }, radius: 1e6 },
    ]) {
      const calls = draw({ kind: "ring", ...ring });
      expect(calls.filter(({ name }) => ["arc", "moveTo", "lineTo"].includes(name))).toEqual([]);
    }
  });

  it("draws a ring that is all on the picture as a ring", () => {
    const calls = draw({ kind: "ring", at: { x: 480, y: 270 }, radius: 50 });
    expect(calls.filter(({ name }) => name === "arc").map(({ args }) => args[2])).toEqual([50]);
  });

  it("cuts lines, boxes and paths down to the picture", () => {
    const far = [
      { x: -1e7, y: 100 },
      { x: 1e7, y: 400 },
    ];
    const box = [
      { x: -1e6, y: -1e6 },
      { x: 1e6, y: -1e6 },
      { x: 1e6, y: 300 },
      { x: -1e6, y: 300 },
    ];
    const calls = draw(
      { kind: "line", points: far, closed: false },
      { kind: "outline", clip: "c", corners: box, style: "target" },
      { kind: "bounds", corners: box },
      { kind: "path", points: far, frames: far },
      {
        kind: "stem",
        from: far[0] as { x: number; y: number },
        to: far[1] as { x: number; y: number },
      },
    );
    const steps = places(calls);
    expect(steps.length).toBeGreaterThan(0);
    for (const [x = 0, y = 0] of steps) {
      expect(x).toBeGreaterThanOrEqual(-20);
      expect(x).toBeLessThanOrEqual(980);
      expect(y).toBeGreaterThanOrEqual(-20);
      expect(y).toBeLessThanOrEqual(560);
    }
    expect(calls.filter(({ name }) => name === "arc")).toEqual([]);
  });
});
