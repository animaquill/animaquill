import { eq, sql } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { describeError, type Executor, type Logger } from "./database.ts";
import { settings } from "./schema.ts";

/**
 * Settings that admins change while the platform runs: one row of `settings` a key, its value as
 * JSON that the code checks, and a version that goes up with each change. What is not there, or is
 * not what the code takes, has the default the code has. The API reads each at most every ten
 * seconds, so a change is in force within ten seconds everywhere.
 */

export interface Setting<T> {
  readonly key: string;
  /** What it is when nobody set it. */
  readonly fallback: T;
  /** The value as the code takes it, or undefined for what it does not take. */
  read(value: unknown): T | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The relay of AI services (relay/routes.ts): on unless an admin turned it off. LLM_RELAY=off in the
 * environment turns it off whatever this says.
 */
export const RELAY_SETTING: Setting<{ readonly enabled: boolean }> = {
  key: "relay",
  fallback: { enabled: true },
  read: (value) =>
    isRecord(value) && typeof value.enabled === "boolean" ? { enabled: value.enabled } : undefined,
};

/** How long a setting that was read is taken as it is. */
export const SETTINGS_KEEP_MS = 10_000;

/** The settings as the API reads them, each kept for a while. */
export class Settings {
  readonly #db: Executor;
  readonly #keepMs: number;
  readonly #now: () => number;
  readonly #log: Logger | undefined;
  readonly #kept = new Map<string, { readonly value: unknown; readonly at: number }>();
  readonly #reading = new Map<string, Promise<unknown>>();

  constructor(options: {
    readonly db: Executor;
    readonly keepMs?: number;
    readonly now?: () => number;
    readonly log?: Logger;
  }) {
    this.#db = options.db;
    this.#keepMs = options.keepMs ?? SETTINGS_KEEP_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  /**
   * The setting now. When the database cannot say, what was read last, or the default: a setting
   * must never take down what it is about.
   */
  async get<T>(setting: Setting<T>): Promise<T> {
    const kept = this.#kept.get(setting.key);
    if (kept && this.#now() - kept.at < this.#keepMs) return kept.value as T;
    let reading = this.#reading.get(setting.key) as Promise<T> | undefined;
    if (!reading) {
      reading = this.#read(setting, kept?.value as T | undefined).finally(() =>
        this.#reading.delete(setting.key),
      );
      this.#reading.set(setting.key, reading);
    }
    return reading;
  }

  async #read<T>(setting: Setting<T>, before: T | undefined): Promise<T> {
    try {
      const value = await readSetting(this.#db, setting);
      this.#kept.set(setting.key, { value, at: this.#now() });
      return value;
    } catch (error) {
      this.#log?.warn(
        { err: describeError(error), setting: setting.key },
        "a setting was not read",
      );
      return before ?? setting.fallback;
    }
  }
}

/** A setting as the database has it now, with its version: 0 when nobody set it. */
export const readSettingRow = async <T>(
  db: Executor,
  setting: Setting<T>,
): Promise<{ readonly value: T; readonly version: number; readonly updatedAt: Date | null }> => {
  const [row] = await db
    .select({ value: settings.value, version: settings.version, updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, setting.key));
  const value = row === undefined ? undefined : setting.read(row.value);
  return {
    value: value ?? setting.fallback,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
};

export const readSetting = async <T>(db: Executor, setting: Setting<T>): Promise<T> =>
  (await readSettingRow(db, setting)).value;

/**
 * Changes a setting, and notes it in the record (`audit`, where there is one), in one transaction: by
 * a person (`adminId`), or by the command line on the server (`adminId` null). Setting what it is
 * already changes nothing.
 */
export const changeSetting = <T extends Readonly<Record<string, string | number | boolean | null>>>(
  db: Executor,
  setting: Setting<T>,
  value: T,
  {
    adminId,
    now = new Date(),
    audit,
  }: { readonly adminId: string | null; readonly now?: Date; readonly audit?: Audit | undefined },
): Promise<{ readonly changed: boolean; readonly version: number }> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: settings.value, version: settings.version })
      .from(settings)
      .where(eq(settings.key, setting.key))
      .for("update");
    const current = row === undefined ? undefined : setting.read(row.value);
    if (row && current !== undefined && JSON.stringify(current) === JSON.stringify(value))
      return { changed: false, version: row.version };
    // Counted on from what is there, also should another change have made the row meanwhile.
    const [written] = await tx
      .insert(settings)
      .values({ key: setting.key, value, version: 1, updatedBy: adminId, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, version: sql`${settings.version} + 1`, updatedBy: adminId, updatedAt: now },
      })
      .returning({ version: settings.version });
    await audit?.record(tx, {
      by: adminId,
      action: "setting.change",
      target: `setting:${setting.key}`,
      detail: value,
      at: now,
    });
    return { changed: true, version: written!.version };
  });
