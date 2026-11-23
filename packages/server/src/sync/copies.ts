import { Worker } from "node:worker_threads";
import type {
  FileChange,
  Here,
  LateConflict,
  MergeConflict,
  PlatformBatch,
  UndoRecord,
} from "@animaquill/core";
import type { SyncRejection } from "@animaquill/host/sync";

/**
 * The working copies of projects live in a thread of their own, copy-worker.ts: what Yjs does with
 * a large update holds up that thread for a moment, never the API, and a thread that runs out of its
 * memory ends and starts again, while the API goes on. Everything the copies do is asked for here
 * and comes back as a promise.
 *
 * Copies count against a budget of memory, as `weightOf` estimates it from the bytes of a project
 * and its pieces (structs of Yjs, and the values inside of plain values), which take memory the bytes
 * do not show: what was not used the longest goes first, and comes back from the database the next
 * time it is needed, also a project that windows are connected to. Only what something is being done
 * with right now stays; where that leaves no room, a project does not open now (`CopiesFull`), rather
 * than the thread running out of memory. A person's projects get only a share of it, and no project
 * grows larger than one may be. The thread also says how much of its heap is in use, after each
 * thing it did: past `HEAP_HIGH` of it, what nothing is done with goes, whatever the estimates say.
 */

/** Memory of one struct of Yjs in a copy, and of one value inside of a plain value, about. */
const STRUCT_BYTES = 550;
const VALUE_BYTES = 80;
/** Part of the heap of the thread in use, after which the copies nothing is done with go. */
const HEAP_HIGH = 0.6;

/** The memory a copy takes, about, from its bytes as Yjs encodes them and its pieces. */
export const weightOf = (bytes: number, structs: number, values = 0): number =>
  2 * bytes + STRUCT_BYTES * structs + VALUE_BYTES * values;

/** What a copy says about its project. */
/** How much of the description of a project the platform keeps, for the card of the start page. */
export const DESCRIPTION_MOST = 300;

export interface CopyInfo {
  /** The id in its animaquill.json. */
  readonly projectId: string;
  readonly name: string;
  /** What it says about itself, cut short to `DESCRIPTION_MOST` characters: empty for nothing. */
  readonly description: string;
  readonly formatVersion: number;
  /** Pieces of the project in the copy, see `weightOf`. */
  readonly structs: number;
  readonly values: number;
}

/**
 * What a change that arrived late came to, see late-writes.ts of core: conflicts with what batches
 * of the platform wrote, and what the copy wrote itself after it, as the platform, where it brought
 * in again what a batch did (`fix`, of `fixed` batches).
 */
export interface Late {
  readonly conflicts: readonly LateConflict[];
  readonly fix?: { readonly delta: Uint8Array; readonly batches: readonly string[] };
  /** For a change made without a batch not watched any more: how many places it wrote. */
  readonly unknownPlaces?: number;
}

/** What became of an update. */
export type Taken =
  | {
      readonly kind: "taken";
      readonly delta: Uint8Array;
      readonly info: CopyInfo;
      readonly late?: Late;
    }
  | { readonly kind: "nothing"; readonly info: CopyInfo; readonly late?: Late }
  | {
      readonly kind: "refused";
      readonly reason: SyncRejection;
      readonly detail: string;
      /** The copy had taken it in, and went: it has to be opened again. */
      readonly dropped?: true;
    };

/** How a change came, for what it may not have had of the platform's own batches. */
export interface Arrival {
  /** An editor made it, so it may not write as the platform, see `checkUpdate`. */
  readonly fromEditor: boolean;
  /** The update of the platform its window had when it was made, see "push". */
  readonly base: number;
  /** What a window sends where the platform has less than it, which can be anything. */
  readonly repair: boolean;
  /** Which side stays where it and a batch it did not have changed the same thing. */
  readonly prefer?: "editor" | "github";
  /**
   * It may have been made without a batch the copy does not watch any more, see
   * `SyncLimits.batchesWatched`: the newest such batch, which it is then said of.
   */
  readonly unknown?: string;
}

