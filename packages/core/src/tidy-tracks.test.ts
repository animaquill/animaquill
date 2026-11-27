import { createProject, createTimeline, type Project } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { clipPath } from "./clip-edits.ts";
import { Draft } from "./draft.ts";
import { orderedTracks, type ProjectState } from "./model.ts";
import {
  ProjectStore,
  USER,
  aiTask,
  folderBatch,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
} from "./store.ts";
import { keepsEmptyTrack, removeEmptiedTracks } from "./tidy-tracks.ts";

const AI = aiTask("task-1");
const MAIN = "timelines/main/timeline.json";
const COLOR = { kind: "color", color: "#112233" };

function success(result: CommandResult) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
}

/**
 * A project with its video track `v1` and audio track `a1` as named here, a second video track `v2`
 * above `v1`, clips `c1` on `v1` and `c2` on `v2`, and cleaning up empty tracks on.
 */
function project(extra: (project: Project) => void = () => {}): ProjectStore {
  const created = createProject({ name: "轨道" });
  const document = created.timelines.get("main")?.document;
  if (!document) throw new Error("no timeline");
  const [video, audio] = document.tracks;
  if (!video || !audio) throw new Error("no tracks");
  video.id = "v1";
  audio.id = "a1";
  extra(created);
  const store = ProjectStore.create(created);
  run(store, [
    {
      type: "sound.add",
      params: {
        id: "s",
        manifest: { name: "铃", entry: "sound.js", runtime: 1 },
        files: { "sound.js": "aq.sound(({ frames }) => new Float32Array(frames));" },
      },
    },
    { type: "track.add", params: { timeline: "main", id: "v2", kind: "video", before: "a1" } },
    clipAdd("c1", "v1"),
    clipAdd("c2", "v2"),
  ]);
  store.setTidying({ emptyTracks: true });
  return store;
}

const SOUND = { kind: "sound", sound: "s" };

/** Audio tracks here are `a…` and `b…`, and take a sound. */
const clipAdd = (id: string, track: string, timeline = "main", start = "0"): CommandCall => ({
  type: "clip.add",
  params: {
    timeline,
    track,
    id,
    start,
    duration: "2",
    source: /^[ab]/.test(track) ? SOUND : COLOR,
    ...(/^[ab]/.test(track) && { properties: { "param.duration": 2 } }),
  },
});

const moveTo = (clip: string, track: string, timeline = "main"): CommandCall => ({
  type: "clip.move",
  params: { timeline, clips: [{ clip, track, start: "4" }] },
});

const removeClips = (...clips: string[]): CommandCall => ({
  type: "clip.remove",
  params: { timeline: "main", clips },
});

const run = (store: ProjectStore, calls: readonly CommandCall[], options: ExecuteOptions = {}) =>
  success(store.executeBatch(calls, options));

const tracksOf = (store: ProjectStore, timeline = "main") =>
  orderedTracks(store.getState().timelines[timeline] as never).map((track) => track.id);

const setTrack = (store: ProjectStore, track: string, changes: object) =>
  run(store, [{ type: "track.update", params: { timeline: "main", track, changes } }]);

