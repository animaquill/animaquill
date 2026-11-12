import { Clip, checkProject, createProject, readProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { sync } from "./fuzz-support.ts";
import { effectsOf, type ClipState } from "./model.ts";
import { Trial } from "./trial.ts";
import { describeClip } from "./objects.ts";
import { buildRenderPlan, transitionsNotDone } from "./render-plan.ts";
import { ProjectStore, type CommandCall } from "./store.ts";
import { effectValuesAt, effectWorksAt } from "./view.ts";

/**
 * The effects of clips: how files and the live project keep them, the commands that change them,
 * and what the render plan makes of them. See docs/design/transitions.md, section 7.
 */

function withClip(effects?: readonly object[], properties?: object) {
  const store = ProjectStore.create(createProject({ name: "效果" }));
  const tracks = Object.values(store.getState().timelines["main"]?.tracks ?? {});
  const video = tracks.find(({ kind }) => kind === "video")?.id as string;
  const audio = tracks.find(({ kind }) => kind === "audio")?.id as string;
  const clip = {
    id: "c",
    start: "0",
    duration: "4",
    source: { kind: "color", color: "#808080" },
    ...(effects && { effects }),
    ...(properties && { properties }),
  };
  const added = store.execute({
    type: "clip.add",
    params: { timeline: "main", track: video, ...clip },
  });
  expect(added.ok).toBe(true);
  return { store, video, audio };
}

const run = (store: ProjectStore, type: string, params: object) =>
  store.execute({ type, params: { timeline: "main", clip: "c", ...params } } as CommandCall);

const clipOf = (store: ProjectStore) => store.getState().timelines["main"]?.clips["c"] as ClipState;
const list = (store: ProjectStore) =>
  effectsOf(clipOf(store)).map(({ id, type, enabled }) =>
    enabled === false ? `${id}:${type}:off` : `${id}:${type}`,
  );
const failure = (result: ReturnType<ProjectStore["execute"]>) =>
  result.ok ? "ok" : result.error.code;

describe("the format", () => {
  it("keeps what an effect takes as properties of its clip, and drops it from the effect", () => {
    const read = Clip.parse({
      id: "c",
      start: "0",
      duration: "1",
      source: { kind: "color", color: "#000000" },
      effects: [{ id: "fx", type: "blur", properties: { radius: 4 } }],
      properties: { "effect.fx.radius": 3, "crop.left": 0.2 },
    });
    expect(read.effects).toEqual([{ id: "fx", type: "blur" }]);
    // Cropping is an effect now: the property of before goes.
    expect(read.properties).toEqual({ "effect.fx.radius": 3 });
  });

  it("does not take two effects with one id on a clip", () => {
    const result = Clip.safeParse({
      id: "c",
      start: "0",
      duration: "1",
      source: { kind: "color", color: "#000000" },
      effects: [
        { id: "fx", type: "blur" },
        { id: "fx", type: "crop" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("goes into the live project by id, in its order, and back the same", () => {
    const effects = [
      { id: "z", type: "crop" },
      { id: "a", type: "blur", enabled: false },
    ];
    const { store } = withClip(effects, { "effect.z.left": 0.25 });
    expect(clipOf(store).effects).toEqual({
      z: { type: "crop", order: 0 },
      a: { type: "blur", enabled: false, order: 1 },
    });
    const file = JSON.parse(store.exportFiles().files.get("timelines/main/timeline.json") ?? "{}");
    const clip = file.tracks.flatMap((track: { clips: object[] }) => track.clips)[0];
    expect(clip.effects).toEqual(effects);
    expect(clip.properties).toEqual({ "effect.z.left": 0.25 });
  });

  it("says what this editor does not know and what an effect cannot take", () => {
    const { store } = withClip(
      [
        { id: "p", type: "plugin.glow" },
        { id: "b", type: "brightness" },
      ],
      { "effect.b.brightness": 5, "effect.b.nothing": 1 },
    );
    const { project } = readProject(store.exportFiles().files);
    const codes = checkProject(project as never)
      .filter(({ code }) => code.startsWith("effect"))
      .map(({ code, path }) => `${code} ${path}`);
    expect(codes).toEqual([
      "effect-missing tracks.0.clips.0.effects.0.type",
      "effect-property tracks.0.clips.0.properties.effect.b.brightness",
      "effect-property tracks.0.clips.0.properties.effect.b.nothing",
    ]);
  });

  it("has a blur repeat its edge unless it says transparent, which is the same at every moment", () => {
    const keys = {
      keys: [
        { time: "0", value: "transparent" },
        { time: "2", value: "extend" },
      ],
    };
    const { store } = withClip([{ id: "b", type: "blur" }], { "effect.b.edge": keys });
    const { project } = readProject(store.exportFiles().files);
    const codes = checkProject(project as never)
      .filter(({ path }) => path?.includes("effect.b"))
      .map(({ code }) => code);
    expect(codes).toEqual(["not-animatable"]);
    const layer = buildRenderPlan(store.getState(), "main")?.layers[0];
    if (!layer) throw new Error("no layer");
    // Only the first key counts, at every moment.
    for (const time of [0, 3]) {
      expect(effectValuesAt(layer, { id: "b", type: "blur" }, time).values).toEqual({
        radius: 0,
        edge: "transparent",
      });
    }
    const plain = { ...layer, channels: {} };
    expect(effectValuesAt(plain, { id: "b", type: "blur" }, 0)).toEqual({
      values: { radius: 0, edge: "extend" },
      idle: true,
    });
  });
});

describe("the commands", () => {
  it("put an effect last, or where they say, with what it starts with", () => {
    const { store } = withClip();
    expect(failure(run(store, "effect.add", { id: "a", type: "blur" }))).toBe("ok");
    expect(
      failure(run(store, "effect.add", { id: "b", type: "crop", values: { left: 0.5 } })),
    ).toBe("ok");
    expect(failure(run(store, "effect.add", { id: "c", type: "brightness", index: 0 }))).toBe("ok");
    expect(list(store)).toEqual(["c:brightness", "a:blur", "b:crop"]);
    expect(clipOf(store).properties?.["effect.b.left"]).toBe(0.5);
  });

  it("refuse what this editor does not have, ids that are taken, sound, and wrong values", () => {
    const { store, audio } = withClip([{ id: "a", type: "blur" }]);
    expect(failure(run(store, "effect.add", { type: "plugin.glow" }))).toBe("not-found");
    expect(failure(run(store, "effect.add", { type: "warp" }))).toBe("not-found");
    expect(failure(run(store, "effect.add", { id: "a", type: "crop" }))).toBe("id-taken");
    expect(failure(run(store, "effect.add", { type: "crop", values: { left: 2 } }))).toBe(
      "invalid-value",
    );
    expect(failure(run(store, "effect.add", { type: "crop", values: { width: 1 } }))).toBe(
      "not-found",
    );
    const sound = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: audio,
        id: "s",
        start: "0",
        duration: "1",
        source: { kind: "audio", media: { library: "lib", path: "a.wav" } },
      },
    });
    expect(sound.ok).toBe(true);
    const onSound = store.execute({
      type: "effect.add",
      params: { timeline: "main", clip: "s", type: "blur" },
    });
    expect(failure(onSound)).toBe("wrong-track");
  });

  it("change what an effect takes through property.edit, with keys, and only what it has", () => {
    const { store } = withClip([{ id: "a", type: "blur" }]);
    const edit = (path: string, value: unknown, op = "set") =>
      store.execute({
        type: "property.edit",
        params: {
          timeline: "main",
          edits: [{ owner: { clip: "c" }, path, op, value, ...(op === "setKey" && { time: "1" }) }],
        },
      });
    expect(failure(edit("effect.a.radius", 8, "setKey"))).toBe("ok");
    expect(clipOf(store).properties?.["effect.a.radius"]).toEqual({
      keys: [{ time: "1", value: 8 }],
    });
    expect(failure(edit("effect.a.radius", -1))).toBe("invalid-value");
    expect(failure(edit("effect.a.left", 1))).toBe("not-found");
    expect(failure(edit("effect.gone.radius", 1))).toBe("not-found");
    expect(failure(edit("crop.left", 0.1))).toBe("invalid-value");
    // How a blur takes its edge is one value for the whole clip, out of those it has.
    expect(failure(edit("effect.a.edge", "transparent"))).toBe("ok");
    expect(failure(edit("effect.a.edge", "extend", "setKey"))).toBe("not-animatable");
    expect(failure(edit("effect.a.edge", "mirror"))).toBe("invalid-value");
  });

  it("move, turn off and take away, with what it took, and undo brings all of it back", () => {
    const { store } = withClip(
      [
        { id: "a", type: "blur" },
        { id: "b", type: "crop" },
        { id: "c", type: "brightness" },
      ],
      { "effect.b.left": 0.3 },
    );
    expect(failure(run(store, "effect.move", { effect: "c", index: 0 }))).toBe("ok");
    expect(list(store)).toEqual(["c:brightness", "a:blur", "b:crop"]);
    expect(failure(run(store, "effect.move", { effect: "c", index: 2 }))).toBe("ok");
    expect(list(store)).toEqual(["a:blur", "b:crop", "c:brightness"]);
    expect(failure(run(store, "effect.update", { effect: "a", enabled: false }))).toBe("ok");
    expect(list(store)[0]).toBe("a:blur:off");
    expect(failure(run(store, "effect.remove", { effects: ["b"] }))).toBe("ok");
    expect(list(store)).toEqual(["a:blur:off", "c:brightness"]);
    expect(clipOf(store).properties?.["effect.b.left"]).toBeUndefined();
    store.undo();
    expect(list(store)).toEqual(["a:blur:off", "b:crop", "c:brightness"]);
    expect(clipOf(store).properties?.["effect.b.left"]).toBe(0.3);
    store.undo();
    store.undo();
    store.undo();
    expect(list(store)).toEqual(["a:blur", "b:crop", "c:brightness"]);
  });

  it("go along when a clip is cut, and a copy brings them", () => {
    const { store, video } = withClip([{ id: "a", type: "blur" }], { "effect.a.radius": 4 });
    const cut = store.execute({
      type: "clip.split",
      params: { timeline: "main", clip: "c", at: "2" },
    });
    expect(cut.ok).toBe(true);
    const clips = Object.values(store.getState().timelines["main"]?.clips ?? {});
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(effectsOf(clip).map(({ id }) => id)).toEqual(["a"]);
      expect(clip.properties?.["effect.a.radius"]).toBe(4);
    }
    const copy = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: video,
        start: "10",
        duration: "1",
        source: { kind: "color", color: "#000000" },
        effects: [{ id: "a", type: "blur" }],
      },
    });
    expect(copy.ok).toBe(true);
  });

  it("from two people at once both stay, each effect on its own", () => {
    const { store: a } = withClip();
    const b = ProjectStore.fromUpdates([a.encodeState()]).store as ProjectStore;
    run(a, "effect.add", { id: "x", type: "blur" });
    run(b, "effect.add", { id: "y", type: "crop" });
    sync(a, b);
    expect(list(a).toSorted()).toEqual(["x:blur", "y:crop"]);
    expect(list(b)).toEqual(list(a));
  });

  it("leave nothing in the files when one takes it away and the other changes it", () => {
    const { store: a } = withClip([{ id: "x", type: "blur" }]);
    const b = ProjectStore.fromUpdates([a.encodeState()]).store as ProjectStore;
    run(a, "effect.remove", { effects: ["x"] });
    run(b, "effect.update", { effect: "x", enabled: false });
    sync(a, b);
    for (const store of [a, b]) {
      expect(list(store)).toEqual([]);
      expect(store.exportFiles().problems).toEqual([]);
    }
    // What is left of it can still go.
    expect(failure(run(a, "effect.remove", { effects: ["x"] }))).toBe("ok");
  });
});

