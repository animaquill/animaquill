import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { describeError, type Db, type Executor, type Logger } from "../database.ts";
import type { Jobs } from "../jobs.ts";
import { projectRepos, projects, repoConflicts, repoMerges, users } from "../schema.ts";
import { UNUSABLE_KEPT_MS, unusableReasonOf, type Link } from "../archive/links.ts";
import type { Recheck } from "../archive/recheck.ts";
import type { SyncHub } from "./hub.ts";

/**
 * What the platform does with projects nobody sees to, every hour, each part on its own, so that
 * one that fails holds up nothing else, and each fine to run again:
 *
 * 1. Projects whose repository cannot be used for seven days (`unusable_since`, `deleteAtOf`) go,
 *    once GitHub says again that it cannot be used: the App's token asks about the repository by
 *    its number (`recheckLink`). Where it can be used by now, archiving goes on, and nothing goes;
 *    where GitHub cannot be asked, nothing goes either, and the next hour asks again. Only once it
 *    says so does the project go, as people take one away (`SyncHub.remove`): its id is kept, and
 *    its windows hear that it was deleted. Nothing goes while taking such projects away has not
 *    begun (`deletesFrom`), nor without the App's key, which is what asks.
 * 2. Ids of projects taken away more than a week ago are forgotten (`SyncHub.forgetDeleted`).
 * 3. Projects whose changes have not got into GitHub for three days are said to admins in the log,
 *    and on the first page of the admin site (`archivesFailingLong`): those GitHub or the platform
 *    keep out (`transient_since`, see `Archiver`) are kept as long as that lasts, and somebody has
 *    to look; the rest wait for their people, who are told from the start.
 * 4. Changes kept with conflicts of merges from GitHub (`repo_conflicts.change`) go once the
 *    conflict is settled, or stale for a week (`CHANGES_KEPT_MS`): only an open one is read on top
 *    of, and they would grow with every change that arrives late.
 * 5. Merges from GitHub that never went in, a month on (`MERGES_KEPT_MS`: superseded, refused) go.
 *    Their conflicts stay (`merge_id` goes, see the schema), and say the commit themselves. Those
 *    that went in stay as long as the project: what they brought is what is taken back out of the
 *    project where GitHub's history is rewritten (archiver.ts, `#takeOutDropped`), and a row is a
 *    few hundred bytes, as what was read into it (`input`) went once it was merged.
 */

/** How long a change kept with a conflict that went stale stays, see 4. above. */
export const CHANGES_KEPT_MS = 7 * 24 * 3600_000;

/** How long a merge from GitHub that is done with stays, see 5. above. */
export const MERGES_KEPT_MS = 30 * 24 * 3600_000;

/** The queue of pg-boss of the sweep: its name is from when it only forgot ids, once a day. */
export const PROJECTS_SWEEP_QUEUE = "deleted-projects-sweep";

/** Projects taken away for their repository in one sweep at most: the rest go an hour later. */
const MOST_AT_ONCE = 50;

/** Archives that fail for this long are said to admins. */
export const FAILING_LONG_MS = 3 * 24 * 3600_000;
/** Projects named in the log of those, at most. */
const NAMED_MOST = 20;

export interface ProjectSweepOptions {
  readonly db: Db;
  readonly hub: Pick<SyncHub, "remove" | "forgetDeleted">;
  readonly log: Logger;
  /** Asks GitHub about a repository, see `recheckLink`. Undefined where the App's key is not set. */
  readonly recheck: ((link: Link) => Promise<Recheck>) | undefined;
  /** Has a project archived again, once its repository can be used again. */
  readonly lookAgain?: ((projectId: string) => Promise<void>) | undefined;
  /** Since when such projects are taken away, see `deleteAtOf`: none unless said. */
  readonly deletesFrom?: string | undefined;
  /** Projects taken away for their repository in one sweep at most: `MOST_AT_ONCE` unless said. */
  readonly most?: number;
  readonly now?: () => Date;
}

export interface ProjectSweep {
  /** Projects taken away for their repository. */
  readonly removed: number;
  /** Projects whose repository can be used again, found as they were due. */
  readonly back: number;
  /** Projects that stay as GitHub could not be asked, or something else went wrong. */
  readonly unknown: number;
  readonly forgotten: number;
  /** Projects whose archives have failed for three days for GitHub's or the platform's sake. */
  readonly failingLong: number;
  /** Projects whose changes have not got into GitHub for three days, for whatever reason. */
  readonly behindLong: number;
  /** Changes kept with conflicts that were let go of. */
  readonly changesForgotten: number;
  /** Merges from GitHub done with that went. */
  readonly mergesForgotten: number;
}

