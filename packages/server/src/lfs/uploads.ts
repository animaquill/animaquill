import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SignedIn } from "../auth/accounts.ts";
import { describeError, type Db, type Logger, type Tx } from "../database.ts";
import { GitHubUnavailable } from "../github/client.ts";
import { linkOf } from "../archive/links.ts";
import {
  LfsQuota,
  RepoPaused,
  RepoRefused,
  hereOf,
  placeOf,
  type RepoHosts,
  type RepoProvider,
} from "../archive/repo-host.ts";
import {
  OPEN_LFS_STATES,
  lfsObjects,
  lfsUploads,
  projects,
  type LfsUploadState,
  userPrefs,
} from "../schema.ts";
import { UPLOAD_ID, type Staging } from "./staging.ts";

/**
 * Files on their way into the large file storage (Git LFS) of a project's repository, as the editor
 * sends them: only by the person whose project it is, in pieces of `minChunkBytes` to `chunkBytes`
 * (the last one of a file as small as it is), one after the other. A piece is on the disk before it
 * counts (`Staging.write`), under a lock of the row of its upload, so that a piece sent twice, as
 * after an answer that got lost, is taken once, and one that does not go where the upload got is
 * turned away with where it got. Once all of it is there it is read through for its hash, which
 * nobody waits for: the last piece is answered as the others are, "receiving" with all of the file
 * received, and the editor asks how it went. What is not the file the editor said, as one that
 * changed while it was sent, fails and goes. What is, the worker puts into the storage, see
 * push.ts.
 *
 * A file the storage has already is "present" at once, by what the platform knows (`lfs_objects`) or
 * by asking GitHub, which goes by the hash alone: only what the storage has as large as the editor
 * says the file is counts, and anything else is not the file ("changed"). One that is on its way,
 * from another computer too, goes on as it is. New ones are taken while there is room (Q6 of the
 * plan): `fileBytes` a file, `personBytes` on its way for one person, `totalBytes` for everyone, and
 * the disk keeps `floorBytes` free whatever comes in. An upload comes in within `LFS_RECEIVING_MS`
 * of its start, however its pieces come: nobody holds room for longer than that.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export interface LfsLimits {
  /** The largest file: what GitHub's free accounts take, as far as is known. */
  readonly fileBytes: number;
  /** What one person has on its way at the same time. */
  readonly personBytes: number;
  /** How many files one person has on its way at the same time, however small. */
  readonly personUploads: number;
  /** What everybody has on its way together: the most the staging volume holds. */
  readonly totalBytes: number;
  /** What the disk keeps free, counting what is on its way to it. */
  readonly floorBytes: number;
  /** The largest piece. The gateway takes a little more for a request to /api/lfs/uploads/. */
  readonly chunkBytes: number;
  /**
   * The smallest piece, but for the last one of a file: a piece is a transaction and a write that
   * waits for the disk, so a file is not sent a few bytes at a time. Small enough for a slow line
   * to get one through in time, see routes.ts.
   */
  readonly minChunkBytes: number;
  /** Files read through for their hashes at the same time. */
  readonly hashing: number;
  /**
   * Pieces written at the same time: each holds a connection of the database while it is written,
   * which syncing needs too.
   */
  readonly writing: number;
  /**
   * How long a new upload waits for the lock under which uploads are counted, in the database,
   * before it is told to come back: only another process can hold it that long, see `begin`.
   */
  readonly lockWaitMs: number;
}

export const LFS_LIMITS: LfsLimits = {
  fileBytes: 2 * GIB,
  personBytes: 4 * GIB,
  // The editor sends three at a time; a few windows, a few computers.
  personUploads: 30,
  totalBytes: 20 * GIB,
  floorBytes: 30 * GIB,
  chunkBytes: 8 * MIB,
  minChunkBytes: 64 * KIB,
  hashing: 2,
  writing: 3,
  lockWaitMs: 5000,
};

/** How long an upload waits for its next piece, and how long one is tried to be passed on. */
export const LFS_LIFE_MS = 24 * 3600_000;
/**
 * How long an upload may take to come in, from when it was started, whatever comes meanwhile: a
 * piece a day would otherwise hold its room, of one person's and of everybody's, for good. 2 GiB
 * come in within that at 9 KiB a second.
 */
