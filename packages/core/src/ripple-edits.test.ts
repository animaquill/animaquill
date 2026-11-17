import { createProject, formatTime, parseTime, subtract, writeProject } from "@animaquill/schema";
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

  it("leaves sections and markers where they are when a track that stays has something after the gap", () => {
    const { run, startOf, sections, markers } = project({
      overlay: [color("o", "1", "1"), color("p", "6", "2")],
      video: [color("long", "0", "20")],
      sections: [
        { id: "s1", duration: "4" },
        { id: "s2", duration: "16" },
      ],
      markers: [{ id: "m", time: "7" }],
    });
    // Only the empty time on the overlay, as with every other track locked.
    const result = success(
      run("timeline.closeGap", { ranges: [{ from: "2", to: "6" }], rippleTracks: ["V2"] }),
    );
    expect(result.results[0]).toEqual({ moved: ["p"] });
    expect([startOf("p"), startOf("long")]).toEqual(["2", "0"]);
    expect(sections()).toEqual(["s1:4", "s2:16"]);
    expect(markers()).toEqual(["m@7"]);
  });

  it("moves sections and markers when the tracks that stay have nothing after the gap", () => {
    const { run, sections, markers } = project({
      overlay: [color("o", "1", "1"), color("p", "6", "2")],
      video: [color("early", "0", "1")],
      markers: [{ id: "m", time: "7" }],
    });
    success(run("timeline.closeGap", { ranges: [{ from: "2", to: "6" }], rippleTracks: ["V2"] }));
    expect(sections()).toEqual(["s1:16"]);
    expect(markers()).toEqual(["m@3"]);
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
    // The only clip of its group cut there: its part after the cut stays with the sound under it.
    expect(main().clips[split[0]!.piece]?.link).toBe("film");
    expect([spanOf("s"), spanOf("t"), spanOf("o"), spanOf("c")]).toEqual([
      "0+10",
      "3+1",
      "3+2",
      "8+2",
    ]);
  });

  it("keeps a group together when only one of it is cut and its partner moves back with the part after the cut", () => {
    const { run, main, spanOf } = project({
      video: [picture("v", "2", "4", "film")],
      audio: [{ ...sound("a", "3", "3", "film"), offset: "1" }],
    });
    const result = success(run("timeline.removeRange", { from: "2.5", to: "3.5", ripple: true }));
    const { split } = result.results[0] as { split: { clip: string; piece: string }[] };
    const piece = split[0]!.piece;
    expect([spanOf("v"), spanOf(piece), spanOf("a")]).toEqual(["2+0.5", "2.5+2.5", "2.5+2.5"]);
    // All three stay one group: the part after the cut and the sound go on together.
    const linkOf = (id: string) => main().clips[id]?.link;
    expect([linkOf("v"), linkOf(piece), linkOf("a")]).toEqual(["film", "film", "film"]);
    expect(main().clips[piece]?.offset).toBe(main().clips["a"]?.offset);
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

  it("keeps the link for the part after a cut of the only clip of its group cut there", () => {
    // Dropped over the picture only: the sound still lies under both parts, and goes with both.
    const { run, main } = project({
      video: [picture("v", "0", "10", "film")],
      audio: [sound("s", "0", "10", "film")],
      overlay: [color("d", "4", "2")],
    });
    success(
      run("clip.move", { clips: [{ clip: "d", start: "4", track: "V1" }], overlap: "overwrite" }),
    );
    const piece = Object.values(main().clips).find((clip) => clip.id !== "s" && clip.start === "6");
    expect(piece).toBeDefined();
    expect([main().clips["v"]?.link, piece?.link, main().clips["s"]?.link]).toEqual([
      "film",
      "film",
      "film",
    ]);
  });
});

