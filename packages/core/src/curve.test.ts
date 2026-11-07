import { readFileSync } from "node:fs";
import type { Animation, Key, PropertyValue, Value, ValueType } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  MAX_SPLIT_Y,
  MIN_SPLIT_Y,
  VALUE_TYPES,
  bezierProgress,
  compileChannel,
  joinBezier,
  numberAt,
  sample,
  splitBezier,
  type Channel,
  type Handles,
} from "./curve.ts";

const compiled = (value: PropertyValue, type: ValueType = "number"): Channel => {
  const channel = compileChannel(value, type);
  if (!channel) throw new Error("no channel");
  return channel;
};

const at = (value: PropertyValue, clock: number, type: ValueType = "number") =>
  sample(compiled(value, type), clock);

const ramp: Animation = {
  keys: [
    { time: "1", value: 10 },
    { time: "3", value: 30 },
  ],
};

describe("a property without keys", () => {
  it.each<[ValueType, Value]>([
    ["number", 3],
    ["angle", 720],
    ["boolean", true],
    ["choice", "cover"],
    ["text", "标题"],
    ["asset", { asset: "a" }],
  ])("%s stays what it is at any time", (type, value) => {
    expect(at(value, -5, type)).toEqual(value);
    expect(at(value, 1000, type)).toEqual(value);
  });

  it("has no channel without a value", () => {
    expect(compileChannel(undefined, "number")).toBeUndefined();
  });
});

describe("linear keys", () => {
  it.each([
    ["before the first key", 0, 10],
    ["right on the first key", 1, 10],
    ["a quarter of the way", 1.5, 15],
    ["half way", 2, 20],
    ["right on the last key", 3, 30],
    ["after the last key", 9, 30],
  ])("%s", (_, clock, value) => {
    expect(at(ramp, clock)).toBeCloseTo(value, 9);
  });

  it("goes through every key", () => {
    const keys = [
      { time: "0", value: 0 },
      { time: "1", value: 100 },
      { time: "2", value: 50 },
    ];
    expect(at({ keys }, 0.5)).toBeCloseTo(50, 9);
    expect(at({ keys }, 1)).toBe(100);
    expect(at({ keys }, 1.5)).toBeCloseTo(75, 9);
  });

  it("works with times that have no decimal form", () => {
    const keys = [
      { time: "1/3", value: 0 },
      { time: "1001/1500", value: 100 },
    ];
    const first = 1 / 3;
    const last = 1001 / 1500;
    expect(at({ keys }, first)).toBe(0);
    expect(at({ keys }, last)).toBe(100);
    expect(at({ keys }, (first + last) / 2)).toBeCloseTo(50, 9);
  });

  it("reads the frames of a rate like 30000/1001 right", () => {
    const frame = (index: number) => (index * 1001) / 30_000;
    const keys = [
      { time: "1001/30000", value: 1 },
      { time: "1001/3000", value: 10 },
    ];
    expect(at({ keys }, frame(1))).toBe(1);
    expect(at({ keys }, frame(10))).toBe(10);
    expect(at({ keys }, frame(2))).toBeCloseTo(2, 9);
  });

  it("does not care what the last key says about going on", () => {
    const keys: Key[] = [
      { time: "0", value: 0 },
      { time: "1", value: 10, interp: "hold" },
    ];
    expect(at({ keys }, 0.5)).toBeCloseTo(5, 9);
    expect(at({ keys }, 1)).toBe(10);
  });

  it("a single key is a constant, whatever is around it", () => {
    const keys = [{ time: "1", value: 7 }];
    expect(at({ keys }, 0)).toBe(7);
    expect(at({ keys }, 1)).toBe(7);
    expect(at({ keys, before: "continue", after: "loop" }, 9)).toBe(7);
    expect(compiled({ keys })).toEqual({ kind: "still", value: 7 });
  });
});

