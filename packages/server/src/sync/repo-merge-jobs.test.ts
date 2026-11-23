import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newProject, quiet, world } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { startJobs, type Jobs } from "../jobs.ts";
import { repoMerges } from "../schema.ts";
import { REPO_MERGE_QUEUE, requeueWaitingMerges, setUpRepoMergeQueue } from "./repo-merge-jobs.ts";

/**
 * Merges that wait with no job for them, as after the database was made again from an export: the
 * worker queues them again as it starts. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */
describe.skipIf(!TEST_DATABASE)("merges that wait without a job, on a database", () => {
  let t: TestDatabase;
  let jobs: Jobs;
  beforeAll(async () => {
    t = await createTestDatabase();
    jobs = await startJobs(t.config, quiet);
    await setUpRepoMergeQueue(jobs);
  });
  afterAll(async () => {
    await jobs?.stop({ graceful: false });
    await t?.drop();
  });

  test("are queued again, each once, and none that is done", async () => {
    const w = await world(t.db);
    const merge = async (state: "ready" | "applied") => {
      const project = await newProject(w);
      const [row] = await t.db
        .insert(repoMerges)
        .values({
          projectId: project.id,
          repoId: 1,
          fromSha: "a".repeat(40),
          toSha: "b".repeat(40),
          state,
        })
        .returning({ id: repoMerges.id });
      return row!.id;
    };
    const waiting = [await merge("ready"), await merge("ready")];
    await merge("applied");
    expect(await requeueWaitingMerges(t.db, jobs)).toBe(2);
    // A worker that starts again while they still wait: no second job of any.
    expect(await requeueWaitingMerges(t.db, jobs)).toBe(0);
    const queued = await jobs.findJobs<{ merge: string }>(REPO_MERGE_QUEUE, { queued: true });
    expect(queued.map((job) => job.data.merge).toSorted()).toEqual(waiting.toSorted());
  });
});
