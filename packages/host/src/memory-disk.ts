import { chromeRefuses, isRefusedByChrome } from "./chrome-names.ts";
import { memoryRecordStore } from "./folder-records.ts";
import type { WatchTiming } from "./folder-watch.ts";
import type {
  ChangeRecordLike,
  CreateWritableOptions,
  DirectoryHandleLike,
  FileHandleLike,
  HandleLike,
  ObserverConstructor,
  ObserverLike,
  PermissionMode,
} from "./handles.ts";
import type { LocalFolders } from "./index.ts";
import {
  createLocalFolders,
  type LocalFoldersEnvironment,
  type RecordStore,
} from "./local-folders.ts";

/**
 * For tests: a disk in memory that behaves like a real one does to a page in Chrome, with what goes
 * wrong there. Other programs change it, the browser misses changes, writes fail halfway, people
 * allow and refuse, folders go away. Paths are from the top of the disk, with forward slashes.
 *
 * What it does was measured on Chrome 157 on Linux and Edge 158 on Windows, 2026-11-08: a write goes
 * to "<name>.crswap" next to the file first and takes its place on closing, an exclusive writer keeps
 * every other one out, `move` replaces what is at the new place without a word, a file that was read
 * cannot be read any more once the file changed, the browser tells about changes one at a time and
 * also about its own, and nothing about temporary files.
 */

type Bytes = Uint8Array<ArrayBuffer>;

interface FileNode {
  readonly kind: "file";
  name: string;
  content: Bytes;
  lastModified: number;
  /** Goes up with every change, so that a file that was read can tell that it is not the same. */
  version: number;
  /** The writer that keeps all others out, or how many writers keep only that one out. */
  lock: "exclusive" | number;
}

interface FolderNode {
  readonly kind: "directory";
  name: string;
  /** By the key of their names, see `DiskState.key`. */
  readonly entries: Map<string, Entry>;
}

type Entry = FileNode | FolderNode;
type Names = readonly string[];

export interface MemoryDiskOptions {
  /**
   * The system of the computer. On Windows case does not matter, Chrome refuses short names such as
   * "a~b.txt", and a path can have 260 characters at the most. Windows by default, which is where
   * most people are.
   */
  readonly system?: "windows" | "linux";
  /** How long the path to the top of this disk is, which counts for those 260 characters. */
  readonly depth?: number;
}

/** What a write that goes wrong does. */
export interface WriteFailure {
  /** The name of the error, as the browser names it. "QuotaExceededError" by default. */
  readonly name?: string;
  /** How many bytes arrive before it fails. */
  readonly afterBytes?: number;
  /** Fails as the file is about to take its place instead, with all of it written. */
  readonly atClose?: boolean;
  /** How many writes fail. */
  readonly times?: number;
}

interface ChangeOptions {
  /** The browser does not tell about it, as it sometimes does not on Linux. */
  readonly quietly?: boolean;
}

interface Writer {
  readonly target: Names;
  readonly swap: Names;
  readonly node: FileNode;
  readonly exclusive: boolean;
  /** The page went away while it was writing. */
  dead: boolean;
}

interface Observation {
  readonly observer: { deliver(records: readonly ChangeRecordLike[]): void };
  /** Keys of the folder that is watched. */
  readonly keys: Names;
  readonly recursive: boolean;
}

const failure = (name: string, message: string) => new DOMException(message, name);
const notFound = () =>
  failure(
    "NotFoundError",
    "A requested file or directory could not be found at the time an operation was processed.",
  );
const encoder = new TextEncoder();
const bytesOf = (content: string | Uint8Array): Bytes => {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};
const split = (path: string): Names => (path === "" ? [] : path.split("/"));

/** A file as it was read, which cannot be read any more once the file changed, as in Chrome. */
class MemoryFile extends File {
  readonly #check: () => void;

  constructor(node: FileNode, check: () => void) {
    super([node.content], node.name, { lastModified: node.lastModified });
    this.#check = check;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.#check();
    return super.arrayBuffer();
  }

  override async text(): Promise<string> {
    this.#check();
    return super.text();
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.#check();
    return super.stream();
  }
}

