import { describe, expect, it } from "vitest";
import { compileChannel, type Channel, type Channels } from "./curve.ts";
import type { LayerSource, RenderLayer } from "./render-plan.ts";
import {
  boxOf,
  clockOf,
  fitIn,
  layerMatrix,
  multiply,
  opacityAt,
  stageOf,
  viewMatrix,
  type Matrix,
  type Size,
} from "./view.ts";

const still = (value: number): Channel => ({ kind: "still", value });

const color: LayerSource = { kind: "color", color: "#ff0000" };

const layer = (extra: Partial<RenderLayer> = {}): RenderLayer => ({
  id: "c",
  start: 0,
  end: 10,
  offset: 0,
  source: color,
  fit: "contain",
  fades: { in: 0, out: 0 },
  channels: {},
  ...extra,
});

const transformed = (values: Readonly<Record<string, number>>, extra?: Partial<RenderLayer>) =>
  layer({
    channels: Object.fromEntries(
      Object.entries(values).map(([path, value]) => [path, still(value)]),
    ),
    ...extra,
  });

const point = ([a, b, c, d, e, f]: Matrix, x: number, y: number): readonly [number, number] => [
  a * x + c * y + e,
  b * x + d * y + f,
];

const expectPoint = (found: readonly [number, number], x: number, y: number) => {
  expect(found[0]).toBeCloseTo(x, 6);
  expect(found[1]).toBeCloseTo(y, 6);
};

const FORMATS: readonly (readonly [string, Size, Size])[] = [
  ["1920×1080", { width: 1920, height: 1080 }, { width: 1920, height: 1080 }],
  ["3840×2160", { width: 3840, height: 2160 }, { width: 1920, height: 1080 }],
  ["1080×1920", { width: 1080, height: 1920 }, { width: 1080, height: 1920 }],
  ["1280×720", { width: 1280, height: 720 }, { width: 1920, height: 1080 }],
  ["1080×1080", { width: 1080, height: 1080 }, { width: 1080, height: 1080 }],
  ["2160×3840", { width: 2160, height: 3840 }, { width: 1080, height: 1920 }],
];

const view = (format: Size, camera: Channels = {}) => viewMatrix({ ...format, camera }, 0);

describe("the stage", () => {
  it.each(FORMATS)("of %s", (_, format, stage) => {
    expect(stageOf(format).width).toBeCloseTo(stage.width, 9);
    expect(stageOf(format).height).toBeCloseTo(stage.height, 9);
  });

  it("keeps the shape of an odd format", () => {
    const stage = stageOf({ width: 1001, height: 777 });
    expect(stage.height).toBeCloseTo(1080, 9);
    expect(stage.width / stage.height).toBeCloseTo(1001 / 777, 9);
  });
});

describe("the view", () => {
  it.each(FORMATS)("of %s puts the stage on the whole picture", (_, format) => {
    const stage = stageOf(format);
    const matrix = view(format);
    expectPoint(point(matrix, 0, 0), format.width / 2, format.height / 2);
    expectPoint(point(matrix, -stage.width / 2, -stage.height / 2), 0, 0);
    expectPoint(point(matrix, stage.width / 2, stage.height / 2), format.width, format.height);
  });

  it("is the same in both directions, so that nothing stretches", () => {
    const [a, b, c, d] = view({ width: 1080, height: 1920 });
    expect(a).toBe(d);
    expect(b).toBeCloseTo(0, 12);
    expect(c).toBeCloseTo(0, 12);
  });

  const format = { width: 1920, height: 1080 };

  it("follows a camera when one comes along, without anything else changing", () => {
    const moved = view(format, { "camera.x": still(100), "camera.y": still(50) });
    expectPoint(point(moved, 100, 50), 960, 540);
    const zoomed = view(format, { "camera.zoom": still(2) });
    expectPoint(point(zoomed, 100, 0), 1160, 540);
    const turned = view(format, { "camera.rotation": still(90) });
    // A camera turning clockwise sees the world turn the other way.
    expectPoint(point(turned, 100, 0), 960, 440);
    const both = view(format, { "camera.x": still(100), "camera.rotation": still(90) });
    expectPoint(point(both, 100, 0), 960, 540);
  });
});

