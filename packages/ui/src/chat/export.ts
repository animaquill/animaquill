import type { ChatEntry } from "@animaquill/agent";
import type { TFunction } from "i18next";
import { plainOf } from "./refs.ts";
import { groupsOf, turnOf } from "./turns.ts";

/** A conversation as Markdown: what people said and what AI answered, turn by turn. */
export function markdownOf(t: TFunction, title: string, entries: readonly ChatEntry[]): string {
  const parts = [`# ${title}`];
  for (const group of groupsOf(entries)) {
    const pictures = (group.user.images ?? []).map(
      (image, index) =>
        `[${t("chat.attached.picture", { number: index + 1 })}${image.label ? `: ${image.label}` : ""}]`,
    );
    parts.push(
      `**${t("chat.you")}**:\n\n${[plainOf(group.user.text), ...pictures].filter(Boolean).join("\n\n")}`,
    );
    // What people said while not allowing a change, which AI read with it.
    for (const entry of group.entries) {
      if (
        entry.role === "tool" &&
        entry.data?.declined === true &&
        typeof entry.data.said === "string"
      )
        parts.push(`**${t("chat.youDeclined")}**:\n\n${entry.data.said}`);
    }
    const turn = turnOf(group.user, group.entries);
    // Links of the editor mean nothing outside it: what they say stays.
    if (turn.answer) parts.push(`**${t("chat.assistant")}**:\n\n${plainOf(turn.answer)}`);
  }
  return `${parts.join("\n\n")}\n`;
}
