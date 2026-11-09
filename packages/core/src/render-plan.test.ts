import { describe, expect, it } from "vitest";
import { createProject, type PropertyValue } from "@animaquill/schema";
import { sample } from "./curve.ts";
import { orderedTracks, type ClipState, type ProjectState } from "./model.ts";
import {
  buildAudioPlan,
  buildRenderPlan,
  channelOf,
  effectiveProperties,
  samePlan,
} from "./render-plan.ts";
import { ProjectStore } from "./store.ts";
import { clockOf, opacityAt } from "./view.ts";

function setup() {
  const store = ProjectStore.create(createProject({ name: "计划" }));
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(result.error.message);
  };
  const main = store.getState().timelines["main"];
  const lower = main && orderedTracks(main).find(({ kind }) => kind === "video");
  if (!lower) throw new Error("no video track");
  run("track.add", { timeline: "main", id: "upper", kind: "video" });
  run("asset.add", {
    id: "a",
    asset: { kind: "video", path: "assets/a.mp4", storage: "local", hash: "sha256-a" },
  });
  const addClip = (id: string, track: string, extra: object) =>
    run("clip.add", {
      timeline: "main",
      track,
      clip: { id, start: "1", duration: "2", ...extra },
    });
  const plan = () => {
    const result = buildRenderPlan(store.getState(), "main");
    if (!result) throw new Error("no plan");
    return result;
  };
  return { run, addClip, plan, store, lower: lower.id };
}

const red = { source: { kind: "color", color: "#ff0000" } };

describe("the render plan", () => {
  it("has the size of the first format, and black behind everything", () => {
    const { plan } = setup();
    expect(plan()).toMatchObject({ width: 1920, height: 1080, background: "#000000", layers: [] });
  });

  it("goes back to front: the first track is furthest back", () => {
    const { addClip, plan, lower } = setup();
    addClip("front", "upper", red);
    addClip("back", lower, red);
    expect(plan().layers.map(({ id }) => id)).toEqual(["back", "front"]);
  });

  it("points at a file by its content, and keeps the time in the file", () => {
    const { addClip, plan, lower } = setup();
    addClip("c", lower, { offset: "1/2", source: { kind: "video", media: { asset: "a" } } });
    expect(plan().layers[0]).toMatchObject({
      start: 1,
      end: 3,
      offset: 0.5,
      source: { kind: "video", file: "sha256-a" },
    });
  });

  it("leaves out what does not show", () => {
    const { addClip, run, plan, lower } = setup();
    addClip("gone", lower, { ...red, hidden: true });
    addClip("shown", "upper", red);
    run("track.update", { timeline: "main", track: "upper", changes: { hidden: true } });
    expect(plan().layers).toEqual([]);
  });

  it("skips a clip whose file is unknown instead of failing", () => {
    const { addClip, plan, lower } = setup();
    addClip("c", lower, { source: { kind: "video", media: { asset: "missing" } } });
    expect(plan().layers).toEqual([]);
  });
});