describe("hold", () => {
  const steps: Animation = {
    keys: [
      { time: "0", value: 1, interp: "hold" },
      { time: "1", value: 2, interp: "hold" },
      { time: "2", value: 3 },
    ],
  };

  it.each([
    [0, 1],
    [0.999, 1],
    [1, 2],
    [1.5, 2],
    [2, 3],
  ])("at %d is %d", (clock, value) => {
    expect(at(steps, clock)).toBe(value);
  });

  const onFrames: Animation = {
    keys: [
      { time: "0", value: 0, interp: "hold" },
      { time: "1/3", value: 1 },
    ],
  };

  it.each([
    ["a little early", 1 / 3 - 5e-10],
    ["where floats put the frame", (1 / 30) * 10],
    ["a little late", 1 / 3 + 5e-10],
  ])("a key on a frame is not missed by a clock that is %s", (_, clock) => {
    expect(at(onFrames, clock)).toBe(1);
  });

  it("the frame before still has the value before", () => {
    expect(at(onFrames, (1 / 30) * 9)).toBe(0);
  });

  it("does not stretch that tolerance", () => {
    expect(at(onFrames, 1 / 3 - 1e-8)).toBe(0);
  });
});

describe("bezier", () => {
  const eased = (
    out: readonly [number, number],
    arrive?: readonly [number, number],
  ): Animation => ({
    keys: [
      { time: "0", value: 0, interp: "bezier", out: [...out] as [number, number] },
      { time: "1", value: 100, ...(arrive ? { in: [...arrive] as [number, number] } : {}) },
    ],
  });

  it.each([
    // What browsers give for the named curves of CSS.
    ["ease", [0.25, 0.1], [0.25, 1], 0.5, 80.24],
    ["ease-in", [0.42, 0], [1, 1], 0.5, 31.53],
    ["ease-out", [0, 0], [0.58, 1], 0.5, 68.47],
    ["ease-in-out", [0.42, 0], [0.58, 1], 0.5, 50],
    ["straight", [0.25, 0.25], [0.75, 0.75], 0.3, 30],
  ] as const)("%s is the curve of the same name in CSS", (_, out, arrive, clock, value) => {
    expect(at(eased(out, arrive), clock)).toBeCloseTo(value, 1);
  });

  it("takes the arriving handle from the next key, and without one that is 1, 1", () => {
    expect(at(eased([0.42, 0]), 0.5)).toBeCloseTo(at(eased([0.42, 0], [1, 1]), 0.5) as number, 9);
    expect(at(eased([0.42, 0], [0.58, 1]), 0.25)).not.toBeCloseTo(
      at(eased([0.42, 0]), 0.25) as number,
      1,
    );
  });

  it("can go past the next value", () => {
    const overshoot = eased([0.3, 1.8], [0.7, 1.8]);
    const peak = Math.max(
      ...[0.3, 0.4, 0.5, 0.6, 0.7].map((clock) => at(overshoot, clock) as number),
    );
    expect(peak).toBeGreaterThan(100);
  });

  it("starts and ends right on the keys", () => {
    const curve = eased([0.3, 1.8], [0.7, -0.8]);
    expect(at(curve, 0)).toBe(0);
    expect(at(curve, 1)).toBe(100);
  });

  describe("where time hardly moves along the curve", () => {
    const cubic = (first: number, second: number, s: number) =>
      3 * (1 - s) ** 2 * s * first + 3 * (1 - s) * s ** 2 * second + s ** 3;

    /** Slow and sure, to compare with. */
    function expected(x1: number, y1: number, x2: number, y2: number, time: number): number {
      let low = 0;
      let high = 1;
      for (let step = 0; step < 200; step += 1) {
        const middle = (low + high) / 2;
        if (cubic(x1, x2, middle) < time) low = middle;
        else high = middle;
      }
      return cubic(y1, y2, low);
    }

    // x stands still in the middle of this curve, so Newton is thrown far away from there.
    it.each([0.4999, 0.5001, 0.49, 0.51, 0.499999, 0.25, 0.75])("finds %d", (time) => {
      const found = bezierProgress(1, 0.2, 0, 0.8, time);
      expect(found).toBeCloseTo(expected(1, 0.2, 0, 0.8, time), 6);
    });

    it("stays between its ends, however Newton goes", () => {
      for (let time = 0.001; time < 1; time += 0.001) {
        const found = bezierProgress(1, 0, 0, 1, time);
        expect(found).toBeGreaterThanOrEqual(0);
        expect(found).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("cut where a key goes in", () => {
    const from = { time: 0, value: 0 };
    const to = { time: 2, value: 100 };
    const halves = (handles: Handles, time: number, value?: number) => {
      const curve = eased2(handles);
      const there = value ?? (at(curve, time) as number);
      return { curve, there, cut: splitBezier(from, to, handles, { time, value: there }) };
    };
    /** From 0 to 100 in two seconds. */
    const eased2 = ([x1, y1, x2, y2]: Handles): Animation => ({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [x1, y1] },
        { time: "2", value: 100, in: [x2, y2] },
      ],
    });
    const asKeys = (time: number, value: number, before: Handles, after: Handles): Animation => ({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [before[0], before[1]] },
        {
          time: String(time),
          value,
          interp: "bezier",
          in: [before[2], before[3]],
          out: [after[0], after[1]],
        },
        { time: "2", value: 100, in: [after[2], after[3]] },
      ],
    });

    it("keeps the curve with the value that is there", () => {
      const handles: Handles = [0.42, 0, 0.58, 1];
      const { curve, there, cut } = halves(handles, 0.7);
      if (!cut) throw new Error("not cut");
      const both = asKeys(0.7, there, cut.before, cut.after);
      for (let step = 0; step <= 40; step += 1) {
        expect(at(both, step / 20)).toBeCloseTo(at(curve, step / 20) as number, 7);
      }
    });

    it("bends it through another value, with what steers it from the keys that were there kept", () => {
      const handles: Handles = [0.42, 0, 0.58, 1];
      const { cut } = halves(handles, 0.7, 80);
      if (!cut) throw new Error("not cut");
      expect(at(asKeys(0.7, 80, cut.before, cut.after), 0.7)).toBeCloseTo(80, 9);
      const [, y1, , y2] = [...cut.before, ...cut.after];
      expect(y1).toBe(0);
      expect(y2).toBeLessThanOrEqual(MAX_SPLIT_Y);
      expect(cut.after[3]).toBe(1);
    });

    it("does not cut where a handle would have to reach further than easing goes", () => {
      // Where what overshoots goes past 100, the stretch after it hardly changes.
      const handles: Handles = [0.34, 1.56, 0.64, 1];
      expect(halves(handles, 2 / 3).cut).toBeUndefined();
      const { cut } = halves(handles, 1.6);
      if (!cut) throw new Error("not cut");
      for (const y of [cut.before[1], cut.before[3], cut.after[1], cut.after[3]]) {
        expect(y).toBeGreaterThanOrEqual(MIN_SPLIT_Y);
        expect(y).toBeLessThanOrEqual(MAX_SPLIT_Y);
      }
    });

    it("does not cut a stretch that stands still, or one that would", () => {
      const handles: Handles = [0.42, 0, 0.58, 1];
      expect(splitBezier(from, { time: 2, value: 0 }, handles, { time: 1, value: 5 })).toBe(
        undefined,
      );
      expect(splitBezier(from, to, handles, { time: 1, value: 0 })).toBeUndefined();
      expect(splitBezier(from, to, handles, { time: 1, value: 100 })).toBeUndefined();
    });

    it("joins what it cut back to what it was, digit for digit", () => {
      for (const handles of [
        [0.25, 0.1, 0.25, 1],
        [0.42, 0, 1, 1],
        [0, 0, 0.58, 1],
        [0.34, 1.56, 0.64, 1],
      ] satisfies Handles[]) {
        for (const time of [0.05, 0.3, 1, 1.6, 1.97]) {
          for (const value of [undefined, 12.5, 80]) {
            const { there, cut } = halves(handles, time, value);
            if (!cut) continue;
            const middle = { time, value: there };
            expect(joinBezier(from, middle, to, cut.before, cut.after)).toEqual(handles);
          }
        }
      }
    });

    it("does not join beziers that were not cut from one", () => {
      const middle = { time: 1, value: 50 };
      expect(joinBezier(from, middle, to, [0.42, 0, 0.58, 1], [0.42, 0, 0.58, 1])).toBeUndefined();
      const { there, cut } = halves([0.42, 0, 0.58, 1], 1);
      if (!cut) throw new Error("not cut");
      const moved = { time: 1, value: there + 3 };
      expect(joinBezier(from, moved, to, cut.before, cut.after)).toBeUndefined();
    });
  });

  it("does not read tangents, which are only for editing", () => {
    const { keys } = eased([0.42, 0], [0.58, 1]);
    const tangents = keys.map((key): Key => ({ ...key, tangent: "broken" }));
    expect(at({ keys: tangents }, 0.3)).toBe(at({ keys }, 0.3));
  });
});

describe("what is not worked out yet", () => {
  it("counts spring and preset as linear", () => {
    const spring: Key = {
      time: "0",
      value: 0,
      interp: "spring",
      spring: { stiffness: 100, damping: 10 },
    };
    const preset: Key = { time: "0", value: 0, interp: "preset", preset: "bounce" };
    const last = { time: "2", value: 10 };
    expect(at({ keys: [spring, last] }, 1)).toBeCloseTo(5, 9);
    expect(at({ keys: [preset, last] }, 1)).toBeCloseTo(5, 9);
  });

  it("leaves noise out", () => {
    const noisy: Animation = { ...ramp, modifiers: [{ type: "noise", amount: 5, seed: 1 }] };
    expect(at(noisy, 2)).toBe(at(ramp, 2));
    expect(at(noisy, 9)).toBe(at(ramp, 9));
  });
});

describe("going on before and after the keys", () => {
  const around = (mode: "hold" | "loop" | "pingpong" | "continue"): Animation => ({
    ...ramp,
    before: mode,
    after: mode,
  });

  it.each([
    ["hold", 0, 10],
    ["hold", -100, 10],
    ["hold", 4, 30],
    ["hold", 100, 30],

    // The period is from the first key to the last, here 2 seconds.
    ["loop", 3.5, 15],
    ["loop", 4, 20],
    ["loop", 5, 10],
    ["loop", 5.5, 15],
    ["loop", 7, 10],
    ["loop", 0.5, 25],
    ["loop", 0, 20],
    ["loop", -1, 10],
    ["loop", -1.5, 25],

    ["pingpong", 3.5, 25],
    ["pingpong", 4, 20],
    ["pingpong", 5, 10],
    ["pingpong", 5.5, 15],
    ["pingpong", 7, 30],
    ["pingpong", 0.5, 15],
    ["pingpong", 0, 20],
    ["pingpong", -1, 30],
    ["pingpong", -1.5, 25],

    ["continue", 4, 40],
    ["continue", 10, 100],
    ["continue", 0, 0],
    ["continue", -1, -10],
  ] as const)("%s at %d is %d", (mode, clock, value) => {
    expect(at(around(mode), clock)).toBeCloseTo(value, 9);
  });

  it("does not write hold, because that is what it does without being told", () => {
    expect(at(ramp, -3)).toBe(at(around("hold"), -3));
    expect(at(ramp, 30)).toBe(at(around("hold"), 30));
  });

  it("can do something else on each side", () => {
    const both: Animation = { ...ramp, before: "continue", after: "loop" };
    expect(at(both, 0)).toBeCloseTo(0, 9);
    expect(at(both, 4)).toBeCloseTo(20, 9);
  });

  it("goes around the whole shape of the keys, not only the ends", () => {
    const shape: Animation = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 10, interp: "hold" },
        { time: "2", value: 0 },
      ],
      after: "loop",
    };
    expect(at(shape, 2.5)).toBeCloseTo(5, 9);
    expect(at(shape, 3.5)).toBe(10);
  });

  it("the first key of a round is not missed on a frame", () => {
    // Ten frames at 29.97 are one round, and three rounds in floats do not come to frame 30.
    const frame = (index: number) => (index * 1001) / 30_000;
    const keys: Key[] = [
      { time: "0", value: 1, interp: "hold" },
      { time: "1001/3000", value: 2 },
    ];
    expect(at({ keys, after: "loop" }, frame(30))).toBe(1);
    expect(at({ keys, after: "loop" }, frame(29))).toBe(1);
    expect(at({ keys, after: "loop" }, frame(60))).toBe(1);
    expect(at({ keys, before: "loop" }, -frame(30))).toBe(1);
  });

  it("a round ends on the last key, and starts over right after it", () => {
    const loop: Animation = { ...ramp, after: "loop" };
    expect(at(loop, 3)).toBe(30);
    expect(at(loop, 3.000001)).toBeCloseTo(10.00001, 6);
    expect(at(loop, 4.999999)).toBeCloseTo(29.99999, 6);
    expect(at(loop, 5)).toBe(10);
    expect(at(loop, 7)).toBe(10);
  });

  it("a round going the other way ends on the first key", () => {
    const loop: Animation = { ...ramp, before: "loop" };
    expect(at(loop, 1)).toBe(10);
    expect(at(loop, 0.999999)).toBeCloseTo(29.99999, 6);
    expect(at(loop, -1)).toBe(10);
  });

  it("pingpong has no such step at its turning points", () => {
    const bounce: Animation = { ...ramp, after: "pingpong" };
    expect(at(bounce, 3)).toBe(30);
    expect(at(bounce, 3.000001)).toBeCloseTo(29.99999, 6);
    expect(at(bounce, 5)).toBe(10);
    expect(at(bounce, 7)).toBe(30);
  });

  it("goes on with the slope a bezier ends with", () => {
    const keys: Key[] = [
      { time: "0", value: 0, interp: "bezier", out: [0.5, 0] },
      { time: "1", value: 100, in: [0.5, 0] },
    ];
    // The handle points at the end from (0.5, 0): two units of progress per unit of time.
    expect(at({ keys, after: "continue" }, 2)).toBeCloseTo(300, 6);
    expect(at({ keys, before: "continue" }, -1)).toBeCloseTo(0, 6);
  });

  describe("with a handle right on a key", () => {
    const curve = (out: [number, number], arrive: [number, number]): Key[] => [
      { time: "0", value: 0, interp: "bezier", out },
      { time: "1", value: 100, in: arrive },
    ];

    it.each<[string, [number, number], [number, number], number]>([
      ["the handle says how steep it starts", [0.5, 1], [1, 1], 200],
      ["on the key, the other handle says so", [0, 0], [0.5, 1], 200],
      ["both on the key is a straight line", [0, 0], [0, 0], 100],
      ["straight up counts as flat", [0, 0.5], [1, 1], 0],
    ])("%s", (_, out, arrive, speed) => {
      const before = at({ keys: curve(out, arrive), before: "continue" }, -1) as number;
      expect(before).toBeCloseTo(-speed, 6);
    });

    it.each<[string, [number, number], [number, number], number]>([
      ["the handle says how steep it ends", [0, 0], [0.5, 0.5], 100],
      ["on the key, the other handle says so", [0.5, 0], [1, 1], 200],
      ["both on the key is a straight line", [1, 1], [1, 1], 100],
      ["straight up counts as flat", [0, 0], [1, 0.5], 0],
    ])("%s at the end", (_, out, arrive, speed) => {
      const after = at({ keys: curve(out, arrive), after: "continue" }, 2) as number;
      expect(after).toBeCloseTo(100 + speed, 6);
    });
  });

  it("goes on flat after a hold", () => {
    const keys: Key[] = [
      { time: "0", value: 0, interp: "hold" },
      { time: "1", value: 10 },
    ];
    expect(at({ keys, after: "continue" }, 3)).toBe(10);
    expect(at({ keys, before: "continue" }, -3)).toBe(0);
  });

  it.each<[ValueType, Value, Value]>([
    ["boolean", true, false],
    ["choice", "a", "b"],
    ["text", "一", "二"],
  ])("%s has no slope to go on with, so it holds", (type, first, last) => {
    const keys = [
      { time: "0", value: first },
      { time: "1", value: last },
    ];
    const animation: Animation = { keys, before: "continue", after: "continue" };
    expect(at(animation, 5, type)).toBe(last);
    expect(at(animation, -5, type)).toBe(first);
  });

  it("comes back to the same value on the same time, also when it loops", () => {
    const channel = compiled(around("loop"));
    const first = sample(channel, 5.25);
    sample(channel, -7);
    expect(sample(channel, 5.25)).toBe(first);
  });
});

