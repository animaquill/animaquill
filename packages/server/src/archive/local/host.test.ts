import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitHubUnavailable } from "../../github/client.ts";
import { RepoPaused, type LocalPlace, type RepoSession } from "../repo-host.ts";
import { DiskFull, nodeDisk, type Disk } from "./disk.ts";
import { LocalGitRepoHost, REPOS_MARK } from "./host.ts";
import { STALE_LOCK_MS } from "./refs.ts";

/**
 * The repositories of the server's own, against a real Git: what is written reads in `git fsck
 * --strict`, clones, and logs; what Git writes (a push, `git gc --aggressive`) reads here; and a
 * disk that fails at any step, or two writers at once, leave the branch where it was or where it
 * went, never anywhere else.
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit && process.env["CI"]) throw new Error("git is needed for these tests");

const AUTHOR = { name: "artist", email: "artist@example.com" };
const AT = new Date("2026-11-10T08:00:00Z");
const quiet = { info() {}, warn() {}, error() {} };
const PLACE: LocalPlace = { provider: "local", repoId: 7, dir: "repos/p1.git" };

/** A disk that fails where a test says, once each. */
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
    writeFile: at("writeFile", disk.writeFile),
    rename: at("rename", disk.rename),
    syncDir: at("syncDir", disk.syncDir),
    mkdir: at("mkdir", disk.mkdir),
  };
};

const errno = (code: string) => Object.assign(new Error(code), { code });

let dataDir: string;
let host: LocalGitRepoHost;
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const gitdir = () => join(dataDir, "repos", "p1.git");

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "aq-local-"));
  host = new LocalGitRepoHost({ dataDir, log: quiet });
  expect(await host.prepare()).toBe("made");
  await host.create(PLACE, "我的片子", { owner: "u1", project: "p1" });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** An archive as the archiver makes one: a tree on the tip's, a commit, the branch moved. */
const archive = async (session: RepoSession, files: Record<string, string>, message = "存档") => {
  const tip = await session.tip("main");
  if (tip === undefined) {
    await session.start({ path: ".gitattributes", text: "# AnimaQuill\n" }, "开始存档", AUTHOR, AT);
    return archive(session, files, message);
  }
  const base = (await session.commit(tip))!.tree;
  const tree = await session.writeTree(
    base,
    Object.entries(files).map(([path, text]) => ({ path, text })),
  );
  const sha = await session.writeCommit({ tree, parents: [tip], message, author: AUTHOR, at: AT });
  return { sha, moved: await session.advance("main", sha) };
};

