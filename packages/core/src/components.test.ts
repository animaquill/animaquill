import type { Animation, Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  componentKeys,
  componentOf,
  componentSpecOf,
  componentsOf,
  keyWithComponent,
  withComponent,
} from "./components.ts";
import { sample } from "./curve.ts";
import { channelOf } from "./render-plan.ts";
import { rowsOf } from "./property-tree.ts";

const keys: Key[] = [
  { time: "1", value: [0, 100], interp: "bezier", out: [0.25, 0.1] },
  { time: "3", value: [200, 50], in: [0.75, 0.9] },
];

describe("parts of a vector", () => {
  it("are called what the description says, or else x, y, z and w", () => {
    expect(componentsOf({ type: "vec2" })).toEqual(["x", "y"]);
    expect(componentsOf({ type: "vec4" })).toEqual(["x", "y", "z", "w"]);
    expect(componentsOf({ type: "vec3", components: ["r", "g", "b"] })).toEqual(["r", "g", "b"]);
    expect(componentsOf({ type: "number" })).toEqual([]);
  });

  it("each have a row, also when the description does not name them", () => {
    const rows = rowsOf({ path: "p", type: "vec3" });
    expect(rows.map(({ component }) => component)).toEqual([
      undefined,
      { index: 0, name: "x" },
      { index: 1, name: "y" },
      { index: 2, name: "z" },
    ]);
    expect(rows.slice(1).every(({ curve }) => curve === "value")).toBe(true);
  });

  it("are numbers in the units and the range of the vector", () => {
    const spec = { path: "p", type: "vec2", unit: "world", min: 0, softMax: 10 } as const;
    expect(componentSpecOf(spec)).toEqual({
      path: "p",
      type: "number",
      unit: "world",
      min: 0,
      softMax: 10,
    });
    expect(componentSpecOf(spec)).toBe(componentSpecOf(spec));
  });

  it("have the keys of the vector, at the same times and with the same easing", () => {
    expect(componentKeys(keys, 1)).toEqual([
      { time: "1", value: 100, interp: "bezier", out: [0.25, 0.1] },
      { time: "3", value: 50, in: [0.75, 0.9] },
    ]);
    // Worked out once for the same keys.
    expect(componentKeys(keys, 1)).toBe(componentKeys(keys, 1));
    expect(componentKeys(keys, 2)).toBeUndefined();
    expect(componentKeys([{ time: "0", value: "#ffffff" }], 0)).toBeUndefined();
  });

  it("go the way the vector goes, each on its own curve", () => {
    const animation: Animation = { keys };
    const x = componentOf(animation, 0) as Animation;
    const y = componentOf(animation, 1) as Animation;
    expect(componentOf(animation, 1)).toBe(y);
    const whole = channelOf(animation, "vec2");
    const curveOfX = channelOf(x, "number");
    const curveOfY = channelOf(y, "number");
    if (!whole || !curveOfX || !curveOfY) throw new Error("no curve");
    for (const at of [1, 1.5, 2, 2.7, 3]) {
      const [atX, atY] = sample(whole, at) as number[];
      expect(sample(curveOfX, at)).toBeCloseTo(atX as number, 9);
      expect(sample(curveOfY, at)).toBeCloseTo(atY as number, 9);
    }
    expect(componentOf([3, 4], 1)).toBe(4);
    expect(componentOf([3, 4], 2)).toBeUndefined();
    expect(componentOf(5, 0)).toBeUndefined();
  });

  it("change one number of the vector, and nothing else", () => {
    expect(withComponent([1, 2, 3], 1, 20)).toEqual([1, 20, 3]);
    const key = keys[0] as Key;
    const part = componentKeys(keys, 1)?.[0] as Key;
    // Only the number of the part: the others stay as they are.
    expect(keyWithComponent(key, { ...part, value: 140 }, 1)).toEqual({
      ...key,
      value: [0, 140],
    });
    // Where it is and how it eases is the same for all of the parts.
    const handled = { ...part, time: "2", out: [0.5, 0.3] as [number, number], tangent: "aligned" };
    expect(keyWithComponent(key, handled as Key, 1)).toEqual({
      time: "2",
      value: [0, 100],
      interp: "bezier",
      out: [0.5, 0.3],
      tangent: "aligned",
    });
  });
});