/** All there is of a disk, and what each handle does to it. */
class DiskState {
  readonly system: "windows" | "linux";
  readonly depth: number;
  readonly top: FolderNode = { kind: "directory", name: "", entries: new Map() };
  readonly grants = new Map<string, Record<PermissionMode, PermissionState>>();
  readonly observations = new Set<Observation>();
  readonly writers = new Set<Writer>();
  readonly failures = new Map<string, Required<WriteFailure>>();
  missesChanges = false;
  activation = false;
  answer: "allow" | "refuse" = "allow";
  refusesMoves = false;
  #clock = Date.UTC(2026, 10, 8);

  constructor(system: "windows" | "linux", depth: number) {
    this.system = system;
    this.depth = depth;
  }

  /** What tells names apart: on Windows not their case. */
  key(name: string): string {
    return this.system === "windows" ? name.toLowerCase() : name;
  }

  keyOf(names: Names): string {
    return names.map((name) => this.key(name)).join("/");
  }

  /** Every change gets a time of its own, so that what changed always looks changed. */
  tick(): number {
    this.#clock += 1;
    return this.#clock;
  }

  refuses(name: string): boolean {
    return this.system === "windows"
      ? isRefusedByChrome(name)
      : chromeRefuses(name) === "everywhere";
  }

  find(names: Names): Entry | undefined {
    let entry: Entry = this.top;
    for (const name of names) {
      if (entry.kind !== "directory") return undefined;
      const next = entry.entries.get(this.key(name));
      if (!next) return undefined;
      entry = next;
    }
    return entry;
  }

  /** The names on the disk, which can differ in case from how they were asked for. */
  diskNames(names: Names): Names {
    const found: string[] = [];
    let entry: Entry | undefined = this.top;
    for (const name of names) {
      entry = entry?.kind === "directory" ? entry.entries.get(this.key(name)) : undefined;
      found.push(entry?.name ?? name);
    }
    return found;
  }

  folderAt(names: Names): FolderNode {
    const entry = this.find(names);
    if (!entry) throw notFound();
    if (entry.kind !== "directory") throw failure("TypeMismatchError", "Not a directory.");
    return entry;
  }

  fileAt(names: Names): FileNode {
    const entry = this.find(names);
    if (!entry) throw notFound();
    if (entry.kind !== "file") throw failure("TypeMismatchError", "Not a file.");
    return entry;
  }

  permission(names: Names, mode: PermissionMode): PermissionState {
    for (let length = names.length; length >= 0; length--) {
      const grant = this.grants.get(this.keyOf(names.slice(0, length)));
      if (grant) return grant[mode];
    }
    return "prompt";
  }

  grant(names: Names, mode: PermissionMode, state: PermissionState = "granted"): void {
    const key = this.keyOf(names);
    const before = this.grants.get(key) ?? { read: "prompt", readwrite: "prompt" };
    const next = { ...before, [mode]: state };
    if (mode === "readwrite" && state === "granted") next.read = "granted";
    this.grants.set(key, next);
  }

  async request(names: Names, mode: PermissionMode): Promise<PermissionState> {
    const state = this.permission(names, mode);
    if (state !== "prompt") return state;
    if (!this.activation) {
      throw failure("SecurityError", "User activation is required to request permissions.");
    }
    // People who say no, or close the question, leave it the way it was.
    if (this.answer === "refuse") return "prompt";
    this.grant(names, mode);
    return "granted";
  }

  mayRead(names: Names): void {
    if (this.permission(names, "read") !== "granted") {
      throw failure("NotAllowedError", "The request is not allowed.");
    }
  }

  /** Writing without leave makes the browser ask, if it can. */
  mayWrite(names: Names): void {
    const state = this.permission(names, "readwrite");
    if (state === "granted") return;
    if (state === "prompt" && !this.activation) {
      throw failure("SecurityError", "User activation is required to request permissions.");
    }
    if (state === "denied" || this.answer === "refuse") {
      throw failure("NotAllowedError", "The request is not allowed.");
    }
    this.grant(names, "readwrite");
  }

  checkName(name: string): void {
    if (this.refuses(name)) throw new TypeError("Name is not allowed.");
  }

