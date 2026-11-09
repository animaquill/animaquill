import { createProject, readProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { orderedTracks } from "./model.ts";
import { buildAudioPlan, buildRenderPlan, transitionsNotDone } from "./render-plan.ts";
import { ProjectStore, USER, aiTask, type CommandResult } from "./store.ts";
import { progressAt, shownAt } from "./view.ts";

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
    ["invalid-params", { enter: fade("0") }],
    ["invalid-params", { enter: fade("1", { curve: [1.5, 0, 0.5, 1] }) }],
    ["invalid-params", { enter: fade("1", { curve: [0.5, 10.5, 0.5, 1] }) }],
    ["invalid-params", { enter: fade("1", { curve: [0.5, 0, 0.5, -1e308] }) }],
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

  it("always takes one away, and changes the length and speed of one that a file left", () => {
    const star = { type: "plugin.star", duration: "1" };
    const { clipOf, set } = withClip({ start: "0", duration: "4", enter: star, exit: fade("1") });
    success(set({ exit: fade("2") }));
    expect(clipOf()?.exit).toEqual(fade("2"));
    // It stays what it is, which this editor cannot do: the problems and exports say so.
    success(set({ enter: { ...star, duration: "2", curve: [0.42, 0, 1, 1] } }));
    expect(clipOf()?.enter).toEqual({ ...star, duration: "2", curve: [0.42, 0, 1, 1] });
    // What it is cannot become something else that this editor cannot do.
    expect(failure(set({ enter: { ...star, type: "plugin.moon" } })).code).toBe(
      "transition-missing",
    );
    expect(failure(set({ enter: { ...star, variant: "up" } })).code).toBe("transition-missing");
    expect(failure(set({ exit: star })).code).toBe("transition-missing");
    // Every picture that comes with the editor can come instead, such as pushing in from the left.
    const push = { type: "push", variant: "right", duration: "1" };
    success(set({ enter: push }));
    expect(clipOf()?.enter).toEqual(push);
    success(set({ enter: null }));
    expect(clipOf()).not.toHaveProperty("enter");
    success(set({ exit: null }));
    expect(clipOf()).not.toHaveProperty("exit");
  });

  it("changes the speed of two that two windows left longer than the clip, and no more", () => {
    const { store } = withClip({ start: "0", duration: "5" });
    const doc = store.encodeState();
    const left = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const right = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const setIn = (window: ProjectStore, params: object) =>
      window.execute({
        type: "clip.setTransition",
        params: { timeline: "main", clip: "a", ...params },
      });
    success(setIn(left, { enter: fade("3") }));
    success(setIn(right, { exit: fade("3") }));
    left.applyUpdates([right.encodeState()]);
    right.applyUpdates([left.encodeState()]);
    expect(left.getState()).toEqual(right.getState());
    const clipOf = () => left.getState().timelines["main"]?.clips["a"];
    expect([clipOf()?.enter?.duration, clipOf()?.exit?.duration]).toEqual(["3", "3"]);
    // What the speed buttons do: only the curve changes.
    success(setIn(left, { enter: fade("3", { curve: [0.42, 0, 1, 1] }) }));
    expect(clipOf()?.enter).toEqual(fade("3", { curve: [0.42, 0, 1, 1] }));
    // Shorter, or as long, is fine. Longer than it was is not.
    success(setIn(left, { exit: fade("2.5") }));
    success(setIn(left, { exit: fade("2"), enter: fade("3.5") }));
    expect(failure(setIn(left, { exit: fade("2.5") })).code).toBe("transition-too-long");
    expect(left.exportFiles().problems).toEqual([]);
  });

  it("is also for a locked track, which is only there for people at the editor", () => {
    const { store, set, track, clipOf } = withClip({ start: "0", duration: "4" });
    const changes = { locked: true };
    success(store.execute({ type: "track.update", params: { timeline: "main", track, changes } }));
    success(set({ enter: fade("1") }, { origin: aiTask("t") }));
    expect(clipOf()?.enter).toEqual(fade("1"));
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

  it("get shorter where they do not fit, the exit first, as the clip has it", () => {
    const { result, clipOf } = add({
      start: "2",
      duration: "2",
      enter: fade("2"),
      exit: fade("1"),
    });
    success(result);
    expect(clipOf("b")?.enter).toEqual(fade("2"));
    expect(clipOf("b")).not.toHaveProperty("exit");
    const longer = add({
      start: "2",
      duration: "2",
      enter: fade("1.5"),
      exit: fade("1", { curve: [0, 0, 0.58, 1] }),
    });
    success(longer.result);
    expect(longer.clipOf("b")?.exit).toEqual(fade("0.5", { curve: [0, 0, 0.58, 1] }));
  });

  it("come along as they are, also what this editor cannot do yet, which it tells about", () => {
    const wipe = { type: "wipe", variant: "up", duration: "1" };
    const melt = { type: "melt", duration: "1" };
    const { result, clipOf } = add({ start: "2", duration: "2", enter: wipe, exit: melt });
    success(result);
    expect(clipOf("b")?.enter).toEqual(wipe);
    expect(clipOf("b")?.exit).toEqual(melt);
    expect(failure(add({ start: "2", duration: "2", fadeIn: "1" }).result).code).toBe(
      "invalid-params",
    );
  });

  it("are copied and pasted, and dragged with a copy, as two windows left them", () => {
    const { store, track } = withClip({ start: "0", duration: "5" });
    const doc = store.encodeState();
    const left = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const right = ProjectStore.fromUpdates([doc]).store as ProjectStore;
    const setIn = (window: ProjectStore, params: object) =>
      window.execute({
        type: "clip.setTransition",
        params: { timeline: "main", clip: "a", ...params },
      });
    success(setIn(left, { enter: fade("3") }));
    success(setIn(right, { exit: fade("3") }));
    left.applyUpdates([right.encodeState()]);
    const original = left.getState().timelines["main"]?.clips["a"];
    if (!original) throw new Error("no clip");
    const { track: _, ...copy } = original;
    const clip = { ...copy, id: "b", start: "10" };
    success(left.execute({ type: "clip.add", params: { timeline: "main", track, clip } }));
    const pasted = left.getState().timelines["main"]?.clips["b"];
    expect([pasted?.enter?.duration, pasted?.exit?.duration]).toEqual(["3", "2"]);
    expect(left.exportFiles().problems).toEqual([]);
  });

  it("of sound come along too, which this editor cannot play yet", () => {
    const files = writeProject(createProject({ name: "粘贴" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(files.get(path) as string);
    const audio = timeline.tracks.find(({ kind }: { kind: string }) => kind === "audio");
    const source = { kind: "audio", media: { asset: "nothing" } };
    audio.clips.push({ id: "s", start: "0", duration: "2", source, enter: fade("0.2") });
    files.set(path, JSON.stringify(timeline));
    const store = ProjectStore.open(files).store as ProjectStore;
    const original = store.getState().timelines["main"]?.clips["s"];
    if (!original) throw new Error("no clip");
    const { track, ...copy } = original;
    const clip = { ...copy, id: "s2", start: "5" };
    success(store.execute({ type: "clip.add", params: { timeline: "main", track, clip } }));
    expect(store.getState().timelines["main"]?.clips["s2"]?.enter).toEqual(fade("0.2"));
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

  it("change from a file, field by field, also on a locked track", () => {
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
    const locked = rewrite((video, timeline) => {
      video.joins[1].duration = "0.25";
      timeline.name = "改过";
    }, aiTask("t"));
    if (!locked.ok) throw new Error(JSON.stringify(locked.error));
    expect(main()?.joins?.["j2"]?.transition?.duration).toBe("0.25");
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

describe("a join with a hidden side", () => {
  /** a hidden, b after it with its own enter, and a join between them. */
  const files = () => {
    const written = writeProject(createProject({ name: "隐藏" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(written.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.clips.push(
      { id: "a", start: "0", duration: "2", source: color, hidden: true, exit: fade("1") },
      { id: "b", start: "2", duration: "2", source: color, enter: fade("1") },
    );
    video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    written.set(path, JSON.stringify(timeline));
    return written;
  };

  it("does nothing, as if it were not there, which the problems and the picture agree on", () => {
    const { problems } = readProject(files());
    expect(problems.filter(({ code }) => code === "transition-shadowed")).toEqual([]);
    // Hiding a clip is done on purpose: that is no problem either.
    expect(problems.filter(({ code }) => code.startsWith("join"))).toEqual([]);
    const store = ProjectStore.open(files()).store as ProjectStore;
    const b = buildRenderPlan(store.getState(), "main")?.layers.find(({ id }) => id === "b");
    expect(b?.enter).toBeDefined();
    expect(b && shownAt(b, 2.5)).toBeCloseTo(0.5, 6);
  });

  it("does what it says again when the clip shows, and then the enter is what does nothing", () => {
    const store = ProjectStore.open(files()).store as ProjectStore;
    const changes = { hidden: false };
    success(
      store.execute({ type: "clip.update", params: { timeline: "main", clip: "a", changes } }),
    );
    const shadowed = readProject(store.exportFiles().files).problems.filter(
      ({ code }) => code === "transition-shadowed",
    );
    expect(shadowed.map(({ path }) => path)).toEqual([
      "tracks.0.clips.0.exit",
      "tracks.0.clips.1.enter",
    ]);
    const layers = buildRenderPlan(store.getState(), "main")?.layers;
    expect(layers?.find(({ id }) => id === "b")?.enter).toBeUndefined();
    expect(layers?.find(({ id }) => id === "a")?.exit).toBeUndefined();
  });
});

describe("a join that one window removes with its clip while another changes it", () => {
  it("is whole and valid again after the removal is taken back", () => {
    const { store, track } = withClip({ start: "0", duration: "2" }, (timeline) => {
      const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
      video.clips.push({ id: "b", start: "2", duration: "2", source: color });
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    const doc = store.encodeState();
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
    expect(left.undo().ok).toBe(true);
    right.applyUpdates([left.encodeState()]);
    expect(left.getState()).toEqual(right.getState());
    expect(left.getState().timelines["main"]?.joins?.["j"]).toEqual({
      track,
      from: "a",
      to: "b",
      transition: { type: "fade", duration: "0.75" },
    });
    expect(left.exportFiles().problems).toEqual([]);
  });
});

describe("fades of a document from before transitions", () => {
  it("never show again, whatever happens to the clip", () => {
    const { store } = withClip({ start: "0", duration: "4" });
    const root = store.doc.getMap<unknown>("project");
    const main = (root.get("timelines") as Y.Map<Y.Map<unknown>>).get("main") as Y.Map<unknown>;
    const a = (main.get("clips") as Y.Map<Y.Map<unknown>>).get("a") as Y.Map<unknown>;
    a.set("fadeIn", "1");
    const old = new Y.Map<unknown>();
    main.set("transitions", old);
    const kept = new Y.Map<unknown>();
    old.set("t", kept);
    kept.set("from", "a");
    const fresh = () => new ProjectStore(store.doc);
    expect(fresh().getState().timelines["main"]?.clips["a"]).not.toHaveProperty("fadeIn");
    success(
      store.execute({ type: "clip.split", params: { timeline: "main", clip: "a", at: "2" } }),
    );
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a"] } }));
    store.undo();
    store.undo();
    store.redo();
    const { files, problems } = store.exportFiles();
    expect(problems).toEqual([]);
    expect(files.get("timelines/main/timeline.json")).not.toMatch(/fadeIn|"transitions"/);
    expect(fresh().getState()).toEqual(store.getState());
  });
});

describe("a speed curve", () => {
  it("only reaches as far as the format lets it, and never gives anything but a number", () => {
    const files = writeProject(createProject({ name: "曲线" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    const curve = [0.5, 1e308, 0.5, 1];
    video.clips.push({
      id: "a",
      start: "0",
      duration: "4",
      source: color,
      enter: fade("2", { curve }),
    });
    files.set(path, JSON.stringify(timeline));
    const errors = readProject(files).problems.filter(({ severity }) => severity === "error");
    expect(errors.map(({ path: where }) => where)).toContain("tracks.0.clips.0.enter.curve.1");
    const planned = {
      how: { kind: "built-in", type: "fade" },
      start: 0,
      end: 2,
      duration: 2,
    } as const;
    expect(progressAt({ ...planned, curve: [0.5, 1e308, 0.5, 1] }, 1)).toBe(0.5);
    expect(progressAt({ ...planned, curve: [0.5, Number.NaN, 0.5, 1] }, 0.5)).toBe(0.25);
    expect(progressAt({ ...planned, curve: [0.5, 10, 0.5, -10] }, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe("what an export stops at", () => {
  /** Clips on the video track, the audio track and joins, as a file has them. */
  const project = (more: (video: any, audio: any) => void) => {
    const files = writeProject(createProject({ name: "导出" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    const audio = timeline.tracks.find(({ kind }: { kind: string }) => kind === "audio");
    more(video, audio);
    files.set(path, JSON.stringify(timeline));
    const { store, problems } = ProjectStore.open(files);
    if (!store) throw new Error(JSON.stringify(problems));
    const state = store.getState();
    const plan = buildRenderPlan(state, "main");
    if (!plan) throw new Error("no plan");
    const timelineState = state.timelines["main"];
    if (!timelineState) throw new Error("no timeline");
    return {
      store,
      notDone: (sound = true) =>
        transitionsNotDone(timelineState, plan, sound ? buildAudioPlan(state, "main") : undefined),
    };
  };
  const sound = { kind: "audio", media: { asset: "tone" } };
  const withTone = (audio: any) => {
    audio.clips.push({ id: "s", start: "1", duration: "2", source: sound, exit: fade("0.5") });
  };

  it("is nothing where this editor does all of it", () => {
    const { notDone } = project((video) => {
      video.clips.push({ id: "a", start: "0", duration: "2", source: color, enter: fade("1") });
    });
    expect(notDone()).toEqual([]);
  });

  it("is a transition of a picture that shows as a fade, and a transition of sound", () => {
    const { store, notDone } = project((video, audio) => {
      video.clips.push(
        {
          id: "a",
          start: "0",
          duration: "2",
          source: color,
          enter: { type: "plugin.star", duration: "1/2" },
        },
        { id: "b", start: "2", duration: "2", source: color },
        { id: "c", start: "4", duration: "2", source: color },
        { id: "d", start: "6", duration: "2", source: color },
      );
      video.joins = [
        { id: "j1", from: "a", to: "b", library: "lib", resource: "ink", duration: "1" },
        { id: "j2", from: "b", to: "c", type: "plugin.melt", duration: "1", align: "before" },
        // What comes with the editor is done: a wipe, which a join is now too.
        { id: "j3", from: "c", to: "d", type: "wipe", variant: "up", duration: "1" },
      ];
      withTone(audio);
    });
    store.execute({
      type: "asset.add",
      params: {
        id: "tone",
        asset: { kind: "audio", path: "a.wav", storage: "local", hash: "sha256-a" },
      },
    });
    expect(notDone()).toEqual([
      { clip: "a", use: "enter", media: "picture", start: 0, end: 0.5 },
      { clip: "a", use: "join", media: "picture", start: 1.5, end: 2.5 },
      { clip: "b", use: "join", media: "picture", start: 3, end: 4 },
    ]);
  });

  it("is a sound that is heard, at its transitions and its joins, and only with sound", () => {
    const { store } = project((_video, audio) => {
      withTone(audio);
      audio.clips.push({ id: "t", start: "3", duration: "2", source: sound });
      audio.joins = [
        { id: "k", from: "s", to: "t", type: "fade", duration: "1/2", align: "after" },
      ];
    });
    const asset = { kind: "audio", path: "a.wav", storage: "local", hash: "sha256-a" };
    success(store.execute({ type: "asset.add", params: { id: "tone", asset } }));
    const state = store.getState();
    const timeline = state.timelines["main"] as NonNullable<(typeof state.timelines)["main"]>;
    const plan = buildRenderPlan(state, "main") as NonNullable<ReturnType<typeof buildRenderPlan>>;
    const audible = transitionsNotDone(timeline, plan, buildAudioPlan(state, "main"));
    // The exit of s is where the join is, which wins.
    expect(audible).toEqual([{ clip: "s", use: "join", media: "sound", start: 3, end: 3.5 }]);
    expect(transitionsNotDone(timeline, plan, undefined)).toEqual([]);
    const audio = orderedTracks(timeline).find(({ kind }) => kind === "audio")?.id;
    const muted = { timeline: "main", track: audio, changes: { muted: true } };
    success(store.execute({ type: "track.update", params: muted }));
    const quiet = store.getState();
    expect(transitionsNotDone(timeline, plan, buildAudioPlan(quiet, "main"))).toEqual([]);
  });

  it("is no join with a hidden side, and no clip that does not show", () => {
    const { notDone } = project((video) => {
      video.clips.push(
        {
          id: "a",
          start: "0",
          duration: "2",
          source: color,
          hidden: true,
          enter: { type: "wipe", variant: "up", duration: "1" },
        },
        { id: "b", start: "2", duration: "2", source: color },
      );
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    expect(notDone()).toEqual([]);
  });
});

describe("fades written the way they were before transitions", () => {
  const files = () => {
    const written = writeProject(createProject({ name: "旧的" }));
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(written.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.clips.push({
      id: "a",
      start: "0",
      duration: "4",
      source: color,
      fadeIn: "1",
      fadeOut: "1",
    });
    written.set(path, JSON.stringify(timeline));
    return written;
  };

  it("go without a word when a project opens", () => {
    const { store, problems } = ProjectStore.open(files());
    expect(problems.filter(({ code }) => code === "fades-retired")).toEqual([]);
    expect(store?.getState().timelines["main"]?.clips["a"]).not.toHaveProperty("fadeIn");
  });

  it("are said to be left out when a file comes in", () => {
    const { store } = withClip({ start: "0", duration: "4" });
    const path = "timelines/main/timeline.json";
    const imported = store.importFile(path, files().get(path) as string, { origin: USER });
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.problems).toEqual([
      {
        severity: "warning",
        code: "fades-retired",
        file: path,
        path: "tracks.0.clips.0.fadeIn",
        message: "旧的淡入淡出写法已不支持，被忽略",
      },
    ]);
    expect(store.getState().timelines["main"]?.clips["a"]).not.toHaveProperty("fadeIn");
  });
});