describe("when an effect works", () => {
  const rangeOf = (store: ProjectStore, id = "c") => {
    const clip = store.getState().timelines["main"]?.clips[id] as ClipState;
    return Object.fromEntries(
      effectsOf(clip).map(({ id: effect, start, end }) => [effect, [start, end]]),
    );
  };

  it("is all of the clip without saying, and from a start up to an end, as one step", () => {
    const { store } = withClip();
    expect(failure(run(store, "effect.add", { id: "a", type: "blur" }))).toBe("ok");
    expect(failure(run(store, "effect.add", { id: "b", type: "blur", start: "1" }))).toBe("ok");
    expect(rangeOf(store)).toEqual({ a: [undefined, undefined], b: ["1", undefined] });
    expect(failure(run(store, "effect.update", { effect: "a", start: "0.5", end: "3" }))).toBe(
      "ok",
    );
    expect(rangeOf(store)["a"]).toEqual(["0.5", "3"]);
    // Null is the edge of the clip again.
    expect(failure(run(store, "effect.update", { effect: "a", end: null }))).toBe("ok");
    expect(rangeOf(store)["a"]).toEqual(["0.5", undefined]);
    store.undo();
    expect(rangeOf(store)["a"]).toEqual(["0.5", "3"]);
    store.undo();
    expect(rangeOf(store)["a"]).toEqual([undefined, undefined]);
    // The files have it, and read it back the same.
    const read = readProject(store.exportFiles().files);
    const document = read.project?.timelines.get("main")?.document;
    const clip = document?.tracks.flatMap(({ clips }) => clips)[0];
    expect(clip?.effects).toEqual([
      { id: "a", type: "blur" },
      { id: "b", type: "blur", start: "1" },
    ]);
  });

  it.each([
    [{ start: "5" }],
    [{ end: "4.5" }],
    [{ start: "2", end: "2" }],
    [{ start: "3", end: "1" }],
    [{ start: "-1" }],
  ])("is refused outside the clip, or where it would not work at all: %j", (range) => {
    const { store } = withClip([{ id: "a", type: "blur" }]);
    const revision = store.revision;
    expect(failure(run(store, "effect.update", { effect: "a", ...range }))).not.toBe("ok");
    expect(failure(run(store, "effect.add", { type: "blur", ...range }))).not.toBe("ok");
    expect(store.revision).toBe(revision);
  });

  it("stays where it was when the clip is trimmed, cut down to what is left of the clip", () => {
    const { store } = withClip([
      { id: "all", type: "blur" },
      { id: "mid", type: "blur", start: "1", end: "3" },
      { id: "late", type: "blur", start: "3" },
      { id: "early", type: "blur", end: "1" },
    ]);
    const trim = (start?: string, end?: string) =>
      store.execute({
        type: "clip.trim",
        params: { timeline: "main", clip: "c", ...(start && { start }), ...(end && { end }) },
      });
    // The start goes 2 seconds later: what was at 3 on the clip is at 1 now.
    expect(failure(trim("2"))).toBe("ok");
    expect(rangeOf(store)).toEqual({
      all: [undefined, undefined],
      mid: ["0", "1"],
      late: ["1", undefined],
      // Nothing is left of it: it stays, working nowhere, at the edge where it went.
      early: [undefined, "0"],
    });
    // The end goes 1.5 seconds earlier: what goes up to the end stays up to the end.
    expect(failure(trim(undefined, "3.5"))).toBe("ok");
    expect(rangeOf(store)).toEqual({
      all: [undefined, undefined],
      mid: ["0", "1"],
      late: ["1", undefined],
      early: [undefined, "0"],
    });
    expect(failure(trim(undefined, "2.5"))).toBe("ok");
    expect(rangeOf(store)["mid"]).toEqual(["0", "0.5"]);
    // Back out, what moved along stays where it was on the timeline.
    expect(failure(trim("1"))).toBe("ok");
    expect(rangeOf(store)["mid"]).toEqual(["1", "1.5"]);
    expect(rangeOf(store)["late"]).toEqual(["1.5", undefined]);
    for (let step = 0; step < 4; step++) store.undo();
    expect(rangeOf(store)).toEqual({
      all: [undefined, undefined],
      mid: ["1", "3"],
      late: ["3", undefined],
      early: [undefined, "1"],
    });
  });

  it("goes with each part of a cut clip as far as it works there, and from a part it is not in", () => {
    const { store } = withClip(
      [
        { id: "all", type: "blur" },
        { id: "left", type: "blur", end: "1" },
        { id: "right", type: "crop", start: "3" },
        { id: "across", type: "blur", start: "1", end: "3" },
      ],
      { "effect.right.left": 0.5, "effect.left.radius": 2 },
    );
    const cut = store.execute({
      type: "clip.split",
      params: { timeline: "main", clip: "c", at: "2", piece: "d" },
    });
    expect(cut.ok).toBe(true);
    expect(rangeOf(store, "c")).toEqual({
      all: [undefined, undefined],
      left: [undefined, "1"],
      across: ["1", "2"],
    });
    expect(rangeOf(store, "d")).toEqual({
      all: [undefined, undefined],
      right: ["1", undefined],
      across: ["0", "1"],
    });
    const clips = store.getState().timelines["main"]?.clips;
    expect(clips?.["c"]?.properties).toEqual({ "effect.left.radius": 2 });
    expect(clips?.["d"]?.properties).toEqual({ "effect.right.left": 0.5 });
    store.undo();
    expect(rangeOf(store, "c")["right"]).toEqual(["3", undefined]);
  });

  it("is cut down when the clip gets shorter, and goes along when the clip moves", () => {
    const { store } = withClip([{ id: "a", type: "blur", start: "1", end: "3" }]);
    const update = (changes: object) =>
      store.execute({ type: "clip.update", params: { timeline: "main", clip: "c", changes } });
    expect(failure(update({ start: "5" }))).toBe("ok");
    expect(rangeOf(store)["a"]).toEqual(["1", "3"]);
    expect(failure(update({ duration: "2" }))).toBe("ok");
    expect(rangeOf(store)["a"]).toEqual(["1", "2"]);
  });

  it("is when the render plan has it work, on the timeline, and only then", () => {
    const { store } = withClip([
      { id: "a", type: "blur", start: "1", end: "3" },
      { id: "b", type: "blur" },
      { id: "nowhere", type: "blur", start: "2", end: "2" },
    ]);
    const moved = store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "c", changes: { start: "10" } },
    });
    expect(moved.ok).toBe(true);
    const layer = buildRenderPlan(store.getState(), "main")?.layers[0];
    expect(layer?.effects).toEqual([
      { id: "a", type: "blur", from: 11, to: 13 },
      { id: "b", type: "blur" },
    ]);
    const [a, b] = layer?.effects ?? [];
    expect(a && [10.5, 11, 12.9, 13, 13.5].map((time) => effectWorksAt(a, time))).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    // Without a range it works wherever the layer shows, also past its clip for a join.
    expect(b && [9, 11, 15].map((time) => effectWorksAt(b, time))).toEqual([true, true, true]);
  });
});

