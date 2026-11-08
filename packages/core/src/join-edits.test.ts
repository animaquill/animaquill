import { createProject, readProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { chooseAlign, joinsInEffect, stillDuring } from "./joins.ts";
import type { ClipState } from "./model.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { ProjectStore, USER, aiTask, type CommandResult } from "./store.ts";

/** Joins as commands keep them: putting them on cuts, changing them, and what moving clips does. */

const color = { kind: "color", color: "#ff0000" };
const MAIN = "timelines/main/timeline.json";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function failure(result: CommandResult) {
  if (result.ok) throw new Error("it went through");
  return result.error;
}

/**
 * Clips a, b and c one after the other on the video track, two seconds each, and a video v of a
 * file of ten seconds on a track of its own, as a file has them.
 */
function project(more: (video: any, timeline: any) => void = () => {}) {
  const files = writeProject(createProject({ name: "衔接" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
  video.clips.push(
    { id: "a", start: "0", duration: "2", source: color },
    { id: "b", start: "2", duration: "2", source: color },
    { id: "c", start: "4", duration: "2", source: color },
  );
  more(video, timeline);
  files.set(MAIN, JSON.stringify(timeline));
  const assets = JSON.parse(files.get("assets.json") ?? '{"assets":{}}');
  assets.assets.file = {
    kind: "video",
    path: "assets/file.mp4",
    storage: "local",
    hash: "sha256-f",
    info: { duration: "10" },
  };
  files.set("assets.json", JSON.stringify(assets));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  const main = () => store.getState().timelines["main"];
  const run = (type: string, params: Record<string, unknown>, options = {}) =>
    store.execute({ type, params: { timeline: "main", ...params } }, options);
  const joinOf = (id: string) => main()?.joins?.[id];
  return { store, main, run, joinOf, track: video.id as string };
}

describe("a join that is put on a cut", () => {
  it("goes between two clips that follow each other, as long as it says, in one step", () => {
    const { store, run, joinOf, track } = project();
    const result = success(run("join.add", { id: "j", from: "a", to: "b", type: "fade" }));
    expect(result.results).toEqual([{ id: "j", align: "center" }]);
    expect(joinOf("j")).toEqual({
      track,
      from: "a",
      to: "b",
      transition: { type: "fade", duration: "0.5" },
    });
    expect(store.exportFiles().problems).toEqual([]);
    store.undo();
    expect(joinOf("j")).toBeUndefined();
    store.redo();
    expect(joinOf("j")?.transition).toEqual({ type: "fade", duration: "0.5" });
  });

  it("is what it says, with its kind, length and speed, as the file has it", () => {
    const { run, joinOf, store } = project();
    const params = {
      id: "j",
      from: "b",
      to: "c",
      type: "push",
      variant: "left",
      duration: "1",
      curve: [0.42, 0, 0.58, 1],
      align: "after",
    };
    success(run("join.add", params));
    expect(joinOf("j")?.transition).toEqual({
      type: "push",
      variant: "left",
      duration: "1",
      curve: [0.42, 0, 0.58, 1],
      align: "after",
    });
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    const video = file.tracks.find(({ kind }: { kind: string }) => kind === "video");
    expect(video.joins).toEqual([params]);
  });

  it.each([
    ["not-adjacent", { from: "a", to: "c", type: "fade" }],
    ["not-adjacent", { from: "b", to: "a", type: "fade" }],
    ["invalid-value", { from: "a", to: "a", type: "fade" }],
    ["not-found", { from: "a", to: "gone", type: "fade" }],
    ["transition-missing", { from: "a", to: "b", type: "melt" }],
    ["transition-missing", { from: "a", to: "b", type: "wipe" }],
    ["transition-missing", { from: "a", to: "b", type: "plugin.star" }],
    ["transition-missing", { from: "a", to: "b", library: "lib", resource: "ink" }],
    ["invalid-value", { from: "a", to: "b" }],
    ["invalid-value", { from: "a", to: "b", type: "fade", transition: "ink" }],
    ["transition-too-long", { from: "a", to: "b", type: "fade", duration: "4.5" }],
    ["transition-too-long", { from: "a", to: "b", type: "fade", duration: "3", align: "before" }],
    ["invalid-params", { from: "a", to: "b", type: "fade", duration: "0" }],
    ["invalid-params", { from: "a", to: "b", type: "fade", align: "middle" }],
  ])("is refused with %s for %j", (code, params) => {
    const { run, main } = project();
    expect(failure(run("join.add", params)).code).toBe(code);
    expect(main()).not.toHaveProperty("joins");
  });

  it("is refused where a cut has one, and on a cut without anything between its clips", () => {
    const { run } = project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    expect(
      failure(run("join.add", { from: "a", to: "b", type: "dip", variant: "black" })).code,
    ).toBe("join-taken");
    expect(failure(run("join.add", { id: "j", from: "b", to: "c", type: "fade" })).code).toBe(
      "id-taken",
    );
    success(run("clip.move", { clips: [{ clip: "c", start: "5" }] }));
    expect(failure(run("join.add", { from: "b", to: "c", type: "fade" })).message).toBe(
      "两个片段之间有空隙，先把它们接上，才能加衔接转场",
    );
  });

  it("only checks with a dry run", () => {
    const { run, main } = project();
    success(run("join.add", { from: "a", to: "b", type: "fade" }, { dryRun: true }));
    expect(main()).not.toHaveProperty("joins");
  });

  it("takes as much as fits when it says nothing, and leaves room for the other ends", () => {
    const { run, joinOf } = project((video) => {
      video.clips[0].duration = "0.2";
      video.clips[1].start = "0.2";
      video.clips[1].duration = "3.8";
      video.clips[1].exit = { type: "fade", duration: "3.6" };
    });
    // Half of it before the cut, which a clip of 0.2 seconds has room for twice over.
    success(run("join.add", { id: "j", from: "a", to: "b", type: "fade" }));
    expect(joinOf("j")?.transition?.duration).toBe("0.4");
    // What comes in at the start of b and the exit at its end leave it 0.2 seconds.
    const longer = run("join.update", { join: "j", changes: { duration: "1" } });
    expect(failure(longer).code).toBe("transition-too-long");
    expect(failure(longer).message).toBe("衔接转场太长，这里最长 0.4 秒");
  });

  it("is not for a locked track, not even for AI, nor for sound and captions yet", () => {
    const { store, run, track } = project();
    const locked = { track, changes: { locked: true } };
    success(run("track.update", locked));
    expect(failure(run("join.add", { from: "a", to: "b", type: "fade" })).code).toBe(
      "track-locked",
    );
    const asAi = { origin: aiTask("t") };
    expect(failure(run("join.add", { from: "a", to: "b", type: "fade" }, asAi)).code).toBe(
      "track-locked",
    );
    expect(store.getState().timelines["main"]).not.toHaveProperty("joins");
  });
});

describe("a copy of a join that comes with copies of its clips", () => {
  it("comes as it was, shorter where it does not fit, and stays out where nothing fits", () => {
    const { run, joinOf, main } = project((video) => {
      video.clips[1].exit = { type: "fade", duration: "2" };
    });
    const copied = { copied: true, align: "center" };
    // Two seconds in the middle want a second of b, whose exit takes all of it.
    const none = success(
      run("join.add", { from: "a", to: "b", type: "fade", duration: "2", ...copied }),
    );
    expect(none.results).toEqual([{ left: "no-room" }]);
    expect(main()).not.toHaveProperty("joins");
    // At the end of b it wins over that exit: two seconds on each side of the cut are all there is.
    const result = success(
      run("join.add", { id: "j", from: "b", to: "c", type: "fade", duration: "6", ...copied }),
    );
    expect(result.results).toEqual([{ id: "j", align: "center" }]);
    expect(joinOf("j")?.transition).toEqual({ type: "fade", duration: "4" });
  });

  it("gets shorter to what its clips leave, also this editor does not do", () => {
    const { run, joinOf } = project();
    const params = { from: "b", to: "c", type: "plugin.star", duration: "6", copied: true };
    const result = success(run("join.add", { id: "j", ...params, align: "after" }));
    expect(result.results).toEqual([{ id: "j", align: "after" }]);
    expect(joinOf("j")?.transition).toEqual({ type: "plugin.star", duration: "2", align: "after" });
    // On a cut that has one already it stays out, instead of stopping the rest.
    const again = success(run("join.add", { id: "k", ...params, type: "fade" }));
    expect(again.results).toEqual([{ left: "taken" }]);
  });

  it("is only for people, never for AI", () => {
    const { run } = project();
    const params = { from: "b", to: "c", type: "fade", copied: true };
    expect(failure(run("join.add", params, { origin: aiTask("t") })).code).toBe("user-only");
  });
});

describe("where a join goes around its cut when nobody says", () => {
  /** A clip of the video file before a color, or after it, with its file around it as it says. */
  const around = (offset: string, duration: string, before: boolean) =>
    project((video) => {
      video.clips = [
        before
          ? {
              id: "v",
              start: "0",
              duration,
              offset,
              source: { kind: "video", media: { asset: "file" } },
            }
          : { id: "x", start: "0", duration: "2", source: color },
        before
          ? { id: "x", start: duration, duration: "2", source: color }
          : {
              id: "v",
              start: "2",
              duration,
              offset,
              source: { kind: "video", media: { asset: "file" } },
            },
      ];
    });

  it("is in the middle when both clips have enough past the cut", () => {
    const { run, joinOf } = around("1", "4", false);
    success(run("join.add", { id: "j", from: "x", to: "v", type: "fade", duration: "1" }));
    expect(joinOf("j")?.transition).not.toHaveProperty("align");
  });

  it("is after the cut when the clip after it starts at the first frame of its file", () => {
    const { run, joinOf } = around("0", "4", false);
    const result = success(
      run("join.add", { id: "j", from: "x", to: "v", type: "fade", duration: "1" }),
    );
    expect(result.results).toEqual([{ id: "j", align: "after" }]);
    expect(joinOf("j")?.transition?.align).toBe("after");
  });

  it("is before the cut when the clip before it ends at the last frame of its file", () => {
    const { run, joinOf } = around("6", "4", true);
    success(run("join.add", { id: "j", from: "v", to: "x", type: "fade", duration: "1" }));
    expect(joinOf("j")?.transition?.align).toBe("before");
  });

  it("is where it is told, also where a frame then stands still, which the timeline shows", () => {
    const { run, store } = around("0.2", "4", false);
    success(
      run("join.add", {
        id: "j",
        from: "x",
        to: "v",
        type: "fade",
        duration: "1",
        align: "center",
      }),
    );
    const [join] = joinsInEffect(store.getState().timelines["main"] as never);
    if (!join) throw new Error("no join");
    // Half a second before the cut, of which the file has 0.2: the first 0.3 stand still.
    expect(stillDuring(store.getState(), join)).toEqual([{ from: 1.5, to: 1.8 }]);
  });

  it("goes by what the clips have past the cut, with the middle when that is a tie", () => {
    const { store } = project();
    const state = store.getState();
    const clip = (extra: Partial<ClipState>): ClipState =>
      ({ id: "c", track: "t", start: "0", duration: "4", source: color, ...extra }) as ClipState;
    const video = (offset: string) =>
      clip({ source: { kind: "video", media: { asset: "file" } }, offset });
    const scene = (offset: string) => clip({ source: { kind: "scene", scene: "s" }, offset });
    const length = { n: 1n, d: 1n };
    expect(chooseAlign(state, clip({}), clip({}), length)).toBe("center");
    expect(chooseAlign(state, clip({}), video("0"), length)).toBe("after");
    expect(chooseAlign(state, video("6"), clip({}), length)).toBe("before");
    expect(chooseAlign(state, video("6"), video("0"), length)).toBe("center");
    // A scene goes on after its end, and has nothing before its clock reads zero.
    expect(chooseAlign(state, scene("0"), scene("0"), length)).toBe("after");
    expect(chooseAlign(state, video("5.9"), video("0.1"), length)).toBe("center");
  });
});

describe("changing a join", () => {
  const joined = () =>
    project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "wipe", variant: "left", duration: "1" }];
    });

  it("puts another one in its place as a whole, and changes its length, speed and place", () => {
    const { run, joinOf, store } = joined();
    success(run("join.update", { join: "j", changes: { type: "fade" } }));
    expect(joinOf("j")?.transition).toEqual({ type: "fade", duration: "1" });
    success(run("join.update", { join: "j", changes: { type: "push", variant: "right" } }));
    expect(joinOf("j")?.transition).toEqual({ type: "push", variant: "right", duration: "1" });
    success(run("join.update", { join: "j", changes: { variant: "up" } }));
    expect(joinOf("j")?.transition?.variant).toBe("up");
    success(
      run("join.update", {
        join: "j",
        changes: { duration: "1.5", curve: [0.42, 0, 1, 1], align: "before" },
      }),
    );
    expect(joinOf("j")?.transition).toEqual({
      type: "push",
      variant: "up",
      duration: "1.5",
      curve: [0.42, 0, 1, 1],
      align: "before",
    });
    success(run("join.update", { join: "j", changes: { curve: null, align: "center" } }));
    expect(joinOf("j")?.transition).toEqual({ type: "push", variant: "up", duration: "1.5" });
    for (let step = 0; step < 5; step++) store.undo();
    expect(joinOf("j")?.transition).toEqual({ type: "wipe", variant: "left", duration: "1" });
  });

  it("leaves no step when nothing changes", () => {
    const { run, store } = joined();
    const revision = store.revision;
    success(run("join.update", { join: "j", changes: { duration: "1", align: "center" } }));
    expect(store.revision).toBe(revision);
  });

  it.each([
    ["transition-missing", { type: "wipe" }],
    ["transition-missing", { variant: "middle" }],
    ["transition-missing", { type: "plugin.star" }],
    ["transition-too-long", { duration: "4.5" }],
    ["transition-too-long", { align: "after", duration: "3" }],
    ["invalid-params", { duration: "-1" }],
    ["invalid-value", { type: "fade", transition: "ink" }],
  ])("is refused with %s for %j", (code, changes) => {
    const { run, joinOf } = joined();
    expect(failure(run("join.update", { join: "j", changes })).code).toBe(code);
    expect(joinOf("j")?.transition).toEqual({ type: "wipe", variant: "left", duration: "1" });
  });

  it("can always make one shorter that a file left too long, and take it away", () => {
    const { run, joinOf, main } = project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "plugin.star", duration: "6" }];
    });
    success(run("join.update", { join: "j", changes: { duration: "5", curve: [0, 0, 0.58, 1] } }));
    expect(joinOf("j")?.transition?.duration).toBe("5");
    expect(failure(run("join.update", { join: "j", changes: { duration: "7" } })).code).toBe(
      "transition-too-long",
    );
    success(run("join.remove", { joins: ["j"] }));
    expect(main()).not.toHaveProperty("joins");
  });

  it("is not for a locked track, and goes with join.remove, also several at once", () => {
    const { run, store, track, main } = project((video) => {
      video.joins = [
        { id: "j", from: "a", to: "b", type: "fade", duration: "1" },
        { id: "k", from: "b", to: "c", type: "fade", duration: "1" },
      ];
    });
    success(run("track.update", { track, changes: { locked: true } }));
    expect(failure(run("join.update", { join: "j", changes: { duration: "0.5" } })).code).toBe(
      "track-locked",
    );
    expect(failure(run("join.remove", { joins: ["j"] })).code).toBe("track-locked");
    success(run("track.update", { track, changes: { locked: false } }));
    expect(failure(run("join.remove", { joins: ["j", "gone"] })).code).toBe("not-found");
    success(run("join.remove", { joins: ["j", "k", "j"] }));
    expect(main()).not.toHaveProperty("joins");
    store.undo();
    expect(Object.keys(main()?.joins ?? {}).toSorted()).toEqual(["j", "k"]);
  });
});