describe("kinds of value", () => {
  it("turns an angle the long way, so that it can do several turns", () => {
    const keys = [
      { time: "0", value: 0 },
      { time: "2", value: 720 },
    ];
    expect(at({ keys }, 1, "angle")).toBeCloseTo(360, 9);
    expect(at({ keys }, 1.5, "angle")).toBeCloseTo(540, 9);
  });

  it("does not go the short way across 360 either", () => {
    const keys = [
      { time: "0", value: 350 },
      { time: "1", value: 10 },
    ];
    expect(at({ keys }, 0.5, "angle")).toBeCloseTo(180, 9);
  });

  it.each<[ValueType, Value, Value]>([
    ["boolean", false, true],
    ["choice", "contain", "cover"],
    ["text", "一", "二"],
    ["asset", { asset: "a" }, { asset: "b" }],
  ])("%s stays until the next key, whatever the key says about easing", (type, first, last) => {
    const keys: Key[] = [
      { time: "0", value: first, interp: "bezier", out: [0.5, 0.5] },
      { time: "1", value: last },
    ];
    expect(at({ keys }, 0, type)).toEqual(first);
    expect(at({ keys }, 0.99, type)).toEqual(first);
    expect(at({ keys }, 1, type)).toEqual(last);
  });

  it.each<[ValueType, PropertyValue]>([
    ["number", "12"],
    ["angle", true],
    ["boolean", 1],
    ["choice", 1],
    ["number", { keys: [{ time: "0", value: "12" }] }],
    [
      "number",
      {
        keys: [
          { time: "0", value: 1 },
          { time: "1", value: "12" },
        ],
      },
    ],
  ])("a %s that holds %j does nothing", (type, value) => {
    expect(compileChannel(value, type)).toBeUndefined();
  });

  it("has a rule for every type", () => {
    const types: readonly ValueType[] = [
      "number",
      "angle",
      "text",
      "choice",
      "boolean",
      "asset",
      "color",
      "vec2",
      "vec3",
      "vec4",
      "numbers",
    ];
    expect(Object.keys(VALUE_TYPES).toSorted()).toEqual(types.toSorted());
  });
});