describe("timeline.openGap", () => {
  it("puts time in: what starts there or later moves on, a clip across it is cut in two", () => {
    const { run, main, startOf, spanOf, sections, markers } = project({
      video: [picture("a", "0", "4", "l"), picture("b", "4", "2")],
      audio: [sound("sa", "0", "4", "l"), sound("sb", "6", "2")],
      sections: [
        { id: "s1", duration: "3" },
        { id: "s2", duration: "17" },
      ],
      markers: [
        { id: "m1", time: "1" },
        { id: "m2", time: "2", duration: "2" },
        { id: "m3", time: "5" },
      ],
    });
    const result = success(run("timeline.openGap", { at: "3", duration: "2" }));
    const { moved, split } = result.results[0] as {
      moved: string[];
      split: { clip: string; piece: string }[];
    };
    expect(moved.toSorted()).toEqual(["b", "sb"]);
    expect(split.map(({ clip }) => clip).toSorted()).toEqual(["a", "sa"]);
    const piece = (clip: string) => split.find((each) => each.clip === clip)!.piece;
    expect([spanOf("a"), spanOf(piece("a")), startOf("b")]).toEqual(["0+3", "5+1", "6"]);
    expect([spanOf("sa"), spanOf(piece("sa")), startOf("sb")]).toEqual(["0+3", "5+1", "8"]);
    expect(main().clips[piece("a")]?.offset).toBe("3");
    // Both parts after the cut of the group are a group of their own.
    const links = [piece("a"), piece("sa")].map((id) => main().clips[id]?.link);
    expect(links[0]).toBeDefined();
    expect(links[0]).toBe(links[1]);
    expect(links[0]).not.toBe("l");
    // At a boundary, the section after it gets longer: what comes in belongs with what follows.
    expect(sections()).toEqual(["s1:3", "s2:19"]);
    expect(markers()).toEqual(["m1@1", "m2@2+4", "m3@7"]);
  });

  it("makes the timeline longer when what moved on ends past its end, also with a track left out", () => {
    const { run, sections, spanOf } = project({
      video: [color("a", "0", "8")],
      audio: [sound("s", "2", "8")],
      sections: [{ id: "s1", duration: "10" }],
    });
    success(run("timeline.openGap", { at: "1", duration: "3", rippleTracks: ["A1"] }));
    // V1 stays and has something after the moment, so sections stay; the end follows the sound.
    expect([spanOf("a"), spanOf("s")]).toEqual(["0+8", "5+8"]);
    expect(sections()).toEqual(["s1:13"]);
  });

  it("takes a join apart whose clips it puts time between", () => {
    const { run, main } = project({
      video: [color("a", "0", "2"), color("b", "2", "2")],
      joins: [{ id: "j", from: "a", to: "b", type: "fade", duration: "0.5" }],
    });
    const result = success(run("timeline.openGap", { at: "2", duration: "1" }));
    expect(result.results[0]).toEqual({ moved: ["b"], joinsRemoved: ["j"] });
    expect(main().joins?.["j"]).toBeUndefined();
  });

  it("checks where and how long", () => {
    const { run, store } = project({ video: [color("a", "0", "2")] });
    const before = structuredClone(store.getState());
    const late = run("timeline.openGap", { at: "21", duration: "1" });
    expect(!late.ok && late.error.params).toEqual({
      rule: "range-outside",
      path: "at",
      to: "21",
      length: "20",
    });
    expect(run("timeline.openGap", { at: "1", duration: "0" }).ok).toBe(false);
    expect(run("timeline.openGap", { at: "1", duration: "1", rippleTracks: ["X"] }).ok).toBe(false);
    expect(store.getState()).toEqual(before);
    // At the very end there is nothing to push, and the last section gets longer.
    expect(run("timeline.openGap", { at: "20", duration: "1" }).ok).toBe(true);
  });
});

