import { SYNC_CLOSE, SYNC_PROTOCOL } from "@animaquill/host/sync";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  confirmed,
  Editor,
  edit,
  keep,
  newProject,
  quiet,
  world,
  write,
  type World,
} from "../test/archive-support.ts";
import {
  connection,
  createTestDatabase,
  TEST_DATABASE,
  type TestDatabase,
} from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import {
  agentBudgets,
  agentCards,
  agentMail,
  agentWatches,
  agentWindows,
  archives,
  deletedProjects,
  lfsUploads,
  projectCovers,
  projectMarks,
  userChats,
  projectRepos,
  projects,
  projectSnapshots,
  projectUpdates,
  projectBatches,
  repoConflicts,
  repoMerges,
} from "../schema.ts";
import { editorAtLeast, SyncHub } from "./hub.ts";

/**
 * Taking away a project that is saved to a repository: only once the repository has everything of it, or where people let the rest go; with
 * nothing of it left on the platform, and the repository as it was; and the windows that have it
 * hearing that it was deleted. On a real PostgreSQL, the fake GitHub and a hub. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

/** The editor of the windows. */
const NEW = "0.3.50";

/** What deleting says of a project whose archiving goes as it should, but is not all there. */
const READY = { error: "notArchived", state: "ready", archiving: false } as const;