describe("the clip box", () => {
  const stage = { width: 1920, height: 1080 };
  const natural = { width: 400, height: 300 };
  const sized = (values: Readonly<Record<string, number>>, fit: RenderLayer["fit"]) =>
    transformed(values, { fit });

  it.each(["contain", "cover"] as const)("without a size and with %s is the stage", (fit) => {
    expect(boxOf(layer({ fit }), 0, natural, stage)).toEqual(stage);
  });

  it("without a size and with fixed is the media, a pixel for a unit", () => {
    expect(boxOf(layer({ fit: "fixed" }), 0, natural, stage)).toEqual(natural);
  });

  it("without a size and without media is the stage, also with fixed", () => {
    expect(boxOf(layer({ fit: "fixed" }), 0, undefined, stage)).toEqual(stage);
  });

  it.each(["contain", "cover", "fixed"] as const)(
    "with one side and %s takes the other from the shape of the media",
    (fit) => {
      expect(boxOf(sized({ "transform.width": 200 }, fit), 0, natural, stage)).toEqual({
        width: 200,
        height: 150,
      });
      expect(boxOf(sized({ "transform.height": 150 }, fit), 0, natural, stage)).toEqual({
        width: 200,
        height: 150,
      });
    },
  );

  it("with one side and no media takes the other from the shape of the stage", () => {
    const box = boxOf(sized({ "transform.width": 960 }, "contain"), 0, undefined, stage);
    expect(box).toEqual({ width: 960, height: 540 });
  });

  it("with both sides is that", () => {
    const values = { "transform.width": 300, "transform.height": 100 };
    expect(boxOf(sized(values, "contain"), 0, natural, stage)).toEqual({ width: 300, height: 100 });
  });

  it("follows keys on its size, on the clock of the clip", () => {
    const width = compileChannel(
      {
        keys: [
          { time: "1", value: 100 },
          { time: "2", value: 200 },
        ],
      },
      "number",
    ) as Channel;
    const moving = layer({ start: 10, offset: 1, channels: { "transform.width": width } });
    expect(boxOf(moving, 10.5, natural, stage).width).toBeCloseTo(150, 9);
  });

  it("does not go below nothing when a curve does", () => {
    expect(boxOf(sized({ "transform.width": -5 }, "contain"), 0, natural, stage).width).toBe(0);
  });
});

