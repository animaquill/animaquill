import { MAX_SOURCE_BYTES, isDocument, isProjectFile, isProjectFolder } from "@animaquill/core";
import { SYNC_LIMITS } from "@animaquill/host/sync";
import { LFS_POINTER_MAX_BYTES, readLfsPointer } from "@animaquill/schema";
import { and, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { describeError, withLock, type Db, type Logger, type Tx } from "../database.ts";
import type { Jobs } from "../jobs.ts";
import {
  lfsObjects,
  projectRepos,
  projects,
  projectSnapshots,
  projectUpdates,
  users,
  type CopyProblem,
  type ReleasedFrom,
} from "../schema.ts";
import { digestOf, lockProject } from "../sync/hub.ts";
import type { BuiltProject } from "./export-worker.ts";
import type { ProjectExporter } from "./exporter.ts";
import { ARCHIVE_LOCK, linkOf, type Link } from "./links.ts";
import { topFoldersOf } from "./pointers.ts";
import {
  RepoPaused,
  type LfsObject,
  hereOf,
  placeOf,
  type RepoHosts,
  type RepoProvider,
  type RepoSession,
  type TreeEntry,
} from "./repo-host.ts";

/**
 * Making the working copy of a project again from its repository, in the worker: the platform keeps
 * a project's list entry for good, and its working copy only while it is used. Two ways in, the
 * same work:
 *
 * - A project the platform let go of (`copy_state` "released", `released_from`): made from the
 *   commit of its last archive, which is known to read as a project. Its updates go on from the
 *   head it had, and it is the next working copy (`generation` + 1): another document of Yjs, which
 *   what a window has of the one before cannot go on with, see "hello" of the protocol.
 * - Restoring a repository as a new project (`RepositoryService.restore`): made from the last commit
 *   of the branch, its first working copy, archived up to that commit.
 *
 * The files of the project are read from the commit, all at once (`RepoSession.files`), made into a
 * project in the export thread, and checked as the platform checks the first version a window sends
 * (`ProjectExporter.build`), within what the person may keep. Then, in one transaction under the
 * lock of the project's id, it becomes one update and its snapshot, and the copy is "live" again.
 * Before that nothing of it is written: whatever fails halfway (GitHub, the thread, the worker
 * stopping) leaves the project as it was, and one that failed goes back to "released" with why
 * (`copy_problem`), to be tried again when it is asked for again.
 *
 * Only a project that is "restoring", which only `wakeCopy` (sync/wake.ts) and restoring make, and
 * only where the database has nothing of a working copy of it: nothing is ever made over changes the
 * repository may not have. It holds the lock of the project's archives meanwhile, as an archive
 * does, and what it found is written only where nothing changed since it began: not the copy's
 * state, its generation, where it was let go of, nor the repository. A project that went meanwhile
 * gets nothing.
 *
 * Changes on GitHub after the last archive are not taken in here: the copy is what the platform
 * archived, which is what a window of the copy before has in common with it. Until the platform
 * merges changes on GitHub (step 2B of the plan), an archive that only looks is queued afterwards:
 * it finds them, and archiving pauses ("diverged") without writing over any of them, as for any
 * project whose files changed on GitHub.
 *
 * The assets in Git LFS of the repository: what the files point at is asked of the storage, for those
 * the platform does not know of (`lfs_objects`), and noted where it has them, so that archives go on
 * writing their pointers. What cannot be asked now an archive asks again.
 */

/** The queue of the work, one project waiting and one running at most. */
export const REBUILD_QUEUE = "copy-rebuild";
/** Every minute: projects "restoring" whose work went missing, as a worker that stopped. */
export const REBUILD_SCAN_QUEUE = "copy-rebuild-scan";
/** Objects of Git LFS the storage is asked about in one go at most; the rest an archive asks. */
const ASKED_MOST = 100;

/**
 * Bytes of the files of a repository that are read for a copy, together, at most, and of any one
 * document (the review of step RB, 1): what the platform takes of a project as a first version
 * (`SYNC_LIMITS.state`, as Yjs encodes it) a few times over, as the files are JSON written out
 * with indents, larger than what Yjs keeps of them. Code larger than the editor takes
 * (`MAX_SOURCE_BYTES`) is no file of the project, and is not read at all. All of it is looked at
 * in the listing of the tree, which says how large each file is, before any of it is read: a
 * repository larger than this is "tooLarge", and nothing of it comes into the worker.
 */
export const READ_MOST_BYTES = 4 * SYNC_LIMITS.state;

/**
 * How long one try may take at most, from the first request to GitHub to the copy, however slow
 * GitHub is: then it stops, as for GitHub not there ("unavailable"), and the worker goes on with
 * the archives that wait behind it.
 */
export const REBUILD_DEADLINE_MS = 5 * 60_000;

/**
 * A try the worker began this long ago without coming to an end did not live through it, as the
 * worker stopped: the scan queues it again (`sweepRestoring`).
 */
export const STOPPED_AFTER_MS = REBUILD_DEADLINE_MS + 2 * 60_000;

/**
 * Tries in a row that do not come to a copy, after which it is not queued again by itself: one the
 * platform let go of waits until it is asked for, after `retryDelayMs`; a restore that never came
 * to a copy goes.
 */
export const MOST_ATTEMPTS = 3;

/**
 * Why a copy does not come that only people can put right, as what the repository has: tried again
 * only after hours, or as people ask for the branch as it is (sync/wake.ts).
 */
export const PERMANENT_PROBLEMS: ReadonlySet<CopyProblem["code"]> = new Set([
  "unreadable",
  "notProject",
  "tooLarge",
  "tooNew",
  "identity",
]);

/** For what the repository has: hours. */
const PERMANENT_RETRY_MS = 6 * 3600_000;

/**
 * After how long a copy that did not come is tried again, as it is asked for: a minute, two, four,
 * … up to an hour after tries in a row; hours for what only people can put right.
 */
export const retryDelayMs = (code: CopyProblem["code"], attempts: number): number =>
  PERMANENT_PROBLEMS.has(code)
    ? PERMANENT_RETRY_MS
    : Math.min(3600_000, 60_000 * 2 ** Math.max(0, Math.min(attempts, 12) - 1));

export interface RebuildJob {
  readonly project: string;
}

export type RebuildOutcome =
  /** Not "restoring", or not there: nothing to do. */
  | { readonly kind: "none" }
  /** Its archive or another rebuild runs: tried again in a while. */
  | { readonly kind: "busy" }
  | { readonly kind: "rebuilt"; readonly seq: number; readonly generation: number }
  /**
   * It did not come to a copy, for what `problem` says. `retryInMs`: a restore that is tried
   * again by itself then; `removed`: a restore that never came to a copy, and went.
   */
  | {
      readonly kind: "failed";
      readonly problem: CopyProblem;
      readonly retryInMs?: number;
      readonly removed?: true;
    };

/** It did not come to a copy, for what `problem` says: the project goes back to "released". */
class Refused extends Error {
  override name = "Refused";
  readonly problem: Omit<CopyProblem, "at">;
  constructor(problem: Omit<CopyProblem, "at">, message: string = problem.code) {
    super(message);
    this.problem = problem;
  }
}

/** What was read of the repository, see `Rebuilder.#read`. */
interface Read {
  /** The commit the copy is made from. */
  readonly sha: string;
  /**
   * Whether it is made from the archive the copy before was let go of at, which is what that one
   * has in common with it; not where that is not there any more, or people asked for the branch.
   */
  readonly commonBase: boolean;
  readonly built: Extract<BuiltProject, { ok: true }>;
  /** Files of the project read. */
  readonly files: number;
  /** What the pointers of Git LFS of its assets point at. */
  readonly pointers: readonly LfsObject[];
}

/** What the database had of the project when the work began, which has to be so when it ends. */
interface Began {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly head: number;
  readonly digest: string;
  readonly generation: number;
  readonly releasedFrom: ReleasedFrom | null;
  readonly provider: RepoProvider;
  readonly repoId: number;
  /** People asked for the branch as it is, see `projects.rebuild_from_branch`. */
  readonly fromBranch: boolean;
  /** Which try this is, in a row. */
  readonly attempt: number;
}

export interface RebuilderOptions {
  readonly db: Db;
  /** The repositories, on whichever provider: see repo-host.ts. */
  readonly hosts: RepoHosts;
  readonly exporter: ProjectExporter;
  readonly log: Logger;
  /** Has the repository looked at once the copy is here again, see above. */
  readonly lookAgain?: ((projectId: string) => Promise<void>) | undefined;
  /** How long a try may take: `REBUILD_DEADLINE_MS` unless said. */
  readonly deadlineMs?: number;
  readonly now?: () => Date;
}

export class Rebuilder {
  readonly #db: Db;
  readonly #hosts: RepoHosts;
  readonly #exporter: ProjectExporter;
  readonly #log: Logger;
  readonly #lookAgain: ((projectId: string) => Promise<void>) | undefined;
  readonly #deadlineMs: number;
  readonly #now: () => Date;

  constructor(options: RebuilderOptions) {
    this.#deadlineMs = options.deadlineMs ?? REBUILD_DEADLINE_MS;
    this.#db = options.db;
    this.#hosts = options.hosts;
    this.#exporter = options.exporter;
    this.#log = options.log;
    this.#lookAgain = options.lookAgain;
    this.#now = options.now ?? (() => new Date());
  }

  /** Makes the working copy of a project again, where it is "restoring". Never rejects. */
  async run(id: string): Promise<RebuildOutcome> {
    try {
      const locked = await withLock(this.#db, ARCHIVE_LOCK, id, () => this.#rebuild(id));
      return locked.held ? locked.value : { kind: "busy" };
    } catch (error) {
      // Only the database can fail out here: the project stays "restoring", and the scan comes
      // back to it.
      this.#log.error({ err: describeError(error), project: id }, "a working copy was not made");
      return {
        kind: "failed",
        problem: { code: "unavailable", at: this.#now().getTime() },
      };
    }
  }

  async #rebuild(id: string): Promise<RebuildOutcome> {
    const [row] = await this.#db
      .select({
        ownerId: projects.ownerId,
        projectId: projects.projectId,
        head: projects.head,
        digest: projects.digest,
        copyState: projects.copyState,
        generation: projects.generation,
        releasedFrom: projects.releasedFrom,
        fromBranch: projects.rebuildFromBranch,
        disabledAt: users.disabledAt,
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(eq(projects.id, id));
    if (!row || row.copyState !== "restoring") return { kind: "none" };
    // The try is counted before anything is read, so that one the worker does not live through
    // counts too (`sweepRestoring`).
    const [counted] = await this.#db
      .update(projects)
      .set({
        rebuildAttempts: sql`${projects.rebuildAttempts} + 1`,
        rebuildStartedAt: this.#now(),
      })
      .where(and(eq(projects.id, id), eq(projects.copyState, "restoring")))
      .returning({ attempts: projects.rebuildAttempts });
    if (!counted) return { kind: "none" };
    const attempt = counted.attempts;
    const link = await linkOf(this.#db, id);
    if (!link)
      return this.#failed(
        id,
        attempt,
        { code: "unusable", reason: "noRepository" },
        "no repository",
      );
    // Nothing comes from GitHub for someone disabled (admin/users.ts): it waits, as archives do.
    if (row.disabledAt !== null)
      return this.#failed(id, attempt, { code: "unavailable" }, "the person is disabled");
    // A repository on a provider this server is not set up for: it waits, as for GitHub away.
    if (!this.#hosts.has(link.provider))
      return this.#failed(
        id,
        attempt,
        { code: "unavailable" },
        `this server is not set up for repositories on ${link.provider}`,
      );
    const began: Began = {
      id,
      ownerId: row.ownerId,
      projectId: row.projectId,
      head: row.head,
      digest: row.digest,
      generation: row.generation,
      releasedFrom: row.releasedFrom,
      provider: link.provider,
      repoId: link.repoId,
      fromBranch: row.fromBranch,
      attempt,
    };
    // However slow GitHub is: every request stops at the deadline, and so does the thread.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("the deadline passed")), this.#deadlineMs);
    timer.unref?.();
    const session = this.#hosts.open(placeOf(link), { signal: stop.signal });
    const exporting = this.#exporter.open();
    const ended = () => void exporting.close().catch(() => {});
    stop.signal.addEventListener("abort", ended, { once: true });
    try {
      const read = await this.#read(began, link, session, (files, here) =>
        exporting.build(files, here),
      );
      stop.signal.throwIfAborted();
      const landed = await this.#land(began, read);
      if (landed.kind !== "rebuilt") return landed;
      this.#log.info(
        {
          project: id,
          generation: landed.generation,
          seq: landed.seq,
          files: read.files,
          bytes: read.built.state.length,
          restore: began.releasedFrom === null,
          commonBase: read.commonBase,
        },
        "a working copy was made from the repository",
      );
      await this.#noteLfs(session, link, read.pointers);
      // Changes on GitHub since the archive it was made from: found by an archive that looks.
      if (began.releasedFrom !== null)
        await this.#lookAgain?.(id).catch((error: unknown) => {
          this.#log.warn({ err: describeError(error), project: id }, "no check after a rebuild");
        });
      return landed;
    } catch (error) {
      if (stop.signal.aborted)
        return this.#failed(id, attempt, { code: "unavailable", reason: "timeout" }, "too long");
      if (error instanceof Refused) return this.#failed(id, attempt, error.problem, error.message);
      if (error instanceof RepoPaused)
        return this.#failed(id, attempt, { code: "unusable", reason: error.reason }, error.message);
      return this.#failed(
        id,
        attempt,
        { code: "unavailable" },
        String(describeError(error).message ?? "failed"),
        error,
      );
    } finally {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", ended);
      await exporting.close().catch(() => {});
      await session.close().catch(() => {});
    }
  }

  /**
   * The project from the repository: the commit it is made from, its files, and what the export
   * thread made of them; and the pointers of Git LFS there that its assets have.
   */
  async #read(
    began: Began,
    link: Link,
    session: RepoSession,
    build: (
      files: ReadonlyMap<string, Uint8Array>,
      here: { repo: string },
    ) => Promise<BuiltProject>,
  ): Promise<Read> {
    const info = await session.info();
    // On another account by now: someone else's, which nothing is read from.
    if (info.ownerId !== link.ownerId) throw new RepoPaused("gone", "the repository moved");
    let sha: string | undefined;
    let commonBase = false;
    if (began.releasedFrom !== null && !began.fromBranch) {
      sha = began.releasedFrom.headSha;
      commonBase = true;
      // Not there any more, as the branch was set back elsewhere: the branch as it is.
      if (!(await session.commit(sha))) {
        commonBase = false;
        sha = await session.tip(info.branch);
      }
    } else {
      sha = await session.tip(info.branch);
    }
    if (sha === undefined) throw new Refused({ code: "notProject" }, "an empty repository");
    const commit = await session.commit(sha);
    if (!commit) throw new Refused({ code: "unavailable" }, "the commit is not there");
    const top = await session.tree(commit.tree);
    const entries: TreeEntry[] = [];
    const listed = new Map<string, TreeEntry>();
    const list = async (entry: TreeEntry) => {
      for (const inner of await session.tree(entry.sha, { recursive: true })) {
        const path = `${entry.path}/${inner.path}`;
        listed.set(path, { ...inner, path });
      }
    };
    for (const entry of top) {
      if (entry.type === "tree") {
        if (isProjectFolder(entry.path)) await list(entry);
      } else listed.set(entry.path, entry);
    }
    // How large they are, as the listing says, before anything of them is read.
    let total = 0;
    const tooLarge: string[] = [];
    for (const entry of listed.values()) {
      if (entry.type !== "blob" || entry.mode === "120000" || !isProjectFile(entry.path)) continue;
      const size = entry.size;
      if (size === undefined) throw new Refused({ code: "unavailable" }, "a file without its size");
      if (!isDocument(entry.path)) {
        // Code larger than the editor takes is not the project's: not read.
        if (size > MAX_SOURCE_BYTES) continue;
      } else if (size > READ_MOST_BYTES) {
        tooLarge.push(entry.path);
        continue;
      }
      total += size;
      entries.push(entry);
    }
    if (tooLarge.length > 0 || total > READ_MOST_BYTES)
      throw new Refused(
        {
          code: "tooLarge",
          ...(tooLarge.length > 0 && { files: tooLarge.toSorted().slice(0, 50) }),
        },
        `${total} bytes of files`,
      );
    const files = await session.files(sha, entries);
    const built = await build(files, hereOf(link));
    if (!built.ok) {
      this.#log.warn(
        { project: began.id, code: built.code, files: built.files, problems: built.problems },
        "the repository does not make a project",
      );
      throw new Refused({ code: built.code, ...(built.files && { files: built.files }) });
    }
    if (began.releasedFrom !== null && built.projectId !== began.projectId)
      throw new Refused({ code: "identity" }, "another project than it was");
    // The pointers of its assets in Git LFS, where the repository has them.
    const folders = topFoldersOf(built.lfs.map(([path]) => path));
    for (const entry of top)
      if (entry.type === "tree" && folders.has(entry.path) && !isProjectFolder(entry.path))
        await list(entry);
    const small = built.lfs.flatMap(([path]) => {
      const entry = listed.get(path);
      return entry?.type === "blob" &&
        entry.mode !== "120000" &&
        entry.size !== undefined &&
        entry.size < LFS_POINTER_MAX_BYTES
        ? [entry]
        : [];
    });
    const texts = small.length === 0 ? new Map() : await session.files(sha, small);
    const pointers: LfsObject[] = [];
    for (const [path, oid, size] of built.lfs) {
      const bytes = texts.get(path);
      const pointer = bytes && readLfsPointer(Buffer.from(bytes).toString("utf8"));
      if (pointer && pointer.oid === oid && pointer.size === size) pointers.push({ oid, size });
    }
    return { sha, commonBase, built, files: entries.length, pointers };
  }

  /**
   * Writes the copy, in one transaction, where nothing changed since the work began: one update
   * after the head it had, its snapshot, and the same once more as where this copy began (reason
   * "base", which compacting leaves, for "hello" with `base`).
   */
  async #land(began: Began, read: Read): Promise<RebuildOutcome> {
    const { built, sha, commonBase } = read;
    const state = Buffer.from(built.state);
    const at = this.#now();
    const isRestore = began.releasedFrom === null;
    return this.#db.transaction(
      async (tx): Promise<RebuildOutcome> => {
        await lockProject(tx, began.id);
        await tx
          .select({ repoId: projectRepos.repoId })
          .from(projectRepos)
          .where(eq(projectRepos.projectId, began.id))
          .for("update");
        const [now] = await tx
          .select({
            head: projects.head,
            digest: projects.digest,
            copyState: projects.copyState,
            generation: projects.generation,
            releasedFrom: projects.releasedFrom,
            fromBranch: projects.rebuildFromBranch,
          })
          .from(projects)
          .where(eq(projects.id, began.id))
          .for("update");
        const [link] = await tx
          .select({ provider: projectRepos.provider, repoId: projectRepos.repoId })
          .from(projectRepos)
          .where(eq(projectRepos.projectId, began.id));
        if (
          !now ||
          now.copyState !== "restoring" ||
          now.head !== began.head ||
          now.generation !== began.generation ||
          JSON.stringify(now.releasedFrom) !== JSON.stringify(began.releasedFrom) ||
          now.fromBranch !== began.fromBranch ||
          link?.provider !== began.provider ||
          link.repoId !== began.repoId
        ) {
          this.#log.info({ project: began.id }, "the project changed while its copy was made");
          return { kind: "none" };
        }
        // Nothing of a working copy may be there: one is never made over another.
        if (await hasCopy(tx, began.id)) {
          this.#log.error(
            { project: began.id },
            "a project that is restoring has updates: no copy is made over them",
          );
          const problem: CopyProblem = {
            code: "unavailable",
            at: at.getTime(),
            retryAt: at.getTime() + retryDelayMs("unavailable", began.attempt),
          };
          await this.#noteFailed(tx, began.id, problem);
          return { kind: "failed", problem };
        }
        // Never turned away for what the person keeps (`storage.platform`, sync/room.ts): a project
        // that is there is made again whatever they have, as one they let go of is opened. Only a
        // new one is, as restoring asks before this runs.
        const seq = began.head + 1;
        const digest = digestOf(began.digest, seq, state);
        const generation = isRestore ? began.generation : began.generation + 1;
        await tx.insert(projectUpdates).values({
          projectId: began.id,
          seq,
          digest,
          data: state,
          kind: "first",
          device: "platform",
          window: "rebuild",
          base: began.head,
          behind: false,
          madeAt: at,
          createdAt: at,
        });
        for (const reason of ["compact", "base"])
          await tx.insert(projectSnapshots).values({
            projectId: began.id,
            seq,
            digest,
            state,
            reason,
            createdAt: at,
          });
        await tx
          .update(projects)
          .set({
            head: seq,
            digest,
            bytes: state.length,
            name: built.name,
            ...(isRestore && { projectId: built.projectId }),
            copyState: "live",
            generation,
            copyProblem: null,
            releasedAt: null,
            dirtySince: null,
            rebuildAttempts: 0,
            rebuildStartedAt: null,
            rebuildFromBranch: false,
            // What a window of the copy before has in common with this one, which it goes by.
            ...(began.releasedFrom !== null && {
              releasedFrom: { ...began.releasedFrom, commonBase },
            }),
          })
          .where(eq(projects.id, began.id));
        await tx
          .update(projectRepos)
          .set({
            headSha: sha,
            archivedSeq: seq,
            pendingSha: null,
            pending: null,
            ...(isRestore && { lfsPaths: [], checkedAt: at }),
          })
          .where(eq(projectRepos.projectId, began.id));
        return { kind: "rebuilt", seq, generation };
      },
      { isolationLevel: "read committed" },
    );
  }

  /**
   * It did not come to a copy, for what `problem` says, on the `attempt`th try in a row: see
   * `#failedIn`.
   */
  async #failed(
    id: string,
    attempt: number,
    problem: Omit<CopyProblem, "at" | "retryAt">,
    detail: string,
    error?: unknown,
  ): Promise<RebuildOutcome> {
    const at = this.#now().getTime();
    const noted: CopyProblem = {
      ...problem,
      at,
      retryAt: at + retryDelayMs(problem.code, attempt),
    };
    this.#log[problem.code === "unavailable" ? "warn" : "info"](
      {
        project: id,
        code: problem.code,
        attempt,
        detail: detail.slice(0, 200),
        ...(error !== undefined && { err: describeError(error) }),
      },
      "a working copy could not be made from the repository",
    );
    return this.#db.transaction(async (tx) => {
      await lockProject(tx, id);
      return this.#failedIn(tx, id, attempt, noted);
    });
  }

  /**
   * In the transaction that holds the project's id: one the platform let go of goes back to
   * "released", with why, and is tried again as it is asked for, from `problem.retryAt`. A restore
   * that never came to a copy (sync/wake.ts has no copy of it to go back to) is tried again by
   * itself where GitHub or the platform failed, `MOST_ATTEMPTS` times in all; otherwise it goes,
   * with its link, so that nothing holds the repository, and it can be restored again. While a
   * request to restore it waits for the answer (`linking_until`), it is left "released" with why,
   * for the request to say so, and to take it away.
   */
  async #failedIn(
    tx: Tx,
    id: string,
    attempt: number,
    problem: CopyProblem,
  ): Promise<RebuildOutcome> {
    const [row] = await tx
      .select({
        copyState: projects.copyState,
        head: projects.head,
        releasedFrom: projects.releasedFrom,
        linkingUntil: projects.linkingUntil,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .for("update");
    if (!row || row.copyState !== "restoring") return { kind: "none" };
    const neverMade = row.releasedFrom === null && row.head === 0;
    if (neverMade && !PERMANENT_PROBLEMS.has(problem.code) && attempt < MOST_ATTEMPTS) {
      await tx
        .update(projects)
        .set({ copyProblem: problem, rebuildStartedAt: null })
        .where(eq(projects.id, id));
      return {
        kind: "failed",
        problem,
        retryInMs: Math.max(0, (problem.retryAt ?? problem.at) - problem.at),
      };
    }
    const waited = row.linkingUntil !== null && row.linkingUntil.getTime() > this.#now().getTime();
    if (neverMade && !waited) {
      await tx.delete(projects).where(eq(projects.id, id));
      this.#log.info({ project: id, code: problem.code }, "a restore that came to nothing went");
      return { kind: "failed", problem, removed: true };
    }
    await this.#noteFailed(tx, id, problem);
    return { kind: "failed", problem };
  }

  async #noteFailed(tx: Tx, id: string, problem: CopyProblem): Promise<void> {
    await tx
      .update(projects)
      .set({
        copyState: "released",
        copyProblem: problem,
        rebuildStartedAt: null,
        rebuildFromBranch: false,
      })
      .where(and(eq(projects.id, id), eq(projects.copyState, "restoring")));
  }

  /**
   * Notes the objects of Git LFS that the pointers of the project point at, where the storage has
   * them and the platform did not know: so that archives go on writing their pointers. Whatever
   * cannot be asked now, the next archive asks.
   */
  async #noteLfs(session: RepoSession, link: Link, pointers: readonly LfsObject[]): Promise<void> {
    const byOid = new Map(pointers.map((object) => [object.oid, object]));
    if (byOid.size === 0) return;
    try {
      const known = new Set<string>();
      const oids = [...byOid.keys()];
      for (let at = 0; at < oids.length; at += 1000) {
        const rows = await this.#db
          .select({ oid: lfsObjects.oid })
          .from(lfsObjects)
          .where(
            and(
              eq(lfsObjects.provider, link.provider),
              eq(lfsObjects.repoId, link.repoId),
              inArray(lfsObjects.oid, oids.slice(at, at + 1000)),
            ),
          );
        for (const row of rows) known.add(row.oid);
      }
      const asked = [...byOid.values()].filter(({ oid }) => !known.has(oid)).slice(0, ASKED_MOST);
      if (asked.length === 0) return;
      const sizes = await session.lfsSizes(asked);
      const found = asked.flatMap((object, index) => {
        const size = sizes[index];
        return size === undefined
          ? []
          : [{ provider: link.provider, repoId: link.repoId, oid: object.oid, size }];
      });
      if (found.length > 0) await this.#db.insert(lfsObjects).values(found).onConflictDoNothing();
      this.#log.info(
        { project: link.projectId, asked: asked.length, found: found.length },
        "objects of Git LFS of a repository noted",
      );
    } catch (error) {
      this.#log.warn(
        { err: describeError(error), project: link.projectId },
        "Git LFS could not be asked what it has: an archive asks again",
      );
    }
  }
}

