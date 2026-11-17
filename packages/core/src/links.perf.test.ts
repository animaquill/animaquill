import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const media = { asset: "file" };

describe("linking and unlinking", () => {
  it("stays quick with thousands of linked clips", () => {
    // 2500 videos with their sound: 5000 clips, each pair linked.
    const pairs = Array.from({ length: 2500 }, (_, index) => ({
      start: String(index * 2),
      duration: "1",
      link: `l${index}`,
    }));
    const project = createProject({ name: "大项目" });
    const main = project.timelines.get("main")?.document;
    if (!main) throw new Error("no timeline");
    const tracks = [
      {
        id: "video",
        kind: "video",
        clips: pairs.map((pair, index) => ({
          ...pair,
          id: `v${index}`,
          source: { kind: "video", media },
        })),
      },
      {
        id: "audio",
        kind: "audio",
        clips: pairs.map((pair, index) => ({
          ...pair,
          id: `s${index}`,
          source: { kind: "audio", media },
        })),
      },
    ];
    const store = ProjectStore.create({
      ...project,
      timelines: new Map([
        ["main", { document: { ...main, tracks } as never, overrides: new Map() }],
      ]),
    });
    const all = pairs.map((_, index) => `v${index}`);
    let started = performance.now();
    success(store.execute({ type: "clip.unlink", params: { timeline: "main", clips: all } }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(store.getState().timelines["main"]?.clips["s2499"]?.link).toBeUndefined();
    started = performance.now();
    for (let index = 0; index < 20; index++) {
      const clips = [`v${index}`, `s${index}`];
      success(store.execute({ type: "clip.link", params: { timeline: "main", clips } }));
    }
    // One step on a timeline this long, as moving a clip there takes.
    expect((performance.now() - started) / 20).toBeLessThan(100);
  });
});