  /** What the system allows for a new entry. */
  checkLength(names: Names): void {
    if (this.system === "windows") {
      // The whole path, with a backslash before each name and an ending zero.
      const length = this.depth + names.reduce((sum, name) => sum + name.length + 1, 0);
      if (length >= 260) throw notFound();
    } else if (names.some((name) => encoder.encode(name).length > 255)) {
      throw failure("InvalidStateError", "The state had changed since it was read from disk.");
    }
  }

  isLocked(entry: Entry): boolean {
    if (entry.kind === "file") return entry.lock !== 0;
    return [...entry.entries.values()].some((inner) => this.isLocked(inner));
  }

  /** Tells observers, as the browser does: each change on its own, a moment later. */
  emit(
    type: ChangeRecordLike["type"],
    names: Names,
    kind: "file" | "directory" | undefined,
    from?: Names,
  ): void {
    if (this.missesChanges) return;
    const keys = names.map((name) => this.key(name));
    const fromKeys = from?.map((name) => this.key(name));
    for (const observation of this.observations) {
      const inside = (path: readonly string[] | undefined) =>
        path !== undefined &&
        path.length > observation.keys.length &&
        observation.keys.every((key, index) => key === path[index]) &&
        (observation.recursive || path.length === observation.keys.length + 1);
      const isIn = inside(keys);
      const wasIn = inside(fromKeys);
      if (!isIn && !wasIn) continue;
      const depth = observation.keys.length;
      // What moves in from outside of the folder comes, and what moves out of it goes.
      const told = isIn ? (type === "moved" && !wasIn ? "appeared" : type) : "disappeared";
      const record: ChangeRecordLike = {
        type: told,
        relativePathComponents: (isIn ? names : (from as Names)).slice(depth),
        relativePathMovedFrom: isIn && wasIn && from ? from.slice(depth) : null,
        changedHandle: type === "disappeared" || !kind ? null : { kind },
      };
      queueMicrotask(() => observation.observer.deliver([record]));
    }
  }

  /**
   * Tells observers of a folder, or of what is in it, what the browser would, such as "unknown",
   * without anything changing. After "errored" the browser watches no more.
   */
  say(type: ChangeRecordLike["type"], names: Names): void {
    const keys = names.map((name) => this.key(name));
    for (const observation of this.observations) {
      const isInside =
        keys.length >= observation.keys.length &&
        observation.keys.every((key, index) => key === keys[index]);
      if (!isInside) continue;
      if (type === "errored") this.observations.delete(observation);
      const record: ChangeRecordLike = {
        type,
        relativePathComponents: names.slice(observation.keys.length),
        changedHandle: null,
      };
      queueMicrotask(() => observation.observer.deliver([record]));
    }
  }

  /** The watched folders that go away with an entry: their watching is over. */
  endObservations(keys: Names): void {
    for (const observation of this.observations) {
      const goes = keys.every((key, index) => key === observation.keys[index]);
      if (!goes || keys.length > observation.keys.length) continue;
      this.observations.delete(observation);
      const root: ChangeRecordLike[] = [
        { type: "disappeared", relativePathComponents: [], changedHandle: null },
        { type: "errored", relativePathComponents: [], changedHandle: null },
      ];
      queueMicrotask(() => observation.observer.deliver(root));
    }
  }

  /** Every entry in a folder, the innermost first, for telling about each one going. */
  descendants(names: Names, entry: Entry): [Names, Entry][] {
    if (entry.kind === "file") return [[names, entry]];
    return [
      ...[...entry.entries.values()].flatMap((inner) =>
        this.descendants([...names, inner.name], inner),
      ),
      [names, entry],
    ];
  }

  /** Takes an entry away, and tells about everything that goes with it. */
  take(names: Names, quietly: boolean): void {
    const parent = this.folderAt(names.slice(0, -1));
    const key = this.key(names.at(-1) as string);
    const entry = parent.entries.get(key);
    if (!entry) throw notFound();
    const onDisk = this.diskNames(names);
    parent.entries.delete(key);
    if (!quietly) {
      for (const [path, gone] of this.descendants(onDisk, entry)) {
        this.emit("disappeared", path, gone.kind);
      }
    }
    this.endObservations(names.map((name) => this.key(name)));
  }

