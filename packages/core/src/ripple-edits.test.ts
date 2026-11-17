import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

/**
 * Ripple edits: removing clips and closing the gap they leave, closing gaps, lifting and
 * extracting. What comes after moves back on every track that ripples, or nothing happens.
 */

const MAIN = "timelines/main/timeline.json";
const media = { asset: "file" };
const color = (id: string, start: string, duration: string, more: object = {}) => ({
  id,
  start,
  duration,
  source: { kind: "color", color: "#ff0000" },
  ...more,
});
const picture = (id: string, start: string, duration: string, link?: string) => ({
  id,
  start,
  duration,
  source: { kind: "video", media },
  ...(link && { link }),
});
const sound = (id: string, start: string, duration: string, link?: string) => ({
  id,
  start,
  duration,
  source: { kind: "audio", media },
  ...(link && { link }),
});

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

interface Layout {
  readonly video?: readonly object[];
  readonly overlay?: readonly object[];
  readonly audio?: readonly object[];
  readonly joins?: readonly object[];
  readonly sections?: readonly object[];
  readonly markers?: readonly object[];
}

/**
 * A timeline with two video tracks and one audio track. Without sections of its own it is one of
 * 20 seconds.
 */
function project(layout: Layout) {
  const files = writeProject(createProject({ name: "波纹" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  timeline.sections = layout.sections ?? [{ id: "s1", duration: "20" }];
  if (layout.markers) timeline.markers = layout.markers;
  timeline.tracks = [
    {
      id: "V1",
      kind: "video",
      clips: layout.video ?? [],
      ...(layout.joins && { joins: layout.joins }),
    },
    { id: "V2", kind: "video", clips: layout.overlay ?? [] },
    { id: "A1", kind: "audio", clips: layout.audio ?? [] },
  ];
  files.set(MAIN, JSON.stringify(timeline));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  const main = () => store.getState().timelines["main"]!;
  const run = (type: string, params: Record<string, unknown>) =>
    store.execute({ type, params: { timeline: "main", ...params } });
  const startOf = (id: string) => main().clips[id]?.start;
  const spanOf = (id: string) => {
    const clip = main().clips[id];
    return clip && `${clip.start}+${clip.duration}`;
  };
  const sections = () =>
    Object.values(main().sections)
      .toSorted((a, b) => a.order - b.order)
      .map(({ id, duration }) => `${id}:${duration}`);
  const markers = () =>
    Object.values(main().markers)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(({ id, time, duration }) => `${id}@${time}${duration ? `+${duration}` : ""}`);
  return { store, main, run, startOf, spanOf, sections, markers };
}

describe("clip.remove with ripple", () => {
  it("closes the gap on every track: the picture and the sound after it go back together", () => {
    const { run, startOf, sections, store } = project({
      video: [picture("a", "0", "2", "la"), picture("b", "2", "3", "lb"), picture("c", "5", "4")],
      audio: [sound("sa", "0", "2", "la"), sound("sb", "2", "3", "lb"), sound("sc", "5", "4")],
      overlay: [color("o", "9", "2")],
    });
    const result = success(run("clip.remove", { clips: ["b", "sb"], ripple: true }));
    expect(result.results[0]).toEqual({ moved: ["c", "o", "sc"] });
    expect([startOf("a"), startOf("c"), startOf("sc"), startOf("o")]).toEqual(["0", "2", "2", "6"]);
    expect([startOf("b"), startOf("sb")]).toEqual([undefined, undefined]);
    expect(sections()).toEqual(["s1:17"]);
    // One step back is exactly where it was.
    const after = structuredClone(store.getState().timelines["main"]);
    store.undo();
    expect([startOf("b"), startOf("c"), startOf("o")]).toEqual(["2", "5", "9"]);
    expect(sections()).toEqual(["s1:20"]);
    store.redo();
    expect(store.getState().timelines["main"]).toEqual(after);
  });

  it("closes the gaps of clips apart from each other, each by what was before it", () => {
    const { run, startOf } = project({
      video: [
        color("a", "0", "1"),
        color("b", "1", "2"),
        color("c", "3", "1"),
        color("d", "4", "2"),
      ],
    });
    success(run("clip.remove", { clips: ["a", "c"], ripple: true }));
    expect([startOf("b"), startOf("d")]).toEqual(["0", "2"]);
  });

  it("does nothing when another track has something in the gap, and says what and where", () => {
    const { run, store, startOf } = project({
      video: [picture("b", "2", "3", "lb"), color("c", "5", "4")],
      audio: [sound("sb", "2", "3", "lb"), sound("x", "8", "1")],
    });
    const before = structuredClone(store.getState());
    // Only the picture, as with Alt: its sound is still in that time.
    const result = run("clip.remove", { clips: ["b"], ripple: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "ripple-blocked",
      params: { clips: [{ id: "sb" }], tracks: ["A1"] },
    });
    expect(store.getState()).toEqual(before);
    // Only the track of the picture moves then, and the sound stays where it is.
    success(run("clip.remove", { clips: ["b"], ripple: true, rippleTracks: ["V1"] }));
    expect([startOf("c"), startOf("sb"), startOf("x")]).toEqual(["2", "2", "8"]);
  });

  it("leaves a track out that is not listed, as a locked one", () => {
    const { run, startOf, sections } = project({
      video: [color("b", "2", "3"), color("c", "5", "4")],
      overlay: [color("o", "3", "1"), color("p", "9", "2")],
      audio: [sound("long", "0", "20")],
    });
    success(run("clip.remove", { clips: ["b"], ripple: true, rippleTracks: ["V1"] }));
    expect([startOf("c"), startOf("o"), startOf("p"), startOf("long")]).toEqual([
      "2",
      "3",
      "9",
      "0",
    ]);
    // The sound that stayed still ends at 20: the timeline gets no shorter than what is on it.
    expect(sections()).toEqual(["s1:20"]);
  });

  it("without ripple removes and moves nothing, as before", () => {
    const { run, startOf } = project({ video: [color("b", "2", "3"), color("c", "5", "4")] });
    const result = success(run("clip.remove", { clips: ["b"] }));
    expect(result.results[0]).toBeUndefined();
    expect(startOf("c")).toBe("5");
  });

  it("fails for a track that is not there", () => {
    const { run } = project({ video: [color("b", "2", "3")] });
    const result = run("clip.remove", { clips: ["b"], ripple: true, rippleTracks: ["V9"] });
    expect(!result.ok && result.error).toMatchObject({
      code: "not-found",
      params: { kind: "track", id: "V9" },
    });
  });
});

describe("timeline.closeGap", () => {
  it("takes a stretch out: what starts at its end or later moves back, sections and markers too", () => {
    const { run, startOf, sections, markers } = project({
      video: [color("a", "0", "2"), color("c", "5", "4")],
      audio: [sound("s", "0", "2"), sound("t", "6", "1")],
      sections: [
        { id: "s1", duration: "3" },
        { id: "s2", duration: "2" },
        { id: "s3", duration: "15" },
      ],
      markers: [
        { id: "m1", time: "1" },
        { id: "m2", time: "3" },
        { id: "m3", time: "5" },
        { id: "m4", time: "1", duration: "3" },
        { id: "m5", time: "2.5", duration: "1" },
      ],
    });
    const result = success(run("timeline.closeGap", { ranges: [{ from: "2", to: "5" }] }));
    expect(result.results[0]).toEqual({ moved: ["c", "t"], sectionsRemoved: ["s2"] });
    expect([startOf("a"), startOf("c"), startOf("s"), startOf("t")]).toEqual(["0", "2", "0", "3"]);
    expect(sections()).toEqual(["s1:2", "s3:15"]);
    // Within the stretch: to its start; across it: shorter; all of one in it: a point at its start.
    expect(markers()).toEqual(["m1@1", "m2@2", "m3@2", "m4@1+1", "m5@2"]);
  });

  it("takes out several stretches at once, each moving what is after it by all before it", () => {
    const { run, startOf } = project({
      video: [color("a", "1", "1"), color("b", "4", "1"), color("c", "8", "1")],
    });
    success(
      run("timeline.closeGap", {
        ranges: [
          { from: "5", to: "8" },
          { from: "0", to: "1" },
        ],
      }),
    );
    expect([startOf("a"), startOf("b"), startOf("c")]).toEqual(["0", "3", "4"]);
  });

  it("counts overlapping stretches once", () => {
    const { run, startOf } = project({ video: [color("c", "8", "1")] });
    success(
      run("timeline.closeGap", {
        ranges: [
          { from: "2", to: "5" },
          { from: "4", to: "6" },
          { from: "6", to: "7" },
        ],
      }),
    );
    expect(startOf("c")).toBe("3");
  });

  it("is blocked by a clip in the stretch on any track that ripples, also one that crosses it", () => {
    const { run, store } = project({
      video: [color("a", "0", "2"), color("c", "5", "4")],
      overlay: [color("o", "1", "2")],
    });
    const before = structuredClone(store.getState());
    const result = run("timeline.closeGap", { ranges: [{ from: "2", to: "5" }] });
    expect(!result.ok && result.error).toMatchObject({
      code: "ripple-blocked",
      params: { clips: [{ id: "o" }], tracks: ["V2"] },
    });
    expect(store.getState()).toEqual(before);
    success(run("timeline.closeGap", { ranges: [{ from: "2", to: "5" }], rippleTracks: ["V1"] }));
  });

  it("is exact on frames that are no whole numbers", () => {
    const { run, startOf } = project({ video: [color("c", "1001/1000", "1")] });
    success(run("timeline.closeGap", { ranges: [{ from: "1/30000", to: "1001/30000" }] }));
    expect(startOf("c")).toBe("2903/3000");
  });

  it("checks the stretches", () => {
    const { run } = project({});
    const backwards = run("timeline.closeGap", { ranges: [{ from: "8", to: "6" }] });
    expect(!backwards.ok && backwards.error).toMatchObject({
      code: "invalid-value",
      params: { rule: "range-backwards", path: "ranges.0", from: "8", to: "6" },
    });
    const outside = run("timeline.closeGap", { ranges: [{ from: "8", to: "21" }] });
    expect(!outside.ok && outside.error).toMatchObject({
      code: "invalid-value",
      params: { rule: "range-outside", path: "ranges.0.to", to: "21", length: "20" },
    });
    expect(run("timeline.closeGap", { ranges: [{ from: "8", to: "20" }] }).ok).toBe(true);
  });

  it("leaves one frame of a timeline that is all taken out", () => {
    const { run, sections, markers } = project({
      sections: [
        { id: "s1", duration: "4" },
        { id: "s2", duration: "6" },
      ],
      markers: [{ id: "m", time: "7" }],
    });
    const result = success(run("timeline.closeGap", { ranges: [{ from: "0", to: "10" }] }));
    expect(result.results[0]).toEqual({ sectionsRemoved: ["s2"] });
    expect(sections()).toEqual(["s1:1/30"]);
    expect(markers()).toEqual(["m@0"]);
  });

  it("takes along joins between clips that move together", () => {
    const { run, startOf, main } = project({
      video: [color("c", "5", "2"), color("d", "7", "2")],
      joins: [{ id: "j", from: "c", to: "d", type: "fade", duration: "1" }],
    });
    success(run("timeline.closeGap", { ranges: [{ from: "1", to: "5" }] }));
    expect([startOf("c"), startOf("d")]).toEqual(["1", "3"]);
    expect(main().joins?.["j"]).toBeDefined();
  });

  it("moves clips that already overlapped on an audio track together", () => {
    const { run, spanOf } = project({ audio: [sound("x", "4", "3"), sound("y", "5", "3")] });
    success(run("timeline.closeGap", { ranges: [{ from: "1", to: "4" }] }));
    expect([spanOf("x"), spanOf("y")]).toEqual(["1+3", "2+3"]);
    const blocked = run("timeline.closeGap", { ranges: [{ from: "4", to: "5" }] });
    expect(!blocked.ok && blocked.error.code).toBe("ripple-blocked");
  });
});

describe("timeline.removeRange", () => {
  const layout: Layout = {
    video: [picture("v", "0", "10", "film"), color("c", "12", "2")],
    audio: [sound("s", "0", "10", "film"), sound("t", "3", "1", "other")],
    overlay: [color("o", "3", "2")],
  };

  it("lifts: what is in the stretch goes, and the clips across it are cut in two", () => {
    const { run, spanOf, main, startOf } = project(layout);
    const result = success(run("timeline.removeRange", { from: "2", to: "6" }));
    const { removed, split } = result.results[0] as {
      removed: string[];
      split: { clip: string; piece: string }[];
    };
    expect(removed.toSorted()).toEqual(["o", "t"]);
    expect(split.map(({ clip }) => clip).toSorted()).toEqual(["s", "v"]);
    const pieceOf = (clip: string) => split.find((each) => each.clip === clip)!.piece;
    expect([spanOf("v"), spanOf(pieceOf("v")), spanOf("s"), spanOf(pieceOf("s"))]).toEqual([
      "0+2",
      "6+4",
      "0+2",
      "6+4",
    ]);
    // The parts before keep their group, those after are a group of their own.
    const linkOf = (id: string) => main().clips[id]?.link;
    expect([linkOf("v"), linkOf("s")]).toEqual(["film", "film"]);
    expect(linkOf(pieceOf("v"))).toBe(linkOf(pieceOf("s")));
    expect(linkOf(pieceOf("v"))).not.toBe("film");
    expect(linkOf(pieceOf("v"))).toBeDefined();
    // The clock of what is after the cut reads on where it was.
    expect(main().clips[pieceOf("v")]?.offset).toBe("6");
    expect(startOf("c")).toBe("12");
  });

  it("extracts: lifts, and closes the stretch on the same tracks", () => {
    const { run, spanOf, sections } = project(layout);
    const result = success(run("timeline.removeRange", { from: "2", to: "6", ripple: true }));
    const { split, moved } = result.results[0] as {
      split: { clip: string; piece: string }[];
      moved: string[];
    };
    const pieces = split.map(({ piece }) => piece);
    expect(moved.toSorted()).toEqual(["c", ...pieces].toSorted());
    expect(pieces.map(spanOf)).toEqual(["2+4", "2+4"]);
    expect(spanOf("c")).toBe("8+2");
    expect(sections()).toEqual(["s1:16"]);
  });

  it("only touches the tracks it lists", () => {
    const { run, spanOf, main } = project(layout);
    const result = success(
      run("timeline.removeRange", { from: "2", to: "6", tracks: ["V1"], ripple: true }),
    );
    const { split } = result.results[0] as { split: { clip: string; piece: string }[] };
    expect(split).toHaveLength(1);
    // The only part after the cut of its group has nothing to be linked with.
    expect(main().clips[split[0]!.piece]?.link).toBeUndefined();
    expect([spanOf("s"), spanOf("t"), spanOf("o"), spanOf("c")]).toEqual([
      "0+10",
      "3+1",
      "3+2",
      "8+2",
    ]);
  });

  it("takes a join at an edge that it cuts away", () => {
    const { run, main } = project({
      video: [color("a", "0", "4"), color("b", "4", "4")],
      joins: [{ id: "j", from: "a", to: "b", type: "fade", duration: "1" }],
    });
    const result = success(run("timeline.removeRange", { from: "3", to: "5" }));
    expect(result.results[0]).toMatchObject({ joinsRemoved: ["j"] });
    expect(main().joins?.["j"]).toBeUndefined();
  });

  it("checks the stretch and the tracks", () => {
    const { run } = project(layout);
    const backwards = run("timeline.removeRange", { from: "6", to: "2" });
    expect(!backwards.ok && backwards.error.params).toMatchObject({ rule: "range-backwards" });
    const unknown = run("timeline.removeRange", { from: "2", to: "6", tracks: ["nope"] });
    expect(!unknown.ok && unknown.error.code).toBe("not-found");
  });
});

describe("cutting clips away under a drop", () => {
  it("gives the parts after the cut of a linked group a new link together", () => {
    const { run, main } = project({
      video: [picture("v", "0", "10", "film"), color("x", "12", "2")],
      audio: [sound("s", "0", "10", "film"), sound("y", "12", "2")],
    });
    success(run("clip.link", { clips: ["x", "y"] }));
    success(
      run("clip.move", {
        clips: [
          { clip: "x", start: "4" },
          { clip: "y", start: "4" },
        ],
        overlap: "overwrite",
      }),
    );
    const clips = Object.values(main().clips);
    const after = clips.filter((clip) => clip.start === "6");
    expect(after).toHaveLength(2);
    const [first, second] = after;
    expect(first?.link).toBe(second?.link);
    expect(first?.link).not.toBe("film");
    expect(
      clips
        .filter((clip) => clip.link === "film")
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual(["s", "v"]);
  });

  it("gives the only part after a cut of its group no link", () => {
    const { run, main } = project({
      video: [picture("v", "0", "10", "film")],
      audio: [sound("s", "0", "10", "film")],
    });
    const added = success(
      run("clip.add", {
        track: "V1",
        start: "4",
        duration: "2",
        source: { kind: "color", color: "#00ff00" },
        overlap: "overwrite",
      }),
    );
    const id = (added.results[0] as { id: string }).id;
    const piece = Object.values(main().clips).find((clip) => clip.start === "6" && clip.id !== id);
    expect(piece?.link).toBeUndefined();
    expect([main().clips["v"]?.link, main().clips["s"]?.link]).toEqual(["film", "film"]);
  });
});