export const LFS_RECEIVING_MS = 3 * 24 * 3600_000;

/** The lock of PostgreSQL under which new uploads are counted against the limits, see `begin`. */
export const LFS_LOCK = 0x61712d6c; // "aq-l"

/** Seconds to come back after, where there is no room now. */
const WAIT = { person: 60, total: 300, disk: 600, full: 60, lock: 10 } as const;

/** Something the editor asked about uploads that cannot be done: `code` for it, with a status. */
export class UploadRefused extends Error {
  override name = "UploadRefused";
  readonly code: string;
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  constructor(code: string, status: number, extra?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** An upload as the editor gets it, see `LfsUpload` of its host. */
export interface UploadAnswer {
  readonly id?: string;
  readonly state: "present" | LfsUploadState;
  /**
   * The repository, as the place of the asset is bound to it: its number on GitHub, or
   * `local:<number>` for one of the server's own (`hereOf`).
   */
  readonly repo: string;
  readonly oid: string;
  readonly size: number;
  readonly received: number;
  /** The most bytes a piece may have, and the fewest, but for the last piece of the file. */
  readonly chunk: number;
  readonly minChunk: number;
  readonly error?: string;
  readonly detail?: string;
}

type Row = typeof lfsUploads.$inferSelect;

/** The large file storage of the server's own repositories, as uploads into it are counted. */
export interface LocalLfs {
  /** The largest file. */
  readonly fileBytes: number;
  /** All of it together at most, objects and uploads on their way: undefined for no limit. */
  readonly maxBytes: number | undefined;
  /** LFS_MIN_FREE_GB, where the server is set up for it, which the staging disk keeps free too. */
  readonly stagingFloorBytes: number | undefined;
  /** Bytes free on the disk of the repositories, and how large it is. */
  room(): Promise<{ readonly free: number; readonly total: number } | undefined>;
  /** Whether a folder is on the disk of the repositories. */
  sameDisk(path: string): Promise<boolean>;
}

/**
 * What the disk of the server's own repositories keeps free whatever comes in: 2 GiB, or 5 % of
 * it where that is more (D of the design of O8, 2026-11-23).
 */
export const localFloorOf = (total: number): number => Math.max(2 * GIB, Math.ceil(total * 0.05));

/** A repository, as `lfs_objects` and `lfs_uploads` know it: its number on its provider. */
interface Repo {
  readonly provider: RepoProvider;
  readonly repoId: number;
}

export interface LfsUploadsOptions {
  readonly db: Db;
  readonly staging: Staging;
  /**
   * The repositories, for asking the storage whether it has a file. Undefined, or none on the
   * project's provider: nothing is taken.
   */
  readonly hosts: RepoHosts | undefined;
  /**
   * The large file storage of the repositories of the server's own, where they are on: its limits,
   * and the disk they are on.
   */
  readonly local?: LocalLfs | undefined;
  /** Puts an upload whose file is all there into the queue of the worker, see push.ts. */
  readonly enqueue: (upload: string) => Promise<void>;
  readonly log: Logger;
  readonly limits?: Partial<LfsLimits>;
  readonly now?: () => Date;
}

/** A few slots: what runs takes one, and the rest wait their turn. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(count: number) {
    this.#free = count;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

const isCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

/** Whether PostgreSQL gave up waiting for a lock (55P03, `lock_timeout`), however drizzle says so. */
const isLockTimeout = (error: unknown): boolean =>
  isCode(error, "55P03") || isCode((error as { cause?: unknown } | undefined)?.cause, "55P03");

/** GitHub's words, short: never a token or an address, which its messages do not have. */
const short = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * What a refusal of an object by the storage means for people: too large, no room left, or
 * something else, in GitHub's words.
 */
export const refusalOf = (answer: {
  readonly code: number;
  readonly message: string;
}): { readonly error: string; readonly detail: string } => {
  const detail = short(answer.message);
  if ((answer.code === 422 || answer.code === 413) && /size|large/i.test(answer.message))
    return { error: "tooLarge", detail };
  if (answer.code === 507 || /quota/i.test(answer.message)) return { error: "githubQuota", detail };
  if (answer.code === 401 || answer.code === 403 || answer.code === 404)
    return { error: "gone", detail };
  return { error: "refused", detail };
};

export class LfsUploads {
  readonly #options: LfsUploadsOptions;
  readonly #limits: LfsLimits;
  readonly #now: () => Date;
  readonly #hashing: Slots;
  readonly #writing: Slots;
  /**
   * New uploads are counted one at a time: whoever waits for that waits here, and not on a
   * connection of the database, which syncing needs too.
   */
  readonly #counting = new Slots(1);
  /** Uploads that are being read through for their hashes, by id: one read for all who ask. */
  readonly #settling = new Map<string, Promise<UploadAnswer>>();

  constructor(options: LfsUploadsOptions) {
    this.#options = options;
    const limits = { ...LFS_LIMITS, ...options.limits };
    // No piece has to be larger than the largest one.
    this.#limits = { ...limits, minChunkBytes: Math.min(limits.minChunkBytes, limits.chunkBytes) };
    this.#now = options.now ?? (() => new Date());
    this.#hashing = new Slots(this.#limits.hashing);
    this.#writing = new Slots(this.#limits.writing);
  }

  /** The most bytes a piece may have, which a request is never read beyond, see routes.ts. */
  get chunkBytes(): number {
    return this.#limits.chunkBytes;
  }

  #answer(row: Row): UploadAnswer {
    return {
      id: row.id,
      state: row.state,
      repo: hereOf(row).repo,
      oid: row.oid,
      size: row.size,
      received: row.received,
      chunk: this.#limits.chunkBytes,
      minChunk: this.#limits.minChunkBytes,
      ...(row.error && { error: row.error }),
      ...(row.detail && { detail: row.detail }),
    };
  }

  #present(repo: Repo, oid: string, size: number): UploadAnswer {
    return {
      state: "present",
      repo: hereOf(repo).repo,
      oid,
      size,
      received: size,
      chunk: this.#limits.chunkBytes,
      minChunk: this.#limits.minChunkBytes,
    };
  }

