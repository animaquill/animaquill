import { accessGate, OWNER_ONLY } from "../access.ts";
import { SYNC_CLOSE, SYNC_PROTOCOL, framesOf } from "@animaquill/host/sync";
import { eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  Editor,
  edit,
  linkTo,
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
import { ORIGIN, platform, WEB, type Platform } from "../test/platform-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import type { Accounts } from "../auth/accounts.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { poolOf } from "../database.ts";
import { startJobs } from "../jobs.ts";
import {
  archives,
  deletedProjects,
  lfsUploads,
  projectRepos,
  projects,
  projectSnapshots,
  projectUpdates,
  users,
  type PauseReason,
} from "../schema.ts";
import { PROJECT_LOCK, SYNC_HUB_LIMITS, SyncHub } from "./hub.ts";
import { PROJECTS_SWEEP_QUEUE, scheduleProjectSweep } from "./sweep.ts";
import { attentionOf, STALE_MOST, STALE_MS } from "./list.ts";
import { projectRoutes } from "./routes.ts";
import { HOSTED_CREDENTIALS } from "../auth/credentials.ts";

/**
 * The projects of a person as the editor asks for them (the interface of 1A): the list people open
 * one from, with the repository each is saved to, and taking away one that is saved to none. On a
 * real PostgreSQL, the fake GitHub and a hub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe("what needs people, of a project in the list", () => {
  test("no repository, a pause, and what merging will say", () => {
    expect(attentionOf(undefined)).toBe("noRepository");
    expect(attentionOf({ state: "ready", pauseReason: null })).toBeUndefined();
    for (const reason of ["gone", "diverged", "transferred", "manifest", "protected"])
      expect(attentionOf({ state: "paused", pauseReason: reason }), reason).toBe("repository");
    expect(attentionOf({ state: "paused", pauseReason: null })).toBe("repository");
    expect(attentionOf({ state: "paused", pauseReason: "conflicts" })).toBe("conflicts");
    expect(attentionOf({ state: "paused", pauseReason: "blocked" })).toBe("blocked");
    // A reason left over from a pause that ended says nothing.
    expect(attentionOf({ state: "ready", pauseReason: "conflicts" })).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE)("the projects of a person through the API, on a database", () => {
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

  const list = async () => (await p.request("GET", "/api/projects")).json.projects as any[];
  const listed = async (id: string) => (await list()).find((project) => project.id === id);
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0];
  const pause = (id: string, reason: string) =>
    t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: reason as PauseReason })
      .where(eq(projectRepos.projectId, id));

  /** Every statement that goes to the database through the pool, while this is on. */
  const statements = () => {
    const pool = poolOf(t.db);
    const texts: string[] = [];
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
      const [first] = args;
      texts.push(typeof first === "string" ? first : ((first as { text?: string }).text ?? ""));
      return query(...args);
    }) as never);
    return { texts, stop: () => spy.mockRestore() };
  };

  /** How a window's connection closed, or undefined where it is still open a moment from now. */
  const closeOf = (peer: TestPeer) =>
    Promise.race([
      peer.connection.closed,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);

  /** A window that says hello for a project and brings its first version, to make it. */
  const makes = (id: string, userId = w.userId, name = "新建的") => {
    const editor = new Editor(name);
    const peer = new TestPeer(hub, { userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      generation: 1,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name, projectId: editor.projectId },
      payload: editor.store.encodeState(),
    });
    return peer;
  };

  /** The row that keeps the id of a project that was taken away. */
  const tombOf = async (id: string) =>
    (
      await t.db
        .select()
        .from(deletedProjects)
        .where(sql`${deletedProjects.id} = ${id}`)
    )[0];

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

  /** A window of the person connected to a project that is on the platform. */
  const connect = async (id: string, userId = w.userId) => {
    const peer = new TestPeer(hub, { userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    return peer;
  };

  test("lists each project with its repository, how far archiving got, and what needs people", async () => {
    // Saved to no repository yet.
    const bare = await newProject(w, new Editor("还没有仓库"));
    w.time.later(60_000);
    // Archived, with nothing waiting.
    const saved = await newProject(w, new Editor("存好了"));
    await p.request("POST", `/api/projects/${saved.id}/repository`, { create: { name: "saved" } });
    expect(await p.work()).toMatchObject([{ kind: "archived" }]);
    w.time.later(60_000);
    // Archived, and changed since.
    const behind = await newProject(w, new Editor("有新改动"));
    const open = w.github.addRepo(w.person, { name: "open", select: true, private: false });
    await linkTo(w, behind.id, open, false);
    expect(await w.archiver().run(behind.id, "first")).toMatchObject({ kind: "archived" });
    w.time.later(60_000);
    await edit(w, behind, write("code/a.js", "a\n"));

    const all = await list();
    expect(all.map((project) => project.name)).toEqual(["有新改动", "存好了", "还没有仓库"]);
    const bareRow = (await rowOf(bare.id))!;
    expect(all[2]).toEqual({
      id: bare.id,
      name: "还没有仓库",
      createdAt: bareRow.createdAt.getTime(),
      updatedAt: bareRow.updatedAt.getTime(),
      copy: "live",
      size: { documents: bareRow.bytes },
      attention: "noRepository",
    });
    const savedLink = (await linkOf(saved.id))!;
    const savedRow = (await rowOf(saved.id))!;
    expect(all[1]).toEqual({
      id: saved.id,
      name: "存好了",
      createdAt: savedRow.createdAt.getTime(),
      updatedAt: savedRow.updatedAt.getTime(),
      copy: "live",
      size: { documents: savedRow.bytes },
      repository: {
        id: savedLink.repoId,
        owner: w.person.login,
        name: "saved",
        fullName: `${w.person.login}/saved`,
        private: true,
        url: `${WEB}/${w.person.login}/saved`,
        state: "ready",
        checkedAt: savedLink.checkedAt!.getTime(),
      },
      archive: { at: savedLink.archivedAt!.getTime(), seq: 1, behind: false },
    });
    expect(all[0]).toMatchObject({
      id: behind.id,
      repository: { id: open.id, name: "open", private: false, state: "ready" },
      archive: { seq: 1, behind: true },
    });
    expect(all[0].attention).toBeUndefined();
    expect(all[0].archive.at).toBe((await linkOf(behind.id))!.archivedAt!.getTime());

    // A pause needs people; one for clashes or files that could not be taken in says which.
    await pause(saved.id, "gone");
    expect(await listed(saved.id)).toMatchObject({
      repository: { state: "paused", reason: "gone" },
      attention: "repository",
    });
    await pause(saved.id, "conflicts");
    expect((await listed(saved.id)).attention).toBe("conflicts");
    await pause(saved.id, "blocked");
    expect((await listed(saved.id)).attention).toBe("blocked");

    // Whether the working copy is here, and what an archive counted, once one does.
    await t.db
      .update(projects)
      .set({ copyState: "released", stats: { assets: { count: 3, bytes: 4096, elsewhere: 2 } } })
      .where(eq(projects.id, bare.id));
    expect(await listed(bare.id)).toMatchObject({
      copy: "released",
      size: { documents: bareRow.bytes, assets: { count: 3, bytes: 4096, elsewhere: 2 } },
    });
    // Counts that are none are not passed on.
    await t.db
      .update(projects)
      .set({ stats: { assets: { count: -1, bytes: 1, elsewhere: 0 } } })
      .where(eq(projects.id, bare.id));
    expect((await listed(bare.id)).size).toEqual({ documents: bareRow.bytes });

    // Only the person's own.
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    expect(await listed(theirs.id)).toBeUndefined();
    const nobody = await p.send("GET", "/api/projects", { signedIn: false });
    expect(nobody.status).toBe(401);
    expect(nobody.json).toEqual({ error: "signedOut" });
  });

  test("says what each project says about itself, where it says something", async () => {
    const plain = await newProject(w, new Editor("没有说明"));
    const described = await newProject(w, new Editor("有说明"));
    await t.db
      .update(projects)
      .set({ description: "一条讲原子的片子" })
      .where(eq(projects.id, described.id));
    expect((await listed(described.id))?.description).toBe("一条讲原子的片子");
    expect(await listed(plain.id)).not.toHaveProperty("description");
  });

  test("the list is one query of the projects, and reads no working copy", async () => {
    const projectsOf = [await newProject(w), await newProject(w), await newProject(w)];
    for (const project of projectsOf) await edit(w, project, write("code/a.js", "a\n"));
    const repo = w.github.addRepo(w.person, { name: "one", select: true });
    await linkTo(w, projectsOf[0]!.id, repo);
    const mark = w.github.calls.length;
    const seen = statements();
    let all: any[];
    try {
      all = await list();
    } finally {
      seen.stop();
    }
    expect(all).toHaveLength(3);
    // One statement names the projects, with their repositories; none reads what they are made of.
    const about = seen.texts.filter((text) => /\bfrom "projects"/.test(text));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/left join "project_repos"/);
    expect(seen.texts.filter((text) => /project_updates|project_snapshots/.test(text))).toEqual([]);
    // The hub knows none of them, and has no copy in memory.
    await hub.idle();
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });
    // Nor is GitHub asked for a list.
    expect(w.github.calls.length).toBe(mark);
  });

  test("has repositories nobody looked at for a day looked at again, a few at a time", async () => {
    const day = STALE_MS;
    const hour = 3600_000;
    // The archiver's clock is the one of the API here: a look notes the time that the list reads.
    w.time.now = new Date();
    const started = w.time.now.getTime();
    const linked: { id: string; name: string }[] = [];
    for (let index = 0; index < 7; index++) {
      const project = await newProject(w);
      const repo = w.github.addRepo(w.person, { name: `old-${index}`, select: true });
      await linkTo(w, project.id, repo);
      linked.push({ id: project.id, name: repo.name });
    }
    const at = (ms: number) => new Date(started - ms);
    const check = (id: string, checkedAt: Date | null) =>
      t.db.update(projectRepos).set({ checkedAt }).where(eq(projectRepos.projectId, id));
    // Never looked at; looked at long ago, and longer ago; and one looked at today.
    await check(linked[1]!.id, at(3 * day));
    await check(linked[2]!.id, at(5 * day));
    await check(linked[3]!.id, at(2 * day + 3 * hour));
    await check(linked[4]!.id, at(2 * day + 2 * hour));
    await check(linked[5]!.id, at(2 * day + hour));
    await check(linked[6]!.id, at(day - hour));
    // Not what a look would help: paused, waiting after a failure, or without a repository.
    const paused = await newProject(w);
    await linkTo(w, paused.id, w.github.addRepo(w.person, { name: "paused", select: true }));
    await pause(paused.id, "diverged");
    const failing = await newProject(w);
    await linkTo(w, failing.id, w.github.addRepo(w.person, { name: "failing", select: true }));
    await t.db
      .update(projectRepos)
      .set({ failures: 2, nextAttemptAt: new Date(started + hour) })
      .where(eq(projectRepos.projectId, failing.id));
    await newProject(w);
    // Nor one whose working copy is not here, which a look would have to read.
    const released = await newProject(w);
    await linkTo(w, released.id, w.github.addRepo(w.person, { name: "released", select: true }));
    await t.db.update(projects).set({ copyState: "released" }).where(eq(projects.id, released.id));

    expect(await list()).toHaveLength(11);
    // Those not looked at the longest first, and no more than a few.
    expect(p.queued).toEqual(
      [0, 2, 1, 3, 4].map((index) => ({ project: linked[index]!.id, kind: "check" })),
    );
    expect(p.queued).toHaveLength(STALE_MOST);
    // Asked again at once, as a start page that loads twice: nothing more for now.
    await list();
    expect(p.queued).toHaveLength(STALE_MOST);

    // Renamed on GitHub meanwhile, which nothing told the platform: the look finds out.
    const renamed = [...w.github.repos.values()].find((repo) => repo.name === "old-0")!;
    w.github.rename(renamed.id, "new-0");
    expect(w.github.takeDeliveries().filter(({ event }) => event === "repository")).toEqual([]);
    expect(await p.work()).toEqual(Array.from({ length: 5 }, () => ({ kind: "checked" })));
    expect((await linkOf(linked[0]!.id))!.checkedAt).not.toBeNull();

    // The next list, a minute on (here: another API) has them as they are, and the rest looked at.
    const later = await platform(w, { hub });
    const again = (await later.request("GET", "/api/projects")).json.projects as any[];
    expect(again.find((project) => project.id === linked[0]!.id).repository).toMatchObject({
      name: "new-0",
      fullName: `${w.person.login}/new-0`,
      url: `${WEB}/${w.person.login}/new-0`,
    });
    expect(later.queued).toEqual([{ project: linked[5]!.id, kind: "check" }]);
    await later.work();
    const last = await platform(w, { hub });
    await last.request("GET", "/api/projects");
    expect(last.queued).toEqual([]);
  });

  test("the list goes out also where the looks cannot be queued", async () => {
    const project = await newProject(w);
    await linkTo(w, project.id, w.github.addRepo(w.person, { name: "unlucky", select: true }));
    let asked = 0;
    const broken = await platform(w, {
      hub,
      queue: {
        enqueue: async () => {
          asked += 1;
          throw new Error("the queue is away");
        },
        isQueued: async () => false,
      },
    });
    const answer = await broken.request("GET", "/api/projects");
    expect(answer.status).toBe(200);
    expect(answer.json.projects).toMatchObject([
      { id: project.id, repository: { name: "unlucky" } },
    ]);
    expect(asked).toBe(1);
  });

  test("everyone together has repositories looked at again only a few times a minute", async () => {
    // The routes alone, with a clock of the test's, and what they ask to have looked at.
    let now = Date.now();
    const looked: string[][] = [];
    const people = new Map<string, string>();
    const accounts = {
      session: async (id: string) => {
        const userId = people.get(id);
        return userId === undefined ? undefined : { userId };
      },
    } as unknown as Accounts;
    const app = Fastify();
    await app.register(projectRoutes, {
      origin: ORIGIN,
      accounts: () => accounts,
      credentials: HOSTED_CREDENTIALS,
      db: () => t.db,
      hub: () => hub,
      webUrl: WEB,
      gate: accessGate(OWNER_ONLY, () => t.db),
      lookAgain: async (ids) => {
        looked.push([...ids]);
      },
      now: () => now,
    });
    // Eight people, each with a project whose repository nobody looked at yet.
    const stale: { session: string; project: string }[] = [];
    for (let index = 0; index < 8; index++) {
      const person = await world(t.db);
      const project = await newProject(person);
      const repo = person.github.addRepo(person.person, { name: `stale-${index}`, select: true });
      await linkTo(person, project.id, repo);
      const session = `a-session-of-person-${index}-0123456789`;
      people.set(session, person.userId);
      stale.push({ session, project: project.id });
    }
    const projectsOf = async (session: string) => {
      const answer = await app.inject({
        url: "/api/projects",
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
      });
      expect(answer.statusCode).toBe(200);
      return (answer.json() as { projects: { id: string }[] }).projects.map(({ id }) => id);
    };
    try {
      for (const each of stale.slice(0, 7))
        expect(await projectsOf(each.session)).toEqual([each.project]);
      // Six of them had theirs looked at. The seventh got the list, and no look: everyone's turns
      // of this minute are taken.
      expect(looked).toEqual(stale.slice(0, 6).map(({ project }) => [project]));
      // Nor does one who had a turn get another within the minute, whatever is left of everyone's.
      await projectsOf(stale[0]!.session);
      await projectsOf(stale[7]!.session);
      expect(looked).toHaveLength(6);
      // A minute on: turns again, also for the one who was left out, and six of them again.
      now += 60_000;
      await projectsOf(stale[6]!.session);
      expect(looked).toHaveLength(7);
      expect(looked[6]).toEqual([stale[6]!.project]);
      for (const each of stale.slice(0, 6)) await projectsOf(each.session);
      expect(looked).toHaveLength(12);
      await projectsOf(stale[7]!.session);
      expect(looked).toHaveLength(12);
    } finally {
      await app.close();
    }
  });

  test("takes away a project that has no repository, with everything the platform kept of it", async () => {
    /** What the platform's log gets told, as its own lines of JSON would have it. */
    const logged: { readonly said: object; readonly message: string | undefined }[] = [];
    const log = {
      ...quiet,
      info: (said: object, message?: string) => void logged.push({ said, message }),
    };
    const hubOfSmall = new SyncHub({ db: t.db, log, limits: { compactUpdates: 2 } });
    const small = await platform(w, { hub: hubOfSmall });
    const editor = new Editor("不要了");
    const id = `gone${Date.now().toString(36)}`;
    const peer = new TestPeer(hubOfSmall, { userId: w.userId, session: "s" });
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name: "不要了", projectId: editor.projectId },
      payload: editor.store.encodeState(),
    });
    await peer.until(() => peer.of("synced").length > 0, "synced");
    for (let index = 1; index <= 3; index++) {
      peer.send({
        t: "push",
        id: index,
        kind: "user",
        base: index,
        at: Date.now(),
        window: "w1",
        behind: false,
        payload: editor.change(write("code/a.js", `${index}\n`)),
      });
      await peer.until(() => peer.of("ack").length === index, "an ack");
    }
    const count = async () => ({
      updates: (await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, id)))
        .length,
      snapshots: (
        await t.db.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, id))
      ).length,
    });
    expect((await count()).updates).toBeGreaterThan(0);
    expect((await count()).snapshots).toBeGreaterThan(0);
    const other = await newProject(w);

    const deleted = await small.send("DELETE", `/api/projects/${id}`);
    expect(deleted.status).toBe(204);
    expect(await rowOf(id)).toBeUndefined();
    expect(await count()).toEqual({ updates: 0, snapshots: 0 });
    // Only that one.
    expect(await rowOf(other.id)).toBeDefined();
    expect((await small.request("GET", "/api/projects")).json.projects).toMatchObject([
      { id: other.id },
    ]);
    // The log of the platform says who took what away and how much there was of it, and nothing
    // of what was in it: not even what it was called.
    const lines = logged.filter(({ message }) => message === "a project was deleted");
    expect(lines).toEqual([
      {
        said: {
          project: id,
          user: w.userId,
          head: 4,
          bytes: expect.any(Number),
          repository: false,
          discarded: false,
          unusable: false,
          connections: 1,
        },
        message: "a project was deleted",
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain("不要了");
    // Again: there is none.
    const again = await small.send("DELETE", `/api/projects/${id}`);
    expect(again.status).toBe(404);
    expect(again.json).toEqual({ error: "notFound" });
    expect(logged.filter(({ message }) => message === "a project was deleted")).toHaveLength(1);
    hubOfSmall.stop();
  });

  test("never takes away a project that has a repository", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    await p.request("POST", `/api/projects/${project.id}/repository`, { create: { name: "kept" } });
    await p.work();
    const refused = await p.send("DELETE", `/api/projects/${project.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "hasRepository" });
    // Also one whose archiving is paused, as when the repository is gone.
    await pause(project.id, "gone");
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).json).toEqual({
      error: "hasRepository",
    });
    expect(await rowOf(project.id)).toBeDefined();
    expect(await linkOf(project.id)).toBeDefined();
    expect(
      await t.db.select().from(projectUpdates).where(eq(projectUpdates.projectId, project.id)),
    ).toHaveLength(2);
    expect(
      await t.db.select().from(archives).where(eq(archives.projectId, project.id)),
    ).toHaveLength(1);
    // And its windows stay connected.
    const peer = await connect(project.id);
    await p.send("DELETE", `/api/projects/${project.id}`);
    await hub.idle();
    expect(peer.closedWith).toBeUndefined();
    expect(hub.size).toMatchObject({ connections: 1, projects: 1 });
  });

  test("closes the windows of a project as it goes, and none gets it afterwards", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const first = await connect(project.id);
    const second = await connect(project.id);
    expect(hub.size).toMatchObject({ connections: 2, projects: 1 });
    // The working copy is in memory: one of them compared with the platform.
    first.send({ t: "check" });
    await first.until(() => first.of("checked").length > 0, "checked");
    expect(hub.size.open).toBe(1);

    const deleted = await p.send("DELETE", `/api/projects/${project.id}`);
    expect(deleted.status).toBe(204);
    // Both heard that the project is not there any more, which is what stops an editor: by the
    // time the answer is out, not some time later.
    expect((await closeOf(first))?.code).toBe(SYNC_CLOSE.deleted);
    expect((await closeOf(second))?.code).toBe(SYNC_CLOSE.deleted);
    await hub.idle();
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });
    // A window that comes for it now finds none, whatever it had of it.
    const late = await connect(project.id);
    expect(late.closedWith?.code).toBe(SYNC_CLOSE.deleted);
    expect(late.received).toEqual([]);
  });

  test("a project that was taken away is not made again for a week, whoever asks", async () => {
    // Made by a window, as connecting a project does, and taken away.
    const id = `tomb${Date.now().toString(36)}`;
    const first = makes(id);
    await first.until(() => first.of("synced").length > 0, "synced");
    expect((await rowOf(id))!.ownerId).toBe(w.userId);
    const before = Date.now();
    expect((await p.send("DELETE", `/api/projects/${id}`)).status).toBe(204);
    expect((await closeOf(first))?.code).toBe(SYNC_CLOSE.deleted);
    // Its id is kept, with whose it was and when, and nothing of what was in it.
    const tomb = (await tombOf(id))!;
    expect(Object.keys(tomb).toSorted()).toEqual(["deletedAt", "id", "ownerId"]);
    expect(tomb).toMatchObject({ id, ownerId: w.userId });
    expect(tomb.deletedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // The request to make it that was still on its way, or a window that kept its note to make
    // it: no such project, which stops an editor, and none is made.
    const late = makes(id);
    expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.deleted);
    expect(late.received).toEqual([]);
    expect(await rowOf(id)).toBeUndefined();
    // Nor for anyone else who has the id.
    const someone = await world(t.db);
    const theirs = makes(id, someone.userId);
    expect((await closeOf(theirs))?.code).toBe(SYNC_CLOSE.missing);
    expect(await rowOf(id)).toBeUndefined();
    // Nor after the platform started again: it is the database that remembers.
    const restarted = new SyncHub({ db: t.db, log: quiet });
    const again = new TestPeer(restarted, { userId: w.userId, session: "s" });
    const editor = new Editor("再来一次");
    again.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name: "再来一次", projectId: editor.projectId },
      payload: editor.store.encodeState(),
    });
    expect((await closeOf(again))?.code).toBe(SYNC_CLOSE.deleted);
    restarted.stop();
    expect(await rowOf(id)).toBeUndefined();
    await hub.idle();
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });
    // Taking it away again: there is none.
    const twice = await p.send("DELETE", `/api/projects/${id}`);
    expect(twice.status).toBe(404);
    expect(twice.json).toEqual({ error: "notFound" });
    expect(
      await t.db
        .select()
        .from(deletedProjects)
        .where(sql`${deletedProjects.id} = ${id}`),
    ).toHaveLength(1);

    // An id nobody took away is made as ever, as every new connection of a project has one.
    const other = makes(`${id}b`);
    await other.until(() => other.of("synced").length > 0, "synced");
    expect(await rowOf(`${id}b`)).toBeDefined();
    // A project that is not taken away leaves no such row: one with a repository, someone else's.
    const kept = await newProject(w);
    await linkTo(w, kept.id, w.github.addRepo(w.person, { name: "kept", select: true }));
    await p.send("DELETE", `/api/projects/${kept.id}`);
    const notMine = await newProject(someone);
    await p.send("DELETE", `/api/projects/${notMine.id}`);
    expect(await tombOf(kept.id)).toBeUndefined();
    expect(await tombOf(notMine.id)).toBeUndefined();

    // The ids go with their person, and with nobody else.
    const leaving = await world(t.db);
    const leavingApp = await platform(leaving, { hub });
    const gone = await newProject(leaving);
    expect((await leavingApp.send("DELETE", `/api/projects/${gone.id}`)).status).toBe(204);
    expect(await tombOf(gone.id)).toBeDefined();
    await t.db.delete(users).where(sql`${users.id} = ${leaving.userId}`);
    expect(await tombOf(gone.id)).toBeUndefined();
    expect(await tombOf(id)).toBeDefined();
  });

  test("a project that is taken away before it was made is not made either: its id is noted all the same", async () => {
    // The editor gave up connecting a project, and asks to take away what is not there yet: the
    // request that makes it is still on its way.
    const id = `early${Date.now().toString(36)}`;
    const early = await p.send("DELETE", `/api/projects/${id}`);
    expect(early.status).toBe(404);
    expect(early.json).toEqual({ error: "notFound" });
    // Noted, as whoever asked's.
    expect(await tombOf(id)).toMatchObject({ id, ownerId: w.userId });
    // The whole request comes late: none is made.
    const late = makes(id);
    expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.deleted);
    expect(late.received).toEqual([]);
    expect(await rowOf(id)).toBeUndefined();
    // Nor for anyone else who says so with that id, as the window may be signed in as another.
    const someone = await world(t.db);
    const theirs = makes(id, someone.userId);
    expect((await closeOf(theirs))?.code).toBe(SYNC_CLOSE.missing);
    expect(await rowOf(id)).toBeUndefined();
    // Asked once more: the same answer, and noted once.
    expect((await p.send("DELETE", `/api/projects/${id}`)).status).toBe(404);
    expect(
      await t.db
        .select()
        .from(deletedProjects)
        .where(sql`${deletedProjects.id} = ${id}`),
    ).toHaveLength(1);

    // A first version that goes in parts: the first is in when the editor gives up, and the rest
    // arrives afterwards, as a browser sends what was queued also once the socket is closing.
    const parted = `${id}p`;
    const editor = new Editor("取消了的");
    editor.change(write("code/big.js", `// ${"x".repeat(700_000)}\n`));
    const frames = framesOf({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: parted,
      after: 0,
      generation: 1,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name: "取消了的", projectId: editor.projectId },
      payload: editor.store.encodeState(),
    });
    expect(frames.length).toBeGreaterThan(1);
    const peer = new TestPeer(hub, { userId: w.userId, session: "s" });
    peer.sendBytes(frames[0]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hub.idle();
    const cancelled = await p.send("DELETE", `/api/projects/${parted}`);
    expect(cancelled.status).toBe(404);
    expect(cancelled.json).toEqual({ error: "notFound" });
    for (const frame of frames.slice(1)) peer.sendBytes(frame);
    await peer.until(
      () => peer.closedWith !== undefined || peer.of("synced").length > 0,
      "an answer to the hello",
    );
    expect(peer.closedWith?.code).toBe(SYNC_CLOSE.deleted);
    expect(peer.received).toEqual([]);
    await hub.idle();
    expect(await rowOf(parted)).toBeUndefined();
    const after = (await p.request("GET", "/api/projects")).json.projects as { id: string }[];
    expect(after.map((project) => project.id)).toEqual([]);
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });

    // What is someone else's is not noted: it is there, and theirs to keep or take away.
    const kept = await newProject(someone);
    const refused = await p.send("DELETE", `/api/projects/${kept.id}`);
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: "notFound" });
    expect(await tombOf(kept.id)).toBeUndefined();
    expect(await rowOf(kept.id)).toBeDefined();
    // Nor what could not be the id of a project.
    const before = await t.db.select().from(deletedProjects);
    for (const wrong of ["a%20b", "x".repeat(65), "%E9%A1%B9%E7%9B%AE"]) {
      expect((await p.send("DELETE", `/api/projects/${wrong}`)).status, wrong).toBe(404);
    }
    expect(await t.db.select().from(deletedProjects)).toHaveLength(before.length);
  });

  test("ids that never were projects are noted only so many a day for each person; projects taken away always are", async () => {
    const warned: { readonly said: object; readonly message: string | undefined }[] = [];
    const log = {
      ...quiet,
      warn: (said: object, message?: string) => void warned.push({ said, message }),
    };
    const counting = new SyncHub({ db: t.db, log, limits: { notedIdsPerDay: 3 } });
    const app = await platform(w, { hub: counting });
    const stamp = Date.now().toString(36);
    const never = (index: number) => `never${stamp}n${index}`;
    try {
      // As many as a person gets noted in a day.
      for (const index of [1, 2, 3]) {
        expect((await app.send("DELETE", `/api/projects/${never(index)}`)).status).toBe(404);
        expect(await tombOf(never(index))).toMatchObject({ ownerId: w.userId });
      }
      expect(warned).toEqual([]);
      // One more: the same answer, and not noted, which the log of the platform says, without
      // what was asked for.
      const more = await app.send("DELETE", `/api/projects/${never(4)}`);
      expect(more.status).toBe(404);
      expect(more.json).toEqual({ error: "notFound" });
      expect(await tombOf(never(4))).toBeUndefined();
      expect(warned).toEqual([
        { said: { user: w.userId }, message: "too many ids noted as deleted in a day" },
      ]);
      // Someone else is not held to what this person used up.
      const someone = await world(t.db);
      const theirs = await platform(someone, { hub: counting });
      expect((await theirs.send("DELETE", `/api/projects/${never(5)}`)).status).toBe(404);
      expect(await tombOf(never(5))).toMatchObject({ ownerId: someone.userId });
      // A project that is there and is taken away is always noted, whatever was noted before.
      const real = await newProject(w);
      expect((await app.send("DELETE", `/api/projects/${real.id}`)).status).toBe(204);
      expect(await tombOf(real.id)).toMatchObject({ ownerId: w.userId });
      const late = new TestPeer(counting, { userId: w.userId, session: "s" });
      late.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: real.id,
        after: 0,
        generation: 1,
        device: "d1",
        window: "w1",
        editor: "test",
        create: { name: "再来", projectId: real.editor.projectId },
        payload: real.editor.store.encodeState(),
      });
      expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.deleted);
      // A day on, what was noted then counts no more.
      await t.db
        .update(deletedProjects)
        .set({ deletedAt: new Date(Date.now() - 24 * 3600_000 - 60_000) })
        .where(eq(deletedProjects.ownerId, w.userId));
      expect((await app.send("DELETE", `/api/projects/${never(4)}`)).status).toBe(404);
      expect(await tombOf(never(4))).toMatchObject({ ownerId: w.userId });
    } finally {
      counting.stop();
    }
  });

  test("the id of a project taken away is kept a week: after that it is made again, and the daily sweep forgets only what is older", async () => {
    const kept = SYNC_HUB_LIMITS.deletedKeptMs;
    /** Notes the id as taken away so long ago. */
    const noted = (id: string, ago: number) =>
      t.db
        .update(deletedProjects)
        .set({ deletedAt: new Date(Date.now() - ago) })
        .where(eq(deletedProjects.id, id));
    expect(kept).toBe(7 * 24 * 3600_000);

    // Made and taken away: a day short of the week, nothing is made under it, as ever.
    const id = `week${Date.now().toString(36)}`;
    const first = makes(id);
    await first.until(() => first.of("synced").length > 0, "synced");
    expect((await p.send("DELETE", `/api/projects/${id}`)).status).toBe(204);
    expect((await closeOf(first))?.code).toBe(SYNC_CLOSE.deleted);
    await noted(id, kept - 24 * 3600_000);
    const early = makes(id);
    expect((await closeOf(early))?.code).toBe(SYNC_CLOSE.deleted);
    expect(await rowOf(id)).toBeUndefined();
    // A week on, the id counts for nothing, also before the sweep: the project is made again.
    await noted(id, kept + 60_000);
    const again = makes(id);
    await again.until(() => again.of("synced").length > 0, "synced");
    expect((await rowOf(id))!.ownerId).toBe(w.userId);
    // Taken away once more: noted from now, and kept a week again.
    const before = Date.now();
    expect((await p.send("DELETE", `/api/projects/${id}`)).status).toBe(204);
    expect((await closeOf(again))?.code).toBe(SYNC_CLOSE.deleted);
    expect((await tombOf(id))!.deletedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const late = makes(id);
    expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.deleted);
    expect(await rowOf(id)).toBeUndefined();

    // An id that never was a project: the same, and asking again after the week notes it again.
    const never = `${id}n`;
    expect((await p.send("DELETE", `/api/projects/${never}`)).status).toBe(404);
    await noted(never, kept + 60_000);
    const someone = await world(t.db);
    const theirs = await platform(someone, { hub });
    expect((await theirs.send("DELETE", `/api/projects/${never}`)).status).toBe(404);
    expect(await tombOf(never)).toMatchObject({ ownerId: someone.userId });
    const refused = makes(never);
    expect((await closeOf(refused))?.code).toBe(SYNC_CLOSE.missing);
    await noted(never, kept + 60_000);
    const made = makes(never);
    await made.until(() => made.of("synced").length > 0, "synced");
    expect(await rowOf(never)).toBeDefined();

    // The sweep: only what is older than the week goes.
    const young = `${id}y`;
    const almost = `${id}a`;
    const old = `${id}o`;
    for (const each of [young, almost, old])
      expect((await p.send("DELETE", `/api/projects/${each}`)).status).toBe(404);
    await noted(almost, kept - 60_000);
    await noted(old, kept + 60_000);
    expect(await hub.forgetDeleted()).toBeGreaterThanOrEqual(2);
    expect(await tombOf(old)).toBeUndefined();
    // The id of the project made again, whose note was older too.
    expect(await tombOf(never)).toBeUndefined();
    expect(await tombOf(young)).toBeDefined();
    expect(await tombOf(almost)).toBeDefined();
    expect(await tombOf(id)).toBeDefined();
    expect(await hub.forgetDeleted()).toBe(0);
  });

  test("the sweep of old ids runs every hour in the job queue, and what fails there is only logged", async () => {
    const jobs = await startJobs(t.config, quiet);
    const warned: string[] = [];
    const log = { ...quiet, warn: (_said: object, message?: string) => void warned.push(message!) };
    try {
      let runs = 0;
      await scheduleProjectSweep(jobs, {
        db: t.db,
        hub: {
          remove: async () => "missing",
          forgetDeleted: async () => {
            runs += 1;
            throw new Error("the database went away");
          },
        },
        log,
        recheck: undefined,
        // Nothing in the database is old by then: the projects of the other tests are dated by
        // the clock of the tests, and the sweep says those of three days ago, by the real one.
        now: () => new Date(0),
      });
      const [schedule] = await jobs.getSchedules(PROJECTS_SWEEP_QUEUE);
      expect(schedule?.cron).toBe("43 * * * *");
      await jobs.send(PROJECTS_SWEEP_QUEUE, {});
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the sweep sets it meanwhile
      for (let turn = 0; turn < 300 && runs === 0; turn++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      for (let turn = 0; turn < 100 && warned.length === 0; turn++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runs).toBe(1);
      expect(warned).toEqual(["ids of deleted projects were not forgotten"]);
    } finally {
      await jobs.stop({ graceful: false });
    }
  });

  test("what points at a project goes with it, by an index of its own, and nothing of another project does", async () => {
    const project = await newProject(w);
    const other = await newProject(w);
    const upload = { userId: w.userId, repoId: 424242, size: 10, state: "done" as const };
    await t.db.insert(lfsUploads).values([
      { ...upload, projectId: project.id, oid: "a".repeat(64) },
      { ...upload, projectId: other.id, oid: "b".repeat(64) },
    ]);
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    const uploads = await t.db.select().from(lfsUploads).where(eq(lfsUploads.userId, w.userId));
    expect(uploads.map((each) => each.projectId)).toEqual([other.id]);
    // Each of them is found by the project, not by reading the whole table; and what was noted
    // of a person in the last day is counted the same way.
    const indexes = await t.query(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1) order by indexname",
      [["deleted_projects_owner", "lfs_uploads_project"]],
    );
    expect(
      indexes.rows.map((row: { indexname: string; indexdef: string }) => [
        row.indexname,
        /\((.*)\)$/.exec(row.indexdef)?.[1],
      ]),
    ).toEqual([
      ["deleted_projects_owner", "owner_id, deleted_at"],
      ["lfs_uploads_project", "project_id"],
    ]);
  });

  test("a window that says hello while its project is taken away waits, and finds it gone", async () => {
    const project = await newProject(w);
    const connected = await connect(project.id);
    // Taking it away is held up half way: something else holds its row for a moment.
    const holding = await connection(t);
    let deleting: ReturnType<Platform["send"]>;
    let answered = false;
    try {
      await holding.query("begin");
      await holding.query("select 1 from projects where id = $1 for update", [project.id]);
      deleting = p.send("DELETE", `/api/projects/${project.id}`).then((answer) => {
        answered = true;
        return answer;
      });
      await untilHeldUp();
      // Meanwhile two windows say hello for it: one that has it, and one that brings its first
      // version to make it, as a window whose note says so.
      const without = new TestPeer(hub, { userId: w.userId, session: "s" });
      without.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: project.id,
        after: 1,
        generation: 1,
        device: "d2",
        window: "w2",
        editor: "test",
        payload: new Uint8Array(0),
      });
      const withCreate = makes(project.id);
      // Neither is answered while the project goes: not connected to it, and not turned away.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(answered).toBe(false);
      for (const peer of [without, withCreate]) {
        expect(peer.received).toEqual([]);
        expect(peer.closedWith).toBeUndefined();
      }
      expect(connected.closedWith).toBeUndefined();
      await holding.query("rollback");

      expect((await deleting).status).toBe(204);
      // Then both find it gone, and so does the window that was connected.
      expect((await closeOf(without))?.code).toBe(SYNC_CLOSE.deleted);
      expect((await closeOf(withCreate))?.code).toBe(SYNC_CLOSE.deleted);
      expect((await closeOf(connected))?.code).toBe(SYNC_CLOSE.deleted);
      expect(without.received).toEqual([]);
      expect(withCreate.received).toEqual([]);
    } finally {
      await holding.end();
    }
    await hub.idle();
    // Nothing brought it back, and no connection is left with it.
    expect(await rowOf(project.id)).toBeUndefined();
    expect(
      await t.db
        .select()
        .from(projectUpdates)
        .where(sql`${projectUpdates.projectId} = ${project.id}`),
    ).toEqual([]);
    expect(await tombOf(project.id)).toMatchObject({ ownerId: w.userId });
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });
  });

  test("no project is made while its id is being noted as taken away: one of the two waits for the other", async () => {
    // As a deletion that has taken the rows away and noted the id, and has not ended yet: it
    // holds the id, as the platform's own does.
    const id = `race${Date.now().toString(36)}`;
    const deleting = await connection(t);
    let late: TestPeer;
    try {
      await deleting.query("begin");
      await deleting.query("select pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_LOCK, id]);
      await deleting.query("insert into deleted_projects (id, owner_id) values ($1, $2)", [
        id,
        w.userId,
      ]);
      // A window makes a project of that id now: nothing says yet that it was taken away.
      late = makes(id);
      await untilHeldUp();
      expect(late.closedWith).toBeUndefined();
      expect(late.received).toEqual([]);
      await deleting.query("commit");
    } finally {
      await deleting.end();
    }
    // It waited, and then saw: none is made.
    expect((await closeOf(late))?.code).toBe(SYNC_CLOSE.deleted);
    expect(late.received).toEqual([]);
    await hub.idle();
    expect(await rowOf(id)).toBeUndefined();
    expect(hub.size).toEqual({ connections: 0, projects: 0, open: 0 });

    // The other way round: a project is being made, and taking it away waits for that, and then
    // takes it away. Never both a project and the note that it is gone.
    const other = `race${Date.now().toString(36)}b`;
    const making = await connection(t);
    try {
      await making.query("begin");
      await making.query("select pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_LOCK, other]);
      await making.query(
        `insert into projects (id, owner_id, project_id, name, head, digest)
         values ($1, $2, 'made-elsewhere', '别处建的', 0, '')`,
        [other, w.userId],
      );
      let answered = false;
      const removing = p.send("DELETE", `/api/projects/${other}`).then((answer) => {
        answered = true;
        return answer;
      });
      await untilHeldUp();
      expect(answered).toBe(false);
      await making.query("commit");
      expect((await removing).status).toBe(204);
    } finally {
      await making.end();
    }
    expect(await rowOf(other)).toBeUndefined();
    expect(await tombOf(other)).toBeDefined();
  });

  // Something of the database that will not let the row go, as nothing of the platform's does:
  // at once, as the row is taken away, or only as the transaction ends.
  test.each([
    ["as it is taken away", ""],
    ["only as taking it away ends", " deferrable initially deferred"],
  ])(
    "a project that cannot be taken away stays as it was, with its windows (%s)",
    async (_when, deferred) => {
      const project = await newProject(w);
      const peer = await connect(project.id);
      await t.query(
        `create table keeps_projects (project_id text references projects (id)${deferred})`,
      );
      try {
        await t.query("insert into keeps_projects values ($1)", [project.id]);
        const failed = await p.send("DELETE", `/api/projects/${project.id}`);
        expect(failed.status).toBe(503);
        expect(failed.json).toEqual({ error: "unavailable" });
        // Nothing happened: the project is there, its id is not noted, and its window was told
        // nothing.
        expect(await rowOf(project.id)).toBeDefined();
        expect(await tombOf(project.id)).toBeUndefined();
        expect(await closeOf(peer)).toBeUndefined();
        await hub.idle();
        expect(hub.size).toMatchObject({ connections: 1, projects: 1 });
        // And the window goes on as before.
        peer.send({
          t: "push",
          id: 1,
          kind: "user",
          base: 1,
          at: Date.now(),
          window: "w1",
          behind: false,
          payload: project.editor.change(write("code/a.js", "still here\n")),
        });
        await peer.until(() => peer.of("ack").length === 1, "an ack");
      } finally {
        await t.query("drop table keeps_projects");
      }
      // Once nothing keeps it: gone, and the window hears so.
      expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
      expect((await closeOf(peer))?.code).toBe(SYNC_CLOSE.deleted);
      expect(await rowOf(project.id)).toBeUndefined();
    },
  );

  test("a project of someone else is not there to take away, nor is one without the page of the editor", async () => {
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    const peer = await connect(theirs.id, someone.userId);
    const refused = await p.send("DELETE", `/api/projects/${theirs.id}`);
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: "notFound" });
    expect(await rowOf(theirs.id)).toBeDefined();
    await hub.idle();
    expect(peer.closedWith).toBeUndefined();
    // Theirs is not noted as taken away either: it is there.
    expect(await tombOf(theirs.id)).toBeUndefined();
    // One that is not there is none, and its id is noted, as it may be on its way.
    const absent = `absent${Date.now().toString(36)}`;
    const none = await p.send("DELETE", `/api/projects/${absent}`);
    expect(none.status).toBe(404);
    expect(none.json).toEqual({ error: "notFound" });
    expect(await tombOf(absent)).toMatchObject({ ownerId: w.userId });
    // Nor what could not name a project at all, of which nothing is noted.
    for (const wrong of ["a%20b", "x".repeat(65), "%E9%A1%B9%E7%9B%AE"]) {
      const answer = await p.send("DELETE", `/api/projects/${wrong}`);
      expect(answer.status, wrong).toBe(404);
      expect(answer.json, wrong).toEqual({ error: "notFound" });
    }

    const mine = await newProject(w);
    const elsewhere = await p.send("DELETE", `/api/projects/${mine.id}`, { fromHere: false });
    expect(elsewhere.status).toBe(403);
    const forged = await p.send("DELETE", `/api/projects/${mine.id}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    const nobody = await p.send("DELETE", `/api/projects/${mine.id}`, { signedIn: false });
    expect(nobody.status).toBe(401);
    expect(nobody.json).toEqual({ error: "signedOut" });
    expect(await rowOf(mine.id)).toBeDefined();
    // Without the hub, as before the platform is ready: not now.
    const unready = await platform(w);
    const waits = await unready.send("DELETE", `/api/projects/${mine.id}`);
    expect(waits.status).toBe(503);
    expect(waits.json).toEqual({ error: "unavailable" });
    expect(await rowOf(mine.id)).toBeDefined();
  });

  test("a repository linked at the same moment keeps its project: the row that came first decides", async () => {
    const project = await newProject(w);
    const repo = w.github.addRepo(w.person, { name: "racing", select: true });
    // Linking has put its row in, and not said so yet: as its transaction stands before it ends.
    const linking = await connection(t);
    try {
      await linking.query("begin");
      await linking.query(
        `insert into project_repos
           (project_id, installation_id, repo_id, owner_id, owner_login, name, branch, private, created_here)
         values ($1, $2, $3, $4, $5, $6, 'main', true, false)`,
        [project.id, w.installation, repo.id, w.person.id, w.person.login, repo.name],
      );
      let answered = false;
      const deleting = p.send("DELETE", `/api/projects/${project.id}`).then((answer) => {
        answered = true;
        return answer;
      });
      // Deleting waits for it: nothing is decided on what is not known yet.
      for (let turn = 0; turn < 200; turn++) {
        const waiting = await t.query(
          "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (waiting.rows[0].waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(answered).toBe(false);
      await linking.query("commit");
      const refused = await deleting;
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({ error: "hasRepository" });
    } finally {
      await linking.end();
    }
    expect(await rowOf(project.id)).toBeDefined();
    expect((await linkOf(project.id))!.repoId).toBe(repo.id);
  });

  test("a project deleted while its repository is being made keeps it: no repository is left for nobody", async () => {
    const project = await newProject(w);
    // GitHub takes its time to make the repository, and people give up on the project meanwhile.
    let reached!: () => void;
    const atGitHub = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.intercept(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const answer = await w.github.fetch(input, init);
      if (url.pathname === "/api/user/repos" && init?.method === "POST") {
        reached();
        await held;
      }
      return answer;
    });
    const linking = p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "too-late" },
    });
    await atGitHub;
    // Held for the link, which nothing of the database waits for: it has a repository, as far as
    // anyone is to know, and the editor keeps it, see R3 of the review.
    const deleted = await p.send("DELETE", `/api/projects/${project.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.json).toEqual({ error: "hasRepository" });
    release();
    const linked = await linking;
    expect(linked.status).toBe(201);
    const repo = [...w.github.repos.values()].find((each) => each.name === "too-late")!;
    expect(await rowOf(project.id)).toBeDefined();
    expect((await linkOf(project.id))?.repoId).toBe(repo.id);
    expect(p.queued).toEqual([{ project: project.id, kind: "first", by: w.userId }]);
  });

  test("a project deleted before its repository is made is not linked, and nothing is made for it", async () => {
    const project = await newProject(w);
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    const made = w.github.repos.size;
    const linked = await p.request("POST", `/api/projects/${project.id}/repository`, {
      create: { name: "never" },
    });
    expect(linked.status).toBe(404);
    expect(linked.json).toEqual({ error: "notFound" });
    expect(w.github.repos.size).toBe(made);
    expect(p.queued).toEqual([]);
  });
});
