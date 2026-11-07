import { createProject, type Animation, type PropertyValue } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { CommandError } from "./draft.ts";
import { orderedTracks } from "./model.ts";
import { applyEdit } from "./property-edit.ts";
import { ProjectStore, aiTask } from "./store.ts";

const keyed: Animation = {
  keys: [
    { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
    { time: "2", value: 20, in: [0.58, 1], interp: "hold" },
  ],
  after: "loop",
};

describe("applying an edit", () => {
  describe("write", () => {
    const write = (value: PropertyValue | undefined, time: string, to = 5) =>
      applyEdit(value, { op: "write", time, value: to });

    it("changes a plain value, whatever the time", () => {
      expect(write(1, "3")).toBe(5);
      expect(write(undefined, "3")).toBe(5);
    });

    it("writes a key with keys, between the ones that are there", () => {
      const after = write(keyed, "1") as Animation;
      expect(after.keys.map(({ time }) => time)).toEqual(["0", "1", "2"]);
      expect(after.keys[1]).toEqual({ time: "1", value: 5 });
    });

    it("writes a key before the first one and after the last one", () => {
      expect((write(keyed, "3") as Animation).keys.at(-1)).toEqual({ time: "3", value: 5 });
      const late: Animation = { keys: [{ time: "1", value: 1 }] };
      expect((write(late, "0") as Animation).keys[0]).toEqual({ time: "0", value: 5 });
    });

    it("a new key is linear and has no handles", () => {
      const key = (write(keyed, "1") as Animation).keys[1];
      expect(key?.interp).toBeUndefined();
      expect(key?.out).toBeUndefined();
      expect(key?.in).toBeUndefined();
    });

    it("changes only the value of a key that is there", () => {
      expect((write(keyed, "0") as Animation).keys[0]).toEqual({
        time: "0",
        value: 5,
        interp: "bezier",
        out: [0.42, 0],
      });
      expect((write(keyed, "2") as Animation).keys[1]).toEqual({
        time: "2",
        value: 5,
        in: [0.58, 1],
        interp: "hold",
      });
    });

    it("knows the same moment in another spelling", () => {
      const thirds: Animation = { keys: [{ time: "1/3", value: 1 }] };
      expect((write(thirds, "2/6") as Animation).keys).toEqual([{ time: "1/3", value: 5 }]);
    });

    it("keeps moments apart that only look alike as floats", () => {
      const thirds: Animation = { keys: [{ time: "1/3", value: 1 }] };
      const after = write(thirds, "0.333333333") as Animation;
      expect(after.keys).toHaveLength(2);
      expect(after.keys[0]?.time).toBe("0.333333333");
    });

    it("keeps how a curve goes on around its keys", () => {
      expect(write(keyed, "1")).toMatchObject({ after: "loop" });
    });

    it("leaves the value it got as it is", () => {
      const before = structuredClone(keyed);
      write(keyed, "1");
      write(keyed, "0");
      expect(keyed).toEqual(before);
    });
  });

  describe("setKey", () => {
    const setKey = (value: PropertyValue | undefined, time: string) =>
      applyEdit(value, { op: "setKey", time, value: 5 });

    it("starts keys on a plain value and on none", () => {
      expect(setKey(1, "2")).toEqual({ keys: [{ time: "2", value: 5 }] });
      expect(setKey(undefined, "2")).toEqual({ keys: [{ time: "2", value: 5 }] });
    });

    it("adds to keys that are there", () => {
      expect((setKey(keyed, "1") as Animation).keys).toHaveLength(3);
    });

    it("changes only the value of a key that is there", () => {
      expect((setKey(keyed, "0") as Animation).keys[0]).toMatchObject({
        value: 5,
        interp: "bezier",
        out: [0.42, 0],
      });
    });
  });

  describe("removeKey", () => {
    const removeKey = (value: PropertyValue | undefined, time: string) =>
      applyEdit(value, { op: "removeKey", time });

    it("takes one away and leaves the others as they are", () => {
      expect(removeKey(keyed, "0")).toEqual({ keys: [keyed.keys[1]], after: "loop" });
    });

    it("the last one leaves its value behind", () => {
      expect(removeKey({ keys: [{ time: "1", value: 7 }] }, "1")).toBe(7);
    });

    it("finds a key by its moment, not its spelling", () => {
      expect(removeKey({ keys: [{ time: "1/2", value: 7 }] }, "0.5")).toBe(7);
    });

    it.each<[string, PropertyValue | undefined]>([
      ["a moment without a key", keyed],
      ["a plain value", 3],
      ["nothing", undefined],
    ])("fails for %s", (_, value) => {
      expect(() => removeKey(value, "1")).toThrow(CommandError);
    });
  });

  it("set replaces everything, and clear leaves nothing", () => {
    expect(applyEdit(keyed, { op: "set", value: 3 })).toBe(3);
    expect(applyEdit(3, { op: "set", value: keyed })).toBe(keyed);
    expect(applyEdit(keyed, { op: "clear" })).toBeUndefined();
  });
});

function setup() {
  const store = ProjectStore.create(createProject({ name: "属性" }));
  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(result.error.message);
    return result;
  };
  const addClip = (id: string, start = "0") =>
    run("clip.add", {
      timeline: "main",
      track,
      clip: { id, start, duration: "5", source: { kind: "color", color: "#ff0000" } },
    });
  addClip("c");
  const owner = { clip: "c" };
  const edit = (...edits: readonly object[]) =>
    store.execute({ type: "property.edit", params: { timeline: "main", edits } });
  const value = (path: string, clip = "c") => main().clips[clip]?.properties?.[path];
  const failure = (result: ReturnType<typeof edit>) => {
    if (result.ok) throw new Error("it went through");
    return result.error;
  };
  return { store, main, track, run, addClip, owner, edit, value, failure };
}