describe("which editors are as new as a version", () => {
  test("those of the version and later; pages of the code always", () => {
    expect(editorAtLeast("0.3.50", "0.3.50")).toBe(true);
    expect(editorAtLeast("0.3.51", "0.3.50")).toBe(true);
    expect(editorAtLeast("0.4.0", "0.3.50")).toBe(true);
    expect(editorAtLeast("1.0.0", "0.3.50")).toBe(true);
    expect(editorAtLeast("0.3.49", "0.3.50")).toBe(false);
    expect(editorAtLeast("0.2.99", "0.3.50")).toBe(false);
    // Numbers, not text.
    expect(editorAtLeast("0.3.100", "0.3.50")).toBe(true);
    expect(editorAtLeast("0.3.9", "0.3.50")).toBe(false);
    expect(editorAtLeast("dev", "0.3.50")).toBe(true);
    for (const other of ["", "test", "local", "0.3", "0.3.50-beta", " 0.3.50", "v0.3.50"])
      expect(editorAtLeast(other, "0.3.50"), other).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE)(
  "taking away a project saved to a repository, on a database",
  () => {
    let t: TestDatabase;
    let w: World;
    let p: Platform;
    let hub: SyncHub;
    beforeAll(async () => {
      t = await createTestDatabase();
    });
    afterAll(async () => {
      await t?.drop();
    });
    beforeEach(async () => {
      w = await world(t.db);
      hub = new SyncHub({ db: t.db, log: quiet });
      p = await platform(w, { hub });
    });
    afterEach(() => {
      hub.stop();
    });

    const rowOf = async (id: string) =>
      (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
    const linkOf = async (id: string) =>
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0];
    const updatesOf = async (id: string) =>
      t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, id));
    const remove = (id: string, query = "") => p.send("DELETE", `/api/projects/${id}${query}`);

    /** How a window's connection closed, or undefined where it is still open a moment from now. */
    const closeOf = (peer: TestPeer) =>
      Promise.race([
        peer.connection.closed,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]);

    /** Waits until a statement of this database waits for a lock, as one that is held up does. */
    const untilHeldUp = async () => {
      for (let turn = 0; turn < 300; turn++) {
        const waiting = await t.query(
          "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (waiting.rows[0].waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("nothing waits for a lock");
    };

    /** A window of an editor of `editor` that says hello for a project, after `after`. */
    const hello = (id: string, editor: string, after = 0, userId = w.userId) => {
      const peer = new TestPeer(hub, { userId, session: "s" });
      peer.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: id,
        after,
        device: "d1",
        window: "w1",
        editor,
        payload: new Uint8Array(0),
      });
      return peer;
    };

    /** A window connected to a project that is on the platform. */
    const connect = async (id: string, editor: string) => {
      const peer = hello(id, editor);
      await peer.until(() => peer.of("synced").length > 0, "synced");
      return peer;
    };

    /** A project with a change, saved to a new repository, and archived: GitHub has all of it. */
    const archived = async (name = "film") => {
      const project = await newProject(w);
      await edit(w, project, write("code/a.js", "a\n"));
      const linked = await p.request("POST", `/api/projects/${project.id}/repository`, {
        create: { name },
      });
      expect(linked.status).toBe(201);
      expect(await p.work()).toMatchObject([{ kind: "archived", seq: 2 }]);
      const link = (await linkOf(project.id))!;
      expect(link.archivedSeq).toBe(2);
      expect((await rowOf(project.id))!).toMatchObject({ head: 2, dirtySince: null });
      return { project, repoId: link.repoId };
    };

    test("goes once the repository has everything of it, up to the update the editor saw", async () => {
      const { project, repoId } = await archived();
      const files = new Map(w.github.files(repoId));
      expect(files.size).toBeGreaterThan(0);
      // Not as an editor from before asks: it stays, as ever.
      expect((await remove(project.id)).json).toEqual({ error: "hasRepository" });
      // The editor saw less archived than there is: what it saw is not what goes.
      const behind = await remove(project.id, "?archived=1");
      expect(behind.status).toBe(409);
      expect(behind.json).toEqual({ ...READY, head: 2, archivedSeq: 2 });
      expect((await remove(project.id, "?archived=3")).json).toMatchObject({
        error: "notArchived",
      });
      expect(await rowOf(project.id)).toBeDefined();

      const deleted = await remove(project.id, "?archived=2");
      expect(deleted.status).toBe(204);
      expect(await rowOf(project.id)).toBeUndefined();
      expect(await linkOf(project.id)).toBeUndefined();
      // The repository is as it was: every file of it.
      expect(new Map(w.github.files(repoId))).toEqual(files);
      // Gone: there is none to take away again.
      expect((await remove(project.id, "?archived=2")).json).toEqual({ error: "notFound" });
    });

    test("a change the repository does not have yet keeps it, whatever the editor saw", async () => {
      const { project } = await archived();
      await edit(w, project, write("code/a.js", "b\n"));
      // The head moved on: the repository has 2 of 3.
      expect((await remove(project.id, "?archived=2")).json).toEqual({
        ...READY,
        head: 3,
        archivedSeq: 2,
      });
      expect((await remove(project.id, "?archived=3")).json).toEqual({
        ...READY,
        head: 3,
        archivedSeq: 2,
      });
      // Archived again, it goes.
      await p.request("POST", `/api/projects/${project.id}/archive`);
      expect(await p.work()).toMatchObject([{ kind: "archived", seq: 3 }]);
      expect((await remove(project.id, "?archived=3")).status).toBe(204);
    });

    test("changes waiting to be archived keep it, also where the numbers say it has everything", async () => {
      const { project } = await archived();
      // As the database has it after an archive that is not noted the way it should be.
      await t.db
        .update(projects)
        .set({ dirtySince: new Date() })
        .where(eq(projects.id, project.id));
      expect((await remove(project.id, "?archived=2")).json).toEqual({
        ...READY,
        head: 2,
        archivedSeq: 2,
      });
      expect(await rowOf(project.id)).toBeDefined();
    });

    test("goes with whatever the repository has where people let the rest go", async () => {
      const { project, repoId } = await archived();
      await edit(w, project, write("code/a.js", "never archived\n"));
      const files = new Map(w.github.files(repoId));
      expect((await remove(project.id, "?discard=1")).status).toBe(204);
      expect(await rowOf(project.id)).toBeUndefined();
      expect(new Map(w.github.files(repoId))).toEqual(files);
      // Also one whose archiving paused, as when the repository is gone.
      const paused = await archived("other");
      await t.db
        .update(projectRepos)
        .set({ state: "paused", pauseReason: "gone" })
        .where(eq(projectRepos.projectId, paused.project.id));
      expect((await remove(paused.project.id, "?discard=1")).status).toBe(204);
    });

    test("one saved to no repository goes whatever is asked; what is no condition is turned away", async () => {
      for (const query of ["", "?archived=7", "?discard=1", "?archived=1&discard=1"]) {
        const project = await newProject(w);
        expect((await remove(project.id, query)).status, query).toBe(204);
      }
      const project = await newProject(w);
      for (const query of [
        "?archived=",
        "?archived=-1",
        "?archived=1.5",
        "?archived=01",
        "?archived=a",
        "?archived=1&archived=2",
        "?archived=9999999999999999",
        "?discard=0",
        "?discard=true",
        "?discard=",
      ]) {
        const refused = await remove(project.id, query);
        expect(refused.status, query).toBe(400);
        expect(refused.json, query).toEqual({ error: "invalid" });
      }
      expect(await rowOf(project.id)).toBeDefined();
    });

    test("a change taken while it is being deleted keeps it: what is looked at is looked at in the lock", async () => {
      const { project } = await archived();
      // Another process takes a change of the project: it holds the row, as the hub does.
      const other = await connection(t);
      let answered = false;
      try {
        await other.query("begin");
        await other.query("select head from projects where id = $1 for update", [project.id]);
        const deleting = remove(project.id, "?archived=2").then((answer) => {
          answered = true;
          return answer;
        });
        await untilHeldUp();
        expect(answered).toBe(false);
        // The change lands while deleting waits, as one that came a moment before it would.
        await other.query(
          "update projects set head = 3, dirty_since = coalesce(dirty_since, now()) where id = $1",
          [project.id],
        );
        await other.query(
          `insert into project_updates (project_id, seq, digest, data, kind, device, "window", base, made_at)
         values ($1, 3, 'd3', '\\x00'::bytea, 'user', 'd2', 'w2', 2, now())`,
          [project.id],
        );
        await other.query("commit");
        const refused = await deleting;
        expect(refused.status).toBe(409);
        expect(refused.json).toEqual({ ...READY, head: 3, archivedSeq: 2 });
      } finally {
        await other.end();
      }
      expect((await rowOf(project.id))!.head).toBe(3);
      expect(await updatesOf(project.id)).toHaveLength(3);
    });

    test("an archive that lands while it is being deleted is seen, and nothing waits for the other for good", async () => {
      const { project } = await archived();
      await edit(w, project, write("code/a.js", "b\n"));
      // An archive of update 3 lands, as the worker notes it: the link first, then the project.
      const worker = await connection(t);
      try {
        await worker.query("begin");
        await worker.query(
          "update project_repos set archived_seq = greatest(archived_seq, 3) where project_id = $1",
          [project.id],
        );
        const deleting = remove(project.id, "?archived=3");
        await untilHeldUp();
        await worker.query(
          "update projects set dirty_since = case when head <= 3 then null else now() end where id = $1",
          [project.id],
        );
        await worker.query("commit");
        // Deleting waited for it, and saw everything archived.
        expect((await deleting).status).toBe(204);
      } finally {
        await worker.end();
      }
      expect(await rowOf(project.id)).toBeUndefined();
    });

    test("a window's change while the project is being deleted waits, and is never taken", async () => {
      const { project } = await archived();
      const window = await connect(project.id, NEW);
      // Deleting is held up half way: something else holds the row for a moment.
      const holding = await connection(t);
      try {
        await holding.query("begin");
        await holding.query("select 1 from projects where id = $1 for update", [project.id]);
        const deleting = remove(project.id, "?archived=2");
        await untilHeldUp();
        window.send({
          t: "push",
          id: 1,
          kind: "user",
          base: 2,
          at: Date.now(),
          window: "w1",
          behind: false,
          payload: project.editor.change(write("code/b.js", "b\n")),
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        // It waits for the project's turn, which deleting has.
        expect(window.of("ack")).toEqual([]);
        await holding.query("rollback");
        expect((await deleting).status).toBe(204);
      } finally {
        await holding.end();
      }
      expect((await closeOf(window))?.code).toBe(SYNC_CLOSE.deleted);
      expect(window.of("ack")).toEqual([]);
      await hub.idle();
      expect(await updatesOf(project.id)).toEqual([]);
      expect(await rowOf(project.id)).toBeUndefined();
    });

    test("a window's change that came first keeps it", async () => {
      const { project } = await archived();
      const window = await connect(project.id, NEW);
      window.send({
        t: "push",
        id: 1,
        kind: "user",
        base: 2,
        at: Date.now(),
        window: "w1",
        behind: false,
        payload: project.editor.change(write("code/b.js", "b\n")),
      });
      // Sent at the same moment: whichever is first, a change that is taken is never deleted.
      const answer = await remove(project.id, "?archived=2");
      await hub.idle();
      if (window.of("ack").length > 0) {
        expect(answer.json).toEqual({ ...READY, head: 3, archivedSeq: 2 });
        expect(await rowOf(project.id)).toBeDefined();
      } else {
        expect(answer.status).toBe(204);
        expect((await closeOf(window))?.code).toBe(SYNC_CLOSE.deleted);
      }
    });

    test("windows hear that it was deleted", async () => {
      const { project } = await archived();
      const fresh = await connect(project.id, NEW);
      const newer = await connect(project.id, "0.4.0");
      expect((await remove(project.id, "?archived=2")).status).toBe(204);
      expect((await closeOf(fresh))?.code).toBe(SYNC_CLOSE.deleted);
      expect((await closeOf(newer))?.code).toBe(SYNC_CLOSE.deleted);
      await hub.idle();
      expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });
    });

    test("a window that comes for it within the week hears that it was deleted, only the person's", async () => {
      const { project } = await archived();
      expect((await remove(project.id, "?archived=2")).status).toBe(204);
      const fresh = hello(project.id, NEW, 2);
      expect((await closeOf(fresh))?.code).toBe(SYNC_CLOSE.deleted);
      expect(fresh.received).toEqual([]);
      // One that brings its first version to make it again, as a window whose note says so.
      const editor = new Editor();
      const making = new TestPeer(hub, { userId: w.userId, session: "s" });
      making.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: project.id,
        after: 0,
        generation: 1,
        device: "d1",
        window: "w1",
        editor: NEW,
        create: { name: "again", projectId: editor.projectId },
        payload: editor.store.encodeState(),
      });
      expect((await closeOf(making))?.code).toBe(SYNC_CLOSE.deleted);
      expect(await rowOf(project.id)).toBeUndefined();
      // Someone else hears nothing of what was not theirs.
      const someone = await world(t.db);
      const stranger = hello(project.id, NEW, 0, someone.userId);
      expect((await closeOf(stranger))?.code).toBe(SYNC_CLOSE.missing);
      // A project that never was is not there, not deleted.
      const never = hello(`never${Date.now().toString(36)}`, NEW);
      expect((await closeOf(never))?.code).toBe(SYNC_CLOSE.missing);
      // After the week, it is only not there.
      await t.db
        .update(deletedProjects)
        .set({ deletedAt: new Date(Date.now() - 8 * 24 * 3600_000) })
        .where(eq(deletedProjects.id, project.id));
      const late = hello(project.id, NEW, 2);
      expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.missing);
    });

    test("nothing of it is left on the platform: every table that points at a project goes with it", async () => {
      const { project, repoId } = await archived();
      const other = await archived("other");
      // Something of it in each table that points at projects, and the same for another project.
      for (const id of [project.id, other.project.id]) {
        for (let index = 0; index < 3; index++)
          await keep(t.db, id, new Editor().change(write("code/x.js", `${index}\n`)), new Date());
        await t.db.insert(projectSnapshots).values({
          projectId: id,
          seq: 2,
          digest: "d",
          state: Buffer.from([0]),
          reason: "before-merge",
        });
        await t.db.insert(projectCovers).values({
          projectId: id,
          bytes: Buffer.from("cover"),
          type: "image/webp",
          etag: "e",
        });
        await t.db.insert(lfsUploads).values({
          userId: w.userId,
          projectId: id,
          repoId,
          oid: (id === project.id ? "a" : "b").repeat(64),
          size: 10,
          state: "received",
        });
        await t.db
          .insert(projectMarks)
          .values({ userId: w.userId, projectId: id, starred: true, starAt: new Date() });
        // A merge from GitHub, its batch and a conflict of it.
        const [merge] = await t.db
          .insert(repoMerges)
          .values({ projectId: id, repoId, fromSha: "a", toSha: "b", state: "applied" })
          .returning({ id: repoMerges.id });
        const mergeId = (merge as { id: string }).id;
        await t.db.insert(projectBatches).values({
          id: mergeId,
          projectId: id,
          kind: "repo",
          mergeId,
          seq: 2,
          label: "GitHub 上的改动",
          files: 1,
          writes: Buffer.from([0]),
          formatVersion: 1,
        });
        await t.db.insert(repoConflicts).values({
          projectId: id,
          mergeId,
          batch: mergeId,
          source: "merge",
          lost: "batch",
          file: "animaquill.json",
          path: ["manifest", "name"],
          label: "项目的名字",
          kind: "value",
        });
        await t.db.insert(userChats).values({
          userId: w.userId,
          projectId: id,
          chatId: "c1",
          revision: 1,
          summary: { id: "c1", title: "对话", updatedAt: 1 },
          body: { entries: [] },
          size: 10,
          updatedAt: new Date(),
        });
        // What its conversations say to each other (me/agents.ts).
        const at = new Date();
        const of = { userId: w.userId, projectId: id };
        await t.db.insert(agentWindows).values({ ...of, windowId: "w-1", liveUntil: at });
        await t.db.insert(agentCards).values({
          ...of,
          agentId: "c1",
          windowId: "w-1",
          card: {},
          updatedAt: at,
        });
        await t.db.insert(agentMail).values({
          ...of,
          mailId: "m-1",
          toAgent: "c1",
          fromAgent: "c2",
          text: "x",
          body: {},
          left: false,
          sentAt: 1,
          createdAt: at,
          expiresAt: at,
        });
        await t.db.insert(agentWatches).values({ ...of, target: "c1", watcher: "c2", until: at });
        await t.db.insert(agentBudgets).values({ ...of, count: 1, at });
      }
      expect(
        await t.db.select().from(archives).where(eq(archives.projectId, project.id)),
      ).toHaveLength(1);

      // Every foreign key of the server that points at projects, as the database has them: one
      // that a later step adds is looked at here too. (Those of a deployment's schema, such as the
      // platform's tasks of cloud AI, are its own to test.)
      const keys = await t.query(
        `select c.conrelid::regclass::text as "table", a.attname as "column", c.confdeltype as "onDelete"
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'projects'::regclass
          and c.connamespace = 'public'::regnamespace
        order by 1`,
      );
      const pointing = keys.rows as { table: string; column: string; onDelete: string }[];
      expect(pointing.map(({ table }) => table)).toEqual(
        expect.arrayContaining([
          "archives",
          "lfs_uploads",
          "project_batches",
          "project_covers",
          "project_marks",
          "project_repos",
          "project_snapshots",
          "project_updates",
          "repo_conflicts",
          "repo_merges",
          "user_chats",
          "agent_windows",
          "agent_cards",
          "agent_mail",
          "agent_watches",
          "agent_budgets",
        ]),
      );
      // Each goes with its project ("c": on delete cascade).
      for (const key of pointing) expect(key.onDelete, key.table).toBe("c");
      const left = async (id: string) => {
        const counts: Record<string, number> = {};
        for (const { table, column } of pointing) {
          const rows = await t.query(
            `select count(*)::int as n from ${table} where ${column} = $1`,
            [id],
          );
          counts[table] = rows.rows[0].n;
        }
        return counts;
      };
      for (const n of Object.values(await left(project.id))) expect(n).toBeGreaterThan(0);

      expect((await remove(project.id, "?discard=1")).status).toBe(204);
      for (const [table, n] of Object.entries(await left(project.id))) expect(n, table).toBe(0);
      expect(await rowOf(project.id)).toBeUndefined();
      // Only its id is kept, and whose it was.
      expect(
        (
          await t.db
            .select()
            .from(deletedProjects)
            .where(sql`${deletedProjects.id} = ${project.id}`)
        )[0],
      ).toMatchObject({ ownerId: w.userId });
      // The other project has everything it had.
      for (const [table, n] of Object.entries(await left(other.project.id)))
        expect(n, table).toBeGreaterThan(0);
    });

    test("its repository is free again: choosing it says it has a project, not that another one has it", async () => {
      const { project, repoId } = await archived();
      const next = await newProject(w);
      const check = async () =>
        (await p.request("POST", "/api/github/repositories/check", { existing: { id: repoId } }))
          .json;
      const link = async () =>
        (
          await p.request("POST", `/api/projects/${next.id}/repository`, {
            existing: { id: repoId },
          })
        ).json;
      expect(await check()).toMatchObject({ ok: false, reason: "linkedElsewhere" });
      expect(await link()).toMatchObject({ error: "linkedElsewhere" });

      expect((await remove(project.id, "?archived=2")).status).toBe(204);
      // Its files are still there: a project, to bring back from it some day.
      expect(await check()).toMatchObject({ ok: false, reason: "hasProject" });
      expect(await link()).toMatchObject({ error: "hasProject" });
      expect(await linkOf(next.id)).toBeUndefined();
      // Nothing holds the repository: no row names it.
      expect(await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, repoId))).toEqual(
        [],
      );
    });

    test("the log says who took what away, whether it had a repository, and whether people let the rest go", async () => {
      const logged: { said: Record<string, unknown>; message: string | undefined }[] = [];
      const log = {
        ...quiet,
        info: (said: object, message?: string) =>
          void logged.push({ said: said as Record<string, unknown>, message }),
      };
      const logging = new SyncHub({ db: t.db, log });
      const q = await platform(w, { hub: logging });
      try {
        const { project } = await archived();
        const kept = await archived("kept");
        expect((await q.send("DELETE", `/api/projects/${project.id}?archived=2`)).status).toBe(204);
        expect((await q.send("DELETE", `/api/projects/${kept.project.id}?discard=1`)).status).toBe(
          204,
        );
        expect(
          logged
            .filter(({ message }) => message === "a project was deleted")
            .map(({ said }) => said),
        ).toEqual([
          {
            project: project.id,
            user: w.userId,
            head: 2,
            bytes: expect.any(Number),
            repository: true,
            discarded: false,
            unusable: false,
            connections: 0,
          },
          {
            project: kept.project.id,
            user: w.userId,
            head: 2,
            bytes: expect.any(Number),
            repository: true,
            discarded: true,
            unusable: false,
            connections: 0,
          },
        ]);
      } finally {
        logging.stop();
      }
    });

    test("a repository that is gone keeps it: the platform knows, and the editor's numbers say nothing", async () => {
      const { project, repoId } = await archived("gone-known");
      w.github.deleteRepo(repoId);
      // The webhook tells the platform, and archiving pauses.
      expect((await p.deliver()).every((status) => status < 300)).toBe(true);
      await p.work();
      expect(await confirmed(w, project.id)).toMatchObject({ kind: "paused", reason: "gone" });
      expect(await linkOf(project.id)).toMatchObject({
        state: "paused",
        pauseReason: "gone",
        archivedSeq: 2,
      });
      const refused = await remove(project.id, "?archived=2");
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: "notArchived",
        head: 2,
        archivedSeq: 2,
        state: "paused",
        reason: "gone",
        archiving: false,
      });
      expect(await rowOf(project.id)).toBeDefined();
      // Only where people let it go.
      expect((await remove(project.id, "?discard=1")).status).toBe(204);
    });

    test("an archive people asked for that is not done yet keeps it: it is what finds a repository gone", async () => {
      const { project, repoId } = await archived("gone-unknown");
      // Deleted on GitHub, the webhook not here yet.
      w.github.deleteRepo(repoId);
      w.github.takeDeliveries();
      expect((await p.request("POST", `/api/projects/${project.id}/archive`)).status).toBe(202);
      const status = (await p.request("GET", `/api/projects/${project.id}/repository`)).json;
      expect(status).toMatchObject({ state: "ready", archiving: true, head: 2, archivedSeq: 2 });
      // The numbers say everything is there; the archive asked for has not looked yet.
      const waiting = await remove(project.id, "?archived=2");
      expect(waiting.status).toBe(409);
      expect(waiting.json).toEqual({ ...READY, archiving: true, head: 2, archivedSeq: 2 });
      // It looks, and finds the repository gone, and so does the next one, minutes on.
      await p.work();
      expect(await confirmed(w, project.id, "manual")).toMatchObject({ kind: "paused" });
      expect((await remove(project.id, "?archived=2")).json).toMatchObject({
        error: "notArchived",
        state: "paused",
        reason: "gone",
        archiving: true,
      });
      expect(await rowOf(project.id)).toBeDefined();

      // Where the repository is there, the archive asked for is done, and then it goes.
      const there = await archived("there");
      expect((await p.request("POST", `/api/projects/${there.project.id}/archive`)).status).toBe(
        202,
      );
      expect((await remove(there.project.id, "?archived=2")).json).toMatchObject({
        archiving: true,
      });
      await p.work();
      expect((await remove(there.project.id, "?archived=2")).status).toBe(204);
    });

    test("an archive that failed last keeps it until one goes as it should", async () => {
      const { project } = await archived();
      await t.db
        .update(projectRepos)
        .set({ failures: 2, nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(projectRepos.projectId, project.id));
      expect((await remove(project.id, "?archived=2")).json).toEqual({
        ...READY,
        head: 2,
        archivedSeq: 2,
        failures: 2,
      });
      await p.request("POST", `/api/projects/${project.id}/archive`);
      await p.work();
      expect((await remove(project.id, "?archived=2")).status).toBe(204);
    });

    test("files still on their way into the large file storage keep it, unless people let them go", async () => {
      const { project, repoId } = await archived("lfs-open");
      const upload = { userId: w.userId, projectId: project.id, repoId, size: 10 };
      await t.db.insert(lfsUploads).values([
        { ...upload, oid: "c".repeat(64), state: "received" },
        { ...upload, oid: "d".repeat(64), state: "receiving" },
        // Over, one way or another: nothing of these is on its way.
        { ...upload, oid: "e".repeat(64), state: "done" },
        { ...upload, oid: "f".repeat(64), state: "failed" },
      ]);
      for (const query of ["?archived=2", ""]) {
        const refused = await remove(project.id, query);
        expect(refused.status, query).toBe(409);
        expect(refused.json, query).toEqual(
          query === "" ? { error: "hasRepository" } : { error: "uploading", uploads: 2 },
        );
      }
      expect(
        await t.db.select().from(lfsUploads).where(eq(lfsUploads.projectId, project.id)),
      ).toHaveLength(4);
      // Pushed: it goes.
      await t.db
        .update(lfsUploads)
        .set({ state: "done" })
        .where(eq(lfsUploads.projectId, project.id));
      const done = await archived("lfs-done");
      await t.db
        .insert(lfsUploads)
        .values({ ...upload, projectId: done.project.id, oid: "a".repeat(64), state: "done" });
      expect((await remove(done.project.id, "?archived=2")).status).toBe(204);
      // Still on its way, and let go.
      await t.db
        .update(lfsUploads)
        .set({ state: "pushing" })
        .where(eq(lfsUploads.oid, "c".repeat(64)));
      expect((await remove(project.id, "?archived=2")).json).toEqual({
        error: "uploading",
        uploads: 1,
      });
      expect((await remove(project.id, "?discard=1")).status).toBe(204);
      expect(
        await t.db.select().from(lfsUploads).where(eq(lfsUploads.projectId, project.id)),
      ).toEqual([]);
    });

    test("deleting and an archive that lands on a repository linked meanwhile wait for each other: no failure comes of it", async () => {
      const project = await newProject(w);
      await edit(w, project, write("code/a.js", "a\n"));
      const repo = w.github.addRepo(w.person, { name: "dl", select: true });
      const holder = await connection(t);
      const linker = await connection(t);
      const lander = await connection(t);
      let landerError: { code?: string } | undefined;
      try {
        // Something holds the project's row without keeping a link from being made, as a change does.
        await holder.query("begin");
        await holder.query("select 1 from projects where id = $1 for no key update", [project.id]);
        const deleting = remove(project.id, "?archived=2");
        await untilHeldUp();
        // A repository is linked meanwhile...
        await linker.query(
          `insert into project_repos (project_id, installation_id, repo_id, owner_id, owner_login, name, branch, private, created_here, linked_at)
         values ($1, $2, $3, $4, $5, $6, 'main', true, true, now())`,
          [project.id, w.installation, repo.id, repo.owner.id, repo.owner.login, repo.name],
        );
        // ...and its first archive lands: the link first, then the project, as an archive does.
        await lander.query("begin");
        await lander.query(
          "update project_repos set archived_seq = greatest(archived_seq, 2) where project_id = $1",
          [project.id],
        );
        await holder.query("commit");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const landing = lander
          .query(
            "update projects set dirty_since = case when head <= 2 then null else now() end where id = $1",
            [project.id],
          )
          .then(() => lander.query("commit"))
          .catch(async (error: unknown) => {
            landerError = error as { code?: string };
            await lander.query("rollback");
          });
        const answer = await deleting;
        await landing;
        // Whichever the database let go: deleting looked again, and never failed.
        expect(answer.status).not.toBe(503);
        if (answer.status === 204) expect(landerError).toBeUndefined();
        else {
          expect(answer.json).toMatchObject({ error: "notArchived" });
          expect(await rowOf(project.id)).toBeDefined();
        }
        expect(landerError === undefined || landerError.code === "40P01").toBe(true);
      } finally {
        await holder.end();
        await linker.end();
        await lander.end();
      }
    });
  },
);
