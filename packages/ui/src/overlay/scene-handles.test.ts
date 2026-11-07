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
    const handles = new SceneHandles();
    const changed = vi.fn();
    handles.subscribe(changed);
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
