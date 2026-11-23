import type { Executor } from "../database.ts";

/** How much a person has stored, and has on its way, in bytes. */
export interface Usage {
  readonly used: number;
  readonly uploading: number;
}

export const NO_USAGE: Usage = { used: 0, uploading: 0 };

/**
 * What people have stored (ready or being checked) and what they have on its way, from the table of
 * stored files that step 14.4 brings (`library_objects`). Until then nothing can be uploaded, and
 * nobody has used anything.
 */
export const usageOf = async (
  _db: Executor,
  _userIds?: readonly string[],
): Promise<ReadonlyMap<string, Usage>> => new Map();
