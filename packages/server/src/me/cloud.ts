import { eq } from "drizzle-orm";
import type { Tx } from "../database.ts";
import { userPrefs } from "../schema.ts";

/**
 * The row of a person in `user_prefs`, which what is the person's alone takes as a lock: the room
 * of their pictures (me/chat-images.ts), and what they said about the large file storage of GitHub
 * (me/lfs.ts). Which cloud features go with the account is up to each device: the platform keeps no
 * switches for them.
 */

/**
 * Has the row of the person in `user_prefs`, and holds it until the transaction is over: `share`
 * for reading what the lock is for, `update` for changing it.
 */
export const lockPrefs = async (tx: Tx, userId: string, mode: "share" | "update") => {
  await tx.insert(userPrefs).values({ userId }).onConflictDoNothing();
  const [row] = await tx.select().from(userPrefs).where(eq(userPrefs.userId, userId)).for(mode);
  return row!;
};
