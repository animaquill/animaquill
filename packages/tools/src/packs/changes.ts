import { DEFAULT_TEXTS, type TextTable, type TextValue } from "../texts/index.ts";
import { textsAt } from "../toolset.ts";
import { textsOf } from "./apply.ts";
import type { CallSettings, ModelPack, PackEdit, PackVariant } from "./format.ts";
import { hintsIn, type HintRule } from "./hints.ts";

/**
 * What a pack changes, for people to see before they install it or take an update of it: its
 * words next to the ones they replace, and how it calls models.
 */

/** Where words are, for people: the system prompt, tools, parameters, operations, examples. */
export type WordsGroup = "system" | "tools" | "params" | "ops" | "examples";

export interface WordsChange {
  readonly key: string;
  readonly group: WordsGroup;
  /** The words are replaced, go on, or go: for an update, how the new version has them. */
  readonly how: PackEdit["how"];
  /** Only for these models: words of a variant. */
  readonly models?: readonly string[];
  /** As the model reads them now: the default words, or those of the version installed. */
  readonly before: string;
  /** As the pack has them; where they go on after the others, only what goes on. */
  readonly after: string;
  /** The guard of the system prompt, or what the place AI works in says of itself. */
  readonly sensitive: boolean;
  readonly hints: readonly HintRule[];
}

export const groupOf = (key: string): WordsGroup =>
  key.startsWith("system.")
    ? "system"
    : key.endsWith(".examples")
      ? "examples"
      : /^tools\.[^.]+\.description$/.test(key)
        ? "tools"
        : /^ops\.[^.]+\.[^.]+\.(summary|description)$/.test(key)
          ? "ops"
          : "params";

export const isSensitive = (key: string): boolean =>
  key === "system.guard" || key === "system.host";

const shown = (value: TextValue | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Words as the model reads them, with what stands for numbers put in, see `filledTexts`. */
const read = (texts: TextTable, key: string): string => shown(textsAt(texts)[key]);

function editChange(edit: PackEdit, models?: readonly string[]): WordsChange {
  const before = read(DEFAULT_TEXTS, edit.key);
  const after =
    edit.how === "remove"
      ? ""
      : edit.how === "set"
        ? read({ ...DEFAULT_TEXTS, [edit.key]: edit.value }, edit.key)
        : shown(edit.value);
  return {
    key: edit.key,
    group: groupOf(edit.key),
    how: edit.how,
    ...(models && { models }),
    before,
    after,
    sensitive: isSensitive(edit.key),
    hints: hintsIn(after),
  };
}

const extrasOf = (pack: ModelPack): readonly PackVariant[] =>
  pack.variants.filter(({ extra }) => extra !== undefined);

/**
 * What a pack changes in the words: against the default ones, or for an update against the version
 * installed. Changes of the guard and of what the place says of itself come first.
 */
export function wordsChanges(pack: ModelPack, installed?: ModelPack): readonly WordsChange[] {
  const changes: WordsChange[] = [];
  if (!installed) {
    for (const edit of pack.edits) changes.push(editChange(edit));
    for (const variant of extrasOf(pack)) {
      if (variant.extra) changes.push(editChange(variant.extra, variant.models));
    }
  } else {
    const keys = [...installed.edits, ...pack.edits].map(({ key }) => key);
    changes.push(...textsChanges(textsOf(installed), textsOf(pack), keys, pack.edits));
    const before = extrasOf(installed);
    const after = extrasOf(pack);
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      const old = before[index];
      const now = after[index];
      const oldText = old ? read(textsOf(installed, old), "system.extra") : "";
      const newText = now ? read(textsOf(pack, now), "system.extra") : "";
      if (oldText === newText && old?.models.join() === now?.models.join()) continue;
      changes.push({
        key: "system.extra",
        group: "system",
        how: now?.extra?.how ?? "remove",
        models: (now ?? old)?.models ?? [],
        before: oldText,
        after: newText,
        sensitive: false,
        hints: hintsIn(newText),
      });
    }
  }
  return changes.toSorted((a, b) => Number(b.sensitive) - Number(a.sensitive));
}

