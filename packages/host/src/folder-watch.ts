import type {
  ChangeRecordLike,
  DirectoryHandleLike,
  ObserverConstructor,
  ObserverLike,
} from "./handles.ts";
import {
  FolderError,
  type FileStat,
  type FolderChange,
  type FolderWatch,
  type WatchOptions,
} from "./index.ts";
import { isToolFolder, sameNameKey } from "./paths.ts";

export interface WatchTiming {
  /** How long it has to be quiet before changes are told: programs change several files at once. */
  readonly quietMs: number;
  /** How long changes wait at the most, however busy the folder is. */
  readonly longestMs: number;
  /** How often the folder gets looked at where the browser tells nothing. */
  readonly pollMs: number;
}

export const WATCH_TIMING: WatchTiming = { quietMs: 500, longestMs: 3000, pollMs: 10_000 };

/** How many files get looked at the same time. Each one is a call to the browser. */
const LOOK_AT_ONCE = 16;

/** What a file is like, or that there is none. */
export type Seen = FileStat | "absent";

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

export const isSameSeen = (a: Seen, b: Seen): boolean =>
  a === "absent" || b === "absent"
    ? a === b
    : a.size === b.size && a.lastModified === b.lastModified;

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

/**
 * Tells what changes in a folder. The browser tells about changes as they happen, and each one is
 * only a hint: whether a file changed is told by what it is like now against what it was like the
 * last time. A batch gets told once the folder is quiet for a moment.
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
  #timer: ReturnType<typeof setTimeout> | undefined;
  #since: number | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
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
      await this.#enqueue(() => this.#look(true));
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
      if (record.type === "errored") {
        void this.#enqueue(() => this.#watchAgain()).catch((error: unknown) => {
          console.warn("The folder could not be watched again", error);
        });
        continue;
      }
      // The browser lost track: only looking at everything again tells what happened.
      if (record.type === "unknown") {
        this.#everything = true;
        matters = true;
        continue;
      }
      const kind = record.changedHandle?.kind;
      matters = this.#note(record.relativePathComponents.join("/"), kind) || matters;
      const from = record.relativePathMovedFrom;
      if (record.type === "moved" && from) matters = this.#note(from.join("/"), kind) || matters;
    }
    if (matters) this.#schedule();
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
    const known = this.#spelling.get(key) ?? path;
    // Linux tells nothing about what comes or goes with a folder, and Chrome does not say what
    // kind of thing disappeared.
    const inside = kind !== "file";
    const { includes } = this.#options;
    const matters =
      this.#seen.has(known) ||
      includes(known, "file") ||
      (inside && (this.#within.has(key) || includes(known, "folder")));
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
    return this.#enqueue(() => this.#look(false));
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
    for (let end = key.lastIndexOf("/"); end > 0; end = key.lastIndexOf("/", end - 1)) {
      this.#within.add(key.slice(0, end));
    }
  }

  /** Looks at what was put to be looked at, or at everything, and tells what changed. */
  async #look(atStart: boolean): Promise<void> {
    const everything = atStart || this.#everything;
    const pending = [...this.#pending];
    this.#everything = false;
    this.#pending.clear();
    try {
      const paths = everything ? await this.#allPaths() : await this.#pathsOf(pending);
      // What a file is like halfway through a write means nothing: it gets looked at after.
      for (const path of paths) {
        if (!this.#folder.isWriting(path)) continue;
        paths.delete(path);
        this.#later.set(sameNameKey(path), path);
      }
      const found = await inTurns([...paths], LOOK_AT_ONCE, async (path) => ({
        path,
        file: await this.#folder.look(path),
      }));
      const changes: FolderChange[] = [];
      for (const { path, file } of found) {
        if (file === "unknown") continue;
        const now: Seen = file ? statOf(file) : "absent";
        const before = this.#seen.get(path);
        if (before === undefined ? now === "absent" : isSameSeen(before, now)) continue;
        this.#remember(path, now);
        if (!atStart) changes.push({ path, file });
      }
      if (changes.length > 0) await this.#tell(changes);
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

  async #tell(changes: readonly FolderChange[]): Promise<void> {
    try {
      await this.#options.onChange(changes);
    } catch (error) {
      console.warn("Changes in the folder could not be taken in", error);
    }
  }

  /**
   * The browser stopped watching, which is what it does when the folder itself goes away. A folder
   * that is still there gets watched again, and looked at, since nothing told what happened.
   */
  async #watchAgain(): Promise<void> {
    this.#observer?.disconnect();
    this.#observer = undefined;
    if (!(await this.#folder.isThere())) {
      this.#gone(new FolderError("gone", ""));
      return;
    }
    await this.#observe();
    this.#everything = true;
    await this.#look(false);
  }

  #gone(error: FolderError): void {
    if (this.#stopped) return;
    this.#options.onProblem?.(error);
    this.stop();
  }
}
