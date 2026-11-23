import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { backoffMs } from "../archive/links.ts";
import { LfsQuota, RepoPaused, type RepoHost } from "../archive/repo-host.ts";
import { describeError, type Db, type Logger } from "../database.ts";
import { GitHubUnavailable } from "../github/client.ts";
import { lfsObjects, lfsUploads, projectRepos, projects, users } from "../schema.ts";
import type { Staging } from "./staging.ts";
import { NotTheObject, TransferFailed, putObject, transferMs, verifyObject } from "./transfer.ts";
import { LFS_LIFE_MS, refusalOf } from "./uploads.ts";

/**
 * The worker puts files that came in whole into the large file storage of their repository: it asks
 * GitHub's batch API every time, as the addresses it gives last 15 minutes; an object GitHub has
 * already is there; anything else goes in one PUT from the staging file (basic transfers do not go
 * on from where they stopped), and is verified. Then the platform notes the object (`lfs_objects`),
 * which archives write pointers to, and the staging file goes, as it is not needed any more. Never
 * before: what is not in the storage can still go there.
 *
 * Only the file itself is ever noted. The staging file was read through for its hash when it came
 * in (uploads.ts), and is hashed again as it goes out: one that is not the file any more, whatever
 * changed it, stops before its end, fails as "changed", and goes (transfer.ts). And an object GitHub
 * says it has is noted only where the storage has it as large as the file is, see `lfsSizes`.
 *
 * What GitHub says no to for good (no room, too large, the repository gone) fails the upload; what
 * fails otherwise is tried again, 1, 2, 4… up to 60 minutes later, for a day from when it came in,
 * and then the upload expires. Both take the staging file away: the editor has the file and can
 * start again. The queue runs two at a time, see jobs.ts.
 */

export type PushOutcome =
  /** Not an upload to push now: done, failed, not there, or not due yet. */
  | { readonly kind: "none" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly error: string }
  /** Tried again at `at`, which the queue has to know. */
  | { readonly kind: "later"; readonly at: Date }
  | { readonly kind: "expired" };

export interface LfsPusherOptions {
  readonly db: Db;
  readonly host: RepoHost;
  readonly staging: Staging;
  readonly log: Logger;
  /** What reaches the storage's own addresses, for tests. */
  readonly fetch?: typeof fetch;
  /** How long sending a file of a size may take, see `transferMs`. */
  readonly transferMs?: (size: number) => number;
  readonly now?: () => Date;
  /** How long an upload is tried, from when it came in. */
  readonly lifeMs?: number;
}

type Row = typeof lfsUploads.$inferSelect;

const isCode = (error: unknown, ...codes: string[]) =>
  codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");

/** How long to wait before trying again someone who is disabled: their uploads wait, as archives do. */
const DISABLED_WAIT_MS = 60 * 60_000;

export class LfsPusher {
  readonly #options: LfsPusherOptions;
  readonly #now: () => Date;