describe("the render plan", () => {
  it("has the effects that are on, in their order, with what they take as channels", () => {
    const { store } = withClip(
      [
        { id: "a", type: "crop" },
        { id: "b", type: "blur", enabled: false },
        { id: "p", type: "plugin.glow" },
        { id: "c", type: "brightness" },
      ],
      {
        "effect.a.left": 0.2,
        "effect.b.radius": 3,
        "effect.c.brightness": {
          keys: [
            { time: "0", value: 0 },
            { time: "2", value: 1 },
          ],
        },
      },
    );
    const plan = buildRenderPlan(store.getState(), "main");
    const layer = plan?.layers[0];
    expect(layer?.effects).toEqual([
      { id: "a", type: "crop" },
      { id: "p", type: "plugin.glow", missing: true },
      { id: "c", type: "brightness" },
    ]);
    expect(Object.keys(layer?.channels ?? {}).toSorted()).toEqual([
      "effect.a.left",
      "effect.c.brightness",
    ]);
    const brightness = layer && effectValuesAt(layer, { id: "c", type: "brightness" }, 1);
    expect(brightness).toEqual({ values: { brightness: 0.5 }, idle: false });
    // An export stops where something this editor cannot do shows.
    const timeline = store.getState().timelines["main"];
    const notDone = timeline && plan ? transitionsNotDone(timeline, plan, undefined) : [];
    expect(notDone).toEqual([{ clip: "c", use: "effect", media: "picture", start: 0, end: 4 }]);
  });

  it("leaves a picture as it is at the defaults, and keeps values within their limits", () => {
    const { store } = withClip([{ id: "a", type: "crop" }], { "effect.a.left": 7 });
    const layer = buildRenderPlan(store.getState(), "main")?.layers[0];
    if (!layer) throw new Error("no layer");
    expect(effectValuesAt(layer, { id: "a", type: "crop" }, 0)).toEqual({
      values: { left: 1, top: 0, right: 0, bottom: 0 },
      idle: false,
    });
    const idle = effectValuesAt({ ...layer, channels: {} }, { id: "a", type: "crop" }, 0);
    expect(idle.idle).toBe(true);
  });

  it("keeps its layer while nothing about the clip changes", () => {
    const { store } = withClip([{ id: "a", type: "blur" }]);
    const first = buildRenderPlan(store.getState(), "main")?.layers[0];
    expect(buildRenderPlan(store.getState(), "main")?.layers[0]).toBe(first);
    run(store, "effect.update", { effect: "a", enabled: false });
    const off = buildRenderPlan(store.getState(), "main")?.layers[0];
    expect(off).not.toBe(first);
    expect(off?.effects).toBeUndefined();
  });
});

