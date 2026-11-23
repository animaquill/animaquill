import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { startJobs, type Jobs } from "../jobs.ts";
import { archives, projectRepos, projects, users } from "../schema.ts";
import {
  ARCHIVE_QUEUE,
  dueAt,
  enqueueArchive,
  isArchiveQueued,
  setUpArchiveQueues,
  takeDue,
  type ArchiveJob,
} from "./schedule.ts";

/**
 * When projects are archived: after five minutes without a change, or thirty of changes, and never
 * twice at once. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const MINUTE = 60_000;

describe.skipIf(!TEST_DATABASE)("what is due, on a database", () => {
  let t: TestDatabase;
  let w: World;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.query("truncate projects cascade");
    w = await world(t.db);
  });

  const project = async () => {
    const made = await newProject(w);
    await linkTo(w, made.id, w.github.addRepo(w.person, { name: `r${made.id}`, select: true }));
    return made;
  };
  const due = () => takeDue(t.db, w.time.now);

  test("five minutes after the last change, or thirty after the first, whatever comes in between", async () => {
    const idle = await project();
    const busy = await project();
    expect(await due()).toEqual([]);
    w.time.later(4 * MINUTE);
    await edit(w, busy, write("code/a.js", "1"));
    w.time.later(MINUTE + 1);
    // Quiet for five minutes now; busy changed a minute ago.
    expect(await due()).toEqual([idle.id]);
    for (let minute = 0; minute < 25; minute++) {
      w.time.later(MINUTE);
      await edit(w, busy, write("code/a.js", `${minute}`));
    }
    // Changes for thirty minutes in a row.
    expect((await due()).toSorted()).toEqual([busy.id, idle.id].toSorted());
  });

  test("not without changes, not while paused, not before the next try", async () => {
    const clean = await project();
    await t.db.update(projects).set({ dirtySince: null }).where(eq(projects.id, clean.id));
    const paused = await project();
    await t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "diverged", pausedAt: w.time.now })
      .where(eq(projectRepos.projectId, paused.id));
    const failing = await project();
    w.time.later(10 * MINUTE);
    await t.db
      .update(projectRepos)
      .set({ failures: 2, nextAttemptAt: new Date(w.time.now.getTime() + 3 * MINUTE) })
      .where(eq(projectRepos.projectId, failing.id));
    // Not linked at all.
    await newProject(w);
    expect(await due()).toEqual([]);
    w.time.later(3 * MINUTE);
    expect(await due()).toEqual([failing.id]);
  });

  test("a pause for what the project had ends once it changed, and only then", async () => {
    const broken = await project();
    const pausedAt = w.time.later(MINUTE);
    await t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "manifest", pausedAt, pausedSeq: 1 })
      .where(eq(projectRepos.projectId, broken.id));
    w.time.later(10 * MINUTE);
    expect(await due()).toEqual([]);
    expect(
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, broken.id)))[0],
    ).toMatchObject({ state: "paused" });
    await edit(w, broken, write("code/fix.js", "fixed"));
    w.time.later(6 * MINUTE);
    expect(await due()).toEqual([broken.id]);
    expect(
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, broken.id)))[0],
    ).toMatchObject({ state: "ready", pauseReason: null });
  });

  test("a project people asked to archive is due at once, also without changes, and archived as asked", async () => {
    const asked = await project();
    await t.db.update(projects).set({ dirtySince: null }).where(eq(projects.id, asked.id));
    expect(await due()).toEqual([]);
    await t.db
      .update(projectRepos)
      .set({ requestedAt: w.time.now, requestedBy: w.userId })
      .where(eq(projectRepos.projectId, asked.id));
    expect(await due()).toEqual([asked.id]);
    // The job the scan queues does what people asked for, as theirs.
    expect(await w.archiver().run(asked.id, "auto")).toMatchObject({ kind: "archived" });
    const [archive] = await t.db.select().from(archives).where(eq(archives.projectId, asked.id));
    expect(archive).toMatchObject({ kind: "first", byUser: w.userId });
    expect(
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, asked.id)))[0],
    ).toMatchObject({ requestedAt: null, requestedBy: null });
    expect(await due()).toEqual([]);
  });

  test("nothing of someone disabled, whose changes wait until they are enabled again", async () => {
    const theirs = await project();
    const asked = await project();
    await t.db
      .update(projectRepos)
      .set({ requestedAt: w.time.now, requestedBy: w.userId })
      .where(eq(projectRepos.projectId, asked.id));
    w.time.later(10 * MINUTE);
    await t.db.update(users).set({ disabledAt: w.time.now }).where(eq(users.id, w.userId));
    expect(await due()).toEqual([]);
    // A job in the queue from before, or a check after a push elsewhere, does nothing either.
    for (const each of [theirs, asked])
      expect(await w.archiver().run(each.id, "auto")).toEqual({ kind: "none" });
    expect(await w.archiver().run(theirs.id, "check")).toEqual({ kind: "none" });
    expect(await t.db.select().from(archives)).toEqual([]);
    const waiting = await t.db.select().from(projects).where(eq(projects.id, theirs.id));
    expect(waiting[0]!.dirtySince).not.toBeNull();
    // Enabled again, it goes on where it was.
    await t.db.update(users).set({ disabledAt: null }).where(eq(users.id, w.userId));
    expect((await due()).toSorted()).toEqual([asked.id, theirs.id].toSorted());
    expect(await w.archiver().run(theirs.id, "auto")).toMatchObject({ kind: "archived" });
  });

  test("says when the next archive is due, for people", () => {
    const at = new Date("2026-11-10T08:00:00Z");
    expect(dueAt(at, null, null)).toBeUndefined();
    expect(dueAt(at, new Date(at.getTime() - 28 * MINUTE), null)).toEqual(
      new Date(at.getTime() + 2 * MINUTE),
    );
    expect(dueAt(at, at, null)).toEqual(new Date(at.getTime() + 5 * MINUTE));
    expect(dueAt(at, at, new Date(at.getTime() + 9 * MINUTE))).toEqual(
      new Date(at.getTime() + 9 * MINUTE),
    );
  });
});

describe.skipIf(!TEST_DATABASE)("the queue of archives, on a database", () => {
  let t: TestDatabase;
  let jobs: Jobs;
  beforeAll(async () => {
    t = await createTestDatabase();
    jobs = await startJobs(t.config, quiet);
    await setUpArchiveQueues(jobs);
    // Twice is the same as once, as the API and the worker both do it.
    await setUpArchiveQueues(jobs);
  });
  afterAll(async () => {
    await jobs?.stop({ graceful: false });
    await t?.drop();
  });

  test("has a project waiting at most once, and knows when it is", async () => {
    expect(await isArchiveQueued(jobs, "p1")).toBe(false);
    await enqueueArchive(jobs, { project: "p1", kind: "auto" });
    await enqueueArchive(jobs, { project: "p1", kind: "manual", by: "someone" });
    await enqueueArchive(jobs, { project: "p2", kind: "first" });
    expect(await isArchiveQueued(jobs, "p1")).toBe(true);
    const waiting = await jobs.findJobs(ARCHIVE_QUEUE, { queued: true });
    expect(waiting.map((job) => (job.data as { project: string }).project).toSorted()).toEqual([
      "p1",
      "p2",
    ]);
    // One running and one waiting of the same project, at most.
    const [running] = await jobs.fetch<{ project: string }>(ARCHIVE_QUEUE, { batchSize: 1 });
    expect(running?.data.project).toBe("p1");
    await enqueueArchive(jobs, { project: "p1", kind: "auto" });
    await enqueueArchive(jobs, { project: "p1", kind: "auto" });
    const p1 = (await jobs.findJobs(ARCHIVE_QUEUE, { key: "p1" })).filter(
      (job) => job.state === "created" || job.state === "active",
    );
    expect(p1.map((job) => job.state).toSorted()).toEqual(["active", "created"]);
  });
});

describe.skipIf(!TEST_DATABASE)("a worker that died, on a database", () => {
  let t: TestDatabase;
  let jobs: Jobs;
  beforeAll(async () => {
    t = await createTestDatabase();
    jobs = await startJobs(t.config, quiet);
    await setUpArchiveQueues(jobs);
  });
  afterAll(async () => {
    await jobs?.stop({ graceful: false });
    await t?.drop();
  });

  test("does not hold up the next archive of its project for long", async () => {
    const queue = (await jobs.getQueue(ARCHIVE_QUEUE)) as unknown as {
      expireInSeconds: number;
      heartbeatSeconds: number | null;
      table: string;
    };
    expect(queue.expireInSeconds).toBeLessThanOrEqual(10 * 60);
    expect(queue.heartbeatSeconds).toBeGreaterThan(0);
    expect(queue.heartbeatSeconds!).toBeLessThanOrEqual(60);
    await enqueueArchive(jobs, { project: "dead", kind: "auto" });
    // Taken by a worker that is then killed: it never says anything again.
    const [taken] = await jobs.fetch(ARCHIVE_QUEUE, { batchSize: 1 });
    expect(taken).toBeDefined();
    await enqueueArchive(jobs, { project: "dead", kind: "manual", by: "someone" });
    expect(await jobs.fetch(ARCHIVE_QUEUE, { batchSize: 1 })).toEqual([]);
    // Longer than the queue waits for a word from it.
    await t.query(
      `update pgboss.${queue.table} set heartbeat_on = now() - interval '1 hour' where id = $1`,
      [taken!.id],
    );
    await jobs.supervise(ARCHIVE_QUEUE);
    const next = await jobs.fetch<{ kind: string }>(ARCHIVE_QUEUE, { batchSize: 1 });
    expect(next.map((job) => job.data.kind)).toEqual(["manual"]);
  });
});

describe.skipIf(!TEST_DATABASE)(
  "archives asked for while another job of the project waits, on a database",
  () => {
    let t: TestDatabase;
    let jobs: Jobs;
    let w: World;
    beforeAll(async () => {
      t = await createTestDatabase();
      jobs = await startJobs(t.config, quiet);
      await setUpArchiveQueues(jobs);
      w = await world(t.db);
    });
    afterAll(async () => {
      await jobs?.stop({ graceful: false });
      await t?.drop();
    });

    /** What the worker does: takes what waits, one at a time, and archives it. */
    const drain = async () => {
      const outcomes: string[] = [];
      for (;;) {
        const [job] = await jobs.fetch<ArchiveJob>(ARCHIVE_QUEUE, { batchSize: 1 });
        if (!job) return outcomes;
        const outcome = await w.archiver().run(job.data.project, job.data.kind, job.data.by);
        outcomes.push(`${job.data.kind}:${outcome.kind}`);
        await jobs.complete(ARCHIVE_QUEUE, job.id);
      }
    };

    test("archiving now while a check waits in the queue archives, with the queue of the worker", async () => {
      const p = await platform(w, {
        queue: {
          enqueue: (job) => enqueueArchive(jobs, job),
          isQueued: (project) => isArchiveQueued(jobs, project),
        },
      });
      const project = await newProject(w);
      await p.request("POST", `/api/projects/${project.id}/repository`, {
        create: { name: "queue" },
      });
      expect(await drain()).toEqual(["first:archived"]);
      await edit(w, project, write("code/a.js", "asked for\n"));
      // The first commit of the new repository came to the webhook: a check waits.
      await enqueueArchive(jobs, { project: project.id, kind: "check" });
      expect((await p.request("POST", `/api/projects/${project.id}/archive`)).status).toBe(202);
      await drain();
      const repo = [...w.github.repos.values()].find((each) => each.name === "queue")!;
      expect(w.github.files(repo.id).get("code/a.js")).toBe("asked for\n");
      const status = (await p.request("GET", `/api/projects/${project.id}/repository`)).json;
      expect(status).toMatchObject({ archiving: false, lastArchive: { kind: "manual" } });
    });
  },
);
