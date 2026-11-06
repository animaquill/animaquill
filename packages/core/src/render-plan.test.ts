import { describe, expect, it } from "vitest";
import { createProject } from "@animaquill/schema";
import { orderedTracks } from "./model.ts";
import { buildAudioPlan, buildRenderPlan } from "./render-plan.ts";
import { ProjectStore } from "./store.ts";

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
