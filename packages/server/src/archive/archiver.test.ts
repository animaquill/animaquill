import { randomBytes } from "node:crypto";
import { INSTRUCTIONS_START } from "@animaquill/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  confirmed,
  crashingHost,
  edit,
  keep,
  linkTo,
  newProject,
  projectMap,
  quiet,
  world,
  write,
  type Level,
  type World,
} from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import type { FakeRepo } from "../test/fake-github.ts";
import { archives, projectRepos, projects, projectUpdates } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { Archiver, CONFIRM_AFTER_MS } from "./archiver.ts";
import { ProjectExporter } from "./exporter.ts";
import { ATTRIBUTES_END, ATTRIBUTES_START, trailersOf } from "./plan.ts";
import { RepoHosts, blobShaOf, bytesOf } from "./repo-host.ts";
import { takeDue } from "./schedule.ts";

/**
 * Archiving a project into its repository, on a real PostgreSQL and the fake GitHub: what an
 * archive writes, what it never touches, and every way it can stop halfway or find the repository
 * changed. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const SCENE = { name: "开场", entry: "index.html", runtime: 1 };
const addScene = (
  id: string,
  files: Record<string, string> = { "index.html": `<p>${id}</p>\n` },
) => ({
  type: "scene.add",
  params: { id, manifest: SCENE, files },
});

describe.skipIf(!TEST_DATABASE)("archiving a project, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
  });

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const archivesOf = async (id: string) =>
    t.db.select().from(archives).where(eq(archives.projectId, id)).orderBy(archives.createdAt);
  const dirtyOf = async (id: string) =>
    (
      await t.db.select({ dirty: projects.dirtySince }).from(projects).where(eq(projects.id, id))
    )[0]!.dirty;

  /** A project with a scene, linked to a new empty repository. */
  const linked = async (options: { repo?: FakeRepo } = {}) => {
    const project = await newProject(w);
    await edit(w, project, addScene("intro"));
    await edit(w, project, write("code/shared.js", "export const a = 1;\n"));
    const repo = options.repo ?? w.github.addRepo(w.person, { name: "film", select: true });
    await linkTo(w, project.id, repo);
    return { project, repo };
  };

  test("the first archive starts an empty repository, and has the documents and the code, by the person", async () => {
    const { project, repo } = await linked();
    const outcome = await w.archiver().run(project.id, "first");
    expect(outcome).toMatchObject({ kind: "archived", seq: 3 });
    const files = w.github.files(repo.id);
    expect([...files.keys()].toSorted()).toEqual([
      ".gitattributes",
      "animaquill.json",
      "code/shared.js",
      "scenes/intro/index.html",
      "scenes/intro/scene.json",
      "timelines/main/timeline.json",
    ]);
    expect(files.get(".gitattributes")).toContain(ATTRIBUTES_START);
    expect(files.get("code/shared.js")).toBe("export const a = 1;\n");
    // As the editor writes them into a folder.
    for (const [path, text] of project.editor.store.exportFiles().files)
      expect(files.get(path)).toBe(text);

    const [last, first] = w.github.history(repo.id);
    expect(first!.message).toBe("开始存档");
    expect(last!.parents).toEqual([first!.sha]);
    const author = {
      name: w.person.login,
      email: `${w.person.id}+${w.person.login}@users.noreply.github.com`,
    };
    for (const commit of [last!, first!]) {
      expect(commit.author).toMatchObject(author);
      expect(commit.committer).toMatchObject(author);
    }
    expect(trailersOf(last!.message)).toEqual({ project: project.id, seq: 3 });
    expect(last!.message.split("\n")[0]).toBe("存档");

    const link = await linkOf(project.id);
    expect(link).toMatchObject({
      headSha: last!.sha,
      pendingSha: null,
      archivedSeq: 3,
      failures: 0,
    });
    expect(await archivesOf(project.id)).toMatchObject([
      {
        seq: 3,
        sha: last!.sha,
        parentSha: first!.sha,
        kind: "first",
        changed: 5,
        removed: 0,
        kept: [],
      },
    ]);
    expect(await dirtyOf(project.id)).toBeNull();
  });

  test("writes only what changed, takes away what the project does not have any more, and nothing when nothing changed", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const before = w.github.history(repo.id).length;
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "same" });
    expect(w.github.history(repo.id)).toHaveLength(before);

    await edit(w, project, write("code/shared.js", "export const a = 2;\n"));
    await edit(w, project, { type: "scene.remove", params: { scene: "intro" } });
    const outcome = await w.archiver().run(project.id, "auto");
    expect(outcome).toMatchObject({ kind: "archived", seq: 5 });
    const files = w.github.files(repo.id);
    expect(files.get("code/shared.js")).toBe("export const a = 2;\n");
    expect(files.has("scenes/intro/scene.json")).toBe(false);
    expect(files.has("scenes/intro/index.html")).toBe(false);
    const [latest] = await archivesOf(project.id).then((rows) => rows.toReversed());
    expect(latest).toMatchObject({ kind: "auto", changed: 1, removed: 2 });
    expect(w.github.history(repo.id)[0]!.message.split("\n")[0]).toBe("自动存档");

    // A change that comes to the same files makes no commit: only the number moves on.
    await edit(w, project, write("code/shared.js", "x"));
    await edit(w, project, write("code/shared.js", "export const a = 2;\n"));
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "unchanged", seq: 7 });
    expect(w.github.history(repo.id)).toHaveLength(before + 1);
    expect(await linkOf(project.id)).toMatchObject({ archivedSeq: 7 });
    expect(await dirtyOf(project.id)).toBeNull();
  });

  test("never touches what is not the project's: a README, .github, media, pictures in a scene, a file too large, .animaquill", async () => {
    const big = "x".repeat(8 * 1024 * 1024 + 10);
    const theirs: Record<string, string> = {
      "README.md": "# 我的片子\n",
      "CONTRIBUTING.md": "规则\n",
      ".github/workflows/ci.yml": "on: push\n",
      "assets/video.mp4": "\u0000\u0001binary",
      "scenes/old/picture.png": "\u0089PNG\r\n\u001a\n",
      "code/huge.js": big,
      ".animaquill/cloud.json": "{}",
      ".gitattributes": "*.mp4 filter=lfs diff=lfs merge=lfs -text\n",
    };
    const repo = w.github.addRepo(w.person, { name: "mine", select: true });
    // Bytes that are not UTF-8, as a picture has.
    w.github.commitAs(repo.id, w.person, theirs, "My own files");
    const raw = w.github.repos.get(repo.id)!;
    const tip = raw.refs.get("main")!;
    const flat = raw.objects.flatten(raw.objects.readCommit(tip).tree);
    flat.set("scenes/old/picture.png", {
      mode: "100644",
      sha: raw.objects.blob(Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00])),
    });
    const pictureTree = raw.objects.treeOf(flat);
    const withPicture = raw.objects.commit({
      tree: pictureTree,
      parents: [tip],
      author: { name: "me", email: "me@example.com", time: 1 },
      committer: { name: "me", email: "me@example.com", time: 1 },
      message: "a picture",
    });
    raw.refs.set("main", withPicture);
    const shasBefore = raw.objects.flatten(raw.objects.readCommit(withPicture).tree);

    const { project } = await linked({ repo });
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    await edit(w, project, write("code/shared.js", "changed\n"));
    await edit(w, project, { type: "scene.remove", params: { scene: "intro" } });
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });

    const after = raw.objects.flatten(raw.objects.readCommit(raw.refs.get("main")!).tree);
    for (const path of Object.keys(theirs))
      expect(after.get(path), path).toEqual(shasBefore.get(path));
    expect(after.has("scenes/intro/index.html")).toBe(false);
    expect(w.github.files(repo.id).get(".gitattributes")).toBe(theirs[".gitattributes"]);
  });

  test("leaves an AGENTS.md of the repository alone while the project has only the opening", async () => {
    const repo = w.github.addRepo(w.person, { name: "with-rules", select: true });
    w.github.commitAs(repo.id, w.person, { "AGENTS.md": "我们的规则\n" }, "rules");
    const { project } = await linked({ repo });
    await edit(w, project, write("AGENTS.md", INSTRUCTIONS_START));
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get("AGENTS.md")).toBe("我们的规则\n");
    expect(w.github.files(repo.id).get("code/shared.js")).toBe("export const a = 1;\n");

    // What people then write into it in the project does not go over theirs.
    await edit(w, project, write("AGENTS.md", "项目里改过的\n"));
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect(w.github.files(repo.id).get("AGENTS.md")).toBe("我们的规则\n");
    expect((await linkOf(project.id)).diverged?.files).toEqual(["AGENTS.md"]);
  });

  test("writes the project's AGENTS.md over theirs once people chose the project", async () => {
    const repo = w.github.addRepo(w.person, { name: "with-rules", select: true });
    w.github.commitAs(repo.id, w.person, { "AGENTS.md": "我们的规则\n" }, "rules");
    const { project } = await linked({ repo });
    await edit(w, project, write("AGENTS.md", "项目里的规则\n"));
    expect(await w.archiver().run(project.id, "first")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    const paused = await linkOf(project.id);
    // As "以项目为准继续存档" does it, see ArchiveService.
    await t.db
      .update(projectRepos)
      .set({
        state: "ready",
        pauseReason: null,
        detail: null,
        pausedAt: null,
        pausedSeq: null,
        diverged: null,
        requestedAt: w.time.now,
        requestedBy: w.userId,
        headSha: paused.diverged?.sha ?? null,
        replacedSha: paused.diverged?.sha ?? null,
        archivedSeq: 0,
      })
      .where(eq(projectRepos.projectId, project.id));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.get("AGENTS.md")).toBe("项目里的规则\n");
    expect(files.get("code/shared.js")).toBe("export const a = 1;\n");
    expect((await linkOf(project.id)).replacedSha).toBeNull();
    // From then on it is the project's, written by its archives.
    await edit(w, project, write("AGENTS.md", "又改了\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get("AGENTS.md")).toBe("又改了\n");
  });

  test("never takes a commit it only noted for one people chose the project over", async () => {
    const repo = w.github.addRepo(w.person, { name: "with-rules", select: true });
    const theirs = w.github.commitAs(repo.id, w.person, { "AGENTS.md": "我们的规则\n" }, "rules");
    const { project } = await linked({ repo });
    await edit(w, project, write("AGENTS.md", "项目里的规则\n"));
    // As a link that the platform noted the tip of, before any archive of it landed.
    await t.db
      .update(projectRepos)
      .set({ headSha: theirs, archivedSeq: 0, requestedAt: w.time.now })
      .where(eq(projectRepos.projectId, project.id));
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect(w.github.files(repo.id).get("AGENTS.md")).toBe("我们的规则\n");
    expect((await linkOf(project.id)).diverged?.files).toEqual(["AGENTS.md"]);
  });

  test("writes AGENTS.md over one an archive of the project wrote", async () => {
    const { project, repo } = await linked();
    await edit(w, project, write("AGENTS.md", "第一版\n"));
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    await edit(w, project, write("code/shared.js", "other\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    await edit(w, project, write("AGENTS.md", "第二版\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get("AGENTS.md")).toBe("第二版\n");
  });

  test("a document the project cannot write keeps what the repository has, and says so; one that is new stays out", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const timelineBefore = w.github.files(repo.id).get("timelines/main/timeline.json");
    const broken = project.editor.raw((doc) => {
      const timelines = projectMap(doc).get("timelines") as Level;
      (timelines.get("main") as Level).set("name", 123);
    });
    await keep(t.db, project.id, broken, w.time.now);
    await edit(w, project, write("code/shared.js", "after\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.get("timelines/main/timeline.json")).toBe(timelineBefore);
    expect(files.get("code/shared.js")).toBe("after\n");
    const [latest] = (await archivesOf(project.id)).toReversed();
    expect(latest!.kept).toEqual(["timelines/main/timeline.json"]);
    expect(w.github.history(repo.id)[0]!.message).toContain("timelines/main/timeline.json");

    // A new scene whose scene.json is not right from the start: its code goes, its scene.json not.
    await edit(w, project, addScene("fresh"));
    const brokenScene = project.editor.raw((doc) => {
      const scenes = projectMap(doc).get("scenes") as Level;
      scenes.set("fresh", { ...SCENE, runtime: "soon" });
    });
    await keep(t.db, project.id, brokenScene, w.time.now);
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    const now = w.github.files(repo.id);
    expect(now.has("scenes/fresh/index.html")).toBe(true);
    expect(now.has("scenes/fresh/scene.json")).toBe(false);
    expect((await archivesOf(project.id)).at(-1)!.kept).toEqual([
      "scenes/fresh/scene.json",
      "timelines/main/timeline.json",
    ]);
  });

  test("an animaquill.json the format does not take archives nothing, and pauses until the project changes", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const commits = w.github.history(repo.id).length;
    const broken = project.editor.raw((doc) =>
      (projectMap(doc).get("manifest") as Level).set("name", 123),
    );
    await keep(t.db, project.id, broken, w.time.now);
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "manifest",
    });
    expect(w.github.history(repo.id)).toHaveLength(commits);
    expect(await linkOf(project.id)).toMatchObject({ state: "paused", pauseReason: "manifest" });
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "none" });
  });

  test("files that would not read as a project are never committed: the last check pauses", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const commits = w.github.history(repo.id).length;
    // The manifest names a timeline that is not there, which two windows at once can leave.
    const ghost = project.editor.raw((doc) =>
      (projectMap(doc).get("manifest") as Level).set("timelines", ["main", "ghost"]),
    );
    await keep(t.db, project.id, ghost, w.time.now);
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "invalid",
    });
    expect(w.github.history(repo.id)).toHaveLength(commits);
    expect((await linkOf(project.id)).detail).toContain("ghost");
  });

  test("goes on on top of a push elsewhere that left the project's files as they were", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const theirs = w.github.commitAs(repo.id, w.person, { "README.md": "# 片子\n" }, "README");
    await edit(w, project, write("code/shared.js", "mine\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    const [latest] = w.github.history(repo.id);
    expect(latest!.parents).toEqual([theirs]);
    expect(w.github.files(repo.id).get("README.md")).toBe("# 片子\n");
    expect(w.github.files(repo.id).get("code/shared.js")).toBe("mine\n");
  });

  test("pauses, and writes nothing, where a push elsewhere changed the project's files", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const theirs = w.github.commitAs(
      repo.id,
      w.person,
      {
        "timelines/main/timeline.json": '{"changed":"on GitHub"}\n',
        "scenes/new/index.html": "<p>new</p>",
      },
      "edited on GitHub",
    );
    await edit(w, project, write("code/shared.js", "mine\n"));
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect(w.github.history(repo.id)[0]!.sha).toBe(theirs);
    expect(w.github.files(repo.id).get("timelines/main/timeline.json")).toBe(
      '{"changed":"on GitHub"}\n',
    );
    expect(await linkOf(project.id)).toMatchObject({
      state: "paused",
      pauseReason: "diverged",
      diverged: { sha: theirs, files: ["scenes/new/index.html", "timelines/main/timeline.json"] },
    });
  });

  test("says which of the files that changed on GitHub were taken away there", async () => {
    const { project, repo } = await linked();
    await edit(w, project, write("code/gone.js", "mine\n"));
    await w.archiver().run(project.id, "first");
    const theirs = w.github.commitAs(repo.id, w.person, {
      "code/gone.js": null,
      "code/theirs.js": "new on GitHub\n",
      "timelines/main/timeline.json": '{"changed":"on GitHub"}\n',
    });
    await edit(w, project, write("code/shared.js", "mine\n"));
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect((await linkOf(project.id)).diverged).toEqual({
      sha: theirs,
      files: ["code/gone.js", "code/theirs.js", "timelines/main/timeline.json"],
      deleted: ["code/gone.js"],
    });
  });

  test("ours in .gitattributes is the platform's, the rest of it is people's", async () => {
    const { project, repo } = await linked();
    await w.archiver().run(project.id, "first");
    const attributes = w.github.files(repo.id).get(".gitattributes")!;
    w.github.commitAs(repo.id, w.person, { ".gitattributes": `*.psd binary\n${attributes}` });
    await edit(w, project, write("code/shared.js", "one\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    w.github.commitAs(repo.id, w.person, {
      ".gitattributes": attributes.replace(ATTRIBUTES_END, `*.mov filter=lfs\n${ATTRIBUTES_END}`),
    });
    await edit(w, project, write("code/shared.js", "two\n"));
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect((await linkOf(project.id)).diverged?.files).toEqual([".gitattributes"]);
  });

  test("takes an existing repository with files of its own, and keeps them", async () => {
    const repo = w.github.addRepo(w.person, {
      name: "notes",
      select: true,
      files: { "README.md": "# notes\n", "docs/a.md": "a" },
    });
    const { project } = await linked({ repo });
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.get("README.md")).toBe("# notes\n");
    expect(files.get("docs/a.md")).toBe("a");
    expect(files.has("animaquill.json")).toBe(true);
    // No .gitattributes of ours where nothing needs one: only a new repository starts with it.
    expect(files.has(".gitattributes")).toBe(false);
  });

  test("reads the last snapshot and the updates after it, and archives nothing where one is missing", async () => {
    const { project, repo } = await linked();
    await edit(w, project, write("code/b.js", "b\n"));
    // An update the database lost.
    await t.db
      .delete(projectUpdates)
      .where(and(eq(projectUpdates.projectId, project.id), eq(projectUpdates.seq, 3)));
    const outcome = await w.archiver().run(project.id, "first");
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(w.github.history(repo.id)).toHaveLength(0);
    expect(await linkOf(project.id)).toMatchObject({ failures: 1, state: "ready" });
  });
});