export const sweepProjects = async (options: ProjectSweepOptions): Promise<ProjectSweep> => {
  const { db, hub, log, recheck } = options;
  const now = options.now?.() ?? new Date();
  const from = options.deletesFrom;
  let removed = 0;
  let back = 0;
  let unknown = 0;
  let forgotten = 0;
  let failingLong = 0;
  let changesForgotten = 0;

  // 1. Seven days since the repository could not be used, and since taking such projects away
  // began: before that nothing is due at all.
  const before = new Date(now.getTime() - UNUSABLE_KEPT_MS);
  if (recheck && from !== undefined && Date.parse(from) <= before.getTime()) {
    try {
      const due = await db
        .select({ link: projectRepos, ownerId: projects.ownerId })
        .from(projectRepos)
        .innerJoin(projects, eq(projects.id, projectRepos.projectId))
        .where(and(isNotNull(projectRepos.unusableSince), lte(projectRepos.unusableSince, before)))
        // Those GitHub was asked about the longest ago first: one it could not say anything about
        // goes to the end, and does not hold up the rest.
        .orderBy(sql`${projectRepos.recheckedAt} asc nulls first`, asc(projectRepos.unusableSince))
        .limit(options.most ?? MOST_AT_ONCE);
      for (const { link, ownerId } of due) {
        const project = link.projectId;
        try {
          const found = await recheck(link);
          if (found.kind === "usable") {
            back += 1;
            log.info({ project }, "the repository of a project can be used again");
            await options.lookAgain?.(project).catch(() => {});
            continue;
          }
          if (found.kind === "unknown") {
            unknown += 1;
            log.warn(
              { project, detail: found.detail },
              "GitHub could not be asked about a repository",
            );
            continue;
          }
          // GitHub says it cannot be used: the project goes, where the database still says so.
          const outcome = await hub.remove(project, ownerId, { unusableBefore: before });
          if (outcome === "removed") {
            removed += 1;
            log.info(
              {
                project,
                user: ownerId,
                reason: found.reason,
                since: link.unusableSince?.toISOString(),
                was: unusableReasonOf(link),
              },
              "a project whose repository cannot be used was deleted",
            );
          }
        } catch (error) {
          unknown += 1;
          log.warn({ err: describeError(error), project }, "a project was not swept");
        }
      }
    } catch (error) {
      log.warn(
        { err: describeError(error) },
        "projects whose repository cannot be used were not swept",
      );
    }
  }

  // 2.
  try {
    forgotten = await hub.forgetDeleted();
    if (forgotten > 0) log.info({ forgotten }, "ids of deleted projects forgotten");
  } catch (error) {
    log.warn({ err: describeError(error) }, "ids of deleted projects were not forgotten");
  }

  // 3.
  let behindLong = 0;
  try {
    const failing = await archivesFailingLong(db, now);
    failingLong = failing.transient.count;
    behindLong = failing.behind.count;
    if (failingLong > 0)
      log.error(
        {
          count: failingLong,
          projects: failing.transient.projects.map((row) => row.project),
          since: failing.transient.projects[0]?.since,
        },
        "archives have failed for three days: somebody has to look",
      );
    if (behindLong > failingLong)
      log.warn(
        {
          count: behindLong,
          projects: failing.behind.projects.map((row) => row.project),
          since: failing.behind.projects[0]?.since,
        },
        "changes of projects have not got into GitHub for three days",
      );
  } catch (error) {
    log.warn({ err: describeError(error) }, "archives that keep failing were not looked for");
  }

  // 4.
  try {
    const old = new Date(now.getTime() - CHANGES_KEPT_MS);
    const letGo = await db
      .update(repoConflicts)
      .set({ change: null })
      .where(
        and(
          isNotNull(repoConflicts.change),
          or(
            inArray(repoConflicts.state, ["ours", "theirs"]),
            and(eq(repoConflicts.state, "stale"), lte(repoConflicts.createdAt, old)),
          ),
        ),
      )
      .returning({ id: repoConflicts.id });
    changesForgotten = letGo.length;
    if (changesForgotten > 0)
      log.info({ changesForgotten }, "changes kept with conflicts let go of");
  } catch (error) {
    log.warn({ err: describeError(error) }, "changes kept with conflicts were not let go of");
  }
  // 5.
  let mergesForgotten = 0;
  try {
    const old = new Date(now.getTime() - MERGES_KEPT_MS);
    const gone = await db
      .delete(repoMerges)
      .where(
        and(inArray(repoMerges.state, ["superseded", "refused"]), lte(repoMerges.createdAt, old)),
      )
      .returning({ id: repoMerges.id });
    mergesForgotten = gone.length;
    if (mergesForgotten > 0) log.info({ mergesForgotten }, "merges from GitHub done with went");
  } catch (error) {
    log.warn({ err: describeError(error) }, "merges from GitHub done with stay for now");
  }
  return {
    removed,
    back,
    unknown,
    forgotten,
    failingLong,
    behindLong,
    changesForgotten,
    mergesForgotten,
  };
};

/** Projects of one kind that have not got into GitHub for long, see `archivesFailingLong`. */
export interface FailingLong {
  readonly count: number;
  /** The first `NAMED_MOST`, longest first: since when, in ISO, and why where a pause says. */
  readonly projects: readonly {
    readonly project: string;
    readonly since: string | undefined;
    readonly reason?: string;
  }[];
}

