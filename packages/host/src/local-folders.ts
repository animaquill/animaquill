import { createRecordStore } from "./folder-records.ts";
import {
  FolderWatcher,
  HASHED_BYTES,
  hashOf,
  inTurns,
  isSameSeen,
  statOf,
  type Seen,
  type WatchedFolder,
  type WatchTiming,
} from "./folder-watch.ts";
import {
  isNamed,
  type DirectoryHandleLike,
  type FileHandleLike,
  type HandleLike,
  type ObserverConstructor,
} from "./handles.ts";
import {
  FolderError,
  type AccessAnswer,
  type FileContent,
  type FolderFailure,
  type FolderRecord,
  type FolderRecords,
  type FolderStatus,
  type FolderWatch,
  type LocalEntry,
  type LocalFile,
  type LocalFolder,
  type LocalFolders,
  type LocalWriteOptions,
  type RemoveOptions,
  type WatchOptions,
  type WriteAllOptions,
} from "./index.ts";
import { isToolFolder, partsOf, sameNameKey } from "./paths.ts";

/** Lets the browser come back to the place people used the last time, as it does for exports. */
const PICKER_ID = "animaquill-projects";
/**
 * A file up to this size is read back whole after writing it, to be sure that it is what was
 * written. Of a larger one, such as a video, three pieces are.
 */
const READ_BACK_BYTES = HASHED_BYTES;
/** How large each of those pieces is. */
const PIECE_BYTES = 64 * 1024;
/**
 * How many files get written at the same time. On Windows each one costs about 0.1 s, whatever its
 * size. On Linux 200 small files took 0.6 to 0.9 s one after the other, 0.2 s with 8 at a time and
 * not much less with more (Chromium 156, 2026-11-08). Windows is still to be measured.
 */
export const WRITE_AT_ONCE = 8;
/** What Linux allows for a name, in bytes. */
const MAX_NAME_BYTES = 255;
/** What writing leaves next to a file, as "a.json.crswap" or "a.json.1.crswap". */
const LEFTOVER = /^(.+)\.crswap$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A folder that was opened, as it is kept, with its handle as it is. */
export interface StoredRecord {
  readonly id: string;
  readonly handle: DirectoryHandleLike;
  readonly project: string;
  readonly name: string;
  readonly openedAt: number;
}

/** Where records of folders are kept, see folder-records.ts. */
export interface RecordStore {
  list(): Promise<readonly StoredRecord[]>;
  get(id: string): Promise<StoredRecord | undefined>;
  put(record: StoredRecord): Promise<void>;
  remove(id: string): Promise<void>;
  withProject(project: string): Promise<readonly StoredRecord[]>;
}

/** What folders on this computer need from where they are. */
export interface LocalFoldersEnvironment {
  /** Asks people for a folder to read and write, as `showDirectoryPicker` does. */
  readonly pick: () => Promise<DirectoryHandleLike>;
  /** What tells about changes in folders, where the browser has it. */
  readonly Observer?: ObserverConstructor | undefined;
  /** Calls back when the window comes to the front again. Returns how to stop. */
  readonly onFront: (listener: () => void) => () => void;
  /** Whether nobody can see the window right now. */
  readonly isHidden: () => boolean;
  readonly records: RecordStore;
  /** How long watching waits, for tests. */
  readonly timing?: Partial<WatchTiming> | undefined;
}

/** The handle that each folder and file of this module stands for. */
const handles = new WeakMap<object, HandleLike>();

function directoryOf(folder: LocalFolder): DirectoryHandleLike {
  const handle = handles.get(folder);
  if (handle?.kind !== "directory") throw new Error(`${folder.name} is not a folder of this host`);
  return handle;
}

const handleOfEntry = (entry: LocalEntry) =>
  handles.get(entry.kind === "folder" ? entry.folder : entry.file);

const asBlob = (content: FileContent) => (content instanceof Blob ? content : new Blob([content]));

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

/** The same order on every disk, as in core. */
const byName = (a: HandleLike, b: HandleLike) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const hasLongName = (path: string) =>
  path.split("/").some((part) => encoder.encode(part).length > MAX_NAME_BYTES);

/** A file of this name in a folder, undefined when there is none. */
async function fileIn(
  folder: DirectoryHandleLike,
  name: string,
): Promise<FileHandleLike | undefined> {
  try {
    return await folder.getFileHandle(name);
  } catch (error) {
    if (isNamed(error, "NotFoundError")) return undefined;
    throw error;
  }
}

