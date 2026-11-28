import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { AccessPolicy } from "../access.ts";
import { fixedLimits } from "../limits.ts";
import {
  edit,
  linkTo,
  newProject,
  quiet,
  world,
  write,
  type World,
} from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform } from "../test/platform-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import {
  lfsUploads,
  projectCovers,
  projectRepos,
  projects,
  projectUpdates,
  repoConflicts,
  repoMerges,
  users,
} from "../schema.ts";
import { SyncHub } from "./hub.ts";

/**
 * People letting go of the working copy of a project of theirs, to have room on the platform
 * (`POST /api/projects/:id/release`, docs/design/online-offline.md of AnimaQuill Cloud, 3.6), and
 * what they keep there as the storage page lists it (`platform` of `GET /api/me/storage`): only
 * who may manage a project lets go of it or deletes it, never of what the repository does not
 * have, never where the repository cannot give back the last archive right now, and each time with
 * why not. On a real PostgreSQL and the fake GitHub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

/** Everyone may see and change every project; only the owner may manage one: as members will. */
const MEMBERS: AccessPolicy = {
  may: async (_db, userId, project, action) => action !== "manage" || project.ownerId === userId,
  visible: () => sql`true`,
};

describe.skipIf(!TEST_DATABASE)("people letting go of working copies", () => {
  let t: TestDatabase;
  let w: World;
  let hubs: SyncHub[] = [];
  const held = new Set<string>();
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    held.clear();
  });
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.stop();
  });

  const hubOf = (access?: AccessPolicy) => {
    const hub = new SyncHub({
      db: t.db,
      log: quiet,
      now: () => w.time.now,
      holds: { busy: async (_tx, id) => held.has(id) },
      ...(access && { access }),
    });
    hubs.push(hub);
    return hub;
  };
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const setLink = (id: string, set: Partial<typeof projectRepos.$inferInsert>) =>
    t.db.update(projectRepos).set(set).where(eq(projectRepos.projectId, id));

  let repos = 0;
  /** A project with code, archived into a new repository: nothing waits. */
  const archived = async (text = "export const a = 1;\n") => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", text));
    const repo = w.github.addRepo(w.person, { name: `cut${++repos}`, select: true });
    await linkTo(w, project.id, repo);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    return project;
  };
  const release = (open: Awaited<ReturnType<typeof platform>>, id: string) =>
    open.send("POST", `/api/projects/${id}/release`);

  test("lets go of an archived one, which the list and the storage keep as released", async () => {
    const hub = hubOf();
    const open = await platform(w, { hub });
    const project = await archived();
    const before = (await open.send("GET", "/api/me/storage")).json.platform;
    expect(before.projects).toEqual([
      expect.objectContaining({ id: project.id, state: "live", releasable: true }),
    ]);
    expect(before.used).toBeGreaterThan(0);

    expect(await release(open, project.id)).toMatchObject({
      status: 200,
      json: { copy: "released" },
    });
    expect(await rowOf(project.id)).toMatchObject({ copyState: "released", bytes: 0 });
    expect(
      await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, project.id)),
    ).toEqual([]);
    const list = (await open.send("GET", "/api/projects")).json.projects;
    expect(list).toEqual([expect.objectContaining({ id: project.id, copy: "released" })]);
    const after = (await open.send("GET", "/api/me/storage")).json.platform;
    expect(after).toMatchObject({ used: 0, count: { used: 1, limit: null }, limit: null });
    expect(after.projects).toEqual([
      { id: project.id, name: expect.any(String), bytes: 0, state: "released" },
    ]);
    // Again: there is no copy to let go of.
    expect(await release(open, project.id)).toMatchObject({
      status: 409,
      json: { error: "notLive" },
    });
  });

  test("only who may manage it lets go of it or deletes it: 403 for a member, 404 for others", async () => {
    // Someone else's project, archived.
    const [other] = await t.db
      .insert(users)
      .values({ githubId: w.person.id + 1, login: `${w.person.login}-other` })
      .returning({ id: users.id });
    const theirs = await archived();
    await t.db.update(projects).set({ ownerId: other!.id }).where(eq(projects.id, theirs.id));

    const asMember = await platform(w, { hub: hubOf(MEMBERS), access: MEMBERS });
    expect(await release(asMember, theirs.id)).toMatchObject({
      status: 403,
      json: { error: "forbidden" },
    });
    const archivedSeq = (await linkOf(theirs.id)).archivedSeq;
    expect(
      await asMember.send("DELETE", `/api/projects/${theirs.id}?archived=${archivedSeq}`),
    ).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await asMember.send("DELETE", `/api/projects/${theirs.id}?discard=1`)).toMatchObject({
      status: 403,
    });
    // Nor does it list as theirs.
    const kept = (await asMember.send("GET", "/api/me/storage")).json.platform;
    expect(kept.projects).toEqual([]);

    // Only the owner: somebody else does not even hear that it is there.
    const asStranger = await platform(w, { hub: hubOf() });
    expect(await release(asStranger, theirs.id)).toMatchObject({
      status: 404,
      json: { error: "notFound" },
    });
    expect(await asStranger.send("DELETE", `/api/projects/${theirs.id}?discard=1`)).toMatchObject({
      status: 404,
      json: { error: "notFound" },
    });
    expect(await rowOf(theirs.id)).toMatchObject({ copyState: "live" });

    // The hub says the same where it is asked for a person.
    const hub = hubOf(MEMBERS);
    expect(await hub.release(theirs.id, { userId: w.userId })).toEqual({ kind: "forbidden" });
    expect(await hub.remove(theirs.id, w.userId, { discard: true })).toBe("forbidden");
    expect(await rowOf(theirs.id)).toMatchObject({ copyState: "live" });
  });

  test("says why not, for each thing that keeps a copy, in the list and in the answer", async () => {
    const hub = hubOf();
    const open = await platform(w, { hub });
    /** `listed`: whether the list knows of it, which it does not of windows and AI tasks. */
    const refused = async (id: string, why: Record<string, unknown>, inList = true) => {
      expect(await release(open, id)).toMatchObject({
        status: 409,
        json: { error: "notReleasable", why },
      });
      const listed = (await open.send("GET", "/api/me/storage")).json.platform.projects;
      const found = listed.find((each: { id: string }) => each.id === id);
      // The list cannot know of windows and tasks: only the hub, in its lock.
      if (inList) {
        expect(found).toMatchObject({ why: { code: why.code } });
        expect(found).not.toHaveProperty("releasable");
      }
      expect(await rowOf(id)).toMatchObject({ copyState: "live" });
    };

    // No repository: nothing to make it again from.
    const lone = await newProject(w);
    await refused(lone.id, { code: "noRepository" });

    // Changes not archived yet, which go by themselves.
    const pending = await archived();
    await edit(w, pending, write("code/a.js", "export const a = 2;\n"));
    await refused(pending.id, { code: "pending" });

    // Archives fail.
    const failing = await archived();
    await edit(w, failing, write("code/a.js", "export const a = 3;\n"));
    await setLink(failing.id, { failures: 3, detail: "GitHub answered 500" });
    await refused(failing.id, { code: "failing", failures: 3, detail: "GitHub answered 500" });

    // Archiving paused: the repository is read only on GitHub.
    const paused = await archived();
    await edit(w, paused, write("code/a.js", "export const a = 4;\n"));
    w.github.setArchived((await linkOf(paused.id)).repoId, true);
    w.time.later(60 * 60_000);
    expect(await w.archiver().run(paused.id, "auto")).toMatchObject({
      kind: "paused",
      reason: "archived",
    });
    await refused(paused.id, { code: "paused", reason: "archived" });

    // Conflicts with GitHub wait for people: also where the repository has the rest.
    const conflicting = await archived();
    await t.db.insert(repoConflicts).values({
      projectId: conflicting.id,
      batch: "b1",
      source: "merge",
      lost: "batch",
      file: "code/a.js",
      path: [],
      label: "code/a.js",
      kind: "text",
    });
    await refused(conflicting.id, { code: "conflicts", count: 1 });

    // Its repository cannot be used.
    const unusable = await archived();
    await setLink(unusable.id, {
      state: "paused",
      pauseReason: "uninstalled",
      unusableSince: w.time.now,
    });
    await refused(unusable.id, { code: "unusable", reason: "uninstalled" });

    // A merge from GitHub waits to go into the copy; an AI task of it goes on.
    const merging = await archived();
    await t.db.insert(repoMerges).values({
      projectId: merging.id,
      repoId: (await linkOf(merging.id)).repoId,
      fromSha: (await linkOf(merging.id)).headSha!,
      toSha: "f".repeat(40),
      state: "ready",
    });
    await refused(merging.id, { code: "busy" });
    const tasked = await archived();
    held.add(tasked.id);
    await refused(tasked.id, { code: "busy" }, false);

    // A window has it open.
    const connected = await archived();
    const row = (await rowOf(connected.id))!;
    const peer = new TestPeer(hub, { userId: w.userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: connected.id,
      after: 0,
      generation: row.generation,
      device: "d1",
      window: "w1",
      editor: "dev",
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0, "synced");
    await refused(connected.id, { code: "connected" }, false);
    peer.connection.close();
  });

  test("never where the repository cannot give back the last archive right now", async () => {
    const open = await platform(w, { hub: hubOf() });
    const repository = async (id: string, reason: string) => {
      expect(await release(open, id)).toMatchObject({
        status: 409,
        json: { error: "notReleasable", why: { code: "repository", reason } },
      });
      expect(await rowOf(id)).toMatchObject({ copyState: "live" });
      expect(
        await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, id)),
      ).not.toEqual([]);
    };

    // GitHub says 404: deleted, or out of what the App may touch. The list did not know yet.
    const deleted = await archived();
    const listed = (await open.send("GET", "/api/me/storage")).json.platform.projects;
    expect(listed.find((each: { id: string }) => each.id === deleted.id)).toMatchObject({
      releasable: true,
    });
    w.github.deleteRepo((await linkOf(deleted.id)).repoId);
    await repository(deleted.id, "gone");

    // It is there, and does not have the commit of the last archive any more (history rewritten).
    const rewritten = await archived();
    w.github.faults.once.push({ match: /^GET \/repos\/.*\/git\/commits\//, status: 404 });
    await repository(rewritten.id, "missing");

    // Its branch is not there.
    const branchless = await archived();
    w.github.faults.once.push({ match: /^GET \/repos\/.*\/git\/ref\/heads\//, status: 404 });
    await repository(branchless.id, "gone");

    // On another account now.
    const moved = await archived();
    const stranger = { id: w.person.id + 7, login: `${w.person.login}-elsewhere` };
    w.github.install(stranger, "all");
    w.github.transfer((await linkOf(moved.id)).repoId, stranger);
    await repository(moved.id, "gone");

    // Its history written over (a forced push): the last archive is a commit nothing reaches any
    // more, which GitHub lets go of some day.
    const forced = await archived();
    const forcedRepo = (await linkOf(forced.id)).repoId;
    const orphan = w.github.commitAs(forcedRepo, w.person, { "x.txt": "new" }, "Anew", {
      parent: null,
    });
    w.github.forcePush(forcedRepo, w.person, orphan);
    await repository(forced.id, "rewritten");
    // ...but a branch that goes on from it, as people pushing on GitHub, is no reason.
    const ahead = await archived();
    w.github.commitAs((await linkOf(ahead.id)).repoId, w.person, { "notes.txt": "hi" });
    expect(await release(open, ahead.id)).toMatchObject({ status: 200 });

    // GitHub cannot be reached: nothing goes on a guess.
    const away = await archived();
    w.github.faults.unreachable = true;
    await repository(away.id, "unreachable");
    w.github.faults.unreachable = false;
    expect(await release(open, away.id)).toMatchObject({ status: 200 });
  });

  test("never while files of its assets are on their way into the large file storage", async () => {
    const hub = hubOf();
    const open = await platform(w, { hub });
    const project = await archived();
    const { repoId } = await linkOf(project.id);
    const [upload] = await t.db
      .insert(lfsUploads)
      .values({
        userId: w.userId,
        projectId: project.id,
        repoId,
        oid: "a".repeat(64),
        size: 1000,
        state: "receiving",
      })
      .returning({ id: lfsUploads.id });
    expect(await release(open, project.id)).toMatchObject({
      status: 409,
      json: { error: "notReleasable", why: { code: "uploading", count: 1 } },
    });
    const listed = (await open.send("GET", "/api/me/storage")).json.platform.projects;
    expect(listed).toEqual([
      expect.objectContaining({ id: project.id, why: { code: "uploading", count: 1 } }),
    ]);
    // Not even where an admin says to let go of what the repository does not have.
    expect(await hub.release(project.id, { unarchived: true })).toEqual({
      kind: "uploading",
      uploads: 1,
    });
    expect(await rowOf(project.id)).toMatchObject({ copyState: "live" });
    expect(
      await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, project.id)),
    ).not.toEqual([]);
    // Once it is in: let go of as any.
    await t.db.update(lfsUploads).set({ state: "done" }).where(eq(lfsUploads.id, upload!.id));
    expect(await release(open, project.id)).toMatchObject({ status: 200 });
  });

  test("the hub lets go of a copy for people only against the archive that was looked at", async () => {
    const hub = hubOf();
    const project = await archived();
    const { headSha } = await linkOf(project.id);
    // Nobody looked at the repository: not on a guess.
    expect(await hub.release(project.id, { userId: w.userId })).toEqual({ kind: "busy" });
    // Another archive since the look.
    expect(await hub.release(project.id, { userId: w.userId, checked: "0".repeat(40) })).toEqual({
      kind: "busy",
    });
    expect(await rowOf(project.id)).toMatchObject({ copyState: "live" });
    expect(await hub.release(project.id, { userId: w.userId, checked: headSha! })).toMatchObject({
      kind: "released",
    });
  });

  test("lists what each person keeps, the largest first, only their own, as the limits say", async () => {
    const limits = fixedLimits({ "storage.platform": 10_000_000, "projects.count": 4 }, "person");
    const open = await platform(w, { hub: hubOf(), limits });
    const small = await archived();
    const large = await archived(`export const a = "${"x".repeat(4000)}";\n`);
    // As the hub notes it once it compacts: larger than the others, with no tie to order by.
    await t.db.update(projects).set({ bytes: 50_000 }).where(eq(projects.id, large.id));
    await t.db.insert(projectCovers).values({
      projectId: small.id,
      type: "image/webp",
      bytes: Buffer.alloc(9000),
      etag: "e1",
    });
    const lone = await newProject(w);
    // Somebody else's counts for them only.
    const [other] = await t.db
      .insert(users)
      .values({ githubId: w.person.id + 3, login: `${w.person.login}-third` })
      .returning({ id: users.id });
    const theirs = await newProject(w);
    await t.db.update(projects).set({ ownerId: other!.id }).where(eq(projects.id, theirs.id));

    const kept = (await open.send("GET", "/api/me/storage")).json.platform;
    const bytesOf = async (id: string) => (await rowOf(id))!.bytes;
    const sizes = {
      small: (await bytesOf(small.id)) + 9000,
      large: await bytesOf(large.id),
      lone: await bytesOf(lone.id),
    };
    expect(kept).toEqual({
      limit: 10_000_000,
      used: sizes.small + sizes.large + sizes.lone,
      count: { limit: 4, used: 3 },
      projects: [
        { id: small.id, bytes: sizes.small, releasable: true },
        { id: large.id, bytes: sizes.large, releasable: true },
        { id: lone.id, bytes: sizes.lone, why: { code: "noRepository" } },
      ]
        .toSorted((a, b) => b.bytes - a.bytes)
        .map((each) => ({ ...each, name: expect.any(String), state: "live" })),
    });
  });
});
