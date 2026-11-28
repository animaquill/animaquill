/**
 * Other conversations of the same project, and AI tools on this computer, that AI can see and send
 * words to (docs/design/ai-teamwork.md of AnimaQuill Cloud, 2 and 3): what the host knows of them,
 * and what came of sending. The host decides how a message gets there; the tools only ask.
 */

/** Who sent a message: another conversation of the chat, or an AI tool on this computer. */
export interface AgentFrom {
  readonly id: string;
  readonly name: string;
  readonly kind: "chat" | "tool";
}

/** One that can be sent to, as `aq_agents_list` gives it. */
export interface AgentCard {
  /** Its address: a conversation's id, `mcp:` and a session for an AI tool on this computer. */
  readonly id: string;
  readonly kind: "chat" | "tool";
  /** As people call it, the same as no other one of the list. */
  readonly name: string;
  /**
   * A task of it runs; it waits for people (a change to allow, a question, a plan, or it stopped
   * after too many rounds with others); nothing goes on in it; or it is not open in this window,
   * and opens when it gets a message. An AI tool says none of these: nobody here can tell.
   */
  readonly state: "running" | "waiting" | "idle" | "closed" | "tool";
  /** What it does now, in the words of the chat, while a task runs. */
  readonly doing?: string;
  /** What it changed last, as results name objects. */
  readonly changed: readonly string[];
  /** What it does with messages, as people set it: takes them, asks people first, or none. */
  readonly accepts: "yes" | "ask" | "no";
}

/** What came of sending a message, see `AgentDirectory.send`. */
export type SendOutcome =
  /** It reads it with its next call; or it started a turn with it. */
  | { readonly sent: "read" | "turn" }
  /** It waits there: for people to answer it first, for its next call (an AI tool), for people to say something again. */
  /**
   * It waits there: for people to answer it first, for its next call (an AI tool), for people to
   * let it, for people to say something again, or, left for one not open, for people to read it.
   */
  | {
      readonly sent: "waits";
      readonly until: "people" | "tool" | "asked" | "paused" | "left";
    }
  | {
      readonly refused:
        | "self"
        | "unknown"
        | "declines"
        /** People set this editor to take no messages of others, and so it sends none either. */
        | "silent"
        /** The one that sends answered others too many times in a row: people have to speak first. */
        | "paused"
        | "full"
        | "repeat";
    };

/** What came of asking to be told once another is idle, see `AgentDirectory.notifyWhenIdle`. */
export type NotifyOutcome =
  | { readonly watching: true }
  | { readonly refused: "self" | "unknown" | "cannotTell" | "declines" };

/**
 * The others a caller can see and send to, for one caller: the host knows who calls. Only the
 * project open and the person's own conversations, never anyone else's.
 */
export interface AgentDirectory {
  list(): Promise<readonly AgentCard[]>;
  /** Sends words to one of `list` by its id. */
  send(to: string, text: string): Promise<SendOutcome>;
  /** Asks to be told once, with a message, when that one is next idle: within 12 hours. */
  notifyWhenIdle(target: string): Promise<NotifyOutcome>;
}

/** How long a message is at most, in characters. */
export const MAX_MESSAGE = 4000;
