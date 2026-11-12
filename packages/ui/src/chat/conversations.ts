import type { ChatEntry } from "@animaquill/agent";
import type { SavedChatSummary } from "@animaquill/host";
import { summaryOf } from "./summary.ts";
import { groupsOf } from "./turns.ts";

/**
 * The conversations of a project as the list shows them: by day, and found by what was said in
 * them. Nothing here knows the page.
 */

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

export type DayGroup = "today" | "yesterday" | "earlier";

/** Conversations by when they last changed: today, yesterday, earlier; newest first in each. */
export function byDay<T extends Pick<SavedChatSummary, "updatedAt">>(
  chats: readonly T[],
  now: number,
): readonly { readonly day: DayGroup; readonly chats: readonly T[] }[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - DAY / 2);
  const groups: Record<DayGroup, T[]> = { today: [], yesterday: [], earlier: [] };
  for (const chat of chats.toSorted((a, b) => b.updatedAt - a.updatedAt)) {
    const day =
      chat.updatedAt >= today ? "today" : chat.updatedAt >= yesterday ? "yesterday" : "earlier";
    groups[day].push(chat);
  }
  return (["today", "yesterday", "earlier"] as const)
    .filter((day) => groups[day].length > 0)
    .map((day) => ({ day, chats: groups[day] }));
}

/** How many places AI changed in a conversation: what the card of each turn says, added up. */
export function changesIn(entries: readonly ChatEntry[]): number {
  return groupsOf(entries).reduce((sum, turn) => sum + summaryOf(turn.entries).changes.length, 0);
}

/** AI asked a question in the last turn (`aq_propose`), which nobody answered yet. */
export function askingIn(entries: readonly ChatEntry[]): boolean {
  const start = entries.findLastIndex((entry) => entry.role === "user");
  if (start < 0) return false;
  return entries
    .slice(start + 1)
    .some((entry) => entry.role === "tool" && entry.name === "aq_propose" && entry.ok);
}

/** The first words of a conversation, for its title until it gets another. */
export function firstWords(entries: readonly ChatEntry[], length: number): string {
  const first = entries.find((entry) => entry.role === "user");
  const text = first?.role === "user" ? first.text : "";
  const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
  // A quote is not what a conversation is about: what follows it is.
  const said = text
    .split("\n")
    .find((each) => each.trim() !== "" && !each.trimStart().startsWith(">"));
  return (said ?? line).trim().slice(0, length);
}

/** Where a search found its words in a conversation: the turn, and some text around them. */
export interface Found {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  /** The task of the turn they are in; none where only the title had them. */
  readonly task?: string;
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/** How many characters a hit shows on each side of the words found. */
const AROUND = 24;
/** At most this many hits for one conversation, and for all. */
const PER_CHAT = 3;
const MAX_FOUND = 30;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hitIn(text: string, matcher: RegExp) {
  const found = matcher.exec(text);
  if (!found) return undefined;
  const start = found.index;
  const end = start + found[0].length;
  const before = text.slice(Math.max(0, start - AROUND), start);
  const after = text.slice(end, end + AROUND);
  const flat = (part: string) => part.replace(/\s+/g, " ");
  return {
    before: (start > AROUND ? "…" : "") + flat(before),
    match: found[0],
    after: flat(after) + (end + AROUND < text.length ? "…" : ""),
  };
}

/**
 * Finds words in conversations: in the title, in what people said and what AI answered, without
 * case, as written (not a pattern). Newest conversations first, a few hits each.
 */
export function searchChats(
  chats: readonly {
    readonly summary: Pick<SavedChatSummary, "id" | "title" | "updatedAt">;
    readonly entries: readonly ChatEntry[];
  }[],
  query: string,
): readonly Found[] {
  const needle = query.trim();
  if (!needle) return [];
  const matcher = new RegExp(escaped(needle), "i");
  const found: Found[] = [];
  for (const { summary, entries } of chats.toSorted(
    (a, b) => b.summary.updatedAt - a.summary.updatedAt,
  )) {
    const { id, title, updatedAt } = summary;
    let hits = 0;
    let task: string | undefined;
    for (const entry of entries) {
      if (entry.role === "user") task = entry.task;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      const hit = hitIn(entry.text, matcher);
      if (!hit) continue;
      found.push({ id, title, updatedAt, ...(task !== undefined && { task }), ...hit });
      if (++hits >= PER_CHAT || found.length >= MAX_FOUND) break;
    }
    if (hits === 0) {
      const hit = hitIn(title, matcher);
      if (hit) found.push({ id, title, updatedAt, ...hit });
    }
    if (found.length >= MAX_FOUND) break;
  }
  return found;
}

/**
 * A title the model wrote, made fit for the list: one line, no quotes or a word like "Title:" around
 * it, no full stop at its end, and not too long. Nothing where nothing is left.
 */
export function cleanTitle(said: string, length: number): string | undefined {
  const line = said.split("\n").find((each) => each.trim() !== "") ?? "";
  const bare = line
    .trim()
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/[。.!！]+$/, "")
    .replace(/^["'“”‘’「」《》*#\s]+|["'“”‘’「」《》*\s]+$/g, "")
    .replace(/[。.!！]+$/, "")
    .trim();
  return bare ? bare.slice(0, length) : undefined;
}
