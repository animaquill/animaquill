import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { REBUILD_QUEUE, enqueueRebuild } from "./archive/rebuild.ts";
import { ARCHIVE_QUEUE, ARCHIVE_SCAN_QUEUE } from "./archive/schedule.ts";
import { startJobs } from "./jobs.ts";
import { loadConfig } from "./config.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "./test/database.ts";
import { startWorker } from "./worker.ts";

/**
 * The worker as the server runs it on its own (worker-main.ts): with nothing of GitHub set, it
 * starts all the same, with its queues and schedules, and archives nothing. Needs AQ_TEST_DATABASE,
 * see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE)("the worker", () => {
  let t: TestDatabase;
  let staging: string;
  beforeAll(async () => {
    t = await createTestDatabase();
    staging = mkdtempSync(join(tmpdir(), "aq-worker-staging-"));
  });
  afterAll(async () => {
    await t?.drop();
    if (staging) rmSync(staging, { recursive: true, force: true });
  });

  test("starts without GitHub: the queues and the schedules are there, and it stops", async () => {
    const config = loadConfig(
      {
        // Nor repositories of its own: nothing reaches a repository at all.
        AQ_LOCAL_REPOS: "off",
        DATABASE_HOST: t.config.host,
        DATABASE_PORT: String(t.config.port),
        DATABASE_NAME: t.config.name,
        DATABASE_USER: t.config.user,
        DATABASE_PASSWORD: t.config.password,
        LFS_STAGING_DIR: staging,
        LFS_MIN_FREE_GB: "0",
      },
      () => undefined,
    );
    const said: string[] = [];
    const log = { ...quiet, info: (_: object, message?: string) => void said.push(message ?? "") };
    const worker = startWorker(config, { log });
    await worker.ready;
    expect(said).toContain("archiving");
    expect(said).toContain("pushing to Git LFS");
    const queues = await t.query("select name from pgboss.queue");
    expect(queues.rows.map((row: { name: string }) => row.name)).toEqual(
      expect.arrayContaining([ARCHIVE_QUEUE, ARCHIVE_SCAN_QUEUE]),
    );
    const schedules = await t.query("select name from pgboss.schedule");
    expect(schedules.rows.map((row: { name: string }) => row.name)).toContain(ARCHIVE_SCAN_QUEUE);

    // A working copy asked for of a project on GitHub: it waits in the queue, and nothing of the
    // project or its repository changes, however long, as a try would fail and enough of them
    // would take the project away.
    await t.query(`
      insert into users (id, github_id, login) values ('0190a000-0000-7000-8000-000000000001', 101, 'ada');
      insert into projects (id, owner_id, project_id, name, copy_state) values
        ('p-gone', '0190a000-0000-7000-8000-000000000001', 'm', '一', 'restoring');
      insert into project_repos (project_id, installation_id, repo_id, owner_id, owner_login, name,
          branch, private, created_here) values ('p-gone', 11, 9001, 101, 'ada', 'one', 'main', true, true);`);
    const rowsOf = async () => ({
      project: (await t.query("select * from projects")).rows,
      repos: (await t.query("select * from project_repos")).rows,
    });
    const before = await rowsOf();
    const boss = await startJobs(t.config, quiet);
    try {
      await enqueueRebuild(boss, "p-gone");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const jobs = await boss.findJobs(REBUILD_QUEUE, { key: "p-gone" });
      expect(jobs.map((job) => job.state)).toEqual(["created"]);
    } finally {
      await boss.stop({ graceful: false });
    }
    expect(await rowsOf()).toEqual(before);
    await worker.stop();
  });

  test("without GitHub, keeps repositories of its own: says where, and links projects without one", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aq-worker-data-"));
    try {
      const config = loadConfig(
        {
          DATABASE_HOST: t.config.host,
          DATABASE_PORT: String(t.config.port),
          DATABASE_NAME: t.config.name,
          DATABASE_USER: t.config.user,
          DATABASE_PASSWORD: t.config.password,
          LFS_STAGING_DIR: staging,
          LFS_MIN_FREE_GB: "0",
          AQ_DATA_DIR: dataDir,
        },
        () => undefined,
      );
      await t.query(`
        insert into users (id, github_id, login) values ('0190a000-0000-7000-8000-000000000002', 102, 'grace');
        insert into projects (id, owner_id, project_id, name) values
          ('p-here', '0190a000-0000-7000-8000-000000000002', 'm2', '二');`);
      const said: string[] = [];
      const log = {
        ...quiet,
        info: (_: object, message?: string) => void said.push(message ?? ""),
      };
      const worker = startWorker(config, { log });
      await worker.ready;
      expect(said).toContain(
        "repositories here are on, in a folder made now: it has to be on a volume that stays",
      );
      expect(said).toContain("projects linked to repositories here");
      const link = await t.query(
        "select provider, local_dir from project_repos where project_id = 'p-here'",
      );
      expect(link.rows).toEqual([{ provider: "local", local_dir: "repos/p-here.git" }]);
      const schedules = await t.query("select name from pgboss.schedule");
      expect(schedules.rows.map((row: { name: string }) => row.name)).toEqual(
        expect.arrayContaining(["local-repos-look", "local-repos-verify"]),
      );
      await worker.stop();

      // A deployment that keeps none says so, whatever is set.
      const none: string[] = [];
      const other = startWorker(config, {
        log: { ...quiet, info: (_: object, message?: string) => void none.push(message ?? "") },
        local: undefined,
      });
      await other.ready;
      expect(none.join(" ")).not.toContain("repositories here are on");
      await other.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
