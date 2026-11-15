import { createHash } from "node:crypto";
import { MANIFEST_FILE } from "@animaquill/schema";
import {
  INCOMPLETE_FILE,
  ProjectStore,
  folderBatch,
  inRanks,
  isProjectFile,
  readFolder,
  type FileChange,
  type FolderReading,
  type ReadableFile,
  type ReadOnlyFolder,
} from "@animaquill/core";
import {
  diskFolder,
  diskWriter,
  type DiskStat,
  type DiskWriter,
} from "@animaquill/core/disk-folder";

/**
 * A project folder on this computer, open as a project for the tools: what a command line and the
 * local MCP work on. The folder is the project. Before each call, what changed in it since (the
 * editor, people, Git) comes in the way the editor takes in a folder (`mergeFiles`, as a batch of
 * its own, `folderBatch`), so that the tools tell what others changed; after a change, the files
 * that changed are written back, what others refer to first and animaquill.json last.
 *
 * There is no lock between this and an editor on the same folder (local-projects.md 4.3): each
 * looks at a file right before it writes it, and a file that changed meanwhile comes in first.
 */

/**
 * Why the folder is no project right now, as the last look found: animaquill.json went away, or an
 * export is being written into it. Nothing comes in or goes out until it is one again.
 */
export type FolderTrouble = "manifest-gone" | "incomplete";

/** What this side last read or wrote of a file: its base for a merge. */
interface Known {
  /** Undefined for a file that is no text, which stays as it is. */
  readonly text: string | undefined;
  readonly stat: DiskStat;
}

/** What one round of writing did, for the note of the batch. */
export interface Written {
  readonly path: string;
  /** SHA-256 of what it holds now, in hex; undefined when it was taken away. */
  readonly hash: string | undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const textOf = (bytes: ArrayBuffer): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

export const hashOf = (text: string): string =>
  createHash("sha256").update(encoder.encode(text)).digest("hex");

const sameStat = (a: DiskStat | undefined, b: DiskStat | undefined) =>
  a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;

/** A file that changed while it was read is read again, a few times at the most. */
const READ_ATTEMPTS = 3;

/** How many rounds of "it changed right before writing" come in before writing gives up for now. */
const WRITE_ROUNDS = 3;

/** The folder as it is now: the files of the project in it, by how they look. */
interface Look {
  readonly stats: ReadonlyMap<string, DiskStat>;
}

export class FolderProject {
  readonly root: string;
  readonly store: ProjectStore;
  /** What reading the folder found as it opened: what stayed out, and why. */
  readonly reading: FolderReading;
  readonly #folder: ReadOnlyFolder;
  readonly #writer: DiskWriter;
  /** Files of the project, as this side last read or wrote them. */
  readonly #known: Map<string, Known>;
  /** What the project was as files the last time they were written or read, by path. */
  #exported: Map<string, string>;
  /** Files whose change could not come in: they are not written over, nor taken away. */
  readonly #blocked = new Set<string>();
  #batches = 0;
  #trouble: FolderTrouble | undefined;
  #unwritten = false;

  private constructor(
    root: string,
    store: ProjectStore,
    folder: ReadOnlyFolder,
    writer: DiskWriter,
    known: Map<string, Known>,
    reading: FolderReading,
  ) {
    this.root = root;
    this.store = store;
    this.reading = reading;
    this.#folder = folder;
    this.#writer = writer;
    this.#known = known;
    this.#exported = store.exportFiles().files;
  }

  /**
   * Opens the project in a folder, which has to have animaquill.json at its top. Rejects with
   * `FolderRefused` when it cannot be a project, as the editor would.
   */
  static async open(root: string): Promise<FolderProject> {
    const folder = await diskFolder(root);
    const writer = await diskWriter(root);
    const { known, texts } = await readAll(folder, writer);
    // What was read, as it was read: the project and the bases are of the same moment.
    const reading = await readFolder(snapshotOf(texts, known));
    const store = ProjectStore.create(reading.project, reading.sources);
    return new FolderProject(root, store, folder, writer, known, reading);
  }

