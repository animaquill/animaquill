import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LocalServerHooks, LocalServerState } from "@animaquill/server/local/routes.ts";
import { MASTER_KEY_FILE, writePrivate } from "./data-dir.ts";
import { isOldFolder, oldFolders } from "./upgrade.ts";

/**
 * What "设置 › 服务器" shows of the backend of `npx animaquill`, and what it does there (design O4
 * of AnimaQuill Cloud, 3): where the data folder is, which PostgreSQL, the master key (a copy of
 * it to save, once: `master.key.saved` notes which key people said they saved, by its digest, so
 * that a key made again is asked about again), and the folders of versions of PostgreSQL before,
 * which an upgrade leaves until people take them away.
 */

/** Where the digest of the master key people said they saved is noted. */
export const SAVED_FILE = "master.key.saved";

/** A short digest of a master key's file, which says which one it is and nothing of it. */
export const fingerprintOf = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

export interface ServerStateOptions {
  readonly dataDir: string;
  readonly version: string;
  /** The major version of its own PostgreSQL, or undefined for one people gave. */
  readonly major: number | undefined;
  /** The master key was made as this start began, though the database was there. */
  readonly madeAgain: boolean;
  readonly upgradeFailed?: LocalServerState["upgradeFailed"];
  /** The PostgreSQL of a folder may still run: never taken away while it does. */
  readonly running: (name: string) => boolean;
}

export function serverState(options: ServerStateOptions): LocalServerHooks {
  const { dataDir } = options;
  const keyPath = join(dataDir, MASTER_KEY_FILE);
  const savedPath = join(dataDir, SAVED_FILE);
  const keyText = () => readFile(keyPath, "utf8").catch(() => undefined);
  return {
    async state() {
      const key = await keyText();
      const saved = (await readFile(savedPath, "utf8").catch(() => "")).trim();
      const fingerprint = key === undefined ? undefined : fingerprintOf(key);
      return {
        version: options.version,
        dataDir,
        database:
          options.major === undefined ? { kind: "given" } : { kind: "own", major: options.major },
        ...(fingerprint !== undefined && {
          masterKey: {
            path: keyPath,
            fingerprint,
            saved: saved === fingerprint,
            madeAgain: options.madeAgain,
          },
        }),
        old: await oldFolders(dataDir),
        ...(options.upgradeFailed && { upgradeFailed: options.upgradeFailed }),
      };
    },
    async keySaved(fingerprint) {
      const key = await keyText();
      if (key === undefined || fingerprintOf(key) !== fingerprint) return false;
      await writePrivate(savedPath, `${fingerprint}\n`);
      return true;
    },
    masterKey: keyText,
    async removeOld(name) {
      if (!isOldFolder(name) || options.running(name)) return "notFound";
      const found = (await oldFolders(dataDir)).some((each) => each.name === name);
      if (!found) return "notFound";
      await rm(join(dataDir, name), { recursive: true, force: true });
      return "removed";
    },
  };
}
