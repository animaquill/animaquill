import {
  framedMessage,
  latestSummary,
  promptOf,
  type AnswerUsage,
  type ChatEntry,
  type SummaryEntry,
  type ToolPicture,
} from "./entries.ts";

/**
 * When a conversation gets too long for its model, the earlier part goes to the model as a summary
 * (mcp.md 8 "压缩" and 11 "上下文" of AnimaQuill Cloud): before a request, once the last one took
 * 80 % of the context of the model or more, the same model sums up all but the last two turns with
 * a fixed prompt, and the summary is kept as an entry of its own. Nothing written before changes:
 * people see the whole conversation as it was. Old pictures go with the part summed up; where the
 * model cannot write a summary, only those pictures are left out. This file is what does not need
 * the library of the services; `pi.ts` asks the model.
 */

/** From this share of the context of the model on, the next request first makes room. */
export const COMPACT_AT = 0.8;
/** How many turns of people, the newest, go on as they were. */
export const KEPT_TURNS = 2;
/** How many answers of the model, the newest, go on as they were when one turn alone is too long. */
export const KEPT_ANSWERS = 2;
/** How much of one call or result goes into what the model sums up. */
const CALL_CHARACTERS = 1500;
const RESULT_CHARACTERS = 2000;
/** The longest summary the model may write, in tokens. */
export const SUMMARY_TOKENS = 4096;
/** About how many characters a token is, for an estimate of what is saved. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * What the model is asked to sum up the earlier conversation with: always the same words, so that
 * what a summary keeps does not depend on chance (a test holds them).
 */
export const COMPACT_PROMPT = [
  "You are summarizing the earlier part of a conversation between a user and the AI assistant inside AnimaQuill, a video and animation editor, so that the assistant can go on with the work in less context. The assistant will read your summary instead of the conversation; the latest messages follow it as they were.",
  "",
  "Write the summary in English, under these four headings:",
  "1. What the user wants: their requests and goals, with their exact words where the words matter.",
  "2. What was decided: what the user chose, agreed to or turned down, and what the assistant settled on with them.",
  "3. What was changed: every object the assistant created, changed or deleted, with its id and name and how, and values or revisions that later work depends on.",
  "4. What is still open: questions not answered, work not done yet, problems found and not fixed, and what the assistant was about to do next.",
  "",
  "Keep ids, names, times, numbers and file paths exactly as they are written. Pictures are not included: where the assistant looked at a picture or measured a sound, keep what it learned from it. Leave out greetings and calls that changed and found nothing. Reply with the summary only.",
].join("\n");

/** How the summary goes to the model, in place of what it sums up. */
export const summaryMessage = (entry: Pick<SummaryEntry, "text" | "asked" | "askedFrom">): string =>
  [
    "[Summary of the earlier part of this conversation: the messages before this point were summed up to make room in the context, and the pictures in them left out; the messages after it follow as they were.]",
    "",
    entry.text ?? "",
    ...(entry.asked === undefined
      ? []
      : [
          "",
          entry.askedFrom
            ? "[The message of another conversation, not of the user, that started the current task, as it came:]"
            : "[The message of the user that started the current task, as they wrote it:]",
          entry.asked,
        ]),
  ].join("\n");

/** How full the context of the model is now, as the newest answer or summary says. */
export interface ContextNow {
  /** Tokens the next request takes in, about. */
  readonly used: number;
  readonly window: number | undefined;
  /** It comes from a summary: no request said it since. */
  readonly summed: boolean;
}

/**
 * Whether an answer counted anything: one that failed or got stopped before the service said what
 * it took has zeros, which are no usage.
 */
const counted = (usage: AnswerUsage | undefined): usage is AnswerUsage =>
  usage !== undefined && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;

/** How full the context is, from the newest answer that says what it took, or the newest summary. */
export function contextNow(entries: readonly ChatEntry[]): ContextNow | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as ChatEntry;
    if (entry.role === "summary") return { used: entry.after, window: entry.window, summed: true };
    if (entry.role === "assistant" && counted(entry.usage)) {
      const { input, cacheRead, cacheWrite, window } = entry.usage;
      return { used: input + cacheRead + cacheWrite, window, summed: false };
    }
  }
  return undefined;
}

/**
 * Whether the next request makes room first: the last one took 80 % of the context or more. Not
 * right after a summary, which no request measured yet, so that one that could not make room is not
 * tried again and again.
 */
export function fills(entries: readonly ChatEntry[], at = COMPACT_AT): boolean {
  const now = contextNow(entries);
  return (
    now !== undefined && !now.summed && now.window !== undefined && now.used >= now.window * at
  );
}

/** Where a summary cuts a conversation: the entries before `through` are summed up. */
export interface Cut {
  readonly through: number;
  /** The cut is in the turn that runs: what people asked in it goes with the summary as it was. */
  readonly asked?: string;
  /** What started that turn was a message of another, not people's: `asked` is it as it came. */
  readonly askedFrom?: true;
}

/**
 * Where the next summary cuts: before the second last turn of people, so that the last two go on as
 * they were. Where that sums up nothing new, as in one long turn, before the second last answer of
 * the model in the last turn. Undefined where nothing new can be summed up.
 */