describe("a join whose clips change", () => {
  const joined = () =>
    project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });

  it("goes along with both of them, also to another track", () => {
    const { run, joinOf, store } = joined();
    success(run("track.add", { id: "other", kind: "video" }));
    const both = run("clip.move", {
      clips: [
        { clip: "a", start: "10", track: "other" },
        { clip: "b", start: "12", track: "other" },
      ],
    });
    expect(success(both).results).toEqual([undefined]);
    expect(joinOf("j")).toMatchObject({ track: "other", from: "a", to: "b" });
    expect(joinsInEffect(store.getState().timelines["main"] as never).map(({ id }) => id)).toEqual([
      "j",
    ]);
  });

  it("goes in the same step when one of them moves away, says so, and comes back with undo", () => {
    const { run, joinOf, store } = joined();
    const before = joinOf("j");
    const moved = success(run("clip.move", { clips: [{ clip: "b", start: "7" }] }));
    expect(moved.results).toEqual([{ joinsRemoved: ["j"] }]);
    expect(joinOf("j")).toBeUndefined();
    store.undo();
    expect(joinOf("j")).toEqual(before);
    expect(store.getState().timelines["main"]?.clips["b"]?.start).toBe("2");
  });

  it("goes when either edge of the cut gets trimmed away from the other", () => {
    for (const trim of [
      { clip: "a", end: "1.5" },
      { clip: "b", start: "2.5" },
    ]) {
      const { run, joinOf, store } = joined();
      expect(success(run("clip.trim", trim)).results).toEqual([{ joinsRemoved: ["j"] }]);
      expect(joinOf("j")).toBeUndefined();
      store.undo();
      expect(joinOf("j")).toBeDefined();
    }
  });

  it("goes with a new length that takes a clip away from the other, and a clip on top of the cut", () => {
    const { run, joinOf } = joined();
    const shorter = run("clip.update", { clip: "a", changes: { duration: "1" } });
    expect(success(shorter).results).toEqual([{ joinsRemoved: ["j"] }]);
    expect(joinOf("j")).toBeUndefined();
    const again = joined();
    const clip = { start: "1.5", duration: "1", source: color };
    const added = again.run("clip.add", { track: again.track, clip, overlap: "overwrite" });
    expect(success(added).results[0]).toMatchObject({ joinsRemoved: ["j"] });
  });

  it("stays when the other ends of its clips change, and gets no longer than they leave room for", () => {
    const { run, joinOf } = joined();
    success(run("clip.trim", { clip: "b", end: "3" }));
    expect(joinOf("j")?.transition?.duration).toBe("1");
    // Half a second of b is all there is past the cut now.
    success(run("clip.trim", { clip: "b", end: "2.25" }));
    expect(joinOf("j")?.transition?.duration).toBe("0.5");
    success(run("clip.update", { clip: "a", changes: { start: "0" } }));
    expect(joinOf("j")).toBeDefined();
  });

  it("at an end of a clip that stays gets no longer than what is left of it", () => {
    for (const how of ["clip.trim", "clip.update"] as const) {
      const { run, joinOf, main } = project((video) => {
        video.clips[1].duration = "3";
        video.clips[2].start = "5";
        video.joins = [{ id: "j", from: "b", to: "c", type: "fade", duration: "2" }];
      });
      // b keeps its end at the cut and gets half a second long: so does the half of j in it.
      if (how === "clip.trim") success(run("clip.trim", { clip: "b", start: "4.5", end: "5" }));
      else success(run("clip.update", { clip: "b", changes: { start: "4.5", duration: "0.5" } }));
      expect(main()?.clips["b"]?.start, how).toBe("4.5");
      expect(joinOf("j")?.transition?.duration, how).toBe("1");
    }
  });

  it("keeps room for an exit at the other end, which gets shorter first", () => {
    const { run, joinOf, main } = project((video) => {
      video.clips[1].exit = { type: "fade", duration: "1" };
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    success(run("clip.trim", { clip: "b", end: "3" }));
    expect(main()?.clips["b"]?.exit?.duration).toBe("0.5");
    expect(joinOf("j")?.transition?.duration).toBe("1");
  });

  it("goes from the part after a cut in the clip before it, and gets shorter where that is short", () => {
    const { run, joinOf, main, store } = joined();
    const cut = success(run("clip.split", { clip: "a", at: "1.75" }));
    const right = (cut.results[0] as { id: string }).id;
    expect(joinOf("j")?.from).toBe(right);
    // A quarter of a second is left before the cut, and the join stays in the middle.
    expect(joinOf("j")?.transition?.duration).toBe("0.5");
    expect(main()?.clips[right]?.duration).toBe("0.25");
    store.undo();
    expect(joinOf("j")).toEqual({
      track: expect.any(String),
      from: "a",
      to: "b",
      transition: { type: "fade", duration: "1" },
    });
    success(run("clip.split", { clip: "b", at: "2.25" }));
    expect(joinOf("j")).toMatchObject({ from: "a", to: "b", transition: { duration: "0.5" } });
  });

  it("stays where a window or a file took its clips apart, doing nothing, for people to fix", () => {
    const { store, joinOf } = joined();
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    const video = file.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.clips[1].start = "3";
    success(store.importFile(MAIN, JSON.stringify(file), { origin: USER }) as never);
    expect(joinOf("j")).toBeDefined();
    const problems = readProject(store.exportFiles().files).problems;
    expect(problems.map(({ code }) => code)).toContain("join-detached");
    // A move afterwards is not what took them apart, so it leaves the join alone too.
    const moved = store.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c", start: "8" }] },
    });
    expect(success(moved).results).toEqual([undefined]);
    expect(joinOf("j")).toBeDefined();
  });

  it("does not stop the transitions at its ends from changing, and they leave it its room", () => {
    const { run, main } = project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "2" }];
    });
    const set = (params: object) => run("clip.setTransition", { clip: "b", ...params });
    success(set({ exit: { type: "fade", duration: "1" } }));
    expect(failure(set({ exit: { type: "fade", duration: "1.5" } })).message).toBe(
      "这个转场和片段另一头的衔接转场加起来比片段长",
    );
    expect(main()?.clips["b"]?.exit?.duration).toBe("1");
  });
});

