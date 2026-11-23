import { INSTRUCTIONS_FILE, INSTRUCTIONS_START } from "@animaquill/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { clock, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import {
  CODE,
  LINES,
  archiveAndMerge,
  conflictsOf,
  linkRow,
  mergeWorld,
  mergesOf,
  projectFilesOf,
  pushOnGitHub,
  withLine,
  workingFiles,
  type MergeWorld,
} from "../test/merge-support.ts";
import { archives, projectBatches, repoConflicts, repoMerges } from "../schema.ts";
import { changeSetting, readSetting } from "../settings.ts";
import { sweepProjects } from "../sync/sweep.ts";
import { REPO_MERGE_SETTING } from "./merging.ts";
import { trailersOf } from "./plan.ts";
import type { RepoHost, RepoSession } from "./repo-host.ts";
import { takeDue } from "./schedule.ts";

/**
 * Archiving with merges of what changed on GitHub: the archive looks, the hub merges, the archive
 * writes the merge commit; and every reason it stops instead, on a real PostgreSQL and the fake
 * GitHub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("merging changes on GitHub as archives go, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db, clock(new Date()));
  });

  const code = (m: MergeWorld) => workingFiles(m).get(CODE) ?? "";
  const tipOf = (m: MergeWorld) => m.w.github.history(m.repo.id)[0]!;
  /** What the platform pushed: none of it forced. */
  const platformPushes = (m: MergeWorld) =>
    m.w.github
      .takeDeliveries()
      .filter(
        (delivery) =>
          delivery.event === "push" &&
          (delivery.payload.sender as { login?: string } | undefined)?.login?.endsWith("[bot]"),
      );

  test("off, a file of the project changed on GitHub pauses archiving as before merges: nothing is looked at more", async () => {
    const m = await mergeWorld(w, { merging: false });
    const before = m.w.github.compared;
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") } });
    await m.window.change({ type: "project.rename", params: { name: "改了" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "diverged" }]);
    const link = await linkRow(m);
    expect(link.diverged).toEqual({ sha: tipOf(m).sha, files: [CODE], deleted: [] });
    expect(await mergesOf(m)).toEqual([]);
    expect(m.w.github.compared).toBe(before);
    // The setting is what the worker goes by: off unless an admin turned it on.
    expect(await readSetting(t.db, REPO_MERGE_SETTING)).toEqual({ enabled: false });
  });

  test("on, the setting of the admin site is what an archive goes by", async () => {
    const m = await mergeWorld(w, { merging: false });
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") } });
    await changeSetting(t.db, REPO_MERGE_SETTING, { enabled: true }, { adminId: null });
    try {
      const { Archiver } = await import("./archiver.ts");
      const { ProjectExporter } = await import("./exporter.ts");
      const archiver = new Archiver({
        db: t.db,
        host: w.host,
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: { info() {}, warn() {}, error() {} },
        enqueueMerge: async (merge) => {
          m.queued.push(merge);
        },
      });
      expect(await archiver.run(m.project, "check")).toMatchObject({ kind: "merging" });
    } finally {
      await changeSetting(t.db, REPO_MERGE_SETTING, { enabled: false }, { adminId: null });
    }
  });

  test("only GitHub changed: merged into the working copy, and the branch stays as it is, with no commit of the platform's", async () => {
    const m = await mergeWorld(w);
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") },
    });
    const outcomes = await archiveAndMerge(m, "check");
    expect(outcomes[0]).toMatchObject({ kind: "merging" });
    expect(code(m)).toContain("v2 = 22");
    // The archive the hub queued: the project is what GitHub has, nothing to write.
    expect(m.archivesQueued).toContain(m.project);
    expect(outcomes[1]).toMatchObject({ kind: "unchanged" });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "same" }]);
    expect(tipOf(m).sha).toBe(theirs);
    expect(await linkRow(m)).toMatchObject({ headSha: theirs, mergedSha: null, state: "ready" });
    const [merge] = await mergesOf(m);
    expect(merge).toMatchObject({ state: "applied", toSha: theirs, input: null });
  });

  test("both changed: the merge commit goes on from GitHub's, with the editor's archive from before the merge as its second parent", async () => {
    const m = await mergeWorld(w);
    const archived = (await linkRow(m)).headSha!;
    await m.window.change({ type: "project.rename", params: { name: "编辑器改的" } });
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") },
    });
    m.w.github.takeDeliveries();
    const outcomes = await archiveAndMerge(m);
    expect(outcomes.map(({ kind }) => kind)).toEqual(["merging", "archived"]);
    const [mc] = m.w.github.history(m.repo.id);
    expect(mc!.parents).toHaveLength(2);
    expect(mc!.parents[0]).toBe(theirs);
    const e = mc!.parents[1]!;
    const files = projectFilesOf(m);
    expect(files.get(CODE)).toContain("v2 = 22");
    expect(JSON.parse(files.get("animaquill.json")!).name).toBe("编辑器改的");
    // E: the project before the merge, on top of the archive before it, without GitHub's change.
    const before = projectFilesOf(m, e);
    expect(JSON.parse(before.get("animaquill.json")!).name).toBe("编辑器改的");
    expect(before.get(CODE)).toBe(LINES.join(""));
    const eCommit = m.w.github.filesAt(m.repo.id, e);
    expect(eCommit.size).toBeGreaterThan(0);
    const history = m.w.github.history(m.repo.id);
    expect(history.map(({ sha }) => sha)).toContain(theirs);
    expect(history.map(({ sha }) => sha)).toContain(archived);
    expect(trailersOf(mc!.message)?.project).toBe(m.project);
    expect(mc!.message.split("\n")[0]).toBe("存档（合并了 GitHub 上的改动）");
    for (const push of platformPushes(m)) expect(push.payload.forced).toBe(false);
    expect(await linkRow(m)).toMatchObject({ headSha: mc!.sha, mergedSha: null, mergeFrom: null });
    const [row] = await t.db
      .select()
      .from(archives)
      .where(and(eq(archives.projectId, m.project), eq(archives.sha, mc!.sha)));
    expect(row).toMatchObject({ kind: "merge", parentSha: theirs });
    // Made again, E is the same commit: the archive before is where it was, the time the snapshot's.
    expect(m.w.github.history(m.repo.id).length).toBeGreaterThan(2);
  });

  test("a conflict pauses archiving, GitHub keeps its own meanwhile, and choosing goes on with the merge commit", async () => {
    const m = await mergeWorld(w);
    await m.window.change({
      type: "file.write",
      params: { path: CODE, text: withLine(LINES.join(""), 2, "export const v2 = 1000;\n") },
    });
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") },
    });
    const outcomes = await archiveAndMerge(m);
    expect(outcomes[0]).toMatchObject({ kind: "merging" });
    // The archive after the merge only looks, as it is paused.
    expect(outcomes.at(-1)).toEqual({ kind: "checked" });
    expect(await linkRow(m)).toMatchObject({ state: "paused", pauseReason: "conflicts" });
    expect(code(m)).toContain("v2 = 1000");
    const open = (await conflictsOf(m)).filter(({ state }) => state === "open");
    expect(open).toHaveLength(1);
    expect(tipOf(m).sha).toBe(theirs);
    // "Archive now" of an editor from before merges does not go past it.
    const status = await m.service.archiveNow({ userId: w.userId } as never, m.project);
    expect(status).toMatchObject({ state: "paused", reason: "conflicts", conflicts: 1 });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "checked" }]);
    expect(tipOf(m).sha).toBe(theirs);
    // A push meanwhile is merged all the same.
    const later = pushOnGitHub(m, { files: { "code/more.js": "export const more = 1;\n" } });
    expect((await archiveAndMerge(m, "check")).map(({ kind }) => kind)).toEqual([
      "merging",
      "checked",
    ]);
    expect(workingFiles(m).get("code/more.js")).toBe("export const more = 1;\n");
    expect(tipOf(m).sha).toBe(later);
    // People keep the editor's: archiving goes on, on top of GitHub's.
    const resolved = await m.service.resolveConflicts({ userId: w.userId } as never, m.project, {
      ids: open.map(({ id }) => id),
      keep: "ours",
    });
    expect(resolved).toMatchObject({ resolved: 1, status: { state: "ready", conflicts: 0 } });
    expect(m.archivesQueued).toContain(m.project);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    const [mc] = m.w.github.history(m.repo.id);
    expect(mc!.parents[0]).toBe(later);
    expect(projectFilesOf(m).get(CODE)).toContain("v2 = 1000");
    expect(projectFilesOf(m).get("code/more.js")).toBe("export const more = 1;\n");
  });

  test("a document on GitHub that does not read is blocked, not merged, and not written over until people choose", async () => {
    const m = await mergeWorld(w);
    const theirs = pushOnGitHub(m, {
      files: {
        "scenes/intro/scene.json": "{ not json",
        [CODE]: withLine(LINES.join(""), 3, "export const v3 = 33;\n"),
      },
    });
    const outcomes = await archiveAndMerge(m);
    expect(outcomes[0]).toMatchObject({ kind: "merging" });
    expect(code(m)).toContain("v3 = 33");
    const link = await linkRow(m);
    expect(link).toMatchObject({ state: "paused", pauseReason: "blocked", mergedSha: theirs });
    expect(link.blocked).toEqual([
      expect.objectContaining({ path: "scenes/intro/scene.json", reason: "invalid" }),
    ]);
    expect(await m.service.status({ userId: w.userId } as never, m.project)).toMatchObject({
      reason: "blocked",
      blocked: [{ path: "scenes/intro/scene.json", reason: "invalid" }],
      merge: { sha: theirs },
    });
    expect(m.w.github.files(m.repo.id).get("scenes/intro/scene.json")).toBe("{ not json");
    // Put right on GitHub: merged again from where it was before, and archiving goes on.
    const fixed = projectFilesOf(m, (await mergesOf(m))[0]!.fromSha).get(
      "scenes/intro/scene.json",
    )!;
    const right = pushOnGitHub(m, { files: { "scenes/intro/scene.json": fixed } });
    const again = await archiveAndMerge(m, "check");
    // Nothing of the editor's on top: the branch is the archive as it is.
    expect(again.map(({ kind }) => kind)).toEqual(["merging", "unchanged"]);
    expect(await linkRow(m)).toMatchObject({
      state: "ready",
      blocked: [],
      mergedSha: null,
      headSha: right,
    });
    expect(projectFilesOf(m).get(CODE)).toContain("v3 = 33");
  });

  test("a document on GitHub that does not read is written over once people choose the editor's", async () => {
    const m = await mergeWorld(w);
    pushOnGitHub(m, { files: { "scenes/intro/scene.json": "{ not json" } });
    await archiveAndMerge(m);
    expect(await linkRow(m)).toMatchObject({ pauseReason: "blocked" });
    await m.service.useEditorFor(
      { userId: w.userId } as never,
      m.project,
      "scenes/intro/scene.json",
    );
    expect(await linkRow(m)).toMatchObject({ state: "ready", blocked: [] });
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    expect(JSON.parse(m.w.github.files(m.repo.id).get("scenes/intro/scene.json")!)).toMatchObject({
      name: "开场",
    });
  });

  test("files on GitHub that are no text the editor reads are never merged: a link, a submodule, bytes", async () => {
    const m = await mergeWorld(w);
    const theirs = pushOnGitHub(m, {
      files: {
        [CODE]: Buffer.from([0xff, 0xfe, 0x00, 0x01]),
        "scenes/intro/index.html": { link: "../../README.md" },
      },
    });
    const outcomes = await archiveAndMerge(m);
    expect(outcomes).toEqual([{ kind: "paused", reason: "blocked" }]);
    const link = await linkRow(m);
    expect(link.mergedSha).toBe(theirs);
    expect(link.blocked.map(({ path, reason }) => [path, reason]).toSorted()).toEqual([
      [CODE, "unreadable"],
      ["scenes/intro/index.html", "unreadable"],
    ]);
    expect(code(m)).toBe(LINES.join(""));
    expect(await mergesOf(m)).toEqual([]);
    const submodule = pushOnGitHub(m, {
      files: {
        [CODE]: LINES.join(""),
        "code/vendor.js": { submodule: "1".repeat(40) },
        "scenes/intro/index.html": "<p>intro</p>\n",
      },
    });
    // Put right, and a submodule where the project has no file: nothing of the project's, merged.
    expect((await archiveAndMerge(m, "check")).map(({ kind }) => kind)).toEqual([
      "merging",
      "unchanged",
    ]);
    const now = await linkRow(m);
    expect(now).toMatchObject({ headSha: submodule, mergedSha: null, blocked: [], state: "ready" });
  });

  test("a project with locked tags takes no merge: the files wait, and go in once the project changes", async () => {
    const m = await mergeWorld(w);
    await m.window.change({
      type: "project.setTags",
      params: { tags: [{ name: "定稿", locked: true }] },
    });
    await archiveAndMerge(m);
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 4, "export const v4 = 44;\n") } });
    await archiveAndMerge(m, "check");
    const link = await linkRow(m);
    expect(link).toMatchObject({ state: "paused", pauseReason: "locked" });
    expect(link.blocked).toEqual([expect.objectContaining({ path: CODE, reason: "locked" })]);
    expect(code(m)).toBe(LINES.join(""));
    await m.window.change({ type: "project.setTags", params: { tags: [] } });
    expect(await takeDue(t.db, new Date(Date.now() + 3600_000), { merging: true })).toContain(
      m.project,
    );
    const outcomes = await archiveAndMerge(m);
    expect(outcomes[0]).toMatchObject({ kind: "merging" });
    expect(code(m)).toContain("v4 = 44");
    expect(await linkRow(m)).toMatchObject({ blocked: [] });
  });

  test("history rewritten on GitHub is not merged by itself: people choose to merge from what both have, and the archive has GitHub's commit as its one parent", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    // Someone commits a secret, the platform merges it, and then they take it away, forced.
    const secret = pushOnGitHub(m, { files: { "code/secret.js": "export const key = 'sk';\n" } });
    await archiveAndMerge(m, "check");
    expect(workingFiles(m).get("code/secret.js")).toBeDefined();
    await m.window.change({ type: "file.remove", params: { path: "code/secret.js" } });
    await m.window.change({ type: "project.rename", params: { name: "编辑器的" } });
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const [forced] = m.w.github.deliveries
      .filter((delivery) => delivery.event === "push")
      .slice(-1);
    expect(forced?.payload.forced).toBe(true);
    const clean = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 5, "export const v5 = 55;\n") },
    });
    const outcomes = await archiveAndMerge(m);
    expect(outcomes).toEqual([{ kind: "paused", reason: "rewritten" }]);
    const link = await linkRow(m);
    expect(link.diverged).toMatchObject({ sha: clean, base: start, merging: true });
    expect(code(m)).not.toContain("v5 = 55");
    expect(tipOf(m).sha).toBe(clean);
    // Archive now without `replace` does not go on top of it.
    await expect(
      m.service.archiveNow({ userId: w.userId } as never, m.project),
    ).rejects.toMatchObject({ code: "diverged" });
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    // First what the history taken away brought goes out (the secret), then GitHub's is merged.
    const merged = await archiveAndMerge(m);
    expect(merged.map(({ kind }) => kind)).toEqual(["merging", "merging", "archived"]);
    expect(code(m)).toContain("v5 = 55");
    const [mc] = m.w.github.history(m.repo.id);
    expect(mc!.parents).toEqual([clean]);
    const all = new Set<string>();
    const walk = [mc!.sha];
    while (walk.length > 0) {
      const sha = walk.pop()!;
      if (all.has(sha)) continue;
      all.add(sha);
      walk.push(...(m.w.github.repos.get(m.repo.id)!.objects.readCommit(sha).parents as string[]));
    }
    expect(all.has(secret)).toBe(false);
    expect(projectFilesOf(m).has("code/secret.js")).toBe(false);
    expect(await linkRow(m)).toMatchObject({ mergeFrom: null, mergedSha: null, state: "ready" });
  });

  test("merging GitHub's rewritten history takes out of the project what the history taken away brought: a secret forced away stays away", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    pushOnGitHub(m, {
      files: {
        "code/secret.js": "export const key = 'sk';\n",
        [CODE]: withLine(LINES.join(""), 1, "export const v1 = 'leaked';\n"),
      },
    });
    await archiveAndMerge(m, "check");
    expect(workingFiles(m).get("code/secret.js")).toBeDefined();
    // The editor goes on, and never touches what came from GitHub.
    await m.window.change({ type: "project.rename", params: { name: "编辑器的" } });
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    const outcomes = await archiveAndMerge(m);
    expect(outcomes.map(({ kind }) => kind)).toEqual(["merging", "merging", "archived"]);
    expect(await archiveAndMerge(m)).toEqual([{ kind: "same" }]);
    const files = m.w.github.files(m.repo.id);
    expect(files.has("code/secret.js")).toBe(false);
    expect(files.get(CODE)).not.toContain("leaked");
    expect(files.get("code/clean.js")).toBe("export const c = 1;\n");
    expect(JSON.parse(files.get("animaquill.json")!).name).toBe("编辑器的");
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
    expect(tipOf(m).parents).toEqual([clean]);
    expect(await conflictsOf(m)).toEqual([]);
  });

  test("what the editor changed since of what history taken away brought stays, as a conflict for people to choose", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    pushOnGitHub(m, { files: { "code/secret.js": "export const key = 'sk';\n" } });
    await archiveAndMerge(m, "check");
    await m.window.change({
      type: "file.write",
      params: { path: "code/secret.js", text: "export const key = process.env.KEY;\n" },
    });
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    await archiveAndMerge(m);
    expect(workingFiles(m).get("code/secret.js")).toBe("export const key = process.env.KEY;\n");
    const open = (await conflictsOf(m)).filter(({ state }) => state === "open");
    expect(open.map(({ file }) => file)).toEqual(["code/secret.js"]);
    expect(await linkRow(m)).toMatchObject({ state: "paused", pauseReason: "conflicts" });
    // Nothing of it reaches GitHub until people choose.
    expect(m.w.github.files(m.repo.id).has("code/secret.js")).toBe(false);
  });

  test("a file of people's own in Git LFS is its pointer on GitHub: never merged into the project as text", async () => {
    const m = await mergeWorld(w);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1234\n`;
    const theirs = pushOnGitHub(m, { files: { [CODE]: pointer } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "blocked" }]);
    expect((await linkRow(m)).blocked).toEqual([
      {
        path: CODE,
        reason: "unreadable",
        detail: "a pointer of Git LFS",
        baseSha: expect.any(String),
      },
    ]);
    expect(code(m)).toBe(LINES.join(""));
    expect(tipOf(m).sha).toBe(theirs);
  });

  test("history rewritten, people choose the editor's: on top of GitHub's commit, as replace did", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    await m.window.change({ type: "project.rename", params: { name: "编辑器的" } });
    pushOnGitHub(m, { files: { "code/a.js": "export const a = 1;\n" } });
    await archiveAndMerge(m);
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const other = pushOnGitHub(m, { files: { "README.md": "# 别人的\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.archiveNow({ userId: w.userId } as never, m.project, other);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    const [tip] = m.w.github.history(m.repo.id);
    expect(tip!.parents).toEqual([other]);
    expect(JSON.parse(projectFilesOf(m).get("animaquill.json")!).name).toBe("编辑器的");
    expect(m.w.github.files(m.repo.id).get("README.md")).toBe("# 别人的\n");
  });

  test("more than one merge takes is not read at all: paused, and what people can do is what they do for history rewritten", async () => {
    const m = await mergeWorld(w);
    m.limits = { files: 1, bytes: 1 << 20 };
    const theirs = pushOnGitHub(m, {
      files: { "code/a.js": "export const a = 1;\n", "code/b.js": "export const b = 1;\n" },
    });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "too-large" }]);
    expect(await mergesOf(m)).toEqual([]);
    expect((await linkRow(m)).diverged).toMatchObject({ sha: theirs });
    await m.service.archiveNow({ userId: w.userId } as never, m.project, theirs);
    expect(await linkRow(m)).toMatchObject({ state: "ready", headSha: theirs, mergedSha: null });
  });

  test("a merge the hub refuses stays refused: the archive says why, and a newer push is read again from what was merged before", async () => {
    const m = await mergeWorld(w, { hubLimits: { mergeFiles: 1 } });
    const earlier = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 1, "export const v1 = 11;\n") },
    });
    await archiveAndMerge(m);
    expect(await linkRow(m)).toMatchObject({ headSha: earlier, mergedSha: null });
    const refused = pushOnGitHub(m, {
      files: { "code/a.js": "export const a = 1;\n", "code/b.js": "export const b = 1;\n" },
    });
    const outcomes = await archiveAndMerge(m);
    expect(outcomes.map(({ kind }) => kind)).toEqual(["merging", "paused"]);
    expect(outcomes[1]).toEqual({ kind: "paused", reason: "too-large" });
    expect(m.archivesQueued.filter((id) => id === m.project).length).toBeGreaterThan(0);
    const rows = await mergesOf(m);
    expect(rows.find(({ toSha }) => toSha === refused)).toMatchObject({
      state: "refused",
      fromSha: earlier,
      input: null,
    });
    // Asked again, it stays so: nothing is made of the same push again.
    expect(await archiveAndMerge(m, "check")).toEqual([{ kind: "paused", reason: "too-large" }]);
    expect(await mergesOf(m)).toHaveLength(rows.length);
    // A newer push that takes one of them back: read again from what was merged, both pushes.
    const newer = pushOnGitHub(m, { files: { "code/b.js": null } });
    const again = await archiveAndMerge(m, "check");
    expect(again[0]).toMatchObject({ kind: "merging" });
    const last = (await mergesOf(m)).find(({ toSha }) => toSha === newer)!;
    expect(last).toMatchObject({ fromSha: earlier, state: "applied" });
    expect(workingFiles(m).get("code/a.js")).toBe("export const a = 1;\n");
    expect(await linkRow(m)).toMatchObject({ headSha: newer, state: "ready" });
  });

  test("the branch moved back right before the merge commit was to go on it: nothing is written, and it is looked at again", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    await m.window.change({ type: "project.rename", params: { name: "编辑器改的" } });
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 2, "export const v2 = 22;\n") },
    });
    // Merged, then someone sets the branch back while the archive writes its commit.
    expect(await m.archiver().run(m.project, "check")).toMatchObject({ kind: "merging" });
    for (const merge of m.queued.splice(0)) await m.hub.mergeRepo(merge);
    m.host = backOnWrite(w.host, () => m.w.github.forcePush(m.repo.id, m.w.person, start));
    const outcomes = await archiveAndMerge(m);
    expect(outcomes).toEqual([{ kind: "paused", reason: "rewritten" }]);
    expect(tipOf(m).sha).toBe(start);
    expect((await linkRow(m)).mergedSha).toBe(theirs);
  });

  test("AGENTS.md as merges have it: people's own is neither merged nor written over while the project has the opening, nor written over once it has its own; replace writes it", async () => {
    const repo = w.github.addRepo(w.person, {
      name: `own-${Date.now()}`,
      select: true,
      files: { [INSTRUCTIONS_FILE]: "# 我的\n" },
    });
    const m = await mergeWorld(w, { repo });
    expect(workingFiles(m).get(INSTRUCTIONS_FILE) ?? INSTRUCTIONS_START).toBe(INSTRUCTIONS_START);
    // 1. Changed on GitHub while the project has the opening: not merged, and no pause.
    pushOnGitHub(m, { files: { [INSTRUCTIONS_FILE]: "# 我的，改过\n" } });
    expect(await archiveAndMerge(m, "check")).toEqual([{ kind: "checked" }]);
    expect(await mergesOf(m)).toEqual([]);
    await m.window.change({ type: "project.rename", params: { name: "改名" } });
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    expect(m.w.github.files(m.repo.id).get(INSTRUCTIONS_FILE)).toBe("# 我的，改过\n");
    // 2. The project has its own now: GitHub's, which no archive wrote, stops it.
    await m.window.change({
      type: "file.write",
      params: { path: INSTRUCTIONS_FILE, text: `${INSTRUCTIONS_START}\n项目自己的\n` },
    });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "diverged" }]);
    const link = await linkRow(m);
    expect(link.diverged).toMatchObject({ files: [INSTRUCTIONS_FILE], merging: true });
    expect(m.w.github.files(m.repo.id).get(INSTRUCTIONS_FILE)).toBe("# 我的，改过\n");
    // It stays paused once merges were on: only what paused before them is looked at again.
    expect(await takeDue(t.db, new Date(), { merging: true })).not.toContain(m.project);
    // 3. replace: the project's is written over it.
    await m.service.archiveNow({ userId: w.userId } as never, m.project, link.diverged!.sha);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    expect(m.w.github.files(m.repo.id).get(INSTRUCTIONS_FILE)).toContain("项目自己的");
    // 4. Changed on GitHub after that: merged into the project's, and written as it became.
    const text = m.w.github.files(m.repo.id).get(INSTRUCTIONS_FILE)!;
    pushOnGitHub(m, { files: { [INSTRUCTIONS_FILE]: `${text}GitHub 加的\n` } });
    await m.window.change({ type: "project.rename", params: { name: "又改名" } });
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["merging", "archived"]);
    expect(m.w.github.files(m.repo.id).get(INSTRUCTIONS_FILE)).toContain("GitHub 加的");
    expect(workingFiles(m).get(INSTRUCTIONS_FILE)).toContain("GitHub 加的");
  });

  test("links paused for changes on GitHub before merges were on are looked at again once they are", async () => {
    const m = await mergeWorld(w, { merging: false });
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 6, "export const v6 = 66;\n") } });
    expect(await archiveAndMerge(m, "check")).toEqual([{ kind: "paused", reason: "diverged" }]);
    expect(await takeDue(t.db, new Date())).not.toContain(m.project);
    expect(await takeDue(t.db, new Date(), { merging: true })).toContain(m.project);
    expect(await linkRow(m)).toMatchObject({ state: "ready", diverged: null });
    m.merging = true;
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["merging", "unchanged"]);
    expect(code(m)).toContain("v6 = 66");
  });

  test("replace is the editor's everywhere: what merges left waiting goes, conflicts become the editor's", async () => {
    const m = await mergeWorld(w);
    await m.window.change({
      type: "file.write",
      params: { path: CODE, text: withLine(LINES.join(""), 7, "export const v7 = 0;\n") },
    });
    const theirs = pushOnGitHub(m, {
      files: { [CODE]: withLine(LINES.join(""), 7, "export const v7 = 77;\n") },
    });
    await archiveAndMerge(m);
    expect(await linkRow(m)).toMatchObject({ pauseReason: "conflicts", mergedSha: theirs });
    await expect(
      m.service.archiveNow({ userId: w.userId } as never, m.project, "f".repeat(40)),
    ).rejects.toMatchObject({ code: "diverged" });
    await m.service.archiveNow({ userId: w.userId } as never, m.project, theirs);
    expect(await linkRow(m)).toMatchObject({
      state: "ready",
      mergedSha: null,
      blocked: [],
      replacedSha: theirs,
    });
    expect((await conflictsOf(m)).map(({ state }) => state)).toEqual(["ours"]);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
    expect(projectFilesOf(m).get(CODE)).toContain("v7 = 0;");
    expect(tipOf(m).parents).toEqual([theirs]);
  });

  test("merges that never went in go after a month; those that went in stay, as what taking them out needs; conflicts stay either way", async () => {
    const m = await mergeWorld(w);
    await m.window.change({
      type: "file.write",
      params: { path: CODE, text: withLine(LINES.join(""), 8, "export const v8 = 0;\n") },
    });
    // One push looked at and not merged yet, then a newer one in its place.
    pushOnGitHub(m, { files: { "code/a.js": "export const a = 1;\n" } });
    expect(await m.archiver().run(m.project, "check")).toMatchObject({ kind: "merging" });
    m.queued.splice(0);
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 8, "export const v8 = 88;\n") } });
    await archiveAndMerge(m);
    const [conflict] = await conflictsOf(m);
    await m.service.resolveConflicts({ userId: w.userId } as never, m.project, {
      ids: [conflict!.id],
      keep: "ours",
    });
    await archiveAndMerge(m);
    await t.db
      .update(repoMerges)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 3600_000) })
      .where(eq(repoMerges.projectId, m.project));
    const sweep = () =>
      sweepProjects({
        db: t.db,
        hub: {
          remove: async () => ({}) as never,
          forgetDeleted: async () => 0,
        },
        log: { info() {}, warn() {}, error() {} },
        recheck: undefined,
      });
    expect((await sweep()).mergesForgotten).toBe(1);
    expect((await mergesOf(m)).map(({ state }) => state)).toEqual(["applied"]);
    // A merge gone some other way (as before merges were kept): its conflict stays all the same.
    await t.db.delete(repoMerges).where(eq(repoMerges.projectId, m.project));
    const [kept] = await t.db
      .select()
      .from(repoConflicts)
      .where(eq(repoConflicts.id, conflict!.id));
    expect(kept).toMatchObject({ state: "ours", mergeId: null, batch: conflict!.batch });
    expect(kept!.theirsSha).toBe(conflict!.theirsSha);
  });

  test("merging GitHub's rewritten history where the platform cannot tell how something of it came in: paused, nothing written, until people choose", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    pushOnGitHub(m, { files: { "code/secret.js": "export const key = 'sk';\n" } });
    await m.window.change({ type: "project.rename", params: { name: "编辑器的" } });
    await archiveAndMerge(m);
    // The merge it came in by is not known any more.
    await t.db.delete(repoMerges).where(eq(repoMerges.projectId, m.project));
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "unmerged" }]);
    const link = await linkRow(m);
    expect(link.diverged).toMatchObject({ sha: clean, files: ["code/secret.js"], merging: true });
    expect(tipOf(m).sha).toBe(clean);
    expect(m.w.github.files(m.repo.id).has("code/secret.js")).toBe(false);
    // People chose: the editor's, as it is.
    await m.service.archiveNow({ userId: w.userId } as never, m.project, clean);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["archived"]);
  });

  /** Paused "unmerged" with a secret GitHub took away in its rewritten history, as above. */
  const unmergedWithSecret = async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    pushOnGitHub(m, {
      files: {
        "code/secret.js": "export const key = 'sk';\n",
        "code/kept.js": "export const k = 1;\n",
      },
    });
    await m.window.change({ type: "project.rename", params: { name: "编辑器的" } });
    await archiveAndMerge(m);
    await t.db.delete(repoMerges).where(eq(repoMerges.projectId, m.project));
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    await m.service.mergeNow({ userId: w.userId } as never, m.project, clean);
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "unmerged" }]);
    expect((await linkRow(m)).diverged?.files).toEqual(["code/kept.js", "code/secret.js"]);
    return { m, clean };
  };

  test("unmerged, people go on with the editor's and take out what GitHub took away: it never goes back to GitHub", async () => {
    const { m, clean } = await unmergedWithSecret();
    await m.service.archiveNow({ userId: w.userId } as never, m.project, clean, () => undefined, [
      "code/secret.js",
    ]);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toEqual(["merging", "archived"]);
    const files = m.w.github.files(m.repo.id);
    expect(files.has("code/secret.js")).toBe(false);
    // What people let go back is written as the editor has it.
    expect(files.get("code/kept.js")).toBe("export const k = 1;\n");
    expect(JSON.parse(files.get("animaquill.json")!).name).toBe("编辑器的");
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
    // People's own doing, not GitHub's: a batch of its own kind, which undoing (2E) refuses.
    const batches = await t.db
      .select({ kind: projectBatches.kind, label: projectBatches.label })
      .from(projectBatches)
      .where(eq(projectBatches.projectId, m.project));
    expect(batches.filter(({ kind }) => kind === "drop")).toEqual([
      { kind: "drop", label: "按你的选择从项目里去掉了 1 个文件" },
    ]);
    // One parent, GitHub's: nothing of the project from before goes along (no E).
    expect(tipOf(m).parents).toEqual([clean]);
    expect(await linkRow(m)).toMatchObject({
      state: "ready",
      dropping: null,
      droppingMerge: null,
      mergedSha: null,
    });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "same" }]);
  });

  /** Every commit on the branch, and each of their parents: a second parent (E) too. */
  const reachableHas = (m: MergeWorld, path: string) =>
    m.w.github
      .history(m.repo.id)
      .flatMap((commit) => [commit.sha, ...commit.parents])
      .some((sha) => m.w.github.filesAt(m.repo.id, sha).has(path));

  test("a merge that takes out what people chose is refused: nothing is written, archiving waits, the files stay listed", async () => {
    const { m, clean } = await unmergedWithSecret();
    await m.service.archiveNow({ userId: w.userId } as never, m.project, clean, () => undefined, [
      "code/secret.js",
    ]);
    m.queued.splice(0);
    expect(await m.archiver().run(m.project, "manual")).toMatchObject({ kind: "merging" });
    // The hub refuses it, as for too large, the quota, a copy that went twice.
    await t.db
      .update(repoMerges)
      .set({ state: "refused", input: null, result: { refused: "too-large", detail: "x" } })
      .where(and(eq(repoMerges.projectId, m.project), eq(repoMerges.state, "ready")));
    expect(await m.archiver().run(m.project, "manual")).toEqual({
      kind: "paused",
      reason: "unmerged",
    });
    expect(m.w.github.files(m.repo.id).has("code/secret.js")).toBe(false);
    expect(tipOf(m).sha).toBe(clean);
    const link = await linkRow(m);
    expect(link.dropping).toEqual(["code/secret.js"]);
    expect(link.diverged).toMatchObject({ files: ["code/secret.js"], deleted: ["code/secret.js"] });
    // Again, as a push or "现在存档" would: still nothing.
    await expect(archiveAndMerge(m)).resolves.toBeDefined();
    expect(reachableHas(m, "code/secret.js")).toBe(false);
  });

  test("merges turned off before what people chose to take out is out: nothing is written until it is", async () => {
    const { m, clean } = await unmergedWithSecret();
    await m.service.archiveNow({ userId: w.userId } as never, m.project, clean, () => undefined, [
      "code/secret.js",
    ]);
    m.merging = false;
    m.queued.splice(0);
    expect(await m.archiver().run(m.project, "manual")).toEqual({
      kind: "paused",
      reason: "unmerged",
    });
    expect(reachableHas(m, "code/secret.js")).toBe(false);
    expect(await linkRow(m)).toMatchObject({ dropping: ["code/secret.js"] });
    // On again: out first, then written.
    m.merging = true;
    await archiveAndMerge(m);
    expect(workingFiles(m).has("code/secret.js")).toBe(false);
    expect(reachableHas(m, "code/secret.js")).toBe(false);
    expect(JSON.parse(m.w.github.files(m.repo.id).get("animaquill.json")!).name).toBe("编辑器的");
  });

  test("after going on with the editor's content, a merge before the next archive keeps no old project in the history: what was taken away stays away", async () => {
    const m = await mergeWorld(w);
    const start = tipOf(m).sha;
    // The secret is the editor's, and an archive with a merge (E) takes it to GitHub.
    await m.window.change({
      type: "file.write",
      params: { path: "code/secret.js", text: "export const key = 'sk';\n" },
    });
    pushOnGitHub(m, { files: { "code/g1.js": "export const g1 = 1;\n" } });
    await archiveAndMerge(m);
    expect(m.w.github.files(m.repo.id).has("code/secret.js")).toBe(true);
    // Forced away on GitHub.
    m.w.github.forcePush(m.repo.id, m.w.person, start);
    const clean = pushOnGitHub(m, { files: { "code/clean.js": "export const c = 1;\n" } });
    expect(await archiveAndMerge(m)).toEqual([{ kind: "paused", reason: "rewritten" }]);
    const link = await linkRow(m);
    expect(link.diverged?.deleted).toContain("code/secret.js");
    // What GitHub changed and still has is not for taking out.
    await expect(
      m.service.archiveNow({ userId: w.userId } as never, m.project, clean, () => undefined, [
        "code/clean.js",
      ]),
    ).rejects.toMatchObject({ code: "invalid" });
    await m.service.archiveNow({ userId: w.userId } as never, m.project, clean, () => undefined, [
      "code/secret.js",
    ]);
    // Someone pushes again before the archive goes on, and the editor changes something.
    pushOnGitHub(m, { files: { "code/g2.js": "export const g2 = 2;\n" } });
    await m.window.change({ type: "project.rename", params: { name: "改了又改" } });
    await archiveAndMerge(m);
    const files = m.w.github.files(m.repo.id);
    expect(files.get("code/g2.js")).toBe("export const g2 = 2;\n");
    expect(JSON.parse(files.get("animaquill.json")!).name).toBe("改了又改");
    expect(reachableHas(m, "code/secret.js")).toBe(false);
  });

  test("drop takes only the files GitHub changed that people were shown: anything else is refused, and nothing changes", async () => {
    const { m, clean } = await unmergedWithSecret();
    for (const drop of [["animaquill.json"], ["code/secret.js", CODE]])
      await expect(
        m.service.archiveNow(
          { userId: w.userId } as never,
          m.project,
          clean,
          () => undefined,
          drop,
        ),
      ).rejects.toMatchObject({ code: "invalid" });
    expect(await linkRow(m)).toMatchObject({
      state: "paused",
      pauseReason: "unmerged",
      dropping: null,
    });
    expect(workingFiles(m).has(CODE)).toBe(true);
  });

  test("which side merges keep first is people's to change, and the status says it", async () => {
    const m = await mergeWorld(w);
    const user = { userId: w.userId } as never;
    expect((await m.service.status(user, m.project)).prefer).toBe("editor");
    expect((await m.service.setPrefer(user, m.project, "github")).prefer).toBe("github");
    expect(await linkRow(m)).toMatchObject({ prefer: "github" });
    // Somebody else's request does not get here: the route asks the policy of access first, see
    // access-coverage.test.ts.
  });

  test("conflicts and the status, and settling them over what the project has now", async () => {
    const m = await mergeWorld(w);
    await m.window.change({
      type: "file.write",
      params: { path: CODE, text: withLine(LINES.join(""), 9, "export const v9 = 0;\n") },
    });
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 9, "export const v9 = 99;\n") } });
    await archiveAndMerge(m);
    const listed = await m.service.conflicts({ userId: w.userId } as never, m.project);
    expect(listed.conflicts).toHaveLength(1);
    expect(listed.conflicts[0]).toMatchObject({ state: "open", kind: "lines", file: CODE });
    expect(listed.conflicts[0]!.theirsUrl).toContain("/commit/");
    // Somebody else, who has an account but not this project: the routes ask the policy of access
    // before the service is asked, see access-coverage.test.ts.
    await expect(
      m.service.resolveConflicts({ userId: w.userId } as never, m.project, {
        ids: [listed.conflicts[0]!.id],
        keep: "theirs",
        seq: 10_000,
      }),
    ).rejects.toMatchObject({ code: "behind" });
  });

  test("merges on, the platform's archive never goes before what waits for the API", async () => {
    const m = await mergeWorld(w);
    pushOnGitHub(m, { files: { [CODE]: withLine(LINES.join(""), 0, "export const v0 = 100;\n") } });
    await m.window.change({ type: "project.rename", params: { name: "也改了" } });
    const first = await m.archiver().run(m.project, "auto");
    expect(first).toMatchObject({ kind: "merging" });
    m.queued.splice(0);
    // Not merged yet: the next archive queues it again, and writes nothing.
    const tip = tipOf(m).sha;
    expect(await m.archiver().run(m.project, "auto")).toMatchObject({ kind: "merging" });
    expect(m.queued).toHaveLength(1);
    expect(tipOf(m).sha).toBe(tip);
    const rows = await mergesOf(m);
    expect(rows.filter(({ state }) => state === "ready")).toHaveLength(1);
  });
});

/**
 * A host whose sessions run `meanwhile` once, right after the commit of an archive is written and
 * before anything else: as someone pushing just then.
 */
const backOnWrite = (host: RepoHost, meanwhile: () => void): RepoHost => ({
  open(place, options): RepoSession {
    const session = host.open(place, options);
    let done = false;
    return new Proxy(session, {
      get(target, key, receiver) {
        if (key === "writeCommit")
          return async (commit: Parameters<RepoSession["writeCommit"]>[0]) => {
            const sha = await target.writeCommit(commit);
            // The merge commit has GitHub's as its first parent and the archive before as its other.
            if (!done && commit.parents.length === 2) {
              done = true;
              meanwhile();
            }
            return sha;
          };
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  },
});