/** Takes away the empty file that a write made and could not fill. */
async function removeIfEmpty(folder: DirectoryHandleLike, name: string): Promise<void> {
  const file = await (await folder.getFileHandle(name)).getFile();
  if (file.size === 0) await folder.removeEntry(name);
}

/**
 * Takes away the folders on the way to a file that was just taken away, as far as that left them
 * empty. Never the top one.
 */
async function prune(chain: readonly DirectoryHandleLike[], parts: readonly string[]) {
  for (let depth = chain.length - 2; depth >= 0; depth--) {
    try {
      // Only an empty folder can go this way: whatever is in one keeps it, also a file that the
      // browser does not show.
      await (chain[depth] as DirectoryHandleLike).removeEntry(parts[depth] as string);
    } catch {
      return;
    }
  }
}

/** The pieces of a file that get read back after writing it: all of a small one. */
function piecesOf(size: number): (readonly [number, number])[] {
  if (size <= READ_BACK_BYTES) return [[0, size]];
  const middle = Math.floor(size / 2 - PIECE_BYTES / 2);
  return [
    [0, PIECE_BYTES],
    [middle, middle + PIECE_BYTES],
    [size - PIECE_BYTES, size],
  ];
}

/** Keeps the pieces that `piecesOf` names of what goes by, to compare with the file after. */
function keeper(size: number) {
  const pieces = piecesOf(size).map(([start, end]) => ({
    start,
    bytes: new Uint8Array(end - start),
  }));
  let offset = 0;
  return {
    pieces,
    take(chunk: Uint8Array) {
      for (const { start, bytes } of pieces) {
        const from = Math.max(start, offset);
        const to = Math.min(start + bytes.length, offset + chunk.length);
        if (from < to) bytes.set(chunk.subarray(from - offset, to - offset), from - start);
      }
      offset += chunk.length;
    },
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The file that a leftover of writing belongs to, among those that matter, by `sameNameKey`. */
function ownerOf(name: string, owners: ReadonlyMap<string, string>): string | undefined {
  const base = LEFTOVER.exec(name)?.[1];
  if (base === undefined) return undefined;
  // "a.1.crswap" is the second of "a", or the first of "a.1": either would do.
  const numbered = /^(.+)\.\d+$/.exec(base)?.[1];
  for (const candidate of [base, numbered]) {
    const owner = candidate === undefined ? undefined : owners.get(sameNameKey(candidate));
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/** What a write left: the file, and what a watch keeps of it to know it as its own. */
interface Written {
  readonly file: File;
  readonly seen: Seen;
}

/** Where a file moves from and to, by writing it. */
interface Places {
  readonly sourceFolder: DirectoryHandleLike;
  readonly sourceName: string;
  readonly targetFolder: DirectoryHandleLike;
  readonly targetName: string;
}

class HandleFolder implements LocalFolder {
  readonly name: string;
  readonly #root: DirectoryHandleLike;
  readonly #environment: LocalFoldersEnvironment;
  /** Files that are being written or moved, by `sameNameKey`, and by how many. */
  readonly #writing = new Map<string, number>();
  /** How many times a write of a file started or ended, by `sameNameKey`. */
  readonly #writes = new Map<string, number>();
  readonly #watchers = new Set<FolderWatcher>();
  readonly #watched: WatchedFolder;

  constructor(root: DirectoryHandleLike, environment: LocalFoldersEnvironment) {
    this.name = root.name;
    this.#root = root;
    this.#environment = environment;
    handles.set(this, root);
    this.#watched = {
      root,
      look: (path) => this.#look(path),
      list: (folder, includes) => this.#listIncluded(folder, includes),
      isThere: () => this.#isThere(),
      isWriting: (path) => this.#writing.has(sameNameKey(path)),
      writes: (path) => this.#writes.get(sameNameKey(path)) ?? 0,
    };
  }

  async status(): Promise<FolderStatus> {
    const permission = await this.#permission();
    if (permission === "denied") return "blocked";
    if (permission === "prompt") return "ask";
    return (await this.#isThere()) ? "ready" : "gone";
  }

  async requestAccess(): Promise<AccessAnswer> {
    if ((await this.#permission()) === "granted") return "granted";
    try {
      const answer = await this.#root.requestPermission?.({ mode: "readwrite" });
      return answer === "granted" ? "granted" : "refused";
    } catch (error) {
      // Not right after people did something.
      if (isNamed(error, "SecurityError")) return "needs-activation";
      if (isNamed(error, "NotAllowedError", "AbortError")) return "refused";
      throw await this.#failure(error, "", false);
    }
  }

  async isSame(other: LocalFolder): Promise<boolean> {
    const theirs = handles.get(other);
    return theirs ? this.#root.isSameEntry(theirs).catch(() => false) : false;
  }

  async pathOf(entry: LocalEntry): Promise<string | undefined> {
    const handle = handleOfEntry(entry);
    const parts = handle && (await this.#root.resolve(handle).catch(() => null));
    return parts?.join("/");
  }

  async *list(): AsyncGenerator<string> {
    yield* this.#walk(this.#root, "", () => true);
  }

  async file(path: string): Promise<File> {
    const parts = this.#parts(path);
    try {
      return await (await this.#fileAt(parts)).getFile();
    } catch (error) {
      throw await this.#failure(error, path, false);
    }
  }

  async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    for (let attempt = 1; ; attempt++) {
      const file = await this.file(path);
      try {
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        // It changed since the browser gave it out, which getting it again takes care of.
        if (attempt === 1 && isNamed(error, "NotReadableError")) continue;
        throw await this.#failure(error, path, false);
      }
    }
  }

  async readText(path: string): Promise<string> {
    const bytes = await this.read(path);
    try {
      return decoder.decode(bytes);
    } catch (error) {
      throw new FolderError("not-text", path, { cause: error });
    }
  }

  async write(path: string, content: FileContent, options: LocalWriteOptions = {}): Promise<File> {
    const parts = this.#parts(path);
    const { signal, expected } = options;
    signal?.throwIfAborted();
    const blob = asBlob(content);
    return this.#changing(
      [path],
      async () => {
        await this.#mayWrite(path);
        const folder = await this.#folderAt(parts.slice(0, -1), true, path);
        const name = parts.at(-1) as string;
        const found = await fileIn(folder, name);
        // An empty file is what a crash leaves of one that was being made: it counts as none.
        const isAsExpected =
          expected === undefined ||
          (expected === "absent"
            ? !found || (await found.getFile()).size === 0
            : found !== undefined);
        if (!isAsExpected) throw new FolderError("changed", path);
        const handle =
          found ??
          (await this.#made(
            () => folder.getFileHandle(name, { create: true }),
            parts.slice(0, -1),
            path,
          ));
        // A file that this made stays only with what it was meant to have.
        const undo = found ? async () => {} : () => removeIfEmpty(folder, name);
        const { file, seen } = await this.#put(handle, blob, path, options, undo);
        this.#wrote(path, seen);
        return file;
      },
      path,
      signal,
    );
  }

  async writeAll(
    files: Iterable<{ readonly path: string; readonly content: FileContent }>,
    { signal, concurrency = WRITE_AT_ONCE, onProgress, onWritten }: WriteAllOptions = {},
  ): Promise<void> {
    // Two writes of one file would keep each other out, also where it is named in two ways that
    // are one file on Windows. The last one is what it gets.
    const byKey = new Map<string, { readonly path: string; readonly content: FileContent }>();
    for (const file of files) {
      const key = sameNameKey(file.path);
      byKey.delete(key);
      byKey.set(key, file);
    }
    const all = [...byKey.values()];
    let written = 0;
    let failure: { readonly error: unknown } | undefined;
    onProgress?.(0, all.length);
    await inTurns(all, Math.max(1, concurrency), async ({ path, content }) => {
      if (failure || signal?.aborted) return;
      try {
        const file = await this.write(path, content, signal ? { signal } : {});
        written += 1;
        onWritten?.(path, file);
        onProgress?.(written, all.length);
      } catch (error) {
        failure ??= { error };
      }
    });
    signal?.throwIfAborted();
    if (failure) throw failure.error;
  }

  async remove(path: string, { expected }: RemoveOptions = {}): Promise<void> {
    const parts = this.#parts(path);
    await this.#changing(
      [path],
      async () => {
        await this.#mayWrite(path);
        const chain = await this.#chain(parts.slice(0, -1));
        const folder = chain?.at(-1);
        const name = parts.at(-1) as string;
        const handle = folder && (await this.#fileHandleIn(folder, name));
        if (!chain || !folder || !handle) {
          this.#wrote(path, "absent");
          return;
        }
        if (expected !== undefined) {
          const now = await handle.getFile();
          if (!isSameSeen(statOf(now), statOf(expected))) throw new FolderError("changed", path);
        }
        try {
          await folder.removeEntry(name);
        } catch (error) {
          if (!isNamed(error, "NotFoundError")) throw error;
          // It went, and not because of this: what it leaves is not this one's to tidy.
          this.#wrote(path, "absent");
          return;
        }
        this.#wrote(path, "absent");
        await prune(chain, parts);
      },
      path,
    );
  }

  async move(from: string, to: string, { expected }: RemoveOptions = {}): Promise<void> {
    const source = this.#parts(from);
    const target = this.#parts(to);
    if (from === to) return;
    await this.#changing(
      [from, to],
      async () => {
        await this.#mayWrite(from);
        const chain = await this.#chain(source.slice(0, -1));
        const sourceFolder = chain?.at(-1);
        const sourceName = source.at(-1) as string;
        if (!chain || !sourceFolder) throw new FolderError("missing", from);
        const handle = await sourceFolder
          .getFileHandle(sourceName)
          .catch(async (error: unknown) => {
            throw await this.#failure(error, from, false);
          });
        const snapshot = await handle.getFile();
        if (expected !== undefined && !isSameSeen(statOf(snapshot), statOf(expected))) {
          throw new FolderError("changed", from);
        }
        const targetName = target.at(-1) as string;
        const targetFolder = await this.#folderAt(target.slice(0, -1), true, to);
        const sameFolder =
          sameNameKey(from.slice(0, from.lastIndexOf("/") + 1)) ===
          sameNameKey(to.slice(0, to.lastIndexOf("/") + 1));
        // The browser would replace it without a word.
        if (await this.#isAnotherAt(targetFolder, targetName, handle, sameFolder)) {
          throw new FolderError("exists", to);
        }
        const moved = await this.#tryMove(handle, targetFolder, targetName, to).catch(
          async (error: unknown) => {
            throw await this.#failure(error, from, false);
          },
        );
        if (moved) {
          const file = await (await targetFolder.getFileHandle(targetName)).getFile();
          this.#wrote(from, "absent");
          this.#wrote(to, statOf(file));
        } else {
          const places: Places = { sourceFolder, sourceName, targetFolder, targetName };
          await this.#moveByCopy(handle, snapshot, places, from, to, target.slice(0, -1));
        }
        await prune(chain, source);
      },
      from,
    );
  }

  async removeLeftovers(paths: Iterable<string>): Promise<readonly string[]> {
    const byFolder = new Map<string, Map<string, string>>();
    for (const path of paths) {
      const parts = partsOf(path);
      if (!parts) continue;
      const folder = parts.slice(0, -1).join("/");
      const owners = byFolder.get(folder) ?? new Map<string, string>();
      owners.set(sameNameKey(parts.at(-1) as string), path);
      byFolder.set(folder, owners);
    }
    if ((await this.#permission()) !== "granted") return [];
    const removed: string[] = [];
    for (const [folderPath, owners] of byFolder) {
      const chain = await this.#chain(folderPath === "" ? [] : folderPath.split("/")).catch(
        () => undefined,
      );
      const folder = chain?.at(-1);
      if (!folder) continue;
      const entries = await collect(folder.values()).catch((): HandleLike[] => []);
      for (const entry of entries) {
        const owner = entry.kind === "file" ? ownerOf(entry.name, owners) : undefined;
        // A write of this window still uses it. One of another window keeps it from going.
        if (owner === undefined || this.#writing.has(sameNameKey(owner))) continue;
        try {
          await folder.removeEntry(entry.name);
          removed.push(folderPath === "" ? entry.name : `${folderPath}/${entry.name}`);
        } catch {
          // In use, or gone already: either way it is not this one's to worry about.
        }
      }
    }
    return removed;
  }

  watch(options: WatchOptions): FolderWatch {
    const watcher: FolderWatcher = new FolderWatcher(
      this.#watched,
      options,
      this.#environment,
      () => this.#watchers.delete(watcher),
    );
    this.#watchers.add(watcher);
    return watcher;
  }

  #parts(path: string): readonly [string, ...string[]] {
    const parts = partsOf(path);
    if (!parts) throw new FolderError("refused", path);
    return parts;
  }

  async #permission(): Promise<PermissionState> {
    try {
      return (await this.#root.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    } catch {
      return "prompt";
    }
  }

  /** Writing without it would have the browser ask people out of the blue, or fail. */
  async #mayWrite(path: string): Promise<void> {
    if ((await this.#permission()) !== "granted") throw new FolderError("denied", path);
  }

  /** Whether the folder is still where it was. One that the browser does not let at is. */
  async #isThere(): Promise<boolean> {
    try {
      const entries = this.#root.values()[Symbol.asyncIterator]();
      await entries.next();
      await entries.return?.();
      return true;
    } catch (error) {
      return !isNamed(error, "NotFoundError");
    }
  }

  /** What went wrong, in a way that says what to do about it. */
  async #failure(error: unknown, path: string, writing: boolean): Promise<FolderError> {
    if (error instanceof FolderError) return error;
    const fail = (reason: FolderFailure) => new FolderError(reason, path, { cause: error });
    switch (error instanceof Error ? error.name : "") {
      case "TypeError":
        return fail("refused");
      case "NotAllowedError":
      case "SecurityError":
        return fail("denied");
      case "NoModificationAllowedError":
        return fail("busy");
      case "QuotaExceededError":
        return fail("full");
      case "TypeMismatchError":
        return fail(writing ? "exists" : "missing");
      case "NotReadableError":
        return fail("changed");
      case "InvalidStateError":
        // What Linux says for a name that is too long.
        return fail(writing && hasLongName(path) ? "too-long" : "failed");
      case "NotFoundError":
        if (!(await this.#isThere())) return fail("gone");
        // A path that is too long is told where something gets made, see `#made`. Anywhere else a
        // file or a folder went away on the way.
        return fail(writing ? "changed" : "missing");
      default:
        return fail("failed");
    }
  }

  /**
   * Makes a file or a folder. Windows says "NotFoundError" for a path that is too long, which is
   * what that means where the folder it goes in is there.
   */
  async #made<T>(make: () => Promise<T>, folder: readonly string[], path: string): Promise<T> {
    try {
      return await make();
    } catch (error) {
      if (!isNamed(error, "NotFoundError")) throw error;
      if (!(await this.#isThere())) throw new FolderError("gone", path, { cause: error });
      const isFolderThere = await this.#folderAt(folder, false).then(
        () => true,
        () => false,
      );
      throw new FolderError(isFolderThere ? "too-long" : "changed", path, { cause: error });
    }
  }

  /** Runs what changes files, which nobody should take for a change from somewhere else. */
  async #changing<T>(
    paths: readonly string[],
    work: () => Promise<T>,
    failurePath: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const keys = paths.map(sameNameKey);
    for (const key of keys) {
      this.#writing.set(key, (this.#writing.get(key) ?? 0) + 1);
      this.#writes.set(key, (this.#writes.get(key) ?? 0) + 1);
    }
    try {
      return await work();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw await this.#failure(error, failurePath, true);
    } finally {
      for (const [index, key] of keys.entries()) {
        const left = (this.#writing.get(key) ?? 1) - 1;
        if (left > 0) this.#writing.set(key, left);
        else this.#writing.delete(key);
        this.#writes.set(key, (this.#writes.get(key) ?? 0) + 1);
        for (const watcher of this.#watchers) watcher.doneWriting(paths[index] as string);
      }
    }
  }

  #wrote(path: string, seen: Seen): void {
    for (const watcher of this.#watchers) watcher.wrote(path, seen);
  }

  /** The folder at these parts. Making them, a too long path rejects as that, about `path`. */
  async #folderAt(
    parts: readonly string[],
    create: boolean,
    path = parts.join("/"),
  ): Promise<DirectoryHandleLike> {
    let folder = this.#root;
    for (const [index, part] of parts.entries()) {
      const parent = folder;
      folder = create
        ? await this.#made(
            () => parent.getDirectoryHandle(part, { create: true }),
            parts.slice(0, index),
            path,
          )
        : await parent.getDirectoryHandle(part);
    }
    return folder;
  }

  async #fileAt(parts: readonly [string, ...string[]]): Promise<FileHandleLike> {
    const folder = await this.#folderAt(parts.slice(0, -1), false);
    return folder.getFileHandle(parts.at(-1) as string);
  }

  /**
   * The folders from the top to the one at these parts, or undefined when one on the way is not
   * there. Rejects when the folder itself is not.
   */
  async #chain(parts: readonly string[]): Promise<DirectoryHandleLike[] | undefined> {
    const chain = [this.#root];
    for (const part of parts) {
      try {
        chain.push(await (chain.at(-1) as DirectoryHandleLike).getDirectoryHandle(part));
      } catch (error) {
        if (!isNamed(error, "NotFoundError", "TypeMismatchError")) throw error;
        if (await this.#isThere()) return undefined;
        throw error;
      }
    }
    return chain;
  }

  /** The file of this name in a folder, undefined when there is none, or a folder is there. */
  async #fileHandleIn(
    folder: DirectoryHandleLike,
    name: string,
  ): Promise<FileHandleLike | undefined> {
    try {
      return await folder.getFileHandle(name);
    } catch (error) {
      if (isNamed(error, "TypeMismatchError")) return undefined;
      if (isNamed(error, "NotFoundError") && (await this.#isThere())) return undefined;
      throw error;
    }
  }

  /**
   * Whether another file or a folder is at a name, which a move would replace. Where only the case
   * of a name changes, the browser on Windows finds the file itself at the new name, which it does
   * not take for the same: there a file is another one only when its name on the disk is just the
   * new one, as on Linux.
   */
  async #isAnotherAt(
    folder: DirectoryHandleLike,
    name: string,
    source: FileHandleLike,
    sameFolder: boolean,
  ): Promise<boolean> {
    let found: FileHandleLike;
    try {
      found = await folder.getFileHandle(name);
    } catch (error) {
      if (isNamed(error, "TypeMismatchError")) return true;
      if (isNamed(error, "NotFoundError")) return false;
      throw error;
    }
    if (await found.isSameEntry(source).catch(() => false)) return false;
    if (!sameFolder || sameNameKey(name) !== sameNameKey(source.name)) return true;
    for await (const entry of folder.values()) if (entry.name === name) return true;
    return false;
  }

  /**
   * Writes a file through a temporary one of the browser, which takes its place once it is all
   * there, with every other writer of this browser kept out. Then reads back what is there: all of
   * a small file, three pieces of a large one.
   */
  async #put(
    handle: FileHandleLike,
    content: Blob,
    path: string,
    { signal, onProgress, expected }: LocalWriteOptions,
    undo: () => Promise<void>,
  ): Promise<Written> {
    const writable = await handle.createWritable({ mode: "exclusive", keepExistingData: false });
    const kept = keeper(content.size);
    try {
      // Once no other writer of this browser can change it any more.
      if (expected !== undefined) {
        const now = await handle.getFile();
        const isAsExpected =
          expected === "absent" ? now.size === 0 : isSameSeen(statOf(now), statOf(expected));
        if (!isAsExpected) throw new FolderError("changed", path);
      }
      let bytes = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          kept.take(chunk);
          bytes += chunk.byteLength;
          onProgress?.(bytes);
          controller.enqueue(chunk);
        },
      });
      await content
        .stream()
        .pipeThrough(counter)
        .pipeTo(writable, signal ? { signal } : {});
    } catch (error) {
      await writable.abort().catch(() => {});
      await undo().catch(() => {});
      throw error;
    }
    const written = await handle.getFile();
    // Something else got there right after, and it is what there is now.
    if (written.size !== content.size) throw new FolderError("changed", path);
    for (const { start, bytes } of kept.pieces) {
      const there = new Uint8Array(await written.slice(start, start + bytes.length).arrayBuffer());
      if (!sameBytes(there, bytes)) throw new FolderError("changed", path);
    }
    const [whole] = kept.pieces;
    const hash = content.size <= HASHED_BYTES && whole ? hashOf(whole.bytes) : undefined;
    return { file: written, seen: { ...statOf(written), hash } };
  }

  /** Resolves to false where the browser cannot move the file, so that writing has to do it. */
  async #tryMove(
    handle: FileHandleLike,
    folder: DirectoryHandleLike,
    name: string,
    to: string,
  ): Promise<boolean> {
    if (typeof handle.move !== "function") return false;
    try {
      await handle.move(folder, name);
      return true;
    } catch (error) {
      // Writing would not get any further with these.
      if (isNamed(error, "InvalidModificationError")) {
        throw new FolderError("exists", to, { cause: error });
      }
      if (isNamed(error, "TypeError")) throw new FolderError("refused", to, { cause: error });
      if (isNamed(error, "NotFoundError", "NoModificationAllowedError", "QuotaExceededError")) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Moves a file by writing it at the new place, which nothing is at, and taking away the old one.
   * Where the old one changed in the meantime, both stay. Where it cannot be taken away, the copy
   * goes again, as long as it is still what this wrote, and otherwise both stay. Where both stay,
   * the error says so.
   */
  async #moveByCopy(
    handle: FileHandleLike,
    snapshot: File,
    { sourceFolder, sourceName, targetFolder, targetName }: Places,
    from: string,
    to: string,
    targetParts: readonly string[],
  ): Promise<void> {
    // What gets written is what was looked at. A document is read at once, a video as it goes.
    const content =
      snapshot.size <= READ_BACK_BYTES
        ? new Blob([
            await snapshot.arrayBuffer().catch(async (error: unknown) => {
              throw await this.#failure(error, from, false);
            }),
          ])
        : snapshot;
    const target = await this.#made(
      () => targetFolder.getFileHandle(targetName, { create: true }),
      targetParts,
      to,
    );
    const { seen } = await this.#put(target, content, to, { expected: "absent" }, () =>
      removeIfEmpty(targetFolder, targetName),
    ).catch(async (error: unknown) => {
      throw await this.#failure(error, to, true);
    });
    // From here on the copy is the editor's own.
    const now = await handle.getFile().catch(() => undefined);
    if (now && !isSameSeen(statOf(now), statOf(snapshot))) {
      this.#wrote(to, seen);
      throw new FolderError("changed", from, { copy: to });
    }
    try {
      await sourceFolder.removeEntry(sourceName);
    } catch (error) {
      // Gone already, which is all that was to happen to it.
      if (isNamed(error, "NotFoundError")) {
        this.#wrote(from, "absent");
        this.#wrote(to, seen);
        return;
      }
      const failure = await this.#failure(error, from, true);
      const copied = await target.getFile().catch(() => undefined);
      const isOwn = copied !== undefined && isSameSeen(statOf(copied), seen);
      const isUndone =
        isOwn &&
        (await targetFolder.removeEntry(targetName).then(
          () => true,
          () => false,
        ));
      if (isUndone) {
        this.#wrote(to, "absent");
        throw failure;
      }
      if (isOwn) this.#wrote(to, seen);
      throw new FolderError(failure.reason, from, { cause: error, copy: to });
    }
    this.#wrote(from, "absent");
    this.#wrote(to, seen);
  }

  /** What a watch sees of a file: missing is no failure, and nor is what cannot be told now. */
  async #look(path: string): Promise<File | undefined | "unknown"> {
    const parts = partsOf(path);
    if (!parts) return undefined;
    try {
      return await (await this.#fileAt(parts)).getFile();
    } catch (error) {
      const failure = await this.#failure(error, path, false);
      if (failure.reason === "missing" || failure.reason === "refused") return undefined;
      if (failure.reason === "gone" || failure.reason === "denied") throw failure;
      return "unknown";
    }
  }

  /** The files of a folder that matter, and of the folders in it that do. */
  async *#listIncluded(
    folderPath: string,
    includes: WatchOptions["includes"],
  ): AsyncGenerator<string> {
    const parts = folderPath === "" ? [] : partsOf(folderPath);
    if (!parts) return;
    const chain = await this.#chain(parts).catch(async (error: unknown) => {
      throw await this.#failure(error, folderPath, false);
    });
    const folder = chain?.at(-1);
    if (!folder) return;
    const prefix = folderPath === "" ? "" : `${folderPath}/`;
    for await (const path of this.#walk(folder, prefix, (inner) => includes(inner, "folder"))) {
      if (includes(path, "file")) yield path;
    }
  }

  /** The files below a folder, through the folders that `enter` lets in, apart from tools. */
  async *#walk(
    folder: DirectoryHandleLike,
    prefix: string,
    enter: (path: string) => boolean,
  ): AsyncGenerator<string> {
    let entries: HandleLike[];
    try {
      entries = (await collect(folder.values())).toSorted(byName);
    } catch (error) {
      const failure = await this.#failure(error, prefix.slice(0, -1), false);
      // A folder in it that went away on the way has nothing to give.
      if (prefix !== "" && failure.reason === "missing") return;
      throw failure;
    }
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "file") yield path;
      else if (!isToolFolder(entry.name) && enter(path))
        yield* this.#walk(entry, `${path}/`, enter);
    }
  }
}

