import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { RelativePath } from "@animaquill/schema";
import { isToolFolder, type ReadableFile, type ReadOnlyFolder } from "./read-folder.ts";

/** Never through a link, where the system can say so. */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Failures go by the names browsers give them, so that they can be told apart the same way. */
const failure = (name: string, message: string) => Object.assign(new Error(message), { name });

/** A file that went on to be something else is not the one that was looked at, as in browsers. */
const changed = (path: string) =>
  failure("NotReadableError", `${path} changed after it was looked at`);

async function* walk(root: string, folder: string): AsyncGenerator<string> {
  const entries = await readdir(join(root, folder), { withFileTypes: true });
  // The same order on every disk, so that what is said about a folder is said the same way.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!isToolFolder(entry.name)) yield* walk(root, path);
    } else if (entry.isFile()) {
      yield path;
    }
    // Links stay out, as in a browser, and so does whatever is no file.
  }
}

/**
 * Where a file of the folder is on the disk. Only one way of writing each path counts, and it has
 * to be inside of the folder without a link on the way: project content comes from anybody, and a
 * link can point anywhere.
 */
async function placeOf(inside: string, path: string): Promise<string> {
  const place = join(inside, path);
  if (place !== `${inside}${path.replaceAll("/", sep)}` || (await realpath(place)) !== place) {
    throw failure("NotFoundError", `${path} is no file of the folder`);
  }
  return place;
}

async function contentOf(place: string, path: string, seen: Stats): Promise<ArrayBuffer> {
  const handle = await open(place, READ);
  try {
    const now = await handle.stat();
    const isSame = now.isFile() && now.size === seen.size && now.mtimeMs === seen.mtimeMs;
    if (!isSame) throw changed(path);
    const bytes = await handle.readFile();
    // It can also change while it is being read.
    if (bytes.byteLength !== seen.size) throw changed(path);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  } finally {
    await handle.close();
  }
}

/**
 * A folder on a disk, for Node: tools, the platform, an AI in a container. It reads what a browser
 * would read of it, so that a project is the same project wherever it is opened.
 */
export async function diskFolder(folder: string): Promise<ReadOnlyFolder> {
  const root = await realpath(folder);
  const isFolder = (await stat(root)).isDirectory();
  if (!isFolder) throw failure("TypeMismatchError", `${folder} is no folder`);
  const inside = root.endsWith(sep) ? root : `${root}${sep}`;
  return {
    list: () => walk(root, ""),
    async file(path): Promise<ReadableFile> {
      const place = await placeOf(inside, path);
      const seen = await stat(place);
      if (!seen.isFile()) throw failure("TypeMismatchError", `${path} is no file`);
      return { size: seen.size, arrayBuffer: () => contentOf(place, path, seen) };
    },
  };
}

/** What a file on the disk looks like, to tell whether it changed since. */
export interface DiskStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Writes the files of a folder on a disk, for Node, as a command line does. Each path stays inside
 * of the folder, and no link on the way is followed, nor one where the file goes: whatever writes
 * here takes paths from AI and from project content, and a link can point anywhere. A file is
 * written whole or not at all: first next to the project, in `.animaquill/tmp`, then renamed into
 * its place, so that a program that reads the folder meanwhile, such as the editor, sees the old
 * file or the new one.
 */
export interface DiskWriter {
  /** How the file looks now; undefined when there is none. Rejects for a link or a folder. */
  stat(path: string): Promise<DiskStat | undefined>;
  /** Writes it, making the folders it is in, and says how it looks then. */
  write(path: string, content: string | Uint8Array): Promise<DiskStat>;
  /** Takes it away. A file that is not there is fine. */
  remove(path: string): Promise<void>;
}

/** Where a write waits before it is renamed into its place, which nothing reads. */
export const SCRATCH_FOLDER = ".animaquill/tmp";

/** A path that can only be inside of the folder, on every system. */
function assertInside(path: string): void {
  const fits =
    RelativePath.safeParse(path).success &&
    // A drive or a stream of a file on Windows, and what no system takes in a name.
    !path.split("/").some((part) => part.includes(":") || part.includes("\0"));
  if (!fits) throw failure("SecurityError", `${path} is no path inside of the folder`);
}

/** What is at a place, without following a link there. */
async function lookAt(place: string): Promise<Stats | undefined> {
  try {
    return await lstat(place);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A file to write or take away: a file, or nothing, and never a link or a folder. */
async function fileAt(place: string, path: string): Promise<Stats | undefined> {
  const seen = await lookAt(place);
  if (seen && !seen.isFile()) {
    const what = seen.isSymbolicLink() ? "a link" : "no file";
    throw failure("TypeMismatchError", `${path} is ${what}, which is not written`);
  }
  return seen;
}

const statOf = ({ size, mtimeMs }: Stats): DiskStat => ({ size, mtimeMs });

export async function diskWriter(folder: string): Promise<DiskWriter> {
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) {
    throw failure("TypeMismatchError", `${folder} is no folder`);
  }

  /** The folder a path is in, made where it is not there, each step a folder and no link. */
  async function folderOf(path: string, create: boolean): Promise<string | undefined> {
    let place = root;
    for (const part of path.split("/").slice(0, -1)) {
      place = join(place, part);
      let seen = await lookAt(place);
      if (!seen) {
        if (!create) return undefined;
        try {
          await mkdir(place);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        seen = await lookAt(place);
      }
      if (!seen?.isDirectory()) {
        throw failure("TypeMismatchError", `${path} goes through ${part}, which is no folder`);
      }
    }
    // Nothing on the way was a link, so this is where it says: inside of the folder.
    return place;
  }

  const placeOfFile = async (path: string, create: boolean) => {
    assertInside(path);
    const inside = await folderOf(path, create);
    return inside && join(inside, path.split("/").at(-1) as string);
  };

  return {
    async stat(path) {
      const place = await placeOfFile(path, false);
      const seen = place && (await fileAt(place, path));
      return seen ? statOf(seen) : undefined;
    },
    async write(path, content) {
      const place = (await placeOfFile(path, true)) as string;
      await fileAt(place, path);
      const scratch = (await folderOf(`${SCRATCH_FOLDER}/file`, true)) as string;
      const waiting = join(scratch, `${randomBytes(8).toString("hex")}.part`);
      const handle = await open(
        waiting,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
      try {
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A link that turned up meanwhile is replaced, not followed.
        await rename(waiting, place);
      } catch (error) {
        await rm(waiting, { force: true });
        throw error;
      }
      return statOf(await lstat(place));
    },
    async remove(path) {
      const place = await placeOfFile(path, false);
      if (!place || !(await fileAt(place, path))) return;
      try {
        await unlink(place);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
