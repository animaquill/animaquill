import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db, Logger } from "../database.ts";
import { describeError } from "../database.ts";
import type { Jobs } from "../jobs.ts";
import { projectRepos, projects, users } from "../schema.ts";
import type { ArchiveKind, Archiver } from "./archiver.ts";
import { readSetting } from "../settings.ts";
import { CONTENT_REASONS } from "./links.ts";
import { REPO_MERGE_SETTING } from "./merging.ts";

/**
 * When projects are archived. The hub notes since when a project has changes
 * (`projects.dirty_since`, in the statement that takes the update); every minute the worker looks
 * for projects whose changes are due: nobody changed anything for five minutes, or changes have
 * been coming for thirty. Each goes into the queue of archives, where a project is waiting at most
 * once, and running at most once (`singletonKey`, policy "stately"), and the archive itself holds a
 * lock on the project as well. Linking a repository and "archive now" queue one at once; a push
 * elsewhere queues a check, see events.ts.
 */

export const ARCHIVE_QUEUE = "archive";
export const ARCHIVE_SCAN_QUEUE = "archive-scan";
/**
 * How long a worker that stops waits for the archive it runs: the compose file gives it longer than
 * this before it is killed (`stop_grace_period`). One that does not finish is safe to leave: the
 * next archive knows what reached GitHub, see `Archiver`.
 */
export const STOP_WAIT_MS = 20_000;
/**
 * A worker that runs an archive says so this often, about: one that died says nothing, and its
 * archive is let go after `heartbeatSeconds`, not after `expireInSeconds`, so that the next one of
 * the project can run.
 */
const HEARTBEAT_SECONDS = 30;
/** Changes are archived once nobody made one for this long... */
export const IDLE_MS = 5 * 60_000;
/** ...or once they have been coming for this long, whatever goes on. */
export const CONTINUOUS_MS = 30 * 60_000;

export interface ArchiveJob {
  readonly project: string;
  readonly kind: ArchiveKind;
  /** Who asked, for an archive people asked for. */
  readonly by?: string;
}

/** The queues of archiving, the same from the API and the worker: making them twice does nothing. */
export const setUpArchiveQueues = async (boss: Jobs): Promise<void> => {
  const archives = {
    // The archive keeps its own count of failures and its own waits, see `Archiver`.
    retryLimit: 0,
    // The largest project takes seconds; this is for one that hangs.
    expireInSeconds: 10 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    deleteAfterSeconds: 60 * 60,
  };
  const scans = {
    retryLimit: 0,
    expireInSeconds: 5 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    deleteAfterSeconds: 60 * 60,
  };
  await boss.createQueue(ARCHIVE_QUEUE, { policy: "stately", ...archives });
  await boss.createQueue(ARCHIVE_SCAN_QUEUE, { policy: "stately", ...scans });
  // A queue that was there before keeps its options: these are the ones from now on.
  await boss.updateQueue(ARCHIVE_QUEUE, archives);
  await boss.updateQueue(ARCHIVE_SCAN_QUEUE, scans);
};

/** Queues an archive, unless one of the project waits already. */
export const enqueueArchive = async (boss: Jobs, job: ArchiveJob): Promise<void> => {
  await boss.send(ARCHIVE_QUEUE, { ...job }, { singletonKey: job.project });
};

/** Whether an archive of the project is waiting or running. */
export const isArchiveQueued = async (boss: Jobs, project: string): Promise<boolean> => {
  // Oldest first, with those done in the last hour (`deleteAfterSeconds`): far fewer than this.
  const found = await boss.findJobs(ARCHIVE_QUEUE, { key: project, limit: 1000 });
  return found.some(
    (job) => job.state === "created" || job.state === "retry" || job.state === "active",
  );
};

/**
 * The projects whose changes are due now, and those people asked to archive that no job took on
 * yet. Pauses for what the project had (an animaquill.json the format does not take, files that do
 * not read as a project) end here once there is an update newer than the one that paused it, also
 * one that came while that archive ran. Nothing of someone disabled (admin/users.ts): their changes
 * wait, `dirty_since` and all, and are due again once they are enabled.
 */
