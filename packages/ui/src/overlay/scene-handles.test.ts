import type { Registration } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import { SceneHandles } from "./scene-handles.ts";

const registration: Registration = {
  objects: [{ id: "arm", properties: [{ path: "x", type: "number", default: 0 }] }],
  elements: [],
  complete: true,
};

const move = { kind: "move", id: "m", at: [1, 2], bind: { x: "x" } };
const raw = [
  { object: "arm", handles: [move, { kind: "move", id: "n", at: [0, 0], bind: { x: "y" } }] },
];

describe("the handles scenes say their objects have", () => {
  it("only count from the clip that was asked", () => {
    const handles = new SceneHandles({ schedule: (run) => (run(), () => {}) });
    const changed = vi.fn();
    handles.subscribe(changed);
    expect(handles.of("c", "r", 0, registration)).toEqual([]);
    handles.note("c", "r", 0, raw);
    expect(changed).not.toHaveBeenCalled();
    handles.want("c");
    handles.note("c", "r", 0, raw);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(handles.of("c", "r", 0, registration)).toEqual([{ object: "arm", handles: [move] }]);
  });

  it("are only true of the clip, the state of its scene and the frame they were said of", () => {
    const handles = new SceneHandles();
    handles.want("c");
    handles.note("c", "r", 3, raw);
    expect(handles.of("d", "r", 3, registration)).toEqual([]);
    expect(handles.of("c", "other", 3, registration)).toEqual([]);
    expect(handles.of("c", "r", 4, registration)).toEqual([]);
    expect(handles.of("c", "r", 3, undefined)).toEqual([]);
    expect(handles.of("c", "r", 3, registration)).toHaveLength(1);
  });

  it("are read once for what the scene registered, and again when that changes", () => {
    const handles = new SceneHandles();
    handles.want("c");
    handles.note("c", "r", 0, raw);
    const first = handles.of("c", "r", 0, registration);
    expect(handles.of("c", "r", 0, registration)).toBe(first);
    const more: Registration = {
      ...registration,
      objects: [{ id: "arm", properties: [{ path: "y", type: "number" }] }],
    };
    expect(handles.of("c", "r", 0, more)).toEqual([
      { object: "arm", handles: [{ kind: "move", id: "n", at: [0, 0], bind: { x: "y" } }] },
    ]);
  });

  it("say who to ask whenever that changes, and only then", () => {
    const handles = new SceneHandles();
    const asked = vi.fn();
    handles.subscribeWanted(asked);
    handles.want("c");
    handles.want("c");
    handles.want(undefined);
    expect(asked).toHaveBeenCalledTimes(2);
    expect(handles.wanted).toBeUndefined();
  });
});

describe("a scene that answers a lot", () => {
  function scheduled() {
    const runs: (() => void)[] = [];
    const schedule = vi.fn((run: () => void) => {
      runs.push(run);
      return () => runs.splice(runs.indexOf(run), 1);
    });
    const flush = () => {
      for (const run of runs.splice(0)) run();
    };
    return { schedule, flush, pending: () => runs.length };
  }

  it("makes nothing look again with answers of another frame or state, and keeps the last", () => {
    const { schedule } = scheduled();
    // Slow enough to be no flood.
    let now = 0;
    const handles = new SceneHandles({ schedule, now: () => (now += 1000) });
    const changed = vi.fn();
    handles.subscribe(changed);
    handles.want("c");
    expect(handles.of("c", "r", 5, registration)).toEqual([]);
    for (let index = 0; index < 1000; index += 1) handles.note("c", "r", 6 + (index % 3), raw);
    for (let index = 0; index < 1000; index += 1) handles.note("c", "other", 5, raw);
    expect(schedule).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    // The playhead got there after the answer: it is still there to be read.
    handles.note("c", "r", 9, raw);
    expect(handles.of("c", "r", 9, registration)).toHaveLength(1);
  });

  it("looks at answers for what shows once a frame of the screen, however many came", () => {
    const { schedule, flush, pending } = scheduled();
    const handles = new SceneHandles({ schedule });
    const changed = vi.fn();
    handles.subscribe(changed);
    handles.want("c");
    handles.of("c", "r", 0, registration);
    for (let index = 0; index < 10; index += 1) handles.note("c", "r", 0, raw);
    expect(pending()).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(handles.of("c", "r", 0, registration)).toHaveLength(1);
  });

  it("says once that a scene says too much, and leaves out what is too much", () => {
    let now = 0;
    const tooMany = vi.fn();
    const { schedule } = scheduled();
    const handles = new SceneHandles({ schedule, now: () => now, tooMany });
    handles.want("c");
    handles.of("c", "r", 0, registration);
    const other = [{ object: "arm", handles: [] }];
    for (let index = 0; index < 200; index += 1)
      handles.note("c", "r", 0, index < 100 ? raw : other);
    expect(tooMany).toHaveBeenCalledTimes(1);
    expect(tooMany).toHaveBeenCalledWith("c", "r");
    // What came while it said too much did not count.
    expect(handles.of("c", "r", 0, registration)).toHaveLength(1);
    now += 10_000;
    handles.note("c", "r", 0, other);
    expect(handles.of("c", "r", 0, registration)).toEqual([]);
    expect(tooMany).toHaveBeenCalledTimes(1);
  });
});
