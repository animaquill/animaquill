import type {
  ChangeRecordLike,
  DirectoryHandleLike,
  ObserverConstructor,
  ObserverLike,
} from "./handles.ts";
import {
  FolderError,
  type FileStat,
  type FolderBatch,
  type FolderChange,
  type FolderWatch,
  type WatchOptions,
} from "./index.ts";
import { isToolFolder, sameNameKey } from "./paths.ts";

export interface WatchTiming {
  /** How long it has to be quiet before changes are told: programs change several files at once. */
  readonly quietMs: number;
  /**
   * How long changes wait at the most while the folder keeps changing, such as during a long
   * checkout. What gets told then says that the folder is still changing.
   */
  readonly longestMs: number;
  /** How often the folder gets looked at where the browser tells nothing. */
  readonly pollMs: number;
  /** How long a file that could not be looked at waits for the next try, at first. That doubles. */
  readonly retryMs: number;
}

export const WATCH_TIMING: WatchTiming = {
  quietMs: 500,
  longestMs: 30_000,
  pollMs: 10_000,
  retryMs: 1000,
};

/** How many files get looked at the same time. Each one is a call to the browser. */
const LOOK_AT_ONCE = 16;
/**
 * Files up to this size are told apart by what is in them where their size and time are the same,
 * as documents are. Media files are larger, and only their size and time count.
 */
export const HASHED_BYTES = 4 * 1024 * 1024;
/** Tries again do not wait longer than this. */
const LONGEST_RETRY_MS = 30_000;
/** How long what `files` gave is good for telling which changes matter, as they come in. */
const NAMED_FOR_MS = 100;

/** What a file is like: its size and time, and what is in it for a small one. Or that it is not. */
export type Seen = (FileStat & { readonly hash?: string | undefined }) | "absent";

/** What a watch needs of the folder it watches. */
export interface WatchedFolder {
  readonly root: DirectoryHandleLike;
  /**
   * The file at a path now, undefined when there is none, "unknown" when that cannot be told right
   * now. Rejects with a `FolderError` when the folder cannot be looked at.
   */
  look(path: string): Promise<File | undefined | "unknown">;
  /** The files in a folder that matter, and in the folders in it that do. */
  list(folder: string, includes: WatchOptions["includes"]): AsyncIterable<string>;
  isThere(): Promise<boolean>;
  /** Whether the folder is writing this file right now. */
  isWriting(path: string): boolean;
  /**
   * How many times the folder started or finished writing this file, so that a look can tell that
   * a write of its own came in between.
   */
  writes(path: string): number;
}

export interface WatchEnvironment {
  readonly Observer?: ObserverConstructor | undefined;
  /** Calls back when the window comes to the front again. Returns how to stop. */
  readonly onFront: (listener: () => void) => () => void;
  readonly isHidden: () => boolean;
  readonly timing?: Partial<WatchTiming> | undefined;
}

export const statOf = (file: FileStat): FileStat => ({
  size: file.size,
  lastModified: file.lastModified,
});

/** Whether size and time are the same. What is in a file tells more, see `hashOf`. */
export const isSameSeen = (a: Seen, b: Seen): boolean =>
  a === "absent" || b === "absent"
    ? a === b
    : a.size === b.size && a.lastModified === b.lastModified;

/**
 * What a file has in it, in 64 bits, for telling it apart from one of the same size and time. It
 * keeps no secret, and it is quick: a few milliseconds for a document. On the page right away, so
 * that nothing waits for anything else to get to it.
 */
export function hashOf(bytes: Uint8Array): string {
  let high = 0xdeadbeef ^ bytes.length;
  let low = 0x41c6ce57 ^ bytes.length;
  for (const byte of bytes) {
    high = Math.imul(high ^ byte, 2_654_435_761);
    low = Math.imul(low ^ byte, 1_597_334_677);
  }
  high =
    Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
  low =
    Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `${hex(high)}${hex(low)}`;
}

/** Runs `work` on every item, `limit` at a time, and resolves to the results in their order. */
export async function inTurns<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The files that `files` gives, by `sameNameKey`, and the folders on the way to them. */
interface Named {
  readonly at: number;
  readonly files: ReadonlyMap<string, string>;
  readonly within: ReadonlySet<string>;
}

const foldersOn = (key: string): string[] => {
  const found: string[] = [];
  for (let end = key.lastIndexOf("/"); end > 0; end = key.lastIndexOf("/", end - 1)) {
    found.push(key.slice(0, end));
  }
  return found;
};

/** What a look found of a file, before it is compared with what was seen. */
type Found =
  | { readonly path: string; readonly writes: number; readonly file: File | undefined | "unknown" }
  | { readonly path: string; readonly writes: number; readonly file: "writing" };

