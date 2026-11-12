import { aiTask, ProblemSet } from "@animaquill/core";
import { CallerState } from "../caller.ts";
import { SYSTEM_PARTS, systemPromptOf } from "../texts/index.ts";
import { textIn } from "../texts/table.ts";
import { createToolset } from "../toolset.ts";
import type { JsonSchema, ToolHost } from "../types.ts";
import { usePack } from "./apply.ts";
import { textsChanges, useChanges, type CallChange, type WordsChange } from "./changes.ts";
import type { Detail } from "./detail.ts";
import type { CallSettings, ModelPack } from "./format.ts";

/** What a model gets with a pack, all of it: for people to read, as it goes out. */
export interface PackPreview {
  /** The system prompt as it goes out. */
  readonly system: string;
  /** The same, part by part, in their order; a part a pack took out is "". */
  readonly parts: readonly { readonly part: string; readonly text: string }[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
  }[];
  readonly call: CallSettings;
  readonly results: Detail;
}

/** A host for tools that only describe themselves: nothing runs. */
const NO_HOST: ToolHost = {
  store: () => undefined,
  origin: () => aiTask("preview"),
  problems: () => new ProblemSet(),
};

/**
 * The system prompt of the browser and the list of tools a model gets with a pack, to the byte as
 * the assistant sends them, with how it is called.
 */
export function previewOf(pack: ModelPack, model: string): PackPreview {
  const use = usePack(pack, model);
  const tools = createToolset(NO_HOST, new CallerState(), use.texts, { results: use.results });
  return {
    system: systemPromptOf({ entry: "browser", texts: use.texts }),
    parts: SYSTEM_PARTS.map((part) => ({
      part,
      text: textIn(use.texts, `system.${part}`)?.trim() ?? "",
    })),
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: use.call,
    results: use.results,
  };
}

/**
 * One piece of what a model gets: a part of the system prompt ("system.work"), the description of
 * a tool ("tools.aq_edit"), or its parameters with what they say ("tools.aq_edit.params").
 */
export interface PackSegment {
  readonly key: string;
  readonly text: string;
}

/** What a model gets with a pack, piece by piece, in the order it goes out. */
export function segmentsOf(preview: PackPreview): readonly PackSegment[] {
  return [
    ...preview.parts.map(({ part, text }) => ({ key: `system.${part}`, text })),
    ...preview.tools.flatMap(({ name, description, inputSchema }) => [
      { key: `tools.${name}`, text: description },
      { key: `tools.${name}.params`, text: JSON.stringify(inputSchema, null, 2) },
    ]),
  ];
}

/** How a piece reads with one pack against the other: "" on one side is not there. */
export interface ComparedSegment {
  readonly key: string;
  readonly left: string;
  readonly right: string;
  readonly state: "same" | "changed" | "onlyLeft" | "onlyRight";
}

/** Two packs for one model, side by side. */
export interface PacksCompared {
  readonly left: PackPreview;
  readonly right: PackPreview;
  /** Every piece of what the model gets, in order, and whether it differs. */
  readonly segments: readonly ComparedSegment[];
  /** The words that differ, by key, as the install dialog shows them (left before, right after). */
  readonly words: readonly WordsChange[];
  /** The settings and how much results give, where they differ. */
  readonly call: readonly CallChange[];
}

/**
 * What a model gets with one pack against another, merged with the default words and the variant
 * for the model: piece by piece, by key of the words (the same comparison as an update's), and how
 * it is called.
 */
export function comparePacks(left: ModelPack, right: ModelPack, model: string): PacksCompared {
  const one = previewOf(left, model);
  const other = previewOf(right, model);
  const theirs = new Map(segmentsOf(other).map((segment) => [segment.key, segment.text]));
  const segments = segmentsOf(one).map(({ key, text }): ComparedSegment => {
    const then = theirs.get(key) ?? "";
    theirs.delete(key);
    const state =
      text === then ? "same" : text === "" ? "onlyRight" : then === "" ? "onlyLeft" : "changed";
    return { key, left: text, right: then, state };
  });
  for (const [key, text] of theirs) {
    segments.push({ key, left: "", right: text, state: text === "" ? "same" : "onlyRight" });
  }
  const was = usePack(left, model);
  const is = usePack(right, model);
  const keys = [left, right].flatMap((pack) => [
    ...pack.edits.map(({ key }) => key),
    ...(pack.variants.some(({ extra }) => extra) ? ["system.extra"] : []),
  ]);
  return {
    left: one,
    right: other,
    segments,
    words: textsChanges(was.texts, is.texts, keys, right.edits),
    call: useChanges(was, is),
  };
}