describe("the property.edit command", () => {
  it("does all five things", () => {
    const { edit, value, owner } = setup();
    const x = { owner, path: "transform.x" };
    expect(edit({ ...x, op: "write", time: "1", value: 10 }).ok).toBe(true);
    expect(value("transform.x")).toBe(10);
    edit({ ...x, op: "setKey", time: "1", value: 20 });
    expect(value("transform.x")).toEqual({ keys: [{ time: "1", value: 20 }] });
    edit({ ...x, op: "write", time: "1/3", value: 30 });
    expect(value("transform.x")).toEqual({
      keys: [
        { time: "1/3", value: 30 },
        { time: "1", value: 20 },
      ],
    });
    edit({ ...x, op: "removeKey", time: "1/3" });
    edit({ ...x, op: "removeKey", time: "1" });
    expect(value("transform.x")).toBe(20);
    edit({ ...x, op: "set", value: 40 });
    expect(value("transform.x")).toBe(40);
    edit({ ...x, op: "clear" });
    expect(value("transform.x")).toBeUndefined();
  });

  it("is one step to undo, however much it changes", () => {
    const { store, edit, value, owner, addClip } = setup();
    addClip("d", "6");
    edit(
      { owner, path: "transform.x", op: "set", value: 10 },
      { owner, path: "opacity", op: "setKey", time: "0", value: 0 },
      { owner, path: "opacity", op: "setKey", time: "1", value: 1 },
      { owner: { clip: "d" }, path: "transform.y", op: "set", value: 5 },
    );
    expect(value("opacity")).toMatchObject({ keys: [{ time: "0" }, { time: "1" }] });
    expect(store.undo().ok).toBe(true);
    expect(value("transform.x")).toBeUndefined();
    expect(value("opacity")).toBeUndefined();
    expect(value("transform.y", "d")).toBeUndefined();
    expect(store.redo().ok).toBe(true);
    expect(value("transform.x")).toBe(10);
    expect(value("transform.y", "d")).toBe(5);
    expect(value("opacity")).toMatchObject({ keys: [{ time: "0" }, { time: "1" }] });
  });

  it("brings back the keys a change replaced", () => {
    const { store, edit, value, owner } = setup();
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "setKey", time: "0", value: 1 });
    edit({ ...x, op: "setKey", time: "2", value: 2 });
    const keys = value("transform.x");
    edit({ ...x, op: "removeKey", time: "2" });
    edit({ ...x, op: "removeKey", time: "0" });
    expect(value("transform.x")).toBe(1);
    store.undo();
    store.undo();
    expect(value("transform.x")).toEqual(keys);
  });

  it("each edit sees the one before it", () => {
    const { edit, value, owner } = setup();
    const x = { owner, path: "transform.x" };
    edit(
      { ...x, op: "setKey", time: "0", value: 1 },
      { ...x, op: "write", time: "1", value: 2 },
      { ...x, op: "removeKey", time: "0" },
    );
    expect(value("transform.x")).toEqual({ keys: [{ time: "1", value: 2 }] });
  });

  it("leaves no step to undo when nothing changes", () => {
    const { store, edit, owner } = setup();
    edit({ owner, path: "opacity", op: "set", value: 0.5 });
    const before = store.revision;
    const same = edit({ owner, path: "opacity", op: "write", time: "0", value: 0.5 });
    expect(same.ok).toBe(true);
    expect(store.revision).toBe(before);
    edit({ owner, path: "transform.x", op: "clear" });
    expect(store.revision).toBe(before);
  });

  it("writes a time in its one spelling", () => {
    const { edit, value, owner } = setup();
    edit({ owner, path: "opacity", op: "setKey", time: "2/4", value: 1 });
    expect(value("opacity")).toEqual({ keys: [{ time: "0.5", value: 1 }] });
  });

  it("does nothing on a locked track, also for an AI task", () => {
    const { store, run, edit, value, owner, failure, track } = setup();
    run("track.update", { timeline: "main", track, changes: { locked: true } });
    const edits = { owner, path: "opacity", op: "set", value: 0.5 };
    expect(failure(edit(edits)).code).toBe("track-locked");
    const params = { timeline: "main", edits: [edits] };
    const asTask = store.execute({ type: "property.edit", params }, { origin: aiTask("t") });
    expect(asTask.ok).toBe(false);
    expect(value("opacity")).toBeUndefined();
  });

  it("changes nothing when one of its edits fails", () => {
    const { edit, value, owner, failure } = setup();
    const result = edit(
      { owner, path: "transform.x", op: "set", value: 10 },
      { owner, path: "opacity", op: "set", value: 2 },
    );
    expect(failure(result).code).toBe("invalid-value");
    expect(value("transform.x")).toBeUndefined();
  });

  it.each([
    ["a value out of range", { path: "opacity", op: "set", value: 2 }],
    ["a key out of range", { path: "opacity", op: "setKey", time: "0", value: 2 }],
    ["the wrong kind of value", { path: "opacity", op: "write", time: "0", value: "很多" }],
    ["a property that does not exist", { path: "transform.z", op: "set", value: 1 }],
    ["a choice that does not exist", { path: "fit", op: "write", time: "0", value: "stretch" }],
  ])("refuses %s", (_, edit) => {
    const { edit: run, owner, failure } = setup();
    expect(failure(run({ owner, ...edit })).code).toBe("invalid-value");
  });

  it.each([
    ["a time before zero", { path: "opacity", op: "setKey", time: "-1", value: 1 }],
    ["no time", { path: "opacity", op: "setKey", value: 1 }],
    ["an unknown kind of edit", { path: "opacity", op: "move", value: 1 }],
    ["more than it needs", { path: "opacity", op: "clear", value: 1 }],
    ["a path with a display name", { path: "object.秤砣.x", op: "set", value: 1 }],
    ["a path that reaches into objects", { path: "__proto__", op: "set", value: 1 }],
    ["a constructor", { path: "constructor", op: "clear" }],
  ])("refuses %s before it does anything", (_, edit) => {
    const { edit: run, owner, failure } = setup();
    expect(failure(run({ owner, ...edit })).code).toBe("invalid-params");
  });

  it("refuses no edits at all", () => {
    const { edit, failure } = setup();
    expect(failure(edit()).code).toBe("invalid-params");
  });

  it("refuses an owner it does not know the shape of", () => {
    const { edit, failure } = setup();
    const owner = { track: "t" };
    expect(failure(edit({ owner, path: "opacity", op: "clear" })).code).toBe("invalid-params");
  });

  it("does not take what every object inherits for a value", () => {
    const { edit, owner, failure, store } = setup();
    // With properties there is an object to find `toString` on.
    edit({ owner, path: "opacity", op: "set", value: 0.5 });
    expect(failure(edit({ owner, path: "toString", op: "write", time: "0", value: 1 })).code).toBe(
      "invalid-value",
    );
    const { revision } = store;
    const cleared = edit({ owner, path: "toString", op: "clear" });
    expect(cleared.ok && cleared.patches).toEqual([]);
    expect(store.revision).toBe(revision);
    expect(failure(edit({ owner, path: "toString", op: "removeKey", time: "0" })).code).toBe(
      "not-found",
    );
  });

  it("says when a clip or a key is not there", () => {
    const { edit, owner, failure } = setup();
    const gone = { owner: { clip: "nope" }, path: "opacity", op: "clear" };
    expect(failure(edit(gone)).code).toBe("not-found");
    const noKey = { owner, path: "opacity", op: "removeKey", time: "1" };
    expect(failure(edit(noKey)).code).toBe("not-found");
  });

  it("does not put keys on what cannot have any", () => {
    const { edit, owner, failure, value } = setup();
    const fit = { owner, path: "fit" };
    expect(failure(edit({ ...fit, op: "setKey", time: "0", value: "cover" })).code).toBe(
      "not-animatable",
    );
    const keys = { keys: [{ time: "0", value: "cover" }] };
    expect(failure(edit({ ...fit, op: "set", value: keys })).code).toBe("not-animatable");
    expect(edit({ ...fit, op: "write", time: "0", value: "cover" }).ok).toBe(true);
    expect(value("fit")).toBe("cover");
  });
});

