import { Readable, Transform, type TransformCallback } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import type { SignedIn } from "../auth/accounts.ts";
import { describeError, type Db, type Logger } from "../database.ts";
import { GitHubUnavailable } from "../github/client.ts";
import { isUnusable, linkOf } from "../archive/links.ts";
import {
  LfsQuota,
  RepoPaused,
  RepoRefused,
  placeOf,
  type LfsAction,
  type RepoHosts,
  type RepoRow,
} from "../archive/repo-host.ts";
import { OPEN_LFS_STATES, lfsObjects, lfsUploads, projects } from "../schema.ts";
import { readSetting, type Setting, type Settings } from "../settings.ts";

/**
 * Files of assets out of the large file storage (Git LFS) of a project's repository, for the editor
 * of another computer. The storage's addresses say nothing of CORS (measured 2026-11-15, 4.7.1), so
 * a browser cannot read them: the platform asks for them and passes on what they give, a piece at a
 * time, as it comes.
 *
 * - **Who:** whoever may read the project, as the route asks it (access.ts); the repository is
 *   the one the project is linked to, never one a request says. Any object of that repository: the
 *   installation of the App reads all of it anyway, as archiving does.
 * - **Addresses** stay here, kept in memory until a little before they run out, and are never said
 *   to the browser or written to the log: what they carry is a credential.
 * - **What goes through** is what the storage says is the part of the object that was asked for, of
 *   its size: nothing else of it, not even its headers.
 * - **How much:** so many at once of one person and of everybody; a piece of at most `mostBytes`;
 *   and so many bytes a day of one person (`LFS_DOWNLOADS_SETTING`, which admins change), as the
 *   platform's own line pays for them. A piece that stops coming, or that the browser stops taking,
 *   is let go of after `stallMs`, or once it comes slower than `pace`.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const DAY_MS = 24 * 3600_000;

export interface DownloadLimits {
  /** Pieces of one person passed on at the same time. */
  readonly perPerson: number;
  /** And of everybody. */
  readonly atOnce: number;
  /** The most a piece has: more than that is asked for again. */
  readonly mostBytes: number;
  /** How long the storage has to answer, until its headers. */
  readonly headersMs: number;
  /** How long a piece may go without a byte, either way. */
  readonly stallMs: number;
  /** Bytes a second on average after `graceMs`, looked at every `checkMs`. */
  readonly bytesPerSecond: number;
  readonly graceMs: number;
  readonly checkMs: number;
  /** How long an address is taken before it runs out, at least. */
  readonly addressSpareMs: number;
  /** What a GB of `LFS_DOWNLOADS_SETTING` is: a GiB, but in tests. */
  readonly bytesPerGb: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = {
  perPerson: 4,
  atOnce: 32,
  mostBytes: 64 * MIB,
  headersMs: 30_000,
  stallMs: 20_000,
  bytesPerSecond: 16 * KIB,
  graceMs: 10_000,
  checkMs: 1000,
  addressSpareMs: 5 * 60_000,
  bytesPerGb: GIB,
};

/** Objects one lookup asks about at most, as the batch API takes them. */
export const LOOKUP_MOST = 100;

/**
 * How much one person may download through the platform a day, in GiB (2026-11-15, 20 until the
 * user says otherwise): admins change it on the admin site or with `admin.ts lfs downloads limit`.
 */
export const LFS_DOWNLOADS_SETTING: Setting<{ readonly dailyGb: number }> = {
  key: "lfsDownloads",
  fallback: { dailyGb: 20 },
  read: (value) => {
    const gb = (value as { dailyGb?: unknown } | null)?.dailyGb;
    return typeof gb === "number" && Number.isSafeInteger(gb) && gb >= 1 && gb <= 100_000
      ? { dailyGb: gb }
      : undefined;
  },
};

/** What a download is refused for, with its HTTP status: see the routes. */
export type DownloadRefusal =
  | "notFound"
  | "notLinked"
  | "gone"
  | "githubQuota"
  | "missing"
  | "changed"
  | "busy"
  | "invalid"
  | "unavailable";

