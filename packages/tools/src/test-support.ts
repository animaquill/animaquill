import {
  ProblemSet,
  ProjectStore,
  aiTask,
  type ClipState,
  type ClipDescription,
} from "@animaquill/core";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { CallerState } from "./caller.ts";
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
  selected: SelectionFacts | undefined;
  open(store: ProjectStore | undefined): void;
}

export function testHost(store: ProjectStore | undefined = openSample(), task = "t1"): TestHost {
  let open: ProjectStore | undefined = store;
  const problems = new ProblemSet();
  const host: TestHost = {
    selected: undefined,
    store: () => open,
    origin: () => aiTask(task),
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
export function toolsOn(host: ToolHost = testHost(), caller = new CallerState()) {
  const tools = new Map<string, Tool>(createToolset(host, caller).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args);
  };
  return { tools, call, caller, host };
}
