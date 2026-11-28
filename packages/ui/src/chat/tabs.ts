import { newSeal, type Mail, type MessageFrom } from "@animaquill/agent";
import type { PostedMail } from "@animaquill/host";
import { MAX_MESSAGE, type AgentCard, type SendOutcome } from "@animaquill/tools";
import { cleanName, IDLE_WORDS } from "./relay.ts";

/**
 * What the windows of a browser carry for each other (chat6 technical design of AnimaQuill Cloud,
 * 6.2, see `AgentPost`): messages, cards and what came of a message, as this editor writes them,
 * and read back as nothing more than what it would write. What another window wrote is read as if
 * it came from anywhere: an editor of another version may have written it, or anything else of the
 * site.
 */

/** How long a message that waited for one whose window went away still starts a turn of its own. */
export const FRESH_LEFT_MS = 12 * 60 * 60 * 1000;
/** How long the window that sends waits to be told what came of a message by the one that took it. */
export const ANSWER_MS = 3_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A message as it waits for another window. */
export function postedOf(to: string, mail: Mail, left: boolean): PostedMail {
  const { seal: _seal, ...body } = mail;
  return { id: mail.id, to, from: mail.from.id, text: mail.text, at: mail.at, left, body };
}

/**
 * A message another window left, as this one reads it: only what a message has, as long as one
 * may be, from one that says who it is. Its words go between a seal this window makes: nothing
 * another wrote decides what the model reads them between.
 */
export function mailOf(posted: PostedMail): Mail | undefined {
  const body = posted.body;
  if (!isRecord(body)) return undefined;
  const { id, from, text, at } = body;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
  if (typeof text !== "string" || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (!isRecord(from) || typeof from.id !== "string" || typeof from.name !== "string") {
    return undefined;
  }
  if (from.kind !== "chat" && from.kind !== "tool") return undefined;
  if (from.id.length === 0 || from.id.length > 200) return undefined;
  const idle = from.idle === true;
  // An idle one says its last answer, which is shorter.
  if (text.length > (idle ? IDLE_WORDS : MAX_MESSAGE)) return undefined;
  const sender: MessageFrom = {
    id: from.id,
    name: cleanName(from.name, from.kind === "tool" ? 40 : 80),
    kind: from.kind,
    ...(idle && { idle: true as const }),
  };
  return { id, from: sender, text, at, seal: newSeal(text) };
}

const STATES = new Set<AgentCard["state"]>(["running", "waiting", "idle", "tool"]);
const ACCEPTS = new Set<AgentCard["accepts"]>(["yes", "ask", "no"]);

/**
 * A card another window said of one it has, as the list shows it: only what a card has; one whose
 * window went away is away. Its id is the one it was kept by, whatever the card says.
 */
export function cardOf(
  id: string,
  card: unknown,
  live: boolean,
  where: "tab" | "elsewhere" = "tab",
): AgentCard | undefined {
  if (!isRecord(card)) return undefined;
  const { kind, name, state, doing, changed, accepts } = card;
  if (kind !== "chat" && kind !== "tool") return undefined;
  // An AI tool is of the window it called; gone with it, there is nothing to send it.
  if (kind === "tool" && !live) return undefined;
  if (typeof name !== "string" || typeof state !== "string") return undefined;
  if (!STATES.has(state as AgentCard["state"])) return undefined;
  if (typeof accepts !== "string" || !ACCEPTS.has(accepts as AgentCard["accepts"])) {
    return undefined;
  }
  const lines = Array.isArray(changed)
    ? changed.filter((each): each is string => typeof each === "string").slice(0, 10)
    : [];
  return {
    id,
    kind,
    name: cleanName(name, kind === "tool" ? 40 : 80),
    state: live ? (state as AgentCard["state"]) : "away",
    ...(live && typeof doing === "string" && doing && { doing: cleanName(doing, 200) }),
    changed: lines.map((line) => cleanName(line, 200)),
    accepts: accepts as AgentCard["accepts"],
    // An AI tool of another window online is of the computer of that window, maybe not this one.
    ...((kind === "chat" || where === "elsewhere") && { where }),
  };
}

const SENT = new Set(["read", "turn"]);
const UNTIL = new Set(["people", "tool", "asked", "paused", "left", "away", "tab"]);
const REFUSED = new Set(["self", "unknown", "declines", "silent", "paused", "full", "repeat"]);

/** What another window said came of a message, as far as it is something that can come of one. */
export function outcomeOf(said: unknown): SendOutcome | undefined {
  if (!isRecord(said)) return undefined;
  if (typeof said.sent === "string") {
    if (SENT.has(said.sent)) return { sent: said.sent as "read" | "turn" };
    if (said.sent === "waits" && typeof said.until === "string" && UNTIL.has(said.until)) {
      return { sent: "waits", until: said.until as never };
    }
    return undefined;
  }
  if (typeof said.refused === "string" && REFUSED.has(said.refused)) {
    return { refused: said.refused as never };
  }
  return undefined;
}
