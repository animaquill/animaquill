import type { ModelRef, ReasoningLevel } from "@animaquill/agent";
import type { ServiceModel } from "../settings.ts";

/** A model in the bubble's list, of its service. */
export interface Row {
  readonly service: string;
  readonly model: ServiceModel;
}

/** A group of the bubble's list: the favorites, or the models that are on of one service. */
export interface Group {
  /** The id of the service, or "" for the favorites. */
  readonly service: string;
  readonly name: string;
  /** No key, or its test failed: the group shows dim, and says where to go. */
  readonly dim: "noKey" | "failed" | undefined;
  readonly rows: readonly Row[];
}

export const keyOf = (row: Pick<Row, "service"> & { readonly model: { readonly id: string } }) =>
  `${row.service}\n${row.model.id}`;
export const refKey = (ref: ModelRef) => `${ref.service}\n${ref.model}`;

/** The models that a search finds: by name, service or id, any case. */
export function findModels(groups: readonly Group[], query: string): readonly Group[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(({ model }) =>
        `${model.name ?? ""} ${model.id} ${group.name}`.toLocaleLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.rows.length > 0);
}

/** The words of a name of a model: by spaces where it has them, else by "-" (an id). */
function wordsOf(name: string): { readonly words: readonly string[]; readonly join: string } {
  const trimmed = name.trim();
  const join = /\s/.test(trimmed) ? " " : "-";
  return { words: trimmed.split(join === " " ? /\s+/ : "-").filter(Boolean), join };
}

/** A word that says little alone: a number, a version, two letters or less. */
const little = (word: string) => word.length <= 2 || /^[\d.]+$/.test(word);

/** The end of a name from a word on: from the last one that says something, or before it. */
function endOf(name: string, back: number): string {
  const { words, join } = wordsOf(name);
  let from = words.length - 1;
  while (from > 0 && little(words[from] as string)) from -= 1;
  return words.slice(Math.max(0, from - back)).join(join);
}

const MOST = 14;
const cut = (text: string) => (text.length > MOST ? `${text.slice(0, MOST)}…` : text);

/**
 * A name of a model short enough for a narrow chat: from its last word that says something on
 * ("GPT-6.1 Sol" is "Sol", "Claude Opus 5.5" is "Opus 5.5", "claude-sonnet-4-5" is "sonnet-4-5"),
 * with a word more where another model of `others` would read the same, at most 14 letters.
 */
export function shortName(name: string, others: readonly string[] = []): string {
  const rivals = others.filter((other) => other !== name);
  const words = wordsOf(name).words.length;
  for (let back = 0; back < words; back += 1) {
    const short = endOf(name, back);
    if (!rivals.some((other) => endOf(other, back) === short)) return cut(short);
  }
  return cut(name.trim());
}

/**
 * The next step of how hard a model reasons, as `Alt+R` goes: up through the steps it takes, then
 * back to "自动" (`undefined`).
 */
export function nextEffort(
  levels: readonly ReasoningLevel[],
  now: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  const steps: readonly (ReasoningLevel | undefined)[] = [undefined, ...levels];
  const at = steps.indexOf(now);
  return steps[(at + 1) % steps.length];
}
