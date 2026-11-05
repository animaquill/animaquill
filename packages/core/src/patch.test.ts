import { describe, expect, it } from "vitest";
import { Mutator, deepEqual, diff, getIn } from "./patch.ts";
import { isContainer } from "./structure.ts";

describe("structure", () => {
  it.each([
    [["manifest"]],
    [["timelines", "main"]],
    [["timelines", "main", "clips", "c1"]],
    [["timelines", "main", "clips", "c1", "properties"]],
    [["timelines", "main", "overrides", "language.en", "clips", "c1", "properties"]],
    [["locales", "en"]],
  ])("%j is a map of its own", (path) => {
    expect(isContainer(path)).toBe(true);
  });

  it.each([
    [["manifest", "name"]],
    [["timelines", "main", "clips", "c1", "start"]],
    [["timelines", "main", "clips", "c1", "properties", "opacity"]],
    [["timelines", "main", "clips", "c1", "source"]],
    [["libraries"]],
  ])("%j is one value", (path) => {
    expect(isContainer(path)).toBe(false);
  });
});

describe("diff", () => {
  const clip = ["timelines", "main", "clips", "c1"];

  it("finds nothing when nothing changed", () => {
    expect(
      diff(
        clip,
        { start: "1", source: { kind: "color" } },
        { start: "1", source: { kind: "color" } },
      ),
    ).toEqual([]);
  });

  it("changes only the keys that changed", () => {
    expect(diff(clip, { start: "1", duration: "2" }, { start: "3", duration: "2" })).toEqual([
      { op: "set", path: [...clip, "start"], value: "3" },
    ]);
  });

  it("goes down into properties, so that two properties merge", () => {
    const before = { properties: { opacity: 1, "transform.x": 0 } };
    const after = { properties: { opacity: 0.5, "transform.x": 0 } };
    expect(diff(clip, before, after)).toEqual([
      { op: "set", path: [...clip, "properties", "opacity"], value: 0.5 },
    ]);
  });

  it("treats a value below the maps as one thing", () => {
    const before = { source: { kind: "scene", scene: "a" } };
    const after = { source: { kind: "scene", scene: "b" } };
    expect(diff(clip, before, after)).toEqual([
      { op: "set", path: [...clip, "source"], value: after.source },
    ]);
  });

  it("removes keys that went away", () => {
    expect(diff(clip, { a: 1, b: 2 }, { a: 1 })).toEqual([{ op: "delete", path: [...clip, "b"] }]);
  });

  it("removes a value that became undefined", () => {
    expect(diff([...clip, "name"], "x", undefined)).toEqual([
      { op: "delete", path: [...clip, "name"] },
    ]);
  });
});

describe("deepEqual", () => {
  it("compares by content", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
  });
});

describe("Mutator", () => {
  it("leaves the original alone", () => {
    const root = { a: { b: 1 } };
    const mutator = new Mutator(root);
    mutator.set(["a", "b"], 2);
    expect(root.a.b).toBe(1);
    expect(mutator.root.a.b).toBe(2);
  });

  it("shares what did not change, so the interface can skip it", () => {
    const root = { clips: { one: { x: 1 }, two: { x: 2 } } };
    const mutator = new Mutator(root);
    mutator.set(["clips", "one", "x"], 3);
    expect(mutator.root.clips.two).toBe(root.clips.two);
    expect(mutator.root.clips.one).not.toBe(root.clips.one);
  });

  it("copies each object once for many changes", () => {
    const root = { clips: { one: { x: 1 } } };
    const mutator = new Mutator(root);
    mutator.set(["clips", "one", "x"], 2);
    const first = mutator.root.clips;
    mutator.set(["clips", "one", "y"], 3);
    expect(mutator.root.clips).toBe(first);
  });

  it("creates what is missing", () => {
    const mutator = new Mutator<object>({});
    mutator.set(["a", "b", "c"], 1);
    expect(getIn(mutator.root, ["a", "b", "c"])).toBe(1);
  });

  it("deletes, and ignores what is not there", () => {
    const root = { a: { b: 1 } };
    const mutator = new Mutator(root);
    mutator.delete(["a", "b"]);
    mutator.delete(["x", "y"]);
    expect(mutator.root).toEqual({ a: {} });
    expect(root).toEqual({ a: { b: 1 } });
  });
});