describe.skipIf(!hasGit)("with a real Git", () => {
  test("what is written reads in git fsck --strict, clones and logs, with a reflog", async () => {
    const session = host.open(PLACE);
    await archive(session, { "animaquill.json": "{}", "scenes/a.html": "<p>甲</p>" });
    await archive(session, { "scenes/a.html": "<p>乙</p>" });
    git(gitdir(), "fsck", "--strict", "--no-dangling");
    const log = git(gitdir(), "log", "--format=%s", "main");
    expect(log.trim().split("\n")).toEqual(["存档", "存档", "开始存档"]);
    expect(git(gitdir(), "reflog", "main").trim().split("\n")).toHaveLength(3);
    expect(readFileSync(join(gitdir(), "description"), "utf8")).toBe("我的片子\n");
    const clone = join(dataDir, "clone");
    git(dataDir, "clone", "--quiet", gitdir(), clone);
    expect(readFileSync(join(clone, "scenes/a.html"), "utf8")).toBe("<p>乙</p>");
  });

  test("a push of people's own reads, a forced one is no fast-forward, and gc changes nothing", async () => {
    const session = host.open(PLACE);
    const { sha: ours } = await archive(session, { "animaquill.json": "{}" });
    const clone = join(dataDir, "clone");
    git(dataDir, "clone", "--quiet", gitdir(), clone);
    git(clone, "config", "user.name", "me");
    git(clone, "config", "user.email", "me@example.com");
    writeFileSync(join(clone, "notes.md"), "mine\n");
    git(clone, "add", "notes.md");
    git(clone, "commit", "--quiet", "-m", "mine");
    git(clone, "push", "--quiet", "origin", "main");
    const pushed = git(clone, "rev-parse", "HEAD").trim();

    const again = host.open(PLACE);
    expect(await again.tip("main")).toBe(pushed);
    expect(await again.compare(ours, pushed)).toMatchObject({ status: "ahead" });
    const listing = await again.tree((await again.commit(pushed))!.tree, { recursive: true });
    const files = await again.files(pushed, listing);
    expect(Buffer.from(files.get("notes.md")!).toString()).toBe("mine\n");

    // Packed, refs and all: everything still reads, and archives go on.
    git(gitdir(), "gc", "--quiet", "--aggressive", "--prune=now");
    expect(existsSync(join(gitdir(), "packed-refs"))).toBe(true);
    const packed = host.open(PLACE);
    expect(await packed.tip("main")).toBe(pushed);
    const { moved } = await archive(packed, { "scenes/b.html": "b" });
    expect(moved).toBe("moved");
    git(gitdir(), "fsck", "--strict", "--no-dangling");

    // History rewritten from the clone: the platform's tip is no ancestor any more.
    git(clone, "reset", "--quiet", "--hard", ours);
    writeFileSync(join(clone, "other.md"), "x\n");
    git(clone, "add", "other.md");
    git(clone, "commit", "--quiet", "-m", "other");
    git(clone, "push", "--quiet", "--force", "origin", "main");
    const forced = git(clone, "rev-parse", "HEAD").trim();
    const after = host.open(PLACE);
    const tip = await after.tip("main");
    expect(tip).toBe(forced);
    const head = (await packed.compare(forced, forced))!;
    expect(head.status).toBe("identical");
  });

  test("a lock Git holds keeps the branch as it is; one left by a crash goes", async () => {
    const session = host.open(PLACE);
    const { sha } = await archive(session, { "animaquill.json": "{}" });
    const lock = join(gitdir(), "refs/heads/main.lock");
    writeFileSync(lock, "");
    const tree = (await session.commit(sha))!.tree;
    const next = await session.writeCommit({
      tree,
      parents: [sha],
      message: "x",
      author: AUTHOR,
      at: AT,
    });
    expect(await session.advance("main", next)).toBe("behind");
    expect(await session.tip("main")).toBe(sha);
    const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(await session.advance("main", next)).toBe("moved");
    expect(existsSync(lock)).toBe(false);
    git(gitdir(), "fsck", "--strict", "--no-dangling");
  });
});