describe("a layer of the render plan", () => {
  const keys = (...times: readonly string[]): PropertyValue => ({
    keys: times.map((time, index) => ({ time, value: index * 10 })),
  });

  function withClip(extra: object) {
    const context = setup();
    context.addClip("c", context.lower, { ...red, ...extra });
    const layer = () => {
      const found = context.plan().layers[0];
      if (!found) throw new Error("no layer");
      return found;
    };
    return { ...context, layer };
  }

  it("has its properties as channels, and nothing for what it does not have", () => {
    const { layer } = withClip({
      properties: { opacity: 0.5, "transform.x": keys("0", "1"), "audio.volume": -6 },
    });
    expect(Object.keys(layer().channels).toSorted()).toEqual(["opacity", "transform.x"]);
    expect(layer().channels["opacity"]).toEqual({ kind: "still", value: 0.5 });
    expect(layer().channels["transform.x"]).toMatchObject({ kind: "curve", type: "number" });
  });

  it("has the kind of value of the property", () => {
    const { layer } = withClip({ properties: { "transform.rotation": keys("0", "1") } });
    expect(layer().channels["transform.rotation"]).toMatchObject({ type: "angle" });
  });

  it.each([
    [{}, "contain"],
    [{ fit: "contain" }, "contain"],
    [{ fit: "cover" }, "cover"],
    [{ fit: "fixed" }, "fixed"],
  ])("with properties %j fits by %s", (properties, fit) => {
    expect(withClip({ properties }).layer().fit).toBe(fit);
  });

  it("goes by the first key of a fit that has keys, which only a hand-written project can", () => {
    const { layer, store } = withClip({});
    const state = store.getState();
    const main = state.timelines["main"];
    const added = main?.clips["c"] as ClipState;
    const curve = {
      keys: [
        { time: "0", value: "cover" },
        { time: "1", value: "fixed" },
      ],
    };
    const handWritten = { ...added, properties: { fit: curve } };
    const next = {
      ...state,
      timelines: { ...state.timelines, main: { ...main, clips: { c: handWritten } } },
    } as ProjectState;
    expect(buildRenderPlan(next, "main")?.layers[0]?.fit).toBe("cover");
    expect(layer().fit).toBe("contain");
  });

  it("has its enter and exit in seconds, also the ones that are no decimal", () => {
    const enter = { type: "fade", duration: "1/2" };
    const exit = { type: "fade", duration: "1/3", curve: [0.42, 0, 1, 1] };
    const { layer } = withClip({ start: "1", duration: "2", enter, exit });
    const how = { kind: "built-in", type: "fade" };
    expect(layer().enter).toEqual({ how, start: 1, end: 1.5, duration: 0.5 });
    expect(layer().exit).toEqual({
      how,
      start: 3 - 1 / 3,
      end: 3,
      duration: 1 / 3,
      curve: [0.42, 0, 1, 1],
    });
  });

  it("has no transitions without any", () => {
    const { layer } = withClip({});
    expect(layer()).not.toHaveProperty("enter");
    expect(layer()).not.toHaveProperty("exit");
  });

  it("makes a transition no longer than its clip, and a fade of what this editor cannot do", () => {
    const { layer, store } = withClip({ start: "1", duration: "2" });
    const state = store.getState();
    const clip = state.timelines["main"]?.clips["c"] as ClipState;
    const hand = (changes: Partial<ClipState>) =>
      ({
        ...state,
        timelines: {
          ...state.timelines,
          main: { ...state.timelines["main"], clips: { c: { ...clip, ...changes } } },
        },
      }) as ProjectState;
    const planned = (changes: Partial<ClipState>) =>
      buildRenderPlan(hand(changes), "main")?.layers[0];
    const enter = planned({ enter: { type: "fade", duration: "5" } })?.enter;
    expect(enter).toMatchObject({ start: 1, end: 3, duration: 2 });
    expect(enter).not.toHaveProperty("missing");
    const star = planned({ exit: { type: "plugin.star", duration: "1" } })?.exit;
    expect(star).toMatchObject({
      how: { kind: "built-in", type: "fade" },
      start: 2,
      missing: true,
    });
    // What comes with the editor is drawn as it says, with what its code gets.
    const values = { direction: "up", softness: 0.1 };
    const wipe = planned({ exit: { type: "wipe", values, duration: "1" } })?.exit;
    expect(wipe).toEqual({
      how: { kind: "built-in", type: "wipe", values },
      start: 2,
      end: 3,
      duration: 1,
    });
    // What it does not set is the default.
    const push = planned({ enter: { type: "push", duration: "1" } })?.enter;
    expect(push).toMatchObject({
      how: { type: "push", values: { direction: "left" } },
      overshoot: true,
    });
    const typo = planned({ exit: { type: "fdae", duration: "1" } })?.exit;
    expect(typo).toMatchObject({ how: { type: "fade" }, missing: true });
    expect(layer()).not.toHaveProperty("enter");
  });

  it("leaves out the end of a clip where a join is, while joins are not drawn yet", () => {
    const { store, lower } = withClip({
      start: "1",
      duration: "2",
      exit: { type: "fade", duration: "1" },
    });
    const state = store.getState();
    const main = state.timelines["main"];
    if (!main) throw new Error("no timeline");
    const next = {
      id: "d",
      start: "3",
      duration: "2",
      source: red.source,
      track: lower,
      enter: { type: "fade", duration: "1" },
    };
    const join = { track: lower, from: "c", to: "d", transition: { type: "fade", duration: "1" } };
    const joined = (joins: object, hidden = false) =>
      buildRenderPlan(
        {
          ...state,
          timelines: {
            main: {
              ...main,
              clips: { ...main.clips, d: { ...next, ...(hidden && { hidden }) } },
              joins,
            },
          },
        } as ProjectState,
        "main",
      )?.layers;
    const [before, after] = joined({ j: join }) ?? [];
    expect(before).not.toHaveProperty("exit");
    expect(after).not.toHaveProperty("enter");
    // A join somewhere else, or with a side that does not show, is as if it were not there.
    const [apart] = joined({ j: { ...join, to: "gone" } }) ?? [];
    expect(apart?.exit).toBeDefined();
    const [alone] = joined({ j: join }, true) ?? [];
    expect(alone?.exit).toBeDefined();
    const [partly] = joined({ j: { from: "c", to: "d", track: lower } }) ?? [];
    expect(partly?.exit).toBeDefined();
  });

  it("shows keys in the same place on the timeline after cutting and trimming", () => {
    const { run, plan, layer } = withClip({
      id: "c",
      start: "2",
      duration: "8",
      offset: "1",
      properties: {
        "transform.x": {
          keys: [
            { time: "1", value: 0 },
            { time: "9", value: 80 },
          ],
        },
      },
    });
    const xOn = (seconds: number) => {
      const shown = plan().layers.find(({ start, end }) => seconds >= start && seconds < end);
      const channel = shown?.channels["transform.x"];
      return shown && channel && sample(channel, clockOf(shown, seconds));
    };
    const moments = [2.5, 3, 5, 6.25, 9.75];
    const before = moments.map(xOn);
    expect(before[1]).toBeCloseTo(10, 9);
    expect(layer().offset).toBe(1);

    run("clip.split", { timeline: "main", clip: "c", at: "5" });
    expect(moments.map(xOn)).toEqual(before);

    run("clip.trim", { timeline: "main", clip: "c", start: "3" });
    expect(moments.slice(1).map(xOn)).toEqual(before.slice(1));
  });

  it("shows keys in the same place when a picture grows past the start of its clock", () => {
    const { run, plan } = withClip({
      start: "5",
      duration: "2",
      properties: {
        opacity: {
          keys: [
            { time: "0", value: 0 },
            { time: "2", value: 1 },
          ],
        },
      },
    });
    const opacity = (seconds: number) => {
      const [shown] = plan().layers;
      return shown && opacityAt(shown, seconds);
    };
    const before = opacity(6);
    run("clip.trim", { timeline: "main", clip: "c", start: "3" });
    expect(opacity(6)).toBe(before);
  });
});

