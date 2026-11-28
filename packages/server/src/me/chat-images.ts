import { createHash } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { S3SignedRequest } from "@animaquill/host/s3";
import {
  describeError,
  retryOnDeadlock,
  type Db,
  type Executor,
  type Logger,
  type Tx,
} from "../database.ts";
import type { Jobs } from "../jobs.ts";
import type { ChatImageStore } from "./chat-image-store.ts";
import { projects, userChatImageRefs, userChatImages, userChats, users } from "../schema.ts";
import { NO_LIMITS, type PersonLimits } from "../limits.ts";
import type { Setting } from "../settings.ts";
import { lockPrefs } from "./cloud.ts";

/**
 * The pictures of people's conversations about projects of the platform: in the object storage of
 * the cloud space, the same bucket, at `chat-images/u/<user id>/<SHA-256>`, one copy of each
 * picture of a person, or under the same names in a folder of the server's own (the data folder of
 * `npx animaquill`), see chat-image-store.ts; the conversations (`user_chats.body`) only say which,
 * see `imagesOf`.
 *
 * - A picture goes up straight to the storage, at an address signed for its size and hash for ten
 *   minutes (`start`), or to the server for a folder (`putContent`); the platform then reads it back
 *   and checks both (`done`): what is not what was said goes at once. Only then can a conversation
 *   refer to it, see `saveChat`.
 * - Only its person reads it: at an address signed for five minutes (`read`), never for another;
 *   from a folder through the server (`content`), for the person who is signed in only.
 * - At most `CHAT_IMAGE_BYTES` each, `IMAGES_PER_CHAT` a conversation, and `chat.images` of
 *   limits.ts a person (on the platform, `CHAT_IMAGES_SETTING`, which admins change: admin.ts
 *   `chat-images`; on a server of its own, AQ_LIMITS).
 * - A picture nothing refers to goes 24 hours after a conversation last began or stopped referring
 *   to it, as does one that never finished going up (`cleanUp`, every hour). Turning the
 *   conversations off takes everything of the person away at once (`purge`), and the hourly round
 *   takes away what is left in the storage of anyone without a row for it, as of an account that
 *   is gone.
 *
 * What a person does with their pictures takes the row of the person in `user_prefs` first, as the
 * conversations do (`lockPrefs`): taking pictures away holds it for update, so that nothing goes up
 * or is referred to meanwhile; so does beginning to put one, so that two do not take the same room.
 */

/** Bytes of one picture at most: the editor makes each fit, see the chat's attachments. */
export const CHAT_IMAGE_BYTES = 2 * 1024 * 1024;
/** Pictures one conversation has on the platform at most; those beyond stay on their device. */
export const IMAGES_PER_CHAT = 100;
/** Different pictures a conversation may name at all, also of those that stay on a device. */
export const NAMED_PER_CHAT = 1000;
/** What pictures may be: what models take. */
export const CHAT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
/** How long a picture nothing refers to stays, and one that never finished going up. */
export const UNREFERENCED_KEEP_MS = 24 * 60 * 60_000;
/** How long an address to put a picture works. */
export const UPLOAD_SECONDS = 600;
/** How long an address to read a picture works. */
export const READ_SECONDS = 300;
/** Where the pictures are in the bucket, each person's under `<user id>/`. */
export const CHAT_IMAGES_PREFIX = "chat-images/u/";

/**
 * Megabytes (1024²) of pictures a person keeps at most on the platform; admins change it, see
 * admin.ts. Only the platform's limits read it (`chat.images`).
 */
export const CHAT_IMAGES_SETTING: Setting<{ readonly perUserMb: number }> = {
  key: "chat-images",
  fallback: { perUserMb: 500 },
  read: (value) => {
    if (typeof value !== "object" || value === null) return undefined;
    const mb = (value as { perUserMb?: unknown }).perUserMb;
    return typeof mb === "number" && Number.isInteger(mb) && mb >= 0 && mb <= 1_000_000
      ? { perUserMb: mb }
      : undefined;
  },
};

const HASH = /^[0-9a-f]{64}$/;
const USER = /^[0-9a-f-]{36}$/;
const REF = /^sha256:([0-9a-f]{64})$/;