  /** Puts an entry at a place, as moving does, and tells about it. */
  place(from: Names, to: Names, quietly: boolean): void {
    const source = this.folderAt(from.slice(0, -1));
    const entry = source.entries.get(this.key(from.at(-1) as string));
    if (!entry) throw notFound();
    const target = this.folderAt(to.slice(0, -1));
    const onDiskFrom = this.diskNames(from);
    source.entries.delete(this.key(from.at(-1) as string));
    entry.name = to.at(-1) as string;
    target.entries.set(this.key(entry.name), entry);
    const onDiskTo = this.diskNames(to);
    this.endObservations(from.map((name) => this.key(name)));
    if (quietly) return;
    const sameFolder = this.keyOf(from.slice(0, -1)) === this.keyOf(to.slice(0, -1));
    // As on Windows: a move to another folder is told as going and coming.
    if (sameFolder) this.emit("moved", onDiskTo, entry.kind, onDiskFrom);
    else {
      this.emit("disappeared", onDiskFrom, entry.kind);
      this.emit("appeared", onDiskTo, entry.kind);
    }
  }

  /** The next writes of this file that are to fail. */
  takeFailure(names: Names): Required<WriteFailure> | undefined {
    const key = this.keyOf(names);
    const found = this.failures.get(key);
    if (!found) return undefined;
    if (found.times <= 1) this.failures.delete(key);
    else this.failures.set(key, { ...found, times: found.times - 1 });
    return found;
  }
}

class MemoryFileHandle implements FileHandleLike {
  readonly kind = "file";
  readonly #state: DiskState;
  #names: Names;

  constructor(state: DiskState, names: Names) {
    this.#state = state;
    this.#names = names;
  }

  get name(): string {
    return this.#names.at(-1) as string;
  }

  /** Where it is, as it was asked for. */
  get names(): Names {
    return this.#names;
  }

  async queryPermission({ mode }: { readonly mode: PermissionMode }) {
    return this.#state.permission(this.#names, mode);
  }

  async requestPermission({ mode }: { readonly mode: PermissionMode }) {
    return this.#state.request(this.#names, mode);
  }

  async isSameEntry(other: HandleLike): Promise<boolean> {
    return (
      other instanceof MemoryFileHandle &&
      this.#state.keyOf(other.names) === this.#state.keyOf(this.#names)
    );
  }

  async getFile(): Promise<File> {
    const state = this.#state;
    const names = this.#names;
    state.mayRead(names);
    const node = state.fileAt(names);
    const { version } = node;
    return new MemoryFile(node, () => {
      const now = state.find(names);
      if (!now) throw notFound();
      if (now !== node || node.version !== version) {
        throw failure("NotReadableError", "The requested file could not be read.");
      }
    });
  }

