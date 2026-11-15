import { ProjectStore } from "@animaquill/core";
import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { testHost, toolsOn } from "./test-support.ts";
import type { ListenData } from "./tools/listen.ts";
import type { Heard, ListenAnswer, ListenRequest } from "./types.ts";

/**
 * aq_audio_analyze with a meter that pretends (mcp.md 8, 6.11a): what it asks the editor to mix,
 * the lines the model reads and the data people see, the clip alone, and what it refuses.
 */

/** A 30 s project with music on one track and a sound made by code on another, muted or not. */
function project(muted = false): ProjectStore {
  const files = writeProject(createProject({ name: "听" }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  timeline.tracks.push(
    {
      id: "track_music",
      kind: "audio",
      clips: [
        {
          id: "clip_music",
          name: "配乐",
          start: "0",
          duration: "30",
          source: { kind: "audio", media: { asset: "music" } },
        },
      ],
    },
    {
      id: "track_fx",
      kind: "audio",
      ...(muted && { muted: true }),
      clips: [
        {
          id: "clip_ding",
          name: "叮",
          start: "12",
          duration: "1.5",
          source: { kind: "sound", sound: "ding" },
        },
      ],
    } as never,
  );
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
  if (!store) throw new Error("the project did not open");
  return store;
}

const HEARD: Heard = {
  seconds: 30,
  integrated: -13.84,
  shortTermMax: -9.21,
  momentaryMax: -7.5,
  truePeak: -0.38,
  samplePeak: -0.61,
  clipping: { places: 2, samples: 37 },
  clips: [
    { from: 11.4, to: 11.41, samples: 12 },
    { from: 22.1, to: 22.12, samples: 25 },
  ],
  silences: [{ from: 18.6, to: 19.5 }],
  silent: false,
  envelope: { peak: -6, peakAt: 0.012, onset: 0.001, attack: 0.012, decay: 0.8, cut: false },
  wave: [0.2, 0.9, 0.5],
};

function setUp(
  answer: (request: ListenRequest) => ListenAnswer = () => ({ ok: true, heard: HEARD }),
  muted = false,
) {
  const store = project(muted);
  const asked: ListenRequest[] = [];
  const listen = async (request: ListenRequest) => {
    asked.push(request);
    return answer(request);
  };
  return { store, asked, ...toolsOn({ ...testHost(store), listen }) };
}

const listenOf = (data: unknown) => (data as { listen: ListenData }).listen;

describe("aq_audio_analyze", () => {
  it("measures the whole mix by default: loudness, silence and clipping, with times on the timeline", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_audio_analyze", {});
    expect(result.isError).toBe(false);
    expect(asked[0]).toMatchObject({ timeline: "main", from: 0, to: 30, envelope: false });
    expect(asked[0]?.only).toBeUndefined();
    const lines = result.text.split("\n").slice(1);
    expect(lines).toEqual([
      'the mix of timeline main "主线" from 0 to 30 (30 s), as the export mixes it: stereo, 48000 Hz',
      "loudness: integrated -13.8 LUFS; short-term max -9.2 LUFS; true peak -0.4 dBTP; sample peak -0.6 dBFS",
      "silence (below -50 dBFS for 0.3 s or longer): 18.6-19.5",
      "clipping: 2 place(s), 37 sample(s) at or over full scale: t=11.4 (12 samples), t=22.1 (25 samples)",
    ]);
    const data = listenOf(result.data);
    expect(data).toMatchObject({
      timeline: "main",
      from: 0,
      to: 30,
      integrated: -13.84,
      truePeak: -0.38,
      clipping: { places: 2, samples: 37 },
      clips: [
        { from: 11.4, to: 11.41 },
        { from: 22.1, to: 22.12 },
      ],
      silences: [{ from: 18.6, to: 19.5 }],
      wave: [0.2, 0.9, 0.5],
    });
    expect(data.envelope).toBeUndefined();
  });

  it("measures a clip alone over its time, with its envelope, and says its sound is made by code", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_audio_analyze", { clip: "clip_ding" });
    expect(result.isError).toBe(false);
    expect(asked[0]).toMatchObject({ from: 12, to: 13.5, only: "clip_ding", envelope: true });
    expect(result.text).toContain(
      'clip clip_ding "叮" alone of timeline main "主线" from 12 to 13.5',
    );
    // Times of the result are on the timeline: the meter's are from the start of what it mixed.
    expect(result.text).toContain(
      "envelope: peak -6.0 dBFS at t=12.012; starts at t=12.001; attack 12 ms (10% to 90% of the peak); decay 0.8 s (from the peak to 40 dB below it)",
    );
    expect(result.text).not.toContain("silence");
    const data = listenOf(result.data);
    expect(data).toMatchObject({ clip: "clip_ding", clipName: "叮", made: true });
    expect(data.envelope).toEqual({ peak: -6, attack: 0.012, decay: 0.8 });
    expect(data.clips).toEqual([
      { from: 23.4, to: 23.41 },
      { from: 34.1, to: 34.12 },
    ]);
  });

  it("takes a range and the measures asked for, in its order", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_audio_analyze", {
      range: { from: "10", to: "20" },
      what: ["clipping", "loudness"],
    });
    expect(asked[0]).toMatchObject({ from: 10, to: 20 });
    const lines = result.text.split("\n").slice(2);
    expect(lines[0]).toMatch(/^loudness: /);
    expect(lines[1]).toMatch(/^clipping: /);
    expect(lines).toHaveLength(2);
  });

  it("refuses a clip nobody hears, a range past the end or too long, and says where nothing mixes", async () => {
    const muted = setUp(undefined, true);
    const silent = await muted.call("aq_audio_analyze", { clip: "clip_ding" });
    expect(silent.text).toMatch(/^error invalid-params: clip clip_ding "叮" is not heard/);
    expect(muted.asked).toHaveLength(0);
    const { call, asked } = setUp();
    expect((await call("aq_audio_analyze", { range: { from: "0", to: "31" } })).text).toMatch(
      /^error out-of-range: range.to 31 is past the end of timeline main/,
    );
    expect((await call("aq_audio_analyze", { range: { from: "5", to: "5" } })).text).toContain(
      "range.from has to be before range.to",
    );
    expect((await call("aq_audio_analyze", { clip: "clip_nope" })).text).toMatch(
      /^error not-found: no clip "clip_nope"/,
    );
    expect(asked).toHaveLength(0);
  });

  it("gives no numbers where a sound is missing, and why", async () => {
    const { call } = setUp(() => ({
      ok: false,
      failure: { reason: "missing-file", layer: "clip_music", file: "x" },
    }));
    const result = await call("aq_audio_analyze", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'error mix-failed: the sound from 0 to 30 cannot be mixed: clip clip_music "配乐" plays asset music "片头音乐", whose file is not on this computer. A mix with a sound missing is not what the export gives, so nothing was measured.',
    );
    expect(listenOf(result.data).failure).toMatchObject({
      reason: "missing-file",
      clipName: "配乐",
      assetName: "片头音乐",
    });
  });

  it("is not available where nothing mixes, as through MCP", async () => {
    const { call } = toolsOn(testHost(project()));
    const result = await call("aq_audio_analyze", {});
    expect(result.text).toBe(
      "error not-available: this place cannot mix sound; the AnimaQuill editor in the browser can.",
    );
  });
});
