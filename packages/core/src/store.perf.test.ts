import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { brokenDocument } from "./document-check.ts";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const color = { kind: "color", color: "#000000" };

describe("moving several clips", () => {
  it("stays quick with thousands of clips", () => {
    const clips = Array.from({ length: 3000 }, (_, index) => ({
      id: `c${index}`,
      start: String(index * 2),
      duration: "1",
    }));
    const project = createProject({ name: "大项目" });
    const main = project.timelines.get("main")?.document;
    if (!main) throw new Error("no timeline");
    const track = {
      id: "track",
      kind: "video",
      clips: clips.map((item) => ({ ...item, source: color })),
    };
    const store = ProjectStore.create({
      ...project,
      timelines: new Map([
        ["main", { document: { ...main, tracks: [track] } as never, overrides: new Map() }],
      ]),
    });
    const started = performance.now();
    success(
      store.execute({
        type: "clip.move",
        params: {
          timeline: "main",
          clips: clips.map(({ id, start }) => ({ clip: id, start: `${start}.5` })),
          overlap: "overwrite",
        },
      }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(store.getState().timelines["main"]?.clips["c2999"]?.start).toBe("5998.5");
  });
});

/** A large timeline: clips spread over tracks, each with transitions, an effect and keys. */
function large(count: number, trackCount: number, keyCount: number): ProjectStore {
  const project = createProject({ name: "大项目" });
  const main = project.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const keys = {
    keys: Array.from({ length: keyCount }, (_, index) => ({
      time: String(index / 10),
      value: index / keyCount,
    })),
  };
  const clips = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    start: String(Math.floor(index / trackCount) * 2),
    duration: "1",
    source: color,
    enter: { type: "fade", duration: "0.2" },
    exit: { type: "fade", duration: "0.2" },
    effects: [{ id: "fx", type: "blur" }],
    properties: Object.fromEntries(
      ["opacity", "transform.x", "transform.y", "transform.scale", "transform.rotation"]
        .concat("effect.fx.radius")
        .map((path) => [path, keys]),
    ),
  }));
  const tracks = Array.from({ length: trackCount }, (_track, number) => ({
    id: `t${number}`,
    kind: "video",
    clips: clips.filter((_, index) => index % trackCount === number),
  }));
  return ProjectStore.create({
    ...project,
    timelines: new Map([
      ["main", { document: { ...main, tracks } as never, overrides: new Map() }],
    ]),
  });
}

const median = (times: readonly number[]) =>
  times.toSorted((a, b) => a - b)[times.length >> 1] ?? 0;

describe("the check of documents before a change is written", () => {
  /**
   * What every command pays for not breaking a document: it reads what changed of a timeline, and
   * walks its clips for the rules across them, also for the first command after opening, when
   * nothing was read before. Here a drag of one clip, which is one command.
   */
  it.each([
    // Measured: 13, 19 and 38 ms for the first command; 0.02, 2.5 and 4.7 ms for the check.
    [1000, 4, 2, 40, 5],
    [5000, 40, 20, 80, 10],
    [10000, 50, 5, 120, 15],
  ])(
    "lets a command through quickly on %i clips on %i tracks with %i keys per property",
    (count, trackCount, keyCount, firstMost, laterMost) => {
      // Warm the code up on another project, so that what is measured is the check.
      large(200, 4, keyCount).execute(move("c0", "0.5"));
      const store = large(count, trackCount, keyCount);
      let flip = 0;
      const next = () => move("c0", flip++ % 2 === 0 ? "0.5" : "0");
      const started = performance.now();
      success(store.execute(next()));
      const first = performance.now() - started;
      const later = median(
        Array.from({ length: 30 }, () => {
          const at = performance.now();
          success(store.execute(next()));
          return performance.now() - at;
        }),
      );
      const plan = success(store.execute(next(), { dryRun: true }));
      const before = store.getState();
      const check = median(
        Array.from({ length: 30 }, () => {
          const at = performance.now();
          brokenDocument(before, plan.state, plan.patches);
          return performance.now() - at;
        }),
      );
      console.info(
        `${count} clips: first command ${first.toFixed(1)} ms, later ${later.toFixed(2)} ms, the check ${check.toFixed(2)} ms`,
      );
      expect(first).toBeLessThan(firstMost);
      expect(check).toBeLessThan(laterMost);
    },
  );
});

const move = (clip: string, start: string) => ({
  type: "clip.move",
  params: { timeline: "main", clips: [{ clip, start }] },
});
