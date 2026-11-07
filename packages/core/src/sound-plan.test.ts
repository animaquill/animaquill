import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { orderedTracks, sourceLength, type ClipState } from "./model.ts";
import { objectsOf } from "./objects.ts";
import { buildAudioPlan } from "./render-plan.ts";
import { madeSoundOf, madeSoundsOf, SOUND_SAMPLE_RATE } from "./sound-plan.ts";
import { ProjectStore, type CommandCall } from "./store.ts";

const CODE = "aq.sound(({ frames }) => new Float32Array(frames));";

function open() {
  const store = ProjectStore.create(createProject({ name: "声音" }));
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params } as CommandCall);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  };
  const track = "sounds";
  run("track.add", { timeline: "main", id: track, kind: "audio" });
  const addSound = (id = "s", manifest: object = {}, files: object = { "sound.js": CODE }) =>
    run("sound.add", {
      id,
      sound: { name: "铃", entry: "sound.js", runtime: 1, ...manifest },
      files,
    });
  const addClip = (id = "c", changes: object = {}) =>
    run("clip.add", {
      timeline: "main",
      track,
      clip: {
        id,
        start: "0",
        duration: "2",
        source: { kind: "sound", sound: "s" },
        properties: { "param.duration": 2 },
        ...changes,
      },
    });
  const clip = (id = "c") => store.getState().timelines["main"]?.clips[id] as ClipState;
  const made = (id = "c") => {
    const sound = madeSoundOf(store.getState(), clip(id));
    if (!sound) throw new Error("no sound");
    return sound;
  };
  return { store, run, addSound, addClip, clip, made, track };
}

describe("what a clip plays", () => {
  it("knows everything it takes to make the sound", () => {
    const { addSound, addClip, made } = open();
    addSound("s", { params: [{ id: "pitch", name: "音高", type: "number", default: 440 }] });
    addClip();
    expect(made()).toMatchObject({
      sound: "s",
      entry: "sounds/s/sound.js",
      runtime: 1,
      sampleRate: SOUND_SAMPLE_RATE,
      duration: 2,
      params: { duration: 2, pitch: 440 },
    });
  });

  it("has no sound when the sound is not there, and nothing for other clips", () => {
    const { store, addSound, addClip, clip, run } = open();
    addSound();
    addClip();
    run("clip.remove", { timeline: "main", clips: ["c"] });
    const gone = { id: "g", track: "sounds", start: "0", duration: "1" };
    const missing = { ...gone, source: { kind: "sound", sound: "nope" } } as ClipState;
    expect(madeSoundOf(store.getState(), missing)).toBeUndefined();
    const color = { ...gone, source: { kind: "color", color: "#000000" } } as ClipState;
    expect(madeSoundOf(store.getState(), color)).toBeUndefined();
    expect(clip()).toBeUndefined();
  });
});