describe("the media in its box", () => {
  const natural = { width: 300, height: 200 };
  const box = { width: 1920, height: 1080 };

  /** What drawing a picture on the whole canvas came down to before there was a world. */
  const placed = (scaleOf: (a: number, b: number) => number) => {
    const scale = scaleOf(box.width / natural.width, box.height / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
  };

  const corners = ({ matrix, source }: ReturnType<typeof fitIn>) => [
    point(matrix, source.x, source.y),
    point(matrix, source.x + source.width, source.y + source.height),
  ];

  it("contain shows all of it in the middle, as it always did", () => {
    const fitted = fitIn("contain", natural, box);
    const { x, y, width, height } = placed(Math.min);
    expect(fitted.source).toEqual({ x: 0, y: 0, ...natural });
    const [start, end] = corners(fitted);
    expectPoint(start as readonly [number, number], x, y);
    expectPoint(end as readonly [number, number], x + width, y + height);
  });

  it("cover fills the box, and leaves out what sticks out on both sides", () => {
    const fitted = fitIn("cover", natural, box);
    const [start, end] = corners(fitted);
    expectPoint(start as readonly [number, number], 0, 0);
    expectPoint(end as readonly [number, number], box.width, box.height);
    // What is left of the media ends up exactly where all of it would have.
    const { x, y } = placed(Math.max);
    expectPoint(point(fitted.matrix, 0, 0), x, y);
    expect(fitted.source.x).toBeCloseTo(0, 9);
    expect(fitted.source.y).toBeGreaterThan(0);
    expect(fitted.source.y * 2 + fitted.source.height).toBeCloseTo(natural.height, 9);
  });

  it("fixed fills the box and does not care about the shape", () => {
    const fitted = fitIn("fixed", natural, { width: 10, height: 500 });
    expect(fitted.source).toEqual({ x: 0, y: 0, ...natural });
    const [start, end] = corners(fitted);
    expectPoint(start as readonly [number, number], 0, 0);
    expectPoint(end as readonly [number, number], 10, 500);
  });

  it("does not distort with contain or cover", () => {
    for (const fit of ["contain", "cover"] as const) {
      const [a, , , d] = fitIn(fit, natural, box).matrix;
      expect(a).toBe(d);
    }
  });
});

describe("from the box to the world", () => {
  const box = { width: 200, height: 100 };

  it("puts the anchor at x and y, and the anchor is in the middle by itself", () => {
    const matrix = layerMatrix(transformed({ "transform.x": 300, "transform.y": -50 }), 0, box);
    expectPoint(point(matrix, 100, 50), 300, -50);
    expectPoint(point(matrix, 0, 0), 200, -100);
  });

  it("can take another point of the box as the anchor", () => {
    const corner = { "transform.anchorX": 0, "transform.anchorY": 1 };
    const matrix = layerMatrix(transformed(corner), 0, box);
    expectPoint(point(matrix, 0, 100), 0, 0);
    expectPoint(point(matrix, 200, 0), 200, -100);
  });

  it("scales around the anchor", () => {
    const matrix = layerMatrix(transformed({ "transform.scale": 2 }), 0, box);
    expectPoint(point(matrix, 100, 50), 0, 0);
    expectPoint(point(matrix, 200, 100), 200, 100);
  });

  it("turns clockwise around the anchor", () => {
    const matrix = layerMatrix(transformed({ "transform.rotation": 90 }), 0, box);
    expectPoint(point(matrix, 200, 50), 0, 100);
  });

  it("takes off the anchor, scales, turns, and only then moves", () => {
    const values = {
      "transform.x": 10,
      "transform.y": 20,
      "transform.scale": 3,
      "transform.rotation": 90,
      "transform.anchorX": 0,
      "transform.anchorY": 0,
    };
    const matrix = layerMatrix(transformed(values), 0, box);
    // 100 along x from the anchor: three times as far, turned to point down, from x and y.
    expectPoint(point(matrix, 100, 0), 10, 320);
  });

  it("reads keys on the clock of the clip, not on the timeline", () => {
    const x = compileChannel(
      {
        keys: [
          { time: "2", value: 0 },
          { time: "4", value: 100 },
        ],
      },
      "number",
    ) as Channel;
    const clip = layer({ start: 10, offset: 2, channels: { "transform.x": x } });
    expect(clockOf(clip, 11)).toBe(3);
    expectPoint(point(layerMatrix(clip, 11, box), 100, 50), 50, 0);
  });
});

describe("a 200 by 200 square", () => {
  const values = { "transform.width": 200, "transform.height": 200 };

  it.each([
    ["1920×1080", 1920, 1080, 200],
    ["3840×2160", 3840, 2160, 400],
    ["1080×1920", 1080, 1920, 200],
  ])("is square in %s, %d by %d, and %d pixels wide", (_, width, height, side) => {
    const format = { width, height };
    const square = transformed(values);
    const box = boxOf(square, 0, undefined, stageOf(format));
    const matrix = multiply(view(format), layerMatrix(square, 0, box));
    const [left, top] = point(matrix, 0, 0);
    const [right, bottom] = point(matrix, box.width, box.height);
    expect(right - left).toBeCloseTo(side, 6);
    expect(bottom - top).toBeCloseTo(side, 6);
    expect((left + right) / 2).toBeCloseTo(width / 2, 6);
    expect((top + bottom) / 2).toBeCloseTo(height / 2, 6);
  });
});

describe("how much of a layer shows", () => {
  const fading = (fades: RenderLayer["fades"], extra?: Partial<RenderLayer>) =>
    layer({ start: 10, end: 20, fades, ...extra });

  it("is its opacity", () => {
    expect(opacityAt(transformed({ opacity: 0.25 }), 5)).toBe(0.25);
  });

  it("is everything without one", () => {
    expect(opacityAt(layer(), 5)).toBe(1);
  });

  it("fades in from the start of the clip", () => {
    const clip = fading({ in: 2, out: 0 });
    expect(opacityAt(clip, 10)).toBe(0);
    expect(opacityAt(clip, 11)).toBeCloseTo(0.5, 9);
    expect(opacityAt(clip, 12)).toBe(1);
    expect(opacityAt(clip, 15)).toBe(1);
  });

  it("fades out towards its end", () => {
    const clip = fading({ in: 0, out: 2 });
    expect(opacityAt(clip, 15)).toBe(1);
    expect(opacityAt(clip, 18)).toBe(1);
    expect(opacityAt(clip, 19)).toBeCloseTo(0.5, 9);
    expect(opacityAt(clip, 20)).toBe(0);
  });

  it("multiplies its opacity with the fades, and the fades with each other", () => {
    const channels = { opacity: still(0.5) };
    expect(opacityAt(fading({ in: 2, out: 0 }, { channels }), 11)).toBeCloseTo(0.25, 9);
    expect(opacityAt(fading({ in: 10, out: 10 }), 15)).toBeCloseTo(0.25, 9);
  });

  it("stays between nothing and all of it when a curve overshoots, or Canvas ignores it", () => {
    expect(opacityAt(transformed({ opacity: 1.4 }), 0)).toBe(1);
    expect(opacityAt(transformed({ opacity: -0.2 }), 0)).toBe(0);
  });
});
