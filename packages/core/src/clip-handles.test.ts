import type { Animation } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  anchoredAt,
  anchorStops,
  cornersOf,
  isInside,
  motionPath,
  placementOf,
} from "./clip-handles.ts";
import type { Channel } from "./curve.ts";
import type { LayerSource, RenderLayer } from "./render-plan.ts";
import { matrixOf, transformPoint, type Point } from "./view.ts";

const stage = { width: 1920, height: 1080 };

const layer = (
  values: Readonly<Record<string, number>> = {},
  source: LayerSource = { kind: "color", color: "#ff0000" },
  extra: Partial<RenderLayer> = {},
): RenderLayer => ({
  id: "c",
  start: 0,
  end: 10,
  offset: 0,
  source,
  fit: "contain",
  channels: Object.fromEntries(
    Object.entries(values).map(([path, value]): [string, Channel] => [
      path,
      { kind: "still", value },
    ]),
  ),
  ...extra,
});

const image: LayerSource = { kind: "image", file: "f" };

const expectNear = (found: Point, wanted: Point, digits = 6) => {
  expect(found.x).toBeCloseTo(wanted.x, digits);
  expect(found.y).toBeCloseTo(wanted.y, digits);
};

describe("where a clip is", () => {
  it("is its box, as the compositor draws it", () => {
    const placed = placementOf(layer({ "transform.x": 100 }), 0, undefined, stage);
    expect(placed.box).toEqual(stage);
    expect(placed.picture).toEqual({ x: 0, y: 0, ...stage });
    expectNear(transformPoint(placed.matrix, { x: 960, y: 540 }), { x: 100, y: 0 });
  });

  it("knows the part of the box a contained picture covers", () => {
    const placed = placementOf(layer({}, image), 0, { width: 100, height: 100 }, stage);
    expect(placed.picture).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    const corners = cornersOf(placed.matrix, placed.picture);
    expectNear(corners[0] as Point, { x: -540, y: -540 });
    expectNear(corners[2] as Point, { x: 540, y: 540 });
  });

  it("takes the size of media from what the project knows, not for a color", () => {
    const fixed = { ...layer({}, image), fit: "fixed" as const };
    expect(placementOf(fixed, 0, { width: 300, height: 200 }, stage).box).toEqual({
      width: 300,
      height: 200,
    });
    const color = { ...layer(), fit: "fixed" as const };
    expect(placementOf(color, 0, { width: 300, height: 200 }, stage).box).toEqual(stage);
  });
});

describe("whether a point is on a clip", () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("is inside its corners, whichever way they go around", () => {
    expect(isInside(square, { x: 5, y: 5 })).toBe(true);
    expect(isInside(square.toReversed(), { x: 5, y: 5 })).toBe(true);
    expect(isInside(square, { x: 11, y: 5 })).toBe(false);
    expect(isInside(square, { x: -0.1, y: 5 })).toBe(false);
  });

  it("goes with how the clip turned", () => {
    const placed = placementOf(layer({ "transform.rotation": 45 }), 0, undefined, {
      width: 100,
      height: 100,
    });
    const corners = cornersOf(placed.matrix, placed.picture);
    expect(isInside(corners, { x: 0, y: 65 })).toBe(true);
    expect(isInside(corners, { x: 45, y: 45 })).toBe(false);
  });

  it("is never on a box of nothing", () => {
    const flat = [square[0], square[1], square[1], square[0]] as Point[];
    expect(isInside(flat, { x: 5, y: 0 })).toBe(false);
  });
});