describe("the name of a sound", () => {
  /** Everything here has to change it. */
  it.each<[string, (t: ReturnType<typeof open>) => void]>([
    ["its code", ({ run }) => run("file.write", { path: "sounds/s/sound.js", text: `${CODE}//` })],
    ["another file of it", ({ run }) => run("file.write", { path: "sounds/s/a.js", text: "1" })],
    ["shared code", ({ run }) => run("file.write", { path: "code/a.js", text: "1" })],
    ["a parameter", (t) => t.run("property.edit", edit("param.a", 1))],
    ["the seed", (t) => t.run("property.edit", edit("param.seed", 9))],
    ["the length", (t) => t.run("property.edit", edit("param.duration", 3))],
    [
      "the output",
      (t) =>
        t.run("clip.update", {
          timeline: "main",
          clip: "c",
          changes: { source: { kind: "sound", sound: "s", output: "b" } },
        }),
    ],
    [
      "the runtime",
      (t) => t.run("sound.update", { sound: "s", changes: { runtime: 1, entry: "b.js" } }),
    ],
  ])("changes with %s", (_, change) => {
    const context = open();
    context.addSound("s", {}, { "sound.js": CODE, "b.js": CODE });
    context.addClip();
    const { file } = context.made();
    change(context);
    expect(context.made().file).not.toBe(file);
  });

  /** And nothing here may: making it again takes time, and would change what people hear. */
  it.each<[string, (t: ReturnType<typeof open>) => void]>([
    ["moving the clip", (t) => t.run("clip.update", clipTimes({ start: "5" }))],
    ["trimming the end", (t) => t.run("clip.update", clipTimes({ duration: "1" }))],
    ["trimming the start", (t) => t.run("clip.update", clipTimes({ offset: "1", duration: "1" }))],
    ["the volume", (t) => t.run("property.edit", edit("audio.volume", -6))],
    ["the name", (t) => t.run("clip.update", clipTimes({ name: "别的" }))],
    ["the code of another sound", (t) => t.run("sound.add", otherSound)],
    [
      "the name of the sound",
      (t) => t.run("sound.update", { sound: "s", changes: { name: "钟" } }),
    ],
  ])("stays with %s", (_, change) => {
    const context = open();
    context.addSound();
    context.addClip();
    const { file } = context.made();
    change(context);
    expect(context.made().file).toBe(file);
  });

  it("changes with how far the clip reaches, when nothing else says how long it is", () => {
    const { addSound, addClip, made, run } = open();
    addSound();
    addClip("c", { properties: {} });
    const { file } = made();
    run("clip.update", clipTimes({ duration: "1" }));
    expect(made().file).not.toBe(file);
  });

  it("is the same for both halves of a cut, and those go on with the same sound", () => {
    const { addSound, addClip, made, run, store } = open();
    addSound();
    addClip();
    const { file } = made();
    run("clip.split", { timeline: "main", clip: "c", at: "1" });
    const clips = Object.keys(store.getState().timelines["main"]?.clips ?? {});
    expect(clips).toHaveLength(2);
    for (const id of clips) expect(made(id).file).toBe(file);
  });

  it("does not depend on how the parameters are written", () => {
    const { addSound, addClip, made } = open();
    addSound();
    const properties = (first: object, second: object) => ({ properties: { ...first, ...second } });
    addClip("a", properties({ "param.a": 1 }, { "param.b": 2 }));
    addClip("b", { start: "5", ...properties({ "param.b": 2 }, { "param.a": 1 }) });
    expect(made("a").file).toBe(made("b").file);
  });

  it("is the same in two projects with the same sound, which is what makes it worth keeping", () => {
    const [first, second] = [open(), open()];
    for (const { addSound, addClip } of [first, second]) {
      addSound();
      addClip();
    }
    expect(first.made().file).toBe(second.made().file);
  });
});

const edit = (path: string, value: number) => ({
  timeline: "main",
  edits: [{ owner: { clip: "c" }, path, op: "set", value }],
});
const clipTimes = (changes: object) => ({ timeline: "main", clip: "c", changes });
const otherSound = {
  id: "other",
  sound: { name: "鼓", entry: "sound.js", runtime: 1 },
  files: { "sound.js": CODE },
};

describe("the seed", () => {
  it("is what the clip says, as a whole number", () => {
    const { addSound, addClip, made } = open();
    addSound();
    addClip("c", { properties: { "param.duration": 2, "param.seed": 7.9 } });
    expect(made().seed).toBe(7);
  });

  it("is what the sound starts out with when the clip says nothing", () => {
    const { addSound, addClip, made } = open();
    addSound("s", { params: [{ id: "seed", name: "种子", type: "number", default: 42 }] });
    addClip();
    expect(made().seed).toBe(42);
  });

  it("without any stays the same for a sound, and differs between sounds", () => {
    const { addSound, addClip, made, run } = open();
    addSound();
    addSound("t");
    addClip();
    addClip("d", { start: "5", source: { kind: "sound", sound: "t" } });
    const { seed } = made();
    run("clip.update", clipTimes({ start: "9" }));
    expect(made().seed).toBe(seed);
    expect(made("d").seed).not.toBe(seed);
  });
});