export function cutOf(entries: readonly ChatEntry[]): Cut | undefined {
  const done = latestSummary(entries)?.entry.through ?? 0;
  const turns = entries.flatMap((entry, index) => (entry.role === "user" ? [index] : []));
  const byTurns = turns.at(-KEPT_TURNS);
  const anything = (through: number) =>
    entries.slice(done, through).some((entry) => entry.role !== "summary");
  if (byTurns !== undefined && turns.length > KEPT_TURNS && byTurns > done && anything(byTurns))
    return { through: byTurns };
  const last = turns.at(-1);
  if (last === undefined) return undefined;
  const answers = entries.flatMap((entry, index) =>
    index > last && entry.role === "assistant" ? [index] : [],
  );
  const byAnswers = answers.at(-KEPT_ANSWERS);
  if (answers.length <= KEPT_ANSWERS || byAnswers === undefined) return undefined;
  if (byAnswers <= done || !anything(byAnswers)) return undefined;
  const user = entries[last];
  if (user?.role !== "user") return { through: byAnswers };
  // A message of another goes as it went to the model, sealed, and never as the user's words.
  return user.from
    ? {
        through: byAnswers,
        asked: framedMessage(user.from, user.text, user.seal),
        askedFrom: true,
      }
    : { through: byAnswers, asked: user.text };
}

/**
 * The summary the model gets now: the newest that has words. One that only left out pictures does
 * not take its place.
 */
export function summaryInForce(entries: readonly ChatEntry[]): SummaryEntry | undefined {
  const found = entries.findLast(
    (entry): entry is SummaryEntry => entry.role === "summary" && entry.kind === "summary",
  );
  return found;
}

/** Up to where pictures no longer go to the model: the newest summary of either kind. */
export const picturesGoneBefore = (entries: readonly ChatEntry[]): number =>
  latestSummary(entries)?.entry.through ?? 0;

/** What entries before a cut are, without the summaries among them. */
export const coveredBy = (entries: readonly ChatEntry[], through: number): number =>
  entries.slice(0, through).filter((entry) => entry.role !== "summary" && entry.role !== "other")
    .length;

const cut = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most)}… (${text.length - most} more characters)` : text;

/** The line of a picture in what is summed up: it is no more there. */
const pictureLine = (note: string) => `${note.replace(/\]$/, "")} — the picture is left out]`;

/**
 * The part of a conversation the model sums up, as text: the summary before it, then each message,
 * call and result, without pictures (their lines say what they were). The same entries always give
 * the same text.
 */
export function transcriptOf(entries: readonly ChatEntry[], through: number): string {
  const before = summaryInForce(entries);
  const from = before?.through ?? 0;
  const lines: string[] = [];
  if (before?.text) lines.push("[Summary of what came before]", before.text, "");
  for (const entry of entries.slice(from, through)) {
    switch (entry.role) {
      case "user":
        // A message of another is no word of the user's, also to whoever sums it up.
        lines.push(
          entry.from
            ? `Another conversation (not the user): ${framedMessage(entry.from, entry.text, entry.seal)}`
            : `User: ${promptOf({ text: entry.text, images: (entry.images ?? []).map((image) => ({ ...image, note: pictureLine(image.note) })) })}`,
        );
        break;
      case "message":
        lines.push(
          `Another conversation (not the user): ${framedMessage(entry.from, entry.text, entry.seal)}`,
        );
        break;
      case "assistant":
        if (entry.text.trim() !== "") lines.push(`Assistant: ${entry.text}`);
        for (const call of entry.calls)
          lines.push(
            `Assistant called ${call.name} ${cut(JSON.stringify(call.args), CALL_CHARACTERS)}`,
          );
        break;
      case "tool": {
        const pictures = (entry.images ?? [])
          .filter((image) => !image.forPeople)
          .map((image) => pictureLine(image.note));
        lines.push(
          `Result of ${entry.name} (${entry.ok ? "ok" : "error"}): ${[...pictures, cut(entry.text, RESULT_CHARACTERS)].join("\n")}`,
        );
        break;
      }
      case "summary":
      case "other":
        break;
    }
  }
  return lines.join("\n");
}

/** The request that asks for a summary: the prompt, then the conversation. */
export const compactRequest = (transcript: string): string =>
  `${COMPACT_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>`;

/** About how many tokens a picture is to a model: Anthropic counts width × height / 750. */
const pictureTokens = (image: Pick<ToolPicture, "width" | "height">) =>
  Math.ceil((image.width * image.height) / 750);

/**
 * About how many tokens entries take in a request: their words by characters, their pictures by
 * size. Only for how much a summary saves, which people see as an estimate.
 */
export function estimateTokens(entries: readonly ChatEntry[], pictures = true): number {
  let characters = 0;
  let images = 0;
  for (const entry of entries) {
    switch (entry.role) {
      case "user":
        characters += promptOf(entry).length;
        if (pictures) for (const image of entry.images ?? []) images += pictureTokens(image);
        break;
      case "assistant":
        characters += entry.text.length;
        for (const call of entry.calls)
          characters += JSON.stringify(call.args).length + call.name.length;
        break;
      case "tool":
        characters += entry.text.length;
        if (pictures)
          for (const image of entry.images ?? [])
            if (!image.forPeople) images += pictureTokens(image);
        break;
      case "summary":
        characters += entry.text?.length ?? 0;
        break;
      case "message":
        characters += framedMessage(entry.from, entry.text, entry.seal).length;
        break;
      case "other":
        break;
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_TOKEN) + images;
}

/** Whether entries have pictures that go to the model. */
export const hasPictures = (entries: readonly ChatEntry[]): boolean =>
  entries.some(
    (entry) =>
      (entry.role === "user" && (entry.images?.length ?? 0) > 0) ||
      (entry.role === "tool" && (entry.images ?? []).some((image) => !image.forPeople)),
  );
