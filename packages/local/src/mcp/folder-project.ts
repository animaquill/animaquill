import {
  INCOMPLETE_FILE,
  ProjectStore,
  isProjectFile,
  readFolder,
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
 * A project folder on this computer, read as a project for the command line (`check`, `describe`),
 * which only reads. The editor in the browser is what changes a project: AI tools on this computer
 * change it there, through `animaquill mcp` (docs/design/online-offline.md of AnimaQuill Cloud, 5).
 */

/** What was read of a file. */
interface Known {
  /** Undefined for a file that is no text. */
  readonly text: string | undefined;
  readonly stat: DiskStat;
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

/** A file that changed while it was read is read again, a few times at the most. */
const READ_ATTEMPTS = 3;

export class FolderProject {
  readonly root: string;
  readonly store: ProjectStore;
  /** What reading the folder found as it opened: what stayed out, and why. */
  readonly reading: FolderReading;

  private constructor(root: string, store: ProjectStore, reading: FolderReading) {
    this.root = root;
    this.store = store;
    this.reading = reading;
  }

  /**
   * Reads the project in a folder, which has to have animaquill.json at its top. Rejects with
   * `FolderRefused` when it cannot be a project, as the editor would. No link is followed.
   */
  static async open(root: string): Promise<FolderProject> {
    const folder = await diskFolder(root);
    // Its reading follows no link, and writes nothing.
    const reader = await diskWriter(root);
    const { known, texts } = await readAll(folder, reader);
    const reading = await readFolder(snapshotOf(texts, known));
    return new FolderProject(root, ProjectStore.create(reading.project, reading.sources), reading);
  }

  destroy(): void {
    this.store.destroy();
  }
}

/** Files that belong to the project as the format has them, and what says an export is unfinished. */
const isTracked = (path: string) => isProjectFile(path) || path === INCOMPLETE_FILE;

async function readKnown(writer: DiskWriter, path: string): Promise<Known | undefined> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      // How it looked before and after it was read, on the same handle: the text and the look
      // are of one moment, so that a write in between is not taken for what was read.
      const read = await writer.read(path);
      if (!read) return undefined;
      const bytes = read.bytes.slice().buffer;
      return { text: textOf(bytes), stat: read.stat };
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
    const read = isTracked(path) ? await readKnown(writer, path) : undefined;
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
