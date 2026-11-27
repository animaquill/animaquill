import type { SavedChatSummary } from "@animaquill/host";
import type { TFunction } from "i18next";

/**
 * What the list calls a conversation: the name people gave it, or the one the model wrote; one that
 * was copied from another and has no name of its own says where from; else its first words.
 */
export function titleOf(
  t: TFunction,
  chat: Pick<SavedChatSummary, "title" | "titleBy" | "forkedFrom">,
): string {
  if (chat.titleBy === undefined && chat.forkedFrom) {
    return t("chat.list.forked", { ...chat.forkedFrom });
  }
  return chat.title || t("chat.untitled");
}

/** How long typing rests before the conversations are searched. */
export const SEARCH_DELAY_MS = 150;
