import type { MessageFrom } from "./entries.ts";

/**
 * Messages of other conversations of the project, or AI tools, for a conversation
 * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3): a task that runs reads them after a call of
 * a tool, the way pi steers a task. Whoever keeps them decides which may go in now.
 */
export interface Mail {
  readonly id: string;
  readonly from: MessageFrom;
  readonly text: string;
  readonly at: number;
  /** What its words go between to the model, made where it was sent: see `framedMessage`. */
  readonly seal: string;
}

export interface Inbox {
  /** The messages that may go into the task that runs now: they are its from then on. */
  take(): readonly Mail[];
  /** Says when there may be messages to take. */
  subscribe(listener: () => void): () => void;
  /** Messages taken that the task did not get to read, as it ended first: they wait again. */
  putBack(mails: readonly Mail[]): void;
}