/** Whether the database has anything of a working copy of the project. */
const hasCopy = async (tx: Tx, id: string): Promise<boolean> => {
  const [updates] = await tx
    .select({ count: count() })
    .from(projectUpdates)
    .where(eq(projectUpdates.projectId, id));
  const [snapshots] = await tx
    .select({ count: count() })
    .from(projectSnapshots)
    .where(eq(projectSnapshots.projectId, id));
  return (updates?.count ?? 0) > 0 || (snapshots?.count ?? 0) > 0;
};

/** The queues, the same from the API and the worker: making them twice does nothing. */
export const setUpRebuildQueues = async (boss: Jobs): Promise<void> => {
  const work = {
    retryLimit: 0,
    // A project of 1000 files, read one by one, takes about a minute; this is for one that hangs.
    expireInSeconds: 10 * 60,
    heartbeatSeconds: 30,
    deleteAfterSeconds: 60 * 60,
  };
  const scans = {
    retryLimit: 0,
    expireInSeconds: 5 * 60,
    heartbeatSeconds: 30,
    deleteAfterSeconds: 60 * 60,
  };
  await boss.createQueue(REBUILD_QUEUE, { policy: "stately", ...work });
  await boss.createQueue(REBUILD_SCAN_QUEUE, { policy: "stately", ...scans });
  await boss.updateQueue(REBUILD_QUEUE, work);
  await boss.updateQueue(REBUILD_SCAN_QUEUE, scans);
};