describe("a render plan for a version", () => {
  function twoFormats() {
    const project = createProject({ name: "画幅" });
    const vertical = { id: "vertical", name: "竖屏", width: 1080, height: 1920, fps: "30" };
    const formats = [...project.manifest.formats, vertical];
    const manifest = { ...project.manifest, formats };
    return ProjectStore.create({ ...project, manifest }).getState();
  }

  it("uses the first format by itself", () => {
    expect(buildRenderPlan(twoFormats(), "main")).toMatchObject({ width: 1920, height: 1080 });
  });

  it("can be for another format, which has its own stage", () => {
    expect(buildRenderPlan(twoFormats(), "main", { format: "vertical" })).toMatchObject({
      width: 1080,
      height: 1920,
      stage: { width: 1080, height: 1920 },
    });
  });

  it("is not there for a format that is not", () => {
    expect(buildRenderPlan(twoFormats(), "main", { format: "nothing" })).toBeUndefined();
  });

  it("gets its properties from one place", () => {
    const { addClip, store, lower } = setup();
    addClip("c", lower, { ...red, properties: { opacity: 0.5 } });
    const clip = store.getState().timelines["main"]?.clips["c"] as ClipState;
    expect(effectiveProperties(clip, { format: "landscape" })).toBe(clip.properties);
  });
});

describe("comparing render plans", () => {
  const opacity = (value: number) => ({
    timeline: "main",
    edits: [{ owner: { clip: "b" }, path: "opacity", op: "set", value }],
  });

  function twoClips() {
    const context = setup();
    context.addClip("a", context.lower, red);
    context.addClip("b", "upper", red);
    return context;
  }

  it("finds nothing new when nothing changed", () => {
    const { plan } = twoClips();
    expect(samePlan(plan(), plan())).toBe(true);
  });

  it("finds a changed value, and a change that was taken back again", () => {
    const { run, plan, store } = twoClips();
    const before = plan();
    run("property.edit", opacity(0.5));
    const after = plan();
    expect(samePlan(before, after)).toBe(false);
    store.undo();
    expect(samePlan(after, plan())).toBe(false);
  });

  it("builds again only what changed", () => {
    const { run, plan } = twoClips();
    const before = plan();
    run("property.edit", opacity(0.5));
    const after = plan();
    expect(after.layers[0]).toBe(before.layers[0]);
    expect(after.layers[1]).not.toBe(before.layers[1]);
  });

  it("finds what changed elsewhere than in a layer", () => {
    const { plan, run } = twoClips();
    const before = plan();
    run("track.update", { timeline: "main", track: "upper", changes: { hidden: true } });
    expect(samePlan(before, plan())).toBe(false);
  });

  it.each([
    ["the width", { width: 1280 }],
    ["the height", { height: 720 }],
    ["the background", { background: "#ffffff" }],
    ["the camera", { camera: {} }],
  ])("finds another %s", (_, change) => {
    const { plan } = twoClips();
    const before = plan();
    expect(samePlan(before, { ...before, ...change })).toBe(false);
  });

  it("finds a layer more or less, and another order", () => {
    const { plan } = twoClips();
    const before = plan();
    expect(samePlan(before, { ...before, layers: before.layers.slice(1) })).toBe(false);
    expect(samePlan(before, { ...before, layers: before.layers.toReversed() })).toBe(false);
  });

  it("finds a file that changed under a clip", () => {
    const { addClip, lower, store } = setup();
    addClip("c", lower, { source: { kind: "image", media: { asset: "a" } } });
    const state = store.getState();
    const before = buildRenderPlan(state, "main");
    const asset = state.assets?.["a"];
    const next = { ...state, assets: { a: { ...asset, hash: "sha256-b" } } } as ProjectState;
    const after = buildRenderPlan(next, "main");
    expect(after?.layers[0]?.source).toEqual({ kind: "image", file: "sha256-b" });
    expect(before && after && samePlan(before, after)).toBe(false);
  });

  it("prepares keys once, however often a plan is built", () => {
    const value: PropertyValue = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 1 },
      ],
    };
    expect(channelOf(value, "number")).toBe(channelOf(value, "number"));
    expect(channelOf(value, "number")).not.toBe(channelOf(value, "angle"));
  });
});

