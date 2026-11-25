import { and, asc, eq, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { withLock, describeError, type Db, type Logger } from "../../database.ts";
import type { Jobs } from "../../jobs.ts";
import { projectRepos } from "../../schema.ts";
import { ARCHIVE_LOCK, linkOf, pauseLink, sameLink } from "../links.ts";
import { RepoPaused, placeOf, type LocalPlace } from "../repo-host.ts";
import type { LocalGitRepoHost } from "./host.ts";

/**
 * What the worker looks at in the repositories of the server's own, besides archiving into them:
 *
 * - every minute, whether the branch moved since the last archive (a `git push` of people's own,
 *   which no webhook tells of): such a project gets an archive that looks (`check`), which merges
 *   what came;
 * - once a week each, whether the repository still reads (`LocalGitRepoHost.verify`, from the tip
 *   down): one that does not is paused "broken", which people end by starting archiving over.
 */

export const LOCAL_LOOK_QUEUE = "local-repos-look";
export const LOCAL_VERIFY_QUEUE = "local-repos-verify";
export const VERIFY_EVERY_MS = 7 * 24 * 3600_000;
/** Repositories read through in one round at most: a round an hour gets through them all. */
const VERIFIED_PER_ROUND = 20;

/**
 * The projects whose branch here is not where the last archive or merge left it, and moved since
 * the last round (`seen`, by project: what it was then), so that a commit an archive only looks at
 * and leaves (such as one of people's files outside the project) is looked at once.
 */
export const pushedHere = async (
  db: Db,
  host: LocalGitRepoHost,
  seen: Map<string, string>,
): Promise<string[]> => {
  const links = await db
    .select()
    .from(projectRepos)
    .where(
      and(
        eq(projectRepos.provider, "local"),
        eq(projectRepos.state, "ready"),
        isNotNull(projectRepos.headSha),
        isNull(projectRepos.pendingSha),
      ),
    );
  const moved: string[] = [];
  const now = new Set<string>();
  for (const link of links) {
    now.add(link.projectId);
    const tip = await host.tipOf(placeOf(link) as LocalPlace);
    if (tip === undefined || tip === link.headSha || tip === link.mergedSha) {
      seen.delete(link.projectId);
      continue;
    }
    if (seen.get(link.projectId) !== tip) moved.push(link.projectId);
    seen.set(link.projectId, tip);
  }
  for (const project of seen.keys()) if (!now.has(project)) seen.delete(project);
  return moved;
};

/**
 * Reads through the repositories whose turn it is, one at a time, while no archive of the project
 * runs. Resolves to how many it read, and which it found broken.
 */
export const verifyDue = async (
  db: Db,
  host: LocalGitRepoHost,
  now: Date,
  log: Logger,
): Promise<{ readonly verified: number; readonly broken: readonly string[] }> => {
  const due = await db
    .select({ projectId: projectRepos.projectId })
    .from(projectRepos)
    .where(
      and(
        eq(projectRepos.provider, "local"),
        or(
          isNull(projectRepos.pauseReason),
          notInArray(projectRepos.pauseReason, ["gone", "broken"]),
        ),
        or(
          isNull(projectRepos.verifiedAt),
          lt(projectRepos.verifiedAt, new Date(now.getTime() - VERIFY_EVERY_MS)),
        ),
        // One no archive went into yet has nothing to read.
        isNotNull(projectRepos.headSha),
      ),
    )
    .orderBy(sql`${projectRepos.verifiedAt} asc nulls first`, asc(projectRepos.projectId))
    .limit(VERIFIED_PER_ROUND);
  let verified = 0;
  const broken: string[] = [];
  for (const { projectId } of due) {
    await withLock(db, ARCHIVE_LOCK, projectId, async () => {
      const link = await linkOf(db, projectId);
      if (!link || link.provider !== "local") return;
      try {
        await host.verify(placeOf(link) as LocalPlace);
      } catch (error) {
        if (!(error instanceof RepoPaused) || error.reason !== "broken") {
          // Gone, or the disk failing now: archives say so, and this looks again next time.
          log.warn(
            { project: projectId, err: describeError(error) },
            "a repository here was not read",
          );
          return;
        }
        log.error({ project: projectId, detail: error.message }, "a repository here is broken");
        await pauseLink(db, link, { reason: "broken", detail: error.message, at: now });
        broken.push(projectId);
      }
      await db.update(projectRepos).set({ verifiedAt: now }).where(sameLink(link));
      verified += 1;
    });
  }
  return { verified, broken };
};

/** Both rounds, as the worker has them. */
export const scheduleLocalChecks = async (
  boss: Jobs,
  options: {
    readonly db: Db;
    readonly host: LocalGitRepoHost;
    readonly log: Logger;
    readonly look: (projectId: string) => Promise<void>;
    readonly now?: () => Date;
  },
): Promise<void> => {
  const now = options.now ?? (() => new Date());
  const scans = { retryLimit: 0, expireInSeconds: 30 * 60, deleteAfterSeconds: 60 * 60 };
  await boss.createQueue(LOCAL_LOOK_QUEUE, { policy: "stately", ...scans });
  await boss.createQueue(LOCAL_VERIFY_QUEUE, { policy: "stately", ...scans });
  await boss.schedule(LOCAL_LOOK_QUEUE, "* * * * *");
  await boss.schedule(LOCAL_VERIFY_QUEUE, "41 * * * *");
  const seen = new Map<string, string>();
  await boss.work(LOCAL_LOOK_QUEUE, async () => {
    const moved = await pushedHere(options.db, options.host, seen);
    for (const project of moved) await options.look(project);
    if (moved.length > 0)
      options.log.info({ projects: moved.length }, "pushed into repositories here");
  });
  await boss.work(LOCAL_VERIFY_QUEUE, async () => {
    const { verified, broken } = await verifyDue(options.db, options.host, now(), options.log);
    if (verified > 0)
      options.log.info({ verified, broken: broken.length }, "repositories here read through");
  });
};
