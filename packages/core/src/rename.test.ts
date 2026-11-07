import { createProject, type PropertyValue } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { factsTakenBack, type ClipFact } from "./draft.ts";
import { orderedTracks } from "./model.ts";
import { convertedValue, inverseOf, movesOf } from "./rename.ts";
import { ProjectStore } from "./store.ts";

const keys = (...values: number[]) => ({
  keys: values.map((value, index) => ({ time: String(index), value })),
});

function setup(properties: Readonly<Record<string, PropertyValue>> = {}) {
  const store = ProjectStore.create(createProject({ name: "改名" }));
  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const added = store.execute({
    type: "clip.add",
    params: {
      timeline: "main",
      track,
      clip: {
        id: "c",
        start: "0",
        duration: "5",
        source: { kind: "color", color: "#ff0000" },
        properties,
      },
    },
  });
  if (!added.ok) throw new Error(added.error.message);
  const rename = (...renames: readonly object[]) =>
    store.execute({ type: "property.rename", params: { timeline: "main", renames } });
  const propertiesNow = () => main().clips["c"]?.properties ?? {};
  return { store, main, track, rename, properties: propertiesNow };
}

const owner = { clip: "c" };

describe("the property.rename command", () => {
  it("moves keys to another path, in one step to undo", () => {
    const arm = keys(0, 35);
    const { store, rename, properties } = setup({ "object.arm.rotation": arm, opacity: 0.5 });
    const result = rename({ owner, from: "object.arm.rotation", to: "object.arm.angle" });
    expect(result.ok && result.results).toEqual([{ renamed: 1 }]);
    expect(properties()).toEqual({ "object.arm.angle": arm, opacity: 0.5 });
    expect(store.undo().ok).toBe(true);
    expect(properties()).toEqual({ "object.arm.rotation": arm, opacity: 0.5 });
    expect(store.redo().ok).toBe(true);
    expect(properties()).toEqual({ "object.arm.angle": arm, opacity: 0.5 });
  });

  it("moves everything under a path with .*", () => {
    const { rename, properties } = setup({
      "object.arm.x": 1,
      "object.arm.hand.y": keys(1, 2),
      "object.armchair.x": 3,
    });
    expect(rename({ owner, from: "object.arm.*", to: "object.arm_l.*" }).ok).toBe(true);
    expect(properties()).toEqual({
      "object.arm_l.x": 1,
      "object.arm_l.hand.y": keys(1, 2),
      "object.armchair.x": 3,
    });
  });

  it("changes the unit on the way, which undo takes back exactly", () => {
    const degrees = {
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
        { time: "1", value: 90, in: [0.58, 1] },
      ],
      modifiers: [{ type: "noise", amount: 2, seed: 7 }],
    } as PropertyValue;
    const { store, rename, properties } = setup({ "object.arm.r": degrees });
    const scale = Math.PI / 180;
    expect(rename({ owner, from: "object.arm.r", to: "object.arm.radians", scale }).ok).toBe(true);
    expect(properties()["object.arm.radians"]).toEqual({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
        { time: "1", value: Math.PI / 2, in: [0.58, 1] },
      ],
      modifiers: [{ type: "noise", amount: 2 * scale, seed: 7 }],
    });
    store.undo();
    expect(properties()["object.arm.r"]).toEqual(degrees);
  });

  it("can swap two properties, which nothing else may write over", () => {
    const { rename, properties } = setup({ "object.a.x": 1, "object.a.y": 2 });
    const swapped = rename(
      { owner, from: "object.a.x", to: "object.a.y" },
      { owner, from: "object.a.y", to: "object.a.x" },
    );
    expect(swapped.ok).toBe(true);
    expect(properties()).toEqual({ "object.a.x": 2, "object.a.y": 1 });
  });

  it.each([
    ["a path that is there", { from: "object.a.x", to: "object.a.y" }, "conflict"],
    ["nothing", { from: "object.nope.x", to: "object.a.z" }, "not-found"],
    ["nothing under a path", { from: "object.nope.*", to: "object.a.*" }, "not-found"],
    ["the same path", { from: "object.a.x", to: "object.a.x" }, "invalid-value"],
    ["a word to a number", { from: "object.a.t", to: "object.a.u", scale: 2 }, "invalid-value"],
    ["what no path can be", { from: "object.a.*", to: "object.__proto__.*" }, "invalid-params"],
    [
      "a value no built-in property can hold",
      { from: "object.a.t", to: "opacity" },
      "invalid-value",
    ],
  ])("does not go to %s", (_, rename, code) => {
    const { rename: run, properties } = setup({
      "object.a.x": 1,
      "object.a.y": 2,
      "object.a.t": "字",
    });
    const before = properties();
    const result = run({ owner, ...rename });
    expect(result.ok ? undefined : result.error.code).toBe(code);
    expect(properties()).toBe(before);
  });

  it("does not take two paths to one", () => {
    const { rename } = setup({ "object.a.x": 1, "object.b.x": 2 });
    const result = rename(
      { owner, from: "object.a.x", to: "object.c.x" },
      { owner, from: "object.b.x", to: "object.c.x" },
    );
    expect(result.ok ? undefined : result.error.code).toBe("invalid-value");
  });

  it("checks what it gets before it does anything", () => {
    const { rename } = setup({ "object.a.x": 1 });
    for (const params of [
      { owner, from: "object.a.*", to: "object.b.x" },
      { owner, from: "object.a.x", to: "object.b.x", scale: 0 },
      { owner, from: "object.a.x", to: "object.b.x", scale: Number.POSITIVE_INFINITY },
    ]) {
      expect(rename(params).ok).toBe(false);
    }
  });

  it("does not touch a clip on a locked track", () => {
    const { store, track, rename, properties } = setup({ "object.a.x": 1 });
    store.execute({
      type: "track.update",
      params: { timeline: "main", track, changes: { locked: true } },
    });
    const result = rename({ owner, from: "object.a.x", to: "object.b.x" });
    expect(result.ok ? undefined : result.error.code).toBe("track-locked");
    expect(properties()).toEqual({ "object.a.x": 1 });
  });

  it("says what it did, so that what is tried can go along, and back again", () => {
    const { store, rename } = setup({ "object.a.x": 1 });
    let facts: unknown;
    store.subscribe(() => (facts = store.change?.facts));
    rename({ owner, from: "object.a.x", to: "object.b.x", scale: 2, offset: 1 });
    expect(facts).toEqual([
      { kind: "renamed", clip: "c", from: "object.a.x", to: "object.b.x", scale: 2, offset: 1 },
    ]);
    expect(factsTakenBack(facts as readonly ClipFact[])).toEqual([
      {
        kind: "renamed",
        clip: "c",
        from: "object.b.x",
        to: "object.a.x",
        scale: 0.5,
        offset: -0.5,
      },
    ]);
  });
});

