import { Emitter } from "../workbench/emitter.ts";

/**
 * Where an export is, as people see it in the list of exports:
 *
 * - `waiting`: in line, and it goes when its turn comes;
 * - `running`: the one that goes now, of which there is one at most;
 * - `paused`: people paused it, or the browser wants a press of a button before it goes on;
 * - `failed`: something went wrong, and it goes on from where it was kept once people retry;
 * - `interrupted`: the page went away while it ran, and it goes on from where it was kept;
 * - `done`: finished, and only in the list until people clear it or the page goes.
 */
export type ExportStatus = "waiting" | "running" | "paused" | "failed" | "interrupted" | "done";

export interface QueueEntry {
  readonly id: string;
  readonly project: string;
  /** Of the file it goes to, which says the format too. */
  readonly name: string;
  readonly status: ExportStatus;
  /** Its place in line, which it keeps when it pauses or fails and goes on again. */
  readonly order: number;
  /** Frames on the disk, as far as it is known here, and how many there are to do. */
  readonly done: number;
  readonly total: number;
  /** What went wrong, as people were told. */
  readonly failure?: string;
  /**
   * It came from before a reload, and only goes on when people say so: going on takes a press of a
   * button, for the window and for the file.
   */
  readonly restored?: boolean;
  /** Paused because the browser wants a press of a button for the file, not because people said so. */
  readonly needsPress?: boolean;
}

/** Statuses that a record keeps for after a reload. A running one is interrupted by then. */
export type SavedStatus = "waiting" | "running" | "paused" | "failed";

/** Where an export is in line, as it is kept with what it did. */
export interface SavedQueue {
  readonly status: SavedStatus;
  readonly order: number;
  readonly failure?: string;
}

/** What a kept export is, after a reload: one that was running did not get to say otherwise. */
export function statusAfterReload(queue: SavedQueue | undefined): ExportStatus {
  if (queue?.status === "waiting" || queue?.status === "paused" || queue?.status === "failed") {
    return queue.status;
  }
  return "interrupted";
}

/**
 * The exports of this window, in line: one runs at a time, and the others wait for their turn in
 * the order people asked for them. All of it is decided here, without a page, so that it can be
 * tested; what an export does is not.
 */
export class ExportQueue {
  readonly #emitter = new Emitter();
  readonly #entries = new Map<string, QueueEntry>();
  #snapshot: readonly QueueEntry[] = [];
  #lastOrder = 0;

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): readonly QueueEntry[] => this.#snapshot;

  /** A place in line after every other, also after those of an earlier page. */
  nextOrder(now = Date.now()): number {
    this.#lastOrder = Math.max(now, this.#lastOrder + 1);
    return this.#lastOrder;
  }

  get(id: string): QueueEntry | undefined {
    return this.#entries.get(id);
  }

  /** Puts it in line, or puts it right where it is. */
  put(entry: QueueEntry): void {
    this.#lastOrder = Math.max(this.#lastOrder, entry.order);
    this.#entries.set(entry.id, entry);
    this.#changed();
  }

  /** What is undefined in `changes` stops being said of the entry. */
  update(
    id: string,
    changes: {
      readonly [K in Exclude<keyof QueueEntry, "id" | "order">]?: QueueEntry[K] | undefined;
    },
  ): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const next: Record<string, unknown> = { ...entry, ...changes };
    // What does not apply any more goes, so that an entry says only what is true of it now.
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
    this.#entries.set(id, next as unknown as QueueEntry);
    this.#changed();
  }

  remove(id: string): void {
    if (this.#entries.delete(id)) this.#changed();
  }

  /** The one that runs, if one does. */
  running(): QueueEntry | undefined {
    return this.#snapshot.find(({ status }) => status === "running");
  }

  /**
   * The one whose turn it is, when none runs: the first that waits, of those that can go now. One
   * that cannot, such as one of a project that is not open, does not hold up those after it.
   */
  next(canRun: (entry: QueueEntry) => boolean = () => true): QueueEntry | undefined {
    if (this.running()) return undefined;
    return this.#snapshot.find((entry) => entry.status === "waiting" && canRun(entry));
  }

  /** How many go before it: the one that runs, and those that wait in front of it. */
  ahead(id: string): number {
    const entry = this.#entries.get(id);
    if (entry?.status !== "waiting") return 0;
    return this.#snapshot.filter(
      (other) =>
        other.status === "running" ||
        (other.status === "waiting" && other.order < entry.order && !other.restored),
    ).length;
  }

  /** How many wait for their turn behind the one that runs, to say how much more there is. */
  waiting(): number {
    return this.#snapshot.filter(({ status, restored }) => status === "waiting" && !restored)
      .length;
  }

  #changed(): void {
    this.#snapshot = [...this.#entries.values()].toSorted((a, b) => a.order - b.order);
    this.#emitter.emit();
  }
}

/**
 * How long the rest takes, from how fast it went so far. Waiting does not count: for a sound, for
 * a file to be read, or for the page to be on the screen again. That says nothing about how fast
 * the frames go, and counting it would make the estimate jump up after every wait.
 */
export class Pace {
  #since: number;
  #from: number;
  /** Time spent waiting since `#since`, up to the last time a wait ended. */
  #waited = 0;
  #waitingSince: number | undefined;
  readonly #waits = new Set<string>();

  constructor(now: number, done: number) {
    this.#since = now;
    this.#from = done;
  }

  /** Starts counting again, from where it is, as after a pause. */
  restart(now: number, done: number): void {
    this.#since = now;
    this.#from = done;
    this.#waited = 0;
    if (this.#waitingSince !== undefined) this.#waitingSince = now;
  }

  /** It waits for this, or does not any more. Waits for several things at once count once. */
  wait(what: string, on: boolean, now: number): void {
    const before = this.#waits.size > 0;
    if (on) this.#waits.add(what);
    else this.#waits.delete(what);
    const after = this.#waits.size > 0;
    if (!before && after) this.#waitingSince = now;
    if (before && !after && this.#waitingSince !== undefined) {
      this.#waited += now - this.#waitingSince;
      this.#waitingSince = undefined;
    }
  }

  get waiting(): boolean {
    return this.#waits.size > 0;
  }

  /** Undefined until enough frames went by to go by. */
  remainingMs(now: number, done: number, total: number, after: number): number | undefined {
    const since = done - this.#from;
    if (since < after) return undefined;
    const waiting = this.#waitingSince === undefined ? 0 : now - this.#waitingSince;
    const spent = Math.max(now - this.#since - this.#waited - waiting, 0);
    return Math.round((spent / since) * (total - done));
  }
}
