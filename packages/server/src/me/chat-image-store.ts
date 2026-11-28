import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { S3Error, type S3SignedRequest } from "@animaquill/host/s3";
import { REQUEST_HEADER } from "../auth/guard.ts";
import { diskRoom, type DiskRoom } from "../library/disk.ts";
import type { LibraryMode } from "../library/config.ts";
import type { LibraryStorage } from "../library/storage.ts";
import type { Logger } from "../database.ts";

/**
 * Where the pictures of conversations are kept (me/chat-images.ts), by their keys
 * (`chat-images/u/<user id>/<SHA-256>`): the object storage of the cloud space
 * (`objectImageStore`), which pages put pictures into and read them from at addresses it signs; or
 * a folder of the server's own (`folderImageStore`), as the backend of `npx animaquill` has them in
 * its data folder, which pages put pictures into and read them from through the server
 * (`/api/me/chat-images/<hash>/content`, see me/routes.ts).
 *
 * Whatever is kept where, `ChatImages` says which pictures there are: a store only keeps bytes.
 */
export interface ChatImageStore {
  readonly kind: "objects" | "folder";
  /** Whether new pictures may go up now: the storage takes them, and there is room on the disk. */
  canPut(): Promise<boolean>;
  /** Whether pictures can be read now. */
  canRead(): boolean;
  /** Where a page puts a picture, for `seconds`: the address, its method, and its headers. */
  putAddress(
    key: string,
    image: { readonly bytes: number; readonly hash: string },
    seconds: number,
  ): Promise<S3SignedRequest>;
  /** Where a page reads a picture, for `seconds`. */
  readAddress(key: string, seconds: number): Promise<string>;
  /**
   * What is kept at `key`: undefined where nothing is; empty where it is larger than `most`, which
   * is then not read (it is no picture of ours).
   */
  read(key: string, most: number): Promise<Buffer | undefined>;
  /**
   * Whether something is kept at `key`: only a store that can say so cheaply (`folder`) has it; the
   * object storage is taken to have what the platform checked once.
   */
  has?(key: string): Promise<boolean>;
  /** Takes away what is at `key`, if anything. */
  remove(key: string): Promise<void>;
  /** A page of the keys under `prefix`, and where the next page starts. */
  list(
    prefix: string,
    next?: string,
  ): Promise<{ readonly keys: readonly string[]; readonly next?: string | undefined }>;
  /**
   * Keeps what a page sent for `key`, all of it or nothing, in place of what was there: only a
   * store that pages put into through the server (`folder`) has it.
   */
  write?(key: string, bytes: Buffer): Promise<void>;
  /**
   * Takes away what writes that stopped halfway left, as of a crash: only a store that writes
   * itself (`folder`) has it. Resolves to how many went.
   */
  tidy?(): Promise<number>;
}