  /** The upload of one person, or "notFound". */
  async #own(user: SignedIn, id: string): Promise<Row> {
    if (!UPLOAD_ID.test(id)) throw new UploadRefused("notFound", 404);
    const [row] = await this.#options.db
      .select()
      .from(lfsUploads)
      .where(and(eq(lfsUploads.id, id), eq(lfsUploads.userId, user.userId)));
    if (!row) throw new UploadRefused("notFound", 404);
    return row;
  }

  /** The upload of an object into a repository that is on its way, if there is one. */
  async #open(repo: Repo, oid: string, db: Pick<Db, "select"> = this.#options.db) {
    const [row] = await db
      .select()
      .from(lfsUploads)
      .where(
        and(
          eq(lfsUploads.provider, repo.provider),
          eq(lfsUploads.repoId, repo.repoId),
          eq(lfsUploads.oid, oid),
          inArray(lfsUploads.state, [...OPEN_LFS_STATES]),
        ),
      );
    return row;
  }

  /** An upload that is on its way already, which the person goes on with. */
  #goOn(user: SignedIn, row: Row, size: number): UploadAnswer {
    // The same object is the same size: one of the two is not what it says, and its hash will say.
    if (row.size !== size) throw new UploadRefused("invalid", 400);
    // Another account's, into the same repository: not to be touched, and not for long.
    if (row.userId !== user.userId)
      throw new UploadRefused("busy", 429, { retryAfter: WAIT.person });
    this.#settleLater(row);
    return this.#answer(row);
  }

  /**
   * Starts an upload of a file into the repository of a project, `oid` the SHA-256 of the file in
   * lower-case hexadecimal: or says the storage has it, or goes on with the one on its way.
   */
  async begin(
    user: SignedIn,
    projectId: string,
    file: { readonly oid: string; readonly size: number },
  ): Promise<{ readonly fresh: boolean; readonly answer: UploadAnswer }> {
    const { db, staging, hosts, log } = this.#options;
    const { oid, size } = file;
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    // Whether the person may: the route asks (access.ts).
    if (!project) throw new UploadRefused("notFound", 404);
    const link = await linkOf(db, projectId);
    // Files go into the room of the person's GitHub account, and cannot be taken out one by one:
    // only once they said they know (/api/me/lfs), whatever the page did or did not ask. Those of a
    // repository of the server's own go onto its disk, which costs nobody anything of theirs.
    if (link?.provider !== "local") {
      const [prefs] = await db
        .select({ at: userPrefs.lfsAcknowledgedAt })
        .from(userPrefs)
        .where(eq(userPrefs.userId, user.userId));
      if (!prefs?.at) throw new UploadRefused("notAcknowledged", 409);
    }
    if (!link) throw new UploadRefused("notLinked", 409);
    const repo: Repo = { provider: link.provider, repoId: link.repoId };
    const here = link.provider === "local" ? this.#options.local : undefined;

    const [known] = await db
      .select({ size: lfsObjects.size })
      .from(lfsObjects)
      .where(
        and(
          eq(lfsObjects.provider, repo.provider),
          eq(lfsObjects.repoId, repo.repoId),
          eq(lfsObjects.oid, oid),
        ),
      );
    if (known) {
      // The storage has the file of this hash, and it is not as large as the editor says: what
      // the editor has is not that file.
      if (known.size !== size)
        return {
          fresh: false,
          answer: await this.#notTheFile(user, projectId, repo, file, known.size),
        };
      return { fresh: false, answer: this.#present(repo, oid, size) };
    }
    const open = await this.#open(repo, oid);
    if (open) return { fresh: false, answer: this.#goOn(user, open, size) };

    // Larger than the storage takes, as far as is known: GitHub is not asked, see `fileBytes`.
    if (size > Math.min(this.#limits.fileBytes, here?.fileBytes ?? Infinity))
      throw new UploadRefused("tooLarge", 413);
    // GitHub has it, as from another project in the repository, or a push of Git LFS.
    if (!hosts?.has(link.provider)) throw new UploadRefused("unavailable", 503);
    const session = hosts.open(placeOf(link));
    const [answer] = await this.#asking(projectId, () =>
      session.lfsHave([{ oid, size }], "upload"),
    );
    if (answer?.kind === "present") {
      // It goes by the oid: how large what it has is, the storage says itself, and only that is
      // noted. A pointer says both, so a file of another size than it says is not the file.
      let stored = answer.size;
      if (stored === undefined || stored === size) {
        [stored] = await this.#asking(projectId, () => session.lfsSizes([{ oid, size }]));
        if (stored !== undefined)
          await db
            .insert(lfsObjects)
            .values({ ...repo, oid, size: stored })
            .onConflictDoNothing();
      }
      if (stored !== size)
        return {
          fresh: false,
          answer: await this.#notTheFile(user, projectId, repo, file, stored),
        };
      return { fresh: false, answer: this.#present(repo, oid, size) };
    }
    if (answer?.kind === "refused") {
      const { error, detail } = refusalOf(answer);
      if (error === "tooLarge") throw new UploadRefused("tooLarge", 413, { detail });
      if (error === "githubQuota") throw new UploadRefused("githubQuota", 409, { detail });
      if (error === "gone") throw new UploadRefused("gone", 409, { detail });
      log.warn({ project: projectId, code: answer.code, detail }, "GitHub's LFS refused a file");
      throw new UploadRefused("unavailable", 503, { detail });
    }
    if (answer?.kind !== "absent") throw new UploadRefused("unavailable", 503);

    // Counted against the limits under one lock, so that two at once do not both fit: of the
    // database, for whatever other process counts too, and one at a time here before that, so
    // that those who wait hold no connection. A lock that does not come in time says "busy".
    const taken = await this.#counted(async (tx) => {
      const there = await this.#open(repo, oid, tx);
      if (there) return { there };
      const sizeOf = sql<string>`coalesce(sum(${lfsUploads.size}), 0)`;
      const [mine] = await tx
        .select({ bytes: sizeOf, files: sql<string>`count(*)` })
        .from(lfsUploads)
        .where(
          and(eq(lfsUploads.userId, user.userId), inArray(lfsUploads.state, [...OPEN_LFS_STATES])),
        );
      if (
        Number(mine?.bytes ?? 0) + size > this.#limits.personBytes ||
        Number(mine?.files ?? 0) >= this.#limits.personUploads
      )
        // The person's own: what they have on their way, which they can give up.
        throw new UploadRefused("busy", 429, { retryAfter: WAIT.person, detail: "person" });
      const [all] = await tx
        .select({
          bytes: sizeOf,
          // What is still to come of what is coming, which the disk has to have room for.
          coming: sql<string>`coalesce(sum(${lfsUploads.size} - ${lfsUploads.received}) filter (where ${lfsUploads.state} = 'receiving'), 0)`,
        })
        .from(lfsUploads)
        .where(inArray(lfsUploads.state, [...OPEN_LFS_STATES]));
      if (Number(all?.bytes ?? 0) + size > this.#limits.totalBytes)
        throw new UploadRefused("busy", 503, { retryAfter: WAIT.total });
      const coming = Number(all?.coming ?? 0);
      if (here) await this.#roomHere(tx, here, size, coming);
      else {
        const free = await staging.freeBytes();
        if (free - coming - size < this.#limits.floorBytes) {
          log.warn({ free, coming }, "the disk is too full for uploads");
          throw new UploadRefused("busy", 503, { retryAfter: WAIT.disk });
        }
      }
      const now = this.#now();
      const [row] = await tx
        .insert(lfsUploads)
        .values({
          userId: user.userId,
          projectId,
          ...repo,
          oid,
          size,
          state: "receiving",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { row: row as Row };
    });
    if ("there" in taken) return { fresh: false, answer: this.#goOn(user, taken.there, size) };
    const { row } = taken;
    try {
      await staging.create(row.id);
    } catch (error) {
      log.error({ err: describeError(error), upload: row.id }, "no staging file for an upload");
      await db
        .update(lfsUploads)
        .set({ state: "failed", error: "lost", updatedAt: this.#now() })
        .where(eq(lfsUploads.id, row.id));
      throw new UploadRefused("unavailable", 503);
    }
    log.info({ upload: row.id, project: projectId, size }, "upload to Git LFS started");
    return { fresh: true, answer: this.#answer(row) };
  }

  /**
   * Whether a file of `size` fits into the large file storage of the server's own repositories:
   * all of it together within what the server is set up for (`maxBytes`, as GitHub's room is,
   * "githubQuota"), and the disk of the repositories keeping `localFloorOf` its size free, counting
   * what is still to come of what is coming (busy, as the disk is: "diskFull"). Where the staging
   * folder is on another disk, that one keeps as much free too; a floor the server is set up for
   * (LFS_MIN_FREE_GB) is kept there as well.
   */
  async #roomHere(tx: Tx, here: LocalLfs, size: number, coming: number): Promise<void> {
    const { staging, log } = this.#options;
    if (here.maxBytes !== undefined) {
      const [kept] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${lfsObjects.size}), 0)` })
        .from(lfsObjects)
        .where(eq(lfsObjects.provider, "local"));
      const [going] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${lfsUploads.size}), 0)` })
        .from(lfsUploads)
        .where(
          and(eq(lfsUploads.provider, "local"), inArray(lfsUploads.state, [...OPEN_LFS_STATES])),
        );
      if (Number(kept?.bytes ?? 0) + Number(going?.bytes ?? 0) + size > here.maxBytes)
        throw new UploadRefused("githubQuota", 409, { detail: "local" });
    }
    const full = (free: number, total: number, floor = localFloorOf(total)) =>
      free - coming - size < floor;
    const room = await here.room();
    if (!room || full(room.free, room.total)) {
      log.warn({ ...room, coming }, "the disk of the repositories here is too full for uploads");
      throw new UploadRefused("busy", 503, { retryAfter: WAIT.disk, detail: "diskFull" });
    }
    const apart = !(await here.sameDisk(staging.dir));
    if (apart || here.stagingFloorBytes !== undefined) {
      const free = await staging.freeBytes();
      const floor = Math.max(apart ? localFloorOf(room.total) : 0, here.stagingFloorBytes ?? 0);
      if (free - coming - size < floor) {
        log.warn({ free, coming }, "the disk of the staging folder is too full for uploads");
        throw new UploadRefused("busy", 503, { retryAfter: WAIT.disk, detail: "diskFull" });
      }
    }
  }

  /** What GitHub is asked for the editor: what it cannot say now is said in the editor's words. */
  async #asking<T>(projectId: string, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof LfsQuota)
        throw new UploadRefused("githubQuota", 409, { detail: short(error.message) });
      if (error instanceof RepoPaused) throw new UploadRefused("gone", 409);
      if (error instanceof GitHubUnavailable)
        throw new UploadRefused("unavailable", 503, {
          ...(error.retryAfterMs !== undefined && {
            retryAfter: Math.ceil(error.retryAfterMs / 1000),
          }),
        });
      if (error instanceof RepoRefused) {
        this.#options.log.warn(
          { err: describeError(error), project: projectId },
          "GitHub's LFS refused",
        );
        throw new UploadRefused("unavailable", 503);
      }
      throw error;
    }
  }

  /**
   * The storage has the file of this hash, in another size than the editor says its file has: what
   * the editor has is not the file. An upload that failed as "changed", as one whose file changed
   * while it was sent: nothing is to be sent, and the editor looks at its file again.
   */
  async #notTheFile(
    user: SignedIn,
    projectId: string,
    repo: Repo,
    file: { readonly oid: string; readonly size: number },
    stored: number | undefined,
  ): Promise<UploadAnswer> {
    const now = this.#now();
    // Said once a day for a file: an editor that asks again and again adds no row each time.
    const [said] = await this.#options.db
      .select()
      .from(lfsUploads)
      .where(
        and(
          eq(lfsUploads.userId, user.userId),
          eq(lfsUploads.provider, repo.provider),
          eq(lfsUploads.repoId, repo.repoId),
          eq(lfsUploads.oid, file.oid),
          eq(lfsUploads.size, file.size),
          eq(lfsUploads.state, "failed"),
          eq(lfsUploads.error, "changed"),
          gt(lfsUploads.createdAt, new Date(now.getTime() - LFS_LIFE_MS)),
        ),
      )
      .orderBy(desc(lfsUploads.createdAt))
      .limit(1);
    if (said) return this.#answer(said);
    const [row] = await this.#options.db
      .insert(lfsUploads)
      .values({
        userId: user.userId,
        projectId,
        ...repo,
        oid: file.oid,
        size: file.size,
        state: "failed",
        error: "changed",
        detail:
          stored === undefined
            ? "the storage has a file of this hash in another size"
            : `the storage has a file of this hash that is ${stored} bytes`,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    this.#options.log.warn(
      { upload: row?.id, project: projectId, size: file.size, stored },
      "a file the storage has in another size",
    );
    return this.#answer(row as Row);
  }

  /**
   * Runs what counts a new upload against the limits, under the lock of the database for that: one
   * at a time in this process, so that only one of them holds a connection while it waits for the
   * lock, and for `lockWaitMs` at most.
   */
  async #counted<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const { db } = this.#options;
    try {
      return await this.#counting.run(() =>
        db.transaction(async (tx) => {
          const wait = String(Math.max(1, Math.round(this.#limits.lockWaitMs)));
          // For this transaction only.
          await tx.execute(sql`select set_config('lock_timeout', ${wait}, true)`);
          await tx.execute(sql`select pg_advisory_xact_lock(${LFS_LOCK})`);
          return work(tx);
        }),
      );
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
      this.#options.log.warn({}, "the lock for counting uploads did not come in time");
      throw new UploadRefused("busy", 503, { retryAfter: WAIT.lock });
    }
  }

  /**
   * Whether a piece at `offset` can be taken, asked before a byte of it is read (routes.ts): rejects
   * with "notFound" for no upload of this person's, and with "offset" for a piece that would not go
   * where the upload got; resolves to the upload where it is over, which a piece changes nothing
   * of; and to undefined where it can go. A piece that the request says would go past the end of the
   * file is "invalid". `send` looks again, under the lock of the upload.
   */
  async expecting(
    user: SignedIn,
    id: string,
    offset: number,
    /** Bytes of the piece, where the request says. */
    length?: number,
  ): Promise<UploadAnswer | undefined> {
    const row = await this.#own(user, id);
    if (length !== undefined && offset + length > row.size) throw new UploadRefused("invalid", 400);
    if (row.state !== "receiving") return this.#answer(row);
    if (offset > row.received) throw new UploadRefused("offset", 409, { received: row.received });
    return undefined;
  }

  /**
   * Takes a piece of the file at `offset`: where the upload got, or before it, as a piece sent again.
   * Resolves to the upload after it, also where it is done for. Once all of the file is there it is
   * read through for its hash, which this does not wait for: the upload says "receiving" with all
   * of it received until that is done, see `state`.
   */
  async send(user: SignedIn, id: string, offset: number, piece: Uint8Array): Promise<UploadAnswer> {
    if (!UPLOAD_ID.test(id)) throw new UploadRefused("notFound", 404);
    if (piece.length === 0) throw new UploadRefused("invalid", 400);
    if (piece.length > this.#limits.chunkBytes) throw new UploadRefused("tooLarge", 413);
    const { row, ended } = await this.#writing.run(() => this.#take(user, id, offset, piece));
    if (ended)
      await this.#options.staging.remove(id).catch((error: unknown) => {
        // The sweep takes it away, see sweep.ts.
        this.#options.log.warn({ err: describeError(error), upload: id }, "a staging file stays");
      });
    this.#settleLater(row);
    return this.#answer(row);
  }

  /**
   * A piece, under the lock of its upload, on the disk before it counts. `ended`: the upload was
   * over its time, and expired with this piece.
   */
  async #take(
    user: SignedIn,
    id: string,
    offset: number,
    piece: Uint8Array,
  ): Promise<{ readonly row: Row; readonly ended?: boolean }> {
    const { db, staging, log } = this.#options;
    return db.transaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(lfsUploads)
        .where(and(eq(lfsUploads.id, id), eq(lfsUploads.userId, user.userId)))
        .for("update");
      if (!upload) throw new UploadRefused("notFound", 404);
      if (offset + piece.length > upload.size) throw new UploadRefused("invalid", 400);
      // Started too long ago, however its pieces came: it is over, see `LFS_RECEIVING_MS`.
      const now = this.#now();
      if (
        upload.state === "receiving" &&
        now.getTime() - upload.createdAt.getTime() > LFS_RECEIVING_MS
      ) {
        const [expired] = await tx
          .update(lfsUploads)
          .set({ state: "expired", updatedAt: now })
          .where(eq(lfsUploads.id, id))
          .returning();
        return { row: expired as Row, ended: true };
      }
      // Over, one way or another: it says so. A piece it has already changes nothing.
      if (upload.state !== "receiving" || offset + piece.length <= upload.received)
        return { row: upload };
      if (offset !== upload.received)
        throw new UploadRefused("offset", 409, { received: upload.received });
      // Smaller than a piece may be, and not the rest of the file.
      if (piece.length < this.#limits.minChunkBytes && offset + piece.length < upload.size)
        throw new UploadRefused("invalid", 400);
      try {
        await staging.write(id, offset, piece);
      } catch (error) {
        if (isCode(error, "ENOSPC"))
          throw new UploadRefused("busy", 503, { retryAfter: WAIT.full });
        if (!isCode(error, "ENOENT")) throw error;
        log.error({ upload: id }, "the staging file of an upload is gone");
        const [lost] = await tx
          .update(lfsUploads)
          .set({ state: "failed", error: "lost", updatedAt: this.#now() })
          .where(eq(lfsUploads.id, id))
          .returning();
        return { row: lost as Row };
      }
      const [next] = await tx
        .update(lfsUploads)
        .set({
          received: sql`${lfsUploads.received} + ${piece.length}`,
          updatedAt: this.#now(),
        })
        .where(eq(lfsUploads.id, id))
        .returning();
      return { row: next as Row };
    });
  }

  /**
   * An upload as it is. One whose file is all there, but not read through yet, gets read now: as
   * after its last piece, and as after the API stopped before it was.
   */
  async state(user: SignedIn, id: string): Promise<UploadAnswer> {
    const row = await this.#own(user, id);
    this.#settleLater(row);
    return this.#answer(row);
  }

  /** Gives an upload up: its file goes, what the worker does with it notwithstanding. */
  async cancel(user: SignedIn, id: string): Promise<void> {
    const { db, staging, log } = this.#options;
    if (!UPLOAD_ID.test(id)) throw new UploadRefused("notFound", 404);
    const row = await db.transaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(lfsUploads)
        .where(and(eq(lfsUploads.id, id), eq(lfsUploads.userId, user.userId)))
        .for("update");
      if (!upload) throw new UploadRefused("notFound", 404);
      if (!OPEN_LFS_STATES.includes(upload.state)) return upload;
      const [cancelled] = await tx
        .update(lfsUploads)
        .set({ state: "failed", error: "cancelled", updatedAt: this.#now() })
        .where(eq(lfsUploads.id, id))
        .returning();
      return cancelled as Row;
    });
    if (row.error === "cancelled")
      await staging.remove(id).catch((error: unknown) => {
        log.warn({ err: describeError(error), upload: id }, "a staging file stays");
      });
  }

  /**
   * Reads the uploads whose file is all there through for their hashes, as the API starts: one that
   * stopped before it got to that would otherwise wait until the editor asks about it. One at a
   * time with the others that are read, see `hashing`.
   */
  async settleWaiting(): Promise<number> {
    const rows = await this.#options.db
      .select()
      .from(lfsUploads)
      .where(and(eq(lfsUploads.state, "receiving"), eq(lfsUploads.received, lfsUploads.size)));
    for (const row of rows) this.#settleLater(row);
    return rows.length;
  }

  /** Reads an upload whose file is all there through for its hash, later. */
  #settleLater(row: Row): void {
    if (row.state !== "receiving" || row.received !== row.size) return;
    void this.#settle(row.id).catch((error: unknown) => {
      this.#options.log.error({ err: describeError(error), upload: row.id }, "settling failed");
    });
  }

  /**
   * Reads the file of an upload that is all there through for its hash, once for all who ask: the
   * file it was meant to be goes on to the worker, anything else fails and goes.
   */
  #settle(id: string): Promise<UploadAnswer> {
    let settling = this.#settling.get(id);
    if (!settling) {
      settling = this.#hashing.run(() => this.#check(id)).finally(() => this.#settling.delete(id));
      this.#settling.set(id, settling);
    }
    return settling;
  }

  async #check(id: string): Promise<UploadAnswer> {
    const { db, staging, log, enqueue } = this.#options;
    const [row] = await db.select().from(lfsUploads).where(eq(lfsUploads.id, id));
    if (!row) throw new UploadRefused("notFound", 404);
    if (row.state !== "receiving" || row.received !== row.size) return this.#answer(row);
    const found = await staging.hash(id, row.size);
    const now = this.#now();
    const all = and(
      eq(lfsUploads.id, id),
      eq(lfsUploads.state, "receiving"),
      eq(lfsUploads.received, row.size),
    );
    if (found === row.oid) {
      const [received] = await db
        .update(lfsUploads)
        .set({ state: "received", receivedAt: now, updatedAt: now, nextAttemptAt: null })
        .where(all)
        .returning();
      if (received) {
        log.info({ upload: id, size: row.size }, "upload to Git LFS received");
        await enqueue(id).catch((error: unknown) => {
          // The sweep of the worker puts it into the queue then, see sweep.ts.
          log.warn({ err: describeError(error), upload: id }, "not queued for pushing yet");
        });
        return this.#answer(received);
      }
    } else {
      // Not the file it was said to be, as one that changed while it was sent; or not there.
      const [failed] = await db
        .update(lfsUploads)
        .set({ state: "failed", error: found === undefined ? "lost" : "changed", updatedAt: now })
        .where(all)
        .returning();
      if (failed) {
        log.warn({ upload: id, error: failed.error }, "upload to Git LFS failed its check");
        await staging.remove(id).catch((error: unknown) => {
          log.warn({ err: describeError(error), upload: id }, "a staging file stays");
        });
        return this.#answer(failed);
      }
    }
    const [now2] = await db.select().from(lfsUploads).where(eq(lfsUploads.id, id));
    if (!now2) throw new UploadRefused("notFound", 404);
    return this.#answer(now2);
  }
}