describe("the length of a sound", () => {
  it("comes from the clip, then from the sound", () => {
    const { addSound, addClip, made, clip, store } = open();
    addSound("s", { params: [{ id: "duration", name: "时长", type: "number", default: 4 }] });
    addClip("c", { properties: {} });
    expect(made().duration).toBe(4);
    addClip("d", { start: "5", properties: { "param.duration": 1 } });
    expect(made("d").duration).toBe(1);
    expect(sourceLength(store.getState(), clip("c"))).toEqual({ n: 4n, d: 1n });
  });

  it("is as far as the clip reaches when nothing says, and has no end then", () => {
    const { addSound, addClip, made, clip, store } = open();
    addSound();
    addClip("c", { offset: "1", properties: {} });
    expect(made().duration).toBe(3);
    expect(sourceLength(store.getState(), clip())).toBeUndefined();
  });

  it("goes by the first key of a parameter that has keys", () => {
    const { addSound, addClip, made } = open();
    addSound();
    const keys = {
      keys: [
        { time: "0", value: 3 },
        { time: "1", value: 9 },
      ],
    };
    addClip("c", { properties: { "param.duration": keys } });
    expect(made().duration).toBe(3);
  });

  it("does not take what is no length", () => {
    const { addSound, addClip, made } = open();
    addSound();
    addClip("c", { properties: { "param.duration": -1 } });
    expect(made().duration).toBe(2);
    addClip("d", { start: "5", properties: { "param.duration": "long" } });
    expect(made("d").duration).toBe(2);
  });
});

describe("the sounds of a timeline", () => {
  it("are there once each, the first one on the timeline first", () => {
    const { store, addSound, addClip } = open();
    addSound();
    addSound("t");
    addClip("late", { start: "5" });
    addClip("early", { source: { kind: "sound", sound: "t" } });
    addClip("again", { start: "9" });
    const sounds = madeSoundsOf(store.getState(), "main");
    expect(sounds.map(({ sound }) => sound)).toEqual(["t", "s"]);
  });
});

describe("the audio plan", () => {
  it("plays a sound like any other file, and says that code makes it", () => {
    const { store, addSound, addClip, made } = open();
    addSound();
    addClip("c", { start: "1", offset: "0.5", duration: "1" });
    expect(buildAudioPlan(store.getState(), "main").sounds).toEqual([
      { id: "c", file: made().file, start: 1, end: 2, offset: 0.5, gain: 1, made: true },
    ]);
  });

  it("goes by the volume of the clip", () => {
    const { store, addSound, addClip } = open();
    addSound();
    addClip("c", { properties: { "param.duration": 2, "audio.volume": -6 } });
    expect(buildAudioPlan(store.getState(), "main").sounds[0]?.gain).toBeCloseTo(10 ** (-6 / 20));
  });

  it("takes what people are trying out over what is saved", () => {
    const { store, addSound, addClip } = open();
    addSound();
    addClip("c", { properties: { "param.duration": 2, "audio.volume": -20 } });
    const plan = buildAudioPlan(store.getState(), "main", () => 0);
    expect(plan.sounds[0]?.gain).toBe(1);
  });

  it("leaves out a muted track, a hidden clip, and a sound that is not there", () => {
    const { store, addSound, addClip, run } = open();
    addSound();
    addClip("hidden", { hidden: true });
    expect(buildAudioPlan(store.getState(), "main").sounds).toEqual([]);
    addClip("c", { start: "5" });
    run("track.update", { timeline: "main", track: "sounds", changes: { muted: true } });
    expect(buildAudioPlan(store.getState(), "main").sounds).toEqual([]);
  });
});

describe("what a clip with a sound offers", () => {
  it("is its volume, which has one value for the whole clip", () => {
    const { addSound, addClip, clip } = open();
    addSound();
    addClip();
    const [object] = objectsOf(clip());
    expect(object?.properties.map(({ path }) => path)).toEqual(["audio.volume"]);
    expect(object?.properties[0]?.animatable).toBe(false);
  });
});

describe("a track of sounds", () => {
  it("is where they go", () => {
    const { store, track } = open();
    const main = store.getState().timelines["main"];
    expect(
      main && orderedTracks(main).some(({ id, kind }) => id === track && kind === "audio"),
    ).toBe(true);
  });
});