export class DownloadRefused extends Error {
  override name = "DownloadRefused";
  readonly code: DownloadRefusal;
  readonly status: number;
  readonly retryAfter: number | undefined;
  readonly detail: string | undefined;
  constructor(
    code: DownloadRefusal,
    status: number,
    extra: { readonly retryAfter?: number; readonly detail?: string } = {},
  ) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = extra.retryAfter;
    this.detail = extra.detail;
  }
}

/** What the platform says of one object that was looked up. */
export type LookupAnswer =
  | {
      readonly oid: string;
      readonly state: "ready" | "missing" | "changed" | "unavailable";
    }
  /** Not in the storage yet: an upload of it into this repository is on its way. */
  | {
      readonly oid: string;
      readonly state: "uploading";
      readonly received: number;
      readonly size: number;
    };

export interface DownloadsOptions {
  readonly db: Db;
  /** Undefined where there is no GitHub App: nothing can be downloaded. */
  readonly hosts: RepoHosts | undefined;
  readonly log: Logger;
  /** What admins set, read every few seconds; undefined to read the database each time. */
  readonly settings?: () => Settings | undefined;
  readonly limits?: Partial<DownloadLimits>;
  readonly fetch?: typeof fetch;
  /** Addresses over http are taken too, as the fake GitHub of the tests gives. */
  readonly plain?: boolean;
  readonly now?: () => number;
}

/** A piece on its way: what the browser gets, and what lets go of its place. */
export interface DownloadPiece {
  readonly start: number;
  readonly end: number;
  readonly size: number;
  readonly body: Readable;
}

const short = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** The part of an object a request asks for: `bytes=<from>-` or `bytes=<from>-<to>`. */
export const rangeOf = (
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | undefined => {
  if (header === undefined) return size > 0 ? { start: 0, end: size - 1 } : undefined;
  const found = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header.trim());
  if (!found) return undefined;
  const start = Number(found[1]);
  const end = found[2] === "" ? size - 1 : Math.min(Number(found[2]), size - 1);
  if (start >= size || end < start) return undefined;
  return { start, end };
};

/** `bytes <start>-<end>/<size>` as the storage says it, or undefined. */
const contentRangeOf = (header: string | null) => {
  const found = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(header ?? "");
  return found
    ? { start: Number(found[1]), end: Number(found[2]), size: Number(found[3]) }
    : undefined;
};

/** Places for pieces: so many of one person, and so many of everybody. */
class Places {
  readonly #perPerson: number;
  readonly #most: number;
  readonly #byPerson = new Map<string, number>();
  #taken = 0;

  constructor(perPerson: number, most: number) {
    this.#perPerson = perPerson;
    this.#most = most;
  }

  get taken(): number {
    return this.#taken;
  }

