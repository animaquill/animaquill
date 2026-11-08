import { createProject, readProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { orderedTracks } from "./model.ts";
import { ProjectStore, USER, aiTask, type CommandResult } from "./store.ts";

/** Transitions at the edges of clips, and joins between them, as commands keep them. */

const color = { kind: "color", color: "#ff0000" };
const fade = (duration: string, more: Record<string, unknown> = {}) => ({
  type: "fade",
  duration,
  ...more,
});

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function failure(result: CommandResult) {
  if (result.ok) throw new Error("it went through");
  return result.error;
}

/**
 * A project with clip `a` on its video track, as a file has it: files can have what commands never
 * make, such as transitions that overlap.
 */
function withClip(clip: Record<string, unknown>, extra: (timeline: any) => void = () => {}) {
  const files = writeProject(createProject({ name: "转场" }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string);
  const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
  video.clips.push({ id: "a", source: color, ...clip });
  extra(timeline);
  files.set(path, JSON.stringify(timeline));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  const main = () => store.getState().timelines["main"];
  const clipOf = (id = "a") => main()?.clips[id];
  const edges = (id = "a") => [clipOf(id)?.enter?.duration, clipOf(id)?.exit?.duration];
  const trim = (to: Record<string, string>) =>
    success(store.execute({ type: "clip.trim", params: { timeline: "main", clip: "a", ...to } }));
  const split = (at: string, id = "a") => {
    const result = success(
      store.execute({ type: "clip.split", params: { timeline: "main", clip: id, at } }),
    );
    return (result.results[0] as { id: string }).id;
  };
  const set = (params: Record<string, unknown>, options = {}) =>
    store.execute(
      { type: "clip.setTransition", params: { timeline: "main", clip: "a", ...params } },
      options,
    );
  return { store, main, clipOf, edges, trim, split, set, track: video.id as string };
}

describe("transitions at the edges of a clip that gets shorter", () => {
  it("stay as they are while they fit", () => {
    const { edges, trim } = withClip({
      start: "0",
      duration: "6",
      enter: fade("1"),
      exit: fade("2"),
    });
    trim({ end: "3" });
    expect(edges()).toEqual(["1", "2"]);
  });

  it("first give up the one at the edge that moved, then the other, in one step", () => {
    const { store, edges, trim } = withClip({
      start: "0",
      duration: "6",
      enter: fade("2"),
      exit: fade("3"),
    });
    trim({ end: "4" });
    expect(edges()).toEqual(["2", "2"]);
    store.undo();
    expect(edges()).toEqual(["2", "3"]);
    trim({ start: "2" });
    expect(edges()).toEqual(["1", "3"]);
    store.undo();
    trim({ start: "4" });
    // Two seconds are left: the exit takes them all, and there is no enter any more.
    expect(edges()).toEqual([undefined, "2"]);
    store.undo();
    expect(edges()).toEqual(["2", "3"]);
  });

  it("are shortened by frames as exactly as the clip is", () => {
    const { edges, trim } = withClip({
      start: "0",
      duration: "2",
      enter: fade("1"),
      exit: fade("1"),
    });
    trim({ end: "59/30" });
    expect(edges()).toEqual(["1", "29/30"]);
  });

  it("keep what they are and how they go when they get shorter", () => {
    const curve = [0.42, 0, 0.58, 1];
    const { clipOf, trim } = withClip({
      start: "0",
      duration: "4",
      enter: fade("1"),
      exit: fade("3", { curve }),
    });
    trim({ end: "3" });
    expect(clipOf()?.exit).toEqual({ type: "fade", duration: "2", curve });
  });

  it("go to the part of a cut they are at, each as long as its part can take", () => {
    const { store, edges, split } = withClip({
      start: "0",
      duration: "6",
      enter: fade("4"),
      exit: fade("5"),
    });
    const right = split("1");
    expect(edges()).toEqual(["1", undefined]);
    expect(edges(right)).toEqual([undefined, "5"]);
    store.undo();
    expect(edges()).toEqual(["4", "5"]);
    const later = split("5");
    expect(edges()).toEqual(["4", undefined]);
    expect(edges(later)).toEqual([undefined, "1"]);
  });

  it("fit when a clip gets shorter with new numbers, by its end", () => {
    const { store, edges } = withClip({
      start: "0",
      duration: "6",
      enter: fade("2"),
      exit: fade("3"),
    });
    const changes = { duration: "4" };
    success(
      store.execute({ type: "clip.update", params: { timeline: "main", clip: "a", changes } }),
    );
    expect(edges()).toEqual(["2", "2"]);
  });
});

describe("setting the transitions of a clip", () => {
  it("puts them there, changes them and takes them away, a step each", () => {
    const { store, clipOf, set } = withClip({ start: "0", duration: "4" });
    success(set({ enter: fade("1") }));
    expect(clipOf()?.enter).toEqual(fade("1"));
    success(set({ enter: fade("1.5", { curve: [0.42, 0, 1, 1] }), exit: fade("2") }));
    expect(clipOf()?.enter).toEqual(fade("1.5", { curve: [0.42, 0, 1, 1] }));
    expect(clipOf()?.exit).toEqual(fade("2"));
    success(set({ enter: null }));
    expect(clipOf()).not.toHaveProperty("enter");
    expect(clipOf()?.exit).toEqual(fade("2"));
    store.undo();
    expect(clipOf()?.enter).toEqual(fade("1.5", { curve: [0.42, 0, 1, 1] }));
    store.undo();
    expect(clipOf()?.enter).toEqual(fade("1"));
    expect(clipOf()).not.toHaveProperty("exit");
    store.undo();
    expect(clipOf()).not.toHaveProperty("enter");
    store.redo();
    expect(clipOf()?.enter).toEqual(fade("1"));
  });

  it("leaves no step when nothing changes", () => {
    const { store, set } = withClip({ start: "0", duration: "4", enter: fade("1") });
    const revision = store.revision;
    success(set({ enter: fade("1") }));
    success(set({ exit: null }));
    expect(store.revision).toBe(revision);
  });

  it("only checks with a dry run", () => {
    const { clipOf, set } = withClip({ start: "0", duration: "4" });
    success(set({ enter: fade("1") }, { dryRun: true }));
    expect(clipOf()).not.toHaveProperty("enter");
  });

  it.each([
    ["transition-too-long", { enter: fade("3"), exit: fade("2") }],
    ["transition-too-long", { exit: fade("4.5") }],
    ["transition-missing", { enter: fade("1", { type: "melt" }) }],
    ["transition-missing", { enter: fade("1", { type: "plugin.star" }) }],
    ["transition-missing", { enter: fade("1", { type: "dip" }) }],
    ["transition-missing", { enter: fade("1", { variant: "left" }) }],
    ["transition-missing", { enter: fade("1", { type: "fade-linear" }) }],
    ["transition-missing", { enter: { transition: "ink", duration: "1" } }],
    ["transition-missing", { enter: { library: "lib", resource: "ink", duration: "1" } }],
    ["transition-unsupported", { enter: fade("1", { type: "wipe", variant: "left" }) }],
    ["invalid-params", { enter: fade("0") }],
    ["invalid-params", { enter: fade("1", { curve: [1.5, 0, 0.5, 1] }) }],
    ["invalid-params", {}],
  ])("refuses %s: %j", (code, params) => {
    const { clipOf, set } = withClip({ start: "0", duration: "4", exit: fade("1") });
    expect(failure(set(params)).code).toBe(code);
    expect(clipOf()?.exit).toEqual(fade("1"));
    expect(clipOf()).not.toHaveProperty("enter");
  });

  it("refuses what sound and captions cannot do yet", () => {
    const { store, track: _video } = withClip({ start: "0", duration: "4" });
    const main = store.getState().timelines["main"];
    const audio = main && orderedTracks(main).find(({ kind }) => kind === "audio");
    const sound = { kind: "audio", media: { asset: "nothing" } };
    const clip = { id: "s", start: "0", duration: "4", source: sound };
    store.execute({
      type: "asset.add",
      params: { id: "nothing", asset: { kind: "audio", path: "a.wav", storage: "local" } },
    });
    success(
      store.execute({ type: "clip.add", params: { timeline: "main", track: audio?.id, clip } }),
    );
    const result = store.execute({
      type: "clip.setTransition",
      params: { timeline: "main", clip: "s", enter: fade("0.2") },
    });
    expect(failure(result).code).toBe("transition-unsupported");
    expect(failure(result).message).toBe("这一版的编辑器还不能播放声音的入转场");
  });

  it("always takes one away, and changes one beside what a file left that it cannot do", () => {
    const wipe = { type: "wipe", variant: "left", duration: "1" };
    const { clipOf, set } = withClip({ start: "0", duration: "4", enter: wipe, exit: fade("1") });
    success(set({ exit: fade("2") }));
    expect(clipOf()?.exit).toEqual(fade("2"));
    expect(failure(set({ enter: { ...wipe, duration: "2" } })).code).toBe("transition-unsupported");
    success(set({ enter: null }));
    expect(clipOf()).not.toHaveProperty("enter");
    success(set({ exit: null }));
    expect(clipOf()).not.toHaveProperty("exit");
  });

  it("is not for a locked track, not even for AI", () => {
    const { store, set, track, clipOf } = withClip({ start: "0", duration: "4" });
    const changes = { locked: true };
    success(store.execute({ type: "track.update", params: { timeline: "main", track, changes } }));
    expect(failure(set({ enter: fade("1") })).code).toBe("track-locked");
    expect(failure(set({ enter: fade("1") }, { origin: aiTask("t") })).code).toBe("track-locked");
    expect(clipOf()).not.toHaveProperty("enter");
  });

  it("is the only way: other changes to a clip leave its transitions alone", () => {
    const { store, clipOf } = withClip({ start: "0", duration: "4", enter: fade("1") });
    const update = (changes: object) =>
      store.execute({ type: "clip.update", params: { timeline: "main", clip: "a", changes } });
    expect(failure(update({ enter: fade("2") })).code).toBe("invalid-params");
    expect(failure(update({ fadeIn: "2" })).code).toBe("invalid-params");
    const clear = store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "a", changes: {}, clear: ["enter"] },
    });
    expect(failure(clear).code).toBe("invalid-params");
    success(update({ name: "片头" }));
    expect(clipOf()?.enter).toEqual(fade("1"));
  });
});