/**
 * Projects whose changes have not got into GitHub for three days (`FAILING_LONG_MS`), for admins
 * (4. above): `transient`, as archives fail for GitHub's or the platform's sake (`transient_since`),
 * which only somebody of the platform puts right, and whose copies are kept meanwhile; `behind`,
 * whatever the reason (`dirty_since`, the first change that is not in), also a pause that waits
 * for people. Only working copies that are here, of people who are not disabled.
 */
export const archivesFailingLong = async (
  db: Executor,
  now: Date,
): Promise<{ readonly transient: FailingLong; readonly behind: FailingLong }> => {
  const since = new Date(now.getTime() - FAILING_LONG_MS);
  const of = async (column: typeof projectRepos.transientSince | typeof projects.dirtySince) => {
    const rows = await db
      .select({
        project: projectRepos.projectId,
        since: column,
        reason: projectRepos.pauseReason,
        count: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(
        and(
          eq(projects.copyState, "live"),
          isNull(users.disabledAt),
          lte(column, since),
          column === projectRepos.transientSince ? eq(projectRepos.state, "ready") : undefined,
        ),
      )
      .orderBy(asc(column))
      .limit(NAMED_MOST);
    return {
      count: rows[0]?.count ?? 0,
      projects: rows.map((row) => ({
        project: row.project,
        since: row.since?.toISOString(),
        ...(row.reason !== null && { reason: row.reason }),
      })),
    };
  };
  return {
    transient: await of(projectRepos.transientSince),
    behind: await of(projects.dirtySince),
  };
};

/**
 * Runs the sweep every hour, in this process, which holds the working copies. The schedule is
 * pg-boss's: one run an hour, however many APIs. What fails waits for the next hour.
 */
export const scheduleProjectSweep = async (
  boss: Jobs,
  options: ProjectSweepOptions,
): Promise<void> => {
  const queue = { retryLimit: 0, expireInSeconds: 15 * 60, deleteAfterSeconds: 24 * 3600 };
  await boss.createQueue(PROJECTS_SWEEP_QUEUE, { policy: "stately", ...queue });
  await boss.updateQueue(PROJECTS_SWEEP_QUEUE, queue);
  await boss.schedule(PROJECTS_SWEEP_QUEUE, "43 * * * *");
  await boss.work(PROJECTS_SWEEP_QUEUE, async () => {
    try {
      const swept = await sweepProjects(options);
      if (swept.removed + swept.back + swept.unknown > 0)
        options.log.info({ ...swept }, "projects swept");
    } catch (error) {
      options.log.warn({ err: describeError(error) }, "projects were not swept");
    }
  });
};

/** The queue of pg-boss that asks GitHub again about repositories that cannot be used. */
export const RECHECK_QUEUE = "repository-recheck";
/** Repositories asked about in one run at most: the rest a minute later. */
const RECHECK_MOST = 20;

/**
 * Asks GitHub again whether repositories that cannot be used can be used by now, as they are due
 * (`recheck_at`, see archive/links.ts): a few minutes after it was first found, then after an hour,
 * six hours and every day; sooner where people open or list such a project. A project found wrongly
 * so, as when GitHub answered 404 for a while, can be edited again within minutes. Resolves to how
 * many can be used again.
 */
export const recheckDue = async (options: {
  readonly db: Db;
  readonly recheck: (link: Link) => Promise<Recheck>;
  readonly lookAgain?: ((projectId: string) => Promise<void>) | undefined;
  readonly log: Logger;
  readonly now?: () => Date;
}): Promise<{ readonly back: number; readonly asked: number }> => {
  const now = options.now?.() ?? new Date();
  const due = await options.db
    .select()
    .from(projectRepos)
    .where(and(isNotNull(projectRepos.unusableSince), lte(projectRepos.recheckAt, now)))
    .orderBy(asc(projectRepos.recheckAt))
    .limit(RECHECK_MOST);
  let back = 0;
  for (const link of due) {
    try {
      const found = await options.recheck(link);
      if (found.kind !== "usable") continue;
      back += 1;
      options.log.info(
        { project: link.projectId },
        "the repository of a project can be used again",
      );
      await options.lookAgain?.(link.projectId).catch(() => {});
    } catch (error) {
      options.log.warn(
        { err: describeError(error), project: link.projectId },
        "a repository was not asked about",
      );
    }
  }
  return { back, asked: due.length };
};

/** Runs `recheckDue` every minute in this process. What fails waits for the next minute. */
export const scheduleRechecks = async (
  boss: Jobs,
  options: Parameters<typeof recheckDue>[0],
): Promise<void> => {
  const queue = { retryLimit: 0, expireInSeconds: 10 * 60, deleteAfterSeconds: 3600 };
  await boss.createQueue(RECHECK_QUEUE, { policy: "stately", ...queue });
  await boss.updateQueue(RECHECK_QUEUE, queue);
  await boss.schedule(RECHECK_QUEUE, "* * * * *");
  await boss.work(RECHECK_QUEUE, async () => {
    try {
      await recheckDue(options);
    } catch (error) {
      options.log.warn({ err: describeError(error) }, "repositories were not asked about");
    }
  });
};
