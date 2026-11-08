import { describe, expect, it } from "vitest";
import { ClipValues, CodeObjects, SceneParams } from "./content.ts";

const ramp = (from: number, to: number) => ({
  keys: [
    { time: "0", value: from },
    { time: "2", value: to },
  ],
});

function setup(initial?: Record<string, unknown>) {
  const values = new ClipValues(initial);
  let now = 0;
  let changes = 0;
  const said: string[] = [];
  const report = (code: string, target?: string) => said.push(`${code} ${target ?? ""}`);
  const objects = new CodeObjects(
    values,
    () => now,
    () => (changes += 1),
  );
  return {
    values,
    objects,
    said,
    report,
    changes: () => changes,
    at: (seconds: number) => (now = seconds),
  };
}

describe("what the clip holds for a scene", () => {
  it("comes to a value of a type at a moment, as a curve", () => {
    const values = new ClipValues({ "object.a.x": ramp(0, 10) });
    expect(values.at("object.a.x", "number", 1)).toBe(5);
    expect(values.at("object.a.x", "color", 1)).toBeUndefined();
    expect(values.at("object.a.y", "number", 1)).toBeUndefined();
  });

  it("says what changed, and nothing for the same thing again", () => {
    const values = new ClipValues({ "object.a.x": 1 });
    const version = values.version;
    expect(values.change({ "object.a.x": 1 })).toEqual([]);
    expect(values.version).toBe(version);
    expect(values.change({ "object.a.x": 2, "object.a.y": null })).toEqual(["object.a.x"]);
    expect(values.at("object.a.x", "number", 0)).toBe(2);
    expect(values.change({ "object.a.x": null })).toEqual(["object.a.x"]);
    expect(values.has("object.a.x")).toBe(false);
    expect(values.version).toBeGreaterThan(version);
  });
});

describe("aq.object", () => {
  const arm = {
    name: "手臂",
    properties: {
      x: { type: "number", default: 3 },
      rotation: { type: "angle", default: 0 },
      tint: "#ffffff",
      at: [1, 2],
      shown: true,
    },
  };

  it("gives the defaults without keys, and one object for every call", () => {
    const { objects, report } = setup();
    const handle = objects.register("arm", arm, report);
    const first = handle.at(0);
    expect(first).toEqual({ x: 3, rotation: 0, tint: "#ffffff", at: [1, 2], shown: true });
    expect(handle.at(1)).toBe(first);
  });

  it("follows the keys of the clip, now or at a moment it is asked about", () => {
    const { objects, report, at } = setup({ "object.arm.rotation": ramp(0, 90) });
    const handle = objects.register("arm", arm, report);
    at(1);
    expect(handle.at().rotation).toBe(45);
    expect(handle.at(2).rotation).toBe(90);
  });

  it("reads keys from paths of before, until its own path has any", () => {
    const { objects, report, values } = setup({ "object.arm.angle": 30, "object.old.x": 7 });
    const handle = objects.register(
      "arm",
      {
        aliases: ["old"],
        properties: { rotation: { type: "angle", aliases: ["angle"] }, x: { type: "number" } },
      },
      report,
    );
    expect(handle.at(0)).toEqual({ rotation: 30, x: 7 });
    values.change({ "object.arm.rotation": 60 });
    expect(handle.at(0).rotation).toBe(60);
  });

  it("goes by the default for what holds another type, which the editor reports", () => {
    const { objects, report } = setup({ "object.arm.x": "far" });
    expect(objects.register("arm", arm, report).at(0).x).toBe(3);
  });

  it("is the same object for the same description, and says when there is a new one", () => {
    const { objects, report, changes } = setup();
    const one = objects.register("arm", arm, report);
    expect(objects.register("arm", structuredClone(arm), report)).toBe(one);
    expect(changes()).toBe(1);
    const other = objects.register("arm", { properties: { y: 1 } }, report);
    expect(other).not.toBe(one);
    expect(changes()).toBe(2);
    expect(objects.descriptors()).toEqual([
      { id: "arm", properties: [{ path: "y", type: "number", default: 1 }] },
    ]);
  });

  it("says what is wrong, and goes on with what it can", () => {
    const { objects, said, report } = setup({ "object.手臂.x": 5 });
    const handle = objects.register(
      "手臂",
      { properties: { x: 1, bad: { type: "nope" } } },
      report,
    );
    // The id comes first: until it is one, nothing of the object can be found again anyway.
    expect(said).toEqual(["object-id 手臂"]);
    expect(handle.at(0)).toEqual({ x: 1 });
    expect(objects.descriptors()).toEqual([]);
  });

  it("survives what code hands it, whatever that is", () => {
    const { objects, report } = setup();
    for (const options of [undefined, null, 5, "x", [], { properties: [1, 2] }]) {
      expect(() => objects.register("a", options, report).at(0)).not.toThrow();
    }
  });
});

describe("aq.param", () => {
  const declared = [
    { id: "title", type: "text", default: "你好" },
    { id: "size", type: "number", default: 64 },
  ] as const;

  function params(initial?: Record<string, unknown>) {
    const values = new ClipValues(initial);
    const said: string[] = [];
    let now = 0;
    let seenMore = 0;
    const read = new SceneParams(
      declared,
      values,
      () => now,
      (code, target) => said.push(`${code} ${target ?? ""}`),
      () => (seenMore += 1),
    );
    const seen = () => seenMore;
    return { values, said, read, seen, at: (seconds: number) => (now = seconds) };
  }

  it("is what the clip says, or the default", () => {
    const { read, at } = params({ "param.size": ramp(10, 30) });
    expect(read.read("title")).toBe("你好");
    at(1);
    expect(read.read("size")).toBe(20);
    expect(read.read("size", 2)).toBe(30);
  });

  it("remembers what the clip held for each one when code first read it, and says when there is more", () => {
    const { read, values, seen } = params({ "param.size": ramp(10, 30) });
    read.read("size");
    read.read("size", 2);
    expect(seen()).toBe(1);
    values.change({ "param.title": "新" });
    read.read("title");
    expect(seen()).toBe(2);
    expect(read.seen()).toEqual({ "param.size": ramp(10, 30), "param.title": "新" });
  });

  it("says once that a parameter is not declared", () => {
    const { read, said } = params();
    expect(read.read("nope")).toBeUndefined();
    read.read("nope");
    expect(said).toEqual(["missing-param nope"]);
  });

  it("says when a parameter that was only read while loading changes", () => {
    const { read, said, values } = params();
    read.read("title");
    read.read("size");
    read.loaded();
    read.read("size");
    read.changed(values.change({ "param.title": "新", "param.size": 1 }));
    read.changed(values.change({ "param.title": "再" }));
    expect(said).toEqual(["param-read-once title"]);
  });
});
