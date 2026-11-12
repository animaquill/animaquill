import { ProjectStore, USER, type CommandCall } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { testHost, toolsOn } from "./test-support.ts";

const user = (store: ProjectStore, type: string, params: unknown) => {
  const done = store.execute({ type, params } as CommandCall, { origin: USER });
  expect(done.ok, JSON.stringify(done)).toBe(true);
};

/** A project whose main timeline has many clips. */
function manyClips(count: number): ProjectStore {
  const project = createProject({ name: "many" });
  const main = project.timelines.get("main")?.document as Record<string, unknown>;
  const clips = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    name: "c",
    start: String(index),
    duration: "1",
    source: { kind: "color", color: "#000000" },
  }));
  const document = { ...main, tracks: [{ id: "v", kind: "video", clips }] } as never;
  return ProjectStore.create({
    ...project,
    timelines: new Map([["main", { document, overrides: new Map() }]]),
  });
}

describe("what others did", () => {
  it("is quick to check after many changes, for a batch of 100 objects", async () => {
    const store = manyClips(1000);
    const { call } = toolsOn(testHost(store));
    await call("aq_timeline_read", { limit: 500 });
    for (let i = 0; i < 999; i += 1) {
      user(store, "clip.update", {
        timeline: "main",
        clip: `c${500 + (i % 400)}`,
        changes: { name: `u${i}` },
      });
    }
    const operations = Array.from({ length: 100 }, (_, i) => ({
      op: "clip.update",
      timeline: "main",
      clip: `c${i}`,
      changes: { name: `a${i}` },
    }));
    const started = performance.now();
    const result = await call("aq_edit", { operations });
    expect(result.isError, result.text).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  }, 60_000);
});
