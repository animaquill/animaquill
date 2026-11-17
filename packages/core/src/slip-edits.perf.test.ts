import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const media = { asset: "file" };
const PAIRS = 2500;

/** 2500 videos with their sound, each right after the one before: 5000 clips, each pair linked. */
function longTimeline(): ProjectStore {
  const pairs = Array.from({ length: PAIRS }, (_, index) => ({
    start: String(index * 2),
    duration: "2",
    offset: "1",
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
 * Slip, slide and roll look at the clips of the tracks they change once, with what is next to
 * them by the moment: of one clip or of every other one, they stay in the league of moving
 * clips with `clip.move` (pro-editing.md, rule 10).
 */
describe("slip, slide and roll", () => {
  it("on 5000 clips take about as long as moving them", { timeout: 60_000 }, () => {
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
    // Every other pair, each between two that give and take.
    const every = Array.from({ length: PAIRS / 2 }, (_, at) => 2 * at + 1).flatMap((index) => [
      `v${index}`,
      `s${index}`,
    ]);
    // Dropping them half a second later over what is there trims as many neighbours.
    const all = timed(() =>
      run("clip.move", {
        clips: every.map((clip) => ({ clip, start: String(Number(clip.slice(1)) * 2 + 0.5) })),
        overlap: "overwrite",
      }),
    );
    // The same clips by hand: the two that slide, and the neighbours that give and take.
    const trims = timed(() =>
      success(
        store.executeBatch(
          [
            ["v6", { start: "12.5" }],
            ["s6", { start: "12.5" }],
            ["v5", { start: "10.5" }],
            ["s5", { start: "10.5" }],
            ["v4", { end: "10.5" }],
            ["s4", { end: "10.5" }],
          ].map(([clip, edge]) => ({
            type: "clip.trim",
            params: { timeline: "main", clip, ...(edge as object) },
          })),
        ),
      ),
    );
    const slip = timed(() => run("clip.slip", { clips: ["v5", "s5"], by: "0.5" }));
    const slide = timed(() => run("clip.slide", { clips: ["v5", "s5"], by: "0.5" }));
    const roll = timed(() =>
      run("clip.roll", {
        edges: [
          { clip: "v5", edge: "end" },
          { clip: "s5", edge: "end" },
        ],
        at: "11.5",
      }),
    );
    const slideAll = timed(() => run("clip.slide", { clips: every, by: "-0.5" }));
    const slipAll = timed(() => run("clip.slip", { clips: every, by: "-0.5" }));
    for (const took of [slip, slide, roll]) expect(took).toBeLessThan(trims * 2);
    for (const took of [slideAll, slipAll]) expect(took).toBeLessThan(all * 2);
  });
});