/** A merge of files from GitHub into a copy, see `SyncHub.mergeRepo`. */
export interface MergeRequest {
  readonly changes: readonly FileChange[];
  /** Its id, which the origin and the batch of the platform go by. */
  readonly batch: string;
  readonly here: Here;
  /** Which side stays where both changed the same thing. */
  readonly prefer: "editor" | "github";
  /** The update of the platform it is to be, which windows that have it say they have. */
  readonly seq: number;
  /** How many of the newest batches the copy watches, see `SyncLimits.batchesWatched`. */
  readonly watched: number;
}

/** What came of a merge. */
export type Merged =
  | {
      readonly kind: "merged";
      /** What it changed, as one update: none where nothing changed. */
      readonly delta: Uint8Array | undefined;
      readonly info: CopyInfo;
      readonly files: readonly { readonly path: string; readonly status: string }[];
      /** Conflicts, `taken` where the copy took GitHub's side and the editor's went. */
      readonly conflicts: readonly (MergeConflict & { readonly taken?: true })[];
      /** Files that did not come in, and why, as the merge said. */
      /** `code`: why the whole round was refused, where it was, such as "project-locked". */
      readonly blocked: readonly {
        readonly path: string;
        readonly detail: string;
        readonly code?: string;
      }[];
      readonly batch: PlatformBatch;
      readonly undo: UndoRecord | undefined;
      /** How long it took, in milliseconds. */
      readonly ms: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly detail: string;
      /** The copy had written some of it, and went: it has to be opened again. */
      readonly dropped?: true;
    };

/**
 * A batch of the platform's own as the copy watches it, see late-writes.ts of core: one that was
 * taken back, or takes one back or does it again (`quiet`), says only what changes made without it
 * took away of theirs, never what they took away of it, and is never written again for them: what
 * it wrote is not what anybody wants any more, or only what was there before.
 */
export type WatchedBatch = PlatformBatch & { readonly quiet?: boolean };

/** Taking a batch of the platform's back as a whole, or doing it again, see `SyncHub.takeBack`. */
export interface TakeBackRequest {
  /** How, as the batch keeps it (`project_batches.undo`, an `UndoRecord` of core). */
  readonly record: unknown;
  readonly direction: "undo" | "redo";
  /** The batch it is taken back with, which is one of its own, and the update it is to be. */
  readonly batch: string;
  readonly seq: number;
  /** The batch taken back or done again: quiet from now on, see `WatchedBatch`. */
  readonly of: string;
  /** How many of the newest batches the copy watches, see `SyncLimits.batchesWatched`. */
  readonly watched: number;
  /** Only whether it could now, and whether all of it would stay: nothing is written. */
  readonly look?: boolean;
}

/**
 * Why a batch cannot be taken back or done again now, as the copy finds: there is no record of it
 * that this editor reads ("gone"), the project's format changed since ("format"), the copy is
 * another one than the batch went into, made again from the repository ("rebuilt"), it is not that
 * way round ("undone", "done"), nothing of it can go back as everything it wrote was changed
 * since or is in use ("changed", "inUse"), the project is locked ("locked"), or something else
 * ("failed").
 */
export type TakeBackWhy =
  "gone" | "format" | "rebuilt" | "undone" | "done" | "changed" | "inUse" | "locked" | "failed";

/** What came of taking a batch back, or doing it again. */
export type TakenBack =
  | {
      readonly kind: "taken";
      /** What it changed, as one update: none where nothing changed. */
      readonly delta: Uint8Array | undefined;
      readonly info: CopyInfo;
      readonly batch: PlatformBatch;
      /** How to take it back or do it again from now on: the record of the batch taken back. */
      readonly undo: UndoRecord | undefined;
      /** Where it went back, and where it stayed, as it was changed since (`obstacle`). */
      readonly back: readonly (readonly string[])[];
      readonly kept: readonly (readonly string[])[];
      readonly obstacle?: "changed" | "inUse";
    }
  /** It could, see `TakeBackRequest.look`. */
  | { readonly kind: "could" }
  | {
      readonly kind: "refused";
      readonly why: TakeBackWhy;
      readonly detail?: string;
      /** The copy had written some of it, and went: it has to be opened again. */
      readonly dropped?: true;
    };

