import { describeError, type Logger } from "../database.ts";
import type { Jobs } from "../jobs.ts";
import type { LfsPusher } from "./push.ts";
import type { LfsSweeper } from "./sweep.ts";

/**
 * The queues of uploads into Git LFS: the API queues an upload once its file came in whole and
 * checked (uploads.ts), and the worker pushes them, two at a time (Q6 of the plan: the bandwidth of
 * the server), and sweeps every 15 minutes (sweep.ts). An upload waits in the queue at most once,
 * and runs at most once (`singletonKey`, policy "stately"); what failed is queued again for when it
 * is due, see push.ts.
 */

export const LFS_PUSH_QUEUE = "lfs-push";
export const LFS_SWEEP_QUEUE = "lfs-sweep";
/** Pushes at the same time, in the worker. */
export const PUSHES_AT_ONCE = 2;

export interface PushJob {
  readonly upload: string;
}

/** The queues, the same from the API and the worker: making them twice does nothing. */
export const setUpLfsQueues = async (boss: Jobs): Promise<void> => {
  const pushes = {
    // A push keeps its own count of tries, and its own waits.
    retryLimit: 0,
    // The longest a 2 GB file takes at 512 KiB/s (transfer.ts), and some: a worker that stops says
    // so sooner, by its heartbeat.
    expireInSeconds: 2.5 * 3600,
    heartbeatSeconds: 30,
    deleteAfterSeconds: 24 * 3600,
  };
  const sweeps = {
    retryLimit: 0,
    expireInSeconds: 30 * 60,
    heartbeatSeconds: 30,
    deleteAfterSeconds: 3600,
  };
  await boss.createQueue(LFS_PUSH_QUEUE, { policy: "stately", ...pushes });
  await boss.createQueue(LFS_SWEEP_QUEUE, { policy: "stately", ...sweeps });
  // A queue that was there before keeps its options: these are the ones from now on.
  await boss.updateQueue(LFS_PUSH_QUEUE, pushes);
  await boss.updateQueue(LFS_SWEEP_QUEUE, sweeps);
};

/** Queues the push of an upload, from `at` on, unless one waits already. */
export const enqueuePush = async (boss: Jobs, upload: string, at?: Date): Promise<void> => {
  await boss.send(
    LFS_PUSH_QUEUE,
    { upload },
    { singletonKey: upload, ...(at !== undefined && { startAfter: at }) },
  );
};

/** The worker's part: pushing what came in, and sweeping. */
export const startLfs = async (
  boss: Jobs,
  options: { readonly pusher: LfsPusher; readonly sweeper: LfsSweeper; readonly log: Logger },
): Promise<void> => {
  const { pusher, sweeper, log } = options;
  await setUpLfsQueues(boss);
  await boss.work<PushJob>(
    LFS_PUSH_QUEUE,
    { localConcurrency: PUSHES_AT_ONCE, batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      const outcome = await pusher.push(job.data.upload);
      if (outcome.kind === "later")
        await enqueuePush(boss, job.data.upload, outcome.at).catch((error: unknown) => {
          // The sweep queues it then.
          log.warn({ err: describeError(error), upload: job.data.upload }, "no push queued");
        });
      return { kind: outcome.kind };
    },
  );
  await boss.schedule(LFS_SWEEP_QUEUE, "*/15 * * * *");
  await boss.work(LFS_SWEEP_QUEUE, async () => {
    const swept = await sweeper.sweep();
    for (const upload of swept.due) await enqueuePush(boss, upload);
    if (swept.expired > 0 || swept.removed > 0 || swept.forgotten > 0)
      log.info(
        {
          expired: swept.expired,
          removed: swept.removed,
          forgotten: swept.forgotten,
          due: swept.due.length,
        },
        "uploads to Git LFS tidied up",
      );
  });
};
