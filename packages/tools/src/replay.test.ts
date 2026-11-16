import { readFileSync, readdirSync } from "node:fs";
import { ProjectStore, USER, type CommandCall } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { ADVICE, COMMAND, testHost, toolsOn } from "./test-support.ts";
import { PLAN_FIRST } from "./tool.ts";
import { WRITE_TOOLS } from "./toolset.ts";
import type { ToolResult } from "./types.ts";

/**
 * Calls of tools as a model would make them, played back without one: each file of replay/ is a
 * scenario on the sample project, with what each call has to give and what the project is in the
 * end. Records of real models can become scenarios like these, to keep what they found fixed.
 */

interface Expect {
  readonly ok?: true;
  /** The code of the error, as its first line says. */
  readonly error?: string;
  readonly lines?: readonly string[];
  readonly absent?: readonly string[];
  readonly terminate?: true;
  /** The same text as the call before. */
  readonly same?: true;
}

type Step =
  | {
      readonly tool: string;
      readonly args?: unknown;
      /** Part of the same answer of the model as the call before. */
      readonly sameAnswer?: true;
      readonly expect: Expect;
    }
  /** The user changes the project meanwhile, at the editor. */
  | { readonly user: readonly CommandCall[] }
  /** The user changes the project in another window. */
  | { readonly window: readonly CommandCall[] }
  /** The user takes back all an AI task did. */
  | { readonly undoTask: string }
  /** A new message of the user: a new answer, in the same conversation, as another task if said. */
  | { readonly message: true; readonly task?: string }
  /** The project opens again, as after a reload; with `newCaller`, nothing of the caller is kept. */
  | { readonly reopen: true; readonly newCaller?: true };

interface Scenario {
  readonly about: string;
  readonly steps: readonly Step[];
  readonly end?: {
    readonly files?: Readonly<Record<string, readonly string[]>>;
    readonly absent?: Readonly<Record<string, readonly string[]>>;
    readonly count?: Readonly<Record<string, Readonly<Record<string, number>>>>;
    /** That one undo of the task takes back all it did. */
    readonly undoAll?: true;
  };
}

const folder = new URL("../replay/", import.meta.url);
const scenarios = readdirSync(folder)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
  .map(
    (name) => [name, JSON.parse(readFileSync(new URL(name, folder), "utf8")) as Scenario] as const,
  );

const codeOf = (result: ToolResult) => /^error ([a-z-]+)/.exec(result.text)?.[1];

