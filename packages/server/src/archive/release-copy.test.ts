import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { TestPeer } from "../test/sync-support.ts";
import { projectRepos, projects, projectUpdates, repoConflicts, repoMerges } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { listProjects } from "../sync/list.ts";
import { archivesFailingLong } from "../sync/sweep.ts";

/**
 * Letting go of the working copy of a project (`SyncHub.release`), as an admin asks for it today
 * and people will: whether or not the repository has all of it (`unarchived`), keeping the list;
 * never of one whose changes wait for GitHub or the platform, or for their first try, nor while a
 * window is connected or an AI task goes on, nor where what it is cannot be told. And the projects
 * whose changes have not got into GitHub for three days, which the hourly sweep names. On a real
 * PostgreSQL and the fake GitHub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const DAY = 24 * 3600_000;

describe.skipIf(!TEST_DATABASE)("letting go of working copies, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let hubs: SyncHub[] = [];
  /** Projects something else may still change, as an AI task (`ProjectHolds`). */
  const held = new Set<string>();
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
  });
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.stop();
  });

  const hubOf = () => {
    const hub = new SyncHub({
      db: t.db,
      log: quiet,
      now: () => w.time.now,
      holds: { busy: async (_tx, id) => held.has(id) },
    });
    hubs.push(hub);
    return hub;
  };
  /** Lets go of a copy as an admin does, also of what the repository does not have. */
  const release = (hub: SyncHub, id: string) => hub.release(id, { unarchived: true });
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const copyOf = async (id: string) => (await rowOf(id))?.copyState;

  let repos = 0;
  /** A project with code, archived into a new repository, opened now. */
  const archived = async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "export const a = 1;\n"));
    const repo = w.github.addRepo(w.person, {
      name: `film${++repos}`,
      select: true,
    });
    await linkTo(w, project.id, repo);
    expect(await w.archiver().run(project.id, "first")).toMatchObject({
      kind: "archived",
    });
    await opened(project.id);
    return project;
  };
  /** Notes the project opened now, as a window that edits it does. */
  const opened = (id: string) =>
    t.db.update(projects).set({ openedAt: w.time.now }).where(eq(projects.id, id));

  /** Says hello for a project as an editor does, and waits until it is synced. */
  const hello = async (hub: SyncHub, id: string, readOnly = false) => {
    const row = (await rowOf(id))!;
    const peer = new TestPeer(hub, { userId: w.userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      generation: row.generation,
      device: "d1",
      window: "w1",
      editor: "dev",
      ...(readOnly && { readOnly: true }),
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0, "synced");
    return peer;
  };

  const listed = async (id: string) => {
    const { projects: list } = await listProjects(t.db, w.userId, {
      webUrl: "https://github.test",
      now: w.time.now.getTime(),
    });
    return list.find((each) => each.id === id);
  };

  test("lets go of it whether or not the repository has it, where people say so, and keeps the list", async () => {
    const hub = hubOf();
    // Archived, nothing waits.
    const clean = await archived();
    // Changes that people have to see to: the repository was set read only (13.6, 1).
    const unsaved = await archived();
    await edit(w, unsaved, write("code/a.js", "export const a = 2;\n"));
    w.github.setArchived((await linkOf(unsaved.id)).repoId, true);
    w.time.later(60 * 60_000);
    expect(await w.archiver().run(unsaved.id, "auto")).toMatchObject({
      kind: "paused",
      reason: "archived",
    });
    // A project from before every project had a repository (13.6, 3): nothing to make it from.
    const lone = await newProject(w);
    const before = await listed(clean.id);
    const beforeUnsaved = await listed(unsaved.id);

    expect(await hub.release(unsaved.id)).toMatchObject({
      kind: "notArchived",
    });
    expect(await release(hub, lone.id)).toEqual({ kind: "noRepository" });
    expect(await hub.release(clean.id)).toMatchObject({ kind: "released" });
    expect(await release(hub, unsaved.id)).toMatchObject({
      kind: "released",
    });
    expect(await rowOf(clean.id)).toMatchObject({ copyState: "released" });
    expect(await rowOf(unsaved.id)).toMatchObject({
      copyState: "released",
      dirtySince: null,
      releasedFrom: { head: 3, archivedSeq: 2 },
    });
    expect(
      await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, unsaved.id)),
    ).toEqual([]);
    // The list is as it was, but for the copy, which is not here.
    const strip = (summary: Awaited<ReturnType<typeof listed>>) => {
      const { copy: _copy, size: _size, releasedAt: _releasedAt, ...rest } = summary!;
      return rest;
    };
    const after = await listed(clean.id);
    expect(after).toMatchObject({
      copy: "released",
      releasedAt: w.time.now.getTime(),
    });
    expect(strip(after)).toEqual(strip(before));
    expect(strip(await listed(unsaved.id))).toMatchObject({
      repository: beforeUnsaved!.repository,
    });
    expect(await copyOf(lone.id)).toBe("live");
    // Again: nothing more.
    expect(await release(hub, clean.id)).toEqual({ kind: "notLive" });
  });

  test("never lets go of changes that wait for GitHub, the platform, or their first try", async () => {
    const hub = hubOf();
    // Not tried yet.
    const waiting = await archived();
    await edit(w, waiting, write("code/a.js", "export const a = 2;\n"));
    // GitHub is away (13.1, "暂时的").
    const away = await archived();
    await edit(w, away, write("code/a.js", "export const a = 3;\n"));
    w.github.faults.down = 10;
    expect(await w.archiver().run(away.id, "auto")).toMatchObject({
      kind: "failed",
    });
    w.github.faults.down = 0;
    expect((await linkOf(away.id)).transientSince).not.toBeNull();
    // An error of the platform's own counts so too (13.9).
    const broken = await archived();
    await edit(w, broken, write("code/a.js", "export const a = 4;\n"));
    await t.db
      .update(projectRepos)
      .set({
        failures: 3,
        transientSince: w.time.now,
        detail: "MissingUpdates",
      })
      .where(eq(projectRepos.projectId, broken.id));
    for (const { id } of [waiting, away, broken]) {
      expect(await release(hub, id)).toEqual({ kind: "transient" });
      expect(await copyOf(id)).toBe("live");
    }
    // Once in, they go.
    for (const { id } of [waiting, away, broken]) {
      await t.db
        .update(projectRepos)
        .set({ failures: 0, transientSince: null, nextAttemptAt: null })
        .where(eq(projectRepos.projectId, id));
      expect(await w.archiver().run(id, "auto")).toMatchObject({
        kind: "archived",
      });
      expect(await release(hub, id)).toMatchObject({ kind: "released" });
    }
  });

  test("keeps a copy a window is connected to, also one that reads, or something else changes", async () => {
    const hub = hubOf();
    const connected = await archived();
    const reading = await archived();
    const working = await archived();
    const peer = await hello(hub, connected.id);
    const reader = await hello(hub, reading.id, true);
    // Something else that may change it goes on, as an AI task of it.
    held.add(working.id);
    expect(await release(hub, connected.id)).toEqual({ kind: "connected" });
    expect(await release(hub, reading.id)).toEqual({ kind: "connected" });
    expect(await release(hub, working.id)).toEqual({ kind: "busy" });
    for (const { id } of [connected, reading, working]) expect(await copyOf(id)).toBe("live");
    peer.connection.close();
    reader.connection.close();
    await hub.idle();
    held.delete(working.id);
    for (const { id } of [connected, reading, working])
      expect(await release(hub, id)).toMatchObject({ kind: "released" });
  });

  test("keeps a copy whose state cannot be told: the repository may be gone, a merge waits", async () => {
    const hub = hubOf();
    const project = await archived();
    await t.db
      .update(projectRepos)
      .set({ unusableSeenAt: w.time.now })
      .where(eq(projectRepos.projectId, project.id));
    expect(await release(hub, project.id)).toEqual({ kind: "busy" });
    await t.db
      .update(projectRepos)
      .set({ unusableSeenAt: null })
      .where(eq(projectRepos.projectId, project.id));
    const link = await linkOf(project.id);
    const [merge] = await t.db
      .insert(repoMerges)
      .values({
        projectId: project.id,
        repoId: link.repoId,
        fromSha: link.headSha!,
        toSha: "f".repeat(40),
      })
      .returning({ id: repoMerges.id });
    expect(await release(hub, project.id)).toEqual({ kind: "busy" });
    await t.db.update(repoMerges).set({ state: "refused" }).where(eq(repoMerges.id, merge!.id));
    await t.db
      .update(projectRepos)
      .set({ dropping: ["secret.txt"] })
      .where(eq(projectRepos.projectId, project.id));
    expect(await release(hub, project.id)).toEqual({ kind: "busy" });
    await t.db
      .update(projectRepos)
      .set({ dropping: null })
      .where(eq(projectRepos.projectId, project.id));
    expect(await release(hub, project.id)).toMatchObject({
      kind: "released",
    });
  });

  test("lets go of what was merged from GitHub with the copy, so that GitHub's changes come in again", async () => {
    const hub = hubOf();
    const project = await archived();
    // Changes on GitHub merged into the copy, not archived; a conflict open, archiving paused.
    await edit(w, project, write("code/a.js", "export const a = 5;\n"));
    await t.db
      .update(projectRepos)
      .set({
        mergedSha: "e".repeat(40),
        blocked: [{ path: "notes.bin", reason: "unreadable" }],
        state: "paused",
        pauseReason: "conflicts",
        pausedAt: w.time.now,
      })
      .where(eq(projectRepos.projectId, project.id));
    await t.db.insert(repoConflicts).values({
      projectId: project.id,
      batch: "b1",
      source: "merge",
      lost: "batch",
      file: "code/a.js",
      path: [],
      label: "code/a.js",
      kind: "text",
      change: Buffer.from([1, 2, 3]),
    });
    expect(await release(hub, project.id)).toMatchObject({
      kind: "released",
    });
    expect(await rowOf(project.id)).toMatchObject({
      copyState: "released",
      releasedFrom: { head: 3, archivedSeq: 2 },
    });
    // The next copy is the archive: what GitHub has after it is merged into it again, from there.
    expect(await linkOf(project.id)).toMatchObject({
      mergedSha: null,
      blocked: [],
      state: "ready",
      pauseReason: null,
    });
    const conflicts = await t.db
      .select()
      .from(repoConflicts)
      .where(eq(repoConflicts.projectId, project.id));
    expect(conflicts).toMatchObject([{ state: "stale", change: null }]);
  });

  test("names projects whose changes have not got into GitHub for three days", async () => {
    const stuck = await archived();
    await edit(w, stuck, write("code/a.js", "export const a = 6;\n"));
    const away = await archived();
    await edit(w, away, write("code/a.js", "export const a = 7;\n"));
    await t.db
      .update(projectRepos)
      .set({ failures: 9, transientSince: w.time.now })
      .where(eq(projectRepos.projectId, away.id));
    const ids = (found: { readonly projects: readonly { readonly project: string }[] }) =>
      found.projects.map(({ project }) => project);
    w.time.later(2 * DAY);
    let found = await archivesFailingLong(t.db, w.time.now);
    expect(ids(found.behind)).not.toContain(stuck.id);
    w.time.later(DAY + 60_000);
    found = await archivesFailingLong(t.db, w.time.now);
    expect(ids(found.behind)).toEqual(expect.arrayContaining([stuck.id, away.id]));
    expect(ids(found.transient)).toContain(away.id);
    expect(ids(found.transient)).not.toContain(stuck.id);
  });
});
