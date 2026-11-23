import type { AccessPolicy } from "../access.ts";
import { eq } from "drizzle-orm";
import type { Db } from "../database.ts";
import { projectRepos, projects, type CopyProblem } from "../schema.ts";
import { lockProject } from "./hub.ts";

/**
 * Asking for the working copy of a project that the platform let go of (`copy_state` "released",
 * see `SyncHub.release`): it is made again from the repository, by the worker (archive/rebuild.ts),
 * as a window says hello for it or people open it from their list (the plan of the redesign, 13.5).
 * Here only whether that can begin, and noting that it did ("restoring"), under the lock of the
 * project's id, so that two who ask at once begin it once; the caller queues the work. One that is
 * on its way already is queued again, which does nothing where it waits or runs: a worker that
 * stopped halfway leaves it so.
 */

/**
 * After making the copy failed, it is not tried again for this long at least, however often it is
 * asked for: GitHub is not asked over and over for what it said no to a moment ago. How long
 * exactly the failure says (`CopyProblem.retryAt`, see `retryDelayMs` of archive/rebuild.ts): longer
 * after each in a row, hours for what only people can put right.
 */
export const REBUILD_RETRY_MS = 60_000;

/**
 * Why a copy did not come that people may answer by asking for the branch as it is (`fromBranch`):
 * what the repository had did not make a project, which they can put right on GitHub.
 */
const BRANCH_MENDS: ReadonlySet<CopyProblem["code"]> = new Set([
  "unreadable",
  "notProject",
  "tooLarge",
  "tooNew",
]);

export type Wake =
  /** Not there, or not the person's. */
  | { readonly copy: "missing" }
  /** Here as it is. */
  | { readonly copy: "live" }
  /** On its way back from the repository: `queue`, the work is to be queued (again). */
  | { readonly copy: "restoring"; readonly queue: boolean }
  /**
   * It stays where it is: there is no repository to make it from ("noRepository"), or the
   * repository cannot be used ("unusable"); or it failed a moment ago, and is tried again from
   * `retryAt` on ("later"), with why (`problem`); or the branch was asked for where that is no
   * answer ("notAllowed"): only after a failure for what the repository had.
   */
  | {
      readonly copy: "released";
      readonly why: "noRepository" | "unusable" | "later" | "notAllowed";
      readonly problem?: CopyProblem;
      readonly retryAt?: number;
    };

/**
 * Begins making the working copy of a project again where the platform let go of it, see `Wake`,
 * for someone who may edit it (`AccessPolicy`, asked with the project locked): for anyone else it is
 * "missing". `fromBranch`: from the branch as
 * it is, not from the last archive, where that last failed for what the repository had, as after
 * people put it right on GitHub; at once, whenever the last try was. A copy made so has nothing in
 * common with the one before (`ReleasedFrom.commonBase`).
 */
export const wakeCopy = async (
  db: Db,
  id: string,
  who: { readonly userId: string; readonly access: AccessPolicy },
  now: Date,
  options: { readonly fromBranch?: boolean } = {},
): Promise<Wake> =>
  db.transaction(
    async (tx): Promise<Wake> => {
      await lockProject(tx, id);
      const [row] = await tx
        .select({
          ownerId: projects.ownerId,
          copyState: projects.copyState,
          copyProblem: projects.copyProblem,
        })
        .from(projects)
        .where(eq(projects.id, id))
        .for("update");
      if (!row || !(await who.access.may(tx, who.userId, { id, ownerId: row.ownerId }, "edit")))
        return { copy: "missing" };
      if (row.copyState === "live") return { copy: "live" };
      if (row.copyState === "restoring") return { copy: "restoring", queue: true };
      const problem = row.copyProblem ?? undefined;
      const fromBranch = options.fromBranch === true;
      if (fromBranch && (problem === undefined || !BRANCH_MENDS.has(problem.code)))
        return { copy: "released", why: "notAllowed", ...(problem && { problem }) };
      const [link] = await tx
        .select({ unusableSince: projectRepos.unusableSince })
        .from(projectRepos)
        .where(eq(projectRepos.projectId, id));
      if (!link) return { copy: "released", why: "noRepository" };
      if (link.unusableSince !== null) return { copy: "released", why: "unusable" };
      const retryAt = problem ? Math.max(problem.retryAt ?? 0, problem.at + REBUILD_RETRY_MS) : 0;
      if (problem && !fromBranch && now.getTime() < retryAt)
        return { copy: "released", why: "later", problem, retryAt };
      await tx
        .update(projects)
        .set({
          copyState: "restoring",
          rebuildFromBranch: fromBranch,
          rebuildStartedAt: null,
          // Somebody opens it: the copy that comes is not one nobody opened for a week.
          openedAt: now,
        })
        .where(eq(projects.id, id));
      return { copy: "restoring", queue: true };
    },
    { isolationLevel: "read committed" },
  );
