import type {
  FolderAccess,
  FolderFile,
  SourceFolder,
  TargetFolder,
  WriteOptions,
} from "./index.ts";
import { folderNameFor, partsOf } from "./paths.ts";
import { zipTarget } from "./zip.ts";

/** Lets the browser come back to the place people used the last time. */
const PICKER_ID = "animaquill-projects";
/** Folders that belong to tools. A project can be a Git repository. */
const TOOL_FOLDERS = new Set([".git", ".animaquill", "node_modules"]);
/** A folder asked for by a name that is taken gets a number, within reason. */
const MAX_NUMBER = 1000;

type DirectoryPicker = (options: {
  readonly id: string;
  readonly mode: "read" | "readwrite";
}) => Promise<FileSystemDirectoryHandle>;

export interface FolderAccessOptions {
  /** Missing in browsers that cannot give out folders. */
  readonly picker: () => DirectoryPicker | undefined;
  /** Lets people choose a folder the old way. Resolves to its files, or undefined if cancelled. */
  readonly chooseFiles: () => Promise<readonly File[] | undefined>;
  readonly saveFile: (file: Blob, name: string) => void;
}

const isNamed = (error: unknown, ...names: readonly string[]) =>
  error instanceof Error && names.includes(error.name);

async function* walk(
  folder: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<FolderFile> {
  for await (const handle of folder.values()) {
    const path = `${prefix}${handle.name}`;
    if (handle.kind === "file") yield { path, read: () => handle.getFile() };
    else if (!TOOL_FOLDERS.has(handle.name)) yield* walk(handle, `${path}/`);
  }
}

/** What the old way gives: paths start with the folder people chose. */
export function sourceFromFiles(files: readonly File[]): SourceFolder {
  return {
    name: files[0]?.webkitRelativePath.split("/")[0] ?? "",
    async *files() {
      for (const file of files) {
        const [, ...parts] = file.webkitRelativePath.split("/");
        if (parts.slice(0, -1).some((part) => TOOL_FOLDERS.has(part))) continue;
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

async function folderOf(
  root: FileSystemDirectoryHandle,
  parts: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder;
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
      const folder = await folderOf(root, parts.slice(0, -1), true);
      const file = await folder.getFileHandle(parts.at(-1) as string, { create: true });
      await writeFile(file, content, options);
    },
    async remove(path) {
      const parts = partsOf(path);
      const folder = await folderOf(root, parts.slice(0, -1), false);
      await folder.removeEntry(parts.at(-1) as string);
    },
    async finish() {},
    async abandon() {
      await parent.removeEntry(name, { recursive: true });
    },
  };
}

/** Folders through the File System Access API, and what is left of that where it is missing. */
export function createFolderAccess(options: FolderAccessOptions): FolderAccess {
  const { picker, chooseFiles, saveFile } = options;

  /** Dismissing the dialog is not a failure. */
  const pick = async (show: DirectoryPicker, mode: "read" | "readwrite") => {
    try {
      return await show({ id: PICKER_ID, mode });
    } catch (error) {
      if (isNamed(error, "AbortError")) return undefined;
      throw error;
    }
  };

  return {
    async chooseSource() {
      const show = picker();
      if (show) {
        const folder = await pick(show, "read");
        return folder && { name: folder.name, files: () => walk(folder, "") };
      }
      const files = await chooseFiles();
      return files && sourceFromFiles(files);
    },
    async chooseTarget(name) {
      const wanted = folderNameFor(name);
      const show = picker();
      if (!show) return zipTarget(wanted, saveFile);
      const parent = await pick(show, "readwrite");
      if (!parent) return undefined;
      const free = await freeName(parent, wanted);
      return directoryTarget(parent, await parent.getDirectoryHandle(free, { create: true }));
    },
  };
}

/** The old way to get a folder, which all browsers on computers have. */
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

export const browserFolders = (): FolderAccess =>
  createFolderAccess({
    picker: () =>
      (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker?.bind(
        globalThis,
      ),
    chooseFiles: chooseFilesWithInput,
    saveFile: saveWithLink,
  });