describe("a disk that fails", () => {
  for (const [op, which] of [
    ["writeFile", "object"],
    ["rename", "object"],
    ["writeFile", "lock"],
    ["rename", "lock"],
    ["syncDir", "refs"],
  ] as const) {
    test(`at ${op} of the ${which}: the branch stays or moved whole, and no temporary file stays`, async () => {
      const session = host.open(PLACE);
      const { sha: before } = await archive(session, { "animaquill.json": "{}" });
      let armed = true;
      const broken = new LocalGitRepoHost({
        dataDir,
        log: quiet,
        disk: failing((at, path) => {
          if (!armed || at !== op) return undefined;
          const hit =
            which === "object"
              ? /objects[\\/][0-9a-f]{2}[\\/]tmp_obj_/.test(path) ||
                /objects[\\/][0-9a-f]{2}$/.test(path)
              : which === "lock"
                ? path.endsWith("main.lock")
                : path.endsWith(join("refs", "heads"));
          if (!hit) return undefined;
          armed = false;
          return errno(op === "writeFile" ? "ENOSPC" : "EIO");
        }),
      });
      const failed = broken.open(PLACE);
      await expect(archive(failed, { "scenes/a.html": "a" })).rejects.toBeTruthy();
      const tip = await host.open(PLACE).tip("main");
      // The rename of the lock is the step after which the branch has moved.
      if (which === "refs") expect(tip).not.toBe(before);
      else expect(tip).toBe(before);
      expect(existsSync(join(gitdir(), "refs/heads/main.lock"))).toBe(false);
      const leftovers = readdirSync(join(gitdir(), "objects"), { recursive: true }).filter((name) =>
        String(name).includes("tmp_obj_"),
      );
      expect(leftovers).toEqual([]);
      if (hasGit) git(gitdir(), "fsck", "--strict", "--no-dangling");
      // And it goes on from there.
      const { moved } = await archive(host.open(PLACE), { "scenes/a.html": "a" });
      expect(moved).toBe("moved");
    });
  }

  test("full: the archive fails as DiskFull, to be tried again", async () => {
    const full = new LocalGitRepoHost({
      dataDir,
      log: quiet,
      disk: failing((op, path) =>
        op === "writeFile" && path.includes("tmp_obj_") ? errno("ENOSPC") : undefined,
      ),
    });
    await expect(archive(full.open(PLACE), { "a.txt": "a" })).rejects.toBeInstanceOf(DiskFull);
  });

  test("Windows refusing a rename for a while: tried again", async () => {
    let refusals = 2;
    const busy = new LocalGitRepoHost({
      dataDir,
      log: quiet,
      platform: "win32",
      disk: failing((op) => (op === "rename" && refusals-- > 0 ? errno("EBUSY") : undefined)),
    });
    const { moved } = await archive(busy.open(PLACE), { "a.txt": "a" });
    expect(moved).toBe("moved");
    expect(refusals).toBeLessThan(0);
  });

  test("two sessions moving the branch at once: one moves it, the other is behind", async () => {
    const first = host.open(PLACE);
    const { sha: base } = await archive(first, { "a.txt": "a" });
    const second = host.open(PLACE);
    const tree = (await first.commit(base))!.tree;
    const make = (session: RepoSession, text: string) =>
      session
        .writeTree(tree, [{ path: "b.txt", text }])
        .then((t) =>
          session.writeCommit({ tree: t, parents: [base], message: text, author: AUTHOR, at: AT }),
        );
    const [one, two] = await Promise.all([make(first, "1"), make(second, "2")]);
    const outcomes = await Promise.all([first.advance("main", one), second.advance("main", two)]);
    expect(outcomes.toSorted()).toEqual(["behind", "moved"]);
    const tip = await host.open(PLACE).tip("main");
    expect([one, two]).toContain(tip);
  });
});

describe("what is wrong with a repository", () => {
  test("an object that is not what its name says is broken, as the weekly look finds", async () => {
    const session = host.open(PLACE);
    const { sha } = await archive(session, { "a.txt": "some text" });
    await host.verify(PLACE);
    const tree = (await session.commit(sha))!.tree;
    const entry = (await session.tree(tree)).find((item) => item.path === "a.txt")!;
    const path = join(gitdir(), "objects", entry.sha.slice(0, 2), entry.sha.slice(2));
    const bytes = readFileSync(path);
    bytes[bytes.length - 3] ^= 0xff;
    writeFileSync(path, bytes);
    await expect(host.verify(PLACE)).rejects.toMatchObject({ reason: "broken" });
    await expect(host.open(PLACE).blob(entry.sha)).rejects.toBeInstanceOf(RepoPaused);
  });

  test("a repository taken away is gone; repos/ without its mark only cannot be reached", async () => {
    await archive(host.open(PLACE), { "a.txt": "a" });
    rmSync(gitdir(), { recursive: true });
    await expect(host.open(PLACE).info()).rejects.toMatchObject({ reason: "gone" });
    rmSync(join(dataDir, "repos", REPOS_MARK));
    await expect(host.open(PLACE).info()).rejects.toBeInstanceOf(GitHubUnavailable);
  });

  test("put aside, listed with what it says of itself, and a folder not marked is not taken", async () => {
    expect(await host.list()).toEqual([{ dir: "repos/p1.git", owner: "u1", project: "p1" }]);
    const aside = await host.putAside(PLACE, AT);
    expect(aside).toBe("repos/broken/p1-20261110T080000Z.git");
    expect(existsSync(join(dataDir, aside!, "HEAD"))).toBe(true);
    expect(await host.list()).toEqual([]);
    await host.create(PLACE, "again", { owner: "u1" });
    expect(await host.open(PLACE).tip("main")).toBeUndefined();

    const other = mkdtempSync(join(tmpdir(), "aq-local-"));
    mkdirSync(join(other, "repos", "x.git"), { recursive: true });
    await expect(new LocalGitRepoHost({ dataDir: other, log: quiet }).prepare()).rejects.toThrow(
      REPOS_MARK,
    );
    rmSync(other, { recursive: true, force: true });
  });
});