  /** The files of the project that are in the folder now, by how they look. */
  async #look(): Promise<Look> {
    const stats = new Map<string, DiskStat>();
    for await (const path of this.#folder.list()) {
      if (!isTracked(path)) continue;
      const seen = await this.#writer.stat(path).catch(() => undefined);
      if (seen) stats.set(path, seen);
    }
    return { stats };
  }

  /**
   * Takes in what changed in the folder since it was last read or written, by size and time of
   * each file: one batch, which the user can take back as a whole. Says whether anything came in.
   */
  async refresh(): Promise<boolean> {
    const { stats } = await this.#look();
    this.#trouble = !stats.has(MANIFEST_FILE)
      ? "manifest-gone"
      : stats.has(INCOMPLETE_FILE)
        ? "incomplete"
        : undefined;
    if (this.#trouble) return false;
    const changes: FileChange[] = [];
    const seen = new Map<string, Known | undefined>();
    for (const path of new Set([...stats.keys(), ...this.#known.keys()])) {
      const known = this.#known.get(path);
      const now = stats.get(path);
      if (sameStat(known?.stat, now)) continue;
      const read = now ? await readKnown(this.#folder, this.#writer, path) : undefined;
      seen.set(path, read);
      if (read && read.text === undefined) {
        // No text: it stays as it is, and is not written over.
        this.#blocked.add(path);
        this.#known.set(path, { text: known?.text, stat: read.stat });
        continue;
      }
      if (read?.text === known?.text) {
        // Touched, not changed.
        if (read) this.#known.set(path, read);
        continue;
      }
      changes.push({ path, base: known?.text, text: read?.text });
    }
    if (changes.length === 0) return false;
    const origin = folderBatch(`mcp-${process.pid}-${++this.#batches}`);
    const result = this.store.mergeFiles(changes, {
      origin,
      baseOf: (path) => this.#known.get(path)?.text,
    });
    if (!result.ok) {
      // Nothing came in. The files keep their bases, and are not written over until it does.
      for (const { path } of changes) this.#blocked.add(path);
      return false;
    }
    const after = this.store.exportFiles().files;
    for (const file of result.files) {
      const read = seen.get(file.path);
      if (file.status === "blocked") {
        this.#blocked.add(file.path);
        // It keeps its old base, and is looked at again once it changes.
        const base = this.#known.get(file.path)?.text;
        if (read) this.#known.set(file.path, { text: base, stat: read.stat });
        continue;
      }
      this.#blocked.delete(file.path);
      if (read) this.#known.set(file.path, read);
      else this.#known.delete(file.path);
      // What came in is what the file holds: nothing to write back, unless the project keeps
      // something else in it now.
      if (!file.rewrite) {
        const text = after.get(file.path);
        if (text === undefined) this.#exported.delete(file.path);
        else this.#exported.set(file.path, text);
      }
    }
    return result.patches.length > 0;
  }

  /**
   * Writes what the project changed since it was last written or read: files whose text changed,
   * and takes away the files the project no longer has. A file that changed in the folder since it
   * was looked at comes in first. Resolves to what was written.
   */
  async save(): Promise<readonly Written[]> {
    const written: Written[] = [];
    if (this.#trouble) return written;
    for (let round = 0; round < WRITE_ROUNDS; round++) {
      const { files, problems } = this.store.exportFiles();
      // A document that does not fit the format is not written, and not taken away either.
      const unfit = new Set(problems.map(({ file }) => file));
      const writes = [...files].filter(
        ([path, text]) =>
          !this.#blocked.has(path) &&
          this.#exported.get(path) !== text &&
          this.#known.get(path)?.text !== text,
      );
      const removals = [...this.#exported.keys()].filter(
        (path) =>
          !files.has(path) && !unfit.has(path) && !this.#blocked.has(path) && this.#known.has(path),
      );
      const changed = [...writes.map(([path]) => path), ...removals];
      if (changed.length === 0) {
        this.#exported = new Map([...files].filter(([path]) => !this.#blocked.has(path)));
        this.#unwritten = false;
        return written;
      }
      // The folder has to be what was seen of it, or what changed there comes in first.
      let isStale = false;
      for (const path of changed) {
        const now = await this.#writer.stat(path).catch(() => undefined);
        if (!sameStat(now, this.#known.get(path)?.stat)) isStale = true;
      }
      if (isStale) {
        await this.refresh();
        continue;
      }
      const texts = new Map(writes);
      for (const rank of inRanks(texts.keys())) {
        for (const path of rank) {
          const text = texts.get(path) as string;
          const stat = await this.#writer.write(path, text);
          this.#known.set(path, { text, stat });
          this.#exported.set(path, text);
          written.push({ path, hash: hashOf(text) });
        }
      }
      for (const rank of inRanks(removals, true)) {
        for (const path of rank) {
          await this.#writer.remove(path);
          this.#known.delete(path);
          this.#exported.delete(path);
          written.push({ path, hash: undefined });
        }
      }
    }
    // The folder kept changing right before each write: what is left goes with the next save.
    this.#unwritten = true;
    return written;
  }

  /** The last `save` left changes unwritten, because the folder kept changing meanwhile. */
  get unwritten(): boolean {
    return this.#unwritten;
  }

  /** Why the folder is no project right now, as the last `refresh` found. */
  get trouble(): FolderTrouble | undefined {
    return this.#trouble;
  }

  /** The writer of the folder, for what goes next to the project in `.animaquill`. */
  get writer(): DiskWriter {
    return this.#writer;
  }

  destroy(): void {
    this.store.destroy();
  }
}

/** Files that belong to the project as the format has them, and what says an export is unfinished. */
const isTracked = (path: string) => isProjectFile(path) || path === INCOMPLETE_FILE;

async function readKnown(
  folder: ReadOnlyFolder,
  writer: DiskWriter,
  path: string,
): Promise<Known | undefined> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      const file = await folder.file(path);
      const text = textOf(await file.arrayBuffer());
      const stat = await writer.stat(path);
      if (!stat) return undefined;
      if (stat.size === file.size) return { text, stat };
    } catch (error) {
      if ((error as Error).name === "NotFoundError") return undefined;
      if ((error as Error).name !== "NotReadableError") throw error;
    }
  }
  throw Object.assign(new Error(`${path} kept changing while it was read`), {
    name: "NotReadableError",
  });
}

/** Every file of the project, read once. */
async function readAll(
  folder: ReadOnlyFolder,
  writer: DiskWriter,
): Promise<{ known: Map<string, Known>; texts: Map<string, string | undefined> }> {
  const known = new Map<string, Known>();
  const texts = new Map<string, string | undefined>();
  for await (const path of folder.list()) {
    if (path.includes("/") && !isTracked(path)) continue;
    const read = isTracked(path) ? await readKnown(folder, writer, path) : undefined;
    if (isTracked(path) && !read) continue;
    texts.set(path, read?.text);
    if (read) known.set(path, read);
  }
  return { known, texts };
}

/**
 * The folder as it was read, for `readFolder`: the same texts as the bases, whatever happens on the
 * disk meanwhile. What is no project file only shows in the list.
 */
function snapshotOf(
  texts: ReadonlyMap<string, string | undefined>,
  known: ReadonlyMap<string, Known>,
): ReadOnlyFolder {
  return {
    async *list() {
      yield* texts.keys();
    },
    async file(path): Promise<ReadableFile> {
      const text = texts.get(path);
      const stat = known.get(path)?.stat;
      if (text === undefined) {
        // No text: a file of the project that is not readable as such, which reading reports.
        return { size: stat?.size ?? 0, arrayBuffer: async () => new Uint8Array([0xff]).buffer };
      }
      const bytes = encoder.encode(text);
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
    },
  };
}
