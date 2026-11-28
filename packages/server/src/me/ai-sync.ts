import {
  AI_SYNC_BATCH,
  AI_SYNC_BYTES,
  AI_SYNC_FORMAT,
  AI_SYNC_KEYS,
  AI_KEY_LENGTH,
  DELETED_KEPT,
  SERVICE_ID,
  checkAiEntry,
  isEntryName,
  isLaterEntry,
  mergeSecret,
  readSecretTimes,
  jsonBytes,
  readServiceSecret,
  type AiEntry,
  type SecretTimes,
  type ServiceSecret,
} from "@animaquill/host/ai-sync";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { retryOnDeadlock, type Db, type Tx } from "../database.ts";
import { userAiKeys, userAiSettings, users } from "../schema.ts";
import { SealError, type Sealer } from "../seal.ts";
import { timeOf } from "../sync/organize.ts";

/** Whether two values are the same as JSON, whatever the order of their fields. */
const sameJson = (a: unknown, b: unknown): boolean => {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .toSorted()
              .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/** When each part of what is secret changed, by the platform's clock. */
const timesOf = (times: SecretTimes, time: (at: number) => number): SecretTimes =>
  Object.fromEntries(Object.entries(times).map(([field, at]) => [field, time(at)]));

/**
 * The AI settings and keys of a person that go with their account, see `AiSyncAccess` of the
 * editor's host and `@animaquill/host/ai-sync` for what an entry is. Only ever of the person who is
 * signed in.
 *
 * Nothing is taken whole: each entry and each key goes by when it last changed, as the editor says
 * (`at`, by its clock, which `now` says as it sends them, as the organizer of the start page does),
 * the later wins, and one taken away on a tie. One taken away stays as such, by its name, so that a
 * device that changed it before, however long ago, does not bring it back: the newest
 * `DELETED_KEPT` of entries, and as many of keys, see `forgetOldMarks`.
 *
 * What is secret of each service (`ServiceSecret`: its key, address and headers) is sealed with the
 * master key, bound to its person and service, so the database and its backups alone open none. It
 * is opened for the person it is of only, as they ask for their settings; nothing here ever logs
 * one. An editor of before 0.3.72 gives and reads the key alone (`format` 1 of `user_ai_keys`).
 *
 * The online mode of the editor has them here only: it reads them as a page starts and writes each
 * change here at once; a page keeps the keys in its memory only, never in the browser's storage.
 * The platform can open what it sealed, as people are told in the settings, for the relay and AI in
 * the cloud.
 */

/** What is secret of a service is sealed as. */
const PURPOSE = "ai-key";
/** What `user_ai_keys.sealed` has in it: a `ServiceSecret` as JSON (1 was the key alone, before 0.3.72). */
const SECRET = 2;
/** How many keys a person has at most; of those taken away, see `DELETED_KEPT`. */
const KEYS_KEPT = 2 * AI_SYNC_KEYS;

export const keyContext = (userId: string, service: string) => `${userId}/${service}`;

export interface EntryChange {
  readonly name: string;
  readonly at: number;
  readonly value?: unknown;
  readonly deleted?: true;
}

export interface KeyChange {
  readonly service: string;
  readonly at: number;
  readonly secret?: ServiceSecret;
  /** When each part of it changed, see `mergeSecret`: missing, all as `at`. */
  readonly fieldsAt?: SecretTimes;
  readonly deleted?: true;
}

export interface AiSyncChanges {
  readonly account: string;
  readonly now?: number;
  readonly format: number;
  readonly entries: readonly EntryChange[];
  readonly keys: readonly KeyChange[];
}

/** What is secret of a service as it is answered: `key` too, for editors of before 0.3.72. */
export type KeyState = {
  at: number;
  secret?: ServiceSecret;
  fieldsAt?: SecretTimes;
  key?: string;
  deleted?: true;
};

/** Everything a person has, by the platform's clock: what is secret opened, for them only. */
/**
 * Said only for pages of before 0.3.72, which take an answer without it for something that cannot
 * be read: whether the settings go is up to each device now. To go once no such page is left (from
 * 0.3.75 on, with `OLDEST_EDITOR` long past 0.3.72).
 */
export const OLD_PAGES = { enabled: true } as const;

export interface AiSyncState {
  readonly enabled: true;
  readonly account: string;
  readonly revision: number;
  readonly format: number;
  readonly entries: Readonly<Record<string, AiEntry>>;
  readonly keys: Readonly<Record<string, KeyState>>;
  /**
   * The services whose secret is kept but does not open with the master keys there are (as after
   * `master.key` of `npx animaquill` was lost): left out of `keys`, as if there were none, so that
   * a device gives it again, and named here, so that people are told to. Missing where there are
   * none; pages of before ignore it.
   */
  readonly unreadable?: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const LATEST = 10_000_000_000_000;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= LATEST;

/**
 * What a request gives, or undefined where it is not made as it should be. Whether each entry can
 * be what its name says is checked as it is kept, on its own (`refused`).
 */
export const aiChangesOf = (body: unknown): AiSyncChanges | undefined => {
  if (!isObject(body)) return undefined;
  const { account, now, format, entries = [], keys = [] } = body;
  if (typeof account !== "string" || account === "") return undefined;
  if (now !== undefined && !isTime(now)) return undefined;
  if (typeof format !== "number" || !Number.isSafeInteger(format) || format < 1) return undefined;
  if (!Array.isArray(entries) || entries.length > AI_SYNC_BATCH) return undefined;
  if (!Array.isArray(keys) || keys.length > AI_SYNC_KEYS) return undefined;
  const readEntries: EntryChange[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || !isEntryName(entry.name) || !isTime(entry.at)) return undefined;
    if (entry.deleted === true) readEntries.push({ name: entry.name, at: entry.at, deleted: true });
    else if (entry.deleted === undefined && "value" in entry && entry.value !== undefined)
      readEntries.push({ name: entry.name, at: entry.at, value: entry.value });
    else return undefined;
  }
  const readKeys: KeyChange[] = [];
  for (const key of keys) {
    if (!isObject(key) || typeof key.service !== "string" || !SERVICE_ID.test(key.service))
      return undefined;
    if (!isTime(key.at)) return undefined;
    if (key.deleted === true) {
      readKeys.push({ service: key.service, at: key.at, deleted: true });
      continue;
    }
    if (key.deleted !== undefined) return undefined;
    // An editor of before 0.3.72 gives the key alone.
    const secret =
      key.secret !== undefined
        ? readServiceSecret(key.secret)
        : typeof key.key === "string" && key.key.length > 0 && key.key.length <= AI_KEY_LENGTH
          ? { key: key.key }
          : undefined;
    if (!secret) return undefined;
    // The key alone is all that changed of it.
    const fieldsAt = key.secret === undefined ? { key: key.at } : readSecretTimes(key.fieldsAt);
    readKeys.push({
      service: key.service,
      at: key.at,
      secret,
      ...(fieldsAt && { fieldsAt }),
    });
  }
  return {
    account,
    ...(typeof now === "number" && { now }),
    format,
    entries: readEntries,
    keys: readKeys,
  };
};

type SettingsRow = typeof userAiSettings.$inferSelect;

/** The entries as kept: whatever is not made as an entry is not one. */
const entriesIn = (value: unknown): Record<string, AiEntry> => {
  const entries: Record<string, AiEntry> = {};
  if (!isObject(value)) return entries;
  for (const [name, entry] of Object.entries(value)) {
    if (!isObject(entry) || !isTime(entry.at)) continue;
    entries[name] =
      entry.deleted === true
        ? { at: entry.at, deleted: true }
        : { at: entry.at, value: entry.value };
  }
  return entries;
};

/** What is secret of a service, sealed for its person, as `user_ai_keys` keeps it. */
export const sealSecret = (
  sealer: Sealer,
  userId: string,
  service: string,
  secret: ServiceSecret,
) => sealer.seal(JSON.stringify(secret), PURPOSE, keyContext(userId, service));

/**
 * What is secret of a service as kept, opened. Throws a `SealError` where it does not open;
 * undefined where it opens to something that is not one, as a row of another format.
 */
export const openSecret = (
  sealer: Sealer,
  userId: string,
  row: {
    readonly service: string;
    readonly sealed: Buffer;
    readonly format: number;
  },
): ServiceSecret | undefined => {
  const opened = sealer.open(row.sealed, PURPOSE, keyContext(userId, row.service));
  if (row.format !== SECRET) return undefined;
  try {
    return readServiceSecret(JSON.parse(opened));
  } catch {
    return undefined;
  }
};

const readKeys = async (
  db: Db | Tx,
  sealer: Sealer,
  userId: string,
  log: (what: string) => void,
): Promise<{ keys: AiSyncState["keys"]; unreadable: string[] }> => {
  const rows = await db.select().from(userAiKeys).where(eq(userAiKeys.userId, userId));
  const keys: Record<string, KeyState> = {};
  const unreadable: string[] = [];
  for (const row of rows) {
    if (!row.sealed) {
      keys[row.service] = { at: row.at.getTime(), deleted: true };
      continue;
    }
    try {
      const secret = openSecret(sealer, userId, { ...row, sealed: row.sealed });
      if (!secret) {
        log("what is secret of an AI service is not one");
        continue;
      }
      const fieldsAt = readSecretTimes(row.fieldsAt);
      keys[row.service] = {
        at: row.at.getTime(),
        secret,
        ...(fieldsAt && { fieldsAt }),
        ...(secret.key !== undefined && { key: secret.key }),
      };
    } catch (error) {
      // Sealed with a master key that is gone: as if there were none, so the device gives it again.
      if (!(error instanceof SealError)) throw error;
      log(error.message);
      unreadable.push(row.service);
    }
  }
  return { keys, unreadable: unreadable.toSorted() };
};

const stateOf = async (
  db: Db | Tx,
  sealer: Sealer,
  userId: string,
  row: SettingsRow | undefined,
  log: (what: string) => void,
): Promise<AiSyncState> => {
  const { keys, unreadable } = await readKeys(db, sealer, userId, log);
  return {
    ...OLD_PAGES,
    account: userId,
    revision: row?.revision ?? 0,
    // Nothing kept yet is of the first format: any editor can begin it.
    format: row?.format ?? 1,
    entries: entriesIn(row?.entries),
    keys,
    ...(unreadable.length > 0 && { unreadable }),
  };
};

/** Everything `userId` has, or only its revision where that is still `since`. */
export const readAiSync = async (
  db: Db,
  sealer: Sealer,
  userId: string,
  since: number | undefined,
  log: (what: string) => void,
): Promise<AiSyncState | { revision: number; unchanged: true; enabled: true }> => {
  const [row] = await db.select().from(userAiSettings).where(eq(userAiSettings.userId, userId));
  if (since !== undefined && (row?.revision ?? 0) === since)
    return { revision: since, unchanged: true, ...OLD_PAGES };
  return stateOf(db, sealer, userId, row, log);
};

export type AiSyncOutcome =
  | {
      readonly state: AiSyncState;
      /** Not taken: not what their name says, or beyond as many as a person has. */
      readonly refused: readonly string[];
      /** Not taken: the entries would be larger than `AI_SYNC_BYTES` with them. */
      readonly tooLarge: readonly string[];
    }
  | "newer";

/**
 * Lets go of the oldest marks of entries taken away beyond `DELETED_KEPT`. A mark stays otherwise,
 * whatever its age, so that a device that had the entry from before, however long it was away,
 * does not bring it back. Only once more than `DELETED_KEPT` different names were taken away can
 * the oldest of them come back from a device that was away since before they were.
 */
const forgetOldMarks = (entries: Record<string, AiEntry>): boolean => {
  const marks = Object.entries(entries)
    .filter(([, entry]) => entry.deleted)
    .toSorted(([, a], [, b]) => b.at - a.at);
  for (const [name] of marks.slice(DELETED_KEPT)) delete entries[name];
  return marks.length > DELETED_KEPT;
};

/** The same of keys taken away (`sealed` null): the newest `DELETED_KEPT` stay. */
const forgetOldKeyMarks = async (tx: Tx, userId: string): Promise<void> => {
  const old = await tx
    .select({ service: userAiKeys.service })
    .from(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), isNull(userAiKeys.sealed)))
    .orderBy(desc(userAiKeys.at), asc(userAiKeys.service))
    .offset(DELETED_KEPT);
  if (old.length === 0) return;
  await tx.delete(userAiKeys).where(
    and(
      eq(userAiKeys.userId, userId),
      isNull(userAiKeys.sealed),
      inArray(
        userAiKeys.service,
        old.map(({ service }) => service),
      ),
    ),
  );
};

