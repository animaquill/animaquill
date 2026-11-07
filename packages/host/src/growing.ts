import type { FileKind, GrowingFile } from "./index.ts";

/** Lets the browser come back to the place people used the last time. */
const PICKER_ID = "animaquill-exports";
/** Where files wait in the private folder of the site until they are finished. */
const SCRATCH_FOLDER = "exports";
/** A download takes the file from there, and it should be done after this. */
const KEEP_SCRATCH_MS = 60 * 60 * 1000;

export type SaveFilePicker = (options: {
  readonly id: string;
  readonly suggestedName: string;
  readonly types: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}) => Promise<FileSystemFileHandle>;

export interface GrowingFileOptions {
  readonly picker: SaveFilePicker | undefined;
  readonly scratch: (() => Promise<FileSystemDirectoryHandle>) | undefined;
  readonly saveFile: (file: Blob, name: string) => void;
}

/** What only Chrome has, so far. */
interface RemovableHandle extends FileSystemFileHandle {
  remove?: () => Promise<void>;
  queryPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
}

/** Where a file goes, in a way that survives the page: a handle can go into IndexedDB. */
export type FileTarget =
  | { readonly kind: "file"; readonly handle: FileSystemFileHandle }
  | { readonly kind: "download"; readonly name: string };

/** Opens a writable only when there is something to write: a long export writes at its end. */
function lazily(handle: FileSystemFileHandle) {
  let writable: Promise<FileSystemWritableFileStream> | undefined;
  return {
    get: () => (writable ??= handle.createWritable()),
    async abort() {
      const opened = await writable?.catch(() => undefined);
      await opened?.abort().catch(() => {});
    },
  };
}

/**
 * A file people chose. The browser writes into a copy of it next to it and only puts that in place
 * on `close`, so a stop halfway leaves the file as it was before: empty, because it is new.
 */
function chosenFile(handle: FileSystemFileHandle): GrowingFile {
  const writable = lazily(handle);
  return {
    name: handle.name,
    kind: "file",
    target: { kind: "file", handle } satisfies FileTarget,
    write: async (data, position) =>
      (await writable.get()).write({ type: "write", position, data }),
    finish: async () => (await writable.get()).close(),
    async abandon(others = []) {
      await writable.abort();
      // Only the empty file the dialog made is this one's to take away. What has something in it
      // now got that from somewhere else, and an empty one that another export goes to is its.
      if (await isAnyOf(handle, others)) return;
      const now = await handle.getFile().catch(() => undefined);
      if (!now || now.size > 0) return;
      const { remove } = handle as RemovableHandle;
      // Without a way to take it away an empty one stays.
      if (!remove) throw new Error("The file stays");
      await remove.call(handle);
    },
  };
}

/** A file people chose before, if it is still there and may still be written. */
export async function reopenedFile(
  handle: FileSystemFileHandle,
): Promise<GrowingFile | "gone" | "denied" | "taken"> {
  const { queryPermission, requestPermission } = handle as RemovableHandle;
  const options = { mode: "readwrite" } as const;
  let permission = (await queryPermission?.call(handle, options)) ?? "granted";
  if (permission !== "granted") {
    permission = (await requestPermission?.call(handle, options).catch(() => "denied")) ?? "denied";
  }
  if (permission !== "granted") return "denied";
  let now: File;
  try {
    now = await handle.getFile();
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") return "gone";
    throw error;
  }
  // An export only writes its file at the end, so until then it is empty. Something in it is from
  // somewhere else, maybe another export that went to the same place, and stays as it is.
  if (now.size > 0) return "taken";
  return chosenFile(handle);
}

/** What downloads left in the private folder of the site, once they are surely over. */
export async function cleanUpDownloads(
  scratch: () => Promise<FileSystemDirectoryHandle>,
): Promise<void> {
  const root = await scratch();
  const folder = await root.getDirectoryHandle(SCRATCH_FOLDER).catch(() => undefined);
  if (folder) await cleanUp(folder);
}

/** Old files of downloads that are surely over. Nothing else gets there. */
async function cleanUp(folder: FileSystemDirectoryHandle): Promise<void> {
  const now = Date.now();
  for await (const name of folder.keys()) {
    try {
      const file = await (await folder.getFileHandle(name)).getFile();
      if (now - file.lastModified > KEEP_SCRATCH_MS) await folder.removeEntry(name);
    } catch {
      // Whatever it is, it does no harm where it is.
    }
  }
}