describe("the older commands for properties", () => {
  it.each([
    ["__proto__"],
    ["constructor"],
    ["param.__proto__"],
    ["object.prototype.x"],
    ["object.秤砣.x"],
    [""],
  ])("do not take %j for a path", (path) => {
    const { store, failure, value } = setup();
    const params = { timeline: "main", clip: "c", path };
    const set = store.execute({ type: "clip.setProperty", params: { ...params, value: 1 } });
    expect(failure(set).code).toBe("invalid-params");
    expect(failure(store.execute({ type: "clip.clearProperty", params })).code).toBe(
      "invalid-params",
    );
    expect(value(path)).toBeUndefined();
    expect(Object.getPrototypeOf(store.getState().timelines["main"]?.clips["c"])).toBe(
      Object.prototype,
    );
  });

  it("go the same way", () => {
    const { run, value, failure, store } = setup();
    const params = { timeline: "main", clip: "c", path: "opacity" };
    run("clip.setProperty", { ...params, value: 0.5 });
    expect(value("opacity")).toBe(0.5);
    run("clip.clearProperty", params);
    expect(value("opacity")).toBeUndefined();
    const keys = { keys: [{ time: "0", value: "cover" }] };
    const wrong = { ...params, path: "fit", value: keys };
    const result = store.execute({ type: "clip.setProperty", params: wrong });
    expect(failure(result).code).toBe("not-animatable");
  });
});
