import { randomBytes } from "node:crypto";
import { USER } from "@animaquill/core";
import { readLfsPointer } from "@animaquill/schema";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { crashingHost, edit, world, type Editor, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import type { FakeRepo } from "../test/fake-github.ts";
import { hashOf, lfsWorld, oidOf, type LfsWorld } from "../test/lfs-support.ts";
import { archives, lfsObjects, projectRepos } from "../schema.ts";
import { ATTRIBUTES_END, ATTRIBUTES_START, attributesSection } from "./plan.ts";

/**
 * The pointers of Git LFS in archives, on a real PostgreSQL and the fake GitHub, with files put
 * into its storage as the editor and the worker do: an asset in Git LFS of the repository has its
 * pointer at its path and a line in our section of .gitattributes; one in Git LFS of another
 * repository is not this one's; no pointer ever points at an object the storage is not known to
 * have; the platform's pointers go once their asset moved, went back to only here, or is gone; and
 * nobody's file is written over. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const lineOf = (path: string) => `${path} filter=lfs diff=lfs merge=lfs -text`;

describe.skipIf(!TEST_DATABASE)("pointers of Git LFS in archives, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let l: LfsWorld;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    l = await lfsWorld(w, { limits: { chunkBytes: 4096 } });
  });
  afterEach(() => {
    l.done();
  });

  type Project = { id: string; editor: Editor };

  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const assetsOf = (repo: FakeRepo) =>
    JSON.parse(w.github.files(repo.id).get("assets.json") ?? '{"assets":{}}').assets as Record<
      string,
      { storage: string; path: string; hash?: string; size?: number }
    >;
  const sectionOf = (repo: FakeRepo) =>
    attributesSection(w.github.files(repo.id).get(".gitattributes"));
  const archive = async (project: Project) => w.archiver().run(project.id, "auto");

  /**
   * The database comes back from a backup: the link is what it was when the backup was taken, while
   * the repository has everything that came since.
   */
  const restore = async (project: Project, backup: Awaited<ReturnType<typeof linkOf>>) =>
    t.db
      .update(projectRepos)
      .set({
        headSha: backup.headSha,
        archivedSeq: backup.archivedSeq,
        lfsPaths: backup.lfsPaths,
        pendingSha: null,
        pending: null,
      })
      .where(eq(projectRepos.projectId, project.id));
  const lastKept = async (project: Project) =>
    (
      await t.db
        .select({ kept: archives.kept })
        .from(archives)
        .where(eq(archives.projectId, project.id))
        .orderBy(desc(archives.seq))
        .limit(1)
    )[0]?.kept;

  /**
   * Every pointer of Git LFS in the repository points at an object its storage has, of that size:
   * the files at the paths the platform wrote, and any other file that reads as a pointer.
   */
  const noDanglingPointer = (repo: FakeRepo) => {
    for (const [path, text] of w.github.files(repo.id)) {
      const pointer = readLfsPointer(text);
      if (!pointer) continue;
      const stored = repo.lfs.get(pointer.oid);
      expect(stored, `${path} points at nothing`).toBeDefined();
      expect(stored?.length, path).toBe(pointer.size);
      expect(oidOf(stored!), path).toBe(pointer.oid);
    }
  };

  /** A project with an asset whose file went into Git LFS of its repository, and is placed there. */
  const withVideo = async (path = "assets/video.mp4") => {
    const { project, repo } = await l.linked();
    const video = randomBytes(5000);
    await l.addAsset(project, "video", path, video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    return { project, repo, video };
  };

  test("an asset in Git LFS of the repository: its pointer at its path, its line, and assets.json says so", async () => {
    const { project, repo, video } = await withVideo();
    const local = randomBytes(300);
    await l.addAsset(project, "local", "assets/local.mp4", local);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.get("assets/video.mp4")).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oidOf(video)}\nsize ${video.length}\n`,
    );
    expect(files.has("assets/local.mp4")).toBe(false);
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    const attributes = files.get(".gitattributes")!;
    expect(attributes.indexOf(ATTRIBUTES_START)).toBeLessThan(
      attributes.indexOf("/assets/video.mp4"),
    );
    expect(attributes.indexOf("/assets/video.mp4")).toBeLessThan(
      attributes.indexOf(ATTRIBUTES_END),
    );
    expect(assetsOf(repo)["video"]).toMatchObject({
      storage: "lfs",
      hash: hashOf(video),
      size: video.length,
    });
    expect(assetsOf(repo)["local"]?.storage).toBe("local");
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    noDanglingPointer(repo);
    // Nothing new: nothing written.
    expect(await archive(project)).toEqual({ kind: "same" });
  });

  test("never a pointer to an object the storage is not known to have: the asset is named instead", async () => {
    const { project, repo } = await l.linked();
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    // Written down without the file getting there, as an editor that has it wrong would.
    await l.placeIn(project, "video", repo, video);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.has("assets/video.mp4")).toBe(false);
    expect(sectionOf(repo)).toEqual([]);
    const [last] = await t.db.select().from(archives).where(eq(archives.projectId, project.id));
    expect(last?.kept).toEqual(["assets/video.mp4"]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
    noDanglingPointer(repo);

    // Once the storage has it, the pointer comes.
    await l.upload(project.id, video);
    await l.addAsset(project, "other", "assets/other.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toEqual({
      oid: oidOf(video),
      size: video.length,
    });
    noDanglingPointer(repo);
  });

  test("only for this repository: an asset in Git LFS of another repository is only here as far as this one goes", async () => {
    const { project, repo } = await l.linked();
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    // The same file is in this repository's storage, for another asset, as it happens.
    await l.upload(project.id, video);
    // But this asset's file went into the storage of another repository, as a copy of the
    // project that was saved somewhere else.
    await l.placeIn(project, "video", "999999", video);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
    expect(assetsOf(repo)["video"]?.storage).toBe("local");
    expect(sectionOf(repo)).toEqual([]);
    noDanglingPointer(repo);
  });

  test("moved, back to only here, in Git LFS again, and gone: the platform's pointers and lines follow", async () => {
    const { project, repo, video } = await withVideo();
    await w.archiver().run(project.id, "first");
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(true);

    // Moved, to a path that .gitattributes has to escape.
    const moved = "素材/片头 #1 [终版].mp4";
    await edit(w, project, {
      type: "asset.update",
      params: { asset: "video", changes: { path: moved } },
    });
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    let files = w.github.files(repo.id);
    expect(files.has("assets/video.mp4")).toBe(false);
    expect(readLfsPointer(files.get(moved) ?? "")).toEqual({
      oid: oidOf(video),
      size: video.length,
    });
    expect(sectionOf(repo)).toEqual([lineOf("/素材/片头[[:space:]]\\#1[[:space:]]\\[终版].mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([moved]);
    noDanglingPointer(repo);

    // Back to only here, as people say.
    await edit(
      w,
      project,
      {
        type: "asset.setStorage",
        params: { asset: "video", storage: "local", hash: hashOf(video) },
      },
      USER,
    );
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    files = w.github.files(repo.id);
    expect(files.has(moved)).toBe(false);
    expect(sectionOf(repo)).toEqual([]);
    expect(assetsOf(repo)["video"]?.storage).toBe("local");
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);

    // In Git LFS again: it is there already, so no upload.
    expect((await l.begin(project.id, video)).json.state).toBe("present");
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).has(moved)).toBe(true);

    // Gone.
    await edit(w, project, { type: "asset.remove", params: { asset: "video" } });
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    files = w.github.files(repo.id);
    expect(files.has(moved)).toBe(false);
    expect(sectionOf(repo)).toEqual([]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
    // What people wrote in .gitattributes around our section stays.
    expect(files.get(".gitattributes")).toContain("这个仓库由 AnimaQuill 存档");
  });

  test("another file of the asset that is not in the storage yet: the repository keeps the pointer before, and names it", async () => {
    const { project, repo, video } = await withVideo();
    await w.archiver().run(project.id, "first");
    // A new file of the asset, written down as in Git LFS before it got there.
    const next = randomBytes(6000);
    await edit(w, project, {
      type: "asset.update",
      params: { asset: "video", changes: { hash: hashOf(next), size: next.length } },
    });
    await l.placeIn(project, "video", repo, next);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toEqual({
      oid: oidOf(video),
      size: video.length,
    });
    const rows = await t.db.select().from(archives).where(eq(archives.projectId, project.id));
    expect(rows.at(-1)?.kept).toEqual(["assets/video.mp4"]);
    noDanglingPointer(repo);
  });

  test("takes nobody's place: a file of people's at the path stays, and so does what the format has there", async () => {
    const { project, repo } = await l.linked();
    w.github.commitAs(repo.id, w.person, {
      "assets/video.mp4": "my own video",
      "README.md": "# film\n",
    });
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    // An asset at the path of a document of the format: the document it is.
    const doc = randomBytes(100);
    await l.addAsset(project, "doc", "notes.json", doc);
    await l.upload(project.id, doc);
    await l.placeIn(project, "doc", repo, doc);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const files = w.github.files(repo.id);
    expect(files.get("assets/video.mp4")).toBe("my own video");
    expect(files.get("README.md")).toBe("# film\n");
    expect(readLfsPointer(files.get("notes.json") ?? "")).toBeUndefined();
    const [last] = await t.db.select().from(archives).where(eq(archives.projectId, project.id));
    expect(last?.kept).toEqual(expect.arrayContaining(["assets/video.mp4", "notes.json"]));
    expect(sectionOf(repo)).toEqual([]);
    noDanglingPointer(repo);
  });

  test("an archive that stopped once the branch had it: the next one knows its pointers are the platform's", async () => {
    const { project, repo } = await withVideo();
    const crashes = { afterAdvance: true };
    expect(await w.archiver(crashingHost(w.host, crashes)).run(project.id, "first")).toMatchObject({
      kind: "failed",
    });
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(true);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
    // Gone from the project: the pointer the commit that got there has goes too.
    await edit(w, project, { type: "asset.remove", params: { asset: "video" } });
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
    expect(sectionOf(repo)).toEqual([]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
  });

  test("a pointer of the platform's changed on GitHub pauses archiving, as a file of the project does", async () => {
    const { project, repo } = await withVideo();
    await w.archiver().run(project.id, "first");
    w.github.commitAs(repo.id, w.person, { "assets/video.mp4": null });
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "paused", reason: "diverged" });
    expect((await linkOf(project.id)).diverged).toMatchObject({
      files: ["assets/video.mp4"],
      deleted: ["assets/video.mp4"],
    });
    // Elsewhere in its folder, a file of people's comes and goes as it likes.
    const other = await withVideo();
    await w.archiver().run(other.project.id, "first");
    w.github.commitAs(other.repo.id, w.person, { "assets/theirs.png": "a picture" });
    await l.addAsset(other.project, "more", "assets/more.mp4", randomBytes(10));
    expect(await archive(other.project)).toMatchObject({ kind: "archived" });
    expect(w.github.files(other.repo.id).get("assets/theirs.png")).toBe("a picture");
  });

  test("merges on, people choosing the editor's over GitHub's rewritten history: the pointers they saw changed are the platform's to write again", async () => {
    const { project, repo } = await withVideo();
    const merging = { merging: async () => true };
    await w.archiver(undefined, merging).run(project.id, "first");
    const start = w.github.history(repo.id).at(-1)!.sha;
    // Someone sets the branch back, and puts a file of their own where the pointer was.
    w.github.forcePush(repo.id, w.person, start);
    const theirs = w.github.commitAs(repo.id, w.person, { "assets/video.mp4": "my own video" });
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    expect(await w.archiver(undefined, merging).run(project.id, "auto")).toMatchObject({
      kind: "paused",
      reason: "rewritten",
    });
    const paused = await linkOf(project.id);
    expect(paused.diverged).toMatchObject({ sha: theirs, merging: true });
    // “以编辑器的内容接着存”, as `replace` notes it.
    await t.db
      .update(projectRepos)
      .set({
        state: "ready",
        pauseReason: null,
        diverged: null,
        headSha: theirs,
        replacedSha: theirs,
        archivedSeq: 0,
      })
      .where(eq(projectRepos.projectId, project.id));
    expect(await w.archiver(undefined, merging).run(project.id, "auto")).toMatchObject({
      kind: "archived",
    });
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toBeDefined();
    expect((await linkOf(project.id)).lfsPaths).toContain("assets/video.mp4");
    noDanglingPointer(repo);
  });

  // What follows is from the review of step 14.2② (R1 to R4): the database back from a backup, and
  // a section of .gitattributes that people broke.

  test("the database back from a backup: a pointer the platform wrote since is still its own, by its line, and goes with its asset", async () => {
    const { project, repo } = await l.linked();
    await l.addAsset(project, "local", "assets/local.mp4", randomBytes(100));
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const backup = await linkOf(project.id);
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);

    await restore(project, backup);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    // The pointer is there, and so is its line: without it, Git takes the pointer for the file.
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toEqual({
      oid: oidOf(video),
      size: video.length,
    });
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    noDanglingPointer(repo);

    // And it is the platform's to take away once its asset is gone.
    await edit(w, project, { type: "asset.remove", params: { asset: "video" } });
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
    expect(sectionOf(repo)).toEqual([]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
  });

  test("the database back from a backup that knows nothing of the object either: GitHub is asked once, and what it has is noted again", async () => {
    const { project, repo } = await l.linked();
    await l.addAsset(project, "local", "assets/local.mp4", randomBytes(100));
    await w.archiver().run(project.id, "first");
    const backup = await linkOf(project.id);
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });

    await restore(project, backup);
    await t.db.delete(lfsObjects).where(eq(lfsObjects.oid, oidOf(video)));
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    const asked = () => w.github.calls.filter((call) => call.startsWith("POST lfs/batch")).length;
    const before = asked();
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(asked() - before).toBe(1);
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toBeDefined();
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    expect(await lastKept(project)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(video))),
    ).toMatchObject([{ repoId: repo.id, size: video.length }]);
    noDanglingPointer(repo);
    // Known again: nobody is asked the next time.
    await l.addAsset(project, "more2", "assets/more2.mp4", randomBytes(10));
    const again = asked();
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(asked()).toBe(again);
  });

  for (const again of ["local", "lfs"] as const) {
    test(`the database back from a backup: a file of people's where a pointer of the platform's was stays theirs (the asset is ${again} now)`, async () => {
      const { project, repo, video } = await withVideo();
      expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
      // The backup has the pointer as the platform's.
      const backup = await linkOf(project.id);
      expect(backup.lfsPaths).toEqual(["assets/video.mp4"]);
      // Back to only here: the platform takes its pointer away.
      await edit(
        w,
        project,
        {
          type: "asset.setStorage",
          params: { asset: "video", storage: "local", hash: hashOf(video) },
        },
        USER,
      );
      expect(await archive(project)).toMatchObject({ kind: "archived" });
      expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
      // People commit a file of their own there, and an archive goes on top of it.
      const theirs = "my own file, not a pointer";
      w.github.commitAs(repo.id, w.person, { "assets/video.mp4": theirs });
      await l.addAsset(project, "x1", "assets/x1.mp4", randomBytes(10));
      expect(await archive(project)).toMatchObject({ kind: "archived" });
      expect(w.github.files(repo.id).get("assets/video.mp4")).toBe(theirs);

      await restore(project, backup);
      if (again === "lfs") await l.placeIn(project, "video", repo, video);
      await l.addAsset(project, "x2", "assets/x2.mp4", randomBytes(10));
      expect(await archive(project)).toMatchObject({ kind: "archived" });
      // Neither taken away nor written over, and named; the path is not the platform's any more.
      expect(w.github.files(repo.id).get("assets/video.mp4")).toBe(theirs);
      expect(await lastKept(project)).toEqual(["assets/video.mp4"]);
      expect((await linkOf(project.id)).lfsPaths).toEqual([]);
      expect(sectionOf(repo)).toEqual([]);
      noDanglingPointer(repo);
    });
  }

  test("a section of .gitattributes that people broke: no new pointer without its line, the ones there stay, and both come once it is mended", async () => {
    const { project, repo, video } = await withVideo();
    await w.archiver().run(project.id, "first");
    const mended = w.github.files(repo.id).get(".gitattributes")!;
    // One of our two lines is gone: where the section ends cannot be told.
    const broken = `*.psd binary\n${ATTRIBUTES_START}\n`;
    w.github.commitAs(repo.id, w.person, { ".gitattributes": broken });
    const next = randomBytes(6000);
    await l.addAsset(project, "next", "assets/next.mp4", next);
    await l.upload(project.id, next);
    await l.placeIn(project, "next", repo, next);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    let files = w.github.files(repo.id);
    // A pointer without its line would be the file itself to Git: it is not written, and named.
    expect(files.has("assets/next.mp4")).toBe(false);
    expect(files.get(".gitattributes")).toBe(broken);
    expect(await lastKept(project)).toEqual([".gitattributes", "assets/next.mp4"]);
    // The pointer that was there stays, and stays the platform's.
    expect(readLfsPointer(files.get("assets/video.mp4") ?? "")).toEqual({
      oid: oidOf(video),
      size: video.length,
    });
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    // Nor is one taken away whose line cannot be: it waits.
    await edit(w, project, { type: "asset.remove", params: { asset: "video" } });
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(true);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    noDanglingPointer(repo);

    // Mended: the new pointer comes with its line, and the one of the asset that is gone goes.
    w.github.commitAs(repo.id, w.person, { ".gitattributes": mended });
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    files = w.github.files(repo.id);
    expect(readLfsPointer(files.get("assets/next.mp4") ?? "")).toEqual({
      oid: oidOf(next),
      size: next.length,
    });
    expect(files.has("assets/video.mp4")).toBe(false);
    expect(sectionOf(repo)).toEqual([lineOf("/assets/next.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/next.mp4"]);
    noDanglingPointer(repo);
  });

  test("Git LFS cannot be asked after the database came back: the documents are archived, the pointer stays as it is with its line, and is known again once it can", async () => {
    const { project, repo } = await l.linked();
    await l.addAsset(project, "local", "assets/local.mp4", randomBytes(100));
    await w.archiver().run(project.id, "first");
    const backup = await linkOf(project.id);
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    await restore(project, backup);
    const noted = () =>
      t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(video)));
    await t.db.delete(lfsObjects).where(eq(lfsObjects.oid, oidOf(video)));

    // Its batch API is down, the rest of GitHub is there.
    w.github.faults.lfsDown = 1;
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(Object.keys(assetsOf(repo)).toSorted()).toEqual(["local", "more", "video"]);
    // Neither the platform's to change nor people's for good: as it is, line and all.
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toBeDefined();
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    expect(await noted()).toEqual([]);

    // Asked again with the next archive, and noted.
    await l.addAsset(project, "more2", "assets/more2.mp4", randomBytes(10));
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(await noted()).toMatchObject([{ size: video.length }]);
    expect(await lastKept(project)).toEqual([]);
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    noDanglingPointer(repo);
  });

  test("GitHub is asked about an object as large as each asset says it is: two assets of one hash that say two sizes", async () => {
    const { project, repo } = await l.linked();
    const video = randomBytes(5000);
    // In the storage some other way, which minds the size: it has the object of 5000 bytes only.
    w.github.addLfsObject(repo.id, video);
    await l.addAsset(project, "right", "assets/right.mp4", video);
    await l.placeIn(project, "right", repo, video);
    // Another asset of that content says another size, and so the storage has none of it.
    await edit(w, project, {
      type: "asset.add",
      params: {
        id: "wrong",
        asset: { kind: "video", path: "assets/wrong.mp4", hash: hashOf(video), size: 4999 },
      },
    });
    await l.placeIn(project, "wrong", repo, video);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    // One answer about an oid in a call: each size is asked about in a call of its own, until
    // one is there. The asset whose size it is gets its pointer, the other is named.
    expect(readLfsPointer(w.github.files(repo.id).get("assets/right.mp4") ?? "")).toEqual({
      oid: oidOf(video),
      size: 5000,
    });
    expect(w.github.files(repo.id).has("assets/wrong.mp4")).toBe(false);
    expect(await lastKept(project)).toEqual(["assets/wrong.mp4"]);
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(video))),
    ).toMatchObject([{ size: 5000 }]);
    noDanglingPointer(repo);
  });

  test("a pointer of people's stays theirs although its line is in our section: the platform goes by what it noted, not by what GitHub has", async () => {
    const { project, repo } = await withVideo();
    await w.archiver().run(project.id, "first");
    // People keep a file of their own in Git LFS, put there with Git LFS, and write its line
    // between our two lines.
    const own = randomBytes(4000);
    w.github.addLfsObject(repo.id, own);
    const theirs = `version https://git-lfs.github.com/spec/v1\noid sha256:${oidOf(own)}\nsize ${own.length}\n`;
    const attributes = w.github.files(repo.id).get(".gitattributes")!;
    const tip = w.github.commitAs(repo.id, w.person, {
      "assets/mine.mp4": theirs,
      ".gitattributes": attributes.replace(
        ATTRIBUTES_END,
        `${lineOf("/assets/mine.mp4")}\n${ATTRIBUTES_END}`,
      ),
    });
    await l.addAsset(project, "more", "assets/more.mp4", randomBytes(10));
    // Our section is not as the platform left it: archiving pauses, until people say to go on
    // with what the editor has, as `RepositoryService.archive` with `replace` notes it.
    expect(await archive(project)).toMatchObject({ kind: "paused", reason: "diverged" });
    await t.db
      .update(projectRepos)
      .set({
        state: "ready",
        pauseReason: null,
        detail: null,
        pausedAt: null,
        pausedSeq: null,
        diverged: null,
        headSha: tip,
        archivedSeq: 0,
      })
      .where(eq(projectRepos.projectId, project.id));
    const asked = () => w.github.calls.filter((call) => call.startsWith("POST lfs/batch")).length;
    const before = asked();
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    // Their pointer is not taken for the platform's, and not taken away: GitHub has its object,
    // but the platform never noted it, and does not ask.
    expect(w.github.files(repo.id).get("assets/mine.mp4")).toBe(theirs);
    expect(asked()).toBe(before);
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(own))),
    ).toEqual([]);
    expect(await lastKept(project)).toEqual(["assets/mine.mp4"]);
    // Our section is ours again: the line of the platform's pointer, and no other.
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
  });

  for (const noHead of [false, true]) {
    test(`GitHub has an object of that oid, but not of the size the asset says: no pointer says a size the file does not have (${noHead ? "an address that takes GET alone" : "asked with HEAD"})`, async () => {
      const { project, repo } = await l.linked();
      const video = randomBytes(5000);
      // In the storage some other way, and the storage goes by the oid alone.
      w.github.addLfsObject(repo.id, video);
      w.github.faults.lfsAnySize = true;
      w.github.faults.lfsNoHead = noHead;
      // An asset that says another size of that content, written down as in Git LFS.
      await edit(w, project, {
        type: "asset.add",
        params: {
          id: "video",
          asset: { kind: "video", path: "assets/video.mp4", hash: hashOf(video), size: 4999 },
        },
      });
      await l.placeIn(project, "video", repo, video);
      expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
      expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
      expect(await lastKept(project)).toEqual(["assets/video.mp4"]);
      // Noted as large as the storage itself says it is, not as it was asked about.
      expect(
        await t.db
          .select()
          .from(lfsObjects)
          .where(eq(lfsObjects.oid, oidOf(video))),
      ).toMatchObject([{ repoId: repo.id, size: 5000 }]);
      expect(w.github.calls.includes("GET lfs/object")).toBe(noHead);

      // With the size the file has, the pointer comes.
      await edit(w, project, {
        type: "asset.update",
        params: { asset: "video", changes: { size: 5000 } },
      });
      await l.placeIn(project, "video", repo, video);
      expect(await archive(project)).toMatchObject({ kind: "archived" });
      expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toEqual({
        oid: oidOf(video),
        size: 5000,
      });
      noDanglingPointer(repo);
    });
  }

  test(".gitattributes that is a link is people's: it is not written over, and no pointer comes without its line", async () => {
    const { project, repo } = await l.linked();
    await l.addAsset(project, "local", "assets/local.mp4", randomBytes(100));
    await w.archiver().run(project.id, "first");
    w.github.commitAs(repo.id, w.person, {
      ".gitattributes": { link: "shared/attributes" },
      "shared/attributes": "*.psd binary\n",
    });
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    // Still the link, to where it led.
    expect(w.github.modes(repo.id).get(".gitattributes")).toBe("120000");
    expect(w.github.files(repo.id).get(".gitattributes")).toBe("shared/attributes");
    expect(w.github.files(repo.id).get("shared/attributes")).toBe("*.psd binary\n");
    expect(w.github.files(repo.id).has("assets/video.mp4")).toBe(false);
    expect(await lastKept(project)).toEqual([".gitattributes", "assets/video.mp4"]);
    expect((await linkOf(project.id)).lfsPaths).toEqual([]);
    expect(Object.keys(assetsOf(repo)).toSorted()).toEqual(["local", "video"]);
  });

  test("no pointer whose line would take a file of people's along: a name with a tab where the asset's has its space, in a folder of such a name too", async () => {
    const { project, repo } = await l.linked();
    w.github.commitAs(repo.id, w.person, {
      "素材/片头\t1.mp4": "people's own, in the folder of the asset",
      "镜头\t2/远景.mp4": "people's own, in a folder of a name alike",
    });
    const files = [randomBytes(5000), randomBytes(5001), randomBytes(5002)];
    const paths = ["素材/片头 1.mp4", "镜头 2/远景.mp4", "素材/片尾 1.mp4"];
    for (const [index, path] of paths.entries()) {
      await l.addAsset(project, `a${index}`, path, files[index]!);
      await l.upload(project.id, files[index]!);
      await l.placeIn(project, `a${index}`, repo, files[index]!);
    }
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    const there = w.github.files(repo.id);
    expect(there.has(paths[0]!)).toBe(false);
    expect(there.has(paths[1]!)).toBe(false);
    expect(await lastKept(project)).toEqual([paths[0], paths[1]].toSorted());
    // The one that takes nothing along is written, with its line.
    expect(readLfsPointer(there.get(paths[2]!) ?? "")).toBeDefined();
    expect(sectionOf(repo)).toEqual([lineOf("/素材/片尾[[:space:]]1.mp4")]);
    expect(there.get("素材/片头\t1.mp4")).toBe("people's own, in the folder of the asset");
  });

  test(
    "no pointer in any archive ever points at nothing, whatever happens in between",
    { timeout: 180_000 },
    async () => {
      const { project, repo } = await l.linked();
      // mulberry32: the same steps every time.
      let seed = 7;
      const random = (below: number) => {
        seed = (seed + 0x6d2b79f5) | 0;
        let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296) * below);
      };
      const files = Array.from({ length: 4 }, (_, index) => randomBytes(1000 + index));
      const assets = new Map<string, { data: Buffer; path: string }>();
      let made = 0;
      let archived = 0;
      /** Archives with a pointer in them, and with one named as not written. */
      let pointed = 0;
      let named = 0;
      const STEPS = [
        "add",
        "add",
        "upload and place",
        "upload and place",
        "upload and place",
        "upload",
        "place",
        "place elsewhere",
        "move",
        "move",
        "local",
        "remove",
      ] as const;
      for (let step = 0; step < 40; step++) {
        const id = [...assets.keys()][random(Math.max(1, assets.size))];
        // As the editor does it mostly (the file goes there, and then it is written down), and
        // the ways it can go otherwise.
        const what = STEPS[random(STEPS.length)] as (typeof STEPS)[number];
        const asset = id === undefined ? undefined : assets.get(id);
        if (what === "add" || id === undefined || !asset) {
          const data = files[random(files.length)]!;
          const name = `a${(made += 1)}`;
          const path = `assets/${name}${random(2) ? " copy" : ""}.mp4`;
          await l.addAsset(project, name, path, data);
          assets.set(name, { data, path });
        } else if (what === "upload and place") {
          await l.upload(project.id, asset.data);
          await l.placeIn(project, id, repo, asset.data);
        } else if (what === "upload") {
          // From another project of the repository, say: the project does not change.
          await l.upload(project.id, asset.data);
        } else if (what === "place") {
          // Written down as in Git LFS here, whether the file got there or not.
          await l.placeIn(project, id, repo, asset.data);
        } else if (what === "place elsewhere") {
          await l.placeIn(project, id, "424242", asset.data);
        } else if (what === "move") {
          const path = `assets/moved/${id}-${step}.mp4`;
          await edit(w, project, {
            type: "asset.update",
            params: { asset: id, changes: { path } },
          });
          assets.set(id, { ...asset, path });
        } else if (what === "local") {
          await edit(
            w,
            project,
            {
              type: "asset.setStorage",
              params: { asset: id, storage: "local", hash: hashOf(asset.data) },
            },
            USER,
          );
        } else {
          await edit(w, project, { type: "asset.remove", params: { asset: id } });
          assets.delete(id);
        }
        const outcome = await w.archiver().run(project.id, archived === 0 ? "first" : "auto");
        if (outcome.kind === "archived") {
          archived += 1;
          // The archive that was just made, by its commit: the clock of these tests stands still,
          // so every archive is of the same moment, and "the latest" by time is any of them.
          const [row] = await t.db
            .select({ kept: archives.kept })
            .from(archives)
            .where(and(eq(archives.projectId, project.id), eq(archives.sha, outcome.sha)));
          expect(row, outcome.sha).toBeDefined();
          if ((row?.kept.length ?? 0) > 0) named += 1;
        }
        expect(["archived", "unchanged", "same"], JSON.stringify(outcome)).toContain(outcome.kind);
        noDanglingPointer(repo);
        // What the platform says is its own is a pointer there, and has its line.
        const link = await linkOf(project.id);
        const there = w.github.files(repo.id);
        for (const path of link.lfsPaths)
          expect(readLfsPointer(there.get(path) ?? ""), path).toBeDefined();
        if (link.lfsPaths.length > 0) pointed += 1;
        expect(sectionOf(repo)?.length).toBe(link.lfsPaths.length);
        // And after an archive that looked (a file that got into the storage changes nothing of the
        // project, so no archive looks for it), every asset in Git LFS in assets.json whose object is
        // in the storage has its pointer.
        if (outcome.kind !== "archived" && outcome.kind !== "unchanged") continue;
        const stored = new Set(
          (await t.db.select().from(lfsObjects).where(eq(lfsObjects.repoId, repo.id))).map(
            (row) => row.oid,
          ),
        );
        for (const [name, listed] of Object.entries(assetsOf(repo))) {
          if (listed.storage !== "lfs" || !listed.hash) continue;
          const oid = oidOf(assets.get(name)?.data ?? Buffer.alloc(0));
          if (stored.has(oid))
            expect(readLfsPointer(there.get(listed.path) ?? "")?.oid, name).toBe(oid);
        }
      }
      expect(archived).toBeGreaterThan(5);
      // It went through what it is about: pointers, and files written down as there that are not.
      expect(pointed).toBeGreaterThan(3);
      expect(named).toBeGreaterThan(0);
    },
  );

  test("after a restore, the pointer of an asset that is back in Git LFS gets its line again, though the platform forgot it", async () => {
    const { project, repo } = await l.linked();
    await l.addAsset(project, "local", "assets/local.mp4", randomBytes(100));
    await w.archiver().run(project.id, "first");
    const backup = await linkOf(project.id);
    const video = randomBytes(5000);
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);

    // The database is back from the backup: no row of the object, and the project without the
    // asset. The pointer stays, as people's for now, without its line.
    await restore(project, backup);
    await t.db.delete(lfsObjects).where(eq(lfsObjects.oid, oidOf(video)));
    await edit(w, project, { type: "asset.remove", params: { asset: "video" } });
    await archive(project);
    expect(readLfsPointer(w.github.files(repo.id).get("assets/video.mp4") ?? "")).toBeDefined();

    // The asset is back, its file in the storage: the very pointer is claimed, with its line.
    await l.addAsset(project, "video", "assets/video.mp4", video);
    await l.upload(project.id, video);
    await l.placeIn(project, "video", repo, video);
    expect(await archive(project)).toMatchObject({ kind: "archived" });
    expect(sectionOf(repo)).toEqual([lineOf("/assets/video.mp4")]);
    expect((await linkOf(project.id)).lfsPaths).toEqual(["assets/video.mp4"]);
    expect(await lastKept(project)).not.toContain("assets/video.mp4");
    noDanglingPointer(repo);
  });

  test("more objects to ask GitHub about than an archive asks: the next archives ask the others, not the first ones again", async () => {
    const { project, repo } = await l.linked();
    for (let index = 0; index < 100; index++) {
      const data = randomBytes(64);
      const id = `a${String(index).padStart(3, "0")}`;
      await l.addAsset(project, id, `assets/${id}.mp4`, data);
      await l.placeIn(project, id, repo, data);
    }
    // One whose object GitHub has, after a hundred it has not: the database knows none of them.
    const real = randomBytes(5000);
    w.github.addLfsObject(repo.id, real);
    await l.addAsset(project, "zreal", "assets/zreal.mp4", real);
    await l.placeIn(project, "zreal", repo, real);
    const pointed: boolean[] = [];
    for (let round = 0; round < 3; round++) {
      await w.archiver().run(project.id, round === 0 ? "first" : "auto");
      pointed.push(
        readLfsPointer(w.github.files(repo.id).get("assets/zreal.mp4") ?? "") !== undefined,
      );
      await l.addAsset(project, `more${round}`, `assets/more${round}.mp4`, randomBytes(10));
    }
    // Not in the first, which asks about a hundred; in the second, which asks about the rest.
    expect(pointed).toEqual([false, true, true]);
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(real))),
    ).toHaveLength(1);
    noDanglingPointer(repo);
  });
});
