import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const media = { asset: "file" };
const PAIRS = 2500;

/** 2500 videos with their sound, a second apart: 5000 clips, each pair linked. */
function longTimeline(): ProjectStore {
  const pairs = Array.from({ length: PAIRS }, (_, index) => ({
    start: String(index * 2),
    duration: "1",
    link: `l${index}`,
  }));
  const project = createProject({ name: "大项目" });
  const main = project.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const clipsOf = (kind: "video" | "audio", prefix: string) =>
    pairs.map((pair, index) => ({ ...pair, id: `${prefix}${index}`, source: { kind, media } }));
  const tracks = [
    { id: "video", kind: "video", clips: clipsOf("video", "v") },
    { id: "audio", kind: "audio", clips: clipsOf("audio", "s") },
  ];
  return ProjectStore.create({
    ...project,
    timelines: new Map([
      [
        "main",
        {
          document: { ...main, sections: [{ id: "all", duration: "5000" }], tracks } as never,
          overrides: new Map(),
        },
      ],
    ]),
  });
}

/**
 * A ripple edit near the start moves nearly every clip of the timeline, which is what moving all
 * of them with `clip.move` takes: it has to stay in that league (pro-editing.md, rule 10), and not
 * look at every clip again for each one.
 */
describe("ripple edits", () => {
  it(
    "near the start of 5000 clips take about as long as moving all of them",
    { timeout: 60_000 },
    () => {
      const store = longTimeline();
      const run = (type: string, params: Record<string, unknown>) =>
        success(store.execute({ type, params: { timeline: "main", ...params } }));
      const timed = (work: () => void) => {
        const started = performance.now();
        for (let index = 0; index < 2; index++) {
          work();
          store.undo();
        }
        return (performance.now() - started) / 2;
      };
      const everything = Array.from({ length: PAIRS - 1 }, (_, at) => at + 1).flatMap((index) => [
        { clip: `v${index}`, start: String(index * 2 - 1) },
        { clip: `s${index}`, start: String(index * 2 - 1) },
      ]);
      const move = timed(() => run("clip.move", { clips: everything }));
      const remove = timed(() => run("clip.remove", { clips: ["v0", "s0"], ripple: true }));
      const close = timed(() => run("timeline.closeGap", { ranges: [{ from: "1", to: "2" }] }));
      const extract = timed(() =>
        run("timeline.removeRange", { from: "0.5", to: "1.5", ripple: true }),
      );
      for (const took of [remove, close, extract]) expect(took).toBeLessThan(move * 2);
    },
  );
});