/** Queues the work for a project, unless it waits already; `afterSeconds` from now. */
export const enqueueRebuild = async (
  boss: Jobs,
  project: string,
  afterSeconds?: number,
): Promise<void> => {
  await boss.send(REBUILD_QUEUE, { project } satisfies RebuildJob, {
    singletonKey: project,
    ...(afterSeconds !== undefined && { startAfter: afterSeconds }),
  });
};

/**
 * What the scan does every minute with projects whose copy is being made (the review of step RB):
 * those whose try has not begun, and that do not wait to be tried again (`copy_problem.retryAt`),
 * are queued, which does nothing for those that wait in the queue already; those whose try began
 * longer ago than any can take (`STOPPED_AFTER_MS`) did not live through it, and are queued again,
 * until `MOST_ATTEMPTS` tries in a row went so: then the worker is not given it again by itself.
 * One the platform let go of goes back to "released", to wait until it is asked for (and then
 * after a while, see `retryDelayMs`); a restore that never came to a copy goes. Also restores
 * that never came to a copy and are let be (as their request did not live to take them away) go.
 */
export const sweepRestoring = async (
  db: Db,
  options: {
    readonly now: Date;
    readonly enqueue: (project: string) => Promise<void>;
    readonly log?: Logger;
  },
): Promise<{ readonly queued: number; readonly stopped: number; readonly removed: number }> => {
  const { now, enqueue } = options;
  let queued = 0;
  let stopped = 0;
  let removed = 0;
  const rows = await db
    .select({
      id: projects.id,
      startedAt: projects.rebuildStartedAt,
      attempts: projects.rebuildAttempts,
      problem: projects.copyProblem,
    })
    .from(projects)
    .where(eq(projects.copyState, "restoring"))
    .limit(1000);
  for (const row of rows) {
    if (row.startedAt === null) {
      if ((row.problem?.retryAt ?? 0) > now.getTime()) continue;
      await enqueue(row.id);
      queued += 1;
      continue;
    }
    if (now.getTime() - row.startedAt.getTime() < STOPPED_AFTER_MS) continue;
    if (row.attempts < MOST_ATTEMPTS) {
      await enqueue(row.id);
      queued += 1;
      continue;
    }
    const problem: CopyProblem = {
      code: "unavailable",
      reason: "stopped",
      at: now.getTime(),
      retryAt: now.getTime() + retryDelayMs("unavailable", row.attempts),
    };
    const gone = await db.transaction(async (tx) => {
      await lockProject(tx, row.id);
      const [still] = await tx
        .select({
          copyState: projects.copyState,
          startedAt: projects.rebuildStartedAt,
          head: projects.head,
          releasedFrom: projects.releasedFrom,
        })
        .from(projects)
        .where(eq(projects.id, row.id))
        .for("update");
      if (
        still?.copyState !== "restoring" ||
        still.startedAt?.getTime() !== row.startedAt?.getTime()
      )
        return undefined;
      if (still.releasedFrom === null && still.head === 0) {
        await tx.delete(projects).where(eq(projects.id, row.id));
        return "removed";
      }
      await tx
        .update(projects)
        .set({ copyState: "released", copyProblem: problem, rebuildStartedAt: null })
        .where(eq(projects.id, row.id));
      return "stopped";
    });
    if (gone === "removed") removed += 1;
    if (gone === "stopped") stopped += 1;
    if (gone)
      options.log?.warn(
        { project: row.id, attempts: row.attempts, outcome: gone },
        "making a working copy stopped with the worker too often: not tried again by itself",
      );
  }
  // Restores that never came to a copy, which nothing waits for any more.
  const left = await db
    .delete(projects)
    .where(
      and(
        eq(projects.copyState, "released"),
        isNull(projects.releasedFrom),
        eq(projects.head, 0),
        or(isNull(projects.linkingUntil), lt(projects.linkingUntil, now)),
      ),
    )
    .returning({ id: projects.id });
  removed += left.length;
  return { queued, stopped, removed };
};

