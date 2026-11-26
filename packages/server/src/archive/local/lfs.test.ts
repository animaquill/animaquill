import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitHubUnavailable } from "../../github/client.ts";
import { NotTheObject } from "../../lfs/transfer.ts";
import { quiet } from "../../test/archive-support.ts";
import { LfsAbsent, LfsChanged, type LfsObject, type LocalPlace } from "../repo-host.ts";
import { DiskFull, nodeDisk, type Disk } from "./disk.ts";
import { LocalGitRepoHost } from "./host.ts";
import {
  lfsObjectsIn,
  lfsPathOf,
  lfsPutInto,
  lfsReadFrom,
  sweepLfsTemporary,
  LFS_TMP_STALE_MS,
} from "./lfs.ts";

/**
 * The large file storage of a repository of the server's own, on the disk: an object goes in
 * whole and only as itself, whatever step fails or the machine stops at; one that is there is never
 * written over; parts of it read back as they are; and Git LFS itself gets it out of a clone, and
 * puts its own in where this finds them.
 */

const oidOf = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const errno = (code: string) => Object.assign(new Error(code), { code });

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasGitLfs = hasGit && spawnSync("git", ["lfs", "version"]).status === 0;
// Where tests run for a release, Git LFS is there: never skipped there.
if (!hasGitLfs && process.env["CI"]) throw new Error("git lfs is needed for these tests");

const git = (cwd: string, args: readonly string[], env: Record<string, string> = {}) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
      // Nothing of this computer's: Git LFS only where a test installs it into a clone.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      // A repository on a path has no locking API, which Git LFS would ask otherwise.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "lfs.locksverify",
      GIT_CONFIG_VALUE_0: "false",
      ...env,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/** A disk that fails where a test says. */
const failing = (fail: (op: string, path: string) => Error | undefined): Disk => {
  const disk = nodeDisk();
  const at =
    <A extends unknown[], R>(op: string, call: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      const error = fail(op, path);
      if (error) throw error;
      return call(path, ...rest);
    };
  return {
    ...disk,
    link: async (existing, path) => {
      const error = fail("link", path);
      if (error) throw error;
      return disk.link(existing, path);
    },
    rename: async (from, to) => {
      const error = fail("rename", to);
      if (error) throw error;
      return disk.rename(from, to);
    },
    mkdir: at("mkdir", disk.mkdir),
    syncDir: at("syncDir", disk.syncDir),
    syncFile: at("syncFile", disk.syncFile),
    chmod: at("chmod", disk.chmod),
    hashFile: at("hashFile", disk.hashFile),
    writeFrom: at("writeFrom", disk.writeFrom),
    readRange: at("readRange", disk.readRange),
  };
};

