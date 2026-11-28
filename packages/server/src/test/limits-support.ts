import { fixedLimits, type LimitKey, type PersonLimits } from "../limits.ts";

/**
 * Limits a test changes as it goes, the same for everyone (limits.ts): asked anew each time, as the
 * platform's are, so that what is set is what the next check goes by.
 */
export const changeableLimits = (
  scope: PersonLimits["scope"] = "person",
): PersonLimits & {
  set(values: Readonly<Partial<Record<LimitKey, number | null>>>): void;
  readonly asked: [string, LimitKey][];
} => {
  let values = fixedLimits({});
  const asked: [string, LimitKey][] = [];
  return {
    scope,
    asked,
    set(next) {
      values = fixedLimits(next);
    },
    of: async (db, userId, key) => {
      asked.push([userId, key]);
      return values.of(db, userId, key);
    },
    all: (db, userId) => values.all(db, userId),
  };
};

/** Numbers from 0 to 1 that are the same each run, for tests that try many orders. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
