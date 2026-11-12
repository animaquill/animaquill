import type { TextsUsed } from "@animaquill/tools";

/**
 * A conversation with AI, as this editor keeps it. This is our own shape and not the one of the
 * library that talks to the services: what is kept in the browser has to outlive an upgrade of it.
 * Only `pi.ts` turns it into what the library wants.
 */

/** What people wrote. Each message starts a task, and what AI changes for it is that task's. */
export interface UserEntry {
  readonly role: "user";
  readonly text: string;
  /** Milliseconds since 1970. */
  readonly at: number;
  /** The task this message started, see `aiTask`. */
  readonly task: string;
}

/** One call of a tool, as AI asked for it. */
export interface ToolCallEntry {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * How an answer ended: it is done, it called tools and goes on after them, it ran out of room, it
 * got stopped, or it failed.
 */
export type AnswerEnd = "done" | "tools" | "length" | "stopped" | "failed";

export interface AssistantEntry {
  readonly role: "assistant";
  readonly text: string;
  readonly calls: readonly ToolCallEntry[];
  readonly at: number;
  readonly end: AnswerEnd;
  /** What went wrong, without any key in it. */
  readonly error?: string;
  /** Which kind of service and which model answered, see `ServiceKind`. */
  readonly service: string;
  readonly protocol: string;
  readonly model: string;
  /**
   * What the model said of its thinking, where its service gives a summary: for people to follow
   * along, never sent back to it.
   */
  readonly thinking?: string;
  /** The version of the tools it had, see `TOOLSET_VERSION`. Older answers had the tools before. */
  readonly toolset?: string;
  /**
   * The model pack it had: the words of the tools and of the system prompt, see `usedOf`. Older
   * answers had the default ones.
   */
  readonly texts?: TextsUsed;
  /** What people see of that pack. Older answers do not say. */
  readonly pack?: PackNote;
}

/**
 * How a conversation came to use a model pack, as `PackChoiceBy` says, or because the switch for
 * developers asked for the words to compare with.
 */
export type PackBy = "chosen" | "matched" | "fallback" | "comparison";

/** Which model pack an answer had, for people: its name, its author, how it came to be. */
export interface PackNote {
  readonly name: string;
  readonly author?: string;
  /** It comes with AnimaQuill. */
  readonly builtin?: true;
  readonly by: PackBy;
}

/** What came of one call of a tool, which is what AI gets to read. */
export interface ToolEntry {
  readonly role: "tool";
  /** The `ToolCallEntry.id` it answers. */
  readonly call: string;
  readonly name: string;
  readonly ok: boolean;
  readonly text: string;
  readonly at: number;
  /** What the call changed or found, for the summary of a turn: never sent to the model. */
  readonly data?: Readonly<Record<string, unknown>>;
}

export type ChatEntry = UserEntry | AssistantEntry | ToolEntry;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTextsUsed = (value: unknown): value is TextsUsed =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.version === "string" &&
  typeof value.hash === "string";

const BYS: readonly PackBy[] = ["chosen", "matched", "fallback", "comparison"];

function readPack(value: unknown): PackNote | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  if (!BYS.includes(value.by as PackBy)) return undefined;
  return {
    name: value.name,
    ...(typeof value.author === "string" && { author: value.author }),
    ...(value.builtin === true && { builtin: true }),
    by: value.by as PackBy,
  };
}

const ENDS: readonly AnswerEnd[] = ["done", "tools", "length", "stopped", "failed"];

function readCall(value: unknown): ToolCallEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, args } = value;
  if (typeof id !== "string" || typeof name !== "string" || !isRecord(args)) return undefined;
  return { id, name, args };
}

/** An entry read back from the browser, or nothing when it is not one. */
export function readEntry(value: unknown): ChatEntry | undefined {
  if (!isRecord(value) || typeof value.at !== "number") return undefined;
  const { role, at } = value;
  if (role === "user") {
    const { text, task } = value;
    if (typeof text !== "string" || typeof task !== "string") return undefined;
    return { role, text, at, task };
  }
  if (role === "tool") {
    const { call, name, ok, text, data } = value;
    if (typeof call !== "string" || typeof name !== "string") return undefined;
    if (typeof ok !== "boolean" || typeof text !== "string") return undefined;
    return { role, call, name, ok, text, at, ...(isRecord(data) && { data }) };
  }
  if (role === "assistant") {
    const { text, calls, end, error, service, protocol, model, thinking, toolset, texts, pack } =
      value;
    const note = readPack(pack);
    if (typeof text !== "string" || !Array.isArray(calls)) return undefined;
    if (!ENDS.includes(end as AnswerEnd)) return undefined;
    if (typeof service !== "string" || typeof protocol !== "string") return undefined;
    if (typeof model !== "string") return undefined;
    const read = calls.map(readCall);
    if (read.some((call) => call === undefined)) return undefined;
    return {
      role,
      text,
      calls: read as ToolCallEntry[],
      at,
      end: end as AnswerEnd,
      ...(typeof error === "string" && { error }),
      service,
      protocol,
      model,
      ...(typeof thinking === "string" && thinking !== "" && { thinking }),
      ...(typeof toolset === "string" && { toolset }),
      ...(isTextsUsed(texts) && { texts }),
      ...(note && { pack: note }),
    };
  }
  return undefined;
}
