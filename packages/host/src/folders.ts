import {
  cleanUpDownloads,
  dropTarget,
  growingFile,
  reopenTarget,
  type SaveFilePicker,
} from "./growing.ts";
import type { FolderAccess, SourceFolder, TargetFolder, WriteOptions } from "./index.ts";
import { FALLBACK_NAME, fileNameFor, folderNameFor, isToolFolder, partsOf } from "./paths.ts";
import { zipTarget } from "./zip.ts";

/** Lets the browser come back to the place people used the last time. */
const PICKER_ID = "animaquill-projects";
/** A folder asked for by a name that is taken gets a number, within reason. */
const MAX_NUMBER = 1000;
/**
 * Stopping a write ends before the browser has let go of the file, and until then the folder
 * around it cannot be removed. That is over in moments. What takes longer is not the browser.
 */
const REMOVE_WAITS_MS = [50, 100, 200, 400, 800];

type DirectoryPicker = (options: {
  readonly id: string;
  readonly mode: "readwrite";
}) => Promise<FileSystemDirectoryHandle>;

export interface FolderAccessOptions {
  /** Missing in browsers that cannot give out folders. */
  readonly picker: () => DirectoryPicker | undefined;
  /** Lets people choose a folder to read. Resolves to its files, or undefined if cancelled. */
  readonly chooseFiles: () => Promise<readonly File[] | undefined>;
  readonly saveFile: (file: Blob, name: string) => void;
  /** Missing in browsers that cannot give out files to write. */
  readonly savePicker?: () => SaveFilePicker | undefined;
  /** The private folder of the site, for a file that goes to the downloads once it is finished. */
  readonly scratch?: () => Promise<FileSystemDirectoryHandle>;
}

const isNamed = (error: unknown, ...names: readonly string[]) =>
  error instanceof Error && names.includes(error.name);

/** What the browser answers for a name it does not allow, or a file where a folder should be. */
const isRefusal = (error: unknown) =>
  error instanceof TypeError || isNamed(error, "TypeMismatchError");

/** What choosing a folder gives: paths start with the folder people chose. */
export function sourceFromFiles(files: readonly File[]): SourceFolder {
  return {
    name: files[0]?.webkitRelativePath.split("/")[0] ?? "",
    async *files() {
      for (const file of files) {
        const [, ...parts] = file.webkitRelativePath.split("/");
        if (parts.slice(0, -1).some(isToolFolder)) continue;
        yield { path: parts.join("/"), read: async () => file };
      }
    },
  };
}

async function exists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getDirectoryHandle(name);
    return true;
  } catch (error) {
    // A file of that name is in the way just the same.
    if (isNamed(error, "TypeMismatchError")) return true;
    if (isNamed(error, "NotFoundError")) return false;
    throw error;
  }
}

async function freeName(folder: FileSystemDirectoryHandle, name: string): Promise<string> {
  for (let number = 1; number <= MAX_NUMBER; number++) {
    const candidate = number === 1 ? name : `${name} (${number})`;
    if (!(await exists(folder, candidate))) return candidate;
  }
  throw new Error(`No free folder name for ${name}`);
}

/** The rules of browsers for names can change, and a backup should not depend on them. */
async function nameFor(folder: FileSystemDirectoryHandle, wanted: string): Promise<string> {
  try {
    return await freeName(folder, wanted);
  } catch (error) {
    if (error instanceof TypeError) return freeName(folder, FALLBACK_NAME);
    throw error;
  }
}

async function folderOf(
  root: FileSystemDirectoryHandle,
  parts: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder;
}

/** Resolves to undefined for a path that cannot exist here. */
async function fileAt(
  root: FileSystemDirectoryHandle,
  parts: readonly [string, ...string[]],
): Promise<FileSystemFileHandle | undefined> {
  try {
    const folder = await folderOf(root, parts.slice(0, -1), true);
    return await folder.getFileHandle(parts.at(-1) as string, { create: true });
  } catch (error) {
    if (isRefusal(error)) return undefined;
    throw error;
  }
}

