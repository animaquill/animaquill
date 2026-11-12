import { objectKey, type ObjectRef, type Origin, type RevisionId } from "@animaquill/core";
import type { ToolResult } from "./types.ts";

/** How many results of calls with a `request_id` are kept, to answer one sent again the same way. */
const KEPT_RESULTS = 50;
/** How long a cursor of a list lasts. */
export const CURSOR_MS = 10 * 60 * 1000;
const KEPT_CURSORS = 20;
/** The version of what `toJSON` gives, for reading it back later. */
const SNAPSHOT_VERSION = 1;

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

/**
 * What of a file was read, of the text it had then: the lines that results gave whole, as ranges
 * from 1. Replacing a whole file needs every line of it read, of the text it has now.
 */
export interface FileSeen {
  readonly revision: RevisionId;
  readonly hash: string;
  readonly lines: number;
  readonly ranges: readonly (readonly [number, number])[];
}

/**
 * When an object was last read: in an overview (a line of a list, which shows where it is and what
 * it is) and whole (every field, also the values of its properties and keyframes). An overview
 * never stands for having read it whole, and a later overview does not make a whole read older.
 */
export interface Seen {
  readonly overview?: RevisionId;
  readonly full?: RevisionId;
}

/** What `CallerState.toJSON` gives: plain data, to keep with a conversation and read back. */
export interface CallerSnapshot {
  readonly version: number;
  readonly seen: readonly (readonly [string, Seen])[];
  readonly files: readonly (readonly [string, FileSeen])[];
  readonly own: readonly Origin[];
  readonly lastRead?: RevisionId;
  readonly lastCall?: RevisionId;
}

/** Ranges with another one in them, merged. */
function withRange(
  ranges: readonly (readonly [number, number])[],
  added: readonly [number, number],
): readonly (readonly [number, number])[] {
  const all = [...ranges, added].toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of all) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * What one caller, such as one conversation, has read of the project and when: the tools use it to
 * keep AI from overwriting what somebody else changed since, so that AI never passes revisions
 * itself. It lasts as long as the conversation, over all its messages, also over a reload when the
 * host keeps `toJSON` with the conversation. Revisions are those of one open project, see
 * `RevisionId`: after the project opens again, none of them counts any more.
 */
export class CallerState {
  /** When each object was last read, by `objectKey`. */
  readonly seen = new Map<string, Seen>();
  readonly files = new Map<string, FileSeen>();
  /** The origins this conversation changed the project as: each of its messages can be a task. */
  readonly own = new Set<Origin>();
  /** The last revision at which anything was read: the base of objects that were not read. */
  lastRead: RevisionId | undefined;
  /** The revision after the last call, to tell what others changed since. */
  lastCall: RevisionId | undefined;
  readonly #results = new Map<string, { readonly call: string; readonly result: ToolResult }>();
  readonly #cursors = new Map<string, Cursor>();
  #cursorCount = 0;
  /** What happened so far in the answer of the model that is running, see `beginAnswer`. */
  answer = { failedWrite: false, proposed: false };
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** What to keep with the conversation, to read back with `from` after a reload. */
  toJSON(): CallerSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      seen: [...this.seen],
      files: [...this.files],
      own: [...this.own],
      ...(this.lastRead !== undefined && { lastRead: this.lastRead }),
      ...(this.lastCall !== undefined && { lastCall: this.lastCall }),
    };
  }

  /** What `toJSON` gave, back as a caller: a snapshot it cannot read gives a new one. */
  static from(snapshot: unknown, now?: () => number): CallerState {
    const caller = new CallerState(now);
    const data = snapshot as Partial<CallerSnapshot> | undefined;
    if (data?.version !== SNAPSHOT_VERSION) return caller;
    for (const [key, seen] of data.seen ?? []) caller.seen.set(key, seen);
    for (const [path, file] of data.files ?? []) caller.files.set(path, file);
    for (const origin of data.own ?? []) caller.own.add(origin);
    if (typeof data.lastRead === "string") caller.lastRead = data.lastRead;
    if (typeof data.lastCall === "string") caller.lastCall = data.lastCall;
    return caller;
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

  /** An object was read, in an overview or whole, at a revision. */
  saw(object: ObjectRef, revision: RevisionId, depth: "overview" | "full" = "overview"): void {
    const key = objectKey(object);
    const known = this.seen.get(key) ?? {};
    this.seen.set(
      key,
      depth === "full" ? { overview: revision, full: revision } : { ...known, overview: revision },
    );
  }

  seenOf(object: ObjectRef): Seen {
    return this.seen.get(objectKey(object)) ?? {};
  }

  read(revision: RevisionId): void {
    this.lastRead = revision;
  }

  /** Lines of a file that a result gave whole, of its text with this hash. */
  readFile(
    path: string,
    revision: RevisionId,
    hash: string,
    lines: number,
    range?: readonly [number, number],
  ): void {
    const known = this.files.get(path);
    const ranges = known && known.hash === hash ? known.ranges : [];
    this.files.set(path, {
      revision,
      hash,
      lines,
      ranges: range ? withRange(ranges, range) : ranges,
    });
  }

  /** The result of a call with this request id, when the call was the same; or that it was not. */
  resultOf(request: string, call: string): ToolResult | "other" | undefined {
    const known = this.#results.get(request);
    if (!known) return undefined;
    return known.call === call ? known.result : "other";
  }

  keepResult(request: string, call: string, result: ToolResult): void {
    this.#results.delete(request);
    this.#results.set(request, { call, result });
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

/** Whether every line of a file was read, of the text it has now. */
export function readWhole(seen: FileSeen | undefined, hash: string, lines: number): boolean {
  if (!seen || seen.hash !== hash) return false;
  const [first] = seen.ranges;
  return seen.ranges.length === 1 && first !== undefined && first[0] <= 1 && first[1] >= lines;
}
