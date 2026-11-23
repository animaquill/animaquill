import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeGitHub, type FakeRepo } from "../test/fake-github.ts";
import { looseObjects } from "../test/fake-git.ts";
import { GitHubApp, InstallationRefused } from "../github/app.ts";
import { GitHubUnavailable } from "../github/client.ts";
import { GitHubPersonRepos, GitHubRepoHost, INLINE_BYTES } from "./github-host.ts";
import { RepoPaused, RepoRefused, blobShaOf, bytesOf, type RepoSession } from "./repo-host.ts";

/**
 * The Git Data API as the platform writes it, against the fake GitHub, and what comes of it read by
 * a real Git: the objects of the fake go into a bare repository, and `git fsck` looks at them.
 */

const API = "https://github.test/api";
const OCTO = { id: 70000001, login: "octo" };
const AUTHOR = { name: "octo", email: "70000001+octo@users.noreply.github.com" };

const hasGit = spawnSync("git", ["--version"]).status === 0;
// CI has Git; there, a test that needs it must not quietly not run.
if (!hasGit && process.env["CI"]) throw new Error("git is needed for these tests");

/** Puts the objects and the branches of a fake repository into a new bare repository. */
const bareRepository = (repo: FakeRepo) => {
  const dir = mkdtempSync(join(tmpdir(), "aq-fsck-"));
  const run = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  run("init", "--quiet", "--bare", `--initial-branch=${repo.defaultBranch}`, ".");
  for (const [path, data] of looseObjects(repo.objects)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  for (const [branch, sha] of repo.refs) writeFileSync(join(dir, "refs/heads", branch), `${sha}\n`);
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("archiving into GitHub, through its Git Data API", () => {
  let github: FakeGitHub;
  let app: GitHubApp;
  let host: GitHubRepoHost;
  let repo: FakeRepo;
  let installation: number;
  let session: RepoSession;

  beforeEach(() => {
    github = new FakeGitHub();
    installation = github.install(OCTO);
    repo = github.addRepo(OCTO, { name: "film", select: true });
    app = new GitHubApp({
      apiUrl: API,
      fetch: github.fetch,
      issuer: github.clientId,
      privateKey: github.privateKey,
    });
    host = new GitHubRepoHost(app, {
      apiUrl: API,
      webUrl: "https://github.test",
      fetch: github.fetch,
    });
    session = host.open({ installationId: installation, repoId: repo.id });
  });

  test("starts an empty repository, then writes trees and commits that Git itself reads", async () => {
    const info = await session.info();
    expect(info).toMatchObject({ id: repo.id, owner: "octo", name: "film", branch: "main" });
    expect(await session.tip("main")).toBeUndefined();
    const at = new Date("2026-11-10T08:00:00Z");
    const first = await session.start(
      { path: ".gitattributes", text: "# AnimaQuill\n" },
      "开始存档",
      AUTHOR,
      at,
    );
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await session.tip("main")).toBe(first);
    const parent = await session.commit(first as string);

    const big = `${"长".repeat(INLINE_BYTES)}\n`;
    const tree = await session.writeTree(parent!.tree, [
      { path: "animaquill.json", text: '{"id":"p1"}\n' },
      { path: "scenes/intro/index.html", text: "<p>你好</p>\n" },
      { path: "scenes/intro/lib/deep/util.js", text: "export const a = 1;\n" },
      { path: "code/big.js", text: big },
    ]);
    const commit = await session.writeCommit({
      tree,
      parents: [first as string],
      message: "存档\n\nAnimaQuill-Project: p1\nAnimaQuill-Seq: 3\n",
      author: AUTHOR,
      at,
    });
    expect(await session.advance("main", commit)).toBe("moved");

    // Taking a file away, and one in a folder that is then empty.
    const next = await session.writeTree(tree, [
      { path: "scenes/intro/lib/deep/util.js", remove: true },
      { path: "animaquill.json", text: '{"id":"p1","name":"x"}\n' },
    ]);
    const second = await session.writeCommit({
      tree: next,
      parents: [commit],
      message: "自动存档\n",
      author: AUTHOR,
      at,
    });
    expect(await session.advance("main", second)).toBe("moved");
    expect([...github.files(repo.id).keys()].toSorted()).toEqual([
      ".gitattributes",
      "animaquill.json",
      "code/big.js",
      "scenes/intro/index.html",
    ]);
    expect(github.files(repo.id).get("code/big.js")).toBe(big);
    // The large file went as a blob of its own.
    expect(github.calls.filter((call) => call === `POST /repos/octo/film/git/blobs`)).toHaveLength(
      1,
    );

    const entries = await session.tree(next, { recursive: true });
    const index = entries.find((entry) => entry.path === "scenes/intro/index.html");
    expect(index).toMatchObject({ type: "blob", sha: blobShaOf(bytesOf("<p>你好</p>\n")) });
    expect(entries.some((entry) => entry.path === "scenes/intro/lib")).toBe(false);

    if (!hasGit) return;
    const bare = bareRepository(github.repos.get(repo.id) as FakeRepo);
    try {
      bare.run("fsck", "--strict", "--no-dangling");
      expect(bare.run("rev-parse", "main").trim()).toBe(second);
      expect(bare.run("ls-tree", "-r", "--name-only", "main").trim().split("\n")).toEqual([
        ".gitattributes",
        "animaquill.json",
        "code/big.js",
        "scenes/intro/index.html",
      ]);
      expect(bare.run("cat-file", "-p", "main:code/big.js")).toBe(big);
      expect(bare.run("log", "--format=%an <%ae>|%cn <%ce>|%s", "main").trim().split("\n")).toEqual(
        [
          `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|自动存档`,
          `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|存档`,
          `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|开始存档`,
        ],
      );
      expect(
        bare.run("log", "-1", "--format=%(trailers:key=AnimaQuill-Seq,valueonly)", commit).trim(),
      ).toBe("3");
      // What the platform says a file is called by is what Git calls it.
      const hashed = spawnSync("git", ["hash-object", "--stdin"], { input: big, encoding: "utf8" });
      expect(hashed.stdout.trim()).toBe(blobShaOf(bytesOf(big)));
    } finally {
      bare.done();
    }
  });

  test("never moves a branch other than forward", async () => {
    const first = (await session.start(
      { path: ".gitattributes", text: "" },
      "开始",
      AUTHOR,
      new Date(),
    )) as string;
    const base = await session.commit(first);
    const mine = await session.writeCommit({
      tree: await session.writeTree(base!.tree, [{ path: "notes.json", text: "{}" }]),
      parents: [first],
      message: "mine",
      author: AUTHOR,
      at: new Date(),
    });
    // Someone else pushes first.
    const theirs = github.commitAs(repo.id, OCTO, { "README.md": "# film\n" });
    expect(await session.advance("main", mine)).toBe("behind");
    expect(await session.tip("main")).toBe(theirs);
  });

  test("says how two commits stand, as GitHub's compare API: after a forced push too, and without history in common", async () => {
    const a = github.commitAs(repo.id, OCTO, { "a.txt": "a\n" }, "a");
    const b = github.commitAs(repo.id, OCTO, { "b.txt": "b\n" }, "b");
    const c = github.commitAs(repo.id, OCTO, { "c.txt": "c\n" }, "c");
    expect(await session.compare(a, c)).toEqual({ status: "ahead", mergeBase: a });
    expect(await session.compare(c, a)).toEqual({ status: "behind", mergeBase: a });
    expect(await session.compare(b, b)).toEqual({ status: "identical", mergeBase: b });
    // Someone sets the branch back to `a` and goes on from there, forced.
    github.takeDeliveries();
    const other = github.commitAs(repo.id, OCTO, { "d.txt": "d\n" }, "d", { parent: a });
    const [push] = github.takeDeliveries();
    expect(push?.payload).toMatchObject({ before: c, after: other, forced: true });
    expect(await session.compare(c, other)).toEqual({ status: "diverged", mergeBase: a });
    // A history of its own: nothing in common, as for a commit that is not there.
    const alone = github.commitAs(repo.id, OCTO, { "e.txt": "e\n" }, "e", { parent: null });
    expect(await session.compare(c, alone)).toBeUndefined();
    expect(await session.compare(c, "0".repeat(40))).toBeUndefined();
    // A push that goes on from the branch is no forced one.
    github.takeDeliveries();
    github.commitAs(repo.id, OCTO, { "f.txt": "f\n" }, "f");
    expect(github.takeDeliveries()[0]?.payload).toMatchObject({ forced: false });
  });

  test("lists a tree folder by folder where GitHub cuts the whole listing short", async () => {
    github.commitAs(repo.id, OCTO, {
      "a/1.txt": "1",
      "a/b/2.txt": "2",
      "c/3.txt": "3",
      "4.txt": "4",
    });
    const tip = (await session.tip("main")) as string;
    const tree = (await session.commit(tip))!.tree;
    const whole = await session.tree(tree, { recursive: true });
    github.faults.truncate = true;
    const walked = await session.tree(tree, { recursive: true });
    expect(walked.map((entry) => entry.path).toSorted()).toEqual(
      whole.map((entry) => entry.path).toSorted(),
    );
  });

  test("says why there is no token: not installed, suspended, or not covering the repository", async () => {
    const other = github.addRepo(OCTO, { name: "other" });
    await expect(app.token(installation, other.id)).rejects.toMatchObject({
      name: "InstallationRefused",
      reason: "gone",
    });
    github.suspend(OCTO);
    await expect(app.token(installation, repo.id)).rejects.toMatchObject({ reason: "suspended" });
    github.suspend(OCTO, false);
    github.uninstall(OCTO);
    await expect(app.token(installation, repo.id)).rejects.toBeInstanceOf(InstallationRefused);
    await expect(app.token(installation, repo.id)).rejects.toMatchObject({ reason: "uninstalled" });
    // And for the archive, that is a pause.
    const paused = await host
      .open({ installationId: installation, repoId: repo.id })
      .info()
      .catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(RepoPaused);
    expect(paused).toMatchObject({ reason: "uninstalled" });
  });

  test("gets a token for the one repository only, and a new one when GitHub takes the old back", async () => {
    const other = github.addRepo(OCTO, { name: "other", select: true });
    const token = await app.token(installation, repo.id);
    const asOther = await github.fetch(`${API}/repositories/${other.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(asOther.status).toBe(404);
    expect(await app.token(installation, repo.id)).toBe(token);
    github.expireInstallationTokens();
    // The token in memory is turned down: one new token, and the call goes through.
    expect((await session.info()).id).toBe(repo.id);
    expect(github.calls.filter((call) => call.endsWith("/access_tokens"))).toHaveLength(2);
  });

  test("does not take a JWT signed with another key", async () => {
    const stranger = new GitHubApp({
      apiUrl: API,
      fetch: github.fetch,
      issuer: github.clientId,
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" })
        .toString(),
    });
    await expect(stranger.token(installation, repo.id)).rejects.toBeInstanceOf(GitHubUnavailable);
  });

  test("waits as long as GitHub asks when it limits the calls", async () => {
    github.faults.limited = 1;
    const error = await session.info().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitHubUnavailable);
    expect((error as GitHubUnavailable).retryAfterMs).toBe(60_000);
  });
  test("a storage of large files that says the repository is not there, a moment after it was, fails: that is no repository that cannot be used", async () => {
    for (const status of [404, 410]) {
      const odd = new GitHubRepoHost(app, {
        apiUrl: API,
        webUrl: "https://github.test",
        fetch: async (input, init) =>
          String(input instanceof Request ? input.url : input).endsWith("/info/lfs/objects/batch")
            ? Response.json({ message: "Not Found" }, { status })
            : github.fetch(input, init),
      });
      const error = await odd
        .open({ installationId: installation, repoId: repo.id })
        .lfsBatch("upload", [{ oid: "a".repeat(64), size: 3 }])
        .catch((reason: unknown) => reason);
      expect(error, String(status)).toBeInstanceOf(RepoRefused);
      expect(error, String(status)).not.toBeInstanceOf(RepoPaused);
    }
  });

  test("a branch that is not there is a repository that is not there: only an empty one has no commits", async () => {
    await session.start({ path: ".gitattributes", text: "" }, "开始", AUTHOR, new Date());
    github.faults.once.push({ match: /^GET \/repos\/.*\/git\/ref\/heads\//, status: 404 });
    const gone = await session.tip("main").catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(RepoPaused);
    expect(gone).toMatchObject({ reason: "gone" });
    const empty = github.addRepo(OCTO, { name: "empty", select: true });
    expect(
      await host.open({ installationId: installation, repoId: empty.id }).tip("main"),
    ).toBeUndefined();
  });

  test("a file that becomes a folder of the same name goes in one tree: what goes is taken away first", async () => {
    const first = (await session.start(
      { path: ".gitattributes", text: "" },
      "开始",
      AUTHOR,
      new Date(),
    )) as string;
    const base = (await session.commit(first))!.tree;
    const withFile = await session.writeTree(base, [{ path: "code/lib", text: "x" }]);
    const withFolder = await session.writeTree(withFile, [
      { path: "code/lib/index.js", text: "x" },
      { path: "code/lib", remove: true },
    ]);
    const paths = (await session.tree(withFolder, { recursive: true }))
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    expect(paths.toSorted()).toEqual([".gitattributes", "code/lib/index.js"]);
  });

  test("tells a branch that moved from one GitHub does not let move, with what GitHub said", async () => {
    const first = (await session.start(
      { path: ".gitattributes", text: "" },
      "开始",
      AUTHOR,
      new Date(),
    )) as string;
    const base = await session.commit(first);
    const mine = await session.writeCommit({
      tree: await session.writeTree(base!.tree, [{ path: "notes.json", text: "{}" }]),
      parents: [first],
      message: "mine",
      author: AUTHOR,
      at: new Date(),
    });
    const message = "Protected branch update failed for refs/heads/main.";
    github.faults.once.push({ match: /^PATCH /, status: 422, message });
    expect(await session.advance("main", mine)).toEqual({ refused: message });
    github.commitAs(repo.id, OCTO, { "README.md": "# film\n" });
    expect(await session.advance("main", mine)).toBe("behind");
  });
});

describe("what the large file storage of a repository has, as it says itself", () => {
  const oidOf = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  let github: FakeGitHub;
  let repo: FakeRepo;
  /** Whether the addresses the storage gives out can be reached. */
  let reachable = true;
  /** What the addresses the storage gives out answer in place of the object, where a test says. */
  let instead: ((url: string, init: RequestInit | undefined) => Response) | undefined;
  /** The addresses asked for, and how. */
  let asked: { url: string; redirect: string | undefined }[] = [];
  let session: RepoSession;
  let installation: number;

  beforeEach(() => {
    github = new FakeGitHub();
    installation = github.install(OCTO);
    repo = github.addRepo(OCTO, { name: "film", select: true });
    reachable = true;
    instead = undefined;
    asked = [];
    const fetchIt: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/_lfs/")) return github.fetch(input, init);
      asked.push({ url, redirect: init?.redirect });
      if (!reachable) return new Response("Slow Down", { status: 503 });
      return instead?.(url, init) ?? github.fetch(input, init);
    };
    const app = new GitHubApp({
      apiUrl: API,
      fetch: github.fetch,
      issuer: github.clientId,
      privateKey: github.privateKey,
    });
    session = new GitHubRepoHost(app, {
      apiUrl: API,
      webUrl: "https://github.test",
      fetch: fetchIt,
    }).open({ installationId: installation, repoId: repo.id });
  });

  test("says how large each object is that it has, in their order, and nothing of one it has not", async () => {
    const first = Buffer.from("a file of the storage");
    const second = Buffer.alloc(70_000, 7);
    github.addLfsObject(repo.id, first);
    github.addLfsObject(repo.id, second);
    const missing = oidOf(Buffer.from("not there"));
    expect(
      await session.lfsSizes([
        { oid: oidOf(second), size: second.length },
        { oid: missing, size: 9 },
        { oid: oidOf(first), size: first.length },
      ]),
    ).toEqual([second.length, undefined, first.length]);
    expect(await session.lfsSizes([])).toEqual([]);
    // One call of the batch API for all of them, and nothing of the objects is fetched.
    expect(github.calls.filter((call) => call === "POST lfs/batch download")).toHaveLength(1);
    expect(github.calls).not.toContain("GET lfs/object");
  });

  test("goes by what the storage keeps, not by the size it was asked about", async () => {
    const data = Buffer.alloc(5000, 1);
    github.addLfsObject(repo.id, data);
    // A storage that minds the size has none of that size.
    expect(await session.lfsSizes([{ oid: oidOf(data), size: 4999 }])).toEqual([undefined]);
    // One that goes by the oid alone says what was asked: the address says what is there.
    github.faults.lfsAnySize = true;
    expect(await session.lfsSizes([{ oid: oidOf(data), size: 4999 }])).toEqual([5000]);
    // An address that takes GET alone is asked for the first byte, which says the size of all.
    github.faults.lfsNoHead = true;
    expect(await session.lfsSizes([{ oid: oidOf(data), size: 1 }])).toEqual([5000]);
    expect(github.calls).toContain("GET lfs/object");
  });

  test("says so where the storage cannot be asked, rather than that it has nothing", async () => {
    const data = Buffer.alloc(100, 1);
    github.addLfsObject(repo.id, data);
    reachable = false;
    await expect(session.lfsSizes([{ oid: oidOf(data), size: 100 }])).rejects.toBeInstanceOf(
      GitHubUnavailable,
    );
    reachable = true;
    github.faults.lfsDown = 1;
    await expect(session.lfsSizes([{ oid: oidOf(data), size: 100 }])).rejects.toBeInstanceOf(
      GitHubUnavailable,
    );
    expect(await session.lfsSizes([{ oid: oidOf(data), size: 100 }])).toEqual([100]);
  });

  test("goes only where it was told, as it was told: no redirect is followed, and no address but https", async () => {
    const data = Buffer.alloc(100, 1);
    github.addLfsObject(repo.id, data);
    // Its headers would go along to wherever the redirect says, with whatever credential they have.
    instead = () =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/x" } });
    await expect(session.lfsSizes([{ oid: oidOf(data), size: 100 }])).rejects.toBeInstanceOf(
      GitHubUnavailable,
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(({ redirect }) => redirect === "manual")).toBe(true);
    expect(asked.some(({ url }) => url.includes("elsewhere"))).toBe(false);
    // An address over http, from a GitHub that is reached over https: not asked at all.
    instead = undefined;
    asked = [];
    const plain = new GitHubRepoHost(
      new GitHubApp({
        apiUrl: API,
        fetch: github.fetch,
        issuer: github.clientId,
        privateKey: github.privateKey,
      }),
      {
        apiUrl: API,
        webUrl: "https://github.test",
        fetch: async (input, init) => {
          const answer = await github.fetch(input, init);
          const url = String(input instanceof Request ? input.url : input);
          if (!url.endsWith("/objects/batch")) return answer;
          const text = (await answer.text()).replaceAll(
            "https://github.test",
            "http://github.test",
          );
          return new Response(text, { status: answer.status, headers: answer.headers });
        },
      },
    ).open({ installationId: installation, repoId: repo.id });
    await expect(plain.lfsSizes([{ oid: oidOf(data), size: 100 }])).rejects.toBeInstanceOf(
      GitHubUnavailable,
    );
    expect(asked).toEqual([]);
  });
});

describe("a person's own repositories", () => {
  let github: FakeGitHub;
  let repos: GitHubPersonRepos;

  beforeEach(() => {
    github = new FakeGitHub();
    repos = new GitHubPersonRepos({ apiUrl: API, fetch: github.fetch });
  });
  afterEach(() => {
    github.faults.unreachable = false;
  });

  test("makes a private one, which joins the installation, and says when the name is taken", async () => {
    const installation = github.install(OCTO);
    const token = github.grant(OCTO);
    const made = await repos.create(token, { name: "film", description: "AnimaQuill 项目：电影" });
    expect(made).toMatchObject({
      kind: "made",
      repo: { name: "film", private: true, pushable: true },
    });
    const listed = await repos.ofInstallation(token, installation, 1);
    expect(listed.repositories.map((repo) => repo.name)).toEqual(["film"]);
    expect(await repos.create(token, { name: "FILM", description: "" })).toEqual({ kind: "taken" });
  });

  test("cannot make one where the App is not installed on the account", async () => {
    const token = github.grant(OCTO);
    expect(await repos.create(token, { name: "film", description: "" })).toMatchObject({
      kind: "refused",
      status: 403,
    });
  });
});