describe("empty tracks go with the change that emptied them", () => {
  it("goes in the same step when a clip moves away, and comes back with one undo", () => {
    const store = project();
    const before = store.getState();
    const result = run(store, [moveTo("c2", "v1")]);
    expect(result.tracksRemoved).toEqual([{ timeline: "main", track: "v2" }]);
    expect(tracksOf(store)).toEqual(["v1", "a1"]);
    const after = store.getState();

    expect(store.undo().ok).toBe(true);
    expect(store.getState()).toEqual(before);
    expect(store.redo().ok).toBe(true);
    expect(store.getState()).toEqual(after);
  });

  it("goes when its last clip is removed, or moved within a batch that also adds", () => {
    const store = project();
    expect(run(store, [removeClips("c2")]).tracksRemoved).toEqual([
      { timeline: "main", track: "v2" },
    ]);
    expect(tracksOf(store)).toEqual(["v1", "a1"]);

    const other = project();
    const result = run(other, [
      { type: "track.add", params: { timeline: "main", id: "v3", kind: "video" } },
      moveTo("c2", "v3"),
    ]);
    expect(result.tracksRemoved).toEqual([{ timeline: "main", track: "v2" }]);
    expect(tracksOf(other)).toEqual(["v1", "a1", "v3"]);
  });

  it("says nothing of tracks when none went", () => {
    const store = project();
    const result = run(store, [clipAdd("c3", "v2", "main", "8")]);
    expect(result).not.toHaveProperty("tracksRemoved");
    expect(run(store, [moveTo("c3", "v1")])).not.toHaveProperty("tracksRemoved");
  });

  it("leaves tracks that were empty, and those the batch added", () => {
    const store = project();
    run(store, [
      { type: "track.add", params: { timeline: "main", id: "v3", kind: "video" } },
      { type: "track.add", params: { timeline: "main", id: "a2", kind: "audio" } },
    ]);
    // The audio track never had a clip, and a new one stays however it was made.
    run(store, [clipAdd("c3", "v3"), moveTo("c3", "v1")]);
    expect(tracksOf(store)).toEqual(["v1", "v2", "a1", "v3", "a2"]);
  });

  it("leaves tracks people set something on, which a false or a blank name is not", () => {
    const store = project();
    setTrack(store, "v2", { name: "标题" });
    run(store, [removeClips("c2")]);
    expect(tracksOf(store)).toContain("v2");

    const blank = project();
    setTrack(blank, "v2", { name: "  " });
    run(blank, [removeClips("c2")]);
    expect(tracksOf(blank)).not.toContain("v2");

    const locked = project();
    setTrack(locked, "v2", { locked: true });
    // Commands do not mind the lock, the track keeps it all the same.
    run(locked, [removeClips("c2")]);
    expect(tracksOf(locked)).toContain("v2");

    const unlocked = project();
    setTrack(unlocked, "v2", { locked: true });
    setTrack(unlocked, "v2", { locked: false });
    run(unlocked, [removeClips("c2")]);
    expect(tracksOf(unlocked)).not.toContain("v2");

    const muted = project();
    run(muted, [clipAdd("s", "a1")]);
    setTrack(muted, "a1", { muted: true });
    run(muted, [removeClips("s")]);
    expect(tracksOf(muted)).toContain("a1");
  });

  it("knows what a track keeps", () => {
    const track = (fields: object) => ({ id: "t", kind: "audio", order: 0, ...fields }) as never;
    expect(keepsEmptyTrack(track({}))).toBe(false);
    expect(keepsEmptyTrack(track({ name: " " }))).toBe(false);
    for (const key of ["locked", "hidden", "muted", "solo"]) {
      expect(keepsEmptyTrack(track({ [key]: true })), key).toBe(true);
      expect(keepsEmptyTrack(track({ [key]: false })), key).toBe(false);
    }
    const kept: readonly object[] = [
      { name: "旁白" },
      { group: "g" },
      { role: "voice" },
      { output: "bus_1" },
      { properties: { "audio.volume": 0 } },
      { effects: [{ id: "e", type: "eq" }] },
      { sends: [{ bus: "bus_1" }] },
    ];
    for (const fields of kept)
      expect(keepsEmptyTrack(track(fields)), JSON.stringify(fields)).toBe(true);
    expect(keepsEmptyTrack(track({ properties: {}, effects: [], sends: [] }))).toBe(false);
  });

  it("leaves a timeline its first video track, or its first track without one", () => {
    const store = project();
    run(store, [clipAdd("s", "a1")]);
    const result = run(store, [removeClips("c1", "c2", "s")]);
    expect(result.tracksRemoved).toEqual([
      { timeline: "main", track: "v2" },
      { timeline: "main", track: "a1" },
    ]);
    expect(tracksOf(store)).toEqual(["v1"]);

    const sound = project();
    run(sound, [
      { type: "track.add", params: { timeline: "main", id: "a2", kind: "audio" } },
      clipAdd("s1", "a1"),
      clipAdd("s2", "a2"),
      { type: "track.remove", params: { timeline: "main", track: "v1" } },
      { type: "track.remove", params: { timeline: "main", track: "v2" } },
    ]);
    run(sound, [removeClips("s1", "s2")]);
    expect(tracksOf(sound)).toEqual(["a1"]);
  });

  it("looks at each timeline on its own", () => {
    const store = project((created) => {
      const other = createTimeline("另一条");
      const [video, audio] = other.tracks;
      if (!video || !audio) throw new Error("no tracks");
      video.id = "w1";
      audio.id = "b1";
      (created.timelines as Map<string, unknown>).set("other", {
        document: other,
        overrides: new Map(),
      });
      created.manifest.timelines = [...created.manifest.timelines, "other"];
    });
    run(store, [
      { type: "track.add", params: { timeline: "other", id: "w2", kind: "video" } },
      clipAdd("o1", "w1", "other"),
      clipAdd("o2", "w2", "other"),
    ]);
    const result = run(store, [moveTo("o2", "w1", "other"), removeClips("c2")]);
    expect(result.tracksRemoved).toEqual([
      { timeline: "other", track: "w2" },
      { timeline: "main", track: "v2" },
    ]);
    expect(tracksOf(store, "other")).toEqual(["w1", "b1"]);
    // The last track that stays need not be one that had clips.
    run(store, [removeClips("c1")]);
    expect(tracksOf(store)).toEqual(["a1"]);
  });

  it("takes the joins of a track along that has none of their clips", () => {
    const state = project().getState();
    const main = state.timelines["main"];
    if (!main) throw new Error("no timeline");
    const join = { id: "j", track: "v2", from: "gone_a", to: "gone_b", transition: "fade" };
    const before: ProjectState = {
      ...state,
      timelines: { ...state.timelines, main: { ...main, joins: { j: join } as never } },
    };
    const draft = new Draft(before, USER);
    draft.delete(clipPath("main", "c2"));
    expect(removeEmptiedTracks(before, draft)).toEqual([{ timeline: "main", track: "v2" }]);
    expect(draft.state.timelines["main"]?.joins?.["j"]).toBeUndefined();
    expect(draft.state.timelines["main"]?.tracks["v2"]).toBeUndefined();
  });
});