export const imageKey = (userId: string, hash: string): string => {
  if (!USER.test(userId) || !HASH.test(hash)) throw new RangeError("not a user id and a SHA-256");
  return `${CHAT_IMAGES_PREFIX}${userId}/${hash}`;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The pictures a conversation names, as it is written: each entry's `images`, each `{image:
 * "sha256:<hex>", …}`, and of those, the ones that say they stayed on the device that has them
 * (`held`), as for want of room: a conversation may name those without the platform having them.
 */
export const imagesOf = (
  body: Record<string, unknown>,
): {
  readonly named: readonly string[];
  readonly held: ReadonlySet<string>;
} => {
  const named = new Set<string>();
  const sent = new Set<string>();
  const entries = Array.isArray(body.entries) ? body.entries : [];
  for (const entry of entries) {
    if (!isObject(entry) || !Array.isArray(entry.images)) continue;
    for (const image of entry.images) {
      if (!isObject(image) || typeof image.image !== "string") continue;
      const hash = REF.exec(image.image)?.[1];
      if (!hash) continue;
      named.add(hash);
      if (image.held === undefined) sent.add(hash);
    }
  }
  return {
    named: [...named],
    held: new Set([...named].filter((hash) => !sent.has(hash))),
  };
};

/** What a request to put a picture says, or undefined where it is not as it should be. */
export const imageStartOf = (
  body: unknown,
): { readonly hash: string; readonly bytes: number; readonly type: string } | undefined => {
  if (!isObject(body)) return undefined;
  const { hash, bytes, type } = body;
  if (typeof hash !== "string" || !HASH.test(hash)) return undefined;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) return undefined;
  if (typeof type !== "string" || !(CHAT_IMAGE_TYPES as readonly string[]).includes(type))
    return undefined;
  return { hash, bytes, type };
};

export const isImageHash = (text: string): boolean => HASH.test(text);

export type StartOutcome =
  | { readonly have: true }
  | { readonly upload: S3SignedRequest }
  | { readonly full: { readonly used: number; readonly limit: number } }
  | "tooLarge"
  /** Pictures cannot go up now: no storage, it is read only, or the disk is too full. */
  | "unavailable";

export type DoneOutcome = "ready" | "mismatch" | "notUploaded" | "missing" | "unavailable";

export interface ChatImageUsage {
  readonly used: number;
  /** Null: no limit. */
  readonly limit: number | null;
  /** Each conversation that has pictures here, largest first. */
  readonly chats: readonly {
    readonly project: string;
    readonly projectName: string;
    readonly chat: string;
    readonly title: string;
    readonly images: number;
    readonly bytes: number;
  }[];
}

export interface ChatImagesOptions {
  readonly db: Db;
  /** Where the pictures are kept (chat-image-store.ts); undefined where nowhere, and none go up. */
  readonly storage: ChatImageStore | undefined;
  /** How much each person may have, see limits.ts (`chat.images`): nothing unless said. */
  readonly limits?: PersonLimits | undefined;
  readonly now?: () => number;
  readonly log?: Logger;
  /**
   * Has `settle` run for these once every address signed to put a picture until now expired
   * (`UPLOAD_SECONDS`), see `scheduleChatImagesCleanup`: what is put there meanwhile goes too.
   */
  readonly later?: (job: { readonly userId: string; readonly hash?: string }) => Promise<void>;
}

export class ChatImages {
  readonly #options: ChatImagesOptions;
  readonly #now: () => number;

  constructor(options: ChatImagesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Bytes of pictures a person keeps at most (`chat.images`): null for no limit. */
  async limit(db: Executor, userId: string): Promise<number | null> {
    return (this.#options.limits ?? NO_LIMITS).of(db, userId, "chat.images");
  }

  /**
   * What a person's pictures take: every one the platform still keeps, also those nothing refers to
   * any more, until the hourly round takes them away (24 hours after), and those on their way.
   */
  async #used(tx: Db | Tx, userId: string): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<string>`coalesce(sum(${userChatImages.bytes}), 0)::bigint`,
      })
      .from(userChatImages)
      .where(eq(userChatImages.userId, userId));
    return Number(row?.total ?? 0);
  }

  async #canPut(): Promise<boolean> {
    return (await this.#options.storage?.canPut()) ?? false;
  }

  /**
   * Begins putting a picture of a person: `have` where the platform has it already; else an
   * address to put it at, for ten minutes, once there is room for it.
   */
  async start(
    userId: string,
    image: {
      readonly hash: string;
      readonly bytes: number;
      readonly type: string;
    },
  ): Promise<StartOutcome> {
    if (image.bytes > CHAT_IMAGE_BYTES) return "tooLarge";
    const { storage } = this.#options;
    if (!storage || !(await this.#canPut())) return "unavailable";
    const outcome = await retryOnDeadlock(() =>
      this.#options.db.transaction(async (tx): Promise<StartOutcome | "sign"> => {
        // For update: two pictures of one person begun at once do not both take the last room.
        await lockPrefs(tx, userId, "update");
        const [row] = await tx
          .select()
          .from(userChatImages)
          .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, image.hash)))
          .for("update");
        // Kept, unless its file is gone from a folder (taken away by hand, or as an export copied
        // it): then it goes up again, under its row as it is.
        if (row?.state === "ready") {
          if ((await storage.has?.(imageKey(userId, image.hash))) !== false) return { have: true };
          if (row.bytes !== image.bytes) return { have: true };
          return "sign";
        }
        const at = new Date(this.#now());
        // What it takes of the room now, as one asked again (a page that went away) says it anew.
        const used = await this.#used(tx, userId);
        const limit = await this.limit(tx, userId);
        if (limit !== null && used - (row?.bytes ?? 0) + image.bytes > limit)
          return { full: { used: used - (row?.bytes ?? 0), limit } };
        if (row) {
          // What is said now is what is checked; it begins again, as the round sees it.
          await tx
            .update(userChatImages)
            .set({
              bytes: image.bytes,
              type: image.type,
              createdAt: at,
              touchedAt: at,
            })
            .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, image.hash)));
        } else {
          await tx.insert(userChatImages).values({
            userId,
            hash: image.hash,
            bytes: image.bytes,
            type: image.type,
            state: "uploading",
            createdAt: at,
            touchedAt: at,
          });
        }
        return "sign";
      }),
    );
    if (outcome !== "sign") return outcome;
    const upload = await storage.putAddress(imageKey(userId, image.hash), image, UPLOAD_SECONDS);
    return { upload };
  }

  /**
   * The picture went up: read back, and `ready` where its size and SHA-256 are what was said;
   * otherwise it goes at once (`mismatch`). `notUploaded` where nothing is there yet.
   */
  async done(userId: string, hash: string): Promise<DoneOutcome> {
    const outcome = await this.#done(userId, hash);
    if (outcome === "mismatch") await this.#gone(userId, hash);
    return outcome;
  }

  /**
   * A picture's row went: its object goes now, and once more after every address signed to put it
   * expired (`later`), as one could still put something there meanwhile.
   */
  async #gone(userId: string, hash: string): Promise<void> {
    await this.settle(userId, hash).catch((error: unknown) =>
      this.#options.log?.warn(
        { err: describeError(error) },
        "a picture of a conversation left for later",
      ),
    );
    await this.#options
      .later?.({ userId, hash })
      .catch((error: unknown) =>
        this.#options.log?.warn(
          { err: describeError(error) },
          "a picture of a conversation left for the hourly round",
        ),
      );
  }

  /**
   * Takes away what the storage has of a person that the platform has no row for: one picture, or
   * all of theirs (as `purge`). Holding the person, so that nothing goes up meanwhile.
   */
  async settle(userId: string, hash?: string): Promise<number> {
    if (hash === undefined) return this.purge(userId);
    const { storage, db } = this.#options;
    if (!storage) return 0;
    const key = imageKey(userId, hash);
    const [person] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!person) {
      await storage.remove(key);
      return 1;
    }
    return retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        await lockPrefs(tx, userId, "update");
        const [row] = await tx
          .select({ hash: userChatImages.hash })
          .from(userChatImages)
          .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, hash)));
        if (row) return 0;
        await storage.remove(key);
        return 1;
      }),
    );
  }

  async #done(userId: string, hash: string): Promise<DoneOutcome> {
    const { storage } = this.#options;
    if (!storage || !storage.canRead()) return "unavailable";
    const key = imageKey(userId, hash);
    return retryOnDeadlock(() =>
      this.#options.db.transaction(async (tx): Promise<DoneOutcome> => {
        await lockPrefs(tx, userId, "share");
        const [row] = await tx
          .select()
          .from(userChatImages)
          .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, hash)))
          .for("update");
        if (!row) return "missing";
        if (row.state === "ready") return "ready";
        const content = await storage.read(key, CHAT_IMAGE_BYTES);
        if (content === undefined) return "notUploaded";
        const right =
          content.length === row.bytes &&
          createHash("sha256").update(content).digest("hex") === hash;
        if (!right) {
          // The object goes once this is in, see `settle`.
          await tx
            .delete(userChatImages)
            .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, hash)));
          return "mismatch";
        }
        await tx
          .update(userChatImages)
          .set({ state: "ready", touchedAt: new Date(this.#now()) })
          .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, hash)));
        return "ready";
      }),
    );
  }

  /** An address to read a picture of the person at, for five minutes; nothing for another's. */
  async read(
    userId: string,
    hash: string,
  ): Promise<{ readonly url: string; readonly type: string } | undefined | "unavailable"> {
    const { storage } = this.#options;
    if (!storage || !storage.canRead()) return "unavailable";
    const [row] = await this.#options.db
      .select({ type: userChatImages.type })
      .from(userChatImages)
      .where(
        and(
          eq(userChatImages.userId, userId),
          eq(userChatImages.hash, hash),
          eq(userChatImages.state, "ready"),
        ),
      );
    if (!row) return undefined;
    return { url: await storage.readAddress(imageKey(userId, hash), READ_SECONDS), type: row.type };
  }

  /**
   * What a page sent of a picture it began to put (`start`), for a store that is put into through
   * the server (a folder): kept where its row says it is on its way, is that large, and is what its
   * name says, holding the person as `done` does, so that nothing takes its row away meanwhile.
   */
  async putContent(
    userId: string,
    hash: string,
    bytes: Buffer,
  ): Promise<"kept" | "missing" | "mismatch" | "unavailable"> {
    const { storage } = this.#options;
    if (!storage?.write || !(await this.#canPut())) return "unavailable";
    const write = storage.write.bind(storage);
    return retryOnDeadlock(() =>
      this.#options.db.transaction(async (tx) => {
        await lockPrefs(tx, userId, "share");
        const [row] = await tx
          .select({ bytes: userChatImages.bytes, state: userChatImages.state })
          .from(userChatImages)
          .where(and(eq(userChatImages.userId, userId), eq(userChatImages.hash, hash)))
          .for("share");
        if (!row) return "missing" as const;
        if (bytes.length !== row.bytes || createHash("sha256").update(bytes).digest("hex") !== hash)
          return "mismatch" as const;
        // One that is kept and there stays as it is; one whose file is gone is put back, as what its
        // name says it is.
        if (row.state === "ready" && (await storage.has?.(imageKey(userId, hash))) === true)
          return "kept" as const;
        await write(imageKey(userId, hash), bytes);
        return "kept" as const;
      }),
    );
  }

  /** A picture of the person, from a store that is read through the server; nothing of another's. */
  async content(
    userId: string,
    hash: string,
  ): Promise<{ readonly bytes: Buffer; readonly type: string } | undefined | "unavailable"> {
    const { storage } = this.#options;
    if (!storage?.write || !storage.canRead()) return "unavailable";
    const [row] = await this.#options.db
      .select({ type: userChatImages.type, bytes: userChatImages.bytes })
      .from(userChatImages)
      .where(
        and(
          eq(userChatImages.userId, userId),
          eq(userChatImages.hash, hash),
          eq(userChatImages.state, "ready"),
        ),
      );
    if (!row) return undefined;
    const bytes = await storage.read(imageKey(userId, hash), CHAT_IMAGE_BYTES);
    if (bytes === undefined || bytes.length !== row.bytes) return undefined;
    return { bytes, type: row.type };
  }

  /** How much of their room a person's pictures take, and which conversations have them. */
  async usage(userId: string): Promise<ChatImageUsage> {
    const { db } = this.#options;
    const used = await this.#used(db, userId);
    const limit = await this.limit(db, userId);
    const rows = await db
      .select({
        project: userChatImageRefs.projectId,
        projectName: projects.name,
        chat: userChatImageRefs.chatId,
        summary: userChats.summary,
        images: sql<number>`count(*)::int`,
        bytes: sql<string>`sum(${userChatImages.bytes})::bigint`,
      })
      .from(userChatImageRefs)
      .innerJoin(
        userChatImages,
        and(
          eq(userChatImages.userId, userChatImageRefs.userId),
          eq(userChatImages.hash, userChatImageRefs.hash),
        ),
      )
      .innerJoin(
        userChats,
        and(
          eq(userChats.userId, userChatImageRefs.userId),
          eq(userChats.projectId, userChatImageRefs.projectId),
          eq(userChats.chatId, userChatImageRefs.chatId),
        ),
      )
      .innerJoin(projects, eq(projects.id, userChatImageRefs.projectId))
      .where(eq(userChatImageRefs.userId, userId))
      .groupBy(
        userChatImageRefs.projectId,
        projects.name,
        userChatImageRefs.chatId,
        userChats.summary,
      );
    const chats = rows
      .map((row) => {
        const title = isObject(row.summary) ? row.summary.title : undefined;
        return {
          project: row.project,
          projectName: row.projectName,
          chat: row.chat,
          title: typeof title === "string" ? title : "",
          images: row.images,
          bytes: Number(row.bytes),
        };
      })
      .toSorted((a, b) => b.bytes - a.bytes || a.chat.localeCompare(b.chat));
    return { used, limit, chats };
  }

  /**
   * Takes away what the storage has of a person that the platform has no row for: holding the
   * person, so that nothing goes up meanwhile. Of an account that is gone, everything. Resolves to
   * how many went.
   */
  async purge(userId: string): Promise<number> {
    const { storage, db } = this.#options;
    if (!storage) return 0;
    const prefix = `${CHAT_IMAGES_PREFIX}${userId}/`;
    const [person] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!person) return this.#removeUnknown(prefix, async () => new Set());
    return retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        await lockPrefs(tx, userId, "update");
        return this.#removeUnknown(prefix, async (hashes) => {
          const rows = await tx
            .select({ hash: userChatImages.hash })
            .from(userChatImages)
            .where(and(eq(userChatImages.userId, userId), inArray(userChatImages.hash, hashes)));
          return new Set(rows.map((row) => row.hash));
        });
      }),
    );
  }

  /** Takes away each object under `prefix` whose hash `known` does not say it has a row. */
  async #removeUnknown(
    prefix: string,
    known: (hashes: string[]) => Promise<ReadonlySet<string>>,
  ): Promise<number> {
    const storage = this.#options.storage!;
    let removed = 0;
    let next: string | undefined;
    do {
      const page = await storage.list(prefix, next);
      next = page.next;
      const hashes = page.keys
        .map((key) => key.slice(prefix.length))
        .filter((hash) => HASH.test(hash));
      const have = hashes.length > 0 ? await known(hashes) : new Set<string>();
      for (const key of page.keys) {
        const hash = key.slice(prefix.length);
        if (HASH.test(hash) && have.has(hash)) continue;
        await storage.remove(key);
        removed += 1;
      }
    } while (next !== undefined);
    return removed;
  }

  /**
   * The hourly round: pictures nothing refers to that nothing touched for 24 hours, and those that
   * never finished going up in that time, go from the storage and the platform; then what the
   * storage has that the platform has no row for, as of people who turned the conversations off
   * while the storage could not be reached, or whose account is gone.
   */
  async cleanUp(): Promise<{
    readonly expired: number;
    readonly leftOver: number;
  }> {
    const { storage, db } = this.#options;
    if (!storage) return { expired: 0, leftOver: 0 };
    await storage
      .tidy?.()
      .catch((error: unknown) =>
        this.#options.log?.warn(
          { err: describeError(error) },
          "half-written pictures stay for now",
        ),
      );
    const cutoff = new Date(this.#now() - UNREFERENCED_KEEP_MS);
    const due = (tx: Db | Tx, userId?: string) =>
      and(
        userId === undefined ? undefined : eq(userChatImages.userId, userId),
        or(
          and(eq(userChatImages.state, "uploading"), lt(userChatImages.createdAt, cutoff)),
          and(
            lt(userChatImages.touchedAt, cutoff),
            sql`not exists (${tx
              .select({ one: sql`1` })
              .from(userChatImageRefs)
              .where(
                and(
                  eq(userChatImageRefs.userId, userChatImages.userId),
                  eq(userChatImageRefs.hash, userChatImages.hash),
                ),
              )})`,
          ),
        ),
      );
    const people = await db
      .selectDistinct({ userId: userChatImages.userId })
      .from(userChatImages)
      .where(due(db));
    let expired = 0;
    for (const { userId } of people) {
      try {
        expired += await retryOnDeadlock(() =>
          db.transaction(async (tx) => {
            await lockPrefs(tx, userId, "update");
            const rows = await tx
              .delete(userChatImages)
              .where(due(tx, userId))
              .returning({ hash: userChatImages.hash });
            return rows.map((row) => row.hash);
          }),
        ).then(async (hashes) => {
          // Once that is in: what was put again meanwhile has a row again, and stays.
          for (const hash of hashes) await this.settle(userId, hash);
          return hashes.length;
        });
      } catch (error) {
        this.#options.log?.warn(
          { err: describeError(error) },
          "pictures of conversations not taken away",
        );
      }
    }
    // What the storage has, by person: those with anything the platform has no row for.
    const found = new Map<string, Set<string>>();
    let next: string | undefined;
    do {
      const page = await storage.list(CHAT_IMAGES_PREFIX, next);
      next = page.next;
      for (const key of page.keys) {
        const [owner = "", hash = "", ...rest] = key.slice(CHAT_IMAGES_PREFIX.length).split("/");
        if (!USER.test(owner)) continue;
        const each = found.get(owner) ?? new Set<string>();
        // Anything else under a person's prefix is not of the platform's: it goes too.
        each.add(HASH.test(hash) && rest.length === 0 ? hash : "");
        found.set(owner, each);
      }
    } while (next !== undefined);
    let leftOver = 0;
    for (const [owner, hashes] of found) {
      try {
        const known = hashes.has("")
          ? []
          : await db
              .select({ hash: userChatImages.hash })
              .from(userChatImages)
              .where(
                and(eq(userChatImages.userId, owner), inArray(userChatImages.hash, [...hashes])),
              );
        if (known.length === hashes.size) continue;
        leftOver += await this.purge(owner);
      } catch (error) {
        this.#options.log?.warn(
          { err: describeError(error) },
          "pictures of conversations not taken away",
        );
      }
    }
    return { expired, leftOver };
  }
}

/** The queue of pg-boss of the hourly round, see `ChatImages.cleanUp`. */
export const CHAT_IMAGES_QUEUE = "chat-images-cleanup";

/** The queue of pg-boss of `ChatImages.settle` once the addresses to put pictures expired. */
export const CHAT_IMAGES_SETTLE_QUEUE = "chat-images-settle";

/** Has `settle` run for a picture, or all of a person's, once every address to put it expired. */
export const settleLater = async (
  boss: Jobs,
  job: { readonly userId: string; readonly hash?: string },
): Promise<void> => {
  await boss.send(CHAT_IMAGES_SETTLE_QUEUE, job, {
    startAfter: UPLOAD_SECONDS + 60,
  });
};

/**
 * Runs the round every hour: one run an hour, however many APIs. What fails waits for the next. And
 * what `settleLater` asks for, as it is due.
 */
export const scheduleChatImagesCleanup = async (
  boss: Jobs,
  images: ChatImages,
  log: Logger,
): Promise<void> => {
  const settling = {
    retryLimit: 5,
    retryDelay: 60,
    deleteAfterSeconds: 24 * 3600,
  };
  await boss.createQueue(CHAT_IMAGES_SETTLE_QUEUE, settling);
  await boss.updateQueue(CHAT_IMAGES_SETTLE_QUEUE, settling);
  await boss.work<{ userId: string; hash?: string }>(CHAT_IMAGES_SETTLE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { userId, hash } = job.data;
      if (typeof userId !== "string" || (hash !== undefined && !HASH.test(hash))) continue;
      await images.settle(userId, hash);
    }
  });
  const queue = {
    retryLimit: 0,
    expireInSeconds: 30 * 60,
    deleteAfterSeconds: 24 * 3600,
  };
  await boss.createQueue(CHAT_IMAGES_QUEUE, { policy: "stately", ...queue });
  await boss.updateQueue(CHAT_IMAGES_QUEUE, queue);
  await boss.schedule(CHAT_IMAGES_QUEUE, "29 * * * *");
  await boss.work(CHAT_IMAGES_QUEUE, async () => {
    try {
      const done = await images.cleanUp();
      if (done.expired + done.leftOver > 0) log.info({ ...done }, "pictures of conversations gone");
    } catch (error) {
      log.warn({ err: describeError(error) }, "pictures of conversations were not looked after");
    }
  });
};