/** A file in the private folder of the site, which becomes a download once it is finished. */
function downloadedFile(
  scratch: () => Promise<FileSystemDirectoryHandle>,
  name: string,
  kind: FileKind,
  saveFile: (file: Blob, name: string) => void,
): GrowingFile {
  const own = `${crypto.randomUUID()}.${kind.extension}`;
  let opened:
    Promise<{ folder: FileSystemDirectoryHandle; handle: FileSystemFileHandle }> | undefined;
  const open = () =>
    (opened ??= (async () => {
      const root = await scratch();
      const folder = await root.getDirectoryHandle(SCRATCH_FOLDER, { create: true });
      await cleanUp(folder);
      return { folder, handle: await folder.getFileHandle(own, { create: true }) };
    })());
  let writable: Promise<FileSystemWritableFileStream> | undefined;
  const writer = () => (writable ??= open().then(({ handle }) => handle.createWritable()));
  return {
    name,
    kind: "download",
    target: { kind: "download", name } satisfies FileTarget,
    write: async (data, position) => (await writer()).write({ type: "write", position, data }),
    async finish() {
      await (await writer()).close();
      // A file on the disk, so that the download does not take any memory either.
      saveFile(await (await open()).handle.getFile(), name);
    },
    async abandon() {
      if (!opened) return;
      const done = await writable?.catch(() => undefined);
      await done?.abort().catch(() => {});
      await (await open()).folder.removeEntry(own).catch(() => {});
    },
  };
}

/** Asks people where a file goes, or else makes it a download. */
export async function growingFile(
  name: string,
  kind: FileKind,
  { picker, scratch, saveFile }: GrowingFileOptions,
): Promise<GrowingFile | undefined> {
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        id: PICKER_ID,
        suggestedName: name,
        types: [{ description: kind.description, accept: { [kind.mime]: [`.${kind.extension}`] } }],
      });
    } catch (error) {
      // Dismissing the dialog is not a failure.
      if (error instanceof Error && error.name === "AbortError") return undefined;
      throw error;
    }
    return chosenFile(handle);
  }
  if (!scratch) throw new Error("No way to save a file here");
  return downloadedFile(scratch, name, kind, saveFile);
}

/**
 * Takes away the file of an export that was given up, as far as it is still the empty one the
 * dialog made, and no other export in `others` is going to write to it: two exports may have been
 * told the same place. With `ask` the browser may ask first, which has to run right after people
 * did something; without it nothing asks, and a file that would need that stays. Resolves to
 * whether an empty file stays behind. A download has nothing to take away: what it leaves in the
 * private folder of the site goes by itself.
 */
export async function dropTarget(
  target: unknown,
  others: readonly unknown[],
  ask: boolean,
): Promise<boolean> {
  const known = target as FileTarget | undefined;
  if (known?.kind !== "file") return false;
  const { handle } = known;
  if (await isAnyOf(handle, others)) return false;
  const { queryPermission, requestPermission, remove } = handle as RemovableHandle;
  const options = { mode: "readwrite" } as const;
  let permission =
    (await queryPermission?.call(handle, options).catch(() => "denied")) ?? "granted";
  if (permission === "prompt" && ask) {
    permission = (await requestPermission?.call(handle, options).catch(() => "denied")) ?? "denied";
  }
  if (permission !== "granted") return true;
  const now = await handle.getFile().catch(() => undefined);
  // Gone, or with something in it from somewhere else: not this one's to take away.
  if (!now || now.size > 0) return false;
  if (!remove) return true;
  return remove.call(handle).then(
    () => false,
    () => true,
  );
}

/**
 * Whether one of the targets is this file. When the browser cannot say, it might be: what goes
 * wrong here must not take away a file that is somebody else's.
 */
async function isAnyOf(handle: FileSystemFileHandle, others: readonly unknown[]): Promise<boolean> {
  for (const other of others) {
    const theirs = other as FileTarget | undefined;
    if (theirs?.kind !== "file") continue;
    if (await handle.isSameEntry(theirs.handle).catch(() => true)) return true;
  }
  return false;
}

/** The same file as before, from a target that survived the page. */
export async function reopenTarget(
  target: unknown,
  kind: FileKind,
  { scratch, saveFile }: GrowingFileOptions,
): Promise<GrowingFile | "gone" | "denied" | "taken"> {
  const known = target as FileTarget | undefined;
  if (known?.kind === "file") return reopenedFile(known.handle);
  if (known?.kind === "download" && scratch) {
    return downloadedFile(scratch, known.name, kind, saveFile);
  }
  return "gone";
}
