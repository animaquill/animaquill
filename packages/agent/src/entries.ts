import type { TextsUsed } from "@animaquill/tools";

/**
 * A conversation with AI, as this editor keeps it. This is our own shape and not the one of the
 * library that talks to the services: what is kept in the browser has to outlive an upgrade of it.
 * Only `pi.ts` turns it into what the library wants.
 */

/**
 * A picture kept with a conversation, by what it is: the SHA-256 of its bytes, so that the same
 * picture is kept once, here and, for a project of the platform, there (a design of its own). The
 * conversation has only this; the bytes are where the host keeps pictures.
 */
export interface ImageRef {
  /** `sha256:` and the hash of its bytes, in hex. */
  readonly image: string;
  /** Its media type, such as image/jpeg. */
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Which moment of the project a picture is a frame of. */
export interface ImageFrame {
  readonly timeline: string;
  readonly timelineName?: string;
  /** As times of the project are written. */
  readonly t: string;
  /** As the editor shows the moment. */
  readonly timecode: string;
}

/** A picture that went with a message: the line that says what it is goes to the model with it. */
export interface AttachedImage extends ImageRef {
  /** For the model, in English: which picture it is, of what, how large. */
  readonly note: string;
  /** For people: what the picture is, such as the moment of a frame. */
  readonly label?: string;
  /** Of a frame of the project: which. */
  readonly frame?: ImageFrame;
}

/** What people wrote. Each message starts a task, and what AI changes for it is that task's. */
export interface UserEntry {
  readonly role: "user";
  /** As people wrote it, links of the editor (`aq:`) as Markdown links. */
  readonly text: string;
  /** Pictures that went with it, in order. */
  readonly images?: readonly AttachedImage[];
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
  /** How long it thought, where it said so. */
  readonly thinkingMs?: number;
  /** The version of the tools it had, see `TOOLSET_VERSION`. Older answers had the tools before. */
  readonly toolset?: string;
  /**
   * The model pack it had: the words of the tools and of the system prompt, see `usedOf`. Older
   * answers had the default ones.
   */
  readonly texts?: TextsUsed;
  /** What people see of that pack. Older answers do not say. */
  readonly pack?: PackNote;
  /** How many tokens the request took and what it cost, as the service told. Older answers do not say. */
  readonly usage?: AnswerUsage;
  /** When the answer was over, in milliseconds since 1970; `at` is when its request went out. */
  readonly endedAt?: number;
}

/**
 * The tokens of one request and its answer, as the service counted them. The cost, in US dollars,
 * only where it is known: from the prices pi lists for this very model, or as the service billed it;
 * a model pi does not list has tokens only. So has the size of the context of the model.
 */
export interface AnswerUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost?: number;
  /** How many tokens the model takes in at most, where pi knows the model. */
  readonly window?: number;
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
  /** When it was done; `startedAt` is when it began, which older results do not say. */
  readonly at: number;
  readonly startedAt?: number;
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

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function readUsage(value: unknown): AnswerUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input);
  const output = count(value.output);
  if (input === undefined || output === undefined) return undefined;
  const cost = count(value.cost);
  const window = count(value.window);
  return {
    input,
    output,
    cacheRead: count(value.cacheRead) ?? 0,
    cacheWrite: count(value.cacheWrite) ?? 0,
    ...(cost !== undefined && { cost }),
    ...(window !== undefined && window > 0 && { window }),
  };
}

const ENDS: readonly AnswerEnd[] = ["done", "tools", "length", "stopped", "failed"];

function readCall(value: unknown): ToolCallEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, args } = value;
  if (typeof id !== "string" || typeof name !== "string" || !isRecord(args)) return undefined;
  return { id, name, args };
}

const HASH = /^sha256:[0-9a-f]{64}$/;

/** A picture as kept, where it is one. */
export function readImage(value: unknown): AttachedImage | undefined {
  if (!isRecord(value)) return undefined;
  const { image, type, note, label } = value;
  const width = count(value.width);
  const height = count(value.height);
  const bytes = count(value.bytes);
  if (typeof image !== "string" || !HASH.test(image) || typeof type !== "string") return undefined;
  if (width === undefined || height === undefined || bytes === undefined) return undefined;
  if (typeof note !== "string") return undefined;
  const frame = isRecord(value.frame) ? value.frame : undefined;
  const ok =
    typeof frame?.timeline === "string" &&
    typeof frame.t === "string" &&
    typeof frame.timecode === "string";
  return {
    image,
    type,
    width,
    height,
    bytes,
    note,
    ...(typeof label === "string" && { label }),
    ...(ok && {
      frame: {
        timeline: frame.timeline as string,
        t: frame.t as string,
        timecode: frame.timecode as string,
        ...(typeof frame.timelineName === "string" && { timelineName: frame.timelineName }),
      },
    }),
  };
}

/**
 * The text a message goes to the model with: its words, then the line of each of its pictures. A
 * picture that does not go with it says so in its line, and why (`missing`).
 */
export function promptOf(
  entry: Pick<UserEntry, "text" | "images">,
  missing: (image: AttachedImage, index: number) => string | undefined = () => undefined,
): string {
  const notes = (entry.images ?? []).map((image, index) => {
    const why = missing(image, index);
    if (why === undefined) return image.note;
    return image.note.endsWith("]")
      ? `${image.note.slice(0, -1)} — not attached: ${why}]`
      : `${image.note} (not attached: ${why})`;
  });
  return notes.length === 0 ? entry.text : `${entry.text}\n\n${notes.join("\n")}`;
}

/** Why a picture of a message does not go to the model with it, in English as all words to AI. */
export const NOT_ATTACHED = {
  blind: "this model cannot receive pictures",
  missing: "the picture is not on this device",
  older: "older picture, only the most recent ones are sent",
} as const;

/** An entry read back from the browser, or nothing when it is not one. */
export function readEntry(value: unknown): ChatEntry | undefined {
  if (!isRecord(value) || typeof value.at !== "number") return undefined;
  const { role, at } = value;
  if (role === "user") {
    const { text, task } = value;
    if (typeof text !== "string" || typeof task !== "string") return undefined;
    const images = Array.isArray(value.images)
      ? value.images.map(readImage).filter((image) => image !== undefined)
      : [];
    return { role, text, at, task, ...(images.length > 0 && { images }) };
  }
  if (role === "tool") {
    const { call, name, ok, text, data } = value;
    if (typeof call !== "string" || typeof name !== "string") return undefined;
    if (typeof ok !== "boolean" || typeof text !== "string") return undefined;
    const startedAt = count(value.startedAt);
    return {
      role,
      call,
      name,
      ok,
      text,
      at,
      ...(startedAt !== undefined && { startedAt }),
      ...(isRecord(data) && { data }),
    };
  }
  if (role === "assistant") {
    const { text, calls, end, error, service, protocol, model, thinking, toolset, texts, pack } =
      value;
    const note = readPack(pack);
    const usage = readUsage(value.usage);
    const endedAt = count(value.endedAt);
    const thinkingMs = count(value.thinkingMs);
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
      ...(typeof thinking === "string" && thinkingMs !== undefined && { thinkingMs }),
      ...(typeof toolset === "string" && { toolset }),
      ...(isTextsUsed(texts) && { texts }),
      ...(note && { pack: note }),
      ...(usage && { usage }),
      ...(endedAt !== undefined && { endedAt }),
    };
  }
  return undefined;
}
