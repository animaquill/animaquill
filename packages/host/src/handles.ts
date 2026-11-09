/**
 * What folders on this computer are made of, as far as the editor uses it: the File System Access
 * API of the browser, and what tells about changes, `FileSystemObserver`. Only Chrome and Edge have
 * all of it. A disk in memory has it too, for tests: see memory-disk.ts.
 */

export type PermissionMode = "read" | "readwrite";

interface Permissions {
  /** Only Chrome has these, so far. */
  queryPermission?(descriptor: { readonly mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { readonly mode: PermissionMode }): Promise<PermissionState>;
}

export interface CreateWritableOptions {
  /** "exclusive" keeps every other writer out, of this page and of other ones in the browser. */
  readonly mode?: "exclusive" | "siloed";
  readonly keepExistingData?: boolean;
}

/**
 * What a writable of a file takes: bytes that go after what came before, or bytes for a place in
 * the file, anywhere, as `FileSystemWritableFileStream` has it.
 */
export type WriteChunk =
  Uint8Array | { readonly type: "write"; readonly position: number; readonly data: Uint8Array };

export interface FileHandleLike extends Permissions {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: CreateWritableOptions): Promise<WritableStream<WriteChunk>>;
  /** Only Chrome has this, for files. It replaces what is at the new place without a word. */
  move?(parent: DirectoryHandleLike, name: string): Promise<void>;
  isSameEntry(other: HandleLike): Promise<boolean>;
}

export interface DirectoryHandleLike extends Permissions {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { readonly recursive?: boolean }): Promise<void>;
  /** Leaves out what Chrome does not allow as a name, see `chromeRefuses`. */
  values(): AsyncIterable<HandleLike>;
  isSameEntry(other: HandleLike): Promise<boolean>;
  resolve(possibleDescendant: HandleLike): Promise<string[] | null>;
}

export type HandleLike = FileHandleLike | DirectoryHandleLike;

/** One change, as `FileSystemObserver` tells it. Paths are from the folder that is watched. */
export interface ChangeRecordLike {
  readonly type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
  readonly relativePathComponents: readonly string[];
  readonly relativePathMovedFrom?: readonly string[] | null;
  /** What changed. Chrome has none for what disappeared. */
  readonly changedHandle?: { readonly kind: "file" | "directory" } | null;
}

export interface ObserverLike {
  observe(handle: DirectoryHandleLike, options: { readonly recursive: boolean }): Promise<void>;
  disconnect(): void;
}

export type ObserverConstructor = new (
  callback: (records: readonly ChangeRecordLike[]) => void,
) => ObserverLike;

/** Whether this is an error of one of these names, as the browser names them. */
export const isNamed = (error: unknown, ...names: readonly string[]): boolean =>
  error instanceof Error && names.includes(error.name);