describe("replayed calls", () => {
  it("are 14 scenarios at least", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(14);
  });

  /** What every call of every scenario gave back, for the check of words below. */
  const said: string[] = [];

  /**
   * Plays a scenario back. Where people want to be asked before a change (S-D4) and allow each one,
   * every call gives what it gives without asking, and the project ends the same.
   */
  const play = async (scenario: Scenario, allowing = false) => {
    const host = testHost();
    if (allowing) host.approve = async () => "once";
    let tools = toolsOn(host);
    let last: ToolResult | undefined;
    for (const [index, step] of scenario.steps.entries()) {
      const store = host.store() as ProjectStore;
      if ("user" in step) {
        // As one step, as the user's tools may: many commands one by one would be slow to test.
        const done = store.executeBatch(step.user, { origin: USER });
        expect(done.ok, `step ${index}: ${JSON.stringify(done)}`).toBe(true);
        continue;
      }
      if ("window" in step) {
        const other = ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;
        for (const command of step.window) {
          const done = other.execute(command, { origin: USER });
          expect(done.ok, `step ${index}: ${JSON.stringify(done)}`).toBe(true);
        }
        store.applyUpdates([other.encodeState()]);
        continue;
      }
      if ("undoTask" in step) {
        expect(store.undoTask(step.undoTask).ok, `step ${index}`).toBe(true);
        continue;
      }
      if ("message" in step) {
        if (step.task !== undefined) host.task = step.task;
        tools.caller.beginAnswer();
        continue;
      }
      if ("reopen" in step) {
        host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
        if (step.newCaller) tools = toolsOn(host);
        continue;
      }
      if (!step.sameAnswer) tools.caller.beginAnswer();
      const before = store.revisionId;
      const result = await tools.call(step.tool, step.args ?? {});
      // A tool that changed the project is one that says so: "plan first" keeps it out by that.
      if (store.revisionId !== before) expect(WRITE_TOOLS, `step ${index}`).toContain(step.tool);
      said.push(`${step.tool}: ${result.text}`);
      const where = `step ${index} (${step.tool}):\n${result.text}`;
      const { expect: wanted } = step;
      if (wanted.ok) expect(result.isError, where).toBe(false);
      if (wanted.error) expect(codeOf(result), where).toBe(wanted.error);
      for (const line of wanted.lines ?? []) expect(result.text, where).toContain(line);
      for (const line of wanted.absent ?? []) expect(result.text, where).not.toContain(line);
      if (wanted.terminate) expect(result.terminate, where).toBe(true);
      if (wanted.same) expect(result.text, where).toBe(last?.text);
      last = result;
    }
    const store = host.store() as ProjectStore;
    const { files, problems } = store.exportFiles();
    expect(problems).toEqual([]);
    const { end } = scenario;
    for (const [path, lines] of Object.entries(end?.files ?? {})) {
      for (const line of lines) expect(files.get(path), path).toContain(line);
    }
    for (const [path, lines] of Object.entries(end?.absent ?? {})) {
      for (const line of lines) expect(files.get(path) ?? "", path).not.toContain(line);
    }
    for (const [path, counts] of Object.entries(end?.count ?? {})) {
      for (const [text, count] of Object.entries(counts)) {
        expect((files.get(path) ?? "").split(text).length - 1, `${path} ${text}`).toBe(count);
      }
    }
    if (end?.undoAll) {
      const origin = host.origin();
      expect(store.canUndoOrigin(origin)).toBe(true);
      expect(store.undoOrigin(origin).ok).toBe(true);
      expect(store.canUndoOrigin(origin)).toBe(false);
    }
  };

  it.each(scenarios)("%s", async (_, scenario) => play(scenario));

  it.each(scenarios)("%s, people asked and allowing each change", async (_, scenario) =>
    play(scenario, true),
  );

  // People are asked and allow nothing: the same calls, and none of them changes the project.
  it.each(scenarios)("%s, people asked and allowing nothing", async (_, scenario) => {
    const host = testHost();
    host.approve = async () => "no";
    let tools = toolsOn(host);
    for (const [index, step] of scenario.steps.entries()) {
      const store = host.store() as ProjectStore;
      if ("user" in step) {
        store.executeBatch(step.user, { origin: USER });
        continue;
      }
      if ("window" in step || "undoTask" in step) continue;
      if ("message" in step) {
        if (step.task !== undefined) host.task = step.task;
        tools.caller.beginAnswer();
        continue;
      }
      if ("reopen" in step) {
        host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
        if (step.newCaller) tools = toolsOn(host);
        continue;
      }
      if (!step.sameAnswer) tools.caller.beginAnswer();
      const before = store.revisionId;
      const result = await tools.call(step.tool, step.args ?? {});
      said.push(`${step.tool}: ${result.text}`);
      expect(store.revisionId, `step ${index} (${step.tool})`).toBe(before);
      // A dry run, and a change that changes nothing, are no change to ask about.
      if (WRITE_TOOLS.has(step.tool) && !result.isError) {
        expect(result.text, `step ${index}`).toMatch(/dry run|which changed nothing/);
      }
    }
    expect((host.store() as ProjectStore).canUndoOrigin(host.origin())).toBe(false);
  });

  // People asked for a plan first: the same calls, and none of them changes the project.
  it.each(scenarios)("%s, with a plan first", async (_, scenario) => {
    const host = testHost();
    host.plan = true;
    let tools = toolsOn(host);
    for (const [index, step] of scenario.steps.entries()) {
      const store = host.store() as ProjectStore;
      if ("user" in step) {
        store.executeBatch(step.user, { origin: USER });
        continue;
      }
      if ("window" in step || "undoTask" in step) continue;
      if ("message" in step) {
        if (step.task !== undefined) host.task = step.task;
        tools.caller.beginAnswer();
        continue;
      }
      if ("reopen" in step) {
        host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
        if (step.newCaller) tools = toolsOn(host);
        continue;
      }
      if (!step.sameAnswer) tools.caller.beginAnswer();
      const before = store.revisionId;
      const result = await tools.call(step.tool, step.args ?? {});
      expect(store.revisionId, `step ${index} (${step.tool})`).toBe(before);
      if (WRITE_TOOLS.has(step.tool)) expect(result.text, `step ${index}`).toBe(PLAN_FIRST);
      else expect(codeOf(result), `step ${index}`).not.toBe("plan-first");
    }
    expect((host.store() as ProjectStore).canUndoOrigin(host.origin())).toBe(false);
  });

  it("gave back only what is so: no advice, no commands", () => {
    expect(said.length).toBeGreaterThan(50);
    const found = said.flatMap((text) => {
      // What the project itself holds is quoted, and is the project's to say.
      const ours = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      return [...ADVICE, COMMAND].flatMap((rule) => (rule.test(ours) ? [`${rule}: ${text}`] : []));
    });
    expect(found).toEqual([]);
  });
});
