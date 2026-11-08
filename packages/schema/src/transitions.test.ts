import { describe, expect, it } from "vitest";
import { parseTime } from "./time.ts";
import {
  BUILT_IN_TRANSITIONS,
  SUPPORTED_TRANSITIONS,
  findTransition,
  isSupported,
  placeJoins,
  type ClipTimes,
  type JoinSides,
} from "./transitions.ts";

describe("what a transition is", () => {
  it("is a built-in one by name, for what it changes and where it is", () => {
    expect(findTransition({ type: "fade" }, "picture", "enter")).toMatchObject({
      kind: "built-in",
      type: "fade",
    });
    expect(findTransition({ type: "dip", variant: "white" }, "picture", "join")).toMatchObject({
      kind: "built-in",
      type: "dip",
      variant: "white",
    });
    expect(findTransition({ type: "fade-linear" }, "sound", "exit")).toMatchObject({
      kind: "built-in",
    });
  });

  it.each([
    [{ type: "melt" }, "picture", "enter", { reason: "unknown", type: "melt" }],
    [{ type: "plugin.star" }, "picture", "enter", { reason: "plugin", type: "plugin.star" }],
    [{ type: "fade-linear" }, "picture", "exit", { reason: "media", media: "picture" }],
    [{ type: "dip" }, "picture", "enter", { reason: "no-variant", variants: ["black", "white"] }],
    [{ type: "dip", variant: "red" }, "picture", "enter", { reason: "variant", variant: "red" }],
    [{ type: "fade", variant: "left" }, "picture", "enter", { reason: "variant" }],
    [{ transition: "ink" }, "picture", "join", { reason: "project", transition: "ink" }],
    [{ library: "lib", resource: "ink" }, "picture", "join", { reason: "library", library: "lib" }],
  ] as const)("is missing for %j on %s at %s", (ref, media, use, why) => {
    const found = findTransition(ref, media, use);
    expect(found.kind).toBe("missing");
    expect(found.kind === "missing" && found.why).toMatchObject(why);
  });

  it("does not come from the prototype of an object", () => {
    expect(findTransition({ type: "constructor" }, "picture", "enter").kind).toBe("missing");
    expect(findTransition({ type: "toString" }, "sound", "enter").kind).toBe("missing");
  });

  it("is only done here for the picture at the start and the end of clips, so far", () => {
    const fade = findTransition({ type: "fade" }, "picture", "enter");
    expect(isSupported(fade, "picture", "enter")).toBe(true);
    expect(isSupported(fade, "picture", "exit")).toBe(true);
    expect(isSupported(fade, "picture", "join")).toBe(false);
    expect(isSupported(fade, "sound", "enter")).toBe(false);
    const wipe = findTransition({ type: "wipe", variant: "left" }, "picture", "enter");
    expect(isSupported(wipe, "picture", "enter")).toBe(false);
    expect(Object.keys(SUPPORTED_TRANSITIONS.picture)).toEqual(["enter", "exit", "join"]);
  });

  it("comes with every name of the design, and their default lengths", () => {
    expect(Object.keys(BUILT_IN_TRANSITIONS.picture)).toEqual(["fade", "dip", "wipe", "push"]);
    expect(Object.keys(BUILT_IN_TRANSITIONS.sound)).toEqual(["fade", "fade-linear"]);
    expect(BUILT_IN_TRANSITIONS.picture["fade"]?.duration).toBe("0.5");
    expect(BUILT_IN_TRANSITIONS.sound["fade"]?.duration).toBe("0.2");
    expect(BUILT_IN_TRANSITIONS.picture["push"]?.overshoot).toBe(true);
  });
});

describe("where joins are", () => {
  const clips: Readonly<Record<string, ClipTimes>> = {
    a: { start: "0", duration: "0.1" },
    b: { start: "0.1", duration: "0.2" },
    c: { start: "0.3", duration: "1" },
    d: { start: "0.3", duration: "2" },
    far: { start: "5", duration: "1" },
  };
  const place = (joins: Readonly<Record<string, JoinSides>>) =>
    Object.fromEntries(
      placeJoins(new Map(Object.entries(joins)), (id) =>
        Object.hasOwn(clips, id) ? clips[id] : undefined,
      ),
    );

  it("is on the cut, exactly", () => {
    expect(place({ j: { from: "b", to: "c" } })).toEqual({
      j: { kind: "cut", at: parseTime("0.3") },
    });
  });

  it("is nowhere for a clip that is not there, or for one clip, or for two apart", () => {
    expect(place({ j: { from: "gone", to: "c" } })).toEqual({
      j: { kind: "missing", clip: "gone" },
    });
    expect(place({ j: { from: "b", to: "gone" } })).toEqual({
      j: { kind: "missing", clip: "gone" },
    });
    expect(place({ j: { from: "b", to: "b" } })).toEqual({ j: { kind: "same" } });
    expect(place({ j: { from: "a", to: "far" } })).toEqual({ j: { kind: "apart" } });
    expect(place({ j: { from: "c", to: "b" } })).toEqual({ j: { kind: "apart" } });
  });

  it("goes to the first by id when two are on one cut, whichever way they share it", () => {
    expect(place({ y: { from: "b", to: "c" }, x: { from: "b", to: "c" } })).toMatchObject({
      x: { kind: "cut" },
      y: { kind: "taken", by: "x" },
    });
    expect(place({ x: { from: "b", to: "c" }, y: { from: "b", to: "d" } })).toMatchObject({
      x: { kind: "cut" },
      y: { kind: "taken", by: "x" },
    });
    expect(place({ x: { from: "a", to: "b" }, y: { from: "b", to: "c" } })).toMatchObject({
      x: { kind: "cut" },
      y: { kind: "cut" },
    });
  });

  it("has nothing to do with a join that does nothing", () => {
    expect(place({ x: { from: "b", to: "far" }, y: { from: "b", to: "c" } })).toMatchObject({
      x: { kind: "apart" },
      y: { kind: "cut" },
    });
  });
});
