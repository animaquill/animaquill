import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
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
