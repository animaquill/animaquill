import { CallerState } from "./caller.ts";
import { makeTool } from "./tool.ts";
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

/**
 * The version of the tools as a whole: their list, order, descriptions and parameters. Within a
 * version they are the same to the byte, so that services keep them in their caches; any change of
 * them is a new version (a test compares them with a snapshot).
 */
export const TOOLSET_VERSION = "2026.1";

/**
 * The tools that AI uses on a project, the same for the assistant in the browser, a command line
 * and the MCP of a platform: six that read, the manual, three that change, one that asks the user
 * and one that checks. The caller keeps what was read, over all messages of one conversation.
 */
export function createToolset(
  host: ToolHost,
  caller: CallerState = new CallerState(),
): readonly Tool[] {
  return [
    makeTool(projectStatus, host, caller),
    makeTool(timelineRead, host, caller),
    makeTool(objectRead, host, caller),
    makeTool(search, host, caller),
    makeTool(fileRead, host, caller),
    makeTool(selectionRead, host, caller),
    makeTool(guide, host, caller),
    makeTool(edit, host, caller),
    makeTool(fileEdit, host, caller),
    makeTool(fileWrite, host, caller),
    makeTool(propose, host, caller),
    makeTool(checkRun, host, caller),
  ];
}