describe("clip.add with insert", () => {
  it("makes room on every track, cutting what is across where it lands", () => {
    const { run, spanOf, startOf, sections } = project({
      video: [color("a", "0", "4"), color("b", "4", "2")],
      audio: [sound("s", "1", "6")],
    });
    const result = success(
      run("clip.add", {
        track: "V1",
        id: "n",
        start: "2",
        duration: "3",
        source: { kind: "color", color: "#00ff00" },
        overlap: "insert",
      }),
    );
    const { split } = result.results[0] as { split: { clip: string; piece: string }[] };
    const piece = (clip: string) => split.find((each) => each.clip === clip)!.piece;
    expect([spanOf("a"), spanOf("n"), spanOf(piece("a")), startOf("b")]).toEqual([
      "0+2",
      "2+3",
      "5+2",
      "7",
    ]);
    expect([spanOf("s"), spanOf(piece("s"))]).toEqual(["1+1", "5+5"]);
    expect(sections()).toEqual(["s1:23"]);
  });

  it("always makes room on its own track, also when the tracks listed leave it out", () => {
    const { run, spanOf, startOf } = project({
      video: [color("a", "0", "4")],
      audio: [sound("s", "0", "4")],
    });
    success(
      run("clip.add", {
        track: "V1",
        id: "n",
        start: "0",
        duration: "1",
        source: { kind: "color", color: "#00ff00" },
        overlap: "insert",
        rippleTracks: ["V2"],
      }),
    );
    expect([spanOf("n"), startOf("a"), startOf("s")]).toEqual(["0+1", "1", "0"]);
  });
});

describe("clip.move with insert", () => {
  it("lands between two clips and pushes what follows, leaving where it was empty", () => {
    const { run, startOf, spanOf } = project({
      video: [color("a", "0", "2"), color("b", "2", "3"), color("c", "5", "2")],
      audio: [sound("s", "6", "2")],
    });
    const result = success(
      run("clip.move", { clips: [{ clip: "a", start: "5" }], overlap: "insert" }),
    );
    expect(result.results[0]).toEqual({ moved: ["c", "s"] });
    expect([spanOf("a"), startOf("b"), startOf("c"), startOf("s")]).toEqual(["5+2", "2", "7", "8"]);
  });

  it("cuts a clip that it lands inside, and moves its partners with a group on several tracks", () => {
    const { run, spanOf, main } = project({
      video: [picture("v", "0", "4", "l"), color("x", "6", "2")],
      audio: [sound("a", "0", "4", "l"), sound("y", "6", "2", "m")],
      overlay: [color("o", "6", "2", { link: "m" })],
    });
    const result = success(
      run("clip.move", {
        clips: [
          { clip: "o", start: "2" },
          { clip: "y", start: "2" },
        ],
        overlap: "insert",
      }),
    );
    const { split } = result.results[0] as { split: { clip: string; piece: string }[] };
    expect(split.map(({ clip }) => clip).toSorted()).toEqual(["a", "v"]);
    const piece = (clip: string) => split.find((each) => each.clip === clip)!.piece;
    expect([spanOf("v"), spanOf(piece("v")), spanOf("x")]).toEqual(["0+2", "4+2", "8+2"]);
    expect([spanOf("a"), spanOf(piece("a")), spanOf("y"), spanOf("o")]).toEqual([
      "0+2",
      "4+2",
      "2+2",
      "2+2",
    ]);
    expect(main().clips[piece("v")]?.link).toBe(main().clips[piece("a")]?.link);
    expect(main().clips[piece("v")]?.link).not.toBe("l");
  });

  it("always makes room on the track it lands on, also when the tracks listed leave it out", () => {
    const { run, store } = project({
      video: [color("a", "0", "4")],
      overlay: [color("b", "5", "2")],
    });
    const before = structuredClone(store.getState());
    const result = run("clip.move", {
      clips: [{ clip: "b", start: "1", track: "V1" }],
      overlap: "insert",
      rippleTracks: ["V2"],
    });
    // V1 is where it lands, so it makes room all the same: a is cut and pushed.
    expect(result.ok).toBe(true);
    const { split } = (result.ok && result.results[0]) as { split: { piece: string }[] };
    expect(split).toHaveLength(1);
    store.undo();
    expect(store.getState().timelines).toEqual(before.timelines);
  });
});

