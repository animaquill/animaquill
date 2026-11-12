import type {
  AssistantEntry,
  ChatEntry,
  ToolCallEntry,
  ToolEntry,
  UserEntry,
} from "@animaquill/agent";

/**
 * A conversation by turns, as the chat shows it: what people said, the process of AI (thinking,
 * calls of tools, and what it said between them), and its answer, the words it ended with.
 */

/** One step of the process of a turn, in the order it came. */
export type Step =
  | { readonly kind: "thinking"; readonly id: string; readonly text: string; readonly ms?: number }
  | { readonly kind: "said"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly call: ToolCallEntry;
      readonly result: ToolEntry | undefined;
    };

export interface Turn {
  readonly task: string;
  readonly user: UserEntry;
  /** Everything after what people said, as kept. */
  readonly entries: readonly ChatEntry[];
  readonly steps: readonly Step[];
  /** The last words of AI in the turn, Markdown. */
  readonly answer: string | undefined;
  /** The answer they are in. */
  readonly answerEntry: AssistantEntry | undefined;
  readonly thoughts: number;
  readonly tools: number;
  readonly failed: number;
  /** From what people said to the end of the last answer or tool, where it ended. */
  readonly ms: number | undefined;
  /** The models that answered, in order, each once. */
  readonly models: readonly string[];
}

/** The entries of a conversation by task: each message of people starts one. */
export function groupsOf(
  entries: readonly ChatEntry[],
): { readonly user: UserEntry; readonly entries: ChatEntry[] }[] {
  const groups: { user: UserEntry; entries: ChatEntry[] }[] = [];
  for (const entry of entries) {
    if (entry.role === "user") groups.push({ user: entry, entries: [] });
    else groups.at(-1)?.entries.push(entry);
  }
  return groups;
}

/** A turn of what was kept. A turn that runs has no answer yet: its words are all process. */
export function turnOf(user: UserEntry, entries: readonly ChatEntry[], running = false): Turn {
  const results = new Map<string, ToolEntry>();
  for (const entry of entries) if (entry.role === "tool") results.set(entry.call, entry);
  const answers = entries.filter((entry): entry is AssistantEntry => entry.role === "assistant");
  const last = answers.at(-1);
  const answerEntry = !running && last && last.text.trim() !== "" ? last : undefined;
  const steps: Step[] = [];
  const models: string[] = [];
  let thoughts = 0;
  let tools = 0;
  let failed = 0;
  answers.forEach((entry, index) => {
    if (!models.includes(entry.model)) models.push(entry.model);
    if (entry.thinking) {
      thoughts += 1;
      steps.push({
        kind: "thinking",
        id: `${user.task}/${index}/thinking`,
        text: entry.thinking,
        ...(entry.thinkingMs !== undefined && { ms: entry.thinkingMs }),
      });
    }
    if (entry.text.trim() !== "" && entry !== answerEntry) {
      steps.push({ kind: "said", id: `${user.task}/${index}/said`, text: entry.text });
    }
    for (const call of entry.calls) {
      const result = results.get(call.id);
      tools += 1;
      if (result && !result.ok) failed += 1;
      steps.push({ kind: "tool", id: call.id, call, result });
    }
  });
  const ends = entries.map((entry) =>
    entry.role === "assistant" ? (entry.endedAt ?? entry.at) : entry.role === "tool" ? entry.at : 0,
  );
  const end = Math.max(0, ...ends);
  return {
    task: user.task,
    user,
    entries,
    steps,
    answer: answerEntry?.text,
    answerEntry,
    thoughts,
    tools,
    failed,
    ms: end > user.at ? end - user.at : undefined,
    models,
  };
}

/** How long something took, as people read it: "0.3 秒", "41 秒", "3 分 5 秒". */
export function durationText(
  say: (key: string, options?: Readonly<Record<string, unknown>>) => string,
  ms: number,
  tenths = false,
): string {
  if (tenths && ms < 10_000) return say("chat.duration.s", { n: (ms / 1000).toFixed(1) });
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return say("chat.duration.s", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return say("chat.duration.m", { m: minutes, s: seconds % 60 });
  return say("chat.duration.h", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