describe("a join in the render plan", () => {
  it("has its layers show past their clips for it, on their own clocks", () => {
    const { run, store } = project((video) => {
      video.clips[0].exit = { type: "fade", duration: "0.5" };
      video.clips[1].enter = { type: "fade", duration: "0.5" };
    });
    success(
      run("join.add", { id: "j", from: "a", to: "b", type: "wipe", variant: "up", duration: "1" }),
    );
    const plan = buildRenderPlan(store.getState(), "main");
    expect(plan?.joins).toEqual([
      {
        id: "j",
        track: expect.any(String),
        from: "a",
        to: "b",
        how: {
          kind: "built-in",
          type: "wipe",
          variant: "up",
          values: { softness: 0.02, direction: [0, -1] },
        },
        start: 1.5,
        end: 2.5,
        duration: 1,
      },
    ]);
    const [a, b, c] = plan?.layers ?? [];
    expect(a).toMatchObject({ id: "a", start: 0, end: 2, shows: { from: 0, to: 2.5 } });
    expect(b).toMatchObject({ id: "b", start: 2, end: 4, shows: { from: 1.5, to: 4 } });
    // The join wins over what the clips had at the cut.
    expect(a).not.toHaveProperty("exit");
    expect(b).not.toHaveProperty("enter");
    expect(c).not.toHaveProperty("shows");
  });

  it("is a fade that says so where this editor cannot do it, and nothing on a hidden track", () => {
    const { store, track, run } = project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "plugin.star", duration: "1" }];
    });
    expect(buildRenderPlan(store.getState(), "main")?.joins[0]).toMatchObject({
      how: { kind: "built-in", type: "fade" },
      missing: true,
    });
    success(run("track.update", { track, changes: { hidden: true } }));
    expect(buildRenderPlan(store.getState(), "main")?.joins).toEqual([]);
  });

  it("is no longer than the clips on its sides, with its progress over what is left", () => {
    const { store } = project((video) => {
      video.clips[0].duration = "0.4";
      video.clips[1].start = "0.4";
      video.clips[2].start = "2.4";
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "2" }];
    });
    const [join] = buildRenderPlan(store.getState(), "main")?.joins ?? [];
    // A second before the cut is more than the 0.4 of a: that much is all it gets.
    expect(join).toMatchObject({ start: 0, end: 1.4, duration: 1.4 });
  });

  it("is a fade where it says it is something only for sound, or for one end of a clip", () => {
    const { store } = project((video) => {
      video.joins = [
        { id: "j", from: "a", to: "b", type: "fade-linear", duration: "1" },
        { id: "k", from: "b", to: "c", type: "dip", duration: "1" },
      ];
    });
    expect(buildRenderPlan(store.getState(), "main")?.joins).toMatchObject([
      { id: "j", how: { type: "fade" }, missing: true },
      { id: "k", how: { type: "fade" }, missing: true },
    ]);
  });

  it("stays the same object while nothing about it changes", () => {
    const { store, run } = project((video) => {
      video.joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }];
    });
    const before = buildRenderPlan(store.getState(), "main");
    success(run("clip.update", { clip: "c", changes: { name: "c" } }));
    const after = buildRenderPlan(store.getState(), "main");
    expect(after?.joins[0]).toBe(before?.joins[0]);
    expect(after?.layers[0]).toBe(before?.layers[0]);
  });
});
