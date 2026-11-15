import { SoundFailed } from "@animaquill/audio";
import { ProjectStore, type AudioPlan, type SoundLayer } from "@animaquill/core";
import { createProject, writeProject } from "@animaquill/schema";
import type { ListenRequest } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import { SoundNotMade } from "../export/made-sounds.ts";
import { SoundListens, localMeter } from "./listens.ts";

/**
 * What AI hears in the browser (mcp.md 8): the part asked for, mixed piece by piece as the export
 * mixes it, of one clip alone where it asks, measured; a sound missing gives why and no numbers.
 */

/** A 30 s project with two sounds: music all along and a sound made by code at 12. */
function state() {
  const files = writeProject(createProject({ name: "听" }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  timeline.tracks.push({
    id: "track_music",
    kind: "audio",
    clips: [
      {
        id: "clip_music",
        start: "0",
        duration: "30",
        source: { kind: "audio", media: { asset: "music" } },
      },
      { id: "clip_ding", start: "12", duration: "1.5", source: { kind: "sound", sound: "ding" } },
    ],
  });
  files.set(path, JSON.stringify(timeline));
  const assets = JSON.parse(files.get("assets.json") ?? '{"assets":{}}') as {
    assets: Record<string, unknown>;
  };
  assets.assets.music = {
    name: "片头音乐",
    kind: "audio",
    path: "assets/music.wav",
    storage: "git",
    hash: "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=",
    info: { duration: "30" },
  };
  files.set("assets.json", JSON.stringify(assets));
  files.set("sounds/ding/sound.json", JSON.stringify({ name: "叮", entry: "main.js", runtime: 1 }));
  files.set("sounds/ding/main.js", "export default () => {};\n");
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("no project");
  return store.getState();
}

const request = (extra: Partial<ListenRequest> = {}): ListenRequest => ({
  state: state(),
  timeline: "main",
  from: 0,
  to: 25,
  envelope: false,
  buckets: 10,
  ...extra,
});

/** A mixer that gives a sine at −20 dBFS, or fails as `fail` says, and keeps what it was asked. */
function setUp(fail?: (plan: AudioPlan) => Error | undefined) {
  const plans: AudioPlan[] = [];
  const pieces: [number, number][] = [];
  let closed = 0;
  const listens = new SoundListens({
    meter: localMeter,
    mixer: (plan) => {
      plans.push(plan);
      return {
        mix: async (from, frames) => {
          pieces.push([from, frames]);
          const error = fail?.(plan);
          if (error) throw error;
          const samples = new Float32Array(frames);
          for (let index = 0; index < frames; index += 1)
            samples[index] =
              0.1 * Math.sin((2 * Math.PI * 1000 * (from * 48_000 + index)) / 48_000);
          return { numberOfChannels: 2, getChannelData: () => samples } as unknown as AudioBuffer;
        },
        close: () => {
          closed += 1;
        },
      };
    },
  });
  return { listens, plans, pieces, closed: () => closed };
}

describe("hearing the sound for AI", () => {
  it("mixes the part asked for in pieces of 10 s, and measures it", async () => {
    const { listens, plans, pieces, closed } = setUp();
    const answer = await listens.listen(request(), new AbortController().signal);
    expect(plans[0]?.sounds.map(({ id }) => id)).toEqual(["clip_music", "clip_ding"]);
    expect(pieces).toEqual([
      [0, 480_000],
      [10, 480_000],
      [20, 240_000],
    ]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.heard.seconds).toBe(25);
    expect(answer.heard.integrated).toBeCloseTo(-20, 1);
    expect(answer.heard.wave).toHaveLength(10);
    expect(answer.heard.envelope).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it("hears one clip alone where it is asked, with its envelope", async () => {
    const { listens, plans } = setUp();
    const answer = await listens.listen(
      request({ only: "clip_ding", from: 12, to: 13.5, envelope: true }),
      new AbortController().signal,
    );
    expect(plans[0]?.sounds.map(({ id }) => id)).toEqual(["clip_ding"]);
    expect(answer.ok && answer.heard.envelope).toBeTruthy();
  });

  it("says which sound is missing, or was not made, and stops with the task", async () => {
    const layer = (id: string) => ({ id, file: `file-${id}` }) as SoundLayer;
    const missing = await setUp(
      () => new SoundFailed(layer("clip_music"), "missing-file"),
    ).listens.listen(request(), new AbortController().signal);
    expect(missing).toEqual({
      ok: false,
      failure: { reason: "missing-file", layer: "clip_music", file: "file-clip_music" },
    });
    const unmade = await setUp(
      () => new SoundNotMade(layer("clip_ding"), "too-new"),
    ).listens.listen(request(), new AbortController().signal);
    expect(unmade).toEqual({
      ok: false,
      failure: { reason: "not-made", layer: "clip_ding", why: "too-new" },
    });
    const stop = new AbortController();
    stop.abort();
    const stopped = await setUp().listens.listen(request(), stop.signal);
    expect(stopped).toEqual({ ok: false, failure: { reason: "stopped" } });
  });
});
