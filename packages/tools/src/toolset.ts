import { CallerState } from "./caller.ts";
import { DEFAULT_TEXTS, hashOfTexts, type TextTable, type TextsUsed } from "./texts/index.ts";
import { DETAIL_LIMITS, filledTexts, type Detail } from "./packs/detail.ts";
import { makeTool, paramMaxima, type ToolDefinition } from "./tool.ts";
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
export const TOOLSET_VERSION = "2026.4";

/** The words of the tools as AnimaQuill writes them: what a conversation records it used. */
export const DEFAULT_TEXTS_USED: TextsUsed = {
  id: "animaquill/default",
  version: TOOLSET_VERSION,
  hash: hashOfTexts(DEFAULT_TEXTS),
};

/** The tools that change the project, for whoever shows what a turn did. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  DEFINITIONS.filter(({ writes }) => writes === true).map(({ name }) => name),
);

let maxima: ReadonlyMap<string, number> | undefined;

/** The most a parameter of a tool takes, by the key of its words, for `{max}`. */
export function maximumOf(key: string): number | undefined {
  maxima ??= new Map(
    DEFINITIONS.flatMap(({ name, params }) =>
      [...paramMaxima(params)].map(
        ([path, most]) => [`tools.${name}.params.${path}`, most] as const,
      ),
    ),
  );
  return maxima.get(key);
}

/** Tables with their placeholders put in, by step of detail: the same table gives the same tools. */
const filled = new WeakMap<TextTable, Map<Detail, TextTable>>();

/** A table of texts as the tools say it at a step of detail, see `filledTexts`. */
export function textsAt(texts: TextTable, detail: Detail = "standard"): TextTable {
  const known = filled.get(texts) ?? new Map<Detail, TextTable>();
  filled.set(texts, known);
  const found = known.get(detail);
  if (found) return found;
  const made = filledTexts(texts, DETAIL_LIMITS[detail], maximumOf);
  known.set(detail, made);
  return made;
}

export interface ToolsetOptions {
  /** How much results give, see `DETAILS`: what the model pack says, standard by default. */
  readonly results?: Detail;
}

/**
 * The tools that AI uses on a project, the same for the assistant in the browser, a command line
 * and the MCP of a platform: six that read, the manual, three that change, one that asks the user
 * and one that checks. The caller keeps what was read, over all messages of one conversation.
 * What the tools say comes from `texts`, with how much results give: the same table at the same
 * step of detail gives the same tools, to the byte.
 */
export function createToolset(
  host: ToolHost,
  caller: CallerState = new CallerState(),
  texts: TextTable = DEFAULT_TEXTS,
  options: ToolsetOptions = {},
): readonly Tool[] {
  const detail = options.results ?? "standard";
  const words = textsAt(texts, detail);
  const limits = DETAIL_LIMITS[detail];
  return DEFINITIONS.map((definition) => makeTool(definition, host, caller, words, limits));
}
