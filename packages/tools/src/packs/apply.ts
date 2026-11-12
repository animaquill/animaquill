import {
  DEFAULT_TEXTS,
  hashOf,
  type TextTable,
  type TextValue,
  type TextsUsed,
} from "../texts/index.ts";
import { DEFAULT_TEXTS_USED, TOOLSET_VERSION } from "../toolset.ts";
import type { Detail } from "./detail.ts";
import type { CallSettings, ModelPack, PackEdit, PackVariant } from "./format.ts";

/**
 * Whether a model name fits a pattern of a pack: `*` stands for anything, case does not matter, and
 * the whole name has to fit, as people wrote it or what follows its last "/" (so that a pack for
 * "claude-opus-5*" fits "anthropic/claude-opus-5-5" on a service that forwards to others).
 */
export function fitsModel(pattern: string, model: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${source}$`, "i");
  return regex.test(model) || regex.test(model.slice(model.lastIndexOf("/") + 1));
}

/** How closely a pattern names models: the more that is not `*`, the closer. */
export const closenessOf = (pattern: string): number => pattern.replaceAll("*", "").length;

/** The variant of a pack for a model: the first whose patterns fit it. */
export function variantOf(pack: ModelPack, model: string | undefined): PackVariant | undefined {
  if (model === undefined) return undefined;
  return pack.variants.find(({ models }) => models.some((pattern) => fitsModel(pattern, model)));
}

const isListItem = (line: string | undefined) => line?.startsWith("- ") === true;

/**
 * What goes between the words a pack goes on after and its own: a line where both are a list, an
 * empty line in the system prompt and in descriptions, a space in the words of a parameter.
 */
function joinerOf(key: string, before: string, after: string): string {
  if (!key.startsWith("system.") && !key.endsWith(".description")) return " ";
  const list = isListItem(before.split("\n").at(-1)) && isListItem(after.split("\n")[0]);
  return list ? "\n" : "\n\n";
}

/** A table with the edits of a pack on it. */
export function withEdits(base: TextTable, edits: readonly PackEdit[]): TextTable {
  const texts: Record<string, TextValue> = { ...base };
  for (const edit of edits) {
    if (edit.how === "remove") {
      texts[edit.key] = "";
      continue;
    }
    if (edit.how === "set") {
      texts[edit.key] = edit.value;
      continue;
    }
    const before = texts[edit.key];
    if (typeof edit.value === "string") {
      const was = typeof before === "string" ? before : "";
      texts[edit.key] =
        was.trim() === ""
          ? edit.value
          : `${was}${joinerOf(edit.key, was, edit.value)}${edit.value}`;
    } else {
      const was = Array.isArray(before) ? before : [];
      texts[edit.key] = [...was, ...edit.value] as TextValue;
    }
  }
  return texts;
}

const made = new WeakMap<ModelPack, Map<PackVariant | undefined, TextTable>>();

/**
 * The words of the tools and the system prompt with a pack, as one table over the default one: what
 * the pack leaves alone is as the default pack has it. The same pack gives the same table.
 */
export function textsOf(pack: ModelPack, variant?: PackVariant): TextTable {
  const known = made.get(pack) ?? new Map<PackVariant | undefined, TextTable>();
  made.set(pack, known);
  const found = known.get(variant);
  if (found) return found;
  const edits = variant?.extra ? [...pack.edits, variant.extra] : pack.edits;
  const texts = edits.length === 0 ? DEFAULT_TEXTS : withEdits(DEFAULT_TEXTS, edits);
  known.set(variant, texts);
  return texts;
}

/** What a conversation records of the pack it used, see `TextsUsed`. */
export function usedOf(pack: ModelPack): TextsUsed {
  if (pack.id === DEFAULT_PACK_ID && pack.edits.length === 0) return DEFAULT_TEXTS_USED;
  return { id: pack.id, version: pack.version, hash: pack.hash };
}

/** Everything a pack gives for one model: words, how to call it, how much results give. */
export interface PackUse {
  readonly pack: ModelPack;
  readonly texts: TextTable;
  readonly call: CallSettings;
  readonly results: Detail;
  readonly used: TextsUsed;
}

export function usePack(pack: ModelPack, model: string | undefined): PackUse {
  const variant = variantOf(pack, model);
  return {
    pack,
    texts: textsOf(pack, variant),
    call: mergedCall(pack.call, variant?.call),
    results: variant?.results ?? pack.results ?? "standard",
    used: usedOf(pack),
  };
}

/** The call settings of a variant over the pack's, field by field. */
export function mergedCall(base: CallSettings, over: CallSettings | undefined): CallSettings {
  if (!over) return base;
  const anthropic =
    base.anthropic || over.anthropic ? { ...base.anthropic, ...over.anthropic } : undefined;
  return { ...base, ...over, ...(anthropic && { anthropic }) };
}

/** The id of the default pack, which is the words of the tools as AnimaQuill writes them. */
export const DEFAULT_PACK_ID = "animaquill/default";

/** The default pack: no models of its own, it is for those no other pack is for. */
export const DEFAULT_PACK: ModelPack = {
  id: DEFAULT_PACK_ID,
  name: "Default",
  version: TOOLSET_VERSION,
  description: "The words AnimaQuill writes for every model.",
  author: { name: "AnimaQuill" },
  license: "AGPL-3.0-only",
  builtin: true,
  models: [],
  call: {},
  variants: [],
  edits: [],
  hash: DEFAULT_TEXTS_USED.hash,
};

/** A hash of what a pack is, the same for the same pack, see `ModelPack.hash`. */
export function hashOfPack(pack: Omit<ModelPack, "hash">): string {
  return hashOf(canonical(pack));
}

/** JSON with the keys of every object in order, so that the same content gives the same text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}
