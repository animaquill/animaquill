import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../database.ts";
import { projectRepos, type Diverged, type GoneCause, type PauseReason } from "../schema.ts";

/**
 * The link of a project to its repository, as the archive, the API and the webhook change it: paused
 * for a reason that needs people, back to ready, and a wait after failing.
 */

export type Link = typeof projectRepos.$inferSelect;

/**
 * The space of the locks of archives, see `withLock` of database.ts: one archive of a project at a
 * time (archiver.ts), and nothing that makes or lets go of its working copy meanwhile
 * (rebuild.ts, `SyncHub.release`).
 */
export const ARCHIVE_LOCK = 0x61712d72; // "aq-r"

export const linkOf = async (db: Executor, projectId: string): Promise<Link | undefined> => {
  const [row] = await db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
  return row;
};

/** Pauses that end by themselves once the project changes, see `takeDue` in schedule.ts. */
export const CONTENT_REASONS: readonly PauseReason[] = ["manifest", "invalid", "locked"];

/**
 * Pauses that say the repository cannot be used at all: gone, whatever GitHub said or did not say
 * of why; on another account; the App uninstalled or suspended. Such a project cannot be edited,
 * and goes seven days after the platform first found it so (`unusable_since`). Every other pause,
 * and every failure, leaves it to be edited as ever.
 */
export const UNUSABLE_REASONS: readonly PauseReason[] = [
  "gone",
  "transferred",
  "uninstalled",
  "suspended",
];

export const isUnusable = (reason: PauseReason | null | undefined): boolean =>
  reason != null && UNUSABLE_REASONS.includes(reason);

/** How long a project whose repository cannot be used is kept, from when that was first found. */
export const UNUSABLE_KEPT_MS = 7 * 24 * 3600_000;

/**
 * Since when projects whose repository cannot be used are taken away (`deletesFrom` of the
 * options of the sweep, the list and the repository service, `ReleaseSwitches`), as an ISO time in
 * UTC, which a deployment gives: undefined, as unless it says, takes none. No project goes before
 * seven days after it, also one whose repository could not be used for longer, see `deleteAtOf`, so
 * that a deployment can turn it on once its editors tell people how long such a project is kept.
 */

/** A time as `deletesFrom` says one: ISO, in UTC. */
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/**
 * The switch of projects whose repository cannot be used, as it is written: an ISO time in UTC, or
 * nothing. Throws for anything else, which the API does as it starts: a switch that is written wrong
 * must not count as off, or as on, without anybody noticing.
 */
export const checkUnusableSwitches = (switches: {
  readonly deletesFrom: string | undefined;
}): void => {
  const { deletesFrom } = switches;
  if (
    deletesFrom !== undefined &&
    (!MOMENT.test(deletesFrom) || !Number.isFinite(Date.parse(deletesFrom)))
  )
    throw new Error(
      `deletesFrom (since when projects whose repository cannot be used are taken away) is no time such as 2026-11-20T00:00:00Z: ${JSON.stringify(deletesFrom)}`,
    );
};

/**
 * When GitHub is asked again by itself whether a repository that cannot be used can be used again
 * (archive/recheck.ts): a few minutes after it was first found so, then after an hour, six hours,
 * and every day after that, from each time it said no. Where it could not be asked, again a while
 * later. A person who opens such a project, or whose list has it, has it asked sooner, but not more
 * than once in `RECHECK_SOON_MS`.
 */
export const RECHECK_FIRST_MS = 5 * 60_000;
export const RECHECK_AFTER_MS: readonly number[] = [3600_000, 6 * 3600_000, 24 * 3600_000];
export const RECHECK_UNKNOWN_MS = 15 * 60_000;
export const RECHECK_SOON_MS = 10 * 60_000;

/** How long to wait to ask again after GitHub said no this many times since it was first found. */
export const recheckAfterMs = (rechecks: number): number =>
  RECHECK_AFTER_MS[Math.min(Math.max(rechecks, 1), RECHECK_AFTER_MS.length) - 1]!;

/**
 * Has GitHub asked about these projects' repositories soon, where they cannot be used, and nobody
 * asked in the last `RECHECK_SOON_MS`: as people open such a project, or list it.
 */
export const recheckSoon = async (
  db: Executor,
  projectIds: readonly string[],
  now: Date,
): Promise<void> => {
  if (projectIds.length === 0) return;
  await db
    .update(projectRepos)
    .set({ recheckAt: now })
    .where(
      and(
        inArray(projectRepos.projectId, [...projectIds]),
        isNotNull(projectRepos.unusableSince),
        or(isNull(projectRepos.recheckAt), gt(projectRepos.recheckAt, now)),
        or(
          isNull(projectRepos.recheckedAt),
          lt(projectRepos.recheckedAt, new Date(now.getTime() - RECHECK_SOON_MS)),
        ),
      ),
    );
};

/**
 * The channel of PostgreSQL that says the link of a project changed in a way that can make it one
 * that cannot be edited, or one that can again: the payload is the project's id. The API process
 * that holds the working copies listens, see sync/link-listener.ts. Sent in the transaction that
 * changes the link, so it is heard once that is committed, and not at all where it is not.
 */
export const LINK_CHANNEL = "project_link";