describe("clip.trim with ripple", () => {
  const layout = () =>
    project({
      video: [picture("v", "2", "4", "l"), color("n", "6", "2")],
      audio: [sound("a", "2", "4", "l"), sound("m", "7", "2")],
      sections: [{ id: "s1", duration: "10" }],
      markers: [{ id: "k", time: "8" }],
    });

  it("shortens the end and closes the time after it, with its partner", () => {
    const { run, spanOf, startOf, sections, markers, store } = layout();
    const before = structuredClone(store.getState().timelines);
    const result = success(
      run("clip.trim", { clip: "v", end: "5", together: ["a"], ripple: true }),
    );
    expect(result.results[0]).toEqual({ moved: ["n", "m"] });
    expect([spanOf("v"), spanOf("a"), startOf("n"), startOf("m")]).toEqual([
      "2+3",
      "2+3",
      "5",
      "6",
    ]);
    expect([sections(), markers()]).toEqual([["s1:9"], ["k@7"]]);
    store.undo();
    expect(store.getState().timelines).toEqual(before);
  });

  it("lengthens the end and pushes what follows", () => {
    const { run, spanOf, startOf, sections } = layout();
    success(run("clip.trim", { clip: "v", end: "7", together: ["a"], ripple: true }));
    expect([spanOf("v"), spanOf("a"), startOf("n"), startOf("m")]).toEqual([
      "2+5",
      "2+5",
      "7",
      "8",
    ]);
    expect(sections()).toEqual(["s1:11"]);
  });

  it("shortens the start: the clips stay where they start, what they show and what follows moves back", () => {
    const { run, main, spanOf, startOf } = layout();
    success(run("clip.trim", { clip: "v", start: "3", together: ["a"], ripple: true }));
    expect([spanOf("v"), spanOf("a"), startOf("n"), startOf("m")]).toEqual([
      "2+3",
      "2+3",
      "5",
      "6",
    ]);
    expect([main().clips["v"]?.offset, main().clips["a"]?.offset]).toEqual(["1", "1"]);
  });

  it("lengthens the start from what the media has before, and pushes what follows", () => {
    const { run, main, spanOf, startOf, store } = project({
      video: [{ ...picture("v", "5", "4"), offset: "3" }, color("n", "9", "2")],
    });
    // Not before the media starts, and nothing moves then.
    const before = structuredClone(store.getState());
    const early = run("clip.trim", { clip: "v", start: "1", ripple: true });
    expect(!early.ok && early.error.code).toBe("source-start");
    expect(store.getState()).toEqual(before);
    success(run("clip.trim", { clip: "v", start: "3", ripple: true }));
    expect([spanOf("v"), main().clips["v"]?.offset, startOf("n")]).toEqual(["5+6", "1", "11"]);
  });

  it("is blocked by a partner left out, and by anything else in the time it closes", () => {
    const { run, store } = layout();
    const before = structuredClone(store.getState());
    const alone = run("clip.trim", { clip: "v", end: "5", ripple: true });
    expect(!alone.ok && alone.error.code).toBe("ripple-blocked");
    expect(!alone.ok && alone.error.params["tracks"]).toEqual(["A1"]);
    expect(store.getState()).toEqual(before);
    // Without the track of the sound, the picture goes alone.
    success(run("clip.trim", { clip: "v", end: "5", ripple: true, rippleTracks: ["V1"] }));
  });

  it("does not cut and push a partner across the edge that it was not told about", () => {
    const { run, store, main } = project({
      video: [picture("v", "0", "5", "L")],
      audio: [sound("a", "0", "8", "L")],
    });
    const before = structuredClone(store.getState());
    const result = run("clip.trim", { clip: "v", end: "7", ripple: true });
    expect(!result.ok && result.error.code).toBe("ripple-blocked");
    expect(!result.ok && result.error.params["clips"]).toEqual([{ id: "a" }]);
    expect(store.getState()).toEqual(before);
    // Told about it, both get as much longer, and stay in step.
    success(run("clip.trim", { clip: "v", end: "7", together: ["a"], ripple: true }));
    expect(
      Object.values(main().clips).map(({ id, start, duration }) => `${id}:${start}+${duration}`),
    ).toEqual(["v:0+7", "a:0+10"]);
  });
  it("keeps a join at the edge that moves, shorter where the clip got too short for it", () => {
    const { run, main } = project({
      video: [color("a", "0", "2"), color("b", "2", "2")],
      joins: [{ id: "j", from: "a", to: "b", type: "dissolve", duration: "1" }],
    });
    const result = success(run("clip.trim", { clip: "a", end: "0.4", ripple: true }));
    expect(result.results[0]).toEqual({ moved: ["b"] });
    const join = main().joins?.["j"];
    expect(join && [join.from, join.to]).toEqual(["a", "b"]);
    expect(main().clips["b"]?.start).toBe("0.4");
  });

  it("without ripple trims clips together, as before", () => {
    const { run, spanOf, startOf } = layout();
    expect(run("clip.trim", { clip: "v", end: "7", together: ["a"] }).ok).toBe(false);
    success(run("clip.trim", { clip: "v", end: "5", together: ["a"] }));
    expect([spanOf("v"), spanOf("a"), startOf("n")]).toEqual(["2+3", "2+3", "6"]);
  });
});

