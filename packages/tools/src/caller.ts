import { objectKey, type ObjectRef, type RevisionId } from "@animaquill/core";
import type { ToolResult } from "./types.ts";

/** How many results of calls with a `request_id` are kept, to answer one sent again the same way. */
const KEPT_RESULTS = 50;
/** How long a cursor of a list lasts. */
export const CURSOR_MS = 10 * 60 * 1000;
const KEPT_CURSORS = 20;

/** Where a list goes on, for the call that asks for its next part. */
export interface Cursor {
  readonly tool: string;
  /** The parameters of the call it goes on from, without the cursor, as JSON. */
  readonly args: string;
  readonly revision: RevisionId;
  /** The first item of the next part. */
  readonly offset: number;
  readonly made: number;
}

/** What a file was when it was read, to tell whether it changed since. */
export interface FileSeen {
  readonly revision: RevisionId;
  readonly hash: string;
}

/**
 * What one caller, such as one conversation, has read of the project and when: the tools use it to
 * keep AI from overwriting what somebody else changed since, so that AI never passes revisions
 * itself. It lasts as long as the conversation, over all its messages. Revisions are those of one
 * open project, see `RevisionId`: after the project opens again, none of them counts any more.
 */
export class CallerState {
  /** The revision at which each object was last read, by `objectKey`. */
  readonly seen = new Map<string, RevisionId>();
  readonly files = new Map<string, FileSeen>();
  /** The last revision at which anything was read: the base of objects that were not read. */
  lastRead: RevisionId | undefined;
  /** The revision after the last call, to tell what others changed since. */
  lastCall: RevisionId | undefined;
  readonly #results = new Map<string, ToolResult>();
  readonly #cursors = new Map<string, Cursor>();
  #cursorCount = 0;
  /** What happened so far in the answer of the model that is running, see `beginAnswer`. */
  answer = { failedWrite: false, proposed: false };
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get now(): number {
    return this.#now();
  }

  /**
   * A new answer of the model begins, with the calls it makes together: one of them that asks the
   * user, or a change that failed, holds back the changes after it in the same answer.
   */
  beginAnswer(): void {
    this.answer = { failedWrite: false, proposed: false };
  }

  saw(object: ObjectRef, revision: RevisionId): void {
    this.seen.set(objectKey(object), revision);
  }

  seenOf(object: ObjectRef): RevisionId | undefined {
    return this.seen.get(objectKey(object));
  }

  read(revision: RevisionId): void {
    this.lastRead = revision;
  }

  resultOf(request: string): ToolResult | undefined {
    return this.#results.get(request);
  }

  keepResult(request: string, result: ToolResult): void {
    this.#results.delete(request);
    this.#results.set(request, result);
    while (this.#results.size > KEPT_RESULTS) {
      const [oldest] = this.#results.keys();
      if (oldest !== undefined) this.#results.delete(oldest);
    }
  }

  /** A cursor for the rest of a list, by a short name that the model passes back. */
  cursor(cursor: Omit<Cursor, "made">): string {
    this.#cursorCount += 1;
    const name = `c${this.#cursorCount}`;
    this.#cursors.set(name, { ...cursor, made: this.#now() });
    while (this.#cursors.size > KEPT_CURSORS) {
      const [oldest] = this.#cursors.keys();
      if (oldest !== undefined) this.#cursors.delete(oldest);
    }
    return name;
  }

  cursorOf(name: string): Cursor | undefined {
    const cursor = this.#cursors.get(name);
    if (!cursor || this.#now() - cursor.made > CURSOR_MS) return undefined;
    return cursor;
  }
}
