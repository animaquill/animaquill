import { readFileSync, readdirSync } from "node:fs";
import { ProjectStore, USER, type CommandCall } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { testHost, toolsOn } from "./test-support.ts";
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

  it.each(scenarios)("%s", async (_, scenario) => {
    const host = testHost();
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
      const result = await tools.call(step.tool, step.args ?? {});
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
  });
});