export type CopyRequest = { readonly id: number } & (
  | {
      readonly op: "open";
      readonly project: string;
      readonly parts: readonly Uint8Array[];
      readonly projectId: string;
      /** The platform's batches whose changes made without them may come yet. */
      readonly batches: readonly WatchedBatch[];
    }
  | {
      readonly op: "create";
      readonly project: string;
      readonly state: Uint8Array;
      readonly projectId: string;
      readonly most: number;
    }
  | {
      readonly op: "apply";
      readonly project: string;
      readonly update: Uint8Array;
      readonly most: number;
      readonly arrival: Arrival;
    }
  | {
      readonly op: "merge";
      readonly project: string;
      readonly merge: MergeRequest;
    }
  | {
      readonly op: "takeBack";
      readonly project: string;
      readonly takeBack: TakeBackRequest;
    }
  | {
      readonly op: "without";
      readonly parts: readonly Uint8Array[];
      readonly paths: readonly (readonly string[])[];
    }
  | { readonly op: "vector" | "deletions" | "encode" | "drop"; readonly project: string }
);

export type CopyResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
      /** Bytes of the heap of the thread in use, afterwards. */
      readonly heap: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

type Ask = CopyRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** No room for a project now: the memory of the copies is taken by what is in use. */
export class CopiesFull extends Error {
  override readonly name = "CopiesFull";
  /** Whether it is the person's own projects that take their share. */
  readonly isOwn: boolean;
  constructor(isOwn: boolean) {
    super(isOwn ? "the person's projects take their share" : "no room for another project");
    this.isOwn = isOwn;
  }
}

/** The thread went away while it worked on this, most likely out of memory. */
export class CopiesGone extends Error {
  override readonly name = "CopiesGone";
  /** Whether this was what it worked on when it went. */
  readonly running: boolean;
  constructor(running: boolean) {
    super("the thread of the working copies went away");
    this.running = running;
  }
}

export interface CopiesOptions {
  /** The heap of the thread, in MB: past it, the thread ends. */
  readonly heapMb: number;
  /** Memory the copies may take together, as `weightOf` estimates it... */
  readonly budget: number;
  /** ...the projects in use of one person... */
  readonly perPerson: number;
  /** ...and one project. */
  readonly perProject: number;
  /**
   * Bytes of the heap of the thread in use past which the copies nothing is done with go: by default
   * `HEAP_HIGH` of `heapMb`. Tests say where, so that they do not depend on what the heap is.
   */
  readonly heapHigh?: number;
  /** Projects that something is being done with now: they stay, see `HEAP_HIGH`. */
  readonly busy?: () => ReadonlySet<string>;
  readonly log: { warn(object: object, message?: string): void };
}

interface Open {
  /** Which thread opened it: copies of a thread that went are gone. */
  readonly thread: number;
  readonly owner: string;
  bytes: number;
  structs: number;
  values: number;
  used: number;
}

const weightOfOpen = (open: Open) => weightOf(open.bytes, open.structs, open.values);

export class WorkingCopies {
  readonly #options: CopiesOptions;
  #worker: Worker | undefined;
  #thread = 0;
  #next = 1;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  readonly #open = new Map<string, Open>();
  /** What each project weighed the last time it was open, to make room for it the next time. */
  readonly #weights = new Map<string, number>();
  /** Bytes of the heap of the thread in use, as it last said. */
  #heap = 0;
  #stopped = false;

  constructor(options: CopiesOptions) {
    // A project as large as one may be has to open, or its windows would come back for ever.
    this.#options = { ...options, perPerson: Math.max(options.perPerson, options.perProject) };
  }

