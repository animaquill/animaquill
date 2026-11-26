import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { GitHubUnavailable } from "../../github/client.ts";

/**
 * The disk as the repositories of the server's own write it (archive/local/), in the few steps
 * they need, so that a test can make any of them fail as a disk or a crash would: a file is whole
 * once it is there (written into a name of its own, synced, renamed over), and a folder is synced
 * after what changed in it, except on Windows, which cannot open one for that.
 */
export interface Disk {
  /** Writes a whole file and syncs it. `exclusive`: fails with EEXIST where it is there already. */
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { readonly exclusive?: boolean },
  ): Promise<void>;
  /** Adds to the end of a file, made where it is not there, and syncs it. */
  appendFile(path: string, text: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Makes a folder and those it is in; nothing where it is there. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Undefined where nothing is there. */
  stat(path: string): Promise<Stats | undefined>;
  /** Syncs what a folder has, so that a file renamed into it stays there through a crash. */
  syncDir(path: string): Promise<void>;
  /** Gives the file at `existing` another name, `path`, on the same disk: EXDEV where it is not. */
  link(existing: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Syncs a file, as it is. */
  syncFile(path: string): Promise<void>;
  /** The SHA-256 of a file, in lower-case hexadecimal, and its length: read through. */
  hashFile(path: string): Promise<{ readonly sha256: string; readonly size: number }>;
  /**
   * Writes what `from` has into a new file (EEXIST where `path` is there), hashed on the way, and
   * syncs it. Resolves to its SHA-256 and length. `from` is closed whatever happens.
   */
  writeFrom(
    path: string,
    from: Readable,
  ): Promise<{ readonly sha256: string; readonly size: number }>;
  /**
   * Part of a file to read, from `start` to `end` (both in it), with how large all of it is: opened
   * now, so that a file that is not there says so here (ENOENT).
   */
  readRange(
    path: string,
    start: number,
    end: number,
  ): Promise<{ readonly size: number; readonly body: Readable }>;
}

/** How much of a file is read at a time. */
const READ_BYTES = 1024 * 1024;

/** The disk of this computer. */
export const nodeDisk = (platform: NodeJS.Platform = process.platform): Disk => ({
  async writeFile(path, bytes, options = {}) {
    const handle = await fs.open(path, options.exclusive ? "wx" : "w", 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async appendFile(path, text) {
    const handle = await fs.open(path, "a", 0o644);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readFile: (path) => fs.readFile(path),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
  async mkdir(path) {
    await fs.mkdir(path, { recursive: true, mode: 0o755 });
  },
  readdir: (path) => fs.readdir(path),
  async stat(path) {
    try {
      return await fs.stat(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return undefined;
      throw error;
    }
  },
  async syncDir(path) {
    if (platform === "win32") return;
    const handle = await fs.open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  link: (existing, path) => fs.link(existing, path),
  chmod: (path, mode) => fs.chmod(path, mode),
  async syncFile(path) {
    const handle = await fs.open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async hashFile(path) {
    const handle = await fs.open(path, "r");
    try {
      const hash = createHash("sha256");
      let size = 0;
      const stream = handle.createReadStream({ highWaterMark: READ_BYTES, autoClose: false });
      for await (const piece of stream as AsyncIterable<Buffer>) {
        hash.update(piece);
        size += piece.length;
      }
      return { sha256: hash.digest("hex"), size };
    } finally {
      await handle.close();
    }
  },
  async writeFrom(path, from) {
    let handle;
    try {
      handle = await fs.open(path, "wx", 0o644);
    } catch (error) {
      from.destroy();
      throw error;
    }
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const piece of from as AsyncIterable<Buffer>) {
        hash.update(piece);
        size += piece.length;
        for (let at = 0; at < piece.length;) {
          const { bytesWritten } = await handle.write(piece, at, piece.length - at);
          if (bytesWritten <= 0) throw new Error("nothing was written");
          at += bytesWritten;
        }
      }
      await handle.sync();
      return { sha256: hash.digest("hex"), size };
    } finally {
      from.destroy();
      await handle.close();
    }
  },
  async readRange(path, start, end) {
    const handle = await fs.open(path, "r");
    try {
      const { size } = await handle.stat();
      const body = handle.createReadStream({
        start,
        end: Math.max(start, Math.min(end, size - 1)),
        highWaterMark: READ_BYTES,
        autoClose: true,
      });
      return { size, body };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
});

export const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};

/** The disk has no room left: nothing was changed, and the archive is tried again later. */
export class DiskFull extends GitHubUnavailable {
  override name = "DiskFull";
  constructor() {
    super("diskFull");
  }
}

/** What a failure of the disk is to the archive: no room is `DiskFull`, the rest as it is. */
export const diskError = (error: unknown): unknown =>
  codeOf(error) === "ENOSPC" || codeOf(error) === "EDQUOT" ? new DiskFull() : error;

/** How long to wait between tries of a rename that Windows refuses for a while. */
const RENAME_WAITS_MS = [10, 30, 100, 300, 1000, 2000];

/**
 * A rename, tried again where Windows refuses it for a while (EBUSY, EPERM, EACCES: another program,
 * such as a virus scanner or an indexer, has the file open). Elsewhere these mean what they say.
 */
export const renameRetrying = async (
  disk: Disk,
  from: string,
  to: string,
  platform: NodeJS.Platform,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await disk.rename(from, to);
      return;
    } catch (error) {
      const code = codeOf(error);
      const busy = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (platform !== "win32" || !busy || attempt >= RENAME_WAITS_MS.length) throw error;
      await wait(RENAME_WAITS_MS[attempt]!);
    }
  }
};

/**
 * Writes a whole file in place of what `path` has, or of nothing: into a name of its own next to
 * it first, synced, then renamed over it and the folder synced. A crash leaves the old file or the
 * new one, and at worst a temporary file, never half of one. Where the disk is full, the temporary
 * file goes and `DiskFull` is thrown.
 */
export const writeWhole = async (
  disk: Disk,
  path: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
): Promise<void> => {
  const folder = dirname(path);
  const temporary = join(folder, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await disk.writeFile(temporary, bytes, { exclusive: true });
    await renameRetrying(disk, temporary, path, platform);
  } catch (error) {
    await disk.unlink(temporary).catch(() => {});
    throw diskError(error);
  }
  await disk.syncDir(folder).catch((error: unknown) => {
    throw diskError(error);
  });
};