describe("large files of a repository here, on the disk", () => {
  let dir: string;
  let gitdir: string;
  let staging: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aq-local-lfs-"));
    gitdir = join(dir, "repos", "p.git");
    staging = join(dir, "staging");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(staging);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A staging file of these bytes, as an upload leaves it. */
  const staged = (data: Buffer, name = "u.part") => {
    const path = join(staging, name);
    writeFileSync(path, data, { mode: 0o600 });
    return { path, open: async () => createReadStream(path) };
  };
  const objectOf = (data: Buffer): LfsObject => ({ oid: oidOf(data), size: data.length });
  const temporaries = () => readdirSync(join(gitdir, "lfs", "tmp")).length;

  test("goes in as a second name of the staging file, readable by whoever clones, and only once", async () => {
    const data = randomBytes(300_000);
    const file = staged(data);
    expect(await lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), file)).toBe("put");
    const path = lfsPathOf(gitdir, oidOf(data));
    expect(path).toBe(
      join(gitdir, "lfs", "objects", oidOf(data).slice(0, 2), oidOf(data).slice(2, 4), oidOf(data)),
    );
    expect(readFileSync(path).equals(data)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    // The same file, not a copy: no room taken twice.
    expect(statSync(path).ino).toBe(statSync(file.path).ino);
    expect(temporaries()).toBe(0);
    // There already: nothing is written over it.
    const again = staged(data, "v.part");
    expect(await lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), again)).toBe("present");
    expect(statSync(path).ino).toBe(statSync(file.path).ino);
    expect(await lfsObjectsIn(nodeDisk(), gitdir)).toEqual([objectOf(data)]);
  });

  test("is copied where the staging folder is on another disk, and checked all the same", async () => {
    const data = randomBytes(100_000);
    const disk = failing((op) => (op === "link" ? errno("EXDEV") : undefined));
    expect(await lfsPutInto(disk, gitdir, "linux", objectOf(data), staged(data))).toBe("put");
    const path = lfsPathOf(gitdir, oidOf(data));
    expect(readFileSync(path).equals(data)).toBe(true);
    expect(statSync(path).ino).not.toBe(statSync(join(staging, "u.part")).ino);
    // What is not the object is not put there, linked or copied.
    const other = randomBytes(100_000);
    for (const each of [nodeDisk(), disk]) {
      const said = { oid: oidOf(randomBytes(8)), size: other.length };
      await expect(
        lfsPutInto(each, gitdir, "linux", said, staged(other, `${Math.random()}.part`)),
      ).rejects.toBeInstanceOf(NotTheObject);
      expect(existsSync(lfsPathOf(gitdir, said.oid))).toBe(false);
      expect(temporaries()).toBe(0);
    }
  });

  test("a step that fails leaves the staging file to go in again, and nothing half there", async () => {
    const steps = ["mkdir", "link", "hashFile", "chmod", "syncFile", "rename"];
    for (const step of steps) {
      const data = randomBytes(50_000);
      const file = staged(data, `${step}.part`);
      let once = true;
      const disk = failing((op) => {
        if (op !== step || !once) return undefined;
        once = false;
        return errno("EIO");
      });
      await expect(
        lfsPutInto(disk, gitdir, "linux", objectOf(data), file),
        step,
      ).rejects.toMatchObject({ code: "EIO" });
      expect(existsSync(lfsPathOf(gitdir, oidOf(data))), step).toBe(false);
      expect(readFileSync(file.path).equals(data), step).toBe(true);
      if (existsSync(join(gitdir, "lfs", "tmp"))) expect(temporaries(), step).toBe(0);
      // Pushed again, as the worker does: in, whole.
      expect(await lfsPutInto(disk, gitdir, "linux", objectOf(data), file), step).toBe("put");
      expect(readFileSync(lfsPathOf(gitdir, oidOf(data))).equals(data), step).toBe(true);
    }
    // Stopped once it was in its place, before the folder was synced: there, as it is.
    const data = randomBytes(50_000);
    let once = true;
    const late = failing((op, path) => {
      const folder = `${oidOf(data).slice(0, 2)}/${oidOf(data).slice(2, 4)}`;
      if (op !== "syncDir" || !once || !path.endsWith(folder)) return undefined;
      once = false;
      return errno("EIO");
    });
    const file = staged(data, "late.part");
    await expect(lfsPutInto(late, gitdir, "linux", objectOf(data), file)).rejects.toThrow();
    expect(await lfsPutInto(late, gitdir, "linux", objectOf(data), file)).toBe("present");
  });

  test("a disk without room: DiskFull, to be tried again, and nothing left of the copy", async () => {
    const data = randomBytes(50_000);
    const disk = failing((op) =>
      op === "link" ? errno("EXDEV") : op === "writeFrom" ? errno("ENOSPC") : undefined,
    );
    await expect(
      lfsPutInto(disk, gitdir, "linux", objectOf(data), staged(data)),
    ).rejects.toBeInstanceOf(DiskFull);
    expect(existsSync(lfsPathOf(gitdir, oidOf(data)))).toBe(false);
    // A staging file that is gone says so, as a push takes that ("lost").
    await expect(
      lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), {
        path: join(staging, "gone.part"),
        open: async () => createReadStream(join(staging, "gone.part")),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("Windows: a rename refused for a while is tried again", async () => {
    const data = randomBytes(10_000);
    let refusals = 2;
    const disk = failing((op) => (op === "rename" && refusals-- > 0 ? errno("EBUSY") : undefined));
    expect(await lfsPutInto(disk, gitdir, "win32", objectOf(data), staged(data))).toBe("put");
    expect(readFileSync(lfsPathOf(gitdir, oidOf(data))).equals(data)).toBe(true);
  });

  test("two at once of one object: one goes in, the other finds it there", async () => {
    const data = randomBytes(200_000);
    const [a, b] = await Promise.all([
      lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), staged(data, "a.part")),
      lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), staged(data, "b.part")),
    ]);
    expect([a, b]).toContain("put");
    expect(readFileSync(lfsPathOf(gitdir, oidOf(data))).equals(data)).toBe(true);
    expect(temporaries()).toBe(0);
  });

  test("parts read back as they are; one that is not there, or not as large, says so", async () => {
    const data = randomBytes(5000);
    await lfsPutInto(nodeDisk(), gitdir, "linux", objectOf(data), staged(data));
    const read = async (start: number, end: number) => {
      const piece = await lfsReadFrom(nodeDisk(), gitdir, objectOf(data), { start, end });
      const parts: Buffer[] = [];
      for await (const part of piece.body) parts.push(part as Buffer);
      return { ...piece, bytes: Buffer.concat(parts) };
    };
    expect((await read(0, 4999)).bytes.equals(data)).toBe(true);
    const middle = await read(1000, 1999);
    expect(middle).toMatchObject({ start: 1000, size: 5000 });
    expect(middle.bytes.equals(data.subarray(1000, 2000))).toBe(true);
    expect((await read(4999, 4999)).bytes.equals(data.subarray(4999))).toBe(true);
    await expect(
      lfsReadFrom(nodeDisk(), gitdir, { oid: oidOf(data), size: 4999 }, { start: 0, end: 9 }),
    ).rejects.toBeInstanceOf(LfsChanged);
    await expect(
      lfsReadFrom(nodeDisk(), gitdir, objectOf(randomBytes(9)), { start: 0, end: 8 }),
    ).rejects.toBeInstanceOf(LfsAbsent);
  });

  test("what crashes left in lfs/tmp goes after a day, nothing else", async () => {
    const folder = join(gitdir, "lfs", "tmp");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ".tmp-old"), "x");
    writeFileSync(join(folder, ".tmp-new"), "x");
    writeFileSync(join(folder, "someone-elses"), "x");
    const old = (Date.now() - LFS_TMP_STALE_MS - 60_000) / 1000;
    utimesSync(join(folder, ".tmp-old"), old, old);
    utimesSync(join(folder, "someone-elses"), old, old);
    expect(await sweepLfsTemporary(nodeDisk(), gitdir, Date.now())).toBe(1);
    expect(readdirSync(folder).toSorted()).toEqual([".tmp-new", "someone-elses"]);
  });
});

