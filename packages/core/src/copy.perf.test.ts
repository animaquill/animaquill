import { createProject } from "@animaquill/schema";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ProjectCopy } from "./copy.ts";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

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
    name: `片段 ${index}`,
    start: String(Math.floor(index / trackCount) * 2),
    duration: "1",
    source: { kind: "color", color: "#000000" },
    enter: { type: "fade", duration: "0.2" },
    effects: [{ id: "fx", type: "blur" }],
    properties: Object.fromEntries(
      ["opacity", "transform.x", "transform.y", "transform.scale", "transform.rotation"].map(
        (path) => [path, keys],
      ),
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

/** Collects garbage, to measure what is kept. */
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

const MiB = 1024 ** 2;

describe("a copy of a large project", () => {
  /**
   * What making a copy costs: the update of the document, a document of its own read from it, and
   * the state of it. That is about what opening the project again costs, nearly all of it Yjs:
   * encoding the update (a quarter) and reading it into a document (more than half). Yjs's second
   * encoding is no faster.
   */
  it.each([
    // Measured on 8 cores: an update of 2.9, 14.7 and 10.8 MiB; 0.3, 1.8 and 1.7 s; 18, 91 and
    // 105 MiB kept; the changes after one change in 1.2, 5.4 and 8.2 ms.
    [1000, 4, 20, 1_500, 60],
    [5000, 40, 20, 6_000, 250],
    [10000, 50, 5, 6_000, 300],
  ])(
    "is made of %i clips on %i tracks with %i keys per property in reasonable time and memory",
    (count, trackCount, keyCount, mostMs, mostMiB) => {
      const source = large(count, trackCount, keyCount);
      const bytes = source.encodeState().byteLength;
      const before = heap();
      const started = performance.now();
      const forked = ProjectCopy.fork(source);
      const took = performance.now() - started;
      if (!forked.ok) throw new Error(forked.error.code);
      const kept = heap() - before;
      const { copy } = forked;
      // One change, and what changed against the base: it walks only what differs.
      success(
        copy.store.execute({
          type: "clip.update",
          params: { timeline: "main", clip: "c0", changes: { name: "x" } },
        }),
      );
      const at = performance.now();
      const changes = copy.changes();
      const listed = performance.now() - at;
      expect(changes).toHaveLength(1);
      console.info(
        `${count} clips: update ${(bytes / MiB).toFixed(1)} MiB, fork ${took.toFixed(0)} ms, kept ${(kept / MiB).toFixed(0)} MiB, changes ${listed.toFixed(1)} ms`,
      );
      expect(took).toBeLessThan(mostMs);
      expect(kept / MiB).toBeLessThan(mostMiB);
      expect(listed).toBeLessThan(50);
      copy.discard();
    },
    60_000,
  );
});
