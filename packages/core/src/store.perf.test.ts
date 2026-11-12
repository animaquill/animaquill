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

describe("the check of documents before a change is written", () => {
  /**
   * What every command pays for not breaking a document: reading again what it touched, here one
   * timeline of 1000 clips with properties, keys and transitions, as one drag of one clip touches it.
   */
  it("takes a few milliseconds for a timeline of 1000 clips", () => {
    const project = createProject({ name: "大项目" });
    const main = project.timelines.get("main")?.document;
    if (!main) throw new Error("no timeline");
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 1 },
      ],
    };
    const clips = Array.from({ length: 1000 }, (_, index) => ({
      id: `c${index}`,
      start: String(index * 2),
      duration: "1",
      source: color,
      enter: { type: "fade", duration: "0.2" },
      properties: { opacity: 0.5, "transform.x": keys },
    }));
    const tracks = [0, 1, 2, 3].map((number) => ({
      id: `t${number}`,
      kind: "video",
      clips: clips.filter((_, index) => index % 4 === number),
    }));
    const store = ProjectStore.create({
      ...project,
      timelines: new Map([
        ["main", { document: { ...main, tracks } as never, overrides: new Map() }],
      ]),
    });
    const before = store.getState();
    const move = (start: string) => ({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c0", start }] },
    });
    // What a dry run of a drag costs, which runs every check and writes nothing. The first one
    // reads every clip; later ones only what changed, see `clipIssue`.
    const first = performance.now();
    const plan = success(store.execute(move("0.5"), { dryRun: true }));
    const cold = performance.now() - first;
    const timed = (run: () => void) => {
      const times: number[] = [];
      for (let round = 0; round < 30; round++) {
        const started = performance.now();
        run();
        times.push(performance.now() - started);
      }
      return times.toSorted((a, b) => a - b)[15] as number;
    };
    const check = timed(() => brokenDocument(before, plan.state, plan.patches));
    const command = timed(() => success(store.execute(move("0.5"), { dryRun: true })));
    console.info(
      `first command ${cold.toFixed(1)} ms; then the check ${check.toFixed(2)} ms, the command ${command.toFixed(2)} ms`,
    );
    expect(check).toBeLessThan(10);
    expect(command).toBeLessThan(20);
  });
});