/** Writes through a temporary file of the browser, so a file stopped halfway does not exist. */
async function writeFile(
  file: FileSystemFileHandle,
  content: Blob,
  { signal, onProgress }: WriteOptions,
): Promise<void> {
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      onProgress?.(bytes);
      controller.enqueue(chunk);
    },
  });
  const writable = await file.createWritable();
  await content
    .stream()
    .pipeThrough(counter)
    .pipeTo(writable, signal ? { signal } : {});
  const written = await file.getFile();
  if (written.size !== content.size) {
    throw new Error(`${file.name}: ${written.size} of ${content.size} bytes arrived`);
  }
}

async function removeFolder(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
  for (const wait of REMOVE_WAITS_MS) {
    try {
      await parent.removeEntry(name, { recursive: true });
      return;
    } catch (error) {
      if (!isNamed(error, "NoModificationAllowedError")) throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, wait);
    });
  }
  await parent.removeEntry(name, { recursive: true });
}

function directoryTarget(
  parent: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
): TargetFolder {
  const { name } = root;
  return {
    name,
    kind: "folder",
    async write(path, content, options = {}) {
      const parts = partsOf(path);
      const file = parts && (await fileAt(root, parts));
      if (!file) return false;
      await writeFile(file, content, options);
      return true;
    },
    async remove(path) {
      const parts = partsOf(path);
      if (!parts) return;
      const folder = await folderOf(root, parts.slice(0, -1), false);
      await folder.removeEntry(parts.at(-1) as string);
    },
    async finish() {},
    async abandon() {
      await removeFolder(parent, name);
    },
  };
}

/** How people get to folders, in the ways that do not lose anything without saying so. */
export function createFolderAccess(options: FolderAccessOptions): FolderAccess {
  const { picker, chooseFiles, saveFile, savePicker, scratch } = options;

  return {
    asksToUpload: true,
    /**
     * Not through the File System Access API, although it is the nicer dialog. On a real disk it
     * does not show what it would not let a page create either, such as aux.js, con/, ~draft.html
     * or a name with a joined emoji. Nothing says so, and those files would be gone without a word.
     */
    async chooseSource() {
      const files = await chooseFiles();
      return files && sourceFromFiles(files);
    },
    async chooseTarget(name) {
      const wanted = folderNameFor(name);
      const show = picker();
      if (!show) return zipTarget(wanted, saveFile);
      let parent: FileSystemDirectoryHandle;
      try {
        parent = await show({ id: PICKER_ID, mode: "readwrite" });
      } catch (error) {
        // Dismissing the dialog is not a failure.
        if (isNamed(error, "AbortError")) return undefined;
        throw error;
      }
      const free = await nameFor(parent, wanted);
      return directoryTarget(parent, await parent.getDirectoryHandle(free, { create: true }));
    },
    saveFile(file, name) {
      saveFile(file, fileNameFor(name));
    },
    chooseFile: (name, kind) =>
      growingFile(fileNameFor(name), kind, { picker: savePicker?.(), scratch, saveFile }),
    reopen: (target, kind) =>
      reopenTarget(target, kind, { picker: savePicker?.(), scratch, saveFile }),
    dropTarget,
    get savesInBrowser() {
      return !savePicker?.();
    },
  };
}

/** All browsers on computers can do this. */
function chooseFilesWithInput(): Promise<readonly File[] | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}

/** Long enough for the browser to have taken over, which only has to start in that time. */
const KEEP_DOWNLOAD_MS = 60_000;

function saveWithLink(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_DOWNLOAD_MS);
}

/** A page that starts takes away what downloads of exports left, a while before. */
const CLEAN_UP_AFTER_MS = 10_000;

export function browserFolders(): FolderAccess {
  const scratch = () => navigator.storage.getDirectory();
  setTimeout(() => {
    cleanUpDownloads(scratch).catch((error: unknown) => {
      console.warn("Downloads of exports stay for now", error);
    });
  }, CLEAN_UP_AFTER_MS);
  return createFolderAccess({
    picker: () =>
      (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker?.bind(
        globalThis,
      ),
    chooseFiles: chooseFilesWithInput,
    saveFile: saveWithLink,
    savePicker: () =>
      (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker?.bind(globalThis),
    scratch,
  });
}