describe("moving the anchor", () => {
  const cases: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
    ["of a clip as it is", {}],
    ["of a turned clip", { "transform.rotation": 30 }],
    ["of a scaled and turned clip", { "transform.scale": 0.4, "transform.rotation": -120 }],
    [
      "of one that was moved and has its anchor elsewhere",
      { "transform.x": -300, "transform.y": 80, "transform.anchorX": 0, "transform.anchorY": 1 },
    ],
    ["of a mirrored one", { "transform.scale": -2, "transform.rotation": 10 }],
  ];

  it.each(cases)("leaves the picture where it is, %s", (_, values) => {
    const placed = placementOf(layer(values, image), 0, { width: 400, height: 300 }, stage);
    const before = cornersOf(placed.matrix, placed.picture);
    for (const target of [
      { x: 0, y: 0 },
      { x: 250, y: -90 },
      { x: -2000, y: 3000 },
    ]) {
      const moved = anchoredAt(placed, target);
      if (!moved) throw new Error("no anchor");
      expect(moved.x).toBe(target.x);
      expect(moved.y).toBe(target.y);
      const after = cornersOf(
        matrixOf({ ...placed.transform, ...moved }, placed.box),
        placed.picture,
      );
      after.forEach((corner, index) => expectNear(corner, before[index] as Point));
    }
  });

  it("puts the anchor on the point as a share of the box, also outside of it", () => {
    const placed = placementOf(layer(), 0, undefined, stage);
    expect(anchoredAt(placed, { x: -960, y: -540 })).toEqual({
      anchorX: 0,
      anchorY: 0,
      x: -960,
      y: -540,
    });
    const outside = anchoredAt(placed, { x: 1920, y: 0 });
    expect(outside?.anchorX).toBeCloseTo(1.5, 9);
    expect(outside?.anchorY).toBeCloseTo(0.5, 9);
  });

  it("cannot be done on a box that shows nothing", () => {
    const flat = placementOf(layer({ "transform.scale": 0 }), 0, undefined, stage);
    expect(anchoredAt(flat, { x: 0, y: 0 })).toBeUndefined();
    const empty = placementOf(
      layer({ "transform.width": 0, "transform.height": 0 }),
      0,
      undefined,
      stage,
    );
    expect(anchoredAt(empty, { x: 0, y: 0 })).toBeUndefined();
  });

  it("stops at the corners, the middles of the sides and the middle of the picture", () => {
    const placed = placementOf(layer({}, image), 0, { width: 100, height: 100 }, stage);
    const stops = anchorStops(placed);
    expect(stops).toHaveLength(9);
    expectNear(stops[0] as Point, { x: -540, y: -540 });
    expectNear(stops[4] as Point, { x: 0, y: 0 });
    expectNear(stops[8] as Point, { x: 540, y: 540 });
  });
});

const keys = (...pairs: (readonly [string, number])[]): Animation => ({
  keys: pairs.map(([time, value]) => ({ time, value })),
});

describe("the path of a clip", () => {
  const shown = { from: 0, to: 10 };
  const origin = { x: 0, y: 0 };

  it("is nothing without keys on its position", () => {
    expect(motionPath(5, undefined, shown, 30, origin)).toBeUndefined();
  });

  it("goes where the anchor goes, as curve.ts works it out, from the first key to the last", () => {
    const x = keys(["1", -100], ["3", 100]);
    const y = keys(["2", 0], ["3", 50]);
    const path = motionPath(x, y, shown, 30, origin);
    if (!path) throw new Error("no path");
    expectNear(path.points[0] as Point, { x: -100, y: 0 });
    expectNear(path.points.at(-1) as Point, { x: 100, y: 50 });
    expect(path.keys).toEqual([
      { time: "1", clock: 1, hasX: true, hasY: false },
      { time: "2", clock: 2, hasX: false, hasY: true },
      { time: "3", clock: 3, hasX: true, hasY: true },
    ]);
    expect(path.keys.map(({ clock }) => path.at(clock))).toEqual([
      { x: -100, y: 0 },
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);
    expect(path.frames.length).toBe(61);
  });

  it("puts keys of both directions at one moment together, however they are written", () => {
    const path = motionPath(
      keys(["1/2", 0], ["2", 10]),
      keys(["0.5", 5], ["2", 7]),
      shown,
      30,
      origin,
    );
    expect(path?.keys.map(({ clock, hasX, hasY }) => [clock, hasX, hasY])).toEqual([
      [0.5, true, true],
      [2, true, true],
    ]);
  });

  it("only goes as far as the clip shows, and keeps a direction without keys where it is", () => {
    const path = motionPath(keys(["0", 0], ["10", 1000]), 40, { from: 2, to: 4 }, 25, origin);
    if (!path) throw new Error("no path");
    expectNear(path.points[0] as Point, { x: 200, y: 40 });
    expectNear(path.points.at(-1) as Point, { x: 400, y: 40 });
    expect(path.keys).toEqual([]);
  });

  it("takes more keys than a call can take arguments", () => {
    const count = 130000;
    const many: Animation = {
      keys: Array.from({ length: count }, (_, index) => ({
        time: String(index),
        value: index % 7,
      })),
    };
    const path = motionPath(many, undefined, { from: 0, to: count }, 30, origin);
    expect(path?.keys).toHaveLength(count);
    expect(path?.points.length).toBeLessThanOrEqual(4003);
  });

  it("does not take forever for a long clip", () => {
    const path = motionPath(
      keys(["0", 0], ["36000", 1000]),
      undefined,
      { from: 0, to: 36000 },
      60,
      origin,
    );
    expect(path?.points.length).toBeLessThanOrEqual(2003);
    expect(path?.frames.length).toBeLessThanOrEqual(601);
  });
});