describe("a rename in the versions of a timeline", () => {
  it("takes what a version changes along, also when only the version has it", () => {
    const { store, main, rename, properties } = setup({ "object.a.x": 1 });
    const file = {
      scope: { format: "vertical" },
      clips: {
        c: {
          properties: {
            "object.a.x": { value: 5, base: 1 },
            "object.a.y": { value: 7 },
          },
        },
      },
    };
    const written = store.importFile(
      "timelines/main/overrides/format.vertical.json",
      JSON.stringify(file),
    );
    expect(written.ok).toBe(true);
    expect(rename({ owner, from: "object.a.*", to: "object.b.*", scale: 10 }).ok).toBe(true);
    expect(properties()).toEqual({ "object.b.x": 10 });
    expect(main().overrides["format.vertical"]?.clips?.["c"]?.properties).toEqual({
      "object.b.x": { value: 50, base: 10 },
      "object.b.y": { value: 70 },
    });
  });
});

describe("the paths of a rename", () => {
  it("are one path, or all of those under a path", () => {
    const paths = ["object.arm.x", "object.arm.hand.x", "object.armour.x", "object.arm"];
    expect(movesOf(paths, { from: "object.arm.x", to: "object.b.x" })).toEqual([
      ["object.arm.x", "object.b.x"],
    ]);
    expect(movesOf(paths, { from: "object.arm.*", to: "object.b.*" })).toEqual([
      ["object.arm.x", "object.b.x"],
      ["object.arm.hand.x", "object.b.hand.x"],
    ]);
    expect(movesOf(paths, { from: "object.leg.x", to: "object.b.x" })).toEqual([]);
  });

  it("change a unit and back", () => {
    const conversion = { scale: 4, offset: 3 };
    expect(convertedValue([1, 2], conversion)).toEqual([7, 11]);
    expect(convertedValue(convertedValue(5, conversion), inverseOf(conversion))).toBe(5);
    expect(convertedValue("字", {})).toBe("字");
  });
});