describe("the tree of what can have keys", () => {
  it("has the effects of a clip under it, each with what it takes", () => {
    const { store } = withClip([
      { id: "a", type: "crop" },
      { id: "b", type: "blur" },
    ]);
    const { objects } = describeClip(store.getState(), clipOf(store), undefined);
    expect(objects.map(({ id, type, parent }) => [id, type, parent])).toEqual([
      ["visual", "clip.visual", undefined],
      ["effects", "clip.effects", undefined],
      ["effect.a", "effect.crop", "effects"],
      ["effect.b", "effect.blur", "effects"],
    ]);
    expect(objects[3]?.properties.map(({ path }) => path)).toEqual([
      "effect.b.radius",
      "effect.b.edge",
    ]);
  });
});

describe("trying out what an effect takes", () => {
  it("waits while the effect is gone, saves the rest, and comes back with it", () => {
    const { store } = withClip([{ id: "a", type: "blur" }]);
    const trial = new Trial(store, "main");
    const write = (path: string, value: number) =>
      trial.write([{ owner: { clip: "c" }, path, op: "set", value }]);
    expect(write("effect.a.radius", 9).ok).toBe(true);
    expect(write("opacity", 0.5).ok).toBe(true);
    expect(trial.count).toBe(2);
    run(store, "effect.remove", { effects: ["a"] });
    expect(trial.count).toBe(1);
    expect(trial.changes.get("c")?.has("effect.a.radius")).toBe(false);
    store.undo();
    expect(trial.count).toBe(2);
    run(store, "effect.remove", { effects: ["a"] });
    expect(trial.save().ok).toBe(true);
    expect(clipOf(store).properties?.["opacity"]).toBe(0.5);
    expect(clipOf(store).properties?.["effect.a.radius"]).toBeUndefined();
    // Back again, what was tried shows again, and saves.
    store.undo();
    store.undo();
    expect(trial.changes.get("c")?.get("effect.a.radius")?.value).toBe(9);
    expect(trial.save().ok).toBe(true);
    expect(clipOf(store).properties?.["effect.a.radius"]).toBe(9);
  });
});
