import type { ChatEntry, MessageFrom } from "@animaquill/agent";

/**
 * How conversations pass words to each other without going on forever (docs/design/ai-teamwork.md
 * of AnimaQuill Cloud, 3), as Claude Code's sessions do: a conversation that answered others five
 * turns in a row stops until people say something to it; the same words from the same one within
 * a minute go once; at most fifty wait for one conversation.
 */

/** Turns in a row that messages of others start, before people have to say something. */
export const MAX_ROUNDS = 5;
/**
 * Turns that messages of others start, and messages tasks read on their way, in all conversations
 * of a window together, before people have to say something in one of them.
 */
export const MAX_UNATTENDED = 10;
/** Words of others one turn reads at most: the rest waits for the next. */
export const MAX_TURN_CHARS = 20_000;
/** Messages that wait for one conversation at most. */
export const MAX_WAITING = 50;
/** The same words from the same one within this long go once. */
export const REPEAT_MS = 60_000;
/** How long one waits to be told that another is idle, at most. */
export const WATCH_MS = 12 * 60 * 60 * 1000;
/** How much of the last answer of one that is idle now goes to whoever asked to be told. */
export const IDLE_WORDS = 300;

/**
 * The rounds at the end of a conversation with others, since people last said something in it:
 * each turn a message of another started, and each message a task read on its way; and who sent
 * the last of them.
 */
export function roundsOf(entries: readonly ChatEntry[]): {
  readonly rounds: number;
  readonly with: MessageFrom | undefined;
} {
  let rounds = 0;
  let last: MessageFrom | undefined;
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at];
    if (entry?.role === "message") {
      rounds += 1;
      last ??= entry.from;
      continue;
    }
    if (entry?.role !== "user") continue;
    if (!entry.from) break;
    rounds += 1;
    last ??= entry.from;
  }
  return { rounds, with: last };
}

/** The last words of a conversation's answer, for whoever asked to be told it is idle. */
export function lastAnswerOf(entries: readonly ChatEntry[]): string {
  const answer = entries.findLast(
    (entry) => entry.role === "assistant" && entry.text.trim() !== "",
  );
  const text = answer?.role === "assistant" ? answer.text.trim() : "";
  return text.length > IDLE_WORDS ? `${text.slice(0, IDLE_WORDS - 1)}…` : text;
}

/** Names that tell each one apart: the second of a name gets "（2）", and so on. */
export function distinctNames<T extends { readonly name: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = (seen.get(item.name) ?? 0) + 1;
    seen.set(item.name, count);
    return count === 1 ? item : { ...item, name: `${item.name}（${count}）` };
  });
}

/**
 * A name as others see it, in the list and as who sent a message: without characters that do not
 * show, turn text around or break lines, on one line, no longer than `most`.
 */
export function cleanName(name: string, most = 80): string {
  return name
    .replace(/[\t\n\r\f\v ]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, most);
}
