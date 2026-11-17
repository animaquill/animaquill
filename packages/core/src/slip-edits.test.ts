import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

/**
 * Slip, slide and roll: edits that change what clips show or where their edges are, and keep the
 * time they take together. Media of 10 seconds, colours of any length.
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
const picture = (id: string, start: string, duration: string, more: object = {}) => ({
  id,
  start,
  duration,
  source: { kind: "video", media },
  ...more,
});
const sound = (id: string, start: string, duration: string, more: object = {}) => ({
  id,
  start,
  duration,
  source: { kind: "audio", media },
  ...more,
});

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

function project(layout: { video?: object[]; audio?: object[]; joins?: object[] }) {
  const files = writeProject(createProject({ name: "滑移" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  timeline.sections = [{ id: "s1", duration: "20" }];
  timeline.tracks = [
    {
      id: "V1",
      kind: "video",
      clips: layout.video ?? [],
      ...(layout.joins && { joins: layout.joins }),
    },
    { id: "A1", kind: "audio", clips: layout.audio ?? [] },
  ];
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
  const main = () => store.getState().timelines["main"]!;
  const run = (type: string, params: Record<string, unknown>) =>
    store.execute({ type, params: { timeline: "main", ...params } });
  const at = (id: string) => {
    const clip = main().clips[id];
    return clip && `${clip.start}+${clip.duration}@${clip.offset ?? "0"}`;
  };
  return { store, main, run, at };
}

const failure = (result: CommandResult) => (result.ok ? undefined : result.error);

describe("clip.slip", () => {
  it("keeps where a clip is and how long, and changes what it shows, with its keys", () => {
    const keys = { opacity: { keys: [{ time: "2", value: 1 }] } };
    const { run, at, main, store } = project({
      video: [picture("a", "1", "4", { offset: "2", properties: keys })],
    });
    success(run("clip.slip", { clips: ["a"], by: "1.5" }));
    expect(at("a")).toBe("1+4@3.5");
    // On its clock, which went along with what it shows.
    expect(main().clips["a"]!.properties).toEqual(keys);
    success(run("clip.slip", { clips: ["a"], by: "-3.5" }));
    expect(at("a")).toBe("1+4@0");
    store.undo();
    expect(at("a")).toBe("1+4@3.5");
    store.redo();
    expect(at("a")).toBe("1+4@0");
  });

  it("does not go before the media starts or past its end, and slips nothing then", () => {
    const { run, at } = project({
      video: [picture("a", "0", "4", { offset: "2", link: "l" })],
      audio: [sound("s", "0", "4", { offset: "2", link: "l" })],
    });
    expect(failure(run("clip.slip", { clips: ["a", "s"], by: "-2.5" }))?.code).toBe("source-start");
    expect(failure(run("clip.slip", { clips: ["a", "s"], by: "4.5" }))?.code).toBe("source-end");
    expect([at("a"), at("s")]).toEqual(["0+4@2", "0+4@2"]);
    success(run("clip.slip", { clips: ["a", "s"], by: "4" }));
    expect([at("a"), at("s")]).toEqual(["0+4@6", "0+4@6"]);
  });

  it("moves the clock of a colour forward with its keys, where it would start before zero", () => {
    const keys = { opacity: { keys: [{ time: "1", value: 1 }] } };
    const { run, at, main, store } = project({
      video: [color("c", "2", "3", { properties: keys })],
    });
    const result = success(run("clip.slip", { clips: ["c"], by: "-2" }));
    expect(at("c")).toBe("2+3@0");
    // The key shows 2 seconds later on the timeline, as if the offset were -2.
    expect(main().clips["c"]!.properties).toEqual({
      opacity: { keys: [{ time: "3", value: 1 }] },
    });
    expect(result.ok).toBe(true);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("names no clip twice and slips what is there", () => {
    const { run } = project({ video: [picture("a", "0", "4")] });
    expect(failure(run("clip.slip", { clips: ["a", "a"], by: "1" }))?.code).toBe("invalid-params");
    expect(failure(run("clip.slip", { clips: ["x"], by: "1" }))?.code).toBe("not-found");
  });
});

describe("clip.slide", () => {
  it("moves a clip, its neighbours give and take, and the three cover what they did", () => {
    const { run, at, store } = project({
      video: [
        picture("a", "0", "3"),
        picture("b", "3", "2", { offset: "1" }),
        picture("c", "5", "3"),
      ],
    });
    success(run("clip.slide", { clips: ["b"], by: "1" }));
    expect([at("a"), at("b"), at("c")]).toEqual(["0+4@0", "4+2@1", "6+2@1"]);
    success(run("clip.slide", { clips: ["b"], by: "-1" }));
    expect([at("a"), at("b"), at("c")]).toEqual(["0+3@0", "3+2@1", "5+3@0"]);
    store.undo();
    store.undo();
    expect([at("a"), at("b"), at("c")]).toEqual(["0+3@0", "3+2@1", "5+3@0"]);
  });

  it("cannot take the start of a neighbour to before its media starts", () => {
    const { run, at } = project({
      video: [picture("a", "0", "3"), picture("b", "3", "2"), picture("c", "5", "3")],
    });
    expect(failure(run("clip.slide", { clips: ["b"], by: "-1" }))?.code).toBe("source-start");
    expect(at("c")).toBe("5+3@0");
  });

  it("makes the empty time on a side longer or shorter, and stops at what is past it", () => {
    const { run, at } = project({
      video: [picture("a", "0", "3"), picture("b", "3", "2"), picture("d", "7", "2")],
    });
    success(run("clip.slide", { clips: ["b"], by: "1.5" }));
    expect([at("a"), at("b"), at("d")]).toEqual(["0+4.5@0", "4.5+2@0", "7+2@0"]);
    const result = failure(run("clip.slide", { clips: ["b"], by: "1" }));
    expect(result?.code).toBe("overlap");
    expect(result?.params).toEqual({ clips: [{ id: "b" }, { id: "d" }] });
  });

  it("slides clips next to each other as one block", () => {
    const { run, at } = project({
      video: [
        color("a", "0", "3"),
        color("b", "3", "1"),
        color("c", "4", "1"),
        color("d", "5", "3"),
      ],
    });
    success(run("clip.slide", { clips: ["b", "c"], by: "-1" }));
    expect([at("a"), at("b"), at("c"), at("d")]).toEqual(["0+2@0", "2+1@0", "3+1@0", "4+4@0"]);
  });

  it("does not take a neighbour down to nothing", () => {
    const { run } = project({
      video: [color("a", "0", "1"), color("b", "1", "2"), color("c", "3", "3")],
    });
    expect(failure(run("clip.slide", { clips: ["b"], by: "-1" }))?.code).toBe("overlap");
    expect(failure(run("clip.slide", { clips: ["b"], by: "-0.9" }))).toBeUndefined();
    expect(failure(run("clip.slide", { clips: ["a"], by: "-0.5" }))?.params).toEqual({
      rule: "before-zero",
      clip: "a",
    });
  });

  it("keeps joins on the edges, as long as there is room for them", () => {
    const joins = [
      { id: "j1", from: "a", to: "b", type: "fade", duration: "1" },
      { id: "j2", from: "b", to: "c", type: "fade", duration: "1" },
    ];
    const { run, main } = project({
      video: [color("a", "0", "3"), color("b", "3", "2"), color("c", "5", "3")],
      joins,
    });
    const result = success(run("clip.slide", { clips: ["b"], by: "2" }));
    expect(result.results[0]).toBeUndefined();
    expect(Object.keys(main().joins ?? {}).toSorted()).toEqual(["j1", "j2"]);
    // c is one second long now: half a second of a join in the middle is all of it.
    expect(main().joins?.["j2"]?.transition?.duration).toBe("1");
    expect(main().clips["c"]!.duration).toBe("1");
  });

  it("says which joins went, also one on the other edge of a neighbour left without room", () => {
    // b is 0.6 seconds between two joins and has a fade at its end: sliding c earlier leaves b too
    // little, the join at its end goes, its own fade comes back there, and the join at its start
    // goes too. Both are said.
    const joins = [
      { id: "j0", from: "a", to: "b", type: "fade", duration: "1/3" },
      { id: "j1", from: "b", to: "c", type: "fade", duration: "1/3" },
    ];
    const { run, main } = project({
      video: [
        color("a", "0", "3"),
        color("b", "3", "0.6", { exit: { type: "fade", duration: "0.5" } }),
        color("c", "3.6", "3"),
      ],
      joins,
    });
    const result = success(run("clip.slide", { clips: ["c"], by: "-7/15" }));
    const left = Object.keys(main().joins ?? {});
    const gone = ["j0", "j1"].filter((id) => !left.includes(id));
    expect(gone.length).toBeGreaterThan(0);
    const said = (result.results?.[0] as { joinsRemoved?: string[] } | undefined)?.joinsRemoved;
    expect([...(said ?? [])].toSorted()).toEqual(gone);
  });

  it("slides the sound linked to a picture by as much, each with its own neighbours", () => {
    const { run, at } = project({
      video: [color("a", "0", "3"), color("b", "3", "2", { link: "l" }), color("c", "5", "3")],
      audio: [sound("s", "2", "4", { link: "l" })],
    });
    success(run("clip.slide", { clips: ["b", "s"], by: "1" }));
    expect([at("a"), at("b"), at("c"), at("s")]).toEqual(["0+4@0", "4+2@0", "6+2@1", "3+4@0"]);
  });
});

describe("clip.roll", () => {
  it("moves a cut: one clip gets longer and the next shorter, together as long", () => {
    const { run, at, store } = project({
      video: [picture("a", "0", "3"), picture("b", "3", "3", { offset: "2" })],
    });
    success(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "4" }));
    expect([at("a"), at("b")]).toEqual(["0+4@0", "4+2@3"]);
    success(run("clip.roll", { edges: [{ clip: "b", edge: "start" }], at: "2" }));
    expect([at("a"), at("b")]).toEqual(["0+2@0", "2+4@1"]);
    store.undo();
    expect([at("a"), at("b")]).toEqual(["0+4@0", "4+2@3"]);
  });

  it("stops where a side would run out of media or of time", () => {
    const { run } = project({
      video: [picture("a", "0", "3", { offset: "6" }), picture("b", "3", "3")],
    });
    const other = project({ video: [picture("a", "0", "3"), picture("b", "3", "3")] });
    expect(failure(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "5" }))?.code).toBe(
      "source-end",
    );
    expect(failure(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "2" }))?.code).toBe(
      "source-start",
    );
    expect(
      failure(other.run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "6" }))?.params,
    ).toEqual({ rule: "end-before-start", clip: "b" });
  });

  it("is a trim where nothing is next to the edge, and does not run into anything", () => {
    const { run, at } = project({ video: [color("a", "0", "3"), color("b", "5", "3")] });
    success(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "4" }));
    expect([at("a"), at("b")]).toEqual(["0+4@0", "5+3@0"]);
    expect(failure(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "6" }))?.code).toBe(
      "overlap",
    );
  });

  it("moves the other edges by as much, as the sound linked to a picture that ends later", () => {
    const { run, at } = project({
      video: [color("a", "0", "3", { link: "l" }), color("b", "3", "3")],
      audio: [sound("s", "0", "4", { link: "l" }), sound("t", "4", "3", { offset: "2" })],
    });
    success(
      run("clip.roll", {
        edges: [
          { clip: "a", edge: "end" },
          { clip: "s", edge: "end" },
        ],
        at: "2",
      }),
    );
    expect([at("a"), at("b"), at("s"), at("t")]).toEqual(["0+2@0", "2+4@0", "0+3@0", "3+4@1"]);
  });

  it("keeps a join on the cut it moves, shorter where it has to be", () => {
    const joins = [{ id: "j", from: "a", to: "b", type: "fade", duration: "2" }];
    const { run, main } = project({
      video: [color("a", "0", "3"), color("b", "3", "3")],
      joins,
    });
    const result = success(run("clip.roll", { edges: [{ clip: "a", edge: "end" }], at: "5.5" }));
    expect(result.results[0]).toBeUndefined();
    expect(main().joins?.["j"]?.transition?.duration).toBe("1");
  });
});
