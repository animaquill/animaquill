import { describe, expect, it } from "vitest";
import { compileChannel, type Channel, type Channels } from "./curve.ts";
import type { LayerSource, RenderLayer } from "./render-plan.ts";
import {
  boxOf,
  clockOf,
  fitIn,
  invert,
  layerMatrix,
  matrixOf,
  missingTransitionAt,
  multiply,
  opacityAt,
  pictureIn,
  progressAt,
  sceneMatrix,
  sceneViewOf,
  showsAt,
  shownAt,
  stageOf,
  transformAt,
  transformPoint,
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
  const FADE = { kind: "built-in", type: "fade" } as const;
  /** Fades in and out of a layer from 10 to 20, as long as these, as the plan has them. */
  const fading = (
    fades: { readonly in: number; readonly out: number },
    extra?: Partial<RenderLayer>,
  ) =>
    layer({
      start: 10,
      end: 20,
      ...(fades.in > 0 && {
        enter: { how: FADE, start: 10, end: 10 + fades.in, duration: fades.in },
      }),
      ...(fades.out > 0 && {
        exit: { how: FADE, start: 20 - fades.out, end: 20, duration: fades.out },
      }),
      ...extra,
    });

  it("is its opacity", () => {
    expect(opacityAt(transformed({ opacity: 0.25 }), 5)).toBe(0.25);
    expect(shownAt(transformed({ opacity: 0.25 }), 5)).toBe(0.25);
  });

  it("is everything without one", () => {
    expect(shownAt(layer(), 5)).toBe(1);
  });

  it("fades in from the start of the clip", () => {
    const clip = fading({ in: 2, out: 0 });
    expect(shownAt(clip, 10)).toBe(0);
    expect(shownAt(clip, 11)).toBeCloseTo(0.5, 9);
    expect(shownAt(clip, 12)).toBe(1);
    expect(shownAt(clip, 15)).toBe(1);
    // The opacity itself has nothing to do with the fade.
    expect(opacityAt(clip, 11)).toBe(1);
  });

  it("fades out towards its end", () => {
    const clip = fading({ in: 0, out: 2 });
    expect(shownAt(clip, 15)).toBe(1);
    expect(shownAt(clip, 18)).toBe(1);
    expect(shownAt(clip, 19)).toBeCloseTo(0.5, 9);
    expect(shownAt(clip, 20)).toBe(0);
  });

  it("multiplies its opacity with the fades, and the fades with each other", () => {
    const channels = { opacity: still(0.5) };
    expect(shownAt(fading({ in: 2, out: 0 }, { channels }), 11)).toBeCloseTo(0.25, 9);
    expect(shownAt(fading({ in: 10, out: 10 }), 15)).toBeCloseTo(0.25, 9);
  });

  it("is what fades always were, to the last bit", () => {
    /** How fades worked before they were transitions, as it was written then. */
    const before = (
      start: number,
      end: number,
      fades: { readonly in: number; readonly out: number },
      opacity: number,
      time: number,
    ) => {
      const fadeIn = fades.in > 0 ? Math.min(Math.max((time - start) / fades.in, 0), 1) : 1;
      const fadeOut = fades.out > 0 ? Math.min(Math.max((end - time) / fades.out, 0), 1) : 1;
      return Math.min(Math.max(opacity, 0), 1) * fadeIn * fadeOut;
    };
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 2000; round++) {
      const start = Math.floor(random() * 600) / 30 + 0.1;
      const end = start + 1 / 3 + Math.floor(random() * 300) / 30;
      const fades = { in: random() < 0.3 ? 0 : 0.1 + random() * 4, out: random() * 4 };
      const opacity = random() * 1.2;
      const time = start + (end - start) * random();
      const shown = layer({
        start,
        end,
        channels: { opacity: still(opacity) },
        ...(fades.in > 0 && {
          enter: { how: FADE, start, end: start + fades.in, duration: fades.in },
        }),
        ...(fades.out > 0 && {
          exit: { how: FADE, start: end - fades.out, end, duration: fades.out },
        }),
      });
      expect(shownAt(shown, time)).toBe(before(start, end, fades, opacity, time));
    }
  });

  it("goes by the speed curve of a transition, from 0 to 1 over its time", () => {
    const easeIn = [0.42, 0, 1, 1] as const;
    const enter = { how: FADE, start: 10, end: 12, duration: 2, curve: easeIn };
    expect(progressAt(enter, 9)).toBe(0);
    expect(progressAt(enter, 10)).toBe(0);
    expect(progressAt(enter, 11)).toBeCloseTo(0.315, 3);
    expect(progressAt(enter, 12)).toBe(1);
    expect(progressAt(enter, 13)).toBe(1);
    const exit = { how: FADE, start: 18, end: 20, duration: 2, curve: easeIn };
    expect(shownAt(layer({ start: 10, end: 20, exit }), 19)).toBeCloseTo(1 - 0.315, 3);
  });

  it("does not overshoot a fade, whatever the curve says", () => {
    const enter = {
      how: FADE,
      start: 0,
      end: 1,
      duration: 1,
      curve: [0.3, -0.8, 0.7, 1.8] as const,
    };
    for (let time = 0; time <= 1; time += 0.05) {
      expect(progressAt(enter, time)).toBeGreaterThanOrEqual(0);
      expect(progressAt(enter, time)).toBeLessThanOrEqual(1);
    }
  });

  it("knows a transition that this editor cannot do, while it goes on", () => {
    const exit = { how: FADE, start: 18, end: 20, duration: 2, missing: true as const };
    const shown = layer({ start: 10, end: 20, exit });
    expect(missingTransitionAt(shown, 17)).toBeUndefined();
    expect(missingTransitionAt(shown, 18)).toBe(exit);
    expect(missingTransitionAt(shown, 19.99)).toBe(exit);
    expect(missingTransitionAt(layer({ start: 10, end: 20 }), 19)).toBeUndefined();
  });

  it("stays between nothing and all of it when a curve overshoots, or Canvas ignores it", () => {
    expect(opacityAt(transformed({ opacity: 1.4 }), 0)).toBe(1);
    expect(opacityAt(transformed({ opacity: -0.2 }), 0)).toBe(0);
  });
});

