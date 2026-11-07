import type { ClipState } from "@animaquill/core";
import type { Animation } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { presetOf } from "./easing.ts";
import { KeySelection, NO_KEYS } from "./selection.ts";
import {
  KEY_EASED,
  KEY_HOLD,
  KEY_LINEAR,
  firstFrom,
  hasKeyAt,
  indexAt,
  keyTableOf,
  markFor,
  nearest,
  summaryOf,
} from "./tables.ts";

const animation: Animation = {
  keys: [
    { time: "1/3", value: 0 },
    { time: "1", value: 10, interp: "hold" },
    { time: "2", value: 20, interp: "bezier", out: [0.5, 2] },
    { time: "3", value: 30, interp: "spring", spring: { stiffness: 1, damping: 1 } },
  ],
};

const clip = (properties: object) =>
  ({
    id: "c",
    start: "0",
    duration: "5",
    track: "t",
    source: { kind: "color" },
    properties,
  }) as ClipState;

describe("a table of keys", () => {
  it("has moments as numbers, and shapes by how keys go on", () => {
    const { seconds, marks } = keyTableOf(animation);
    expect([...seconds]).toEqual([1 / 3, 1, 2, 3]);
    expect([...marks]).toEqual([KEY_LINEAR, KEY_HOLD, KEY_EASED, KEY_EASED]);
  });

  it("is made once for the same keys", () => {
    expect(keyTableOf(animation)).toBe(keyTableOf(animation));
  });

  it("what cannot change gradually only holds", () => {
    expect(markFor(KEY_EASED, "choice")).toBe(KEY_HOLD);
    expect(markFor(KEY_LINEAR, "boolean")).toBe(KEY_HOLD);
    expect(markFor(KEY_EASED, "number")).toBe(KEY_EASED);
  });

  it("finds moments", () => {
    const { seconds } = keyTableOf(animation);
    expect(firstFrom(seconds, 0)).toBe(0);
    expect(firstFrom(seconds, 1)).toBe(1);
    expect(firstFrom(seconds, 1.5)).toBe(2);
    expect(firstFrom(seconds, 9)).toBe(4);
    expect(indexAt(seconds, 1)).toBe(1);
    expect(indexAt(seconds, 1 + 1e-10)).toBe(1);
    expect(indexAt(seconds, 1.5)).toBe(-1);
    expect(nearest(seconds, 1.4)).toBe(1);
    expect(nearest(seconds, 1.6)).toBe(2);
    expect(nearest(seconds, -5)).toBe(0);
    expect(nearest(seconds, 50)).toBe(3);
    expect(nearest(new Float64Array(), 1)).toBe(-1);
  });

  it("knows keys by how they are written", () => {
    expect(hasKeyAt(animation, "1/3")).toBe(true);
    expect(hasKeyAt(animation, "0.5")).toBe(false);
  });
});

describe("a summary", () => {
  const properties = {
    "transform.x": {
      keys: [
        { time: "1", value: 1 },
        { time: "2", value: 2, interp: "hold" },
      ],
    },
    "transform.y": {
      keys: [
        { time: "1", value: 1, interp: "hold" },
        { time: "2", value: 2, interp: "hold" },
        { time: "3", value: 3 },
      ],
    },
    opacity: 0.5,
  };

  it("has each moment once, whatever is at it", () => {
    const paths = ["transform.x", "transform.y", "opacity", "transform.rotation"];
    const { seconds } = summaryOf(clip(properties), paths);
    expect([...seconds]).toEqual([1, 2, 3]);
  });

  it("shows a shape when all keys of a moment agree on it", () => {
    const { marks } = summaryOf(clip(properties), ["transform.x", "transform.y"]);
    expect([...marks]).toEqual([KEY_LINEAR, KEY_HOLD, KEY_LINEAR]);
  });

  it("is only about the properties it is asked for", () => {
    const { seconds } = summaryOf(clip(properties), ["transform.x"]);
    expect([...seconds]).toEqual([1, 2]);
  });

  it("is made once for a clip and its properties", () => {
    const one = clip(properties);
    const paths = ["transform.x"];
    expect(summaryOf(one, paths)).toBe(summaryOf(one, paths));
  });
});

describe("a preset", () => {
  it("is recognised by how a stretch starts and ends", () => {
    const next = { time: "1", value: 1, in: [0.58, 1] as [number, number] };
    const key = {
      time: "0",
      value: 0,
      interp: "bezier" as const,
      out: [0.42, 0] as [number, number],
    };
    expect(presetOf(key, next)).toBe("easeInOut");
    expect(presetOf(key, { time: "1", value: 1 })).toBe("easeIn");
    expect(presetOf({ time: "0", value: 0 }, next)).toBe("linear");
    expect(presetOf({ time: "0", value: 0, interp: "hold" }, next)).toBe("hold");
  });

  it("the end of the keys only has its start to go by", () => {
    const key = {
      time: "0",
      value: 0,
      interp: "bezier" as const,
      out: [0.42, 0] as [number, number],
    };
    expect(presetOf(key, undefined)).toBe("easeIn");
  });

  it("anything else is not one", () => {
    const key = {
      time: "0",
      value: 0,
      interp: "bezier" as const,
      out: [0.1, 0] as [number, number],
    };
    expect(presetOf(key, undefined)).toBeUndefined();
  });
});

describe("a selection", () => {
  const a = { clip: "a", path: "x", time: "1" };
  const b = { clip: "a", path: "x", time: "2" };
  const c = { clip: "b", path: "y", time: "1" };

  it("knows what is in it", () => {
    const selection = KeySelection.of([a, c, a]);
    expect(selection.size).toBe(2);
    expect(selection.has(a)).toBe(true);
    expect(selection.has(b)).toBe(false);
    expect(selection.hasClip("b")).toBe(true);
    expect(selection.hasClip("z")).toBe(false);
    expect([...(selection.timesOf("a", "x") ?? [])]).toEqual(["1"]);
    expect(selection.includes([a, c])).toBe(true);
    expect(selection.includes([a, b])).toBe(false);
  });

  it("makes new ones instead of changing", () => {
    const selection = KeySelection.of([a]);
    const more = selection.with([b]);
    expect(selection.size).toBe(1);
    expect(more.size).toBe(2);
    expect(more.without([a]).has(a)).toBe(false);
    expect([...more]).toEqual([a, b]);
  });

  it("stays the same object when all of it stays", () => {
    const selection = KeySelection.of([a, b]);
    expect(selection.keeping(() => true)).toBe(selection);
    expect(selection.keeping(({ time }) => time === "1").size).toBe(1);
  });

  it("starts out empty", () => {
    expect(NO_KEYS.size).toBe(0);
    expect([...NO_KEYS.channels()]).toEqual([]);
  });
});
