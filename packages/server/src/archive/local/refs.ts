import { join } from "node:path";
import type { Logger } from "../../database.ts";
import { codeOf, diskError, renameRetrying, type Disk } from "./disk.ts";

/**
 * The branch of a bare repository of the server's own, moved the way Git itself moves one, so that
 * a `git push` into the same repository and an archive never write over each other: a lock file
 * next to the branch made exclusively (`refs/heads/main.lock`, the one Git takes too), the branch as
 * it is now read under it (loose, or from `packed-refs` after `git gc`), checked, the new value
 * written into the lock and synced, the lock renamed over the branch, the folder synced, and a line
 * added to the reflog. A lock older than `STALE_LOCK_MS` is what a crash left behind, and goes.
 */

export const STALE_LOCK_MS = 10 * 60_000;

const SHA = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);

/** How long to wait for a lock someone else holds, in turn, before giving up. */
const LOCK_WAITS_MS = [20, 50, 100, 200, 400];

/** What the branch has now: loose, or packed by `git gc`. Undefined where it is not there. */
export const readRef = async (
  disk: Disk,
  gitdir: string,
  ref: string,
): Promise<string | undefined> => {
  try {
    const text = (await disk.readFile(join(gitdir, ref))).toString("utf8").trim();
    if (SHA.test(text)) return text;
  } catch (error) {
    if (codeOf(error) !== "ENOENT" && codeOf(error) !== "EISDIR") throw error;
  }
  try {
    const packed = (await disk.readFile(join(gitdir, "packed-refs"))).toString("utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && SHA.test(sha)) return sha;
    }
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
  return undefined;
};

/** Whether the repository has any branch or tag at all, loose or packed. */
export const hasAnyRef = async (disk: Disk, gitdir: string): Promise<boolean> => {
  const walk = async (folder: string): Promise<boolean> => {
    let names: string[];
    try {
      names = await disk.readdir(folder);
    } catch {
      return false;
    }
    for (const name of names) {
      const path = join(folder, name);
      const stat = await disk.stat(path);
      if (stat?.isDirectory() ? await walk(path) : stat?.isFile() && !name.endsWith(".lock"))
        return true;
    }
    return false;
  };
  if (await walk(join(gitdir, "refs"))) return true;
  try {
    const packed = (await disk.readFile(join(gitdir, "packed-refs"))).toString("utf8");
    return packed.split("\n").some((line) => SHA.test(line.split(" ")[0] ?? ""));
  } catch {
    return false;
  }
};

export interface RefMove {
  readonly ref: string;
  readonly to: string;
  /**
   * Whether the branch may go from what it has now (undefined: not there) to `to`: asked under the
   * lock. False leaves it as it is ("behind").
   */
  readonly may: (now: string | undefined) => Promise<boolean>;
  /** For the reflog. */
  readonly message: string;
  readonly at: Date;
}

/**
 * Moves a branch where `may` says so. "behind" where it does not, or where another writer holds the
 * lock for longer than this waits; the branch is then as it was. A failure of the disk leaves it as
 * it was too (`DiskFull` where there is no room), and the lock goes.
 */
export const moveRef = async (
  disk: Disk,
  gitdir: string,
  move: RefMove,
  options: {
    readonly platform: NodeJS.Platform;
    readonly log: Logger;
    readonly now?: () => number;
    readonly wait?: (ms: number) => Promise<void>;
  },
): Promise<"moved" | "behind"> => {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const path = join(gitdir, move.ref);
  const lock = `${path}.lock`;
  const folder = join(path, "..");
  try {
    await disk.mkdir(folder);
  } catch (error) {
    throw diskError(error);
  }
  // Taken: by a lock of its own, or not at all.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await disk.writeFile(lock, new Uint8Array(), { exclusive: true });
      break;
    } catch (error) {
      // Not made: it is someone else's, or not there, and either way not this one's to take away.
      if (codeOf(error) !== "EEXIST") throw diskError(error);
      if (attempt > LOCK_WAITS_MS.length * 2) return "behind";
      const stat = await disk.stat(lock);
      if (stat && now() - stat.mtimeMs > STALE_LOCK_MS) {
        // Only the lock that was looked at: another writer can have taken it away and made one
        // of its own meanwhile, which is not left behind.
        const again = await disk.stat(lock);
        if (again && again.ino === stat.ino && again.mtimeMs === stat.mtimeMs) {
          options.log.warn({ lock }, "a lock left behind by a crash goes");
          await disk.unlink(lock).catch(() => {});
        }
        // Made exclusively again: whoever gets it first has it.
        continue;
      }
      if (attempt >= LOCK_WAITS_MS.length) return "behind";
      await wait(LOCK_WAITS_MS[attempt]!);
    }
  }
  let from: string | undefined;
  try {
    from = await readRef(disk, gitdir, move.ref);
    if (from !== move.to && !(await move.may(from))) {
      await disk.unlink(lock).catch(() => {});
      return "behind";
    }
    if (from !== move.to) {
      await disk.writeFile(lock, Buffer.from(`${move.to}\n`));
      await renameRetrying(disk, lock, path, options.platform);
      await disk.syncDir(folder);
    } else await disk.unlink(lock);
  } catch (error) {
    await disk.unlink(lock).catch(() => {});
    throw diskError(error);
  }
  if (from === move.to) return "moved";
  // The reflog is for people: a branch that moved stays moved where it cannot be written.
  try {
    const log = join(gitdir, "logs", move.ref);
    await disk.mkdir(join(log, ".."));
    const seconds = Math.floor(move.at.getTime() / 1000);
    await disk.appendFile(
      log,
      `${from ?? ZERO} ${move.to} AnimaQuill <noreply@animaquill.invalid> ${seconds} +0000\t${move.message.replace(/\n/g, " ")}\n`,
    );
  } catch (error) {
    options.log.warn({ ref: move.ref, code: codeOf(error) }, "the reflog was not written");
  }
  return "moved";
};