describe("a large project", () => {
  const CLIPS = 5000;
  const KEYS_PER_CLIP = 10;

  /** Straight into the state, because going through 5000 commands is not what is being measured. */
  function large() {
    const { addClip, store, lower } = setup();
    addClip("seed", lower, red);
    const state = store.getState();
    const main = state.timelines["main"];
    const seed = main?.clips["seed"] as ClipState;
    const keys = Array.from({ length: KEYS_PER_CLIP }, (_, index) => ({
      time: String(index / 2),
      value: index,
    }));
    const clips = Object.fromEntries(
      Array.from({ length: CLIPS }, (_, index) => {
        const id = `clip${index}`;
        const clip: ClipState = {
          ...seed,
          id,
          start: String(index * 5),
          duration: "5",
          properties: { "transform.x": { keys } },
        };
        return [id, clip] as const;
      }),
    );
    const timelines = { ...state.timelines, main: { ...main, clips } };
    return { ...state, timelines } as ProjectState;
  }

  it("a change to one clip leaves all the others as they were", () => {
    const state = large();
    const first = buildRenderPlan(state, "main");
    if (!first) throw new Error("no plan");
    expect(first.layers).toHaveLength(CLIPS);
    const main = state.timelines["main"];
    const changed = {
      ...main?.clips["clip2500"],
      properties: { "transform.x": 5 },
    } as ClipState;
    const clips = { ...main?.clips, clip2500: changed };
    const next = {
      ...state,
      timelines: { ...state.timelines, main: { ...main, clips } },
    } as ProjectState;
    const second = buildRenderPlan(next, "main");
    if (!second) throw new Error("no plan");
    expect(samePlan(first, second)).toBe(false);
    // Doing nothing again for all of them is what makes this cheap. A clock would only tell how
    // busy the machine is.
    const rebuilt = second.layers.filter((layer, index) => layer !== first.layers[index]);
    expect(rebuilt.map(({ id }) => id)).toEqual(["clip2500"]);
  });
});

describe("the audio plan", () => {
  function withSound() {
    const context = setup();
    const { run, addClip } = context;
    run("track.add", { timeline: "main", id: "one", kind: "audio" });
    run("track.add", { timeline: "main", id: "two", kind: "audio" });
    const source = { kind: "audio", media: { asset: "a" } };
    addClip("first", "one", { source, offset: "1/2" });
    addClip("second", "two", { source, properties: { "audio.volume": -20 } });
    const sounds = () => buildAudioPlan(context.store.getState(), "main").sounds;
    return { ...context, sounds };
  }

  it("has every audio clip, with its place in the file and its volume", () => {
    const { sounds } = withSound();
    expect(sounds()).toHaveLength(2);
    expect(sounds()[0]).toMatchObject({ file: "sha256-a", start: 1, end: 3, offset: 0.5, gain: 1 });
    expect(sounds()[1]?.gain).toBeCloseTo(0.1);
  });

  it("leaves out muted tracks", () => {
    const { run, sounds } = withSound();
    run("track.update", { timeline: "main", track: "one", changes: { muted: true } });
    expect(sounds().map(({ id }) => id)).toEqual(["second"]);
  });

  it("plays only the solo track, even over a mute", () => {
    const { run, sounds } = withSound();
    run("track.update", { timeline: "main", track: "two", changes: { solo: true, muted: true } });
    expect(sounds().map(({ id }) => id)).toEqual(["second"]);
  });

  it("is empty for a timeline that is gone", () => {
    const { store } = withSound();
    expect(buildAudioPlan(store.getState(), "nothing").sounds).toEqual([]);
  });
});