describe.skipIf(!TEST_DATABASE)("when an archive fails or stops halfway, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
  });

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const archivesOf = async (id: string) =>
    t.db.select().from(archives).where(eq(archives.projectId, id)).orderBy(archives.createdAt);

  const archived = async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const repo = w.github.addRepo(w.person, { name: "film", select: true });
    await linkTo(w, project.id, repo);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    await edit(w, project, write("code/a.js", "a2\n"));
    return { project, repo };
  };

  test("a token GitHub does not take any more is signed again, once", async () => {
    const { project, repo } = await archived();
    w.github.expireInstallationTokens();
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a2\n");
  });

  // Each its own test: each archives a project first, which is a while on a busy machine.
  test.each([
    ["suspend", "suspended"],
    ["uninstall", "uninstalled"],
    ["unselect", "gone"],
    ["delete", "gone"],
  ] as const)(
    "no token to be had pauses: uninstalled, suspended, the repository taken out or deleted (%s)",
    async (trouble, reason) => {
      const { project, repo } = await archived();
      if (trouble === "suspend") w.github.suspend(w.person);
      if (trouble === "uninstall") w.github.uninstall(w.person);
      if (trouble === "unselect") w.github.unselect(repo.id);
      if (trouble === "delete") w.github.deleteRepo(repo.id);
      // The first archive that finds so only notes it: the next one, minutes on, says so.
      expect(await w.archiver().run(project.id, "auto"), trouble).toMatchObject({ kind: "failed" });
      expect(await linkOf(project.id), trouble).toMatchObject({ state: "ready" });
      w.time.later(CONFIRM_AFTER_MS);
      expect(await w.archiver().run(project.id, "auto"), trouble).toEqual({
        kind: "paused",
        reason,
      });
      expect(await linkOf(project.id), trouble).toMatchObject({
        state: "paused",
        pauseReason: reason,
        failures: 0,
      });
    },
  );

  test("a branch that moved between reading and writing it is read again, never forced", async () => {
    const { project, repo } = await archived();
    let theirs: string | undefined;
    w.github.onCall = (call) => {
      if (call.startsWith("PATCH") && !theirs)
        theirs = w.github.commitAs(repo.id, w.person, { "README.md": "# meanwhile\n" });
    };
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    const [latest, second] = w.github.history(repo.id);
    expect(second!.sha).toBe(theirs);
    expect(latest!.parents).toEqual([theirs]);
    expect(w.github.files(repo.id).get("README.md")).toBe("# meanwhile\n");
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a2\n");
    expect((await linkOf(project.id)).pendingSha).toBeNull();
  });

  test("a branch that moved between reading and writing it with the project's files changed pauses", async () => {
    const { project, repo } = await archived();
    let theirs: string | undefined;
    w.github.onCall = (call) => {
      if (call.startsWith("PATCH") && !theirs)
        theirs = w.github.commitAs(repo.id, w.person, { "code/a.js": "theirs\n" });
    };
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "diverged",
    });
    expect(w.github.history(repo.id)[0]!.sha).toBe(theirs);
    expect(w.github.files(repo.id).get("code/a.js")).toBe("theirs\n");
    expect(await linkOf(project.id)).toMatchObject({
      pendingSha: null,
      diverged: { files: ["code/a.js"] },
    });
  });

  test("stopped after making the commit, before the branch moved: the next archive moves it to that commit", async () => {
    const { project, repo } = await archived();
    const before = w.github.history(repo.id).length;
    const crashing = w.archiver(crashingHost(w.host, { beforeAdvance: true }));
    expect(await crashing.run(project.id, "auto")).toMatchObject({ kind: "failed" });
    const noted = await linkOf(project.id);
    expect(noted.pendingSha).toMatch(/^[0-9a-f]{40}$/);
    expect(w.github.history(repo.id)).toHaveLength(before);
    expect(await w.archiver().run(project.id, "manual")).toMatchObject({ kind: "same" });
    const history = w.github.history(repo.id);
    expect(history).toHaveLength(before + 1);
    expect(history[0]!.sha).toBe(noted.pendingSha);
    expect(await linkOf(project.id)).toMatchObject({
      headSha: noted.pendingSha,
      pendingSha: null,
      archivedSeq: 3,
    });
    expect(await archivesOf(project.id)).toHaveLength(2);
  });

  test("stopped after the branch moved, before the database knew: noted, not archived again, not taken for a push elsewhere", async () => {
    const { project, repo } = await archived();
    const crashing = w.archiver(crashingHost(w.host, { afterAdvance: true }));
    expect(await crashing.run(project.id, "auto")).toMatchObject({ kind: "failed" });
    const noted = await linkOf(project.id);
    expect(w.github.history(repo.id)[0]!.sha).toBe(noted.pendingSha);
    const commits = w.github.history(repo.id).length;
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "same" });
    expect(w.github.history(repo.id)).toHaveLength(commits);
    expect(await linkOf(project.id)).toMatchObject({
      state: "ready",
      headSha: noted.pendingSha,
      pendingSha: null,
      archivedSeq: 3,
    });
    expect((await archivesOf(project.id)).map((row) => row.sha)).toContain(noted.pendingSha);
  });

  test("stopped after the branch moved, and then someone pushed: the commit is found below theirs", async () => {
    const { project, repo } = await archived();
    const crashing = w.archiver(crashingHost(w.host, { afterAdvance: true }));
    await crashing.run(project.id, "auto");
    const noted = await linkOf(project.id);
    const theirs = w.github.commitAs(repo.id, w.person, { "README.md": "# later\n" });
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "same" });
    expect(await linkOf(project.id)).toMatchObject({
      headSha: theirs,
      pendingSha: null,
      archivedSeq: 3,
    });
    expect((await archivesOf(project.id)).map((row) => row.sha)).toContain(noted.pendingSha);
  });

  test("stopped before the branch moved, and then someone pushed: the commit is let go, and the archive goes on top", async () => {
    const { project, repo } = await archived();
    await w.archiver(crashingHost(w.host, { beforeAdvance: true })).run(project.id, "auto");
    const theirs = w.github.commitAs(repo.id, w.person, { "README.md": "# later\n" });
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.history(repo.id)[0]!.parents).toEqual([theirs]);
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a2\n");
  });

  test("GitHub down, unreachable or limiting: tried again later, 1, 2, 4 minutes on, or as long as it asks", async () => {
    const { project, repo } = await archived();
    w.github.faults.down = 1;
    const first = await w.archiver().run(project.id, "auto");
    expect(first).toMatchObject({ kind: "failed" });
    let link = await linkOf(project.id);
    expect(link.failures).toBe(1);
    expect(link.nextAttemptAt!.getTime() - w.time.now.getTime()).toBe(60_000);
    w.github.faults.unreachable = true;
    await w.archiver().run(project.id, "auto");
    w.github.faults.unreachable = false;
    link = await linkOf(project.id);
    expect(link.failures).toBe(2);
    expect(link.nextAttemptAt!.getTime() - w.time.now.getTime()).toBe(2 * 60_000);
    w.github.faults.limited = 1;
    await w.archiver().run(project.id, "auto");
    link = await linkOf(project.id);
    expect(link.failures).toBe(3);
    expect(link.nextAttemptAt!.getTime() - w.time.now.getTime()).toBe(4 * 60_000);
    expect(link.state).toBe("ready");
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(await linkOf(project.id)).toMatchObject({
      failures: 0,
      nextAttemptAt: null,
      detail: null,
    });
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a2\n");
  });

  test("waits at most an hour, and as long as GitHub says when that is longer", async () => {
    const { project } = await archived();
    await t.db
      .update(projectRepos)
      .set({ failures: 9 })
      .where(eq(projectRepos.projectId, project.id));
    w.github.faults.down = 1;
    await w.archiver().run(project.id, "auto");
    expect((await linkOf(project.id)).nextAttemptAt!.getTime() - w.time.now.getTime()).toBe(
      3600_000,
    );
  });

  test("two archives of one project at the same time: one archives, the other leaves it", async () => {
    const { project, repo } = await archived();
    const before = w.github.history(repo.id).length;
    w.github.faults.delayMs = 20;
    const outcomes = await Promise.all([
      w.archiver().run(project.id, "auto"),
      w.archiver().run(project.id, "auto"),
    ]);
    w.github.faults.delayMs = 0;
    expect(outcomes.map((outcome) => outcome.kind).toSorted()).toEqual(["archived", "busy"]);
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "same" });
    expect(w.github.history(repo.id)).toHaveLength(before + 1);
  });

  test("the blobs it computes are the ones GitHub has", async () => {
    const { project, repo } = await archived();
    await w.archiver().run(project.id, "auto");
    const raw = w.github.repos.get(repo.id)!;
    const flat = raw.objects.flatten(raw.objects.readCommit(raw.refs.get("main")!).tree);
    expect(flat.get("code/a.js")!.sha).toBe(blobShaOf(bytesOf("a2\n")));
  });
});

