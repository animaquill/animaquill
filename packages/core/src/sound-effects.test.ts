import { checkProject, createProject, readProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { effectsOf, type ClipState } from "./model.ts";
import { buildMixPlan, masterLimited } from "./render-plan.ts";
import { ProjectStore, type CommandCall } from "./store.ts";

/**
 * Effects of sound and the master (audio-mixing.md 2.4, 2.5, 2.8, 3): the commands on clips of
 * sound, tracks and the master, `property.edit` of the master, what the files and the mix plan
 * have of them, and what a check says.
 */

function project() {
  const store = ProjectStore.create(createProject({ name: "混音" }));
  const tracks = Object.values(store.getState().timelines["main"]?.tracks ?? {});
  const video = tracks.find(({ kind }) => kind === "video")?.id as string;
  const audio = tracks.find(({ kind }) => kind === "audio")?.id as string;
  const added = store.execute({
    type: "clip.add",
    params: {
      timeline: "main",
      track: audio,
      id: "s",
      start: "0",
      duration: "4",
      source: { kind: "audio", media: { asset: "a" } },
    },
  });
  expect(added.ok).toBe(true);
  store.execute({
    type: "clip.add",
    params: {
      timeline: "main",
      track: video,
      id: "p",
      start: "0",
      duration: "4",
      source: { kind: "color", color: "#808080" },
    },
  });
  return { store, audio, video };
}

const run = (store: ProjectStore, type: string, params: object) =>
  store.execute({ type, params: { timeline: "main", ...params } } as CommandCall);
const code = (result: ReturnType<ProjectStore["execute"]>) =>
  result.ok ? "ok" : result.error.code;
const timeline = (store: ProjectStore) => store.getState().timelines["main"];

describe("effects of sound", () => {
  it("go on clips of sound, tracks of sound and the master, and not where they are not for", () => {
    const { store, audio, video } = project();
    expect(code(run(store, "effect.add", { clip: "s", type: "eq", id: "e" }))).toBe("ok");
    expect(code(run(store, "effect.add", { track: audio, type: "compressor", id: "c" }))).toBe(
      "ok",
    );
    expect(code(run(store, "effect.add", { master: true, type: "limiter", id: "l" }))).toBe("ok");
    expect(effectsOf(timeline(store)?.clips["s"] as ClipState).map(({ type }) => type)).toEqual([
      "eq",
    ]);
    const track = timeline(store)?.tracks[audio] as { effects?: { type: string }[] };
    expect(track.effects?.map(({ type }) => type)).toEqual(["compressor"]);
    expect(timeline(store)?.mix?.master?.effects?.map(({ type }) => type)).toEqual(["limiter"]);
    // Not of sound on pictures, not of pictures on sound, not on a track of pictures.
    expect(code(run(store, "effect.add", { clip: "p", type: "reverb" }))).toBe("wrong-track");
    expect(code(run(store, "effect.add", { clip: "s", type: "blur" }))).toBe("wrong-track");
    expect(code(run(store, "effect.add", { track: video, type: "eq" }))).toBe("wrong-track");
    expect(code(run(store, "effect.add", { master: true, type: "blur" }))).toBe("wrong-target");
    // Only clips have a stretch that an effect works in.
    expect(code(run(store, "effect.add", { track: audio, type: "eq", start: "1" }))).toBe(
      "not-applicable",
    );
    expect(code(run(store, "effect.update", { master: true, effect: "l", end: "1" }))).toBe(
      "not-applicable",
    );
    // One target, exactly.
    expect(code(run(store, "effect.add", { type: "eq" }))).toBe("invalid-params");
    expect(code(run(store, "effect.add", { clip: "s", master: true, type: "eq" }))).toBe(
      "invalid-params",
    );
  });

  it("move, turn off and come off a track and the master with their parameters, one step each", () => {
    const { store, audio } = project();
    run(store, "effect.add", { track: audio, type: "eq", id: "a", values: { "low.gain": 3 } });
    run(store, "effect.add", { track: audio, type: "reverb", id: "b", values: { mix: 0.2 } });
    expect(code(run(store, "effect.move", { track: audio, effect: "b", index: 0 }))).toBe("ok");
    expect(code(run(store, "effect.update", { track: audio, effect: "a", enabled: false }))).toBe(
      "ok",
    );
    const track = () =>
      timeline(store)?.tracks[audio] as {
        effects?: { id: string; enabled?: boolean }[];
        properties?: Record<string, unknown>;
      };
    expect(track().effects).toEqual([
      { id: "b", type: "reverb" },
      { id: "a", type: "eq", enabled: false },
    ]);
    expect(code(run(store, "effect.remove", { track: audio, effects: ["a"] }))).toBe("ok");
    expect(track().properties?.["effect.a.low.gain"]).toBeUndefined();
    expect(track().properties?.["effect.b.mix"]).toBe(0.2);
    store.undo();
    expect(track().properties?.["effect.a.low.gain"]).toBe(3);
    run(store, "effect.add", { master: true, type: "eq", id: "m", values: { "mid2.gain": -2 } });
    expect(code(run(store, "effect.remove", { master: true, effects: ["m"] }))).toBe("ok");
    expect(timeline(store)?.mix).toBeUndefined();
  });

  it("have their parameters, and the volume and limiter of the master, written by property.edit", () => {
    const { store, audio } = project();
    run(store, "effect.add", { master: true, type: "compressor", id: "c" });
    run(store, "effect.add", { track: audio, type: "reverb", id: "r" });
    const edit = (edits: object[]) => run(store, "property.edit", { edits });
    expect(
      code(
        edit([
          { owner: { master: true }, path: "audio.volume", op: "set", value: -3 },
          { owner: { master: true }, path: "limit.ceiling", op: "set", value: -2 },
          { owner: { master: true }, path: "effect.c.ratio", op: "set", value: 4 },
          { owner: { track: audio }, path: "effect.r.mix", op: "write", time: "0", value: 0.5 },
        ]),
      ),
    ).toBe("ok");
    expect(timeline(store)?.mix?.master?.properties).toEqual({
      "audio.volume": -3,
      "effect.c.ratio": 4,
      "limit.ceiling": -2,
    });
    // What the master does not have, and values out of range.
    expect(code(edit([{ owner: { master: true }, path: "audio.pan", op: "set", value: 1 }]))).toBe(
      "wrong-target",
    );
    expect(
      code(edit([{ owner: { master: true }, path: "effect.c.ratio", op: "set", value: 40 }])),
    ).toBe("invalid-value");
    expect(
      code(edit([{ owner: { master: true }, path: "effect.x.ratio", op: "set", value: 2 }])),
    ).toBe("not-found");
    expect(
      code(edit([{ owner: { master: true }, path: "limit.on", op: "set", value: { keys: [] } }])),
    ).not.toBe("ok");
    store.undo();
    expect(timeline(store)?.mix?.master?.properties).toBeUndefined();
  });

  it("go into the mix plan, with the safe limiter on unless the master says otherwise", () => {
    const { store, audio } = project();
    run(store, "effect.add", { clip: "s", type: "eq", id: "e", values: { "hp.on": true } });
    run(store, "effect.add", { clip: "s", type: "reverb", id: "r", enabled: false });
    run(store, "effect.add", { track: audio, type: "limiter", id: "l" });
    const withAsset = () =>
      ({
        ...store.getState(),
        assets: { a: { name: "音", kind: "audio", hash: "sha256-a" } },
      }) as never;
    const plan = buildMixPlan(withAsset(), "main");
    expect(plan.sounds[0]?.effects?.map(({ type }) => type)).toEqual(["eq"]);
    expect(plan.sounds[0]?.effects?.[0]?.params["hp.on"]).toEqual({ kind: "still", value: 1 });
    expect(plan.tracks.find(({ id }) => id === audio)?.effects?.map(({ type }) => type)).toEqual([
      "limiter",
    ]);
    expect(plan.master).toEqual({ gain: 1, limit: { ceiling: -1 } });
    expect(masterLimited(store.getState(), "main")).toBe(true);
    run(store, "property.edit", {
      edits: [
        { owner: { master: true }, path: "limit.on", op: "set", value: false },
        { owner: { master: true }, path: "audio.volume", op: "set", value: -6 },
      ],
    });
    const off = buildMixPlan(withAsset(), "main");
    expect(off.master?.limit).toBeUndefined();
    expect(off.master?.gain).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(masterLimited(store.getState(), "main")).toBe(false);
  });

  it("are checked in files: what they cannot take, start and end where nothing has them, a pan of the master", () => {
    const { store, audio } = project();
    run(store, "effect.add", { track: audio, type: "eq", id: "e" });
    const files = store.exportFiles().files;
    const path = "timelines/main/timeline.json";
    const file = JSON.parse(files.get(path) ?? "{}");
    const track = file.tracks.find((one: { id: string }) => one.id === audio);
    track.effects = [
      { id: "e", type: "eq", start: "1" },
      { id: "b", type: "blur" },
    ];
    track.properties = { "effect.e.mid2.gain": 40 };
    file.mix = { master: { properties: { "audio.pan": 0.5 } } };
    files.set(path, JSON.stringify(file));
    const { project: read } = readProject(files);
    const codes = checkProject(read as never)
      .filter(({ code: name }) => name.startsWith("effect") || name === "not-applicable")
      .map(({ code: name, path: where }) => `${name} ${where}`);
    expect(codes).toEqual([
      "not-applicable mix.master.properties.audio.pan",
      `not-applicable tracks.1.effects.0`,
      `effect-missing tracks.1.effects.1.type`,
      `effect-property tracks.1.properties.effect.e.mid2.gain`,
    ]);
  });
});