export const notifyLink = async (db: Executor, projectIds: readonly string[]): Promise<void> => {
  for (const id of new Set(projectIds))
    await db.execute(sql`select pg_notify(${LINK_CHANNEL}, ${id})`);
};

/**
 * Whether the repository of a project cannot be used, and since when and why: what the hub goes
 * by, read from the database each time.
 */
export const unusableOf = async (
  db: Executor,
  projectId: string,
): Promise<{ readonly reason: PauseReason; readonly since: Date } | undefined> => {
  const [row] = await db
    .select({ unusableSince: projectRepos.unusableSince, pauseReason: projectRepos.pauseReason })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId));
  const reason = row && unusableReasonOf(row);
  return reason === undefined ? undefined : { reason, since: row!.unusableSince! };
};

/**
 * Why the repository of a link cannot be used, or undefined where it can. A link noted as unusable
 * is paused for one of `UNUSABLE_REASONS`: "gone" where it somehow is not.
 */
export const unusableReasonOf = (link: {
  readonly unusableSince: Date | null;
  readonly pauseReason: PauseReason | null;
}): PauseReason | undefined => {
  if (link.unusableSince === null) return undefined;
  return isUnusable(link.pauseReason) ? link.pauseReason! : "gone";
};

/**
 * When a project whose repository cannot be used since `since` is taken away: seven days on, and
 * never before seven days after taking such projects away began (`from`, see `deletesFrom` above), so that
 * nobody's project goes before their editor could tell them. Undefined while none is taken away.
 */
export const deleteAtOf = (since: Date, from: string | undefined): Date | undefined => {
  if (from === undefined) return undefined;
  return new Date(Math.max(since.getTime(), Date.parse(from)) + UNUSABLE_KEPT_MS);
};

/**
 * Stops archiving into a repository until someone does something about `reason`: only where the
 * project is still linked to that repository, as people can have chosen another one meanwhile. What
 * failed before is forgotten. For a reason that says the repository cannot be used, since when that
 * is so is noted where it was not yet, and stays as it was where it was, also where the reason is
 * another one now; any other reason ends it. `seq`: the update of the project that was found
 * wanting, for a pause about what the project had. `goneCause`: what a webhook said became of the repository, which is
 * noted; what was noted before stays where this says none, as an archive that finds a repository
 * not there knows no more than that. It goes once the repository is reached again, see `Archiver`.
 */
export const pauseLink = async (
  db: Executor,
  where: { readonly projectId: string; readonly repoId: number },
  pause: {
    readonly reason: PauseReason;
    readonly detail: string;
    readonly at: Date;
    readonly diverged?: Diverged;
    readonly seq?: number;
    readonly goneCause?: GoneCause;
  },
) => {
  await db
    .update(projectRepos)
    .set({
      state: "paused",
      pauseReason: pause.reason,
      detail: pause.detail.slice(0, 500),
      pausedAt: pause.at,
      pausedSeq: pause.seq ?? null,
      diverged: pause.diverged ?? null,
      failures: 0,
      nextAttemptAt: null,
      transientSince: null,
      unusableSeenAt: null,
      ...(isUnusable(pause.reason)
        ? {
            unusableSince: sql`coalesce(${projectRepos.unusableSince}, ${pause.at.toISOString()}::timestamptz)`,
            // First found: GitHub is asked again a few minutes on, see `RECHECK_FIRST_MS`.
            recheckAt: sql`case when ${projectRepos.unusableSince} is null then ${new Date(pause.at.getTime() + RECHECK_FIRST_MS).toISOString()}::timestamptz else ${projectRepos.recheckAt} end`,
            rechecks: sql`case when ${projectRepos.unusableSince} is null then 0 else ${projectRepos.rechecks} end`,
            recheckedAt: sql`case when ${projectRepos.unusableSince} is null then null else ${projectRepos.recheckedAt} end`,
          }
        : { unusableSince: null, recheckAt: null, rechecks: 0, recheckedAt: null }),
      ...(pause.goneCause !== undefined && { goneCause: pause.goneCause }),
    })
    .where(and(eq(projectRepos.projectId, where.projectId), eq(projectRepos.repoId, where.repoId)));
  await notifyLink(db, [where.projectId]);
};

/** Archiving goes on, for links paused for one of `reasons`. Resolves to their projects. */
export const resumeLinks = async (
  db: Executor,
  where: SQL | undefined,
  reasons: readonly PauseReason[],
): Promise<string[]> => {
  const rows = await db
    .update(projectRepos)
    .set({
      state: "ready",
      pauseReason: null,
      detail: null,
      pausedAt: null,
      pausedSeq: null,
      diverged: null,
      unusableSince: null,
      unusableSeenAt: null,
      recheckAt: null,
      rechecks: 0,
      recheckedAt: null,
    })
    .where(
      and(eq(projectRepos.state, "paused"), inArray(projectRepos.pauseReason, [...reasons]), where),
    )
    .returning({ projectId: projectRepos.projectId });
  const projects = rows.map((row) => row.projectId);
  await notifyLink(db, projects);
  return projects;
};

/** How long to wait after failing this many times before: 1, 2, 4… minutes, at most an hour. */
export const backoffMs = (failuresBefore: number, retryAfterMs = 0): number =>
  Math.max(Math.min(60, 2 ** Math.min(failuresBefore, 6)) * 60_000, retryAfterMs);