  async createWritable({ mode, keepExistingData = false }: CreateWritableOptions = {}) {
    const state = this.#state;
    const target = this.#names;
    state.mayWrite(target);
    const node = state.fileAt(target);
    const exclusive = mode === "exclusive";
    if (node.lock === "exclusive" || (exclusive && node.lock !== 0)) {
      throw failure("NoModificationAllowedError", "Modifications are not allowed.");
    }
    node.lock = exclusive ? "exclusive" : (node.lock as number) + 1;
    const folder = state.folderAt(target.slice(0, -1));
    let swapName = `${node.name}.crswap`;
    for (let number = 1; folder.entries.has(state.key(swapName)); number++) {
      swapName = `${node.name}.${number}.crswap`;
    }
    const swap: FileNode = {
      kind: "file",
      name: swapName,
      content: keepExistingData ? bytesOf(node.content) : new Uint8Array(),
      lastModified: state.tick(),
      version: 0,
      lock: "exclusive",
    };
    folder.entries.set(state.key(swapName), swap);
    const writer: Writer = {
      target,
      swap: [...target.slice(0, -1), swapName],
      node,
      exclusive,
      dead: false,
    };
    state.writers.add(writer);
    const fails = state.takeFailure(target);
    let written = 0;
    let released = false;
    // Once, whichever way the writer ends: a second time would let go of another one.
    const release = () => {
      if (released) return;
      released = true;
      state.writers.delete(writer);
      node.lock = exclusive ? 0 : Math.max(0, (node.lock as number) - 1);
      const swapFolder = state.find(writer.swap.slice(0, -1));
      if (swapFolder?.kind === "directory") swapFolder.entries.delete(state.key(swapName));
    };
    const alive = () => {
      if (writer.dead) throw failure("AbortError", "The page went away.");
    };
    return new WritableStream<Uint8Array>({
      write(chunk) {
        alive();
        written += chunk.byteLength;
        if (fails && !fails.atClose && written > fails.afterBytes) {
          release();
          throw failure(fails.name, "Writing failed.");
        }
        const grown = new Uint8Array(swap.content.byteLength + chunk.byteLength);
        grown.set(swap.content);
        grown.set(chunk, swap.content.byteLength);
        swap.content = grown;
      },
      close() {
        alive();
        release();
        if (fails?.atClose) throw failure(fails.name, "Writing failed.");
        // The temporary file takes the place of the file, at its path, which has a file again if
        // another program took it away or moved it meanwhile.
        const fileName = target.at(-1) as string;
        const parent = state.folderAt(target.slice(0, -1));
        const existing = parent.entries.get(state.key(fileName));
        if (existing?.kind === "directory") {
          throw failure("InvalidModificationError", "The object can not be modified in this way.");
        }
        const now: FileNode = existing ?? {
          kind: "file",
          name: fileName,
          content: new Uint8Array(),
          lastModified: 0,
          version: 0,
          lock: 0,
        };
        if (!existing) parent.entries.set(state.key(fileName), now);
        now.content = swap.content;
        now.lastModified = state.tick();
        now.version += 1;
        state.emit("modified", state.diskNames(target), "file");
      },
      abort() {
        if (!writer.dead) release();
      },
    });
  }

  async move(parent: DirectoryHandleLike | string, name?: string): Promise<void> {
    const state = this.#state;
    const from = this.#names;
    const folder =
      typeof parent === "string" ? from.slice(0, -1) : (parent as MemoryDirectoryHandle).names;
    const newName = typeof parent === "string" ? parent : (name ?? this.name);
    state.checkName(newName);
    state.mayWrite(from);
    const node = state.fileAt(from);
    if (node.lock !== 0) {
      throw failure("NoModificationAllowedError", "A handle cannot be moved while it is locked.");
    }
    if (state.refusesMoves) throw failure("NotAllowedError", "The request is not allowed.");
    const to = [...folder, newName];
    const there = state.find(to);
    if (there?.kind === "directory") {
      throw failure("InvalidModificationError", "The object can not be modified in this way.");
    }
    if (there && there !== node && state.isLocked(there)) {
      throw failure("NoModificationAllowedError", "Modifications are not allowed.");
    }
    state.folderAt(folder);
    if (there && there !== node) state.take(to, true);
    state.place(from, to, false);
    this.#names = to;
  }
}

class MemoryDirectoryHandle implements DirectoryHandleLike {
  readonly kind = "directory";
  readonly #state: DiskState;
  readonly names: Names;

  constructor(state: DiskState, names: Names) {
    this.#state = state;
    this.names = names;
  }

  get name(): string {
    return this.names.at(-1) ?? "";
  }

  async queryPermission({ mode }: { readonly mode: PermissionMode }) {
    return this.#state.permission(this.names, mode);
  }

  async requestPermission({ mode }: { readonly mode: PermissionMode }) {
    return this.#state.request(this.names, mode);
  }

  async isSameEntry(other: HandleLike): Promise<boolean> {
    return (
      other instanceof MemoryDirectoryHandle &&
      this.#state.keyOf(other.names) === this.#state.keyOf(this.names)
    );
  }

  async resolve(possibleDescendant: HandleLike): Promise<string[] | null> {
    const other = (possibleDescendant as MemoryFileHandle | MemoryDirectoryHandle).names;
    const state = this.#state;
    const isInside =
      other.length >= this.names.length &&
      this.names.every((name, index) => state.key(name) === state.key(other[index] as string));
    return isInside ? other.slice(this.names.length) : null;
  }

