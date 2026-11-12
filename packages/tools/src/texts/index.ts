import { EDIT_TEXTS } from "./edit.ts";
import { OPERATION_TEXTS } from "./operations.ts";
import { PARAM_TEXTS } from "./params.ts";
import { TYPE_TEXTS } from "./shared.ts";
import { SYSTEM_PARTS, SYSTEM_TEXTS } from "./system.ts";
import { textIn, type TextTable } from "./table.ts";
import { TOOL_TEXTS } from "./tools.ts";

export * from "./table.ts";
export { SYSTEM_PARTS };

/** The words of the tools as AnimaQuill writes them, for every model: the default model pack. */
export const DEFAULT_TEXTS: TextTable = {
  ...SYSTEM_TEXTS,
  ...TOOL_TEXTS,
  ...EDIT_TEXTS,
  ...OPERATION_TEXTS,
  ...PARAM_TEXTS,
  ...TYPE_TEXTS,
};

/** Where AI works: the browser has all seven parts, the instructions of MCP four of them. */
export type Entry = "browser" | "mcp";

const PARTS_OF: Readonly<Record<Entry, readonly (typeof SYSTEM_PARTS)[number][]>> = {
  browser: SYSTEM_PARTS,
  mcp: ["project", "work", "rules", "guard"],
};

const isListItem = (line: string | undefined) => line?.startsWith("- ") === true;

/**
 * The system prompt of a place AI works in, from its parts in the table: paragraphs apart, except
 * that a part that goes on with the list the one before ends in stays in that list.
 */
export function systemPromptOf(options: {
  readonly entry: Entry;
  readonly texts?: TextTable;
}): string {
  const texts = options.texts ?? DEFAULT_TEXTS;
  let prompt = "";
  for (const part of PARTS_OF[options.entry]) {
    const text = textIn(texts, `system.${part}`)?.trim() ?? "";
    if (text === "") continue;
    if (prompt === "") prompt = text;
    else {
      const goesOn = isListItem(prompt.split("\n").at(-1)) && isListItem(text.split("\n")[0]);
      prompt += `${goesOn ? "\n" : "\n\n"}${text}`;
    }
  }
  return prompt;
}

/**
 * Which words a conversation used, to tell later which they were: the default table, at this
 * version of the tools, and a hash of its content. A model pack will have its own.
 */
export interface TextsUsed {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
}

/** A short hash of a table of texts, the same for the same content. */
export function hashOfTexts(texts: TextTable): string {
  const text = JSON.stringify(Object.entries(texts).toSorted(([a], [b]) => (a < b ? -1 : 1)));
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
}
