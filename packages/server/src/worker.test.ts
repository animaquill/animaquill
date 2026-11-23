import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ARCHIVE_QUEUE, ARCHIVE_SCAN_QUEUE } from "./archive/schedule.ts";
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
    await worker.stop();
  });
});