  constructor(options: LfsPusherOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Puts the file of an upload into the storage, if it is one to push now. Never rejects. */
  async push(id: string): Promise<PushOutcome> {
    try {
      return await this.#push(id);
    } catch (error) {
      // The database: the sweep comes back to it.
      this.#options.log.error({ err: describeError(error), upload: id }, "pushing failed");
      return { kind: "none" };
    }
  }

  async #push(id: string): Promise<PushOutcome> {
    const { db, host, staging, log } = this.#options;
    const now = this.#now();
    // Taken: one push of an upload at a time, which the queue sees to; a push that stopped with
    // its worker leaves it "pushing", and the next one takes it over.
    const [row] = await db
      .update(lfsUploads)
      .set({ state: "pushing", attempts: sql`${lfsUploads.attempts} + 1`, updatedAt: now })
      .where(
        and(
          eq(lfsUploads.id, id),
          inArray(lfsUploads.state, ["received", "pushing"]),
          or(isNull(lfsUploads.nextAttemptAt), lte(lfsUploads.nextAttemptAt, now)),
        ),
      )
      .returning();
    if (!row) return { kind: "none" };
    try {
      const [link] = await db
        .select({ installationId: projectRepos.installationId, disabledAt: users.disabledAt })
        .from(projectRepos)
        .innerJoin(projects, eq(projects.id, projectRepos.projectId))
        .innerJoin(users, eq(users.id, projects.ownerId))
        .where(and(eq(projectRepos.projectId, row.projectId), eq(projectRepos.repoId, row.repoId)));
      if (!link) return this.#fail(row, "gone", "the project is not saved to this repository now");
      // Nothing goes to GitHub for someone disabled: it waits, as far as it may.
      if (link.disabledAt !== null)
        return this.#later(row, "the account is disabled", DISABLED_WAIT_MS);
      const session = host.open({ installationId: link.installationId, repoId: row.repoId });
      const object = { oid: row.oid, size: row.size };
      // Every time: the addresses it gives out last a quarter of an hour.
      const [answer] = await session.lfsBatch("upload", [object]);
      if (answer?.kind === "present") {
        // It goes by the oid: how large what it has is, the storage says itself. What came in is
        // the file (its hash is that of this many bytes), so anything else there is not.
        const stored =
          answer.size !== undefined && answer.size !== row.size
            ? answer.size
            : (await session.lfsSizes([object]))[0];
        if (stored !== row.size)
          return this.#fail(
            row,
            "changed",
            `the storage has a file of this hash that is ${stored ?? "not"} as large`,
          );
        return this.#done(row);
      }
      if (answer?.kind === "refused") {
        const { error, detail } = refusalOf(answer);
        return this.#fail(row, error, detail);
      }
      if (answer?.kind !== "upload") return this.#later(row, "no address to put the file");
      const content = await staging.reader(id, row.size);
      const transfer = {
        ...(this.#options.fetch && { fetch: this.#options.fetch }),
        timeoutMs: (this.#options.transferMs ?? transferMs)(row.size),
      };
      await putObject(answer.upload, content, object, transfer);
      if (answer.verify) await verifyObject(answer.verify, object, transfer);
      log.info({ upload: id, size: row.size, attempt: row.attempts }, "pushed to Git LFS");
      return this.#done(row);
    } catch (error) {
      if (error instanceof LfsQuota) return this.#fail(row, "githubQuota", error.message);
      if (error instanceof RepoPaused) return this.#fail(row, "gone", error.message);
      // Not the file that came in and was checked: something changed it where it waited.
      if (error instanceof NotTheObject)
        return this.#fail(row, "changed", "what the platform had of the file was not the file");
      if (isCode(error, "ENOENT", "ESHORT"))
        return this.#fail(row, "lost", "what the platform had of the file is gone");
      const known = error instanceof TransferFailed || error instanceof GitHubUnavailable;
      log[known ? "warn" : "error"](
        { err: describeError(error), upload: id, attempt: row.attempts },
        "pushing to Git LFS failed, trying again later",
      );
      const wait = error instanceof GitHubUnavailable ? error.retryAfterMs : undefined;
      return this.#later(row, describeError(error).message as string, undefined, wait);
    }
  }

  /** The storage has it: noted, for archives, and the staging file goes. */
  async #done(row: Row): Promise<PushOutcome> {
    const { db } = this.#options;
    const now = this.#now();
    await db.transaction(async (tx) => {
      await tx
        .insert(lfsObjects)
        .values({ repoId: row.repoId, oid: row.oid, size: row.size, confirmedAt: now })
        .onConflictDoNothing();
      // Given up meanwhile, it stays given up: the storage has the file all the same.
      await tx
        .update(lfsUploads)
        .set({ state: "done", error: null, detail: null, nextAttemptAt: null, updatedAt: now })
        .where(and(eq(lfsUploads.id, row.id), eq(lfsUploads.state, "pushing")));
    });
    await this.#removeFile(row.id);
    return { kind: "done" };
  }

  async #fail(row: Row, error: string, detail: string): Promise<PushOutcome> {
    this.#options.log.warn({ upload: row.id, error }, "pushing to Git LFS failed for good");
    await this.#options.db
      .update(lfsUploads)
      .set({ state: "failed", error, detail: detail.slice(0, 200), updatedAt: this.#now() })
      .where(and(eq(lfsUploads.id, row.id), eq(lfsUploads.state, "pushing")));
    await this.#removeFile(row.id);
    return { kind: "failed", error };
  }

  /** Tried again later, within a day of when it came in; after that, it expires. */
  async #later(
    row: Row,
    detail: string,
    waitMs?: number,
    retryAfterMs?: number,
  ): Promise<PushOutcome> {
    const { db } = this.#options;
    const now = this.#now();
    const since = row.receivedAt ?? row.createdAt;
    const at = new Date(now.getTime() + (waitMs ?? backoffMs(row.attempts - 1, retryAfterMs)));
    if (at.getTime() - since.getTime() > (this.#options.lifeMs ?? LFS_LIFE_MS)) {
      await db
        .update(lfsUploads)
        .set({ state: "expired", detail: detail.slice(0, 200), updatedAt: now })
        .where(and(eq(lfsUploads.id, row.id), eq(lfsUploads.state, "pushing")));
      await this.#removeFile(row.id);
      return { kind: "expired" };
    }
    await db
      .update(lfsUploads)
      .set({ state: "received", nextAttemptAt: at, detail: detail.slice(0, 200), updatedAt: now })
      .where(and(eq(lfsUploads.id, row.id), eq(lfsUploads.state, "pushing")));
    return { kind: "later", at };
  }

  async #removeFile(id: string): Promise<void> {
    await this.#options.staging.remove(id).catch((error: unknown) => {
      // The sweep takes it away, see sweep.ts.
      this.#options.log.warn({ err: describeError(error), upload: id }, "a staging file stays");
    });
  }
}
