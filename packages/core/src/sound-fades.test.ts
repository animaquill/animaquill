import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { buildAudioPlan } from "./render-plan.ts";
import { fadeGainAt, fadesGainAt, type SoundFade } from "./sound-fades.ts";
import { ProjectStore } from "./store.ts";

/** Transitions of sound: their gain curves, and where the audio plan has them. */

const over = (
  way: SoundFade["way"],
  shape: SoundFade["shape"],
  more: Partial<SoundFade> = {},
): SoundFade => ({ use: "join", way, shape, start: 2, end: 4, duration: 2, ...more });

describe("the gain of a transition of sound", () => {
  it("goes as cos and sin for fade, at the start, the middle and the end", () => {
    const out = over("out", "power");
    const into = over("in", "power");
    expect([1, 2, 4, 5].map((at) => fadeGainAt(out, at))).toEqual([1, 1, 0, 0]);
    expect([1, 2, 4, 5].map((at) => fadeGainAt(into, at))).toEqual([0, 0, 1, 1]);
    expect(fadeGainAt(out, 3)).toBeCloseTo(Math.SQRT1_2, 15);
    expect(fadeGainAt(into, 3)).toBeCloseTo(Math.SQRT1_2, 15);
    // A quarter of the way: cos(π/8) and sin(π/8).
    expect(fadeGainAt(out, 2.5)).toBeCloseTo(Math.cos(Math.PI / 8), 12);
    expect(fadeGainAt(into, 2.5)).toBeCloseTo(Math.sin(Math.PI / 8), 12);
  });

  it("goes as 1 − p and p for fade-linear", () => {
    const out = over("out", "gain");
    const into = over("in", "gain");
    expect([2, 2.5, 3, 3.5, 4].map((at) => fadeGainAt(out, at))).toEqual([1, 0.75, 0.5, 0.25, 0]);
    expect([2, 2.5, 3, 3.5, 4].map((at) => fadeGainAt(into, at))).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("keeps the power of a cross-fade with fade, and its gain with fade-linear", () => {
    for (let at = 1.9; at <= 4.1; at += 0.01) {
      const power =
        fadeGainAt(over("out", "power"), at) ** 2 + fadeGainAt(over("in", "power"), at) ** 2;
      const gain = fadeGainAt(over("out", "gain"), at) + fadeGainAt(over("in", "gain"), at);
      expect(power).toBeCloseTo(1, 12);
      expect(gain).toBeCloseTo(1, 12);
    }
  });

  it("goes by its speed curve", () => {
    const easeIn = over("in", "gain", { curve: [0.42, 0, 1, 1] });
    // Ease in is slow at first: less than halfway at half the time, as CSS has it (0.315).
    expect(fadeGainAt(easeIn, 3)).toBeCloseTo(0.3153, 3);
    expect(fadeGainAt(easeIn, 2)).toBe(0);
    expect(fadeGainAt(easeIn, 4)).toBe(1);
  });

  it("is all of them together, and 1 without any", () => {
    const enter = over("in", "gain", { use: "enter", start: 0, end: 1, duration: 1 });
    const exit = over("out", "gain", { use: "exit", start: 0.5, end: 1.5, duration: 1 });
    expect(fadesGainAt(undefined, 3)).toBe(1);
    expect(fadesGainAt([enter, exit], 0.25)).toBe(0.25);
    expect(fadesGainAt([enter, exit], 0.75)).toBeCloseTo(0.75 * 0.75, 12);
    expect(fadesGainAt([enter, exit], 1.5)).toBe(0);
  });
});

describe("the audio plan of transitions of sound", () => {
  const sound = { kind: "audio", media: { asset: "tone" } };
  /** Clips on the audio track and joins, as a file has them. */
  const planOf = (more: (audio: any) => void, muted = false) => {
    const files = writeProject(createProject({ name: "声音" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(files.get(path) as string);
    const audio = timeline.tracks.find(({ kind }: { kind: string }) => kind === "audio");
    more(audio);
    if (muted) audio.muted = true;
    files.set(path, JSON.stringify(timeline));
    files.set(
      "assets.json",
      JSON.stringify({
        assets: { tone: { kind: "audio", path: "a.wav", storage: "git", hash: "sha256-a" } },
      }),
    );
    const { store, problems } = ProjectStore.open(files);
    if (!store) throw new Error(JSON.stringify(problems));
    // The track of each sound is the same one here.
    const { sounds } = buildAudioPlan(store.getState(), "main");
    return { sounds: sounds.map(({ track: _track, ...layer }) => layer) };
  };

  it("has the transitions at the edges of a clip, as fades of its gain", () => {
    const { sounds } = planOf((audio) => {
      audio.clips.push({
        id: "s",
        start: "1",
        duration: "4",
        offset: "2",
        source: sound,
        enter: { type: "fade", duration: "1/2" },
        exit: { type: "fade-linear", duration: "1", curve: [0, 0, 0.58, 1] },
      });
    });
    expect(sounds).toEqual([
      {
        id: "s",
        file: "sha256-a",
        start: 1,
        end: 5,
        offset: 2,
        gain: 1,
        fades: [
          { use: "enter", way: "in", shape: "power", start: 1, end: 1.5, duration: 0.5 },
          {
            use: "exit",
            way: "out",
            shape: "gain",
            start: 4,
            end: 5,
            duration: 1,
            curve: [0, 0, 0.58, 1],
          },
        ],
      },
    ]);
  });

  it("has a join go on past the cut on each side, on its own clock, in place of their edges", () => {
    const { sounds } = planOf((audio) => {
      audio.clips.push(
        {
          id: "a",
          start: "0",
          duration: "2",
          offset: "3",
          source: sound,
          exit: { type: "fade", duration: "1" },
        },
        // Its file starts at the clip: before the cut it would read before 0, which is silent.
        {
          id: "b",
          start: "2",
          duration: "2",
          source: sound,
          enter: { type: "fade", duration: "1" },
        },
      );
      audio.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    const join = { use: "join", shape: "power", start: 1.5, end: 2.5, duration: 1 };
    expect(sounds).toEqual([
      {
        id: "a",
        file: "sha256-a",
        start: 0,
        end: 2.5,
        offset: 3,
        gain: 1,
        fades: [{ ...join, way: "out" }],
      },
      {
        id: "b",
        file: "sha256-a",
        start: 1.5,
        end: 4,
        offset: -0.5,
        gain: 1,
        fades: [{ ...join, way: "in" }],
      },
    ]);
  });

  it("plays what this editor cannot do as a fade, and says so", () => {
    const { sounds } = planOf((audio) => {
      audio.clips.push({
        id: "s",
        start: "0",
        duration: "2",
        source: sound,
        enter: { type: "wipe", duration: "1" },
      });
    });
    expect(sounds[0]?.fades).toEqual([
      { use: "enter", way: "in", shape: "power", missing: true, start: 0, end: 1, duration: 1 },
    ]);
  });

  it("has nothing of a track that is not heard", () => {
    const { sounds } = planOf((audio) => {
      audio.clips.push({
        id: "s",
        start: "0",
        duration: "2",
        source: sound,
        enter: { type: "fade", duration: "1" },
      });
    }, true);
    expect(sounds).toEqual([]);
  });
});