  take(person: string): (() => void) | "person" | "everyone" {
    const mine = this.#byPerson.get(person) ?? 0;
    if (mine >= this.#perPerson) return "person";
    if (this.#taken >= this.#most) return "everyone";
    this.#taken += 1;
    this.#byPerson.set(person, mine + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#taken -= 1;
      const still = (this.#byPerson.get(person) ?? 1) - 1;
      if (still > 0) this.#byPerson.set(person, still);
      else this.#byPerson.delete(person);
    };
  }
}

/**
 * What passes a piece on: no more than `length` bytes, each counted as it goes (`onBytes`), and
 * stopped where nothing came for `stallMs`, or less than `bytesPerSecond` on average after
 * `graceMs`. A browser that does not take what comes holds it back, which counts the same.
 */
class Paced extends Transform {
  readonly #length: number;
  readonly #onBytes: (bytes: number) => void;
  readonly #clock: () => number;
  #bytes = 0;
  #last: number;
  readonly #watching: ReturnType<typeof setInterval>;
  /**
   * Called once all of the piece went: what the storage sends beyond it, as all of a file where
   * it does not take ranges, is not read, nor counted.
   */
  onFull: (() => void) | undefined;

  constructor(
    length: number,
    limits: DownloadLimits,
    now: () => number,
    onBytes: (bytes: number) => void,
  ) {
    super();
    this.#length = length;
    this.#onBytes = onBytes;
    this.#clock = now;
    const started = now();
    this.#last = started;
    this.#watching = setInterval(() => {
      const at = now();
      const due = ((at - started - limits.graceMs) / 1000) * limits.bytesPerSecond;
      if (at - this.#last > limits.stallMs || this.#bytes < due)
        this.destroy(new Error("the piece came too slowly"));
    }, limits.checkMs);
    this.#watching.unref?.();
    this.once("close", () => clearInterval(this.#watching));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const room = this.#length - this.#bytes;
    if (room <= 0) return done();
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#bytes += part.length;
    this.#last = this.#clock();
    this.#onBytes(part.length);
    this.push(part);
    done();
    if (this.#bytes >= this.#length) {
      const full = this.onFull;
      this.onFull = undefined;
      if (full) queueMicrotask(full);
    }
  }

  override _flush(done: TransformCallback): void {
    clearInterval(this.#watching);
    if (this.#bytes < this.#length) return done(new Error("the storage sent less than it said"));
    done();
  }
}

export class LfsDownloads {
  readonly #options: DownloadsOptions;
  readonly #limits: DownloadLimits;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #places: Places;
  /** Addresses the storage gave, by repository and oid, until shortly before they run out. */
  readonly #addresses = new Map<string, LfsAction & { readonly until: number }>();
  /** Bytes each person downloaded on the day this counts, see `#counted`. */
  #day: number;
  #bytesOf = new Map<string, number>();

  constructor(options: DownloadsOptions) {
    this.#options = options;
    this.#limits = { ...DOWNLOAD_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#places = new Places(this.#limits.perPerson, this.#limits.atOnce);
    this.#day = Math.floor(this.#now() / DAY_MS);
  }

  /** Bytes a person downloaded today, as counted against what a day gives, for tests. */
  countedFor(userId: string): number {
    this.#roll();
    return this.#bytesOf.get(userId) ?? 0;
  }

  /** Pieces passed on right now, for tests. */
  get passing(): number {
    return this.#places.taken;
  }

  /**
   * The repository of a project, or why not. Whether this person may read it, the route asks
   * (access.ts); one that is not there has no link.
   */
  async #repoOf(_user: SignedIn, projectId: string) {
    const { db } = this.#options;
    const [there] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!there) throw new DownloadRefused("notFound", 404);
    const link = await linkOf(db, projectId);
    if (!link) throw new DownloadRefused("notLinked", 409);
    if (isUnusable(link.pauseReason)) throw new DownloadRefused("gone", 409);
    if (!this.#options.hosts?.has(link.provider)) throw new DownloadRefused("unavailable", 503);
    return link;
  }

  /** What GitHub is asked: what it cannot say now is said in the editor's words. */
  async #asking<T>(projectId: string, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof LfsQuota)
        throw new DownloadRefused("githubQuota", 409, {
          detail: short(error.message),
        });
      if (error instanceof RepoPaused) throw new DownloadRefused("gone", 409);
      if (error instanceof GitHubUnavailable)
        throw new DownloadRefused("unavailable", 503, {
          ...(error.retryAfterMs !== undefined && {
            retryAfter: Math.ceil(error.retryAfterMs / 1000),
          }),
        });
      if (error instanceof RepoRefused) {
        this.#options.log.warn(
          { err: describeError(error), project: projectId },
          "GitHub's LFS refused a download",
        );
        throw new DownloadRefused("unavailable", 503);
      }
      throw error;
    }
  }

  /** Keeps the addresses of a batch of answers, and says what each object is. */
  async #ask(
    projectId: string,
    link: RepoRow,
    objects: readonly { readonly oid: string; readonly size: number }[],
  ): Promise<readonly ("ready" | "absent" | "changed" | "unavailable")[]> {
    const hosts = this.#options.hosts as RepoHosts;
    const session = hosts.open(placeOf(link));
    const answers = await this.#asking(projectId, () => session.lfsBatch("download", objects));
    const now = this.#now();
    return answers.map((answer, index) => {
      const { oid } = objects[index] as { oid: string };
      const key = `${link.repoId}:${oid}`;
      if (answer.kind === "download") {
        const { href } = answer.download;
        let protocol: string;
        try {
          protocol = new URL(href).protocol;
        } catch {
          return "unavailable";
        }
        if (protocol !== "https:" && !(this.#options.plain && protocol === "http:"))
          return "unavailable";
        const until = Math.min(
          (answer.download.expiresAt ?? now + 3600_000) - this.#limits.addressSpareMs,
          now + 3600_000,
        );
        if (until > now) this.#addresses.set(key, { ...answer.download, until });
        return "ready";
      }
      this.#addresses.delete(key);
      if (answer.kind === "refused") {
        if (answer.code === 404 || answer.code === 410) return "absent";
        if (answer.code === 422) return "changed";
        if (/quota/i.test(answer.message))
          throw new DownloadRefused("githubQuota", 409, {
            detail: short(answer.message),
          });
        if (answer.code === 401 || answer.code === 403) throw new DownloadRefused("gone", 409);
      }
      return "unavailable";
    });
  }

  /** Forgets addresses that ran out, so that the map does not grow for ever. */
  #tidy(): void {
    const now = this.#now();
    for (const [key, address] of this.#addresses)
      if (address.until <= now) this.#addresses.delete(key);
  }

  /**
   * Says of each object whether it can be downloaded from the repository of a project: there,
   * there in another size ("changed"), on its way into it ("uploading"), or not ("missing").
   */
  async lookup(
    user: SignedIn,
    projectId: string,
    objects: readonly { readonly oid: string; readonly size: number }[],
  ): Promise<readonly LookupAnswer[]> {
    const link = await this.#repoOf(user, projectId);
    if (objects.length === 0) return [];
    this.#tidy();
    const { db } = this.#options;
    const oids = [...new Set(objects.map(({ oid }) => oid))];
    // What the platform knows the storage has, and how large: another size is not the file.
    const known = new Map(
      (
        await db
          .select({ oid: lfsObjects.oid, size: lfsObjects.size })
          .from(lfsObjects)
          .where(and(eq(lfsObjects.repoId, link.repoId), inArray(lfsObjects.oid, oids)))
      ).map(({ oid, size }) => [oid, size]),
    );
    const unique = [...new Map(objects.map((object) => [object.oid, object])).values()];
    const states = await this.#ask(projectId, link, unique);
    const stateOf = new Map(unique.map((object, index) => [object.oid, states[index]]));
    const absent = unique.filter((object) => stateOf.get(object.oid) === "absent");
    const coming = new Map(
      absent.length === 0
        ? []
        : (
            await db
              .select({
                oid: lfsUploads.oid,
                received: lfsUploads.received,
                size: lfsUploads.size,
              })
              .from(lfsUploads)
              .where(
                and(
                  eq(lfsUploads.repoId, link.repoId),
                  inArray(
                    lfsUploads.oid,
                    absent.map(({ oid }) => oid),
                  ),
                  inArray(lfsUploads.state, [...OPEN_LFS_STATES]),
                ),
              )
          ).map((row) => [row.oid, row]),
    );
    return objects.map(({ oid, size }): LookupAnswer => {
      const knownSize = known.get(oid);
      const state = stateOf.get(oid);
      if (state === "ready")
        return {
          oid,
          state: knownSize !== undefined && knownSize !== size ? "changed" : "ready",
        };
      if (state === "absent") {
        const upload = coming.get(oid);
        return upload && upload.size === size
          ? { oid, state: "uploading", received: upload.received, size }
          : { oid, state: "missing" };
      }
      return { oid, state: state ?? "unavailable" };
    });
  }

  /** How many bytes a person may download today still, as admins set it. */
  async #allowance(user: SignedIn): Promise<number> {
    const settings = this.#options.settings?.();
    const { dailyGb } = settings
      ? await settings.get(LFS_DOWNLOADS_SETTING)
      : await readSetting(this.#options.db, LFS_DOWNLOADS_SETTING);
    this.#roll();
    return dailyGb * this.#limits.bytesPerGb - (this.#bytesOf.get(user.userId) ?? 0);
  }

  /** A new day: yesterday's bytes go to the log, all together, and counting starts again. */
  #roll(): void {
    const day = Math.floor(this.#now() / DAY_MS);
    if (day === this.#day) return;
    const bytes = [...this.#bytesOf.values()].reduce((all, each) => all + each, 0);
    if (bytes > 0)
      this.#options.log.info(
        { bytes, people: this.#bytesOf.size },
        "Git LFS downloads through the platform, the day before",
      );
    this.#day = day;
    this.#bytesOf = new Map();
  }

  #counted(user: SignedIn, bytes: number): void {
    this.#roll();
    this.#bytesOf.set(user.userId, (this.#bytesOf.get(user.userId) ?? 0) + bytes);
  }

  /**
   * A piece of an object of the repository of a project, from `range` on, `mostBytes` at most: the
   * place it takes goes once `body` closes, however that happens. Rejects with `DownloadRefused`.
   */
  async piece(
    user: SignedIn,
    projectId: string,
    object: { readonly oid: string; readonly size: number },
    range: { readonly start: number; readonly end: number },
  ): Promise<DownloadPiece> {
    const allowance = await this.#allowance(user);
    if (allowance <= 0) {
      const tomorrow = (Math.floor(this.#now() / DAY_MS) + 1) * DAY_MS;
      throw new DownloadRefused("busy", 429, {
        retryAfter: Math.max(1, Math.ceil((tomorrow - this.#now()) / 1000)),
        detail: "daily",
      });
    }
    const leave = this.#places.take(user.userId);
    if (typeof leave === "string")
      throw new DownloadRefused("busy", leave === "person" ? 429 : 503, {
        retryAfter: 2,
      });
    try {
      const link = await this.#repoOf(user, projectId);
      const start = range.start;
      const end = Math.min(range.end, start + this.#limits.mostBytes - 1, object.size - 1);
      const key = `${link.repoId}:${object.oid}`;
      for (let attempt = 1; ; attempt++) {
        let address = this.#addresses.get(key);
        if (!address || address.until <= this.#now()) {
          const [state] = await this.#ask(projectId, link, [object]);
          if (state === "absent") throw new DownloadRefused("missing", 410);
          if (state === "changed") throw new DownloadRefused("changed", 409);
          address = this.#addresses.get(key);
          if (state !== "ready" || !address) throw new DownloadRefused("unavailable", 503);
        }
        const answer = await this.#get(address, start, end);
        if (answer === "expired") {
          // Taken back early, or it ran out after all: a new one, once.
          this.#addresses.delete(key);
          if (attempt === 1) continue;
          throw new DownloadRefused("unavailable", 503);
        }
        if (answer === "absent") {
          this.#addresses.delete(key);
          throw new DownloadRefused("missing", 410);
        }
        const { response } = answer;
        const said = contentRangeOf(response.headers.get("content-range"));
        const length = Number(response.headers.get("content-length"));
        let from: number;
        let total: number;
        if (response.status === 206 && said) {
          from = said.start;
          total = said.size;
        } else if (response.status === 200 && Number.isSafeInteger(length)) {
          // All of it, as a storage that does not take ranges answers: only from its start.
          from = 0;
          total = length;
        } else {
          await response.body?.cancel().catch(() => {});
          throw new DownloadRefused("unavailable", 503);
        }
        if (total !== object.size) {
          await response.body?.cancel().catch(() => {});
          throw new DownloadRefused("changed", 409);
        }
        if (from !== start || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new DownloadRefused("unavailable", 503);
        }
        const paced = new Paced(end - start + 1, this.#limits, this.#now, (bytes) =>
          this.#counted(user, bytes),
        );
        const source = Readable.fromWeb(response.body as never);
        source.on("error", (error) => paced.destroy(error));
        // The rest of what the storage sends is not read: the connection goes.
        paced.onFull = () => {
          source.unpipe(paced);
          source.destroy();
          paced.end();
        };
        paced.once("close", () => {
          leave();
          source.destroy();
        });
        source.pipe(paced);
        return { start, end, size: object.size, body: paced };
      }
    } catch (error) {
      leave();
      throw error;
    }
  }

  /** The storage's answer to a GET of part of an object, until its headers. */
  async #get(
    address: LfsAction,
    start: number,
    end: number,
  ): Promise<{ readonly response: Response } | "expired" | "absent"> {
    const headers = new Headers(address.header);
    headers.set("accept-encoding", "identity");
    headers.set("range", `bytes=${start}-${end}`);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.#limits.headersMs);
    let response: Response;
    try {
      response = await this.#fetch(address.href, {
        method: "GET",
        headers,
        // The headers of an address go where it says, and nowhere else.
        redirect: "manual",
        signal: stop.signal,
      });
    } catch (error) {
      throw new DownloadRefused("unavailable", 503, {
        detail: error instanceof Error ? error.name : "failed",
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return "expired";
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return "absent";
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadRefused("unavailable", 503);
    }
    return { response };
  }
}
