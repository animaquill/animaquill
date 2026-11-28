import { count, desc, eq, sql } from "drizzle-orm";
import type { Executor } from "../database.ts";
import type { PersonLimits } from "../limits.ts";
import {
  projectCovers,
  projectRepos,
  projects,
  repoConflicts,
  repoMerges,
  type CopyState,
} from "../schema.ts";
import { blockOf, whyNotReleasable, type ReleaseBlock } from "../sync/releasable.ts";
import { platformHeld } from "../sync/room.ts";

/**
 * What a person keeps on the platform, for the storage page of the start page and the dialog that
 * says it is full (docs/design/online-offline.md of AnimaQuill Cloud, 3.6): the bytes and the
 * projects it counts against `storage.platform` and `projects.count` (sync/room.ts), and each of
 * their own projects, the largest first, with whether its working copy can be let go of now
 * (`releasable`), or why not (`why`, see `ReleaseBlock`). What is said of that is as the rows are
 * now: letting go of one looks again, in its lock, and at its repository.
 */
export interface PlatformKept {
  /** Bytes they may keep; null for no limit. */
  readonly limit: number | null;
  readonly used: number;
  /** Projects they may keep, and keep. */
  readonly count: { readonly limit: number | null; readonly used: number };
  readonly projects: readonly PlatformProject[];
}

export interface PlatformProject {
  readonly id: string;
  readonly name: string;
  /** Its working copy and its cover, as counted. */
  readonly bytes: number;
  readonly state: CopyState;
  /** For a "live" one: true where it can be let go of now, otherwise `why` says why not. */
  readonly releasable?: true;
  readonly why?: ReleaseBlock;
}

/** Projects of a person listed at most: as many as they may have (`projects.count`), and more. */
const LISTED_MOST = 2000;

export const platformKept = async (
  db: Executor,
  userId: string,
  limits: PersonLimits,
  now: Date,
): Promise<PlatformKept> => {
  const limit = await limits.of(db, userId, "storage.platform");
  const most = await limits.of(db, userId, "projects.count");
  const held = await platformHeld(db, userId, limits.scope);
  const bytes = sql<number>`${projects.bytes} + coalesce(octet_length(${projectCovers.bytes}), 0)`;
  const merges = db
    .select({ projectId: repoMerges.projectId, count: count().as("merges") })
    .from(repoMerges)
    .where(eq(repoMerges.state, "ready"))
    .groupBy(repoMerges.projectId)
    .as("merges");
  const conflicts = db
    .select({ projectId: repoConflicts.projectId, count: count().as("conflicts") })
    .from(repoConflicts)
    .where(eq(repoConflicts.state, "open"))
    .groupBy(repoConflicts.projectId)
    .as("conflicts");
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      bytes: bytes.mapWith(Number),
      copyState: projects.copyState,
      head: projects.head,
      dirtySince: projects.dirtySince,
      linkingUntil: projects.linkingUntil,
      link: {
        projectId: projectRepos.projectId,
        state: projectRepos.state,
        pauseReason: projectRepos.pauseReason,
        detail: projectRepos.detail,
        archivedSeq: projectRepos.archivedSeq,
        headSha: projectRepos.headSha,
        requestedAt: projectRepos.requestedAt,
        failures: projectRepos.failures,
        transientSince: projectRepos.transientSince,
        unusableSince: projectRepos.unusableSince,
        unusableSeenAt: projectRepos.unusableSeenAt,
        pendingSha: projectRepos.pendingSha,
        dropping: projectRepos.dropping,
        droppingMerge: projectRepos.droppingMerge,
      },
      merges: sql<number>`coalesce(${merges.count}, 0)`.mapWith(Number),
      conflicts: sql<number>`coalesce(${conflicts.count}, 0)`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(projectCovers, eq(projectCovers.projectId, projects.id))
    .leftJoin(projectRepos, eq(projectRepos.projectId, projects.id))
    .leftJoin(merges, eq(merges.projectId, projects.id))
    .leftJoin(conflicts, eq(conflicts.projectId, projects.id))
    // Only their own, whatever else they may see: it is theirs that counts, and theirs to let go.
    .where(eq(projects.ownerId, userId))
    .orderBy(desc(bytes), desc(projects.updatedAt))
    .limit(LISTED_MOST);
  return {
    limit,
    used: held.bytes,
    count: { limit: most, used: held.projects },
    projects: rows.map((row): PlatformProject => {
      const { link } = row;
      const shown = { id: row.id, name: row.name, bytes: row.bytes, state: row.copyState };
      if (row.copyState !== "live") return shown;
      const refusal = whyNotReleasable(
        {
          copyState: row.copyState,
          head: row.head,
          dirtySince: row.dirtySince,
          linkingUntil: row.linkingUntil,
          link: link?.projectId == null ? undefined : link,
          mergesReady: row.merges,
          conflictsOpen: row.conflicts,
          held: false,
        },
        now,
      );
      const why = refusal && blockOf(refusal);
      return why ? { ...shown, why } : { ...shown, releasable: true };
    }),
  };
};
