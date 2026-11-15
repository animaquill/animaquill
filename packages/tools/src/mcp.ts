import { systemPromptOf } from "./texts/index.ts";
import type { JsonSchema, Tool } from "./types.ts";

/**
 * What the tools are through MCP: the same list as in the browser, in the same order and to the
 * byte, with what MCP adds to it, and the instructions of a server. MCP takes no model pack: what
 * other AI tools see is what AnimaQuill writes (mcp.md 16).
 */

/** Where the tools change the project, which is the one sentence that differs between servers. */
export type McpPlace =
  /** A server on this computer, on a project folder: `npx animaquill mcp`. */
  "folder";

/**
 * The first paragraph, which has to make sense alone: Codex holds only to the first 512 characters,
 * and Claude Code decides from it, with the names of the tools, whether to look for them.
 */
const INTRO: Readonly<Record<McpPlace, string>> = {
  folder:
    "AnimaQuill is a video and animation editor whose projects are folders. These aq_ tools read and change the AnimaQuill project in a folder on this computer, and what they change is written to its files; an AnimaQuill editor open on the same folder takes it in. aq_project_status gives the project as it is. Timelines, clips and keyframes change through aq_edit, not by writing their JSON files; aq_check_run lists what is wrong with the project.",
};

/** What the place has, after the rules: no picture, no sound, no editor. */
const HOST: Readonly<Record<McpPlace, string>> = {
  folder:
    "- These tools cannot render frames or play sound: seeing the picture and hearing it takes the AnimaQuill editor. Judge what no picture shows by names, lengths and what the user tells you, and say so when it matters.\n- What the editor selects is the editor's: aq_selection_read here has no editor to read it from.",
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
