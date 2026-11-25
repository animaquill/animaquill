import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeGitHub } from "../test/fake-github.ts";
import { GitHubApp } from "../github/app.ts";
import { GitHubRepoHost } from "./github-host.ts";
import { LocalGitRepoHost } from "./local/host.ts";
import { blobShaOf, bytesOf, type RepoSession } from "./repo-host.ts";

/**
 * What the archive takes of every repository session (`RepoSession`), whichever provider it is on:
 * the fake GitHub and the repositories of the server's own answer the same.
 */

const AUTHOR = { name: "octo", email: "octo@example.com" };
const AT = new Date("2026-11-10T08:00:00Z");
const quiet = { info() {}, warn() {}, error() {} };

interface Made {
  readonly session: RepoSession;
  readonly done: () => void;
}

const providers: Record<string, () => Promise<Made>> = {
  github: async () => {
    const github = new FakeGitHub();
    const person = { id: 70000001, login: "octo" };
    const installation = github.install(person);
    const repo = github.addRepo(person, { name: "film", select: true });
    const app = new GitHubApp({
      apiUrl: "https://github.test/api",
      fetch: github.fetch,
      issuer: github.clientId,
      privateKey: github.privateKey,
    });
    const host = new GitHubRepoHost(app, {
      apiUrl: "https://github.test/api",
      webUrl: "https://github.test",
      fetch: github.fetch,
    });
    return {
      session: host.open({ provider: "github", installationId: installation, repoId: repo.id }),
      done: () => {},
    };
  },
  local: async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aq-local-"));
    const host = new LocalGitRepoHost({ dataDir, log: quiet });
    await host.prepare();
    const place = { provider: "local" as const, repoId: 1, dir: "repos/film.git" };
    await host.create(place, "film", {});
    return {
      session: host.open(place),
      done: () => rmSync(dataDir, { recursive: true, force: true }),
    };
  },
};

describe.each(Object.keys(providers))("a repository session on %s", (provider) => {
  let made: Made | undefined;
  afterEach(() => made?.done());

  const open = async () => {
    made = await providers[provider]!();
    return made.session;
  };

  test("starts an empty repository once, and goes on from it only as a fast-forward", async () => {
    const session = await open();
    const info = await session.info();
    expect(info.branch).toBe("main");
    expect(await session.tip("main")).toBeUndefined();
    const first = await session.start(
      { path: ".gitattributes", text: "# a\n" },
      "开始存档",
      AUTHOR,
      AT,
    );
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await session.tip("main")).toBe(first);
    expect(
      await session.start({ path: ".gitattributes", text: "# b\n" }, "again", AUTHOR, AT),
    ).toBeUndefined();

    const base = (await session.commit(first!))!.tree;
    const tree = await session.writeTree(base, [
      { path: "animaquill.json", text: '{"id":"x"}' },
      { path: "scenes/a/index.html", text: "<p>a</p>" },
      { path: "scenes/b.html", text: "b" },
    ]);
    const second = await session.writeCommit({
      tree,
      parents: [first!],
      message: "存档",
      author: AUTHOR,
      at: AT,
    });
    expect(await session.advance("main", second)).toBe("moved");
    expect(await session.tip("main")).toBe(second);

    const listing = await session.tree(tree, { recursive: true });
    const paths = listing.map((entry) => `${entry.type}:${entry.path}`).toSorted();
    expect(paths).toEqual([
      "blob:.gitattributes",
      "blob:animaquill.json",
      "blob:scenes/a/index.html",
      "blob:scenes/b.html",
      "tree:scenes",
      "tree:scenes/a",
    ]);
    const file = listing.find((entry) => entry.path === "scenes/b.html")!;
    expect(file.sha).toBe(blobShaOf(bytesOf("b")));
    expect(Buffer.from(await session.blob(file.sha)).toString()).toBe("b");
    const files = await session.files(second, listing);
    expect(Buffer.from(files.get("scenes/a/index.html")!).toString()).toBe("<p>a</p>");

    // A folder where a file was, in one tree: what goes goes first; a folder left empty goes.
    const swapped = await session.writeTree(tree, [
      { path: "scenes/b.html", remove: true },
      { path: "scenes/b.html/inner.txt", text: "now a folder" },
      { path: "scenes/a/index.html", remove: true },
    ]);
    const after = await session.tree(swapped, { recursive: true });
    expect(after.map((entry) => `${entry.type}:${entry.path}`).toSorted()).toEqual([
      "blob:.gitattributes",
      "blob:animaquill.json",
      "blob:scenes/b.html/inner.txt",
      "tree:scenes",
      "tree:scenes/b.html",
    ]);

    // Another commit on top of the first, not of the second: no fast-forward.
    const aside = await session.writeCommit({
      tree: swapped,
      parents: [first!],
      message: "aside",
      author: AUTHOR,
      at: AT,
    });
    expect(await session.advance("main", aside)).toBe("behind");
    expect(await session.tip("main")).toBe(second);

    expect(await session.compare(first!, second)).toMatchObject({ status: "ahead" });
    expect(await session.compare(second, first!)).toMatchObject({ status: "behind" });
    expect(await session.compare(second, second)).toMatchObject({ status: "identical" });
    expect(await session.compare(second, aside)).toEqual({ status: "diverged", mergeBase: first });
    expect(await session.commit("0".repeat(40))).toBeUndefined();
    expect((await session.commit(second))!.parents).toEqual([first]);
  });
});