describe("transitions of clips that are added", () => {
  const add = (clip: Record<string, unknown>) => {
    const { store, track, clipOf } = withClip({ start: "0", duration: "1" });
    const params = { timeline: "main", track, clip: { id: "b", source: color, ...clip } };
    return { result: store.execute({ type: "clip.add", params }), clipOf };
  };

  it("come along when they fit", () => {
    const { result, clipOf } = add({
      start: "2",
      duration: "2",
      enter: fade("1"),
      exit: fade("1"),
    });
    success(result);
    expect(clipOf("b")?.enter).toEqual(fade("1"));
  });

  it("stop a clip that they do not fit, or that this editor cannot show", () => {
    expect(
      failure(add({ start: "2", duration: "2", enter: fade("2"), exit: fade("1") }).result).code,
    ).toBe("transition-too-long");
    const wipe = { type: "wipe", variant: "up", duration: "1" };
    expect(failure(add({ start: "2", duration: "2", enter: wipe }).result).code).toBe(
      "transition-unsupported",
    );
    expect(failure(add({ start: "2", duration: "2", fadeIn: "1" }).result).code).toBe(
      "invalid-params",
    );
  });
});

describe("joins", () => {
  /** Clips a, b and c one after the other, and joins between a and b and between b and c. */
  const joined = () =>
    withClip({ start: "0", duration: "2", exit: fade("0.5") }, (timeline) => {
      const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
      video.clips.push(
        { id: "b", start: "2", duration: "2", source: color },
        { id: "c", start: "4", duration: "2", source: color },
      );
      video.joins = [
        { id: "j1", from: "a", to: "b", type: "fade", duration: "1" },
        { id: "j2", from: "b", to: "c", type: "fade", duration: "1", align: "after" },
      ];
    });

  it("are read into the project, sides and track apart from the rest", () => {
    const { main, track } = joined();
    expect(main()?.joins).toEqual({
      j1: { track, from: "a", to: "b", transition: { type: "fade", duration: "1" } },
      j2: {
        track,
        from: "b",
        to: "c",
        transition: { type: "fade", duration: "1", align: "after" },
      },
    });
  });

  it("go when one of their clips goes, and come back with it", () => {
    const { store, main } = joined();
    const before = main()?.joins;
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["b"] } }));
    expect(main()).not.toHaveProperty("joins");
    store.undo();
    expect(main()?.joins).toEqual(before);
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a"] } }));
    expect(Object.keys(main()?.joins ?? {})).toEqual(["j2"]);
  });

  it("go from the part after a cut, and stay with the part that comes after one", () => {
    const { main, split } = joined();
    const right = split("3.5", "b");
    expect(main()?.joins?.["j1"]?.to).toBe("b");
    expect(main()?.joins?.["j2"]?.from).toBe(right);
    const second = split("1", "a");
    expect(main()?.joins?.["j1"]?.from).toBe(second);
    // The exit went to the part after the cut, where the join still wins over it.
    expect(main()?.clips[second]?.exit).toEqual(fade("0.5"));
  });

  it("go along with their track", () => {
    const { store, main, track } = joined();
    success(store.execute({ type: "track.remove", params: { timeline: "main", track } }));
    expect(main()).not.toHaveProperty("joins");
    store.undo();
    expect(Object.keys(main()?.joins ?? {}).toSorted()).toEqual(["j1", "j2"]);
  });

  it("are written back as they were read", () => {
    const { store } = joined();
    const { files } = store.exportFiles();
    const again = ProjectStore.open(files).store?.exportFiles().files;
    expect(again).toEqual(files);
    const timeline = JSON.parse(files.get("timelines/main/timeline.json") as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    expect(video.joins).toEqual([
      { id: "j1", from: "a", to: "b", type: "fade", duration: "1" },
      { id: "j2", from: "b", to: "c", type: "fade", duration: "1", align: "after" },
    ]);
  });

  it("change from a file, field by field, and a lock keeps them as they are", () => {
    const { store, main, track } = joined();
    const path = "timelines/main/timeline.json";
    const rewrite = (change: (video: any, timeline: any) => void, origin = USER) => {
      const timeline = JSON.parse(store.exportFiles().files.get(path) as string);
      change(
        timeline.tracks.find(({ kind }: { kind: string }) => kind === "video"),
        timeline,
      );
      return store.importFile(path, JSON.stringify(timeline), { origin });
    };
    const result = rewrite((video) => (video.joins[0].duration = "0.5"));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.patches.map(({ path: where }) => where.join("/"))).toEqual([
      "timelines/main/joins/j1/transition",
    ]);
    const changes = { locked: true };
    success(store.execute({ type: "track.update", params: { timeline: "main", track, changes } }));
    const held = rewrite((video, timeline) => {
      video.joins[1].duration = "0.25";
      timeline.name = "改过";
    }, aiTask("t"));
    if (!held.ok) throw new Error(JSON.stringify(held.error));
    expect(held.kept.map((where) => where.join("/"))).toEqual([
      "timelines/main/joins/j2/transition",
    ]);
    expect(held.problems[0]?.message).toContain("衔接转场“j2”");
    expect(main()?.joins?.["j2"]?.transition?.duration).toBe("1");
    expect(main()?.name).toBe("改过");
  });

  it("from two windows at once are both there: no window makes a map for them first", () => {
    const { store } = withClip({ start: "0", duration: "2" }, (timeline) => {
      const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
      video.clips.push(
        { id: "b", start: "2", duration: "2", source: color },
        { id: "c", start: "4", duration: "2", source: color },
      );
    });
    expect(store.getState().timelines["main"]).not.toHaveProperty("joins");
    const doc = store.encodeState();
    const left = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const right = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const path = "timelines/main/timeline.json";
    const join = (window: ProjectStore, id: string, from: string, to: string) => {
      const timeline = JSON.parse(window.exportFiles().files.get(path) as string);
      const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
      video.joins = [{ id, from, to, type: "fade", duration: "1" }];
      expect(window.importFile(path, JSON.stringify(timeline), { origin: USER }).ok).toBe(true);
    };
    join(left, "j1", "a", "b");
    join(right, "j2", "b", "c");
    left.applyUpdates([right.encodeState()]);
    right.applyUpdates([left.encodeState()]);
    for (const window of [left, right]) {
      expect(Object.keys(window.getState().timelines["main"]?.joins ?? {}).toSorted()).toEqual([
        "j1",
        "j2",
      ]);
    }
  });

  it("that a file adds on a locked track stay out as a whole, not field by field", () => {
    const { store, main, track } = joined();
    const changes = { locked: true };
    success(store.execute({ type: "track.update", params: { timeline: "main", track, changes } }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(store.exportFiles().files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.joins.push({ id: "j3", from: "a", to: "b", type: "fade", duration: "0.5" });
    timeline.name = "改过";
    const result = store.importFile(path, JSON.stringify(timeline), { origin: aiTask("t") });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(main()?.name).toBe("改过");
    expect(main()?.joins).not.toHaveProperty("j3");
    expect(result.kept.map((where) => where.join("/")).toSorted()).toEqual(
      ["from", "to", "track", "transition"].map((field) => `timelines/main/joins/j3/${field}`),
    );
  });

  it("that only some of is left of stay out of the files, which stay valid", () => {
    // The same document on both sides, as two windows of one project have it.
    const doc = joined().store.encodeState();
    const left = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const right = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    success(left.execute({ type: "clip.remove", params: { timeline: "main", clips: ["b"] } }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(right.exportFiles().files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.joins[0].duration = "0.75";
    expect(right.importFile(path, JSON.stringify(timeline), { origin: USER }).ok).toBe(true);
    left.applyUpdates([right.encodeState()]);
    right.applyUpdates([left.encodeState()]);
    expect(left.getState()).toEqual(right.getState());
    const { problems, files: written } = left.exportFiles();
    expect(problems).toEqual([]);
    expect(readProject(written).problems.filter(({ severity }) => severity === "error")).toEqual(
      [],
    );
    // One of the two wins the field both of them wrote. Either way, j1 is no whole join any more.
    const j1 = left.getState().timelines["main"]?.joins?.["j1"];
    expect(j1 === undefined || j1.from === undefined).toBe(true);
    expect(written.get("timelines/main/timeline.json")).not.toContain('"j1"');
  });
});
