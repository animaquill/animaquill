import { effectsOf, type ClipState } from "@animaquill/core";
import { REVERB_PRESETS, effectPath } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { cookbook, responseDb } from "@animaquill/audio";
import { writeEdit } from "../properties/inspect.ts";
import {
  EQ_BANDS,
  bandOn,
  dragTo,
  frequencyOfX,
  gainOfY,
  qAfterWheel,
  responseAt,
  xOfFrequency,
  yOfGain,
} from "../properties/sound-effects/eq-graph.ts";
import {
  dbOfShare,
  kneePoint,
  ratioAt,
  shareOfDb,
  thresholdAt,
} from "../properties/sound-effects/compressor-graph.ts";
import { setup } from "./test-support.ts";
import { MASTER_CLIP, withTrackClips } from "./track-clip.ts";

/**
 * Effects of sound in the interface (audio-mixing.md 1.3, 1.6): put on tracks and the master from
 * the tab and the mixer, moved and turned off there, their parameters written as the graphs write
 * them, each in one step.
 */

describe("effects of sound on tracks and the master", () => {
  it("go on a track of sound, last or at a place, and come off again with undo", async () => {
    const { store, timeline, audio } = await setup();
    expect(timeline.attachEffectTo(audio, "eq")).toBe(true);
    expect(timeline.attachEffectTo(audio, "compressor", 0)).toBe(true);
    const track = () => store.getState().timelines["main"]?.tracks[audio];
    const types = () =>
      (track() as { effects?: { type: string }[] }).effects?.map(({ type }) => type);
    expect(types()).toEqual(["compressor", "eq"]);
    // A drop on the track selects it, and its list goes to the new one.
    expect(timeline.getSnapshot().track).toBe(audio);
    store.undo();
    expect(types()).toEqual(["eq"]);
    // Not those of pictures, and not on a track of pictures.
    expect(timeline.attachEffectTo(audio, "blur")).toBe(false);
  });

  it("go on the master, and the mixer moves, turns off and takes them off, one step each", async () => {
    const { store, timeline } = await setup();
    timeline.attachEffectTo(MASTER_CLIP, "eq");
    timeline.attachEffectTo(MASTER_CLIP, "limiter");
    const master = () => store.getState().timelines["main"]?.mix?.master;
    const list = () => master()?.effects ?? [];
    const [eq, limiter] = list();
    expect(eq?.type).toBe("eq");
    expect(timeline.moveEffect(MASTER_CLIP, limiter?.id as string, 0)).toBe(true);
    expect(list().map(({ type }) => type)).toEqual(["limiter", "eq"]);
    expect(timeline.setEffectEnabled(MASTER_CLIP, eq?.id as string, false)).toBe(true);
    expect(list()[1]?.enabled).toBe(false);
    expect(timeline.removeEffect(MASTER_CLIP, eq?.id as string)).toBe(true);
    expect(list().map(({ type }) => type)).toEqual(["limiter"]);
    store.undo();
    store.undo();
    store.undo();
    expect(list().map(({ type }) => type)).toEqual(["eq", "limiter"]);
  });

  it("go on a selected clip of sound with a click in the tab, or on the selected track", async () => {
    const { store, timeline, audio } = await setup();
    store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: audio,
        id: "s",
        start: "0",
        duration: "2",
        source: { kind: "audio", media: { asset: "a" } },
      },
    });
    timeline.selectOnly("s");
    expect(timeline.effectProblem("reverb")).toBeUndefined();
    expect(timeline.attachEffect("reverb")).toBe(1);
    const clip = store.getState().timelines["main"]?.clips["s"] as ClipState;
    expect(effectsOf(clip).map(({ type }) => type)).toEqual(["reverb"]);
    // Effects of pictures are not for it.
    expect(timeline.effectProblem("blur")).toBe("sound");
    timeline.selectTrack(audio);
    expect(timeline.attachEffect("limiter")).toBe(1);
    const track = store.getState().timelines["main"]?.tracks[audio] as { effects?: unknown[] };
    expect(track.effects).toHaveLength(1);
    // A clip of pictures takes no effect of sound.
    timeline.selectOnly("c");
    expect(timeline.effectProblem("eq")).toBe("picture");
  });

  it("write the preset of a reverb as one step", async () => {
    const { store, timeline, writer, rows, audio } = await setup();
    timeline.attachEffectTo(audio, "reverb");
    const model = timeline.model;
    if (!model) throw new Error("no timeline");
    const box = withTrackClips(model).boxes.get(`~track:${audio}`);
    const effect = effectsOf(box?.clip as ClipState)[0]?.id as string;
    const hall = REVERB_PRESETS["hall"] as Record<string, number>;
    const edits = Object.entries(hall).map(([name, value]) => {
      const spec = { path: effectPath(effect, name), type: "number" as const };
      const now = rows.inspect(`~track:${audio}`, spec);
      if (!now) throw new Error("no row");
      return writeEdit(`~track:${audio}`, now.row, now.time, value);
    });
    expect(writer.commit(edits)).toBe(true);
    const properties = () => {
      const track = store.getState().timelines["main"]?.tracks[audio];
      return (track as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    };
    expect(properties()[effectPath(effect, "decay")]).toBe(2.2);
    expect(properties()[effectPath(effect, "mix")]).toBe(0.3);
    store.undo();
    expect(properties()[effectPath(effect, "decay")]).toBeUndefined();
    expect(properties()[effectPath(effect, "mix")]).toBeUndefined();
  });
});

