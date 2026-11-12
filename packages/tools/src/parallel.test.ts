import { USER, type ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { testHost, toolsOn } from "./test-support.ts";
import type { ToolResult } from "./types.ts";

/**
 * Tools that only read can be called at the same time: clients such as Claude Code send read-only
 * calls together. What they give, and what the caller keeps of them for the checks of later
 * changes, has to be what calls one after the other give.
 */

const READS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["aq_project_status", {}],
  ["aq_timeline_read", {}],
  ["aq_object_read", { ids: ["clip_title", "clip_interview", "title"] }],
  ["aq_search", { query: "logo" }],
  ["aq_file_read", { path: "scenes/title/index.html" }],
  ["aq_guide", { topic: "ops/clip.move" }],
  ["aq_check_run", { limit: 5 }],
  ["aq_selection_read", {}],
];

/** A result without the epoch of the revision, which is new for every store. */
const plain = (text: string) => text.replaceAll(/\b[a-z0-9]{4}:(\d+)\b/g, "<epoch>:$1");

/** What a caller keeps, without epochs. */
const kept = (tools: ReturnType<typeof toolsOn>) => plain(JSON.stringify(tools.caller.toJSON()));

function userRenames(tools: ReturnType<typeof toolsOn>, clip: string, name: string): void {
  const store = tools.host.store() as ProjectStore;
  const done = store.execute(
    { type: "clip.update", params: { timeline: "main", clip, changes: { name } } },
    { origin: USER },
  );
  expect(done.ok).toBe(true);
}

async function oneByOne(tools: ReturnType<typeof toolsOn>): Promise<readonly ToolResult[]> {
  const results: ToolResult[] = [];
  for (const [name, args] of READS) results.push(await tools.call(name, args));
  return results;
}

const together = (tools: ReturnType<typeof toolsOn>) =>
  Promise.all(READS.map(([name, args]) => tools.call(name, args)));

describe("reading tools called at the same time", () => {
  it("give what they give one after the other, and keep the same record of what was read", async () => {
    const first = toolsOn(testHost());
    const second = toolsOn(testHost());
    const sequential = await oneByOne(first);
    const parallel = await together(second);
    expect(parallel.map(({ text }) => plain(text))).toEqual(
      sequential.map(({ text }) => plain(text)),
    );
    expect(parallel.every(({ isError }) => !isError)).toBe(true);
    expect(kept(second)).toBe(kept(first));
  });

  it("leave the checks of a later change as they are: the user's change since still conflicts", async () => {
    const outcomes: string[][] = [];
    for (const read of [oneByOne, together]) {
      const tools = toolsOn(testHost());
      await read(tools);
      userRenames(tools, "clip_title", "Opening");
      tools.caller.beginAnswer();
      const conflict = await tools.call("aq_edit", {
        operations: [
          { op: "clip.update", timeline: "main", clip: "clip_title", changes: { name: "AI" } },
        ],
      });
      tools.caller.beginAnswer();
      const elsewhere = await tools.call("aq_edit", {
        operations: [
          { op: "clip.update", timeline: "main", clip: "clip_interview", changes: { name: "AI" } },
        ],
      });
      outcomes.push([plain(conflict.text), plain(elsewhere.text)]);
    }
    const [sequential, parallel] = outcomes;
    expect(sequential?.[0]).toMatch(/^error conflict/);
    expect(sequential?.[1]).toMatch(/^rev <epoch>:\d+\ndone:/);
    expect(parallel).toEqual(sequential);
  });

  it("tell what the user did before them, and the next call does not tell it again", async () => {
    const tools = toolsOn(testHost());
    await tools.call("aq_project_status");
    userRenames(tools, "clip_title", "Opening");
    const results = await together(tools);
    const told = results.filter(({ text }) =>
      text.includes("others: since your last call the user changed"),
    );
    // Calls that start together may each tell it: that is all they can know.
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(told[0]?.text).toContain('clip_title "Opening" (name)');
    const next = await tools.call("aq_project_status");
    expect(next.text).not.toContain("others:");
  });

  it("tell a change that lands while one of them waits in the next call, and do not lose it", async () => {
    const tools = toolsOn(testHost());
    await tools.call("aq_project_status");
    // The manual waits for its pages to load: the user changes a clip meanwhile.
    const waiting = tools.call("aq_guide", { topic: "ops/clip.move" });
    userRenames(tools, "clip_title", "Opening");
    expect((await waiting).isError).toBe(false);
    const next = await tools.call("aq_project_status");
    expect(next.text).toContain(
      'others: since your last call the user changed clip_title "Opening" (name)',
    );
  });
});
