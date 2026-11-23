import { systemPromptOf } from "./texts/index.ts";
import { listHash } from "./bridge.ts";
import type { JsonSchema, Tool } from "./types.ts";

/**
 * What the tools are through MCP: the same list as in the browser, in the same order and to the
 * byte, with what MCP adds to it, and the instructions of a server. MCP takes no model pack: what
 * other AI tools see is what AnimaQuill writes (mcp.md 16).
 */

/** Where the tools change the project, which is the one sentence that differs between servers. */
export type McpPlace =
  /**
   * A server on this computer whose calls run in the AnimaQuill editor open in the browser, on the
   * project open there: `npx animaquill mcp` (docs/design/online-offline.md of AnimaQuill Cloud, 5).
   */
  "editor";

/**
 * The first paragraph, which has to make sense alone: Codex holds only to the first 512 characters,
 * and Claude Code decides from it, with the names of the tools, whether to look for them.
 */
const INTRO: Readonly<Record<McpPlace, string>> = {
  editor:
    "AnimaQuill is a video and animation editor. These aq_ tools read and change the project open in the AnimaQuill editor in the browser on this computer, and run there: a change shows in the editor at once and can be taken back there as a whole. aq_project_status gives the project as it is. Timelines, clips and keyframes change through aq_edit, not by writing their JSON files; aq_check_run lists what is wrong with the project.",
};

/** What the place has, after the rules. */
const HOST: Readonly<Record<McpPlace, string>> = {
  editor:
    "- The first result of a session names the project the calls work on, and whether it is offline (a folder on this computer) or online (on a server, without a folder). In an offline project the files of scene and sound code are in that folder, and your own file tools can change them; the editor takes in what changes there. An online project has no folder: its files change through aq_file_edit and aq_file_write.\n- aq_render_frames needs the editor in front: in a background tab the browser draws nothing.",
};

/** The instructions of a server, as MCP gives them to the client. */
export function mcpInstructions(place: McpPlace): string {
  return `${INTRO[place]}\n\n${systemPromptOf({ entry: "mcp" })}\n${HOST[place]}`;
}

/** A tool as `tools/list` gives it. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: Tool["annotations"];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * The tool that Claude Code loads at once even where it searches for the rest: where a task starts.
 * See https://code.claude.com/docs/en/mcp (tool search).
 */
const ALWAYS_LOAD = "aq_project_status";

/** The list of `tools/list`, from the toolset: the same tools, the same order, the same words. */
export const mcpToolsOf = (tools: readonly Tool[]): readonly McpTool[] =>
  tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
    ...(name === ALWAYS_LOAD && { _meta: { "anthropic/alwaysLoad": true } }),
  }));

/**
 * What tells whether two places list the same tools: the hash of the list of `tools/list`, as
 * `animaquill mcp` and the editor compare them (`listHash`).
 */
export function mcpListHash(tools: readonly Tool[]): string {
  return listHash(mcpToolsOf(tools));
}
