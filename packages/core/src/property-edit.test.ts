import { Animation, createProject, type Key, type PropertyValue } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { compileChannel, sample, secondsOf } from "./curve.ts";
import { CommandError } from "./draft.ts";
import { orderedTracks } from "./model.ts";
import { applyEdit, type KeyEase } from "./property-edit.ts";
import { ProjectStore, aiTask } from "./store.ts";

const keyed: Animation = {
  keys: [
    { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
    { time: "2", value: 20, in: [0.58, 1], interp: "hold" },
  ],
  after: "loop",
};

const straight: Animation = {
  keys: [
    { time: "0", value: 0 },
    { time: "2", value: 20 },
  ],
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
      const after = write(straight, "1") as Animation;
      expect(after.keys.map(({ time }) => time)).toEqual(["0", "1", "2"]);
      expect(after.keys[1]).toEqual({ time: "1", value: 5 });
    });

    it("writes a key before the first one and after the last one", () => {
      expect((write(keyed, "3") as Animation).keys.at(-1)).toEqual({ time: "3", value: 5 });
      const late: Animation = { keys: [{ time: "1", value: 1 }] };
      expect((write(late, "0") as Animation).keys[0]).toEqual({ time: "0", value: 5 });
    });

    it("a new key is linear and has no handles", () => {
      const key = (write(straight, "1") as Animation).keys[1];
      expect(key).toEqual({ time: "1", value: 5 });
    });

    it("keeps a bezier as it looks when a key goes in with the value that was there", () => {
      const eased: Animation = {
        keys: [
          { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
          { time: "2", value: 100, in: [0.58, 1] },
        ],
      };
      const before = compileChannel(eased, "number");
      if (!before) throw new Error("no channel");
      const middle = sample(before, 0.5) as number;
      const after = applyEdit(eased, { op: "write", time: "0.5", value: middle });
      const channel = compileChannel(after, "number");
      if (!channel) throw new Error("no channel");
      for (const clock of [0.1, 0.3, 0.5, 0.7, 1, 1.3, 1.7, 1.95]) {
        expect(sample(channel, clock)).toBeCloseTo(sample(before, clock) as number, 3);
      }
      expect((after as Animation).keys).toHaveLength(3);
    });

    it("bends a bezier where a key goes in with another value, and does not swing far", () => {
      // What overshoots, from 0 to 100 in two seconds, with 80 written at every frame.
      const overshoot: Animation = {
        keys: [
          { time: "0", value: 0, interp: "bezier", out: [0.34, 1.56] },
          { time: "2", value: 100, in: [0.64, 1] },
        ],
      };
      for (let frame = 1; frame < 60; frame += 1) {
        const after = applyEdit(overshoot, { op: "write", time: `${frame}/30`, value: 80 });
        expect(Animation.safeParse(after).success).toBe(true);
        const channel = compileChannel(after, "number");
        if (!channel) throw new Error("no channel");
        expect(sample(channel, frame / 30)).toBeCloseTo(80, 9);
        for (let step = 0; step <= 200; step += 1) {
          // As far as the curve itself goes, which is 109.8.
          expect(sample(channel, step / 100)).toBeLessThan(110);
          expect(sample(channel, step / 100)).toBeGreaterThan(-1);
        }
      }
    });

    it("a key that goes in and comes out again leaves the curve exactly as it was", () => {
      const eases = [
        [
          [0.25, 0.1],
          [0.25, 1],
        ],
        [
          [0, 0],
          [0.58, 1],
        ],
        [
          [0.42, 0],
          [0.58, 1],
        ],
        [[0.42, 0], undefined],
        [
          [0.34, 1.56],
          [0.64, 1],
        ],
        [
          [0.36, 0],
          [0.66, -0.56],
        ],
      ] as const;
      for (const [out, arriving] of eases) {
        const before: Animation = {
          keys: [
            { time: "0", value: 0, interp: "bezier", out: [...out] },
            { time: "2", value: 100, ...(arriving ? { in: [...arriving] } : {}) },
          ],
        };
        const channel = compileChannel(before, "number");
        if (!channel) throw new Error("no channel");
        for (const time of ["0.3", "1/3", "0.5", "1", "1.6", "59/30"]) {
          // The diamond writes what is there. Typing writes something else.
          const there = sample(channel, secondsOf(time));
          for (const value of [there, 80, -30, 100]) {
            const added = applyEdit(before, { op: "setKey", time, value });
            expect(applyEdit(added, { op: "removeKey", time })).toEqual(before);
          }
        }
      }
    });

    it("keeps the shape of the usual easings wherever a key goes in with the value that was there", () => {
      for (const [out, arriving] of [
        [
          [0.42, 0],
          [0.58, 1],
        ],
        [
          [0.42, 0],
          [1, 1],
        ],
        [
          [0, 0],
          [0.58, 1],
        ],
      ] as const) {
        const eased: Animation = {
          keys: [
            { time: "0", value: 0, interp: "bezier", out: [...out] },
            { time: "2", value: 100, in: [...arriving] },
          ],
        };
        const before = compileChannel(eased, "number");
        if (!before) throw new Error("no channel");
        for (let frame = 1; frame < 60; frame += 1) {
          const value = sample(before, frame / 30) as number;
          const after = applyEdit(eased, { op: "setKey", time: `${frame}/30`, value });
          expect((after as Animation).keys[1]?.interp).toBe("bezier");
          const channel = compileChannel(after, "number");
          if (!channel) throw new Error("no channel");
          for (let step = 0; step <= 40; step += 1) {
            expect(sample(channel, step / 20)).toBeCloseTo(sample(before, step / 20) as number, 6);
          }
        }
      }
    });

    it("where keeping the shape would take a handle that swings far, the keys around stay", () => {
      const overshoot: Animation = {
        keys: [
          { time: "0", value: 0, interp: "bezier", out: [0.34, 1.56] },
          { time: "2", value: 100, in: [0.64, 1] },
        ],
      };
      const channel = compileChannel(overshoot, "number");
      if (!channel) throw new Error("no channel");
      // Right where the curve goes past 100 the stretch after the key would barely change.
      const after = applyEdit(overshoot, {
        op: "setKey",
        time: "2/3",
        value: sample(channel, 2 / 3),
      }) as Animation;
      expect(after.keys[0]).toEqual(overshoot.keys[0]);
      expect(after.keys[1]).toEqual({ time: "2/3", value: sample(channel, 2 / 3) });
      expect(after.keys[2]).toEqual(overshoot.keys[1]);
    });

    it("a stretch that stands still gets a linear key, and the keys around it stay", () => {
      const still: Animation = {
        keys: [
          { time: "0", value: 5, interp: "bezier", out: [0.42, 0] },
          { time: "2", value: 5, in: [0.58, 1] },
        ],
      };
      const after = applyEdit(still, { op: "setKey", time: "1", value: 30 }) as Animation;
      expect(after.keys).toEqual([still.keys[0], { time: "1", value: 30 }, still.keys[1]]);
    });

    it("leaves a bezier that stands still around the key alone, and writes a linear key", () => {
      const flat: Animation = {
        keys: [
          { time: "0", value: 0, interp: "bezier", out: [0.5, 0] },
          { time: "1", value: 1, in: [1, 0] },
        ],
      };
      // The handles lie on the line of no progress for most of the way: nothing is left to scale.
      const after = applyEdit(flat, { op: "setKey", time: "0.0000001", value: 0 }) as Animation;
      expect(after.keys[1]).toEqual({ time: "0.0000001", value: 0 });
    });

    it("keeps moments on a curve that only has a handle on one side", () => {
      const after = write(keyed, "1") as Animation;
      expect(after.keys[0]?.interp).toBe("bezier");
      expect(after.keys[1]?.interp).toBe("bezier");
      expect(after.keys[2]?.in).toBeDefined();
      expect(Animation.safeParse(after).success).toBe(true);
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

  describe("moveKey", () => {
    const three: Animation = {
      keys: [
        { time: "1", value: 10, interp: "hold" },
        { time: "2", value: 20, interp: "bezier", out: [0.2, 0.3], in: [0.4, 0.5] },
        { time: "3", value: 30, in: [0.6, 0.7] },
      ],
      before: "loop",
    };
    const move = (value: PropertyValue | undefined, ...moves: [string, string][]) =>
      applyEdit(value, { op: "moveKey", moves: moves.map(([from, to]) => ({ from, to })) });
    const times = (value: PropertyValue | undefined) =>
      (value as Animation).keys.map(({ time }) => time);

    it("takes everything of a key along, and leaves the rest", () => {
      const after = move(three, ["2", "2.5"]) as Animation;
      expect(after.keys[1]).toEqual({ ...three.keys[1], time: "2.5" });
      expect(after.keys[0]).toBe(three.keys[0]);
      expect(after.before).toBe("loop");
    });

    it("keeps keys in order when one passes another", () => {
      expect(times(move(three, ["1", "2.5"]))).toEqual(["2", "2.5", "3"]);
      expect(times(move(three, ["3", "0"]))).toEqual(["0", "1", "2"]);
    });

    it("moves keys together, so that one can go where another leaves", () => {
      expect(times(move(three, ["1", "2"], ["2", "3"], ["3", "4"]))).toEqual(["2", "3", "4"]);
      const after = move(three, ["3", "4"], ["2", "3"], ["1", "2"]) as Animation;
      expect(after.keys.map(({ value }) => value)).toEqual([10, 20, 30]);
    });

    it("what lands on a key that stays replaces it", () => {
      const after = move(three, ["1", "2"]) as Animation;
      expect(times(after)).toEqual(["2", "3"]);
      expect(after.keys[0]).toEqual({ time: "2", value: 10, interp: "hold" });
    });

    it("knows moments in another spelling", () => {
      const thirds: Animation = {
        keys: [
          { time: "1/3", value: 1 },
          { time: "2/3", value: 2 },
        ],
      };
      expect(
        times(applyEdit(thirds, { op: "moveKey", moves: [{ from: "2/6", to: "0.5" }] })),
      ).toEqual(["0.5", "2/3"]);
    });

    it("fails for a key that is not there, and on a plain value", () => {
      expect(() => move(three, ["1.5", "2"])).toThrow(CommandError);
      expect(() => move(5, ["0", "1"])).toThrow(CommandError);
      expect(() => move(undefined, ["0", "1"])).toThrow(CommandError);
    });

    it("does not let two keys end up in one place or one key go twice", () => {
      expect(() => move(three, ["1", "5"], ["2", "5"])).toThrow(CommandError);
      expect(() => move(three, ["1", "5"], ["1", "6"])).toThrow(CommandError);
    });

    it("leaves the value it got as it is", () => {
      const before = structuredClone(three);
      move(three, ["1", "2"]);
      expect(three).toEqual(before);
    });
  });

  describe("setInterp", () => {
    const ease = (value: PropertyValue | undefined, times: string[], to: KeyEase) =>
      applyEdit(value, { op: "setInterp", times, ease: to }) as Animation;
    const handles: KeyEase = { interp: "bezier", out: [0.42, 0], in: [0.58, 1] };

    it("a bezier leaves this key and arrives at the next one", () => {
      const after = ease(straight, ["0"], handles);
      expect(after.keys[0]).toEqual({ time: "0", value: 0, interp: "bezier", out: [0.42, 0] });
      expect(after.keys[1]).toEqual({ time: "2", value: 20, in: [0.58, 1] });
    });

    it("the last key has nowhere to arrive", () => {
      const after = ease(straight, ["2"], handles);
      expect(after.keys[1]).toEqual({ time: "2", value: 20, interp: "bezier", out: [0.42, 0] });
    });

    it("hold and linear leave no handles behind", () => {
      const held = ease(ease(straight, ["0"], handles), ["0"], { interp: "hold" });
      expect(held.keys).toEqual([
        { time: "0", value: 0, interp: "hold" },
        { time: "2", value: 20 },
      ]);
      const linear = ease(keyed, ["0"], { interp: "linear" });
      expect(linear.keys[0]).toEqual({ time: "0", value: 0 });
      expect(linear.keys[1]).toEqual({ time: "2", value: 20, interp: "hold" });
    });

    it("how a key arrives stays, which is about the key before", () => {
      const after = ease(keyed, ["2"], { interp: "linear" });
      expect(after.keys[1]).toEqual({ time: "2", value: 20, in: [0.58, 1] });
    });

    it("takes what a spring or a preset said along when it stops being one", () => {
      const preset: Animation = {
        keys: [
          { time: "0", value: 0, interp: "preset", preset: "bounce" },
          { time: "1", value: 1, interp: "spring", spring: { stiffness: 1, damping: 1 } },
        ],
      };
      const after = ease(preset, ["0", "1"], { interp: "hold" });
      expect(after.keys).toEqual([
        { time: "0", value: 0, interp: "hold" },
        { time: "1", value: 1, interp: "hold" },
      ]);
    });

    it("does several keys at once, each one with the stretch it starts", () => {
      const three: Animation = {
        keys: [
          { time: "0", value: 0 },
          { time: "1", value: 1 },
          { time: "2", value: 2 },
        ],
      };
      const after = ease(three, ["1", "0"], handles);
      expect(after.keys[1]).toMatchObject({ interp: "bezier", out: [0.42, 0], in: [0.58, 1] });
      expect(after.keys[2]).toMatchObject({ in: [0.58, 1] });
      expect(Animation.safeParse(after).success).toBe(true);
    });

    it("fails for a key that is not there", () => {
      expect(() => ease(straight, ["1"], { interp: "hold" })).toThrow(CommandError);
      expect(() => ease(3, ["0"], { interp: "hold" })).toThrow(CommandError);
    });
  });

  describe("putKeys", () => {
    const put = (value: PropertyValue | undefined, ...keys: Key[]) =>
      applyEdit(value, { op: "putKeys", keys }) as Animation;

    it("starts keys on a plain value and on none", () => {
      const key = { time: "1", value: 4, interp: "hold" } as const;
      expect(put(5, key)).toEqual({ keys: [key] });
      expect(put(undefined, key)).toEqual({ keys: [key] });
    });

    it("takes the place of what is at those moments, and keeps the rest", () => {
      const after = put(straight, { time: "1", value: 4 }, { time: "2", value: 5, interp: "hold" });
      expect(after.keys).toEqual([
        { time: "0", value: 0 },
        { time: "1", value: 4 },
        { time: "2", value: 5, interp: "hold" },
      ]);
    });

    it("does not take the same moment twice", () => {
      expect(() => put(straight, { time: "1", value: 4 }, { time: "2/2", value: 5 })).toThrow(
        CommandError,
      );
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

  it("moves keys and changes how they go on in one step, and undo brings it all back", () => {
    const { store, edit, value, owner } = setup();
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "setKey", time: "0", value: 1 }, { ...x, op: "setKey", time: "2", value: 2 });
    const keys = value("transform.x");
    edit(
      { ...x, op: "moveKey", moves: [{ from: "2", to: "3" }] },
      { ...x, op: "setInterp", times: ["0"], ease: { interp: "hold" } },
    );
    expect(value("transform.x")).toEqual({
      keys: [
        { time: "0", value: 1, interp: "hold" },
        { time: "3", value: 2 },
      ],
    });
    store.undo();
    expect(value("transform.x")).toEqual(keys);
  });

  it("refuses to move a key before the clock starts, and to write a handle that goes back", () => {
    const { store, edit, value, owner } = setup();
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "setKey", time: "1", value: 1 });
    const before = value("transform.x");
    const run = (change: object) =>
      store.execute({ type: "property.edit", params: { timeline: "main", edits: [change] } });
    expect(run({ ...x, op: "moveKey", moves: [{ from: "1", to: "-1" }] }).ok).toBe(false);
    const ease = { interp: "bezier", out: [1.5, 0] };
    expect(run({ ...x, op: "setInterp", times: ["1"], ease }).ok).toBe(false);
    expect(run({ ...x, op: "setInterp", times: ["1"], ease: { interp: "bezier" } }).ok).toBe(false);
    expect(value("transform.x")).toEqual(before);
  });

  it("checks the values of keys that get put in", () => {
    const { store, owner } = setup();
    const keys = [{ time: "0", value: 3 }];
    const edits = [{ owner, path: "opacity", op: "putKeys", keys }];
    expect(store.execute({ type: "property.edit", params: { timeline: "main", edits } }).ok).toBe(
      false,
    );
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

  it("works on a locked track too, also for an AI task", () => {
    const { store, run, value, owner, track } = setup();
    run("track.update", { timeline: "main", track, changes: { locked: true } });
    const edits = [{ owner, path: "opacity", op: "set", value: 0.5 }];
    const params = { timeline: "main", edits };
    const asTask = store.execute({ type: "property.edit", params }, { origin: aiTask("t") });
    expect(asTask.ok).toBe(true);
    expect(value("opacity")).toBe(0.5);
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