function localFile(handle: FileHandleLike): LocalFile {
  const file: LocalFile = {
    name: handle.name,
    async read() {
      try {
        return await handle.getFile();
      } catch (error) {
        const reason: FolderFailure = isNamed(error, "NotFoundError")
          ? "missing"
          : isNamed(error, "NotAllowedError", "SecurityError")
            ? "denied"
            : "failed";
        throw new FolderError(reason, handle.name, { cause: error });
      }
    },
  };
  handles.set(file, handle);
  return file;
}

/** Folders on this computer, made of handles: of the browser, or of a disk in memory. */
export function createLocalFolders(environment: LocalFoldersEnvironment): LocalFolders {
  const folderOf = (handle: DirectoryHandleLike): LocalFolder =>
    new HandleFolder(handle, environment);
  const recordOf = ({ id, handle, project, name, openedAt }: StoredRecord): FolderRecord => ({
    id,
    folder: folderOf(handle),
    project,
    name,
    openedAt,
  });
  const newestFirst = (records: readonly StoredRecord[]) =>
    records.toSorted((a, b) => b.openedAt - a.openedAt);

  const records: FolderRecords = {
    list: async () => newestFirst(await environment.records.list()).map(recordOf),
    async get(id) {
      const stored = await environment.records.get(id);
      return stored && recordOf(stored);
    },
    async put({ id, folder, project, name, openedAt }) {
      await environment.records.put({ id, handle: directoryOf(folder), project, name, openedAt });
    },
    remove: (id) => environment.records.remove(id),
    async find(folder) {
      const handle = directoryOf(folder);
      for (const stored of newestFirst(await environment.records.list())) {
        if (await stored.handle.isSameEntry(handle).catch(() => false)) return recordOf(stored);
      }
      return undefined;
    },
    withProject: async (project) =>
      newestFirst(await environment.records.withProject(project)).map(recordOf),
  };

  return {
    async choose() {
      try {
        return folderOf(await environment.pick());
      } catch (error) {
        // Changing one's mind is no failure, and neither is a folder that the browser does not
        // give out, such as the documents themselves: it says why itself.
        if (isNamed(error, "AbortError")) return undefined;
        throw error;
      }
    },
    dropped(transfer) {
      // The browser lets go of what was dropped once the event is over, so all of it is asked for
      // right now, before anything waits.
      const asked = Array.from(transfer.items, (item) => {
        const { getAsFileSystemHandle } = item as DataTransferItem & {
          getAsFileSystemHandle?: () => Promise<HandleLike | null>;
        };
        return item.kind === "file" ? getAsFileSystemHandle?.call(item) : undefined;
      });
      return Promise.all(
        asked.map(async (handle): Promise<LocalEntry | undefined> => {
          let found: HandleLike | null | undefined;
          try {
            found = await handle;
          } catch (error) {
            // A folder that the browser does not give out, such as the documents themselves.
            if (!isNamed(error, "AbortError"))
              console.warn("What was dropped cannot be had", error);
            return undefined;
          }
          if (!found) return undefined;
          return found.kind === "directory"
            ? { kind: "folder", folder: folderOf(found) }
            : { kind: "file", file: localFile(found) };
        }),
      ).then((entries) => entries.filter((entry) => entry !== undefined));
    },
    records,
  };
}

type DirectoryPicker = (options: {
  readonly id: string;
  readonly mode: "readwrite";
}) => Promise<DirectoryHandleLike>;

/**
 * Folders on this computer, through the File System Access API. Undefined where a page cannot write
 * to them: Firefox and Safari, and Brave as it comes.
 */
export function browserLocalFolders(database: () => IDBFactory): LocalFolders | undefined {
  const scope = globalThis as {
    showDirectoryPicker?: DirectoryPicker;
    FileSystemObserver?: ObserverConstructor;
  };
  const { showDirectoryPicker } = scope;
  const canWrite =
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype;
  if (typeof showDirectoryPicker !== "function" || !canWrite) return undefined;
  return createLocalFolders({
    pick: () => showDirectoryPicker.call(globalThis, { id: PICKER_ID, mode: "readwrite" }),
    Observer: scope.FileSystemObserver,
    onFront(listener) {
      const onVisible = () => {
        if (document.visibilityState === "visible") listener();
      };
      document.addEventListener("visibilitychange", onVisible);
      addEventListener("focus", listener);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        removeEventListener("focus", listener);
      };
    },
    isHidden: () => document.visibilityState === "hidden",
    records: createRecordStore(database),
  });
}
