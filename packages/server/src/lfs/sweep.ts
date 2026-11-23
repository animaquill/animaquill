import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { describeError, type Db, type Logger } from "../database.ts";
import { OPEN_LFS_STATES, lfsUploads } from "../schema.ts";
import type { Staging } from "./staging.ts";
import { LFS_LIFE_MS, LFS_RECEIVING_MS } from "./uploads.ts";

/**
 * What the worker tidies up of uploads into Git LFS every 15 minutes: an upload that got no piece for a day expires, and so does one that is not
 * all there three days after it was started, whatever came meanwhile, and one that could not be put
 * into the storage for a day since it came in; the staging files of uploads that are over, and
 * those of uploads the database has nothing of, go (and only files of the staging volume's own
 * names, see `Staging.list`). Uploads due to be tried again go into the queue, as a worker that
 * stopped leaves some that no job waits for, and uploads over for a week are forgotten.
 */

/** A push that has said nothing for this long stopped with its worker, see jobs.ts. */
const STALE_PUSH_MS = 3 * 3600_000;
/** Uploads that are over are kept this long, for the editor to see how they ended. */
const KEPT_MS = 7 * 24 * 3600_000;

export interface SweepResult {
  /** Uploads that expired now. */
  readonly expired: number;
  /** Staging files taken away. */
  readonly removed: number;
  /** Files in the staging folder that are not the platform's, which stay. */
  readonly others: number;
  /** Uploads due to be pushed, for the queue. */
  readonly due: readonly string[];
  /** Uploads forgotten, a week after they were over. */
  readonly forgotten: number;
}

export interface LfsSweeperOptions {
  readonly db: Db;
  readonly staging: Staging;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly lifeMs?: number;
}

export class LfsSweeper {
  readonly #options: LfsSweeperOptions;
  readonly #now: () => Date;

  constructor(options: LfsSweeperOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * `resume`: the worker starts, and nothing is being pushed. What a push left "pushing" when its
   * worker stopped is due now, not only once it is stale.
   */
  async sweep({ resume = false } = {}): Promise<SweepResult> {
    const { db, staging, log } = this.#options;
    const now = this.#now();
    const life = this.#options.lifeMs ?? LFS_LIFE_MS;
    const dayAgo = new Date(now.getTime() - life);
    const started = new Date(now.getTime() - LFS_RECEIVING_MS);

    // No piece for a day, or not all there three days after its start, whatever came: a piece
    // now and then must not hold the room of an upload for good. Or not in the storage a day
    // after it came in, and not being put there.
    const expired = await db
      .update(lfsUploads)
      .set({ state: "expired", updatedAt: now })
      .where(
        or(
          and(eq(lfsUploads.state, "receiving"), lt(lfsUploads.updatedAt, dayAgo)),
          and(eq(lfsUploads.state, "receiving"), lt(lfsUploads.createdAt, started)),
          and(eq(lfsUploads.state, "received"), lt(lfsUploads.receivedAt, dayAgo)),
          and(
            eq(lfsUploads.state, "pushing"),
            lt(lfsUploads.receivedAt, dayAgo),
            lt(lfsUploads.updatedAt, new Date(now.getTime() - STALE_PUSH_MS)),
          ),
        ),
      )
      .returning({ id: lfsUploads.id });

    // Files of uploads that are over, or that the database has nothing of. Listed first: a new
    // upload is in the database before its file is made, so one listed here is never taken for
    // that.
    let removed = 0;
    let others = 0;
    try {
      const listed = await staging.list();
      others = listed.others;
      const open = new Set<string>();
      for (let at = 0; at < listed.ids.length; at += 1000) {
        const ids = listed.ids.slice(at, at + 1000);
        const rows = await db
          .select({ id: lfsUploads.id })
          .from(lfsUploads)
          .where(and(inArray(lfsUploads.id, ids), inArray(lfsUploads.state, [...OPEN_LFS_STATES])));
        for (const { id } of rows) open.add(id);
      }
      for (const id of listed.ids) {
        if (open.has(id)) continue;
        await staging.remove(id);
        removed += 1;
      }
    } catch (error) {
      log.error({ err: describeError(error) }, "the staging folder could not be tidied up");
    }
    if (others > 0) log.warn({ others }, "files in the staging folder that are not uploads stay");

    const due = await db
      .select({ id: lfsUploads.id })
      .from(lfsUploads)
      .where(
        or(
          and(
            eq(lfsUploads.state, "received"),
            or(isNull(lfsUploads.nextAttemptAt), lte(lfsUploads.nextAttemptAt, now)),
          ),
          and(
            eq(lfsUploads.state, "pushing"),
            resume ? undefined : lt(lfsUploads.updatedAt, new Date(now.getTime() - STALE_PUSH_MS)),
          ),
        ),
      );

    const forgotten = await db
      .delete(lfsUploads)
      .where(
        and(
          inArray(lfsUploads.state, ["done", "failed", "expired"]),
          lt(lfsUploads.updatedAt, new Date(now.getTime() - KEPT_MS)),
        ),
      )
      .returning({ id: lfsUploads.id });

    return {
      expired: expired.length,
      removed,
      others,
      due: due.map(({ id }) => id),
      forgotten: forgotten.length,
    };
  }
}
