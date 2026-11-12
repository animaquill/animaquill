import {
  DEFAULT_TEXTS_USED,
  TOOLSET_VERSION,
  systemPromptOf,
  type TextTable,
  type Tool,
} from "@animaquill/tools";
import type { AnswerStamp, ToolSpec } from "./pi.ts";

/**
 * The tools of `@animaquill/tools` as the agent runs them: their own check of a call comes before
 * pi's, and what they found for people goes with their result.
 */
export function toolSpecsOf(tools: readonly Tool[]): readonly ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.title,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
    validate: (args) => tool.validate(args)?.text,
    run: async (args) => {
      const result = await tool.run(args);
      return result.data === undefined ? result : { ...result, data: keptData(result.data) };
    },
  }));
}

/** How much of what a tool found goes into a conversation, as JSON. */
export const MAX_DATA = 4096;

/**
 * What a tool found, to keep with its result: as it is, or past `MAX_DATA` only which objects it
 * changed, without how.
 */
export function keptData(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (JSON.stringify(data).length <= MAX_DATA) return data;
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const objects = changes.map((change: Record<string, unknown>) => {
    const { fields: _fields, lines: _lines, ...object } = change;
    return object;
  });
  const kept = { ...data, changes: objects };
  return JSON.stringify(kept).length <= MAX_DATA
    ? kept
    : { ...data, changes: objects.slice(0, 40) };
}

/** The system prompt of the assistant in the browser, from a table of texts. */
export const browserSystemPrompt = (texts?: TextTable): string =>
  systemPromptOf({ entry: "browser", ...(texts && { texts }) });

/** What answers with the default words of the tools are recorded as made with. */
export const DEFAULT_STAMP: AnswerStamp = { toolset: TOOLSET_VERSION, texts: DEFAULT_TEXTS_USED };