describe("colors", () => {
  const between = (from: string, to: string): Animation => ({
    keys: [
      { time: "0", value: from },
      { time: "1", value: to },
    ],
  });

  it("are the keys themselves on the keys, as they were written", () => {
    const keys = between("#FF0000", "#0000ff");
    expect(at(keys, 0, "color")).toBe("#FF0000");
    expect(at(keys, 1, "color")).toBe("#0000ff");
  });

  it("go through Oklab, so that the middle of red and blue is not a dark grey", () => {
    const middle = at(between("#ff0000", "#0000ff"), 0.5, "color") as string;
    expect(middle).toMatch(/^#[0-9a-f]{6}$/);
    // Straight in sRGB this would be #800080. Oklab keeps it light.
    const [red, green, blue] = [1, 3, 5].map((from) =>
      Number.parseInt(middle.slice(from, from + 2), 16),
    );
    expect(red).toBeGreaterThan(128);
    expect(blue).toBeGreaterThan(128);
    expect(green).toBeLessThan(red as number);
  });

  it("change evenly between two greys, which Oklab keeps grey", () => {
    const grey = at(between("#000000", "#ffffff"), 0.5, "color") as string;
    expect(grey.slice(1, 3)).toBe(grey.slice(3, 5));
    expect(grey.slice(3, 5)).toBe(grey.slice(5, 7));
  });

  it("weigh what shows through, so that fading out keeps the color", () => {
    const fading = at(between("#ff000000", "#0000ffff"), 0.5, "color") as string;
    expect(fading).toMatch(/^#0000ff[0-9a-f]{2}$/);
    expect(Number.parseInt(fading.slice(7), 16)).toBe(128);
  });

  it("ease like anything else", () => {
    const keys: Animation = {
      keys: [
        { time: "0", value: "#000000", interp: "hold" },
        { time: "1", value: "#ffffff" },
      ],
    };
    expect(at(keys, 0.9, "color")).toBe("#000000");
  });

  it.each(["red", "#fff", "#12345", 12])("do nothing as %j", (value) => {
    expect(compileChannel(value as Value, "color")).toBeUndefined();
  });
});

describe("lists of numbers", () => {
  const keys: Animation = {
    keys: [
      { time: "0", value: [0, 10, -4] },
      { time: "2", value: [10, 30, 4] },
    ],
  };

  it("change each number with the same easing", () => {
    expect(at(keys, 1, "vec3")).toEqual([5, 20, 0]);
    expect(at(keys, 2, "vec3")).toEqual([10, 30, 4]);
  });

  it("hold when the lists are not as long as each other", () => {
    const uneven: Animation = {
      keys: [
        { time: "0", value: [1, 2] },
        { time: "2", value: [3, 4, 5] },
      ],
    };
    expect(at(uneven, 1, "numbers")).toEqual([1, 2]);
    expect(at(uneven, 2, "numbers")).toEqual([3, 4, 5]);
  });

  it("go on as they ended, not by their speed: going on is for numbers alone", () => {
    expect(at({ ...keys, after: "continue" }, 4, "vec3")).toEqual([10, 30, 4]);
  });

  it.each<[ValueType, Value]>([
    ["vec2", [1, 2, 3]],
    ["vec3", [1, 2]],
    ["vec2", [1, Number.NaN]],
    ["numbers", "1,2"],
  ])("a %s does nothing with %j", (type, value) => {
    expect(compileChannel(value, type)).toBeUndefined();
  });
});

describe("a channel", () => {
  const long: Animation = {
    keys: Array.from({ length: 100 }, (_, index) => ({ time: String(index), value: index * 2 })),
  };

  it("gives the same answers in any order, because where it was is only a shortcut", () => {
    const clocks = [50.5, 50.6, 51.5, 3.25, 99, 0, 98.5, 50.5];
    const fresh = clocks.map((clock) => at(long, clock));
    const channel = compiled(long);
    expect(clocks.map((clock) => sample(channel, clock))).toEqual(fresh);
  });

  it("gets past keys while playing forwards", () => {
    const channel = compiled(long);
    for (let clock = 0; clock < 99; clock += 1 / 7) {
      expect(sample(channel, clock)).toBeCloseTo(clock * 2, 9);
    }
  });

  it("can be sent to a sandbox as it is", () => {
    const channel = compiled({ ...ramp, after: "pingpong" });
    const copy = structuredClone(channel);
    expect(sample(copy, 3.5)).toBe(sample(channel, 3.5));
    expect(copy).toEqual(channel);
  });

  it("reads a number, or what stands in for one", () => {
    expect(numberAt(compiled(ramp), 2, 0)).toBeCloseTo(20, 9);
    expect(numberAt(undefined, 2, 7)).toBe(7);
    expect(numberAt(compiled("cover", "choice"), 2, 7)).toBe(7);
  });
});

describe("keys that cannot be", () => {
  const keys = (...times: readonly string[]): Animation => ({
    keys: times.map((time, value) => ({ time, value })),
  });

  it.each([
    ["out of order", keys("2", "1")],
    ["out of order in the middle", keys("0", "3", "2", "4")],
    ["with something that is no time", keys("0", "soon")],
    ["with a fraction of nothing", keys("0", "1/0")],
  ])("do nothing when they are %s", (_, value) => {
    expect(compileChannel(value, "number")).toBeUndefined();
  });

  it("two keys that floats cannot tell apart are no trouble", () => {
    const close = keys("1", "1.000000001", "1.0000000011", "2");
    expect(at(close, 1.5)).toBeGreaterThan(2);
    expect(at(close, 3)).toBe(3);
  });
});

describe("what goes into a sandbox", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const importsOf = (source: string) =>
    [...source.matchAll(/^import (?!type )[\s\S]*?from "([^"]+)"/gm)].map(([, from]) => from);

  it.each([
    ["curve.ts", ["@animaquill/schema/properties", "@animaquill/schema/time"]],
    ["view.ts", ["./curve.ts", "@animaquill/schema/properties"]],
  ])("%s only needs what does not bring in Yjs and Zod", (file, allowed) => {
    expect(importsOf(read(file)).toSorted()).toEqual(allowed);
  });

  it.each(["properties.ts", "time.ts"])("neither does %s of the schema", (file) => {
    expect(importsOf(read(`../../schema/src/${file}`))).toEqual([]);
  });
});