/** The object storage of the cloud space, as the platform has the pictures. */
export const objectImageStore = (options: {
  readonly storage: LibraryStorage;
  /** Whether the cloud space keeps files now, see library/config.ts. */
  readonly mode: () => LibraryMode;
  /** Whether each picture goes up with its SHA-256 signed in, which the storage checks. */
  readonly checksum: "sha256" | "none";
  /** With less free on the disk, nothing new goes up, as for the cloud space (library/disk.ts). */
  readonly minFreeBytes: number;
  /** Only tests: how full the disk is. */
  readonly disk?: () => Promise<DiskRoom>;
}): ChatImageStore => {
  const { storage } = options;
  return {
    kind: "objects",
    async canPut() {
      if (options.mode() !== "on") return false;
      return (await (options.disk?.() ?? diskRoom(options.minFreeBytes))).enough;
    },
    canRead: () => options.mode() !== "off",
    putAddress: (key, image, seconds) =>
      storage.public.presign("PUT", key, {
        expiresSeconds: seconds,
        size: image.bytes,
        ...(options.checksum === "sha256" && {
          checksumSha256: Buffer.from(image.hash, "hex").toString("base64"),
        }),
      }),
    readAddress: async (key, seconds) =>
      (await storage.public.presign("GET", key, { expiresSeconds: seconds })).url,
    async read(key, most) {
      let response: Response;
      try {
        response = await storage.internal.getObject(key);
      } catch (error) {
        if (error instanceof S3Error && error.status === 404) return undefined;
        throw error;
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > most) {
        await response.body?.cancel().catch(() => {});
        return Buffer.alloc(0);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    remove: (key) => storage.internal.deleteObject(key),
    async list(prefix, next) {
      const page = await storage.internal.listObjects({ prefix, next });
      return { keys: page.objects.map((object) => object.key), next: page.next };
    },
  };
};

/** What a key of a picture is, and nothing else: no way out of the folder. */
const KEY = /^chat-images\/u\/[0-9a-f-]{36}\/[0-9a-f]{64}$/;
const PREFIX = /^chat-images\/u\/(?:[0-9a-f-]{36}\/)?$/;
/** Where pictures are written first, inside the folder, so that a rename puts them in place. */
const WRITING = ".writing";
/** How long a picture being written takes at most: one older is what a crash left. */
const WRITING_KEEP_MS = 60 * 60_000;

/**
 * A folder of the server's own: `<folder>/chat-images/u/<user id>/<SHA-256>`, every file only the
 * server's user's (600, the folders 700). Pages put and read through the server, which checks who
 * they are (me/routes.ts); a picture is written to a file of its own first, synced, and renamed into
 * place, so that a picture is there whole or not at all.
 */
export const folderImageStore = (options: {
  /** The folder the keys are in, such as the data folder of `npx animaquill`. */
  readonly folder: string;
  /** The editor's site, which pages put and read at. */
  readonly origin: string;
  /** With less free on the disk the folder is on, nothing new goes up. */
  readonly minFreeBytes: number;
  /** Only tests: how full the disk is. */
  readonly disk?: () => Promise<DiskRoom>;
  /** Where what is found that is no picture is said. */
  readonly log?: Logger | undefined;
  /** Only tests: the time now. */
  readonly now?: () => number;
}): ChatImageStore => {
  const { folder, origin } = options;
  const pathOf = (key: string) => {
    if (!KEY.test(key)) throw new RangeError("not a key of a picture");
    return join(folder, ...key.split("/"));
  };
  const hashOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);
  const address = (key: string) => `${origin}/api/me/chat-images/${hashOf(key)}/content`;
  return {
    kind: "folder",
    async canPut() {
      return (await (options.disk?.() ?? diskRoom(options.minFreeBytes, { path: folder }))).enough;
    },
    canRead: () => true,
    putAddress: async (key) => ({
      method: "PUT",
      url: address(key),
      // What every change from a page of the editor says (auth/guard.ts).
      headers: { [REQUEST_HEADER]: "1" },
    }),
    readAddress: async (key) => address(key),
    async read(key, most) {
      const path = pathOf(key);
      const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!found) return undefined;
      if (found.size > most) return Buffer.alloc(0);
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    has: async (key) => (await stat(pathOf(key)).catch(() => undefined))?.isFile() === true,
    remove: (key) => rm(pathOf(key), { force: true }),
    async list(prefix) {
      if (!PREFIX.test(prefix)) throw new RangeError("not a prefix of pictures");
      const keys: string[] = [];
      const walk = async (path: string, under: string) => {
        let entries;
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.name === WRITING) continue;
          const key = `${under}${entry.name}`;
          if (entry.isDirectory()) await walk(join(path, entry.name), `${key}/`);
          else if (entry.isFile() && KEY.test(key)) keys.push(key);
          // Something else people put there, as `.DS_Store`: left alone, and said.
          else if (entry.isFile()) options.log?.info({ key }, "not a picture, left as it is");
        }
      };
      await walk(join(folder, ...prefix.split("/").filter(Boolean)), prefix);
      return { keys: keys.toSorted() };
    },
    async tidy() {
      const writing = join(folder, "chat-images", WRITING);
      const before = (options.now ?? Date.now)() - WRITING_KEEP_MS;
      let removed = 0;
      for (const name of await readdir(writing).catch(() => [])) {
        const found = await stat(join(writing, name)).catch(() => undefined);
        if (!found?.isFile() || found.mtimeMs >= before) continue;
        await rm(join(writing, name), { force: true });
        removed += 1;
      }
      return removed;
    },
    async write(key, bytes) {
      const path = pathOf(key);
      const writing = join(folder, "chat-images", WRITING);
      await mkdir(writing, { recursive: true, mode: 0o700 });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = join(writing, `${randomBytes(9).toString("hex")}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } catch (error) {
        await file.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
      }
      await file.close();
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      // The folder too, so that the name survives a crash of the machine (not on Windows).
      if (sep === "/") {
        const dir = await open(dirname(path), "r").catch(() => undefined);
        await dir?.sync().catch(() => {});
        await dir?.close().catch(() => {});
      }
    },
  };
};

/** The SHA-256 of bytes, in hexadecimal. */
export const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
