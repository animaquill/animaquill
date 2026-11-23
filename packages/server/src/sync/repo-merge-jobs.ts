import { eq } from "drizzle-orm";
import { describeError, type Db, type Logger } from "../database.ts";
import type { Jobs } from "../jobs.ts";
import { repoMerges } from "../schema.ts";
import type { SyncHub } from "./hub.ts";

/**
 * Merging changes on GitHub into projects: the worker looks at the repository, writes what changed
 * into `repo_merges` and queues a job here; the API, which holds the working copies, merges it
 * (`SyncHub.mergeRepo`). A job that fails is tried again, with the merge still "ready"; one that
 * comes again for a merge that is done does nothing.
 */

export const REPO_MERGE_QUEUE = "repo-merge";

export interface RepoMergeJob {
  readonly merge: string;
}

const OPTIONS = {
  retryLimit: 20,
  retryDelay: 15,
  retryBackoff: true,
  // The largest merge takes seconds; this is for one that hangs.
  expireInSeconds: 10 * 60,
  deleteAfterSeconds: 24 * 3600,
};

/** The queue, the same from the API and the worker: making it twice does nothing. */
export const setUpRepoMergeQueue = async (boss: Jobs): Promise<void> => {
  await boss.createQueue(REPO_MERGE_QUEUE, OPTIONS);
  await boss.updateQueue(REPO_MERGE_QUEUE, OPTIONS);
};

/** Queues a merge. Queued twice, it runs twice: the second finds it done and does nothing. */
export const enqueueRepoMerge = async (boss: Jobs, merge: string): Promise<void> => {
  await boss.send(REPO_MERGE_QUEUE, { merge } satisfies RepoMergeJob, { singletonKey: merge });
};

/**
 * Queues every merge that waits ("ready") again, as the worker starts: a job can be gone while its
 * merge waits, with the jobs of a database that was made again from an export (which
 * carries no queue over), or one that gave up its tries. Nothing else does it for a project
 * nobody changes: the next archive of the project queues what waits (`Archiver`), but only changes
 * make one due. One with a job that waits or runs is left as it is (the queue's policy is
 * "standard", where `singletonKey` alone keeps nothing out); one that is done by the time it runs
 * does nothing. Resolves to how many were queued.
 */
export const requeueWaitingMerges = async (db: Db, boss: Jobs): Promise<number> => {
  const waiting = await db
    .select({ id: repoMerges.id })
    .from(repoMerges)
    .where(eq(repoMerges.state, "ready"));
  let queued = 0;
  for (const { id } of waiting) {
    const jobs = await boss.findJobs(REPO_MERGE_QUEUE, { key: id });
    if (jobs.some(({ state }) => state === "created" || state === "retry" || state === "active"))
      continue;
    await enqueueRepoMerge(boss, id);
    queued += 1;
  }
  return queued;
};

/** The API's part: merges what the worker found, one at a time. */
export const workRepoMerges = async (
  boss: Jobs,
  hub: Pick<SyncHub, "mergeRepo">,
  log: Logger,
): Promise<void> => {
  await setUpRepoMergeQueue(boss);
  await boss.work<RepoMergeJob>(
    REPO_MERGE_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      try {
        const outcome = await hub.mergeRepo(job.data.merge);
        // Not now: it comes again, as the copy is made again or the repository can be used.
        if (outcome.kind === "later") throw new Error(`later: ${outcome.why}`);
        return outcome;
      } catch (error) {
        log.warn({ err: describeError(error), merge: job.data.merge }, "a merge waits");
        throw error;
      }
    },
  );
};
