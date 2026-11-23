import { createHash } from "node:crypto";
import { constants, createReadStream, type ReadStream } from "node:fs";
import { access, lstat, open, readdir, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where files on their way into Git LFS wait: a volume of their own, `platform_staging`, which the
 * API writes the pieces that come into, and the worker reads from and takes files out of once they
 * are in the storage. One file for each upload, named by its id, `<id>.part`, and nothing else:
 * whatever else is in there is not the platform's, and is left alone.
 *
 * The folder comes from the environment (LFS_STAGING_DIR): only names of this shape are ever made,
 * written, or taken away in it, whatever folder that is.
 */

/** Where the volume is in the containers of the API and the worker. */
export const STAGING_DIR = "/var/lib/animaquill/staging";

/** The id of an upload, which `uuidv7()` makes. */
export const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/;

/** How much of a file is read at a time, for its hash and to send it on. */
const READ_BYTES = 1024 * 1024;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export class Staging {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Where the file of an upload is. Throws for what is no id of an upload. */
  pathOf(id: string): string {
    if (!UPLOAD_ID.test(id)) throw new Error("not the id of an upload");
    return join(this.dir, `${id}.part`);
  }

  /** Whether the folder is there, and this process may write into it. */
  async usable(): Promise<boolean> {
    try {
      const folder = await lstat(this.dir);
      if (!folder.isDirectory()) return false;
      await access(this.dir, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The empty file of a new upload. Rejects where it is there already. */
  async create(id: string): Promise<void> {
    const handle = await open(this.pathOf(id), "wx", 0o600);
    await handle.close();
  }

  /**
   * Writes a piece at `offset`, and waits until it is on the disk: only then does the upload count
   * it. Rejects with ENOENT where the file is gone.
   */
  async write(id: string, offset: number, piece: Uint8Array): Promise<void> {
    const handle = await open(this.pathOf(id), "r+");
    try {
      for (let at = 0; at < piece.length;) {
        const { bytesWritten } = await handle.write(piece, at, piece.length - at, offset + at);
        if (bytesWritten <= 0) throw new Error("nothing was written");
        at += bytesWritten;
      }
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  /**
   * The SHA-256 of the first `size` bytes of the file of an upload, in lower-case hexadecimal, read
   * from the disk: what is there, whatever came. Undefined where it is not there, or shorter.
   */
  async hash(id: string, size: number): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(this.pathOf(id), "r");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      if ((await handle.stat()).size < size) return undefined;
      const hash = createHash("sha256");
      if (size > 0) {
        const stream = handle.createReadStream({
          start: 0,
          end: size - 1,
          highWaterMark: READ_BYTES,
          autoClose: false,
        });
        let read = 0;
        for await (const piece of stream as AsyncIterable<Buffer>) {
          hash.update(piece);
          read += piece.length;
        }
        if (read !== size) return undefined;
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  }

  /** The first `size` bytes of the file of an upload, to send on. Rejects with ENOENT where it is gone. */
  async reader(id: string, size: number): Promise<ReadStream> {
    const path = this.pathOf(id);
    // Opened now, so that a file that is gone says so here, not once something reads.
    const handle = await open(path, "r");
    if ((await handle.stat()).size < size) {
      await handle.close();
      throw Object.assign(new Error("the file is shorter than the upload"), { code: "ESHORT" });
    }
    return createReadStream(path, {
      fd: handle,
      start: 0,
      end: Math.max(0, size - 1),
      highWaterMark: READ_BYTES,
    });
  }

  /** Takes the file of an upload away, where it is still there. */
  async remove(id: string): Promise<void> {
    try {
      await unlink(this.pathOf(id));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /**
   * The files in the folder: those of uploads, by id, and how many others there are, which are not
   * the platform's to touch. Only files right in it, never what a link or a folder leads to.
   */
  async list(): Promise<{ readonly ids: readonly string[]; readonly others: number }> {
    const ids: string[] = [];
    let others = 0;
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      const id = entry.isFile() ? FILE_NAME.exec(entry.name)?.[1] : undefined;
      if (id === undefined) others += 1;
      else ids.push(id);
    }
    return { ids, others };
  }

  /** Bytes free on the disk the folder is on, for anybody, as `df` has it. */
  async freeBytes(): Promise<number> {
    const stats = await statfs(this.dir);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}