describe.skipIf(!hasGitLfs)("large files of a repository here, with Git LFS itself", () => {
  let dir: string;
  let host: LocalGitRepoHost;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "aq-local-lfs-git-"));
    host = new LocalGitRepoHost({ dataDir: dir, log: quiet });
    await host.prepare();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a clone gets what the server put in, and what `git lfs push` puts in the server finds", async () => {
    const place: LocalPlace = { provider: "local", repoId: 1, dir: "repos/p.git" };
    await host.create(place, "片子", {});
    const gitdir = host.pathOf(place);
    const session = host.open(place);
    // A commit with the pointer, as an archive writes it, and the object the server put in.
    const data = randomBytes(400_000);
    const oid = oidOf(data);
    const stagedPath = join(dir, "u.part");
    writeFileSync(stagedPath, data);
    expect(
      await session.lfsPut(
        { oid, size: data.length },
        { path: stagedPath, open: async () => createReadStream(stagedPath) },
      ),
    ).toBe("put");
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n`;
    const work = join(dir, "work");
    git(dir, ["init", "--quiet", "--initial-branch=main", work]);
    writeFileSync(join(work, ".gitattributes"), "*.mp4 filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(work, "a.mp4"), pointer);
    // As the archive writes it: the pointer as a file of its own, never through the filter.
    git(work, ["add", ".gitattributes"]);
    git(work, ["add", "a.mp4"]);
    git(work, ["commit", "--quiet", "-m", "one"]);
    git(work, ["push", "--quiet", gitdir, "main"]);

    const clone = join(dir, "clone");
    git(dir, ["clone", "--quiet", gitdir, clone]);
    git(clone, ["lfs", "install", "--local"]);
    git(clone, ["lfs", "pull"]);
    expect(readFileSync(join(clone, "a.mp4")).equals(data)).toBe(true);
    git(clone, ["lfs", "fsck"]);

    // People's own: a file Git LFS puts into the repository, which the server then has.
    const theirs = randomBytes(200_000);
    writeFileSync(join(clone, "b.mp4"), theirs);
    git(clone, ["add", "b.mp4"]);
    git(clone, ["commit", "--quiet", "-m", "two"]);
    git(clone, ["push", "--quiet", "origin", "main"]);
    const object = { oid: oidOf(theirs), size: theirs.length };
    expect(await session.lfsHave([object], "download")).toEqual([
      { kind: "present", size: theirs.length },
    ]);
    expect(await session.lfsSizes([object, { oid: oidOf(randomBytes(3)), size: 3 }])).toEqual([
      theirs.length,
      undefined,
    ]);
    const piece = await session.lfsRead(object, { start: 0, end: theirs.length - 1 });
    const parts: Buffer[] = [];
    for await (const part of piece.body) parts.push(part as Buffer);
    expect(Buffer.concat(parts).equals(theirs)).toBe(true);
    git(gitdir, ["fsck", "--strict", "--no-dangling"]);
  });
});

describe("a repository here that goes while a file goes into it", () => {
  test("is tried again later, the staging file kept: not lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aq-local-lfs-moved-"));
    try {
      const place: LocalPlace = { provider: "local", repoId: 1, dir: "repos/p.git" };
      let moved = false;
      const host = new LocalGitRepoHost({
        dataDir: dir,
        log: quiet,
        // As archiving starts over meanwhile: the repository is put aside as the file is linked.
        disk: failing((op) => {
          if (op === "link" && !moved) {
            moved = true;
            renameSync(join(dir, "repos", "p.git"), join(dir, "repos", "aside.git"));
          }
          return undefined;
        }),
      });
      await host.prepare();
      await host.create(place, "片子", {});
      const data = randomBytes(5000);
      const staged = join(dir, "u.part");
      writeFileSync(staged, data);
      await expect(
        host
          .open(place)
          .lfsPut(
            { oid: oidOf(data), size: data.length },
            { path: staged, open: async () => createReadStream(staged) },
          ),
      ).rejects.toBeInstanceOf(GitHubUnavailable);
      expect(readFileSync(staged).equals(data)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
