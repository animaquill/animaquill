import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { retryOnDeadlock, type Db, type Tx } from "../database.ts";
import { projects, userChatImageRefs, userChatImages, userChats } from "../schema.ts";
import { IMAGES_PER_CHAT, imagesOf, NAMED_PER_CHAT } from "./chat-images.ts";

/**
 * Conversations of a person with AI about their projects on the platform, see `ChatSyncAccess` of
 * the editor's host. Each is private to its person, and written whole: over the revision it was
 * read at (`base`), so that of two devices that write one at once, the second is told to take the
 * first's ("newer"). Only of projects of the person's own.
 */

/** How large one conversation is at most, as JSON: one larger stays on its device. */
export const CHAT_BYTES = 4 * 1024 * 1024;
/** Conversations of a person about one project: the ones written last stay, as on a device. */
export const CHATS_PER_PROJECT = 50;
/** All conversations of a person together, at most: one beyond stays on its device. */
export const CHAT_BYTES_PER_USER = 256 * 1024 * 1024;
/**
 * A field of the summary that the list of conversations shows, as JSON, at most: one larger goes
 * with the rest of the conversation, which only reading it gives.
 */
export const SUMMARY_FIELD_BYTES = 4096;

export const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** What a summary of a conversation has, see `SavedChatSummary` of the editor's host. */
const SUMMARY_FIELDS = ["id", "title", "updatedAt", "titleBy", "changes", "asking", "forkedFrom"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ChatWrite {
  readonly base: number | null;
  readonly summary: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly size: number;
}

/** What a request to write a conversation gives, or undefined where it is not what it should be. */
export const chatWriteOf = (body: unknown, id: string): ChatWrite | undefined => {
  if (!isObject(body) || !isObject(body.chat)) return undefined;
  const { base, chat } = body;
  if (base !== null && !(typeof base === "number" && Number.isSafeInteger(base) && base >= 0))
    return undefined;
  if (
    chat.id !== id ||
    typeof chat.title !== "string" ||
    chat.title.length > 1000 ||
    typeof chat.updatedAt !== "number" ||
    !Number.isFinite(chat.updatedAt) ||
    !Array.isArray(chat.entries)
  )
    return undefined;
  const summary: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(chat)) {
    if (name === "project" || name === "synced" || name === "syncedAt") continue;
    const small = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= SUMMARY_FIELD_BYTES;
    if (SUMMARY_FIELDS.includes(name) && small) summary[name] = value;
    else rest[name] = value;
  }
  return {
    base,
    summary,
    body: rest,
    size: Buffer.byteLength(JSON.stringify(chat), "utf8"),
  };
};

const isThere = async (db: Pick<Db, "select">, project: string) => {
  const [found] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, project));
  return found !== undefined;
};

/**
 * The conversations of `userId` about a project, written last first; undefined where it is not
 * there. Whether the person may read it, the route asks (access.ts), as for all of these.
 */
export const listChats = async (db: Db | Tx, userId: string, project: string) => {
  if (!(await isThere(db, project))) return undefined;
  const rows = await db
    .select({ revision: userChats.revision, summary: userChats.summary })
    .from(userChats)
    .where(and(eq(userChats.userId, userId), eq(userChats.projectId, project)))
    .orderBy(desc(userChats.updatedAt), asc(userChats.chatId));
  return rows;
};

export const loadChat = async (db: Db | Tx, userId: string, project: string, id: string) => {
  const [row] = await db
    .select()
    .from(userChats)
    .innerJoin(projects, eq(projects.id, userChats.projectId))
    .where(
      and(eq(userChats.userId, userId), eq(userChats.projectId, project), eq(userChats.chatId, id)),
    );
  if (!row) return undefined;
  const chat = row.user_chats;
  return {
    revision: chat.revision,
    chat: { ...(chat.body as object), ...(chat.summary as object) },
  };
};

/**
 * Writes a conversation over the revision it was read at: its new revision; "newer" with the one
 * there where another device wrote it since; "missing" where the project is not there. One that is not there is written whatever `base` says, as a device that had it before
 * it was taken away elsewhere keeps what it says in it.
 */
export const saveChat = (
  db: Db,
  userId: string,
  project: string,
  id: string,
  write: ChatWrite,
  now: number,
): Promise<
  | { revision: number }
  | { newer: number }
  | { missingImages: readonly string[] }
  | "missing"
  | "tooLarge"
  | "tooManyImages"