export const takeDue = async (
  db: Db,
  now: Date,
  options: { readonly merging?: boolean } = {},
): Promise<string[]> => {
  const at = now.toISOString();
  // Merges are on: what paused because files of the project changed on GitHub before they were
  // (`Diverged.merging` missing) goes on, and is looked at, which merges those changes now. What
  // paused while they were on stays paused, as an AGENTS.md that no archive wrote.
  const lookAgain = options.merging
    ? await db
        .update(projectRepos)
        .set({
          state: "ready",
          pauseReason: null,
          detail: null,
          pausedAt: null,
          pausedSeq: null,
          diverged: null,
        })
        .where(
          and(
            eq(projectRepos.state, "paused"),
            eq(projectRepos.pauseReason, "diverged"),
            sql`coalesce((${projectRepos.diverged}->>'merging')::boolean, false) = false`,
          ),
        )
        .returning({ id: projectRepos.projectId })
    : [];
  await db
    .update(projectRepos)
    .set({ state: "ready", pauseReason: null, detail: null, pausedAt: null, pausedSeq: null })
    .where(
      and(
        eq(projectRepos.state, "paused"),
        inArray(projectRepos.pauseReason, [...CONTENT_REASONS]),
        isNotNull(projectRepos.pausedSeq),
        sql`exists (select 1 from ${projects} where ${projects.id} = ${projectRepos.projectId} and ${projects.head} > ${projectRepos.pausedSeq})`,
      ),
    );
  const rows = await db
    .select({ id: projectRepos.projectId })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(
      and(
        eq(projectRepos.state, "ready"),
        isNull(users.disabledAt),
        or(
          isNotNull(projectRepos.requestedAt),
          isNotNull(projects.dirtySince),
          isNotNull(projectRepos.unusableSeenAt),
        ),
        or(
          isNotNull(projectRepos.requestedAt),
          // An archive found the repository cannot be used: the next one looks again.
          isNotNull(projectRepos.unusableSeenAt),
          lte(projects.updatedAt, sql`${at}::timestamptz - ${`${IDLE_MS} milliseconds`}::interval`),
          lte(
            projects.dirtySince,
            sql`${at}::timestamptz - ${`${CONTINUOUS_MS} milliseconds`}::interval`,
          ),
        ),
        or(isNull(projectRepos.nextAttemptAt), lte(projectRepos.nextAttemptAt, now)),
      ),
    );
  return [...new Set([...rows.map((row) => row.id), ...lookAgain.map((row) => row.id)])];
};

/** When the changes of a project are due, as `takeDue` sees it: undefined where none wait. */
export const dueAt = (
  updatedAt: Date,
  dirtySince: Date | null,
  nextAttemptAt: Date | null,
): Date | undefined => {
  if (!dirtySince) return undefined;
  const due = Math.min(updatedAt.getTime() + IDLE_MS, dirtySince.getTime() + CONTINUOUS_MS);
  return new Date(Math.max(due, nextAttemptAt?.getTime() ?? 0));
};

/**
 * The worker's part: every minute it queues what is due, and it archives one project at a time,
 * which keeps the memory of one large project the most it needs, see worker.ts.
 */
export const startArchiving = async (
  boss: Jobs,
  options: {
    readonly db: Db;
    readonly archiver: Pick<Archiver, "run">;
    readonly log: Logger;
    readonly now?: () => Date;
  },
): Promise<void> => {
  const now = options.now ?? (() => new Date());
  await setUpArchiveQueues(boss);
  await boss.schedule(ARCHIVE_SCAN_QUEUE, "* * * * *");
  await boss.work(ARCHIVE_SCAN_QUEUE, async () => {
    const merging = await readSetting(options.db, REPO_MERGE_SETTING)
      .then(({ enabled }) => enabled)
      .catch(() => false);
    const due = await takeDue(options.db, now(), { merging });
    for (const project of due) await enqueueArchive(boss, { project, kind: "auto" });
    if (due.length > 0) options.log.info({ projects: due.length }, "archives due");
  });
  await boss.work<ArchiveJob>(
    ARCHIVE_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      const { project, kind, by } = job.data;
      const outcome = await options.archiver.run(project, kind, by).catch((error: unknown) => {
        options.log.error({ err: describeError(error), project }, "archive failed");
        return undefined;
      });
      return outcome && { kind: outcome.kind };
    },
  );
};
