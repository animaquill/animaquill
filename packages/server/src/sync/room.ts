import { count, eq, sql } from "drizzle-orm";
import type { Executor, Tx } from "../database.ts";
import { lockPerson } from "../locks.ts";
import type { PersonLimits } from "../limits.ts";
import { projectCovers, projects } from "../schema.ts";

/**
 * What a person keeps on the platform, as the limits `storage.platform` and `projects.count` count
 * it (docs/design/online-offline.md 3.6): every project they own, drafts of AI too, and the bytes
 * of each (`projects.bytes`: its last snapshot and the updates after it, 0 for one let go of) with
 * its cover. Not counted: what is on GitHub and in the large file storage, the cloud space, the
 * pictures of conversations, the staging folder, the snapshots kept from before merges and what
 * batches keep to be taken back: the platform's own safety net.
 *
 * Where the limits are for the whole server (`scope` "server"), it is what everyone has.
 */
export const platformHeld = async (
  db: Executor,
  userId: string,
  scope: PersonLimits["scope"],
): Promise<{ readonly projects: number; readonly bytes: number }> => {
  const [row] = await db
    .select({
      projects: count(),
      bytes:
        sql<number>`coalesce(sum(${projects.bytes}), 0) + coalesce(sum(octet_length(${projectCovers.bytes})), 0)`.mapWith(
          Number,
        ),
    })
    .from(projects)
    .leftJoin(projectCovers, eq(projectCovers.projectId, projects.id))
    .where(scope === "server" ? undefined : eq(projects.ownerId, userId));
  return { projects: row?.projects ?? 0, bytes: row?.bytes ?? 0 };
};

/** Why one more project does not fit, with what is there and what may be. */
export type NoRoom =
  | { readonly detail: "count"; readonly used: number; readonly limit: number }
  | { readonly detail: "storage"; readonly used: number; readonly limit: number };

/**
 * Whether a person has room for one more project of `bytes` (0 where that is not known yet, as
 * restoring: then only one already over is refused). Holds the person until the transaction ends
 * (`lockPerson`), so that of two at once, the second counts the first: call it in the transaction
 * that makes the project, before it does. Only making a project asks; changes, merges, renaming and
 * a copy made again of one let go of never do, whatever is kept.
 */
export const roomFor = async (
  tx: Tx,
  limits: PersonLimits,
  userId: string,
  bytes: number,
): Promise<NoRoom | undefined> => {
  await lockPerson(tx, userId, limits.scope);
  const most = await limits.of(tx, userId, "projects.count");
  const room = await limits.of(tx, userId, "storage.platform");
  if (most === null && room === null) return undefined;
  const held = await platformHeld(tx, userId, limits.scope);
  if (most !== null && held.projects >= most)
    return { detail: "count", used: held.projects, limit: most };
  if (room !== null && held.bytes + bytes > room)
    return { detail: "storage", used: held.bytes, limit: room };
  return undefined;
};