> =>
  retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      const [own] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, project))
        .for("key share");
      if (!own) return "missing" as const;
      const [row] = await tx
        .select({ revision: userChats.revision })
        .from(userChats)
        .where(
          and(
            eq(userChats.userId, userId),
            eq(userChats.projectId, project),
            eq(userChats.chatId, id),
          ),
        )
        .for("update");
      if (row && row.revision !== write.base) return { newer: row.revision };
      const { named, held } = imagesOf(write.body);
      if (named.length > NAMED_PER_CHAT || named.length - held.size > IMAGES_PER_CHAT)
        return "tooManyImages" as const;
      // Held for the time of this, so that none of them goes meanwhile.
      const ready =
        named.length === 0
          ? []
          : await tx
              .select({ hash: userChatImages.hash })
              .from(userChatImages)
              .where(
                and(
                  eq(userChatImages.userId, userId),
                  inArray(userChatImages.hash, named),
                  eq(userChatImages.state, "ready"),
                ),
              )
              .for("key share");
      const there = new Set(ready.map((each) => each.hash));
      const missingImages = named.filter((hash) => !held.has(hash) && !there.has(hash));
      if (missingImages.length > 0) return { missingImages };
      const [{ total } = { total: 0 }] = await tx
        .select({
          total: sql<number>`coalesce(sum(${userChats.size}), 0)::bigint`,
        })
        .from(userChats)
        .where(
          and(
            eq(userChats.userId, userId),
            sql`not (${userChats.projectId} = ${project} and ${userChats.chatId} = ${id})`,
          ),
        );
      if (Number(total) + write.size > CHAT_BYTES_PER_USER) return "tooLarge" as const;
      const revision = (row?.revision ?? 0) + 1;
      const values = {
        revision,
        summary: write.summary,
        body: write.body,
        size: write.size,
        updatedAt: new Date(now),
      };
      if (row)
        await tx
          .update(userChats)
          .set(values)
          .where(
            and(
              eq(userChats.userId, userId),
              eq(userChats.projectId, project),
              eq(userChats.chatId, id),
            ),
          );
      else {
        await tx.insert(userChats).values({ userId, projectId: project, chatId: id, ...values });
        // The oldest go, as on a device.
        const keep = tx
          .select({ id: userChats.chatId })
          .from(userChats)
          .where(and(eq(userChats.userId, userId), eq(userChats.projectId, project)))
          .orderBy(desc(userChats.updatedAt), asc(userChats.chatId))
          .limit(CHATS_PER_PROJECT);
        await tx
          .delete(userChats)
          .where(
            and(
              eq(userChats.userId, userId),
              eq(userChats.projectId, project),
              notInArray(userChats.chatId, keep),
            ),
          );
      }
      // Only what it says went: one that says it stayed on its device is not kept for it, so that
      // saying so does not take more than `IMAGES_PER_CHAT` of the platform's.
      await referTo(
        tx,
        userId,
        project,
        id,
        [...there].filter((hash) => !held.has(hash)),
        now,
      );
      return { revision };
    }),
  );

/**
 * Has the pictures a conversation refers to be `hashes`: those it began or stopped referring to
 * are touched now, so that one nothing refers to any more stays 24 hours (me/chat-images.ts).
 */
const referTo = async (
  tx: Tx,
  userId: string,
  project: string,
  id: string,
  hashes: readonly string[],
  now: number,
) => {
  const of = and(
    eq(userChatImageRefs.userId, userId),
    eq(userChatImageRefs.projectId, project),
    eq(userChatImageRefs.chatId, id),
  );
  const before = new Set(
    (await tx.select({ hash: userChatImageRefs.hash }).from(userChatImageRefs).where(of)).map(
      (each) => each.hash,
    ),
  );
  const after = new Set(hashes);
  const gone = [...before].filter((hash) => !after.has(hash));
  const added = hashes.filter((hash) => !before.has(hash));
  if (gone.length > 0)
    await tx.delete(userChatImageRefs).where(and(of, inArray(userChatImageRefs.hash, gone)));
  if (added.length > 0)
    await tx
      .insert(userChatImageRefs)
      .values(added.map((hash) => ({ userId, projectId: project, chatId: id, hash })))
      .onConflictDoNothing();
  const touched = [...gone, ...added];
  if (touched.length > 0)
    await tx
      .update(userChatImages)
      .set({ touchedAt: new Date(now) })
      .where(and(eq(userChatImages.userId, userId), inArray(userChatImages.hash, touched)));
};

export const removeChat = (db: Db, userId: string, project: string, id: string, now: number) =>
  retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      // Its pictures stay 24 hours from now, in case another conversation takes them up again.
      await referTo(tx, userId, project, id, [], now);
      await tx
        .delete(userChats)
        .where(
          and(
            eq(userChats.userId, userId),
            eq(userChats.projectId, project),
            eq(userChats.chatId, id),
          ),
        );
    }),
  );