describe("the way back", () => {
  it.each([
    ["a move", [1, 0, 0, 1, 30, -40]],
    ["a scale and a move", [2.5, 0, 0, 2.5, 960, 540]],
    ["a turn, a scale and a move", [0.3, 1.2, -1.2, 0.3, -7, 11]],
    ["a stretch", [0.5, 0, 0, 3, 1, 2]],
  ] as const)("undoes %s", (_, matrix) => {
    const back = invert(matrix) as Matrix;
    for (const place of [
      { x: 0, y: 0 },
      { x: 123.5, y: -77 },
      { x: -1e4, y: 3e3 },
    ]) {
      const there = transformPoint(back, transformPoint(matrix, place));
      expect(there.x).toBeCloseTo(place.x, 6);
      expect(there.y).toBeCloseTo(place.y, 6);
    }
    expect(multiply(matrix, back).map((n) => Number(n.toFixed(9)))).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("is not there for what squeezes everything onto a point or a line", () => {
    expect(invert([0, 0, 0, 0, 5, 5])).toBeUndefined();
    expect(invert([1, 2, 2, 4, 0, 0])).toBeUndefined();
    expect(invert([Number.NaN, 0, 0, 1, 0, 0])).toBeUndefined();
  });
});

describe("the transform of a layer", () => {
  it("has the defaults of the format where nothing is written", () => {
    expect(transformAt(layer(), 0)).toEqual({
      x: 0,
      y: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      scale: 1,
      rotation: 0,
    });
  });

  it("makes the same matrix the compositor draws with", () => {
    const values = {
      "transform.x": 10,
      "transform.y": 20,
      "transform.scale": 1.5,
      "transform.rotation": 33,
      "transform.anchorX": 0.2,
      "transform.anchorY": 0.9,
    };
    const box = { width: 300, height: 120 };
    const clip = transformed(values);
    expect(matrixOf(transformAt(clip, 0), box)).toEqual(layerMatrix(clip, 0, box));
  });
});

describe("a scene in its box", () => {
  it("lays itself out in its box where its clip starts", () => {
    const width = compileChannel(
      {
        keys: [
          { time: "0", value: 400 },
          { time: "2", value: 800 },
        ],
      },
      "number",
    ) as Channel;
    const clip = layer({
      start: 5,
      channels: { "transform.width": width, "transform.height": still(300) },
    });
    expect(sceneViewOf(clip, { width: 1920, height: 1080 })).toEqual({ width: 400, height: 300 });
  });

  it("gets some room also from a box of nothing", () => {
    const clip = transformed({ "transform.width": 0, "transform.height": 0 });
    expect(sceneViewOf(clip, { width: 1920, height: 1080 })).toEqual({ width: 1, height: 1 });
  });

  it("has its origin in the middle of its box, a unit for a pixel of its page", () => {
    const matrix = sceneMatrix({ width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    expect(transformPoint(matrix, { x: 0, y: 0 })).toEqual({ x: 960, y: 540 });
    expect(transformPoint(matrix, { x: -960, y: -540 })).toEqual({ x: 0, y: 0 });
  });

  it("stretches with a box that grew after it was laid out", () => {
    const matrix = sceneMatrix({ width: 400, height: 300 }, { width: 800, height: 300 });
    expect(transformPoint(matrix, { x: 100, y: 50 })).toEqual({ x: 600, y: 200 });
  });
});

describe("what part of a box has a picture", () => {
  const box = { width: 1920, height: 1080 };

  it("is all of it for what fills its box", () => {
    const whole = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(pictureIn("cover", { width: 100, height: 100 }, box)).toEqual(whole);
    expect(pictureIn("fixed", { width: 100, height: 100 }, box)).toEqual(whole);
    expect(pictureIn("contain", undefined, box)).toEqual(whole);
  });

  it("leaves out the bars of what is contained", () => {
    expect(pictureIn("contain", { width: 100, height: 100 }, box)).toEqual({
      x: 420,
      y: 0,
      width: 1080,
      height: 1080,
    });
    const tall = pictureIn("contain", { width: 3840, height: 1080 }, box);
    expect(tall.x).toBeCloseTo(0, 9);
    expect(tall.y).toBeCloseTo(270, 9);
    expect(tall.width).toBeCloseTo(1920, 9);
    expect(tall.height).toBeCloseTo(540, 9);
  });
});

describe("whether a layer shows", () => {
  const clip = layer({ start: 1, end: 2 });

  it("is from its start up to its end, which belongs to what comes next", () => {
    expect(showsAt(clip, 0.99)).toBe(false);
    expect(showsAt(clip, 1)).toBe(true);
    expect(showsAt(clip, 1.5)).toBe(true);
    expect(showsAt(clip, 2)).toBe(false);
  });

  it("counts a moment that lands a little off as the frame it is on", () => {
    expect(showsAt(clip, 1 - 1e-9)).toBe(true);
    expect(showsAt(clip, 2 - 1e-9)).toBe(false);
  });
});