/**
 * Tells what changes in a folder. The browser tells about changes as they happen, and each one is
 * only a hint: whether a file changed is told by what it is like now against what it was like the
 * last time, and by what is in it where the browser told about it and nothing else differs. A batch
 * gets told once the folder is quiet for a moment.
 */
export class FolderWatcher implements FolderWatch {
  readonly ready: Promise<void>;
  readonly #folder: WatchedFolder;
  readonly #options: WatchOptions;
  readonly #environment: WatchEnvironment;
  readonly #timing: WatchTiming;
  readonly #onStop: () => void;
  /** What files were like the last time: as told, as written by the folder, or at the start. */
  readonly #seen = new Map<string, Seen>();
  /** The paths that were seen, by `sameNameKey`, for a browser that names them another way. */
  readonly #spelling = new Map<string, string>();
  /** The folders on the way to them, by `sameNameKey`. */
  readonly #within = new Set<string>();
  /** Paths to look at, and whether at what is in them too. */
  readonly #pending = new Map<string, boolean>();
  #everything = false;
  /** Files that were being written when they were to be looked at, by `sameNameKey`. */
  readonly #later = new Map<string, string>();
  #named: Named | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #since: number | undefined;
  /** When the browser last told about something that matters. */
  #lastTold: number | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retries = 0;
  #observer: ObserverLike | undefined;
  #stopFront: (() => void) | undefined;
  #work: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(
    folder: WatchedFolder,
    options: WatchOptions,
    environment: WatchEnvironment,
    onStop: () => void,
  ) {
    this.#folder = folder;
    this.#options = options;
    this.#environment = environment;
    this.#timing = { ...WATCH_TIMING, ...environment.timing };
    this.#onStop = onStop;
    this.ready = this.#start();
    // Whoever does not wait for it hears about it from `onProblem` too.
    this.ready.catch(() => {});
  }

  rescan(): Promise<void> {
    this.#everything = true;
    return this.#run();
  }

  flush(): Promise<void> {
    return this.#run();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
    clearInterval(this.#poll);
    this.#observer?.disconnect();
    this.#stopFront?.();
    this.#onStop();
  }

  /** The folder wrote this file itself, which is no change to tell. */
  wrote(path: string, seen: Seen): void {
    this.#remember(path, seen);
  }

  /** A write of the folder is over, whatever came of it. */
  doneWriting(path: string): void {
    const key = sameNameKey(path);
    const later = this.#later.get(key);
    if (later === undefined) return;
    this.#later.delete(key);
    this.#pending.set(later, this.#pending.get(later) ?? false);
    this.#schedule();
  }

  async #start(): Promise<void> {
    this.#stopFront = this.#environment.onFront(() => this.#lookAgain());
    await this.#observe();
    if (this.#stopped) return;
    try {
      await this.#enqueue(() => this.#look(true, false));
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** Has the browser tell about changes, or else looks every so often. */
  async #observe(): Promise<void> {
    const { Observer } = this.#environment;
    if (Observer) {
      let observer: ObserverLike | undefined;
      try {
        observer = new Observer((records) => this.#take(records));
        await observer.observe(this.#folder.root, { recursive: true });
        if (this.#stopped) observer.disconnect();
        else this.#observer = observer;
        return;
      } catch (error) {
        observer?.disconnect();
        console.warn("The browser does not tell about changes in this folder", error);
      }
    }
    if (this.#stopped || this.#poll !== undefined) return;
    this.#poll = setInterval(() => {
      if (!this.#environment.isHidden()) this.#lookAgain();
    }, this.#timing.pollMs);
  }

  #lookAgain(): void {
    this.#everything = true;
    this.#schedule();
  }

  #take(records: readonly ChangeRecordLike[]): void {
    if (this.#stopped) return;
    let matters = false;
    for (const record of records) {
      const path = record.relativePathComponents.join("/");
      // The folder itself went, or the browser stopped watching it. What is at its place now may
      // be another folder, and only whoever opened it can tell that, by what is in it.
      const isGone =
        record.type === "errored" ||
        (path === "" && (record.type === "disappeared" || record.type === "moved"));
      if (isGone) {
        this.#gone(new FolderError("gone", ""));
        return;
      }
      // The browser lost track: only looking at everything again tells what happened.
      if (record.type === "unknown") {
        this.#everything = true;
        matters = true;
        continue;
      }
      const kind = record.changedHandle?.kind;
      matters = this.#note(path, kind) || matters;
      const from = record.relativePathMovedFrom;
      if (record.type === "moved" && from) matters = this.#note(from.join("/"), kind) || matters;
    }
    if (!matters) return;
    this.#lastTold = Date.now();
    this.#schedule();
  }

  /** What `files` gives, which is asked for again once in a while as changes come in. */
  #namedNow(): Named {
    const now = Date.now();
    if (this.#named && now - this.#named.at < NAMED_FOR_MS) return this.#named;
    const files = new Map<string, string>();
    const within = new Set<string>();
    for (const path of this.#options.files?.() ?? []) {
      const key = sameNameKey(path);
      files.set(key, path);
      for (const folder of foldersOn(key)) within.add(folder);
    }
    this.#named = { at: now, files, within };
    return this.#named;
  }

  /** Puts a path to be looked at, as far as it matters. Resolves to whether it did. */
  #note(path: string, kind: "file" | "directory" | undefined): boolean {
    // The folder itself, as before it goes away.
    if (path === "") {
      this.#everything = true;
      return true;
    }
    if (path.split("/").some(isToolFolder)) return false;
    const key = sameNameKey(path);
    const named = this.#namedNow();
    const known = this.#spelling.get(key) ?? named.files.get(key) ?? path;
    // Linux tells nothing about what comes or goes with a folder, and Chrome does not say what
    // kind of thing disappeared.
    const inside = kind !== "file";
    const { includes } = this.#options;
    const matters =
      this.#seen.has(known) ||
      named.files.has(key) ||
      includes(known, "file") ||
      (inside && (this.#within.has(key) || named.within.has(key) || includes(known, "folder")));
    if (matters) this.#pending.set(known, inside || (this.#pending.get(known) ?? false));
    return matters;
  }

  #schedule(): void {
    if (this.#stopped || (!this.#everything && this.#pending.size === 0)) return;
    const now = Date.now();
    this.#since ??= now;
    clearTimeout(this.#timer);
    const wait = Math.min(this.#timing.quietMs, this.#since + this.#timing.longestMs - now);
    this.#timer = setTimeout(() => void this.#run().catch(() => {}), Math.max(0, wait));
  }

  #run(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#since = undefined;
    // Told before the folder got quiet: whoever takes it in may want to wait for the rest.
    const stillChanging =
      this.#lastTold !== undefined && Date.now() - this.#lastTold < this.#timing.quietMs;
    return this.#enqueue(() => this.#look(false, stillChanging));
  }

  /** One thing at a time, in order, so that changes get told in the order they were found. */
  #enqueue(work: () => Promise<void>): Promise<void> {
    const done = this.#work.then(() => (this.#stopped ? undefined : work()));
    this.#work = done.catch(() => {});
    return done;
  }

  #remember(path: string, seen: Seen): void {
    const key = sameNameKey(path);
    // One file, also where the browser or the project write its name another way.
    const known = this.#spelling.get(key) ?? path;
    this.#seen.set(known, seen);
    this.#spelling.set(key, known);
    for (const folder of foldersOn(key)) this.#within.add(folder);
  }

  /** To be looked at again soon, as one that a write of the folder came in between. */
  #again(path: string): void {
    if (this.#folder.isWriting(path)) this.#later.set(sameNameKey(path), path);
    else this.#pending.set(path, this.#pending.get(path) ?? false);
  }

  /** A file that could not be looked at gets looked at later, and later the more often. */
  #retryLater(): void {
    if (this.#stopped || this.#retry !== undefined) return;
    const wait = Math.min(LONGEST_RETRY_MS, this.#timing.retryMs * 2 ** this.#retries);
    this.#retries += 1;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#run().catch(() => {});
    }, wait);
  }

  /** Looks at what was put to be looked at, or at everything, and tells what changed. */
  async #look(atStart: boolean, stillChanging: boolean): Promise<void> {
    const everything = atStart || this.#everything;
    const pending = [...this.#pending];
    this.#everything = false;
    this.#pending.clear();
    try {
      // What the browser told about. Where only what is in a file changed, these get read.
      const told = new Set(pending.map(([path]) => path));
      const paths = await this.#pathsOf(pending);
      if (everything) for (const path of await this.#allPaths()) paths.add(path);
      const looked = await inTurns([...paths], LOOK_AT_ONCE, async (path): Promise<Found> => {
        const writes = this.#folder.writes(path);
        // What a file is like halfway through a write means nothing: it gets looked at after.
        if (this.#folder.isWriting(path)) return { path, writes, file: "writing" };
        return { path, writes, file: await this.#folder.look(path) };
      });
      /** A change found, with how many writes of the folder there were when it was looked at. */
      interface Change {
        readonly path: string;
        readonly writes: number;
        readonly file: File | undefined;
        readonly now: Seen;
        readonly before: Seen | undefined;
      }
      /** A file to read, to tell by what is in it whether it changed. */
      interface ToRead {
        readonly path: string;
        readonly writes: number;
        readonly file: File;
        readonly now: FileStat;
        readonly before: Seen | undefined;
      }
      const changed: Change[] = [];
      const toRead: ToRead[] = [];
      let unknown = false;
      for (const { path, writes, file } of looked) {
        if (file === "writing") {
          this.#later.set(sameNameKey(path), path);
          continue;
        }
        // A write of the folder came in between: what this saw may be from before it.
        if (this.#folder.writes(path) !== writes) {
          this.#again(path);
          continue;
        }
        if (file === "unknown") {
          unknown = true;
          this.#pending.set(path, this.#pending.get(path) ?? false);
          continue;
        }
        const now: Seen = file ? statOf(file) : "absent";
        const before = this.#seen.get(path);
        const isSame = before === undefined ? now === "absent" : isSameSeen(before, now);
        // What a small file has in it says whether it changed. Where size and time are the same,
        // that is worth reading only where the browser told about it.
        const hadHash = before !== undefined && before !== "absent" && before.hash !== undefined;
        const canRead =
          file !== undefined &&
          file.size <= HASHED_BYTES &&
          (!isSame || (hadHash && told.has(path)));
        if (canRead) toRead.push({ path, writes, file, now: statOf(file), before });
        else if (!isSame) changed.push({ path, writes, file, now, before });
      }
      const read = await inTurns(toRead, LOOK_AT_ONCE, async (item) => {
        try {
          return { ...item, hash: hashOf(new Uint8Array(await item.file.arrayBuffer())) };
        } catch {
          // It changed again while it was read: the next look tells.
          return { ...item, hash: undefined };
        }
      });
      for (const item of read) {
        if (item.hash === undefined) {
          this.#again(item.path);
          continue;
        }
        changed.push({ ...item, now: { ...item.now, hash: item.hash } });
      }
      const changes: FolderChange[] = [];
      for (const { path, writes, file, now, before } of changed) {
        // Once more: a write of the folder can have come in while the files were read.
        if (this.#folder.writes(path) !== writes || this.#folder.isWriting(path)) {
          this.#again(path);
          continue;
        }
        this.#remember(path, now);
        // The same as before, with a new time: nothing to tell, unless that is something.
        const isSameContent =
          before !== undefined &&
          before !== "absent" &&
          now !== "absent" &&
          before.hash !== undefined &&
          before.hash === now.hash &&
          before.size === now.size;
        const isNewTime =
          before !== undefined &&
          before !== "absent" &&
          now !== "absent" &&
          before.lastModified !== now.lastModified;
        const tells = !isSameContent || (this.#options.newTimes === true && isNewTime);
        if (!atStart && tells) changes.push({ path, file });
      }
      if (unknown) this.#retryLater();
      else this.#retries = 0;
      if (this.#pending.size > 0 && !unknown) this.#schedule();
      if (changes.length > 0) await this.#tell(changes, { stillChanging });
    } catch (error) {
      if (!(error instanceof FolderError)) throw error;
      // None of it was looked at, so all of it is still to be looked at, the next time.
      if (everything) this.#everything = true;
      for (const [path, inside] of pending) this.#pending.set(path, inside);
      if (error.reason === "gone") this.#gone(error);
      else this.#options.onProblem?.(error);
      if (atStart) throw error;
    }
  }

  /** Everything that matters: what was seen, the files people named, and what is in folders. */
  async #allPaths(): Promise<Set<string>> {
    const { includes, files } = this.#options;
    const named = new Set(files?.() ?? []);
    const paths = new Set(named);
    for (const path of this.#seen.keys()) {
      if (named.has(path) || includes(path, "file")) paths.add(path);
      else this.#seen.delete(path);
    }
    for await (const path of this.#folder.list("", includes)) paths.add(path);
    return paths;
  }

  /** The files to look at for what the browser told: a file, or what is in a folder. */
  async #pathsOf(pending: readonly (readonly [string, boolean])[]): Promise<Set<string>> {
    const { includes, files } = this.#options;
    const named = new Set(files?.() ?? []);
    const paths = new Set<string>();
    for (const [path, inside] of pending) {
      if (this.#seen.has(path) || named.has(path) || includes(path, "file")) paths.add(path);
      if (!inside) continue;
      const prefix = `${sameNameKey(path)}/`;
      for (const known of [...this.#seen.keys(), ...named]) {
        if (sameNameKey(known).startsWith(prefix)) paths.add(known);
      }
      if (includes(path, "folder")) {
        for await (const found of this.#folder.list(path, includes)) paths.add(found);
      }
    }
    return paths;
  }

  async #tell(changes: readonly FolderChange[], batch: FolderBatch): Promise<void> {
    try {
      await this.#options.onChange(changes, batch);
    } catch (error) {
      console.warn("Changes in the folder could not be taken in", error);
    }
  }

  #gone(error: FolderError): void {
    if (this.#stopped) return;
    this.#options.onProblem?.(error);
    this.stop();
  }
}