describe("the graph of an equalizer", () => {
  it("puts frequencies on a log scale and gains on ±24 dB, and back", () => {
    expect(xOfFrequency(20)).toBe(0);
    expect(xOfFrequency(20_000)).toBeCloseTo(1, 12);
    expect(frequencyOfX(xOfFrequency(1000))).toBeCloseTo(1000, 9);
    expect(yOfGain(24)).toBe(0);
    expect(yOfGain(-24)).toBe(1);
    expect(gainOfY(yOfGain(-7.5))).toBeCloseTo(-7.5, 12);
  });

  it("drags a band across for its frequency and up and down for its gain, a pass only across", () => {
    const mid2 = EQ_BANDS.find(({ name }) => name === "mid2");
    const hp = EQ_BANDS.find(({ name }) => name === "hp");
    if (!mid2 || !hp) throw new Error("no bands");
    expect(dragTo(mid2, xOfFrequency(1000), yOfGain(-12))).toEqual({
      "mid2.freq": 1000,
      "mid2.gain": -12,
    });
    expect(dragTo(hp, xOfFrequency(120), yOfGain(10))).toEqual({ "hp.freq": 120 });
  });

  it("narrows a peak with the wheel up and widens it down, within 0.1 to 18", () => {
    expect(qAfterWheel(1, 1)).toBe(1.12);
    expect(qAfterWheel(1, -1)).toBe(0.89);
    expect(qAfterWheel(17.9, 3)).toBe(18);
    expect(qAfterWheel(0.11, -3)).toBe(0.1);
  });

  it("knows which bands do something, and draws what the engine does", () => {
    const values = { "hp.on": true, "hp.freq": 100, "mid2.gain": -6, "mid2.q": 2 };
    expect(EQ_BANDS.filter((band) => bandOn(values, band)).map(({ name }) => name)).toEqual([
      "hp",
      "mid2",
    ]);
    const want =
      responseDb(cookbook("highpass", 100, 0, Math.SQRT1_2), 1000) +
      responseDb(cookbook("peak", 1000, -6, 2), 1000);
    expect(responseAt(values, 1000)).toBeCloseTo(want, 9);
    expect(responseAt({}, 1000)).toBe(0);
  });
});

describe("the graph of a compressor", () => {
  it("has its knee at the threshold, and drags it across", () => {
    expect(kneePoint({ threshold: -30, ratio: 4, knee: 6 })).toEqual({ x: 0.5, y: 0.5 });
    expect(thresholdAt(shareOfDb(-18))).toBe(-18);
    expect(dbOfShare(2)).toBe(0);
  });

  it("takes the ratio from where the line after the knee is dragged", () => {
    const shape = { threshold: -30, ratio: 1, knee: 0 };
    // 20 dB in above the threshold, 5 dB out: 4:1.
    expect(ratioAt(shape, shareOfDb(-10), 1 - shareOfDb(-25))).toBe(4);
    // Straight on: 1:1; flat: the most there is.
    expect(ratioAt(shape, shareOfDb(-10), 1 - shareOfDb(-10))).toBe(1);
    expect(ratioAt(shape, shareOfDb(-10), 1 - shareOfDb(-30))).toBe(20);
  });
});
