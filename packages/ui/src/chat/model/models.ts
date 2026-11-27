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

/**
 * A name of a model short enough for a narrow chat: its last word ("GPT-6.1 Sol" is "Sol"), or its
 * last two where the last says too little alone ("Claude Opus 5.5" is "Opus 5.5", "DeepSeek V4"
 * stays), at most 12 letters.
 */
export function shortName(name: string): string {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? name;
  const little = last.length <= 2 || /^[\d.]+$/.test(last);
  const short = words.length > 1 ? (little ? words.slice(-2).join(" ") : last) : name;
  return short.length > 12 ? `${short.slice(0, 12)}…` : short;
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
