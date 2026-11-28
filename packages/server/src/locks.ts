import { sql } from "drizzle-orm";
import type { Tx } from "./database.ts";

/**
 * The spaces of the advisory locks the server takes, each of one kind of thing, so that two kinds
 * never share a lock by chance. Others are next to what they hold: `PROJECT_LOCK` (sync/hub.ts),
 * `ARCHIVE_LOCK` (archive/links.ts), `LFS_LOCK` (lfs/uploads.ts).
 */

/**
 * The space of the locks on people, for counting what they have while a project is made: two new
 * projects at once (the hub's `#create`, restoring from a repository) do not both find room for one
 * more, see sync/room.ts.
 */
export const PERSON_LOCK = 0x61712d75; // "aq-u"

/**
 * Holds a person until the transaction ends, against any other transaction that does. Where limits
 * are for the whole server (`PersonLimits.scope` "server"), everyone shares one lock.
 */
export const lockPerson = async (
  tx: Tx,
  userId: string,
  scope: "person" | "server" = "person",
): Promise<void> => {
  const key = scope === "server" ? "*" : userId;
  await tx.execute(sql`select pg_advisory_xact_lock(${PERSON_LOCK}, hashtext(${key}))`);
};
