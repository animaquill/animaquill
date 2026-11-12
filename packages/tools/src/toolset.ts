import { CallerState } from "./caller.ts";
import { DEFAULT_TEXTS, type TextTable } from "./texts/index.ts";
import { makeTool, type ToolDefinition } from "./tool.ts";
import { checkRun, propose } from "./tools/ask.ts";
import { edit } from "./tools/edit.ts";
import { fileEdit, fileWrite } from "./tools/files.ts";
import { guide } from "./tools/guide.ts";
import {
  fileRead,
  objectRead,
  projectStatus,
  search,
  selectionRead,
  timelineRead,
} from "./tools/read.ts";
import type { Tool, ToolHost } from "./types.ts";

/** Every tool, in the order of the list. */
// Each tool checks its own parameters, so the list need not know their types.
// oxlint-disable-next-line typescript/no-explicit-any
export const DEFINITIONS: readonly ToolDefinition<any>[] = [
  projectStatus,
  timelineRead,
  objectRead,
  search,
  fileRead,
  selectionRead,
  guide,
  edit,
  fileEdit,
  fileWrite,
  propose,
  checkRun,
];

/**
 * The version of the tools as a whole: their list, order, descriptions and parameters. Within a
 * version they are the same to the byte, so that services keep them in their caches; any change of
 * them is a new version (a test compares them with a snapshot).
 */
export const TOOLSET_VERSION = "2026.2";

/**
 * The tools that AI uses on a project, the same for the assistant in the browser, a command line
 * and the MCP of a platform: six that read, the manual, three that change, one that asks the user
 * and one that checks. The caller keeps what was read, over all messages of one conversation.
 * What the tools say comes from `texts`: the same table gives the same tools, to the byte.
 */
export function createToolset(
  host: ToolHost,
  caller: CallerState = new CallerState(),
  texts: TextTable = DEFAULT_TEXTS,
): readonly Tool[] {
  return DEFINITIONS.map((definition) => makeTool(definition, host, caller, texts));
}