describe.skipIf(!TEST_DATABASE)("what review found, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
  });

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const archivesOf = async (id: string) =>
    t.db.select().from(archives).where(eq(archives.projectId, id)).orderBy(archives.createdAt);
  const since = (mark: number) => w.github.calls.slice(mark);

  const archived = async (repo = w.github.addRepo(w.person, { name: "film", select: true })) => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    await linkTo(w, project.id, repo);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    await edit(w, project, write("code/a.js", "a2\n"));
    return { project, repo };
  };

  test("a branch GitHub does not let move pauses, says what GitHub said, and makes no more commits", async () => {
    const { project, repo } = await archived();
    const tip = w.github.history(repo.id)[0]!.sha;
    const message = "Protected branch update failed for refs/heads/main.";
    for (let time = 0; time < 20; time++)
      w.github.faults.once.push({
        match: /^PATCH \/repos\/.*\/git\/refs\/heads\//,
        status: 422,
        message,
      });
    const mark = w.github.calls.length;
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "protected",
    });
    const link = await linkOf(project.id);
    expect(link).toMatchObject({ state: "paused", pauseReason: "protected", failures: 0 });
    expect(link.detail).toContain(message);
    expect(since(mark).filter((call) => call.endsWith("/git/commits"))).toHaveLength(1);
    expect(w.github.history(repo.id)[0]!.sha).toBe(tip);
    // Paused: it does not try again by itself.
    w.time.later(61 * 60_000);
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "none" });
    expect(since(mark).filter((call) => call.endsWith("/git/commits"))).toHaveLength(1);
    w.github.faults.once.length = 0;
  });

  test("a code file that becomes a folder of the same name is archived", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/lib", "export const x = 1;\n"));
    const repo = w.github.addRepo(w.person, { name: "film", select: true });
    await linkTo(w, project.id, repo);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    await edit(w, project, {
      type: "file.rename",
      params: { from: "code/lib", to: "code/lib/index.js" },
    });
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get("code/lib/index.js")).toBe("export const x = 1;\n");
    expect(w.github.files(repo.id).has("code/lib")).toBe(false);
  });

  test("a pause for what the project had ends once it changes, also by a change made while the archive ran", async () => {
    const { project } = await archived();
    const broken = project.editor.raw((doc) =>
      (projectMap(doc).get("manifest") as Level).set("name", 123),
    );
    await keep(t.db, project.id, broken, w.time.now);
    let fixed = false;
    w.github.onCall = async (call) => {
      // Once the archive read the project: people fix it, a moment before the archive pauses.
      if (fixed || !/^GET \/repos\/.*\/git\/ref\/heads\//.test(call)) return;
      fixed = true;
      const fix = project.editor.raw((doc) =>
        (projectMap(doc).get("manifest") as Level).set("name", "改好了"),
      );
      await keep(t.db, project.id, fix, new Date(w.time.now.getTime() - 1));
    };
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "manifest",
    });
    w.github.onCall = undefined;
    w.time.later(6 * 60_000);
    expect(await takeDue(t.db, w.time.now)).toContain(project.id);
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", pauseReason: null });
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
  });

  test("an archive of a repository never pauses the link to another one people chose meanwhile", async () => {
    const { project, repo } = await archived();
    const other = w.github.addRepo(w.person, { name: "other", select: true });
    w.github.deleteRepo(repo.id);
    let swapped = false;
    w.github.onCall = async (call) => {
      if (swapped || !call.endsWith("/access_tokens")) return;
      swapped = true;
      await t.db
        .update(projectRepos)
        .set({ repoId: other.id, name: "other", headSha: null, archivedSeq: 0 })
        .where(eq(projectRepos.projectId, project.id));
    };
    // Found gone for the first time: noted, of the link it was found of, which is not there any more.
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    w.github.onCall = undefined;
    expect(await linkOf(project.id)).toMatchObject({
      repoId: other.id,
      state: "ready",
      pauseReason: null,
    });
  });

  test("looks at a picture people put into a scene's folder once, not at every archive", async () => {
    const repo = w.github.addRepo(w.person, { name: "pictures", select: true });
    w.github.commitAs(repo.id, w.person, { "README.md": "# pictures\n" });
    const raw = w.github.repos.get(repo.id)!;
    const tip = raw.refs.get("main")!;
    const flat = raw.objects.flatten(raw.objects.readCommit(tip).tree);
    const picture = raw.objects.blob(
      Buffer.concat([Buffer.from([0x89, 0xff, 0xfe, 0]), randomBytes(16)]),
    );
    flat.set("scenes/old/picture.png", { mode: "100644", sha: picture });
    const person = { name: "me", email: "me@example.com", time: 1 };
    raw.refs.set(
      "main",
      raw.objects.commit({
        tree: raw.objects.treeOf(flat),
        parents: [tip],
        author: person,
        committer: person,
        message: "a picture",
      }),
    );
    const { project } = await archived(repo);
    await w.archiver().run(project.id, "auto");
    await edit(w, project, write("code/a.js", "a3\n"));
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.calls.filter((call) => call.endsWith(`/git/blobs/${picture}`))).toHaveLength(1);
    expect(w.github.files(repo.id).has("scenes/old/picture.png")).toBe(true);
  });

  test("a check never writes: a commit that stopped before the branch moved waits for the next archive", async () => {
    const { project, repo } = await archived();
    await w.archiver(crashingHost(w.host, { beforeAdvance: true })).run(project.id, "auto");
    const noted = await linkOf(project.id);
    const tip = w.github.history(repo.id)[0]!.sha;
    expect(noted.pendingSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await w.archiver().run(project.id, "check")).toEqual({ kind: "checked" });
    expect(w.github.history(repo.id)[0]!.sha).toBe(tip);
    expect((await linkOf(project.id)).pendingSha).toBe(noted.pendingSha);
    expect(await w.archiver().run(project.id, "auto")).toEqual({ kind: "same" });
    expect(w.github.history(repo.id)[0]!.sha).toBe(noted.pendingSha);
  });

  test("a branch GitHub says is not there is a repository that is not there, not an empty one", async () => {
    const { project } = await archived();
    w.github.faults.once.push({ match: /^GET \/repos\/.*\/git\/ref\/heads\//, status: 404 });
    const mark = w.github.calls.length;
    // Once, as GitHub answers now and then: noted, nothing written, and the next archive goes on.
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    expect(
      since(mark).some((call) => call.startsWith("PUT") || call.startsWith("POST /repos")),
    ).toBe(false);
    expect(await linkOf(project.id)).toMatchObject({ state: "ready", unusableSince: null });
    w.time.later(CONFIRM_AFTER_MS);
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect((await linkOf(project.id)).unusableSeenAt).toBeNull();
    // Twice, minutes apart: a repository that is not there.
    await edit(w, project, write("code/a.js", "a3\n"));
    for (let time = 0; time < 2; time++)
      w.github.faults.once.push({ match: /^GET \/repos\/.*\/git\/ref\/heads\//, status: 404 });
    expect(await confirmed(w, project.id)).toEqual({ kind: "paused", reason: "gone" });
  });

  test("a tree GitHub does not list whole is not archived from the part it does", async () => {
    const { project, repo } = await archived();
    const before = w.github.history(repo.id).length;
    w.github.faults.truncate = true;
    w.github.faults.truncateLevels = true;
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
    w.github.faults.truncate = false;
    w.github.faults.truncateLevels = false;
    expect(w.github.history(repo.id)).toHaveLength(before);
  });

  test("a repository that is someone else's now pauses, and nothing goes into it", async () => {
    const { project, repo } = await archived();
    // Moved to another account, whose installation covers it, and which the record names now.
    const other = { id: w.person.id + 1, login: `${w.person.login}-studio` };
    const theirs = w.github.install(other, "all");
    w.github.repos.get(repo.id)!.owner = { id: other.id, login: other.login, type: "User" };
    await t.db
      .update(projectRepos)
      .set({ installationId: theirs })
      .where(eq(projectRepos.projectId, project.id));
    const before = w.github.history(repo.id).length;
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "transferred",
    });
    expect(w.github.history(repo.id)).toHaveLength(before);
    // Shown under the names it has now, and still known by the account it was linked on.
    expect(await linkOf(project.id)).toMatchObject({
      state: "paused",
      pauseReason: "transferred",
      ownerLogin: other.login,
      name: repo.name,
      ownerId: w.person.id,
      checkedAt: w.time.now,
    });
  });

  test("notes the repository as it is each time it looks, also where nothing is archived", async () => {
    const { project, repo } = await archived();
    const first = (await linkOf(project.id)).checkedAt;
    expect(first).toEqual(w.time.now);
    // Renamed and made public on GitHub, which nobody told the platform.
    w.github.rename(repo.id, "renamed");
    w.github.setPrivate(repo.id, false);
    w.time.later(3600_000);
    expect(await w.archiver().run(project.id, "check")).toEqual({ kind: "checked" });
    expect(await linkOf(project.id)).toMatchObject({
      name: "renamed",
      private: false,
      checkedAt: w.time.now,
      state: "ready",
    });
    // Archived on GitHub: named as it is now, and paused.
    w.github.rename(repo.id, "shelved");
    w.github.setArchived(repo.id, true);
    w.time.later(3600_000);
    expect(await w.archiver().run(project.id, "auto")).toEqual({
      kind: "paused",
      reason: "archived",
    });
    expect(await linkOf(project.id)).toMatchObject({ name: "shelved", checkedAt: w.time.now });
    // A repository that cannot be looked at keeps the time it last was.
    const looked = w.time.now;
    await t.db
      .update(projectRepos)
      .set({ state: "ready", pauseReason: null })
      .where(eq(projectRepos.projectId, project.id));
    w.github.deleteRepo(repo.id);
    w.time.later(3600_000);
    expect(await confirmed(w, project.id)).toEqual({ kind: "paused", reason: "gone" });
    expect((await linkOf(project.id)).checkedAt).toEqual(looked);
  });

  test("a .gitattributes whose lines of ours are not one pair stays as people have it, and is named", async () => {
    const { project, repo } = await archived();
    const attributes = w.github.files(repo.id).get(".gitattributes")!;
    // People took our last line away, and wrote under our first one.
    const broken = attributes
      .replace(`${ATTRIBUTES_END}\n`, "")
      .replace(ATTRIBUTES_START, `${ATTRIBUTES_START}\n*.ai binary`);
    w.github.commitAs(repo.id, w.person, { ".gitattributes": broken });
    expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).get(".gitattributes")).toBe(broken);
    expect(w.github.files(repo.id).get("code/a.js")).toBe("a2\n");
    expect((await archivesOf(project.id)).at(-1)!.kept).toEqual([".gitattributes"]);
  });

  test("an archive whose project is deleted while it runs, or before, ends without failing", async () => {
    const said: { level: string; message: string | undefined }[] = [];
    const log = {
      info: (_: object, message?: string) => void said.push({ level: "info", message }),
      warn: (_: object, message?: string) => void said.push({ level: "warn", message }),
      error: (_: object, message?: string) => void said.push({ level: "error", message }),
    };
    const archiver = new Archiver({
      db: t.db,
      hosts: RepoHosts.github(w.host),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log,
      now: () => w.time.now,
    });
    const hub = new SyncHub({ db: t.db, log: quiet });
    const deleted = async (id: string) =>
      expect(await hub.remove(id, w.userId, { discard: true })).toBe("removed");
    const linkedProject = async (name: string) => {
      const project = await newProject(w);
      await edit(w, project, write("code/a.js", "a\n"));
      const repo = w.github.addRepo(w.person, { name, select: true });
      await linkTo(w, project.id, repo);
      return { project, repo };
    };
    try {
      // As it starts: before it read the project.
      const early = await linkedProject("early");
      w.github.onCall = async (call) => {
        if (!call.endsWith("/access_tokens")) return;
        w.github.onCall = undefined;
        await deleted(early.project.id);
      };
      expect(await archiver.run(early.project.id, "first")).toEqual({ kind: "none" });
      // Halfway: the commit is made, and the branch is about to move to it.
      const late = await linkedProject("late");
      w.github.onCall = async (call) => {
        if (!/^PATCH .*\/git\/refs\//.test(call)) return;
        w.github.onCall = undefined;
        await deleted(late.project.id);
      };
      expect(await archiver.run(late.project.id, "first")).toEqual({ kind: "none" });
      // What reached the repository stays there.
      expect(w.github.files(late.repo.id).get("code/a.js")).toBe("a\n");
      // A job that waited in the queue while its project went.
      const queued = await linkedProject("queued");
      await deleted(queued.project.id);
      expect(await archiver.run(queued.project.id, "auto")).toEqual({ kind: "none" });
      // Nothing failed, nothing is tried again, and the link is gone with the project.
      expect(said.filter(({ level }) => level !== "info")).toEqual([]);
      expect(said).toContainEqual({
        level: "info",
        message: "the project was deleted while it was archived",
      });
      for (const { project } of [early, late, queued])
        expect(
          await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, project.id)),
        ).toEqual([]);
    } finally {
      w.github.onCall = undefined;
      hub.stop();
    }
  });

  test("a server not set up for GitHub archives nothing there, and notes nothing of it on the link", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const repo = w.github.addRepo(w.person, { name: "film", select: true });
    await linkTo(w, project.id, repo);
    const before = await linkOf(project.id);
    const unhosted = new Archiver({
      db: t.db,
      hosts: new RepoHosts({}),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
    });
    expect(await unhosted.run(project.id, "first")).toEqual({ kind: "none" });
    expect(w.github.history(repo.id)).toHaveLength(0);
    expect(await linkOf(project.id)).toEqual(before);
    expect(await archivesOf(project.id)).toEqual([]);
    // Nor does the scan of the worker queue it, while one that reaches GitHub would.
    w.time.later(60 * 60_000);
    expect(await takeDue(t.db, w.time.now, { providers: [] })).toEqual([]);
    expect(await takeDue(t.db, w.time.now, { providers: ["local"] })).toEqual([]);
    expect(await takeDue(t.db, w.time.now, { providers: ["github"] })).toContain(project.id);
    // The same project, once the server reaches GitHub.
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    expect(await archivesOf(project.id)).toMatchObject([{ provider: "github", repoId: repo.id }]);
  });
});
