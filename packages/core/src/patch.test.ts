import { describe, expect, it, vi } from "vitest";
import { Mutator, deepEqual, diff, getIn, settled } from "./patch.ts";
import { flatEntry, flatKey, isContainer, isFlat } from "./structure.ts";

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

describe("what not everything has", () => {
  const clip = ["timelines", "main", "clips", "c1"];
  const track = ["timelines", "main", "tracks", "t1"];

  it.each([
    [[...clip, "properties"]],
    [[...track, "properties"]],
    [["timelines", "main", "overrides", "language.en", "clips", "c1", "properties"]],
    [["assets"]],
    [["notes"]],
  ])("%j has no map of its own, so that two people cannot both make one", (path) => {
    expect(isFlat(path)).toBe(true);
  });

  it.each([
    [clip],
    [["manifest"]],
    [["timelines", "main", "clips"]],
    [[...clip, "properties", "opacity"]],
    [["files"]],
  ])("%j is what it always was", (path) => {
    expect(isFlat(path)).toBe(false);
  });

  it("finds its entries next to the fields of what has them", () => {
    expect(flatEntry(clip, flatKey("properties", "transform.x"))).toEqual([
      "properties",
      "transform.x",
    ]);
    expect(flatEntry([], flatKey("assets", "a"))).toEqual(["assets", "a"]);
  });

  it.each([
    [clip, "start"],
    [clip, "source/kind"],
    [["files"], "scenes/title/index.html"],
    [["locales", "en"], "properties/x"],
    [[...clip, "properties"], "properties/x"],
  ])("does not take %j %s for one", (path, key) => {
    expect(flatEntry(path, key)).toBeUndefined();
  });

  it("does not go by what every object inherits", () => {
    expect(isContainer(["timelines", "main", "clips", "constructor"])).toBe(true);
    expect(isFlat(["timelines", "main", "clips", "constructor", "properties"])).toBe(true);
    expect(isContainer(["constructor"])).toBe(false);
    expect(isContainer(["manifest", "constructor"])).toBe(false);
    expect(getIn({ a: {} }, ["a", "constructor"])).toBeUndefined();
  });

  it("is gone with its last entry, and only then", () => {
    const mutator = new Mutator({ c: { properties: { a: 1, b: 2 } } });
    const path = ["timelines", "main", "clips", "c1"];
    const state = new Mutator({
      timelines: { main: { clips: { c1: { properties: { a: 1, b: 2 } } } } },
    });
    state.delete([...path, "properties", "a"]);
    expect(getIn(state.root, [...path, "properties"])).toEqual({ b: 2 });
    state.delete([...path, "properties", "b"]);
    expect(getIn(state.root, path)).toEqual({});
    expect(mutator.root).toEqual({ c: { properties: { a: 1, b: 2 } } });
  });

  it("keeps count of what is left when entries come and go", () => {
    const owner = ["timelines", "main", "clips", "c"];
    const level = [...owner, "properties"];
    const mutator = new Mutator({
      timelines: { main: { clips: { c: { properties: { a: 1, b: 2 } } } } },
    });
    mutator.delete([...level, "a"]);
    mutator.set([...level, "c"], 3);
    mutator.set([...level, "b"], 4);
    mutator.delete([...level, "b"]);
    expect(getIn(mutator.root, level)).toEqual({ c: 3 });
    mutator.delete([...level, "nothing"]);
    expect(getIn(mutator.root, level)).toEqual({ c: 3 });
    mutator.delete([...level, "c"]);
    expect(getIn(mutator.root, owner)).toEqual({});
    mutator.set([...level, "d"], 5);
    expect(getIn(mutator.root, level)).toEqual({ d: 5 });
    mutator.delete([...level, "d"]);
    expect(getIn(mutator.root, owner)).toEqual({});
  });

  it("counts what a level holds only once, however many entries go", () => {
    const level = ["assets"];
    const assets = Object.fromEntries([...Array(50).keys()].map((index) => [`a${index}`, {}]));
    const mutator = new Mutator({ assets });
    const counting = vi.spyOn(Object, "keys");
    for (const id of Object.keys(assets)) mutator.delete([...level, id]);
    const counted = counting.mock.calls.length;
    counting.mockRestore();
    // One for the list above, one for the level.
    expect(counted).toBe(2);
    expect(mutator.root).toEqual({});
  });

  it("settles on what the document will hold", () => {
    expect(settled(clip, { start: "1", name: undefined, properties: {} })).toEqual({ start: "1" });
    expect(settled([...clip, "properties"], {})).toBeUndefined();
    expect(settled([...clip, "source"], { a: undefined })).toEqual({ a: undefined });
    expect(settled(clip, { properties: { opacity: 1 } })).toEqual({ properties: { opacity: 1 } });
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

  it("goes down into a level that comes or goes, which has nothing of its own", () => {
    const properties = [...clip, "properties"];
    expect(diff(properties, { opacity: 1, "transform.x": 2 }, undefined)).toEqual([
      { op: "delete", path: [...properties, "opacity"] },
      { op: "delete", path: [...properties, "transform.x"] },
    ]);
    expect(diff(properties, undefined, { opacity: 1 })).toEqual([
      { op: "set", path: [...properties, "opacity"], value: 1 },
    ]);
    expect(diff(["assets"], undefined, { a: { kind: "image" } })).toEqual([
      { op: "set", path: ["assets", "a"], value: { kind: "image" } },
    ]);
    expect(diff(["notes"], { n: { id: "n" } }, {})).toEqual([
      { op: "delete", path: ["notes", "n"] },
    ]);
  });

  it("does the same inside of what changes", () => {
    const before = { start: "1" };
    const after = { start: "1", properties: { opacity: 1 } };
    expect(diff(clip, before, after)).toEqual([
      { op: "set", path: [...clip, "properties", "opacity"], value: 1 },
    ]);
    expect(diff(clip, after, before)).toEqual([{ op: "delete", path: [...clip, "properties"] }]);
  });

  it("does not go by what every object inherits", () => {
    expect(diff(["assets"], { constructor: 1, other: 2 }, { other: 2 })).toEqual([
      { op: "delete", path: ["assets", "constructor"] },
    ]);
    const clips = ["timelines", "main", "clips"];
    expect(diff(clips, { valueOf: { id: "a" } }, {})).toEqual([
      { op: "delete", path: [...clips, "valueOf"] },
    ]);
    expect(diff(clip, {}, { constructor: "x" })).toEqual([
      { op: "set", path: [...clip, "constructor"], value: "x" },
    ]);
    expect(diff(clip, {}, { hasOwnProperty: undefined })).toEqual([]);
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

describe("deepEqual with names every object has", () => {
  it("does not take an inherited one for a key", () => {
    expect(deepEqual({ a: 1, constructor: Object }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ toString: Object.prototype.toString }, { other: 1 })).toBe(false);
    expect(deepEqual({ constructor: Object }, {})).toBe(false);
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
