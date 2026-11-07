import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
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
