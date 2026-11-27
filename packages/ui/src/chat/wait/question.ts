import type { ChatEntry } from "@animaquill/agent";

/** A question AI asked with aq_propose, which the newest task can still have answered. */
export interface Question {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly other: boolean;
}

/** The question the entries of a turn end with, where AI asked one. */
export function questionOf(entries: readonly ChatEntry[]): Question | undefined {
  const asked = entries.findLast(
    (entry) => entry.role === "tool" && entry.name === "aq_propose" && entry.ok,
  );
  const data = asked?.role === "tool" ? asked.data?.question : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { question, options, allow_other: other } = data as Record<string, unknown>;
  if (typeof question !== "string" || !Array.isArray(options)) return undefined;
  const choices = options.flatMap((option: Record<string, unknown>) =>
    typeof option?.label === "string"
      ? [
          {
            label: option.label,
            ...(typeof option.detail === "string" && { detail: option.detail }),
          },
        ]
      : [],
  );
  return { question, options: choices, other: other !== false };
}
