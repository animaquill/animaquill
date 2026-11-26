import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { NotTheObject } from "../../lfs/transfer.ts";
import {
  LfsAbsent,
  LfsChanged,
  RepoRefused,
  type LfsHave,
  type LfsObject,
  type LfsPiece,
  type LfsStaged,
} from "../repo-host.ts";
import { codeOf, diskError, renameRetrying, type Disk } from "./disk.ts";

/**
 * The large file storage of a repository of the server's own: its objects in the folder of the
 * repository, as Git LFS keeps them in a bare one, `lfs/objects/<aa>/<bb>/<oid>`, so that a
 * `git clone` of it, then `git lfs pull`, gets them from there (Git LFS's transfer of its own for a
 * path), and a `git lfs push` of people's own puts them there.
 *
 * An object is whole once it is there, and only ever the object: it is written under a name of its
 * own in `lfs/tmp/` first (a second name of the staging file, where both are on one disk; a copy
 * otherwise), read through for its SHA-256 and length, synced, and renamed into its place; the
 * folder is synced after. A crash leaves the staging file to push again, or the object in its
 * place, and at worst a file in `lfs/tmp/`, which the weekly check takes away. Nothing is ever
 * written over an object that is there as large as it is.
 */

/** The name of an object: its SHA-256, in lower-case hexadecimal. */
export const LFS_OID = /^[0-9a-f]{64}$/;

/** Where the objects wait before they are in their place, in the repository. */
export const LFS_TMP = "lfs/tmp";

/** How old a file in `lfs/tmp/` is before it is taken for one a crash left. */
export const LFS_TMP_STALE_MS = 24 * 3600_000;

/** Why linking may not work where the two files are, which a copy does instead. */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EACCES"]);

export const lfsPathOf = (gitdir: string, oid: string): string => {
  if (!LFS_OID.test(oid)) throw new RepoRefused(400, "not the oid of an object of Git LFS");
  return join(gitdir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
};

/** How large the object of an oid is in the repository: undefined where it is not there. */
export const lfsSizeOf = async (
  disk: Disk,
  gitdir: string,
  oid: string,
): Promise<number | undefined> => {
  if (!LFS_OID.test(oid)) return undefined;
  const stat = await disk.stat(lfsPathOf(gitdir, oid));
  return stat?.isFile() ? stat.size : undefined;
};

export const lfsHaveOf = async (
  disk: Disk,
  gitdir: string,
  objects: readonly LfsObject[],
): Promise<LfsHave[]> => {
  const haves: LfsHave[] = [];
  for (const object of objects) {
    const size = await lfsSizeOf(disk, gitdir, object.oid);
    haves.push(size === undefined ? { kind: "absent" } : { kind: "present", size });
  }
  return haves;
};

/**
 * Makes a folder in the repository and those it is in, syncing each one's parent where it was
 * made, so that it stays through a crash.
 */
const makeFolder = async (disk: Disk, gitdir: string, folder: string): Promise<void> => {
  const made: string[] = [];
  for (let at = folder; at !== gitdir && at.startsWith(gitdir); at = dirname(at)) {
    if (await disk.stat(at)) break;
    made.push(at);
  }
  if (made.length === 0) return;
  await disk.mkdir(folder);
  for (const each of made) await disk.syncDir(dirname(each));
};

/**
 * Puts the file of an upload into the repository as `object`, see above. "present" where it is
 * there already, as large as it is (as after a crash once it was in its place, or a `git lfs push`
 * of people's own). Rejects with `NotTheObject` where the file is not the object, and nothing is
 * in its place then; with `DiskFull` where the disk has no room; with ENOENT where the staging file
 * is gone.
 */
export const lfsPutInto = async (
  disk: Disk,
  gitdir: string,
  platform: NodeJS.Platform,
  object: LfsObject,
  staged: LfsStaged,
): Promise<"put" | "present"> => {
  const target = lfsPathOf(gitdir, object.oid);
  const there = await disk.stat(target);
  if (there?.isFile() && there.size === object.size) return "present";
  const folder = join(gitdir, ...LFS_TMP.split("/"));
  const temporary = join(folder, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await makeFolder(disk, gitdir, folder);
    let linked = false;
    try {
      await disk.link(staged.path, temporary);
      linked = true;
    } catch (error) {
      if (!NO_LINK.has(codeOf(error) ?? "")) throw error;
    }
    const found = linked
      ? await disk.hashFile(temporary)
      : await disk.writeFrom(temporary, await staged.open());
    if (found.size !== object.size || found.sha256 !== object.oid)
      throw new NotTheObject("the file is not the object it was to be put in as");
    if (linked) {
      // The staging file is only for the server; the object, for whoever clones.
      await disk.chmod(temporary, 0o644);
      await disk.syncFile(temporary);
    }
    await makeFolder(disk, gitdir, dirname(target));
    const now = await disk.stat(target);
    if (now?.isFile() && now.size === object.size) {
      await disk.unlink(temporary).catch(() => {});
      return "present";
    }
    await renameRetrying(disk, temporary, target, platform);
    await disk.syncDir(dirname(target));
  } catch (error) {
    await disk.unlink(temporary).catch(() => {});
    throw diskError(error);
  }
  return "put";
};

/** Part of an object of the repository. */
export const lfsReadFrom = async (
  disk: Disk,
  gitdir: string,
  object: LfsObject,
  range: { readonly start: number; readonly end: number },
): Promise<LfsPiece> => {
  let read;
  try {
    read = await disk.readRange(lfsPathOf(gitdir, object.oid), range.start, range.end);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR")
      throw new LfsAbsent("the repository does not have the object");
    throw error;
  }
  if (read.size !== object.size) {
    read.body.destroy();
    throw new LfsChanged("the repository has the object in another size");
  }
  return { start: range.start, size: read.size, body: read.body };
};

/** Every object a repository has, by its oid, as `git lfs` keeps them: what is named otherwise is not one. */
export const lfsObjectsIn = async (disk: Disk, gitdir: string): Promise<LfsObject[]> => {
  const root = join(gitdir, "lfs", "objects");
  const found: LfsObject[] = [];
  const names = async (path: string) => (await disk.readdir(path).catch(() => [])).toSorted();
  for (const first of await names(root)) {
    if (!/^[0-9a-f]{2}$/.test(first)) continue;
    for (const second of await names(join(root, first))) {
      if (!/^[0-9a-f]{2}$/.test(second)) continue;
      for (const oid of await names(join(root, first, second))) {
        if (!LFS_OID.test(oid) || !oid.startsWith(first + second)) continue;
        const stat = await disk.stat(join(root, first, second, oid));
        if (stat?.isFile()) found.push({ oid, size: stat.size });
      }
    }
  }
  return found;
};

/** Takes away what crashes left in `lfs/tmp/`: files older than a day. Resolves to how many. */
export const sweepLfsTemporary = async (
  disk: Disk,
  gitdir: string,
  now: number,
): Promise<number> => {
  const folder = join(gitdir, ...LFS_TMP.split("/"));
  let swept = 0;
  for (const name of await disk.readdir(folder).catch(() => [] as string[])) {
    if (!name.startsWith(".tmp-")) continue;
    const stat = await disk.stat(join(folder, name));
    if (!stat?.isFile() || now - stat.mtimeMs < LFS_TMP_STALE_MS) continue;
    await disk.unlink(join(folder, name)).catch(() => {});
    swept += 1;
  }
  return swept;
};