describe("what does not clean up", () => {
  it("leaves empty tracks with it off, which is how a store starts", () => {
    const store = project();
    store.setTidying({ emptyTracks: false });
    run(store, [removeClips("c2")]);
    expect(tracksOf(store)).toContain("v2");
    expect(ProjectStore.create(createProject({ name: "新" })).tidying).toEqual({
      emptyTracks: false,
    });
  });

  it("leaves files that come in as they say", () => {
    const store = project();
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    for (const track of file.tracks) track.clips = track.id === "v2" ? [] : track.clips;
    success(store.importFile(MAIN, JSON.stringify(file), { origin: USER }));
    expect(tracksOf(store)).toContain("v2");

    const merging = project();
    const files = merging.exportFiles().files;
    const base = files.get(MAIN) as string;
    const merged = merging.mergeFiles([{ path: MAIN, text: JSON.stringify(file), base }], {
      origin: folderBatch("b"),
      baseOf: (path) => files.get(path),
    });
    expect(merged.ok).toBe(true);
    expect(Object.values(merging.getState().timelines["main"]?.clips ?? {})).toHaveLength(1);
    expect(tracksOf(merging)).toContain("v2");
  });

  it("leaves what undo and redo empty", () => {
    const store = project();
    store.setTidying({ emptyTracks: false });
    run(store, [clipAdd("c3", "v2", "main", "8"), removeClips("c2")]);
    store.setTidying({ emptyTracks: true });
    // Undoing takes c3 off v2 again, and v2 stays as it was before.
    expect(store.undo().ok).toBe(true);
    expect(tracksOf(store)).toContain("v2");
    run(store, [removeClips("c2")]);
    expect(tracksOf(store)).not.toContain("v2");
    expect(store.undo().ok).toBe(true);
    expect(store.redo().ok).toBe(true);
    expect(store.undo().ok).toBe(true);
    expect(tracksOf(store)).toContain("v2");
  });
});

describe("AI changes clean up the same way", () => {
  it("removes the track for an AI task, and undoing the task brings it back", () => {
    const store = project();
    const result = run(store, [moveTo("c2", "v1")], { origin: AI });
    expect(result.tracksRemoved).toEqual([{ timeline: "main", track: "v2" }]);
    expect(store.undoTask("task-1").ok).toBe(true);
    expect(tracksOf(store)).toContain("v2");
    expect(store.getState().timelines["main"]?.clips["c2"]?.track).toBe("v2");
  });

  it("does not fail for what somebody else did to a track it only cleans up", () => {
    const store = project();
    const base = store.revisionId;
    setTrack(store, "v2", { hidden: true });
    setTrack(store, "v2", { hidden: false });
    const result = store.executeBatch([moveTo("c2", "v1")], { origin: AI, baseRevision: base });
    expect(success(result).tracksRemoved).toEqual([{ timeline: "main", track: "v2" }]);
    // What it says itself still conflicts.
    const again = project();
    const seen = again.revisionId;
    setTrack(again, "v2", { hidden: true });
    const conflict = again.executeBatch(
      [
        {
          type: "track.update",
          params: { timeline: "main", track: "v2", changes: { hidden: false } },
        },
      ],
      { origin: AI, baseRevision: seen },
    );
    expect(conflict.ok ? undefined : conflict.error.code).toBe("conflict");
  });

  it("writes in a dry run what it writes for real", () => {
    const store = project();
    const dry = success(store.executeBatch([moveTo("c2", "v1")], { dryRun: true }));
    expect(tracksOf(store)).toContain("v2");
    const real = run(store, [moveTo("c2", "v1")]);
    expect(dry.patches).toEqual(real.patches);
    expect(dry.tracksRemoved).toEqual(real.tracksRemoved);
  });

  it("is checked by what is expected of it, which includes the removal", () => {
    const store = project();
    const dry = success(store.executeBatch([moveTo("c2", "v1")], { dryRun: true }));
    store.setTidying({ emptyTracks: false });
    const result = store.executeBatch([moveTo("c2", "v1")], {
      expect: (patches) =>
        patches.length === dry.patches.length ? undefined : { code: "conflict", params: {} },
    });
    expect(result.ok).toBe(false);
  });
});