/**
 * The worker's part: one project at a time, between the archives; every minute, projects that are
 * "restoring" are queued again, which does nothing for those that wait or run.
 */
export const startRebuilding = async (
  boss: Jobs,
  options: { readonly db: Db; readonly rebuilder: Pick<Rebuilder, "run">; readonly log: Logger },
): Promise<void> => {
  await setUpRebuildQueues(boss);
  await boss.schedule(REBUILD_SCAN_QUEUE, "* * * * *");
  await boss.work(REBUILD_SCAN_QUEUE, async () => {
    const swept = await sweepRestoring(options.db, {
      now: new Date(),
      enqueue: (project) => enqueueRebuild(boss, project),
      log: options.log,
    });
    if (swept.stopped + swept.removed > 0) options.log.info({ ...swept }, "restoring swept");
  });
  await boss.work<RebuildJob>(
    REBUILD_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      const { project } = job.data;
      const outcome = await options.rebuilder.run(project);
      // An archive of the project runs: once it is done.
      if (outcome.kind === "busy") await enqueueRebuild(boss, project, 10);
      // A restore that failed for GitHub or the platform: again by itself, a while later.
      if (outcome.kind === "failed" && outcome.retryInMs !== undefined)
        await enqueueRebuild(boss, project, Math.ceil(outcome.retryInMs / 1000));
      return { kind: outcome.kind };
    },
  );
};