/**
 * Where two tables of words differ, by key, of the keys given: as the model reads them, with how
 * the second has them where `edits` say. For an update, and to compare two packs for a model.
 */
export function textsChanges(
  was: TextTable,
  is: TextTable,
  keys: Iterable<string>,
  edits: readonly PackEdit[] = [],
): readonly WordsChange[] {
  const changes: WordsChange[] = [];
  for (const key of new Set(keys)) {
    const before = read(was, key);
    const after = read(is, key);
    if (before === after) continue;
    const edit = edits.find((each) => each.key === key);
    changes.push({
      key,
      group: groupOf(key),
      how: edit?.how ?? (after === "" ? "remove" : "set"),
      before,
      after,
      sensitive: isSensitive(key),
      hints: hintsIn(after),
    });
  }
  return changes.toSorted((a, b) => Number(b.sensitive) - Number(a.sensitive));
}

type Setting = string | number | boolean;

export interface CallChange {
  /** A field of the call settings, such as "reasoning" or "anthropic.thinkingDisplay", or "results". */
  readonly field: string;
  /** Only for these models: a variant. */
  readonly models?: readonly string[];
  /** Nothing: what the editor does by default. */
  readonly before?: Setting;
  readonly after?: Setting;
  /** It makes answers cost clearly more: reasoning of xhigh or max, or very long answers. */
  readonly costly: boolean;
}

function settingsOf(call: CallSettings, results: string | undefined): Map<string, Setting> {
  const found = new Map<string, Setting>();
  for (const [field, value] of Object.entries(call)) {
    if (value === undefined) continue;
    if (field === "anthropic" && typeof value === "object") {
      for (const [inner, setting] of Object.entries(value as Record<string, Setting | undefined>)) {
        if (setting !== undefined) found.set(`anthropic.${inner}`, setting);
      }
    } else found.set(field, value as Setting);
  }
  if (results !== undefined) found.set("results", results);
  return found;
}

const costly = (field: string, value: Setting | undefined): boolean =>
  (field === "reasoning" && (value === "xhigh" || value === "max")) ||
  // A cache that lasts long costs more to write, on Anthropic's services.
  (field === "cache" && value === "long") ||
  (field === "maxOutputTokens" && typeof value === "number" && value > 64_000);

/** Each set of settings of a pack: its own, then each variant's by its models. */
function allSettings(pack: ModelPack | undefined): Map<string, Map<string, Setting>> {
  const all = new Map<string, Map<string, Setting>>();
  if (!pack) return all;
  all.set("", settingsOf(pack.call, pack.results));
  for (const variant of pack.variants) {
    all.set(variant.models.join(" "), settingsOf(variant.call, variant.results));
  }
  return all;
}

/** Where two sets of settings differ, field by field. */
function settingsChanges(
  before: ReadonlyMap<string, Setting>,
  after: ReadonlyMap<string, Setting>,
  models?: readonly string[],
): CallChange[] {
  const changes: CallChange[] = [];
  for (const field of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(field);
    const now = after.get(field);
    if (old === now) continue;
    changes.push({
      field,
      ...(models && { models }),
      ...(old !== undefined && { before: old }),
      ...(now !== undefined && { after: now }),
      costly: costly(field, now),
    });
  }
  return changes;
}

/** How a pack calls models, against the editor's defaults or the version installed. */
export function callChanges(pack: ModelPack, installed?: ModelPack): readonly CallChange[] {
  const was = allSettings(installed);
  const is = allSettings(pack);
  const changes: CallChange[] = [];
  for (const models of new Set([...is.keys(), ...was.keys()])) {
    changes.push(
      ...settingsChanges(
        was.get(models) ?? new Map<string, Setting>(),
        is.get(models) ?? new Map<string, Setting>(),
        models === "" ? undefined : models.split(" "),
      ),
    );
  }
  return changes;
}

/**
 * How two ways of calling one model differ, as each pack has it merged for the model (see
 * `usePack`): the settings and how much results give.
 */
export function useChanges(
  was: { readonly call: CallSettings; readonly results: string },
  is: { readonly call: CallSettings; readonly results: string },
): readonly CallChange[] {
  return settingsChanges(settingsOf(was.call, was.results), settingsOf(is.call, is.results));
}