/** How many bytes an entry adds to the entries as JSON: its name, a colon, it, and a comma. */
const bytesOf = (name: string, entry: AiEntry) => jsonBytes(name) + 1 + jsonBytes(entry) + 1;

/**
 * Keeps what `userId` changed, as the rules above say, in one transaction, and answers everything
 * as it is then, with what it did not take of the entries (by name) and keys (`key:<service>`).
 * Keys go whatever the entries come to, so that taking one away or changing it always goes. An
 * entry that would make the entries larger than `AI_SYNC_BYTES` is not taken (`tooLarge`); what
 * takes something away always is. A key the platform cannot open any more (the master key changed)
 * is as if it were not there: whatever a device gives takes its place. "newer" where a newer editor
 * wrote the entries.
 */
export const applyAiSync = (
  db: Db,
  sealer: Sealer,
  userId: string,
  changes: AiSyncChanges,
  now: number,
  log: (what: string) => void,
): Promise<AiSyncOutcome> =>
  retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("no key update");
      await tx.insert(userAiSettings).values({ userId }).onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, userId))
        .for("update");
      if (!row) throw new Error("the settings of a person are not there");
      if (row.format > changes.format) return "newer" as const;
      const time = (at: number) => timeOf(at, changes.now, now).getTime();
      const refused: string[] = [];
      const tooLarge: string[] = [];
      // Turned off for all devices before that was up to each (0.3.72): what is given now is all.
      const entries = row.enabled ? entriesIn(row.entries) : {};
      let changed = !row.enabled;
      const sizes = new Map(
        Object.entries(entries).map(([name, entry]) => [name, bytesOf(name, entry)]),
      );
      let size = 2 + [...sizes.values()].reduce((sum, each) => sum + each, 0);
      for (const change of changes.entries) {
        if (!change.deleted && !checkAiEntry(change.name, change.value)) {
          refused.push(change.name);
          continue;
        }
        const at = time(change.at);
        const incoming: AiEntry = change.deleted
          ? { at, deleted: true }
          : { at, value: change.value };
        if (!isLaterEntry(entries[change.name], incoming)) continue;
        const bytes = bytesOf(change.name, incoming);
        const grown = size - (sizes.get(change.name) ?? 0) + bytes;
        if (!change.deleted && grown - 1 > AI_SYNC_BYTES) {
          tooLarge.push(change.name);
          continue;
        }
        entries[change.name] = incoming;
        sizes.set(change.name, bytes);
        size = grown;
        changed = true;
      }

      const kept = new Map(
        (
          await tx
            .select({
              service: userAiKeys.service,
              at: userAiKeys.at,
              sealed: userAiKeys.sealed,
              format: userAiKeys.format,
              fieldsAt: userAiKeys.fieldsAt,
            })
            .from(userAiKeys)
            .where(eq(userAiKeys.userId, userId))
            .for("update")
        ).map((each) => [each.service, each]),
      );
      /** What is kept of a service, opened; undefined where it does not open any more. */
      const opened = (stored: {
        service: string;
        sealed: Buffer;
        format: number;
      }): ServiceSecret | undefined => {
        try {
          return openSecret(sealer, userId, stored);
        } catch (error) {
          if (!(error instanceof SealError)) throw error;
          return undefined;
        }
      };
      for (const change of changes.keys) {
        const at = time(change.at);
        const fieldsAt = change.fieldsAt && timesOf(change.fieldsAt, time);
        const before = kept.get(change.service);
        // One that does not open any more is none: whatever a device gives takes its place.
        const was = before?.sealed ? opened({ ...before, sealed: before.sealed }) : undefined;
        const counts = before && (before.sealed === null || was !== undefined);
        let secret = change.secret;
        let times = fieldsAt;
        let latest = at;
        if (before?.sealed && was !== undefined && change.secret) {
          // Both there: part by part, the later of each, so that two devices that each changed
          // another part keep both.
          const merged = mergeSecret(
            {
              at: before.at.getTime(),
              secret: was,
              fieldsAt: readSecretTimes(before.fieldsAt),
            },
            { at, secret: change.secret, fieldsAt },
          );
          if (
            sameJson(merged.secret, was) &&
            sameJson(merged.fieldsAt, readSecretTimes(before.fieldsAt) ?? {}) &&
            merged.at === before.at.getTime()
          )
            continue;
          secret = merged.secret;
          times = merged.fieldsAt;
          latest = merged.at;
        } else if (
          before &&
          counts &&
          !isLaterEntry(
            { at: before.at.getTime(), deleted: before.sealed === null },
            { at, deleted: change.deleted === true },
          )
        )
          continue;
        const live = [...kept.values()].filter((each) => each.sealed !== null).length;
        if (!change.deleted && (!before || before.sealed === null) && live >= KEYS_KEPT) {
          refused.push(`key:${change.service}`);
          continue;
        }
        const sealed = change.deleted ? null : sealSecret(sealer, userId, change.service, secret!);
        const values = {
          sealed,
          format: SECRET,
          fieldsAt: change.deleted ? null : (times ?? null),
          at: new Date(latest),
        };
        await tx
          .insert(userAiKeys)
          .values({ userId, service: change.service, ...values })
          .onConflictDoUpdate({
            target: [userAiKeys.userId, userAiKeys.service],
            set: values,
          });
        kept.set(change.service, { service: change.service, ...values });
        changed = true;
      }
      if (forgetOldMarks(entries)) changed = true;
      await forgetOldKeyMarks(tx, userId);
      const format = Math.max(row.format, Math.min(changes.format, AI_SYNC_FORMAT));
      let next = row;
      if (changed || format !== row.format) {
        [next = row] = await tx
          .update(userAiSettings)
          .set({
            enabled: true,
            entries,
            size: jsonBytes(entries),
            format,
            revision: sql`${userAiSettings.revision} + 1`,
            updatedAt: new Date(now),
          })
          .where(eq(userAiSettings.userId, userId))
          .returning();
      }
      return {
        state: await stateOf(tx, sealer, userId, next, log),
        refused,
        tooLarge,
      };
    }),
  );
