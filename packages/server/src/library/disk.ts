import { statfs as statfsOf } from "node:fs/promises";

/**
 * The last of the four limits of the test storage: with less than `LIBRARY_MIN_FREE_GB` free on the
 * server's disk, nothing new goes into the cloud space. Step 14.4 asks this before each upload it
 * lets begin.
 *
 * The API's container has its root on the server's one partition (Docker's overlay lives there, and
 * so do the database and /srv/animaquill/objects), so its `/` says how full that partition is.
 */

export interface DiskRoom {
  /** Bytes free for what is not root, or null when the disk could not be asked. */
  readonly free: number | null;
  /** What has to stay free. */
  readonly floor: number;
  /** Whether new uploads may begin: never when the disk could not be asked, unless there is no floor. */
  readonly enough: boolean;
}

export const diskRoom = async (
  floor: number,
  {
    path = "/",
    statfs = statfsOf,
  }: { readonly path?: string; readonly statfs?: typeof statfsOf } = {},
): Promise<DiskRoom> => {
  let free: number | null = null;
  try {
    const stats = await statfs(path);
    free = stats.bavail * stats.bsize;
  } catch {}
  return { free, floor, enough: floor <= 0 || (free !== null && free >= floor) };
};