  /** Whether a project is open in the thread as it is now. */
  isOpen(project: string): boolean {
    return this.#open.get(project)?.thread === this.#thread && this.#worker !== undefined;
  }

  /** The memory the open copies take, about, see `weightOf`. */
  get openWeight(): number {
    let total = 0;
    for (const open of this.#open.values()) {
      if (open.thread === this.#thread) total += weightOfOpen(open);
    }
    return total;
  }

  /** Bytes of the heap of the thread in use, as it last said. */
  get heap(): number {
    return this.#heap;
  }

  /**
   * A project, from these updates, after making room for it: as much as it took the last time, or
   * about as much as its bytes. Rejects with `CopiesFull` where there is none.
   */
  async open(
    project: string,
    parts: readonly Uint8Array[],
    projectId: string,
    bytes: number,
    owner: string,
    keep: ReadonlySet<string>,
    batches: readonly WatchedBatch[] = [],
  ): Promise<CopyInfo> {
    await this.#makeRoom(project, owner, this.#weights.get(project) ?? weightOf(bytes, 0), keep);
    const info = (await this.#ask({ op: "open", project, parts, projectId, batches })) as CopyInfo;
    this.#opened(project, owner, bytes, info);
    await this.#settle(project, owner, keep);
    return info;
  }

  async create(
    project: string,
    state: Uint8Array,
    projectId: string,
    owner: string,
    most: number,
    keep: ReadonlySet<string>,
  ): Promise<Taken> {
    await this.#makeRoom(project, owner, weightOf(state.length, 0), keep);
    const taken = (await this.#ask({ op: "create", project, state, projectId, most })) as Taken;
    if (taken.kind !== "taken") return taken;
    const { structs, values } = taken.info;
    if (weightOf(state.length, structs, values) > this.#options.perProject) {
      await this.drop(project);
      return { kind: "refused", reason: "too-large", detail: "more than a project may be" };
    }
    this.#opened(project, owner, state.length, taken.info);
    await this.#settle(project, owner, keep);
    return taken;
  }

  /** A change of an open project: also turned away where it makes the project more than it may be. */
  async apply(
    project: string,
    update: Uint8Array,
    most: number,
    arrival: Arrival = { fromEditor: false, base: Number.MAX_SAFE_INTEGER, repair: false },
  ): Promise<Taken> {
    this.#use(project);
    const taken = (await this.#ask({ op: "apply", project, update, most, arrival })) as Taken;
    if (taken.kind === "refused" && taken.dropped) this.#open.delete(project);
    if (taken.kind !== "taken") return taken;
    const open = this.#open.get(project);
    if (!open) return taken;
    const bytes = open.bytes + taken.delta.length + (taken.late?.fix?.delta.length ?? 0);
    const { structs, values } = taken.info;
    if (weightOf(bytes, structs, values) > this.#options.perProject) {
      await this.drop(project);
      return {
        kind: "refused",
        reason: "too-large",
        detail: "more than a project may be",
        dropped: true,
      };
    }
    Object.assign(open, { bytes, structs, values });
    this.#weights.set(project, weightOfOpen(open));
    return taken;
  }

  /**
   * Merges files from GitHub into an open project, as the platform (see copy-worker.ts): also
   * turned away where it makes the project more than it may be, which drops the copy.
   */
  async merge(project: string, merge: MergeRequest): Promise<Merged> {
    this.#use(project);
    const merged = (await this.#ask({ op: "merge", project, merge })) as Merged;
    if (merged.kind === "refused") {
      if (merged.dropped) this.#open.delete(project);
      return merged;
    }
    const open = this.#open.get(project);
    if (!open || !merged.delta) return merged;
    const bytes = open.bytes + merged.delta.length;
    const { structs, values } = merged.info;
    if (weightOf(bytes, structs, values) > this.#options.perProject) {
      await this.drop(project);
      return {
        kind: "refused",
        reason: "too-large",
        detail: "more than a project may be",
        dropped: true,
      };
    }
    Object.assign(open, { bytes, structs, values });
    this.#weights.set(project, weightOfOpen(open));
    return merged;
  }

  /**
   * Takes a batch of the platform's back as a whole in an open project, or does it again, as the
   * platform (see copy-worker.ts): also turned away where it makes the project more than it may be,
   * which drops the copy.
   */
  async takeBack(project: string, takeBack: TakeBackRequest): Promise<TakenBack> {
    this.#use(project);
    const taken = (await this.#ask({ op: "takeBack", project, takeBack })) as TakenBack;
    if (taken.kind === "refused") {
      if (taken.dropped) this.#open.delete(project);
      return taken;
    }
    const open = this.#open.get(project);
    if (taken.kind !== "taken" || !open || !taken.delta) return taken;
    const bytes = open.bytes + taken.delta.length;
    const { structs, values } = taken.info;
    if (weightOf(bytes, structs, values) > this.#options.perProject) {
      await this.drop(project);
      return {
        kind: "refused",
        why: "failed",
        detail: "more than a project may be",
        dropped: true,
      };
    }
    Object.assign(open, { bytes, structs, values });
    this.#weights.set(project, weightOfOpen(open));
    return taken;
  }

  /**
   * The values at some paths of a project as it would be from these updates, see `valuesWithout`
   * of core: in the thread of the copies, as reading a whole project takes long.
   */
  async without(
    parts: readonly Uint8Array[],
    paths: readonly (readonly string[])[],
  ): Promise<{ readonly values: readonly unknown[]; readonly whole: boolean }> {
    return (await this.#ask({ op: "without", parts, paths })) as {
      values: unknown[];
      whole: boolean;
    };
  }

  /** The project has grown, or got smaller, as its snapshot says. */
  resize(project: string, bytes: number): void {
    const open = this.#open.get(project);
    if (!open) return;
    open.bytes = bytes;
    this.#weights.set(project, weightOfOpen(open));
  }

  #opened(project: string, owner: string, bytes: number, info: CopyInfo): void {
    const { structs, values } = info;
    const open = { thread: this.#thread, owner, bytes, structs, values, used: Date.now() };
    this.#open.set(project, open);
    this.#weights.set(project, weightOfOpen(open));
    // Not a list of every project there ever was.
    if (this.#weights.size > 10_000) {
      for (const known of this.#weights.keys()) {
        if (!this.#open.has(known)) this.#weights.delete(known);
        if (this.#weights.size <= 5000) break;
      }
    }
  }

  async stateVector(project: string): Promise<Uint8Array> {
    this.#use(project);
    return (await this.#ask({ op: "vector", project })) as Uint8Array;
  }

  async deletions(project: string): Promise<Uint8Array> {
    this.#use(project);
    return (await this.#ask({ op: "deletions", project })) as Uint8Array;
  }

  async encode(project: string): Promise<Uint8Array> {
    this.#use(project);
    return (await this.#ask({ op: "encode", project })) as Uint8Array;
  }

  /** Closes a project: it comes back from the database the next time. */
  async drop(project: string): Promise<void> {
    this.#open.delete(project);
    if (this.#worker) await this.#ask({ op: "drop", project }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#open.clear();
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of waiting) reject(new CopiesGone(false));
    await worker?.terminate();
  }

  #use(project: string): void {
    const open = this.#open.get(project);
    if (open) open.used = Date.now();
  }

  /** What the person's other projects in use weigh, see `weightOf`. */
  #ownWeight(project: string, owner: string, keep: ReadonlySet<string>): number {
    let own = 0;
    for (const [other, open] of this.#open) {
      if (other === project || open.thread !== this.#thread || open.owner !== owner) continue;
      if (keep.has(other)) own += weightOfOpen(open);
    }
    return own;
  }

  /**
   * Makes room for `weight` more, before `project` opens: closes what was used the longest ago, but
   * nothing in `keep`. Rejects with `CopiesFull` where what is in use leaves none, or would leave the
   * person more than their share. `weight` is what the project took the last time, or what its bytes
   * say: what it really takes is known once it is open, see `#settle`.
   */
  async #makeRoom(
    project: string,
    owner: string,
    weight: number,
    keep: ReadonlySet<string>,
  ): Promise<void> {
    if (this.#ownWeight(project, owner, keep) + weight > this.#options.perPerson) {
      throw new CopiesFull(true);
    }
    await this.#evict(project, weight, keep);
    if (this.openWeight + weight > this.#options.budget) throw new CopiesFull(false);
  }

  /** Closes what was used the longest ago, but nothing in `keep`, until `weight` more fit. */
  async #evict(project: string, weight: number, keep: ReadonlySet<string>): Promise<void> {
    const candidates = [...this.#open.entries()]
      .filter(
        ([other, open]) => other !== project && open.thread === this.#thread && !keep.has(other),
      )
      .toSorted(([, a], [, b]) => a.used - b.used);
    for (const [other] of candidates) {
      if (this.openWeight + weight <= this.#options.budget) return;
      await this.drop(other);
    }
  }

  /**
   * Once `project` is open and what it takes is known: makes room for it, or closes it again where
   * there is none after all, as `#makeRoom` would have known.
   */
  async #settle(project: string, owner: string, keep: ReadonlySet<string>): Promise<void> {
    const open = this.#open.get(project);
    if (!open) return;
    const weight = weightOfOpen(open);
    const isOwn = this.#ownWeight(project, owner, keep) + weight > this.#options.perPerson;
    if (!isOwn) await this.#evict(project, 0, keep);
    if (isOwn || this.openWeight > this.#options.budget) {
      await this.drop(project);
      throw new CopiesFull(isOwn);
    }
  }

  /** Closes every copy that nothing is being done with, the ones used the longest ago first. */
  async #lighten(): Promise<void> {
    const busy = this.#options.busy?.() ?? new Set<string>();
    const idle = [...this.#open.entries()]
      .filter(([project, open]) => open.thread === this.#thread && !busy.has(project))
      .toSorted(([, a], [, b]) => a.used - b.used);
    for (const [project] of idle) await this.drop(project);
  }

  #workerNow(): Worker {
    if (this.#stopped) throw new CopiesGone(false);
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./copy-worker.ts", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: this.#options.heapMb },
    });
    this.#thread += 1;
    const thread = this.#thread;
    worker.on("message", (response: CopyResponse) => {
      const waiting = this.#pending.get(response.id);
      if (!waiting) return;
      this.#pending.delete(response.id);
      if (response.ok) {
        this.#heap = response.heap;
        waiting.resolve(response.result);
        // Past the high water, what nothing is being done with goes, as far as it is not on its
        // way to the thread already.
        const high = this.#options.heapHigh ?? HEAP_HIGH * this.#options.heapMb * 1024 * 1024;
        if (this.#heap > high) void this.#lighten();
      } else waiting.reject(new Error(response.error));
    });
    const gone = (why: unknown) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      if (!this.#stopped) {
        this.#options.log.warn(
          {
            err:
              why instanceof Error
                ? { name: why.name, message: why.message }
                : { message: String(why) },
            thread,
          },
          "the working copies start again",
        );
      }
      // The thread works on one thing at a time, in order: the oldest is what it was at.
      const waiting = [...this.#pending.entries()].toSorted(([a], [b]) => a - b);
      this.#pending.clear();
      waiting.forEach(([, { reject }], index) => reject(new CopiesGone(index === 0)));
    };
    worker.on("error", gone);
    worker.on("exit", (code) => gone(new Error(`exit ${code}`)));
    worker.unref();
    this.#worker = worker;
    return worker;
  }

  #ask(ask: Ask): Promise<unknown> {
    const worker = this.#workerNow();
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
      worker.postMessage({ ...ask, id } as CopyRequest);
    });
  }
}