describe("clip.trim with ripple and partners whose edges are elsewhere", () => {
  /** A picture and a sound of one file in step (start − offset is 0), and a clip after each. */
  const layout = (spans: { start: string; duration: string }) =>
    project({
      video: [{ ...picture("v", "2", "5", "L"), offset: "2" }, color("n", "8", "2")],
      audio: [
        { ...sound("a", spans.start, spans.duration, "L"), offset: spans.start },
        sound("m", "10", "2"),
      ],
    });
  const clockOf = (clip: { start: string; offset?: string | undefined }) =>
    formatTime(subtract(parseTime(clip.start), parseTime(clip.offset ?? "0")));
  const check = ({ main }: ReturnType<typeof layout>, want: Record<string, string>) => {
    const clips = main().clips;
    expect(
      Object.fromEntries(
        Object.values(clips).map(({ id, start, duration }) => [id, `${start}+${duration}`]),
      ),
    ).toEqual(want);
    // In step as before: the same moment of the file at the same moment of the timeline.
    expect(clockOf(clips["a"]!)).toBe(clockOf(clips["v"]!));
  };

  for (const [name, partner, cases] of [
    [
      "longer",
      { start: "2", duration: "7" },
      [
        ["end", "8", { v: "2+6", a: "2+8", n: "9", m: "11" }],
        ["end", "6", { v: "2+4", a: "2+6", n: "7", m: "9" }],
        ["start", "1", { v: "2+6", a: "2+8", n: "9", m: "11" }],
        ["start", "3", { v: "2+4", a: "2+6", n: "7", m: "9" }],
      ],
    ],
    [
      "shorter",
      { start: "3", duration: "3" },
      [
        ["end", "8", { v: "2+6", a: "3+4", n: "9", m: "11" }],
        ["end", "6", { v: "2+4", a: "3+2", n: "7", m: "9" }],
        ["start", "1", { v: "2+6", a: "3+4", n: "9", m: "11" }],
        ["start", "3", { v: "2+4", a: "3+2", n: "7", m: "9" }],
      ],
    ],
  ] as const) {
    for (const [edge, to, spans] of cases) {
      it(`trims the ${edge} to ${to} with a sound that is ${name}, by as much, in step`, () => {
        const made = layout(partner);
        success(made.run("clip.trim", { clip: "v", [edge]: to, together: ["a"], ripple: true }));
        const { n, m, ...trimmed } = spans as Record<string, string>;
        const starts = { n: `${n}+2`, m: `${m}+2` };
        check(made, { ...trimmed, ...starts });
      });
    }
  }

  it("is blocked where a partner that grows runs into a clip that stays", () => {
    const { run, store } = project({
      video: [picture("v", "2", "5", "L")],
      audio: [sound("a", "2", "3", "L"), sound("m", "5.5", "1")],
    });
    const before = structuredClone(store.getState());
    const result = run("clip.trim", { clip: "v", end: "8", together: ["a"], ripple: true });
    expect(!result.ok && result.error.params["clips"]).toEqual([{ id: "m" }]);
    expect(store.getState()).toEqual(before);
  });
});