  async getDirectoryHandle(name: string, { create = false } = {}) {
    const state = this.#state;
    state.checkName(name);
    state.mayRead(this.names);
    const folder = state.folderAt(this.names);
    const names = [...this.names, name];
    const entry = folder.entries.get(state.key(name));
    if (entry?.kind === "file") throw failure("TypeMismatchError", "Not a directory.");
    if (!entry) {
      if (!create) throw notFound();
      state.mayWrite(this.names);
      state.checkLength(names);
      folder.entries.set(state.key(name), { kind: "directory", name, entries: new Map() });
      state.emit("appeared", state.diskNames(names), "directory");
    }
    return new MemoryDirectoryHandle(state, names);
  }

  async getFileHandle(name: string, { create = false } = {}) {
    const state = this.#state;
    state.checkName(name);
    state.mayRead(this.names);
    const folder = state.folderAt(this.names);
    const names = [...this.names, name];
    const entry = folder.entries.get(state.key(name));
    if (entry?.kind === "directory") throw failure("TypeMismatchError", "Not a file.");
    if (!entry) {
      if (!create) throw notFound();
      state.mayWrite(this.names);
      state.checkLength(names);
      const file: FileNode = {
        kind: "file",
        name,
        content: new Uint8Array(),
        lastModified: state.tick(),
        version: 0,
        lock: 0,
      };
      folder.entries.set(state.key(name), file);
      state.emit("appeared", state.diskNames(names), "file");
    }
    return new MemoryFileHandle(state, names);
  }

  async removeEntry(name: string, { recursive = false } = {}) {
    const state = this.#state;
    state.checkName(name);
    state.mayWrite(this.names);
    const folder = state.folderAt(this.names);
    const entry = folder.entries.get(state.key(name));
    if (!entry) throw notFound();
    if (state.isLocked(entry)) {
      throw failure("NoModificationAllowedError", "Modifications are not allowed.");
    }
    if (entry.kind === "directory" && entry.entries.size > 0 && !recursive) {
      throw failure("InvalidModificationError", "The object can not be modified in this way.");
    }
    state.take([...this.names, name], false);
  }

  async *values(): AsyncGenerator<HandleLike> {
    const state = this.#state;
    state.mayRead(this.names);
    const folder = state.folderAt(this.names);
    // As it was when listing started: what changes on the way is for the next time.
    for (const entry of Array.from(folder.entries.values())) {
      // Chrome does not show what it does not allow, and says nothing about it.
      if (state.refuses(entry.name)) continue;
      const names = [...this.names, entry.name];
      yield entry.kind === "file"
        ? new MemoryFileHandle(state, names)
        : new MemoryDirectoryHandle(state, names);
    }
  }
}

/** For tests: a disk in memory, see the top of this file. */
export class MemoryDisk {
  /** Where the folders that were opened are kept. It stays the same for every page. */
  readonly records: RecordStore = memoryRecordStore();
  /** Whether the browser tells about changes, as Chrome and Edge do from version 133 on. */
  observes = true;
  /** Whether the window is out of sight. */
  hidden = false;
  readonly #state: DiskState;
  readonly #front = new Set<() => void>();
  #chosen: string | undefined;
  readonly #Observer: ObserverConstructor;

