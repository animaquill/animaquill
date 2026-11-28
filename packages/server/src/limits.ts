import type { Executor } from "./database.ts";

/**
 * How much each person may have of what the server keeps or does for them: the registry of limits
 * of the server. One key for each, asked of `PersonLimits` wherever the server
 * checks, never as a number written there. `null` is no limit. Only what can differ from person to
 * person, or from plan to plan, is here: the limits of the engineering (the bytes of one project,
 * the conversations of one project, how often a request may come) stay constants where they are.
 *
 * Not to be mixed up with `Limits` of auth/limits.ts, which is how often a request may come, nor
 * with `SyncLimits` of sync/hub.ts, which are the hub's own.
 */

export type LimitUnit = "bytes" | "count" | "minutes";

export interface LimitInfo {
  readonly unit: LimitUnit;
  /** What it is, in a few words, for the admin site and the log. */
  readonly what: string;
  /**
   * Where it is checked, each `<side>:<file>`: `server:` of this package (src/), `platform:` of
   * the API of a platform built on this server (its own sources). A test of each side looks that each
   * file names the key.
   */
  readonly checks: readonly string[];
}

export const LIMIT_KEYS = {
  "storage.platform": {
    unit: "bytes",
    what: "projects kept on the platform, with their covers",
    checks: ["server:sync/room.ts"],
  },
  "projects.count": {
    unit: "count",
    what: "projects kept on the platform",
    checks: ["server:sync/room.ts"],
  },
  "storage.cloud": {
    unit: "bytes",
    what: "files in the cloud space",
    checks: ["server:me/routes.ts"],
  },
  "chat.images": {
    unit: "bytes",
    what: "pictures of the conversations with AI",
    checks: ["server:me/chat-images.ts"],
  },
  "chat.history": {
    unit: "bytes",
    what: "conversations with AI",
    checks: ["server:me/chats.ts"],
  },
  "lfs.downloads.daily": {
    unit: "bytes",
    what: "large files downloaded through the server in a day",
    checks: ["server:lfs/downloads.ts"],
  },
  "ai.workspaces": {
    unit: "count",
    what: "workspaces of cloud AI at once",
    checks: ["platform:ai/scheduler.ts"],
  },
  "ai.minutes.monthly": {
    unit: "minutes",
    what: "time of cloud AI in a month",
    checks: ["platform:ai/scheduler.ts", "platform:ai/sweep.ts"],
  },
  "ai.memory": {
    unit: "bytes",
    what: "memory of one task of cloud AI",
    checks: ["platform:ai/scheduler.ts"],
  },
} as const satisfies Record<string, LimitInfo>;

export type LimitKey = keyof typeof LIMIT_KEYS;

export const LIMIT_KEY_LIST = Object.keys(LIMIT_KEYS) as readonly LimitKey[];

export const isLimitKey = (key: string): key is LimitKey => Object.hasOwn(LIMIT_KEYS, key);

export type LimitValues = Readonly<Record<LimitKey, number | null>>;

export interface PersonLimits {
  /**
   * Who a value is for: each person ("person", the platform's plans), or the whole server
   * ("server", the open-source server, whose limits are its settings, AQ_LIMITS): there, what is
   * counted against the platform's storage and projects is what everyone on the server has.
   */
  readonly scope: "person" | "server";
  /** What a person may have of one: null for no limit. Never cached: asked where it is checked. */
  of(db: Executor, userId: string, key: LimitKey): Promise<number | null>;
  /** All of them, for what a person is shown. */
  all(db: Executor, userId: string): Promise<LimitValues>;
}

/** Each of `of`, one after the other: for those that have nothing quicker. */
export const allOf = async (
  limits: Pick<PersonLimits, "of">,
  db: Executor,
  userId: string,
): Promise<LimitValues> => {
  const values: Record<string, number | null> = {};
  for (const key of LIMIT_KEY_LIST) values[key] = await limits.of(db, userId, key);
  return values as LimitValues;
};

/** The same values for everyone: what is not given is not limited. */
export const fixedLimits = (
  values: Readonly<Partial<Record<LimitKey, number | null>>>,
  scope: PersonLimits["scope"] = "person",
): PersonLimits => {
  const all = Object.fromEntries(
    LIMIT_KEY_LIST.map((key) => [key, values[key] ?? null]),
  ) as LimitValues;
  return {
    scope,
    of: async (_db, _userId, key) => all[key],
    all: async () => all,
  };
};

/** Nothing is limited, as on a server of its own where nothing is said. */
export const NO_LIMITS: PersonLimits = fixedLimits({}, "server");

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const notBytes = (key: LimitKey) => `${key} has to be bytes, like 20GB, 500MB or 1048576`;
const notWhole = (key: LimitKey) => `${key} has to be a whole number, 0 or more`;

/** A value as AQ_LIMITS writes it, or why it is not one. */
const valueOf = (key: LimitKey, value: unknown): number | null | { readonly problem: string } => {
  if (value === null) return null;
  const bytes = LIMIT_KEYS[key].unit === "bytes";
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0
      ? value
      : { problem: bytes ? notBytes(key) : notWhole(key) };
  if (typeof value !== "string" || !bytes)
    return { problem: bytes ? notBytes(key) : notWhole(key) };
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  const times = match ? BYTE_UNITS[(match[2] || "b").toLowerCase()] : undefined;
  if (!match || times === undefined) return { problem: notBytes(key) };
  const total = Math.round(Number(match[1]) * times);
  return Number.isSafeInteger(total) ? total : { problem: notBytes(key) };
};

/**
 * AQ_LIMITS, a JSON object of keys of `LIMIT_KEYS` (`{"storage.platform":"20GB","ai.workspaces":2}`):
 * a whole number, bytes with a unit (KB, MB, GB, TB, each of 1024, as KiB, MiB…), or null for no
 * limit. What is left out is not limited. Whatever is wrong is said, all of it, in `problems`,
 * which stops the server from starting (config.ts).
 */
export const parseLimits = (
  text: string | undefined,
): {
  readonly values: Readonly<Partial<Record<LimitKey, number | null>>>;
  readonly problems: readonly string[];
} => {
  if (text === undefined || text.trim() === "") return { values: {}, problems: [] };
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return { values: {}, problems: ["AQ_LIMITS has to be a JSON object"] };
  }
  if (typeof read !== "object" || read === null || Array.isArray(read))
    return { values: {}, problems: ["AQ_LIMITS has to be a JSON object"] };
  const values: Partial<Record<LimitKey, number | null>> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(read)) {
    if (!isLimitKey(key)) {
      problems.push(`AQ_LIMITS: ${key.slice(0, 60)} is no limit (${LIMIT_KEY_LIST.join(", ")})`);
      continue;
    }
    const parsed = valueOf(key, value);
    if (typeof parsed === "object" && parsed !== null)
      problems.push(`AQ_LIMITS: ${parsed.problem}`);
    else values[key] = parsed;
  }
  return { values, problems };
};
