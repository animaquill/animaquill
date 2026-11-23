import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../database.ts";
import { projectCovers, projects, type CoverType } from "../schema.ts";

/**
 * The covers of projects (`project_covers`): a small picture of a frame for the cards of the start
 * page, which the editor makes and sends. The platform makes none: a scene is HTML, and takes a
 * browser. One for each project, of the kinds the editor makes, checked by their first bytes and
 * how many there are, never shown to anyone but the owner.
 */

/** The bytes a cover may have at most: a picture 480 wide, which is a few dozen kilobytes. */
export const COVER_BYTES = 64 * 1024;

/** The kinds a cover can be, by the type a request says. */
export const COVER_TYPES: readonly CoverType[] = ["image/webp", "image/jpeg"];

/** How long a main timeline can say it is, in milliseconds: a week, more than any film. */
const LONGEST_MS = 7 * 24 * 3600_000;

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  text.split("").every((char, index) => bytes[at + index] === char.charCodeAt(0));

/** A 32-bit number of a RIFF, little-endian. */
const le32 = (bytes: Uint8Array, at: number) =>
  (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/**
 * A WebP as its container has it: a RIFF of "WEBP" whose length is what came, and chunks that fill
 * it exactly, each with its length (and a byte to make it even), the first one of an image.
 */
const isWebp = (bytes: Uint8Array): boolean => {
  if (bytes.length < 20 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return false;
  if (le32(bytes, 4) + 8 !== bytes.length) return false;
  if (!["VP8 ", "VP8L", "VP8X"].some((name) => ascii(bytes, 12, name))) return false;
  let at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    const size = le32(bytes, at + 4);
    at += 8 + size + (size % 2);
  }
  return at === bytes.length;
};

/** Markers of a JPEG that start a frame (SOFn): not DHT (C4), JPG (C8) or DAC (CC). */
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * A JPEG as its segments have it: the start, then segments each with its length, which stay
 * within the bytes, the first an APPn, a table or a frame; a frame before the scan; and the end
 * marker as the last two bytes. What is in the scan is not read.
 */
const isJpeg = (bytes: Uint8Array): boolean => {
  const end = bytes.length;
  if (end < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  if (bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return false;
  const first = bytes[3]!;
  if (bytes[2] !== 0xff || !((first >= 0xe0 && first <= 0xef) || first === 0xdb || isFrame(first)))
    return false;
  let at = 2;
  let framed = false;
  while (at + 4 <= end - 2) {
    if (bytes[at] !== 0xff) return false;
    const marker = bytes[at + 1]!;
    // Markers without a length, and bytes that only fill.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) return false;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > end - 2) return false;
    if (isFrame(marker)) framed = true;
    // The scan: its header is whole, and what follows is the picture, up to the end marker.
    if (marker === 0xda) return framed;
    at += 2 + length;
  }
  return false;
};

/**
 * Whether the bytes are a picture of the kind they say, as their structure has it (see `isWebp`,
 * `isJpeg`): nothing more is decoded. The browser that shows it does, and only for the owner.
 */
export const isPictureOf = (type: CoverType, bytes: Uint8Array): boolean =>
  type === "image/webp" ? isWebp(bytes) : isJpeg(bytes);

/** A duration that a request says, in milliseconds, or undefined where it is none. */
export const durationOf = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return undefined;
  const ms = Number(value);
  return ms <= LONGEST_MS ? ms : undefined;
};

/** What a list and a browser know a cover by: the start of the SHA-256 of its bytes. */
export const etagOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64url").slice(0, 22);

/**
 * Keeps a cover of a project, in place of the one it had (who may, the route asks: access.ts). One people chose themselves
 * (`chosen`) takes the place of any; one the editor made (not `chosen`) does not take the place of
 * one people chose: that stays, and only how long the main timeline is changes. Resolves to the
 * etag of the cover the project has now, when it was kept, and whether people chose it; or
 * undefined where the project is not there, also where it went while this was kept.
 */
export const putCover = async (
  db: Db,
  projectId: string,
  cover: {
    readonly type: CoverType;
    readonly bytes: Buffer;
    readonly durationMs?: number;
    readonly chosen?: boolean;
  },
  at: Date,
): Promise<
  { readonly etag: string; readonly at: number; readonly chosen: boolean } | undefined
> => {
  const values = {
    bytes: cover.bytes,
    type: cover.type,
    etag: etagOf(cover.bytes),
    durationMs: cover.durationMs ?? null,
    chosen: cover.chosen === true,
    updatedAt: at,
  };
  // Only of a project that is there, in one statement: one that is deleted meanwhile
  // either takes the cover with it, or is gone before, and nothing is kept. Whether the one there
  // stays is decided in it too: another request meanwhile waits for it.
  const stays = sql`(${projectCovers.chosen} and not excluded.chosen)`;
  const kept = await db.execute<{ etag: string; updated_at: string | Date; chosen: boolean }>(sql`
    insert into ${projectCovers} (project_id, bytes, type, etag, duration_ms, chosen, updated_at)
    select ${projects.id}, ${values.bytes}, ${values.type}, ${values.etag}, ${values.durationMs},
      ${values.chosen}, ${values.updatedAt.toISOString()}::timestamptz
    from ${projects}
    where ${projects.id} = ${projectId}
    for key share
    on conflict (project_id) do update set
      bytes = case when ${stays} then ${projectCovers.bytes} else excluded.bytes end,
      type = case when ${stays} then ${projectCovers.type} else excluded.type end,
      etag = case when ${stays} then ${projectCovers.etag} else excluded.etag end,
      updated_at = case when ${stays} then ${projectCovers.updatedAt} else excluded.updated_at end,
      chosen = ${projectCovers.chosen} or excluded.chosen,
      duration_ms = case when ${projectCovers.chosen} or excluded.chosen
        then coalesce(excluded.duration_ms, ${projectCovers.durationMs})
        else excluded.duration_ms end
    returning etag, updated_at, chosen`);
  const [row] = kept.rows;
  return row && { etag: row.etag, at: new Date(row.updated_at).getTime(), chosen: row.chosen };
};

/**
 * How long the main timeline of a project is now, for its cover, whichever it is: the editor says
 * it without a picture where people chose the cover. Resolves to false where the project has no
 * cover, or is not there.
 */
export const putDuration = async (
  db: Db,
  projectId: string,
  durationMs: number,
): Promise<boolean> => {
  const kept = await db.execute(sql`
    update ${projectCovers} set duration_ms = ${durationMs}
    where ${projectCovers.projectId} = ${projectId}
    returning ${projectCovers.projectId}`);
  return kept.rows.length > 0;
};

/**
 * Takes the cover of a project away, as people go back to the one the editor makes. Resolves to
 * false where the project is not there; true also where it had none.
 */
export const removeCover = async (db: Db, projectId: string): Promise<boolean> => {
  const [there] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!there) return false;
  await db.delete(projectCovers).where(eq(projectCovers.projectId, projectId));
  return true;
};

/** The cover of a project, or undefined where it has none. */
export const coverOf = async (db: Db, projectId: string) => {
  const [row] = await db
    .select({
      bytes: projectCovers.bytes,
      type: projectCovers.type,
      etag: projectCovers.etag,
    })
    .from(projectCovers)
    .where(eq(projectCovers.projectId, projectId));
  return row;
};
