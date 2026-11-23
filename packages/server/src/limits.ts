import type { Executor } from "./database.ts";

/**
 * How much each person may have of what the server keeps for them (the registry of limits): one key
 * for each, asked of `PersonLimits` wherever the server checks, never as a number written there.
 * `null` is no limit. The keys come as the limits do; for now the room in the cloud space (bytes),
 * which the account page shows.
 *
 * Not to be mixed up with `Limits` of auth/limits.ts, which is how often a request may come.
 */
export type LimitKey = "cloudSpace";

export interface PersonLimits {
  of(db: Executor, userId: string, key: LimitKey): Promise<number | null>;
}

/** Nothing is limited. */
export const NO_LIMITS: PersonLimits = { of: async () => null };
