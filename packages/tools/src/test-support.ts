import {
  ProblemSet,
  ProjectStore,
  aiTask,
  type ClipState,
  type ClipDescription,
} from "@animaquill/core";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { CallerState } from "./caller.ts";
import { DEFAULT_TEXTS, type TextTable } from "./texts/index.ts";
import { createToolset } from "./toolset.ts";
import type { SelectionFacts, Tool, ToolHost, ToolResult } from "./types.ts";

/** The sample project, without the tag that locks it, so that it can be changed. */
export function openSample(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("the sample did not open");
  return store;
}

/** A host as a command line would be, around one project. */
export interface TestHost extends ToolHost {
  /** The task the changes are made as: in the browser, each message is one. */
  task: string;
  selected: SelectionFacts | undefined;
  open(store: ProjectStore | undefined): void;
}

export function testHost(store: ProjectStore | undefined = openSample(), task = "t1"): TestHost {
  let open: ProjectStore | undefined = store;
  const problems = new ProblemSet();
  const host: TestHost = {
    task,
    selected: undefined,
    store: () => open,
    origin: () => aiTask(host.task),
    selection: () => host.selected,
    describe: (_clip: ClipState): ClipDescription | undefined => undefined,
    problems: () => {
      problems.update(open?.getState());
      return problems;
    },
    open: (next) => {
      open = next;
    },
  };
  return host;
}

/** The tools on a host, by name, with a way to call them. */
export function toolsOn(
  host: ToolHost = testHost(),
  caller = new CallerState(),
  texts: TextTable = DEFAULT_TEXTS,
) {
  const tools = new Map<string, Tool>(
    createToolset(host, caller, texts).map((tool) => [tool.name, tool]),
  );
  const call = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args);
  };
  return { tools, call, caller, host };
}

/**
 * Phrases that tell a model to call a tool, when, or never to do something: triggers, defaults and
 * absolutes. Anthropic names these as what makes newer models call tools too often (see the audit
 * of tool descriptions, 2026-11-12). Facts with consequences take their place.
 */
export const DIRECTIVE_PHRASES: readonly RegExp[] = [
  /\bcall (it|this)\b/i,
  /\buse (it|this tool) (to|when|for)\b/i,
  /\brun it\b/i,
  /\bat the start of\b/i,
  /\bbefore you\b/i,
  /\bwhen the user says\b/i,
  /\binstead of guessing\b/i,
  /\bif in doubt\b/i,
  /\bwhenever\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bDo not\b/,
  /\bDon't\b/,
  /\byou must\b/i,
  /\bmake sure\b/i,
  /\bread (it|the file) again\b/i,
];

/**
 * What tells AI what to do next, rather than what happened: results and errors say what is so,
 * with the form a call needs, and leave what to do to the model and what the user asked for.
 */
export const ADVICE: readonly RegExp[] = [
  /\bfix (the|it|them|this)\b/i,
  /\byou should\b/i,
  /\bconsider\b/i,
  /\btry again\b/i,
  /\btell the user\b/i,
  /\bask the user\b/i,
  /\bthen decide\b/i,
  /\bread (it|them|the file) again\b/i,
  /\bplease\b/i,
];

/**
 * A sentence that starts with a verb in its plain form, as a command does: "Send them in several
 * batches.", "Pass timeline.". Results, errors and descriptions say what is so.
 */
export const COMMAND =
  /(?:^|[.!?;]\s+|\n\s*)(?:Send|Give|Pass|Use|Read|Choose|Set|Leave|Call|Run|Try|Ask|Tell|Change|Add|Remove|Fix|Make|Check|Write|Copy|Put|Move|Keep|Avoid|Consider|Ensure|Do|Don't|Note|See|Look|Go|Wait|Retry|Stop)\b(?! \w+ing\b)/;