  constructor({ system = "windows", depth = 40 }: MemoryDiskOptions = {}) {
    const state = new DiskState(system, depth);
    this.#state = state;
    this.#Observer = class MemoryObserver implements ObserverLike {
      readonly #callback: (records: readonly ChangeRecordLike[]) => void;
      readonly #own = new Set<Observation>();

      constructor(callback: (records: readonly ChangeRecordLike[]) => void) {
        this.#callback = callback;
      }

      async observe(handle: DirectoryHandleLike, { recursive }: { readonly recursive: boolean }) {
        const { names } = handle as MemoryDirectoryHandle;
        state.mayRead(names);
        state.folderAt(names);
        const observation: Observation = {
          observer: { deliver: (records) => this.#callback(records) },
          keys: names.map((name) => state.key(name)),
          recursive,
        };
        this.#own.add(observation);
        state.observations.add(observation);
      }

      disconnect() {
        for (const observation of this.#own) state.observations.delete(observation);
        this.#own.clear();
      }
    };
  }

  get system(): "windows" | "linux" {
    return this.#state.system;
  }

  /** The browser misses what changes, as Linux does in new folders, and says nothing about it. */
  get missesChanges(): boolean {
    return this.#state.missesChanges;
  }

  set missesChanges(misses: boolean) {
    this.#state.missesChanges = misses;
  }

  /** Whether people just did something, which the browser needs before it asks them anything. */
  get activation(): boolean {
    return this.#state.activation;
  }

  set activation(active: boolean) {
    this.#state.activation = active;
  }

  /** What people answer when the browser asks whether the editor may write a folder. */
  get answer(): "allow" | "refuse" {
    return this.#state.answer;
  }

  set answer(answer: "allow" | "refuse") {
    this.#state.answer = answer;
  }

  /** Whether moving a file fails, as it once did in Edge, so that writing has to do it. */
  get refusesMoves(): boolean {
    return this.#state.refusesMoves;
  }

  set refusesMoves(refuses: boolean) {
    this.#state.refusesMoves = refuses;
  }

  /** Writes a file, and the folders on the way, as another program does. */
  write(path: string, content: string | Uint8Array = "", { quietly = false }: ChangeOptions = {}) {
    const state = this.#state;
    const names = split(path);
    const parent = this.#makeFolders(names.slice(0, -1), quietly);
    const key = state.key(names.at(-1) as string);
    const existing = parent.entries.get(key);
    if (existing?.kind === "directory") throw new Error(`A folder is at ${path}`);
    const file: FileNode = existing ?? {
      kind: "file",
      name: names.at(-1) as string,
      content: new Uint8Array(),
      lastModified: 0,
      version: 0,
      lock: 0,
    };
    file.content = bytesOf(content);
    file.lastModified = state.tick();
    file.version += 1;
    parent.entries.set(key, file);
    if (quietly) return;
    if (!existing) state.emit("appeared", state.diskNames(names), "file");
    state.emit("modified", state.diskNames(names), "file");
  }

  /** Makes a folder, and the ones on the way. */
  folder(path: string, { quietly = false }: ChangeOptions = {}): void {
    this.#makeFolders(split(path), quietly);
  }

  /** Takes a file or a folder away, with all that is in it, as another program does. */
  remove(path: string, { quietly = false }: ChangeOptions = {}): void {
    this.#state.take(split(path), quietly);
  }

  /** Moves or renames a file or a folder, as another program does, which replaces nothing. */
  move(from: string, to: string, { quietly = false }: ChangeOptions = {}): void {
    if (this.#state.find(split(to))) throw new Error(`Something is at ${to}`);
    this.#makeFolders(split(to).slice(0, -1), quietly);
    this.#state.place(split(from), split(to), quietly);
  }

  /** Gives a file a new time and nothing else, which Linux does not tell about. */
  touch(path: string): void {
    const file = this.#state.fileAt(split(path));
    file.lastModified = this.#state.tick();
    file.version += 1;
  }

  /**
   * Tells what the browser would about a path, without anything changing: "unknown" when it lost
   * track, "errored" when it stopped watching, or a change that did not happen.
   */
  tell(type: ChangeRecordLike["type"], path: string): void {
    this.#state.say(type, split(path));
  }

  has(path: string): boolean {
    return this.#state.find(split(path)) !== undefined;
  }

  bytes(path: string): Bytes {
    return bytesOf(this.#state.fileAt(split(path)).content);
  }

  text(path: string): string {
    return new TextDecoder().decode(this.#state.fileAt(split(path)).content);
  }

  /** The names in a folder as they are on the disk, also those that Chrome does not show. */
  names(path = ""): string[] {
    return [...this.#state.folderAt(split(path)).entries.values()].map((entry) => entry.name);
  }

  /** What the next dialog for choosing a folder gives: this folder, made if it is not there. */
  chooseNext(path: string | "cancel"): void {
    this.#chosen = path;
  }

  /**
   * What dropping these folders and files gives, for `LocalFolders.dropped`. They may be read, and
   * dropping counts as people doing something.
   */
  drop(...paths: readonly string[]): DataTransfer {
    const state = this.#state;
    const items = paths.map((path) => {
      const names = split(path);
      const entry = state.find(names);
      if (!entry) throw new Error(`Nothing is at ${path}`);
      if (state.permission(names, "read") !== "granted") state.grant(names, "read");
      const handle =
        entry.kind === "file"
          ? new MemoryFileHandle(state, names)
          : new MemoryDirectoryHandle(state, names);
      return { kind: "file", getAsFileSystemHandle: async () => handle };
    });
    state.activation = true;
    return { items } as unknown as DataTransfer;
  }

  /** Lets the editor at a folder, as people do when the browser asks them. */
  grant(path: string, mode: PermissionMode = "readwrite"): void {
    this.#state.grant(split(path), mode);
  }

  /** Has the browser not let the editor at a folder at all, as a policy can. */
  block(path: string): void {
    this.#state.grant(split(path), "read", "denied");
    this.#state.grant(split(path), "readwrite", "denied");
  }

  /**
   * Takes back what people allowed, as the browser does once all windows of the site were closed:
   * it asks again the next time.
   */
  forgetPermissions(): void {
    this.#state.grants.clear();
  }

  /** Has the next writes of a file fail. */
  failWrites(path: string, how: WriteFailure = {}): void {
    const { name = "QuotaExceededError", afterBytes = 0, atClose = false, times = 1 } = how;
    this.#state.failures.set(this.#state.keyOf(split(path)), { name, afterBytes, atClose, times });
  }

  /**
   * As if the browser went away while it was writing: the files stay as they were, and on Linux
   * the temporary files stay too, which the browser never takes away.
   */
  crash({ leaveTemporaryFiles = this.system === "linux" } = {}): void {
    const state = this.#state;
    for (const writer of state.writers) {
      writer.dead = true;
      writer.node.lock = 0;
      const swap = state.find(writer.swap);
      if (swap?.kind === "file") swap.lock = 0;
      if (!leaveTemporaryFiles) {
        const folder = state.find(writer.swap.slice(0, -1));
        if (folder?.kind === "directory")
          folder.entries.delete(state.key(writer.swap.at(-1) as string));
      }
    }
    state.writers.clear();
    state.observations.clear();
  }

  /** People come back to the window. */
  front(): void {
    this.hidden = false;
    for (const listener of this.#front) listener();
  }

  /** What `createLocalFolders` needs, on this disk. */
  environment(timing?: Partial<WatchTiming>): LocalFoldersEnvironment {
    // Asked for when a watch starts, so that a test can take it away before.
    const observer = () => (this.observes ? this.#Observer : undefined);
    return {
      pick: async () => this.#pick(),
      get Observer() {
        return observer();
      },
      onFront: (listener) => {
        this.#front.add(listener);
        return () => this.#front.delete(listener);
      },
      isHidden: () => this.hidden,
      records: this.records,
      timing,
    };
  }

  #pick(): DirectoryHandleLike {
    const chosen = this.#chosen;
    this.#chosen = undefined;
    if (chosen === undefined || chosen === "cancel") {
      throw failure("AbortError", "The user aborted a request.");
    }
    const names = split(chosen);
    this.#makeFolders(names, true);
    this.#state.grant(names, "readwrite");
    return new MemoryDirectoryHandle(this.#state, names);
  }

  #makeFolders(names: Names, quietly: boolean): FolderNode {
    const state = this.#state;
    let folder = state.top;
    for (const [index, name] of names.entries()) {
      const key = state.key(name);
      const existing = folder.entries.get(key);
      if (existing?.kind === "file") throw new Error(`A file is at ${names.join("/")}`);
      if (existing) {
        folder = existing;
        continue;
      }
      const made: FolderNode = { kind: "directory", name, entries: new Map() };
      folder.entries.set(key, made);
      folder = made;
      if (!quietly) state.emit("appeared", state.diskNames(names.slice(0, index + 1)), "directory");
    }
    return folder;
  }
}

/** For tests: folders on a disk in memory, the way a page in Chrome has them. */
export const memoryFolders = (disk: MemoryDisk, timing?: Partial<WatchTiming>): LocalFolders =>
  createLocalFolders(disk.environment(timing));
