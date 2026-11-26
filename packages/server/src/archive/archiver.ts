import {
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_START,
  isDocument,
  isProjectFile,
  isProjectFolder,
} from "@animaquill/core";
import { LFS_POINTER_MAX_BYTES, readLfsPointer, type LfsObjectId } from "@animaquill/schema";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { describeError, withLock, type Db, type Executor, type Logger } from "../database.ts";
import { GitHubUnavailable } from "../github/client.ts";
import {
  archives,
  lfsObjects,
  projectBatches,
  projectRepos,
  projectSnapshots,
  projects,
  projectUpdates,
  repoConflicts,
  repoMerges,
  users,
  type BlockedFile,
  type Diverged,
  type PauseReason,
  type PendingArchive,
} from "../schema.ts";
import {
  ExportFailed,
  type ExportResult,
  type ExportSession,
  type ProjectExporter,
} from "./exporter.ts";
import { readSetting } from "../settings.ts";
import { writeMergeInput, type MergeInput } from "../sync/batches.ts";
import {
  ARCHIVE_LOCK,
  backoffMs,
  isUnusable,
  linkOf,
  pauseLink,
  sameLink,
  type Link,
} from "./links.ts";
import {
  LOOKED_WHILE_PAUSED,
  MERGE_BYTES,
  MERGE_FILE_BYTES,
  MERGE_FILES,
  REPO_MERGE_SETTING,
  mergePauseOf,
  settleMergePause,
} from "./merging.ts";
import {
  ATTRIBUTES_FILE,
  INITIAL_ATTRIBUTES,
  NOT_TEXT,
  attributesSection,
  blobsToLookAt,
  commitMessage,
  differingFiles,
  isText,
  managedEntries,
  planArchive,
  trailersOf,
  type AttributesText,
} from "./plan.ts";
import {
  pathOfAttributesLine,
  planPointers,
  pointerText,
  spaced,
  topFoldersOf,
} from "./pointers.ts";
import {
  RepoPaused,
  RepoRefused,
  blobShaOf,
  bytesOf,
  type CommitInfo,
  type LfsObject,
  type Person,
  hereOf,
  placeOf,
  type RepoHosts,
  type RepoProvider,
  type RepoInfo,
  type RepoSession,
  type TreeEntry,
} from "./repo-host.ts";

/**
 * Archives a project into its repository: the working copy as the database has it, as files
 * (exporter.ts), written on top of the last commit of the default branch by the rules of plan.ts,
 * and the branch moved on, only ever as a fast-forward.
 *
 * One archive of a project at a time, whatever runs it: a lock of PostgreSQL on the project, and the
 * queue keeps one waiting and one running at most (schedule.ts). Between making a commit and moving
 * the branch to it, the commit is noted (`pending_sha`), and the commits of the platform end with two
 * lines that name the project and the update, so that whatever stops an archive halfway, the next one
 * knows what reached GitHub: it neither archives twice, nor takes its own commit for a push of
 * someone else.
 *
 * The assets in Git LFS of the repository have their pointers in it, see pointers.ts: only those the
 * platform knows the storage to have, and the paths of those it wrote are noted (`lfs_paths`). They
 * are its own to write over and to take away, as long as what is there is still such a pointer: the
 * database can be older than the repository, as after it came back from a backup, so what it says
 * is looked at in the repository first, and what the repository says (the lines of our section of
 * .gitattributes, the objects GitHub has) puts right what the database lost.
 *
 * A branch that moved elsewhere is fine as long as the files that are the platform's are as it left
 * them (a README edited on GitHub): the archive goes on top. Where they are not, archiving pauses,
 * "diverged", and nothing is written over until people say so. The same for what people have to do
 * something about: a repository that is gone, an App that is not installed or suspended, an archived
 * repository, an animaquill.json the format does not take, or files that would not read as a project.
 * Everything else that fails (GitHub down, a limit, the thread) is tried again later, 1, 2, 4… up to
 * 60 minutes on.
 *
 * With merges on (the switch of the admin site, `REPO_MERGE_SETTING`), files of the project that
 * changed on GitHub do not pause archiving: they are read into a merge for the API first
 * (`repo_merges`), and the archive after it goes on top of GitHub's commit, see `#workMerging`.
 * What it cannot merge by itself pauses for people: conflicts, blocked files, a project with locked
 * tags, history rewritten, too much at once.
 */

export { ARCHIVE_LOCK };
/** Fresh tries when the branch moves between reading and writing it, before waiting. */
const ROUNDS = 3;
/** Commits back from the tip that a commit of an archive that stopped halfway is looked for. */
const PENDING_DEPTH = 20;
/**
 * Whether blobs are text the editor reads, by their sha, for all archives of this process: what is
 * in a blob never changes, and a picture people put into a scene's folder is looked at once.
 */
const TEXT_SEEN = new Map<string, boolean>();
const TEXT_SEEN_MOST = 50_000;
/** What small blobs point at as pointers of Git LFS, null for those that are none, by their sha. */
const POINTERS_SEEN = new Map<string, LfsObjectId | null>();
/**
 * Objects that GitHub is asked about in one archive at most, where the platform does not know them:
 * each takes a call of its own to the storage. The rest wait for the next archive.
 */
const ASKED_MOST = 100;
/** How many of them are asked about in one go: what one go finds is kept if the next one fails. */
const ASKED_AT_ONCE = 20;
/**
 * When GitHub was last asked about an object of a repository in a size, by `<repo>:<oid>:<size>`,
 * for all archives of this process, and whether it said it has none: those asked longest ago (or
 * never) go first, so that more than `ASKED_MOST` objects are all asked about over a few archives,
 * not the first hundred again and again. One it said it has none of is not asked again for
 * `ABSENT_MS`: an object that an upload puts there meanwhile is noted (`lfs_objects`), which is
 * looked at before anybody is asked.
 */
const ASKED_SEEN = new Map<string, { readonly at: number; readonly absent: boolean }>();
const ASKED_SEEN_MOST = 50_000;
export const ABSENT_MS = 60 * 60_000;

/**
 * What an archive found out about objects of the storage, by oid: how large it has one, null for
 * one it does not have, "unknown" where it could not be asked now.
 */
type Looked = Map<string, number | null | "unknown">;

/**
 * "first": the first after linking; "auto": changes are due, see schedule.ts; "manual": people asked;
 * "check": only whether the branch still has what the platform left, after a push elsewhere. A
 * check never writes to the repository. Whatever the job, an archive people asked for that is not
 * done yet (`requested_at`) is done by it, as the queue can have dropped theirs.
 */
export type ArchiveKind = "first" | "auto" | "manual" | "check";

export type ArchiveOutcome =
  /** Another archive of the project is running. */
  | { readonly kind: "busy" }
  /** Not linked, or paused. */
  | { readonly kind: "none" }
  /** The repository has everything already. */
  | { readonly kind: "same" }
  | { readonly kind: "archived"; readonly sha: string; readonly seq: number }
  /** No file changed: only that the repository has everything up to `seq` is noted. */
  | { readonly kind: "unchanged"; readonly seq: number }
  | { readonly kind: "checked" }
  /** What changed on GitHub went to the API to be merged first: nothing is written now. */
  | { readonly kind: "merging"; readonly merge: string }
  | { readonly kind: "paused"; readonly reason: PauseReason }
  | { readonly kind: "failed"; readonly error: string; readonly retryAt: Date };

/** What a listing of a tree found: the files that could be the platform's, and the others. */
interface Listed {
  readonly managed: Map<string, TreeEntry>;
  readonly others: Set<string>;
  /** Every file that was listed, by path, and every folder: where pointers of large files go. */
  readonly files: Map<string, TreeEntry>;
  readonly folders: Set<string>;
}

/** The project as the database has it, at one moment. */
interface ProjectAt {
  readonly head: number;
  readonly parts: readonly Uint8Array[];
  readonly author: Person;
}

/** What changes as an archive with merges goes, see `MergingWork`. */
interface MergingState {
  /** `head_sha`, `merged_sha`, `merge_from` and `blocked` of the link, as the archive found them. */
  known: string | null;
  mergedSha: string | null;
  readonly mergeFrom: string | null;
  readonly blocked: readonly BlockedFile[];
}

/** What an archive with merges goes by, see `Archiver.#workMerging`. */
interface MergingWork {
  readonly link: Link;
  readonly session: RepoSession;
  readonly info: RepoInfo;
  readonly project: ProjectAt;
  readonly exportProject: () => Promise<ExportResult>;
  readonly exporter: () => ExportSession;
  readonly stopping: (files: readonly string[]) => Promise<readonly string[]>;
  readonly kind: ArchiveKind;
  readonly byUser: string | null;
  readonly asked: Date | null;
  readonly now: Date;
  readonly tip: string;
  readonly state: MergingState;
  readonly archivedSeq: number;
  readonly ours: readonly string[];
}

/**
 * Commits of the history taken away on GitHub gone down at most, see `#takeOutDropped`: one that is
 * longer pauses, as it cannot be told what it brought.
 */
const TAKEN_OUT_STEPS = 200;

/** No merge is left to archive, where it is still `merged`: a newer one stays. */
const mergedGone = (merged: string) => ({
  mergedSha: sql`case when ${projectRepos.mergedSha} = ${merged} then null else ${projectRepos.mergedSha} end`,
  mergeFrom: sql`case when ${projectRepos.mergedSha} = ${merged} then null else ${projectRepos.mergeFrom} end`,
});

/** How far back an archive looks for the commit that wrote AGENTS.md, see `#assertOwnInstructions`. */
const INSTRUCTIONS_LOOK_BACK = 200;

/** The database misses updates of a project: nothing is archived until it has them. */
class MissingUpdates extends Error {
  override name = "MissingUpdates";
}

/** The link changed while an archive ran: it is not this archive's to finish. */
class LinkChanged extends Error {
  override name = "LinkChanged";
}

/**
 * A pause that the archive decided on, with what people need to know, and, for what the project
 * had, the update it had then.
 */
class Pause extends Error {
  override name = "Pause";
  readonly reason: PauseReason;
  readonly diverged: Diverged | undefined;
  readonly seq: number | undefined;
  constructor(
    reason: PauseReason,
    detail: string,
    more: { diverged?: Diverged; seq?: number } = {},
  ) {
    super(detail);
    this.reason = reason;
    this.diverged = more.diverged;
    this.seq = more.seq;
  }
}

/**
 * An archive that finds the repository cannot be used says so only where another found the same
 * this long before, and not longer than `CONFIRM_WITHIN_MS` before: see `Archiver.#confirms`.
 */
export const CONFIRM_AFTER_MS = 3 * 60_000;
export const CONFIRM_WITHIN_MS = 60 * 60_000;

/** What GitHub said when it did not let the branch move. */
const refusalOf = (moved: "behind" | { readonly refused: string }) =>
  typeof moved === "object" ? moved.refused : "GitHub does not let the branch move";

export interface ArchiverOptions {
  readonly db: Db;
  /** The repositories, on whichever provider: see repo-host.ts. */
  readonly hosts: RepoHosts;
  readonly exporter: ProjectExporter;
  readonly log: Logger;
  /** How long one archive may take: `ARCHIVE_DEADLINE_MS` unless said. */
  readonly deadlineMs?: number;
  readonly now?: () => Date;
  /**
   * Whether changes on GitHub are merged (`REPO_MERGE_SETTING`, read from the database each archive
   * unless said). Off, archiving is as before merges.
   */
  readonly merging?: () => Promise<boolean>;
  /**
   * Has the API merge what an archive found changed on GitHub (`repo_merges`, see
   * sync/repo-merge-jobs.ts). Where it is not there, nothing is merged: the merge waits "ready",
   * and the next archive that looks queues it again.
   */
  readonly enqueueMerge?: ((merge: string) => Promise<void>) | undefined;
  /** How much one merge takes: what the hub takes (`MERGE_FILES`, `MERGE_BYTES`) unless said. */
  readonly mergeLimits?: { readonly files: number; readonly bytes: number };
}

/**
 * How long one archive may take at most, however slow GitHub is: less than the queue lets a job be
 * (schedule.ts), so that the worker goes on with what waits behind it.
 */
export const ARCHIVE_DEADLINE_MS = 8 * 60_000;

export class Archiver {
  readonly #db: Db;
  readonly #hosts: RepoHosts;
  readonly #exporter: ProjectExporter;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #deadlineMs: number;
  readonly #merging: () => Promise<boolean>;
  readonly #enqueueMerge: ((merge: string) => Promise<void>) | undefined;
  readonly #mergeLimits: { readonly files: number; readonly bytes: number };

  constructor(options: ArchiverOptions) {
    this.#db = options.db;
    this.#hosts = options.hosts;
    this.#exporter = options.exporter;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
    this.#deadlineMs = options.deadlineMs ?? ARCHIVE_DEADLINE_MS;
    this.#merging =
      options.merging ?? (async () => (await readSetting(this.#db, REPO_MERGE_SETTING)).enabled);
    this.#enqueueMerge = options.enqueueMerge;
    this.#mergeLimits = options.mergeLimits ?? { files: MERGE_FILES, bytes: MERGE_BYTES };
  }

  /** Archives a project, or does nothing where another archive of it runs. Never rejects. */
  async run(projectId: string, kind: ArchiveKind, byUser?: string): Promise<ArchiveOutcome> {
    try {
      const locked = await withLock(this.#db, ARCHIVE_LOCK, projectId, () =>
        this.#archive(projectId, kind, byUser ?? null),
      );
      return locked.held ? locked.value : { kind: "busy" };
    } catch (error) {
      // Only the database can fail out here: the next scan comes back to it.
      this.#log.error({ err: describeError(error), project: projectId }, "archive failed");
      return {
        kind: "failed",
        error: describeError(error).message as string,
        retryAt: this.#now(),
      };
    }
  }

  async #archive(
    projectId: string,
    kind: ArchiveKind,
    byUser: string | null,
  ): Promise<ArchiveOutcome> {
    const link = await linkOf(this.#db, projectId);
    if (!link) return { kind: "none" };
    // A repository of the server's own always merges what people push into it themselves: the
    // switch of the admin site is about GitHub.
    const merging = link.provider === "local" || (await this.#merging());
    // Paused for what waits of merges, a push is still looked at, and merged: it only looks.
    const looksOnly =
      link.state === "paused" &&
      merging &&
      link.pauseReason !== null &&
      LOOKED_WHILE_PAUSED.includes(link.pauseReason);
    if (link.state !== "ready" && !looksOnly) return { kind: "none" };
    // A repository on a provider this server is not set up for: nothing goes there.
    if (!this.#hosts.has(link.provider)) return { kind: "none" };
    // Nothing goes to GitHub for someone disabled, also from a job that was waiting before: the
    // changes wait, and go once they are enabled again, see `takeDue`.
    if (await this.#ownerDisabled(projectId)) return { kind: "none" };
    // The platform let go of the working copy, or makes it again (archive/rebuild.ts): there is
    // nothing to archive, nor anything to look at the repository for until it is here.
    if (!(await this.#isLive(projectId))) return { kind: "none" };
    // However slow GitHub is, the archive stops by its deadline, and the worker goes on with what
    // waits behind it: every request stops, and so does the thread. Stopping anywhere is safe, as
    // the next archive finds out what reached GitHub.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("the deadline passed")), this.#deadlineMs);
    timer.unref?.();
    const place = placeOf(link);
    // A repository of the server's own is made by the first archive into it: one that never had an
    // archive and is not there yet. One that had is "gone" where it is not there.
    if (place.provider === "local" && link.headSha === null && link.pendingSha === null) {
      try {
        const project = await this.#readOwner(projectId);
        await this.#hosts.local?.create(place, project.name, {
          owner: project.ownerId,
          project: projectId,
        });
      } catch (error) {
        return this.#fail(link, error);
      }
    }
    const session = this.#hosts.open(place, { signal: stop.signal });
    let exporting: ExportSession | undefined;
    const ended = () => void exporting?.close().catch(() => {});
    stop.signal.addEventListener("abort", ended, { once: true });
    try {
      return await this.#work(
        link,
        session,
        looksOnly ? "check" : kind,
        byUser,
        () => {
          stop.signal.throwIfAborted();
          exporting ??= this.#exporter.open();
          return exporting;
        },
        { merging, looksOnly },
      );
    } catch (error) {
      if (error instanceof LinkChanged) return { kind: "none" };
      if (stop.signal.aborted)
        return this.#fail(link, new GitHubUnavailable("the archive took longer than it may"));
      // The project was deleted while this ran, as people may whatever the archive does: there is
      // nothing to pause or to try again, and nothing went wrong. What reached the repository
      // stays there.
      if (await this.#isGone(projectId)) {
        this.#log.info({ project: projectId }, "the project was deleted while it was archived");
        return { kind: "none" };
      }
      // Not there to the App, or the App not installed or suspended, as GitHub answers now: said
      // only where the next archive a few minutes on finds the same, as GitHub can answer so for a
      // while for anything. A webhook that says so is another matter, see events.ts.
      if (
        error instanceof RepoPaused &&
        isUnusable(error.reason, link.provider) &&
        !this.#confirms(link)
      )
        return this.#suspect(link, error);
      if (error instanceof Pause || error instanceof RepoPaused) {
        const reason = error.reason;
        await this.#pause(link, reason, error.message, error instanceof Pause ? error : {});
        this.#log.warn({ project: projectId, reason }, "archiving paused");
        return { kind: "paused", reason };
      }
      return this.#fail(link, error);
    } finally {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", ended);
      await exporting?.close().catch(() => {});
      await session.close().catch(() => {});
    }
  }

  async #work(
    link: Link,
    session: RepoSession,
    job: ArchiveKind,
    jobBy: string | null,
    exporter: () => ExportSession,
    mode: { readonly merging: boolean; readonly looksOnly: boolean } = {
      merging: false,
      looksOnly: false,
    },
  ): Promise<ArchiveOutcome> {
    const now = this.#now();
    const info = await session.info();
    // As it is now, before anything stops the archive: what people are shown is the repository as
    // it is called today, also where it is someone else's by now, or read-only.
    await this.#remember(link, info, now);
    if (info.archived) throw new Pause("archived", "the repository is archived on GitHub");
    // Moved to another account: someone else's now, whatever the App may touch there.
    if (info.ownerId !== link.ownerId)
      throw new Pause("transferred", `the repository is on the account ${info.owner} now`);
    const project = await this.#readProject(link.projectId);
    /** The project as files, with where the files of its assets are as this repository has them. */
    let exporting: Promise<ExportResult> | undefined;
    const exportProject = () => (exporting ??= exporter().export(project.parts, hereOf(link)));
    /**
     * Of the files that changed on GitHub, those that stop an archive. AGENTS.md does not while the
     * project has none or only the opening a new project starts with: an archive leaves the one on
     * GitHub as it is then (plan.ts), people's own instructions for AI, which they often keep in a
     * repository before it holds a project.
     */
    const stopping = async (files: readonly string[]) => {
      if (!files.includes(INSTRUCTIONS_FILE)) return files;
      const ours = (await exportProject()).files.get(INSTRUCTIONS_FILE)?.text;
      if (ours !== undefined && ours !== INSTRUCTIONS_START) return files;
      return files.filter((path) => path !== INSTRUCTIONS_FILE);
    };
    // An archive people asked for, which the queue can have dropped for this job: this job does it.
    // Only looking, while paused: what people asked for waits until it goes on.
    const asked = mode.looksOnly ? null : link.requestedAt;
    const kind: ArchiveKind = asked !== null && job !== "first" ? "manual" : job;
    const byUser = asked !== null ? (link.requestedBy ?? jobBy) : jobBy;
    let tip = await session.tip(info.branch);
    /** The last commit of the branch that the platform knows as its own, and what it has. */
    let known = link.headSha;
    let archivedSeq = link.archivedSeq;
    /** The pointers of large files of the platform's that `known` has, see pointers.ts. */
    let ours: readonly string[] = link.lfsPaths;
    /** What of GitHub's the project has merged since, see `project_repos.merged_sha`. */
    let mergedSha = link.mergedSha;
    let mergeFrom = link.mergeFrom;

    // An archive that stopped between making its commit and noting that the branch has it. A check
    // never writes: what the branch would move to then waits for the next archive.
    if (link.pendingSha && link.pending) {
      const pending = link.pending;
      if (tip !== link.pendingSha && tip === pending.parent && kind !== "check") {
        const moved = await session.advance(info.branch, link.pendingSha);
        if (moved === "moved") tip = link.pendingSha;
        else {
          const again = await session.tip(info.branch);
          if (again === tip) {
            await this.#dropPending(link);
            throw new Pause("protected", refusalOf(moved));
          }
          tip = again;
        }
      }
      if (tip !== undefined && (await this.#reaches(session, tip, link.pendingSha))) {
        await this.#landed(link, link.pendingSha, pending, now, null);
        known = link.pendingSha;
        archivedSeq = Math.max(archivedSeq, pending.seq);
        if (pending.lfsPaths) ours = pending.lfsPaths;
        // It was the archive after a merge: what was merged is in the repository now.
        if (pending.merged !== undefined) {
          mergedSha = null;
          mergeFrom = null;
        }
      } else if (kind !== "check") {
        await this.#dropPending(link);
      }
    }

    // An empty repository, as a new one is: its first commit has only our .gitattributes. A check
    // never writes, and finds nothing to check there.
    if (tip === undefined && kind === "check") return { kind: "checked" };
    if (tip === undefined) {
      const started = await session.start(
        { path: ATTRIBUTES_FILE, text: INITIAL_ATTRIBUTES },
        "开始存档",
        project.author,
        now,
      );
      tip = started ?? (await session.tip(info.branch));
      if (tip === undefined) throw new RepoRefused(409, "the repository stays empty");
    }

    // Files people chose to take out go out only by a merge: with merges off nothing is written
    // until they are out, as an archive would write them back (it waits until merges are on).
    const dropping = link.dropping ?? [];
    if (!mode.merging && dropping.length > 0) {
      if (kind === "check") return { kind: "checked" };
      throw new Pause("unmerged", "waits until the files people chose to take out are out", {
        diverged: { sha: tip, files: dropping, deleted: dropping, merging: true },
      });
    }
    if (mode.merging)
      return this.#workMerging({
        link,
        session,
        info,
        project,
        exportProject,
        exporter,
        stopping,
        kind,
        byUser,
        asked,
        now,
        tip,
        state: {
          known,
          mergedSha,
          mergeFrom,
          blocked: link.blocked,
        },
        archivedSeq,
        ours,
      });

    // The branch moved elsewhere: what is the platform's has to be as it was left. A commit of an
    // archive of this project that the database does not know of, newer than what it knows, is the
    // platform's own, as after the database came back from a backup; an older one is not, as when
    // the branch was set back to it on purpose.
    const tipCommit = await session.commit(tip);
    if (!tipCommit) throw new RepoRefused(404, "the branch has a commit that is not there");
    // Lines anyone who can push could write, see `trailersOf`: a known limit.
    const signed = trailersOf(tipCommit.message);
    const isOurs =
      signed?.project === link.projectId && signed.seq > archivedSeq && signed.seq <= project.head;
    if (tip !== known && !isOurs) {
      const before = known === null ? undefined : await session.commit(known);
      if (known !== null && !before) {
        // What the platform wrote last is not in the repository any more.
        const files = [...(await this.#listed(session, tipCommit.tree)).managed.keys()];
        throw new Pause("diverged", "the last archive is not in the repository any more", {
          diverged: { sha: tip, files, deleted: [] },
        });
      }
      const differing = await this.#differing(session, before?.tree, tipCommit.tree, ours);
      const files = await stopping(differing.files);
      if (files.length > 0) {
        const deleted = differing.deleted.filter((path) => files.includes(path));
        throw new Pause("diverged", `${files.length} files of the project changed on GitHub`, {
          diverged: { sha: tip, files, deleted },
        });
      }
    }

    // The files of the platform are as it left them: with nothing newer to write, that is all.
    if (kind === "check" || archivedSeq >= project.head) {
      if (tip !== known) await this.#adopt(link, tip);
      if (kind !== "check") await this.#settle(link, project.head, tip, now, asked);
      return kind === "check" ? { kind: "checked" } : { kind: "same" };
    }

    // The project as files, with where the files of its assets are as this repository has them,
    // and what that changes on top of the branch.
    const exported = await exportProject();
    if (exported.invalid.has("animaquill.json"))
      throw new Pause("manifest", problemsOf(exported, "animaquill.json"), { seq: project.head });
    /** What this archive finds out about the storage, each object once, see `#storedOf`. */
    const looked: Looked = new Map();
    let base = tip;
    let baseTree = tipCommit.tree;
    /** What `#assertOwnInstructions` found out, by commit and blob, for the rounds after the first. */
    const ownInstructions = new Map<string, boolean>();
    for (let round = 1; ; round++) {
      // Where pointers could be the platform's: where the database says, and where the lines of
      // our section of .gitattributes in the repository say, which a backup cannot be behind.
      const top = await session.tree(baseTree);
      const attributes = await this.#attributesOf(session, top);
      const lined = (attributesSection(attributes) ?? []).flatMap(
        (line) => pathOfAttributesLine(line) ?? [],
      );
      const candidates = new Set([...ours, ...lined]);
      const parent = await this.#listed(session, baseTree, {
        top,
        extra: topFoldersOf([...exported.lfs.map(({ path }) => path), ...candidates]),
      });
      await this.#assertOwnInstructions(session, link, exported, base, top, ownInstructions);
      const { plan, lfsPaths } = await this.#plan(session, link, exported, parent, {
        attributes,
        candidates,
        looked,
      });
      if (plan.manifestInvalid)
        throw new Pause("manifest", problemsOf(exported, "animaquill.json"), { seq: project.head });
      // The last line: what the repository will have reads as a project. It always should.
      const documents = new Map<string, string>();
      for (const [path, file] of exported.files)
        if (isDocument(path) && !exported.invalid.has(path)) documents.set(path, file.text);
      for (const path of plan.kept) {
        const entry = parent.managed.get(path);
        if (isDocument(path) && entry?.type === "blob")
          documents.set(path, Buffer.from(await session.blob(entry.sha)).toString("utf8"));
      }
      const errors = await exporter().check(documents);
      if (errors.length > 0)
        throw new Pause(
          "invalid",
          `the files would not read as a project: ${errors.slice(0, 3).join("; ")}`,
          { seq: project.head },
        );

      if (plan.changes.length === 0) {
        await this.#settle(link, project.head, base, now, asked, lfsPaths);
        return { kind: "unchanged", seq: project.head };
      }

      const archiveKind = known === null ? "first" : kind;
      const tree = await session.writeTree(baseTree, plan.changes);
      const sha = await session.writeCommit({
        tree,
        parents: [base],
        message: commitMessage({
          local: link.provider === "local",
          kind: archiveKind,
          changed: plan.changed,
          removed: plan.removed,
          kept: plan.kept,
          project: link.projectId,
          seq: project.head,
        }),
        author: project.author,
        at: now,
      });
      const pending: PendingArchive = {
        parent: base,
        seq: project.head,
        kind: archiveKind,
        changed: plan.changed,
        removed: plan.removed,
        kept: plan.kept,
        byUser,
        lfsPaths,
      };
      await this.#notePending(link, sha, pending);
      const moved = await session.advance(info.branch, sha);
      if (moved === "moved") {
        await this.#landed(link, sha, pending, now, asked);
        this.#log.info(
          {
            project: link.projectId,
            seq: project.head,
            changed: plan.changed,
            removed: plan.removed,
          },
          "archived",
        );
        return { kind: "archived", sha, seq: project.head };
      }

      // Someone pushed between reading the branch and moving it, or GitHub does not let it move:
      // never forced, looked at again.
      await this.#dropPending(link, sha);
      const again = await session.tip(info.branch);
      const againCommit = again === undefined ? undefined : await session.commit(again);
      if (!again || !againCommit) throw new RepoRefused(409, "the branch went away");
      // Where it was: it did not move meanwhile, it does not move at all, as a protected branch. No
      // more commits are made for it until people see to that.
      if (again === base) throw new Pause("protected", refusalOf(moved));
      const differing = await this.#differing(session, baseTree, againCommit.tree, ours);
      const files = await stopping(differing.files);
      if (files.length > 0) {
        const deleted = differing.deleted.filter((path) => files.includes(path));
        throw new Pause("diverged", `${files.length} files of the project changed on GitHub`, {
          diverged: { sha: again, files, deleted },
        });
      }
      if (round >= ROUNDS) throw new GitHubUnavailable("the branch keeps moving");
      base = again;
      baseTree = againCommit.tree;
    }
  }

  /**
   * Archiving while merges from GitHub are on: first a look at the branch, which has what changed
   * of the project's files on GitHub merged by the API before anything is written; then, once
   * nothing waits (a merge, open conflicts, blocked files), the project on top of the branch. After
   * a merge that commit has two parents: GitHub's, which the branch had, and the project as it was
   * before the first merge since the last archive, written on top of that archive (E), where the
   * editor had changes the repository did not have then. Right before the branch moves it is read
   * again: one that moved, also back, is looked at again.
   */
  async #workMerging(w: MergingWork): Promise<ArchiveOutcome> {
    const { link, session, info, project, now } = w;
    const looked: Looked = new Map();
    const ownInstructions = new Map<string, boolean>();
    let tip = w.tip;
    for (let round = 1; ; round++) {
      const tipCommit = await session.commit(tip);
      if (!tipCommit) throw new RepoRefused(404, "the branch has a commit that is not there");
      const chosen = await this.#takeOutChosen(w, tip);
      if (chosen !== undefined) return chosen;
      const seen = await this.#look(w, tip, tipCommit);
      if (seen !== undefined) return seen;
      if (w.kind === "check") return { kind: "checked" };
      const waiting = await this.#waiting(w);
      if (waiting !== undefined) return waiting;
      const { state } = w;
      if (w.archivedSeq >= project.head && state.mergedSha === null) {
        await this.#settle(link, project.head, tip, now, w.asked);
        return { kind: "same" };
      }

      const exported = await w.exportProject();
      if (exported.invalid.has("animaquill.json"))
        throw new Pause("manifest", problemsOf(exported, "animaquill.json"), { seq: project.head });
      const top = await session.tree(tipCommit.tree);
      const attributes = await this.#attributesOf(session, top);
      const lined = (attributesSection(attributes) ?? []).flatMap(
        (line) => pathOfAttributesLine(line) ?? [],
      );
      const candidates = new Set([...w.ours, ...lined]);
      const parent = await this.#listed(session, tipCommit.tree, {
        top,
        extra: topFoldersOf([...exported.lfs.map(({ path }) => path), ...candidates]),
      });
      await this.#assertOwnInstructions(session, link, exported, tip, top, ownInstructions, true);
      const { plan, lfsPaths } = await this.#plan(session, link, exported, parent, {
        attributes,
        candidates,
        looked,
        // People chose the project over this very commit (`replace`): the pointers they saw there
        // changed on GitHub are the platform's to write over or take away, as they were told.
        ...(link.replacedSha !== null && link.replacedSha === tip && { confirmed: candidates }),
      });
      if (plan.manifestInvalid)
        throw new Pause("manifest", problemsOf(exported, "animaquill.json"), { seq: project.head });
      const documents = new Map<string, string>();
      for (const [path, file] of exported.files)
        if (isDocument(path) && !exported.invalid.has(path)) documents.set(path, file.text);
      for (const path of plan.kept) {
        const entry = parent.managed.get(path);
        if (isDocument(path) && entry?.type === "blob")
          documents.set(path, Buffer.from(await session.blob(entry.sha)).toString("utf8"));
      }
      const errors = await w.exporter().check(documents);
      if (errors.length > 0)
        throw new Pause(
          "invalid",
          `the files would not read as a project: ${errors.slice(0, 3).join("; ")}`,
          { seq: project.head },
        );

      // The project is what the branch has: GitHub's commit is the archive, with nothing on top.
      if (plan.changes.length === 0) {
        await this.#settle(link, project.head, tip, now, w.asked, lfsPaths, state.mergedSha);
        return { kind: "unchanged", seq: project.head };
      }

      const merged = state.mergedSha;
      const before =
        merged !== null && state.mergeFrom === null
          ? await this.#beforeMerge(w, looked)
          : undefined;
      const archiveKind = state.known === null ? "first" : merged !== null ? "merge" : w.kind;
      const tree = await session.writeTree(tipCommit.tree, plan.changes);
      const sha = await session.writeCommit({
        tree,
        parents: before === undefined ? [tip] : [tip, before],
        message: commitMessage({
          local: link.provider === "local",
          kind: archiveKind,
          changed: plan.changed,
          removed: plan.removed,
          kept: plan.kept,
          project: link.projectId,
          seq: project.head,
        }),
        author: project.author,
        at: now,
      });
      // Read again right before the branch moves: one that went back meanwhile (forced onto an older
      // commit) would take this commit as a fast-forward, and have back what people took away.
      const head = await session.tip(info.branch);
      if (head !== tip) {
        if (head === undefined) throw new RepoRefused(409, "the branch went away");
        if (round >= ROUNDS) throw new GitHubUnavailable("the branch keeps moving");
        tip = head;
        continue;
      }
      const pending: PendingArchive = {
        parent: tip,
        seq: project.head,
        kind: archiveKind,
        changed: plan.changed,
        removed: plan.removed,
        kept: plan.kept,
        byUser: w.byUser,
        lfsPaths,
        ...(merged !== null && { merged }),
        ...(before !== undefined && { ours: before }),
      };
      await this.#notePending(link, sha, pending, { ready: true });
      const moved = await session.advance(info.branch, sha);
      if (moved === "moved") {
        await this.#landed(link, sha, pending, now, w.asked);
        this.#log.info(
          {
            project: link.projectId,
            seq: project.head,
            changed: plan.changed,
            removed: plan.removed,
            ...(merged !== null && { merged, ours: before ?? null }),
          },
          "archived",
        );
        return { kind: "archived", sha, seq: project.head };
      }
      // Someone pushed between reading the branch and moving it, or GitHub does not let it move:
      // never forced, looked at again.
      await this.#dropPending(link, sha);
      const again = await session.tip(info.branch);
      if (!again) throw new RepoRefused(409, "the branch went away");
      if (again === tip) throw new Pause("protected", refusalOf(moved));
      if (round >= ROUNDS) throw new GitHubUnavailable("the branch keeps moving");
      tip = again;
    }
  }

  /**
   * Looks at the branch for what changed of the project on GitHub since what the platform has of it
   * (`merged_sha`, or the commit people chose to merge from, or the last archive): undefined where
   * nothing did, or only what the platform writes back itself (our section of .gitattributes, the
   * pointers of large files), which is then the commit archives go on from. Where files of the
   * project changed, they are read into a merge for the API (`repo_merges`), and the archive stops
   * there. A branch that does not go on from what the platform has is not merged ("rewritten"),
   * nor is more than a merge takes ("too-large"), nor what the API refused before.
   */
  async #look(
    w: MergingWork,
    tip: string,
    tipCommit: CommitInfo,
  ): Promise<ArchiveOutcome | undefined> {
    const { link, session, state } = w;
    const from = state.mergedSha ?? state.mergeFrom ?? state.known;
    // What waits for the project to change (locked) is merged again once it goes on, see
    // `CONTENT_REASONS`: not while it is still paused for it.
    const retry =
      link.state === "ready" ? state.blocked.filter(({ reason }) => reason === "locked") : [];
    // People chose to merge GitHub's rewritten history: what the history taken away brought goes
    // out of the project first.
    const takenOut = await this.#takeOutDropped(w, tip);
    if (takenOut !== undefined) return takenOut;
    if (tip === from && retry.length === 0) return undefined;
    // A newer archive of this project's own that the database does not know of, as after it came
    // back from a backup: as before merges.
    if (state.mergedSha === null && state.mergeFrom === null) {
      const signed = trailersOf(tipCommit.message);
      if (
        signed?.project === link.projectId &&
        signed.seq > w.archivedSeq &&
        signed.seq <= w.project.head
      )
        return undefined;
    }
    // The first archive into a repository that has commits: what of the project is there is
    // people's, as before merges.
    if (from === null) {
      const differing = await this.#differing(session, undefined, tipCommit.tree, w.ours);
      const files = await w.stopping(differing.files);
      if (files.length > 0)
        throw new Pause("diverged", `${files.length} files of the project changed on GitHub`, {
          diverged: { sha: tip, files, deleted: [], merging: true },
        });
      return undefined;
    }
    const fromCommit = await session.commit(from);
    const rewritten = async (base: string | undefined) => {
      const differing = fromCommit
        ? await this.#differing(session, fromCommit.tree, tipCommit.tree, w.ours)
        : {
            files: [...(await this.#listed(session, tipCommit.tree)).managed.keys()],
            deleted: [],
          };
      return new Pause("rewritten", "the history of the branch on GitHub was rewritten", {
        diverged: {
          sha: tip,
          files: differing.files,
          deleted: differing.deleted,
          ...(base !== undefined && { base }),
          merging: true,
        },
      });
    };
    if (!fromCommit) throw await rewritten(undefined);
    if (tip !== from) {
      const relation = await session.compare(from, tip);
      if (relation === undefined || relation.status === "behind" || relation.status === "diverged")
        throw await rewritten(relation?.mergeBase);
    }
    const differing =
      tip === from
        ? { files: [] as string[], deleted: [] as string[] }
        : await this.#differing(session, fromCommit.tree, tipCommit.tree, w.ours);
    // What the platform writes itself is written back by the archive, as the project has it.
    const changed = (await w.stopping(differing.files)).filter(
      (path) => path !== ATTRIBUTES_FILE && !w.ours.includes(path) && isProjectFile(path),
    );
    if (changed.length === 0 && retry.length === 0) {
      await this.#adoptMerged(w, tip);
      return undefined;
    }
    const waiting = new Map(state.blocked.map((file) => [file.path, file]));
    // Every blocked file goes along: what the merge says of it is what it is now.
    const paths = [...new Set([...changed, ...waiting.keys()])].toSorted();

    const [last] = await this.#db
      .select()
      .from(repoMerges)
      .where(
        and(
          eq(repoMerges.projectId, link.projectId),
          eq(repoMerges.provider, link.provider),
          eq(repoMerges.repoId, link.repoId),
        ),
      )
      .orderBy(desc(repoMerges.createdAt), desc(repoMerges.id))
      .limit(1);
    if (last && last.toSha === tip && last.fromSha === from) {
      if (last.state === "ready") {
        await this.#queueMerge(link, last.id);
        return { kind: "merging", merge: last.id };
      }
      // Refused for good: said, and nothing more is made of this push. A newer one is read again
      // from what was merged before.
      if (last.state === "refused") {
        const refused = last.result?.refused ?? "failed";
        throw new Pause(
          refused === "too-large" ? "too-large" : "unmerged",
          `${refused}${last.result?.detail ? `: ${last.result.detail}` : ""}`,
          { diverged: { sha: tip, files: changed, deleted: differing.deleted, merging: true } },
        );
      }
      // Merged since this archive read the link: the next one goes on from it.
      if (last.state === "applied" && state.mergedSha !== last.toSha) throw new LinkChanged();
    }

    const read = await this.#readForMerge(w, tipCommit, from, paths, waiting);
    if (read === "too-large")
      throw new Pause("too-large", `${paths.length} files changed on GitHub`, {
        diverged: { sha: tip, files: changed, deleted: differing.deleted, merging: true },
      });
    const { input, unreadable, instructions } = read;
    const at = this.#now();
    const id = await this.#db.transaction(async (tx) => {
      const [now] = await tx
        .select({
          mergedSha: projectRepos.mergedSha,
          mergeFrom: projectRepos.mergeFrom,
          headSha: projectRepos.headSha,
        })
        .from(projectRepos)
        .where(this.#same(link))
        .for("update");
      // A merge went in, or people chose, since this archive read the link: its look is old.
      if (
        !now ||
        now.mergedSha !== state.mergedSha ||
        now.mergeFrom !== state.mergeFrom ||
        now.headSha !== state.known
      )
        throw new LinkChanged();
      if (input.length === 0) {
        // Nothing GitHub has of them reads as text: they wait, and nothing needs the API.
        await tx
          .update(projectRepos)
          .set({ mergedSha: tip, blocked: unreadable })
          .where(this.#same(link));
        await settleMergePause(tx, link.projectId, at, { merged: true });
        return undefined;
      }
      await tx
        .update(repoMerges)
        .set({ state: "superseded", input: null })
        .where(and(eq(repoMerges.projectId, link.projectId), eq(repoMerges.state, "ready")));
      const [row] = await tx
        .insert(repoMerges)
        .values({
          projectId: link.projectId,
          provider: link.provider,
          repoId: link.repoId,
          fromSha: from,
          toSha: tip,
          input: writeMergeInput(input),
          result: {
            ...(unreadable.length > 0 && { unreadable }),
            ...(instructions !== undefined && { instructions }),
          },
          createdAt: at,
        })
        .returning({ id: repoMerges.id });
      return row!.id;
    });
    if (id === undefined) {
      this.#log.warn(
        { project: link.projectId, files: unreadable.map(({ path }) => path) },
        "files on GitHub do not read as text: they wait",
      );
      return { kind: "paused", reason: "blocked" };
    }
    this.#log.info(
      { project: link.projectId, merge: id, from, to: tip, files: input.length },
      "changes on GitHub to merge",
    );
    await this.#queueMerge(link, id);
    return { kind: "merging", merge: id };
  }

  /**
   * After people chose to merge what GitHub has now over history that was rewritten (`merge_from`):
   * what merges brought into the project from commits that are not on the branch any more goes back
   * out first, one merge at a time, newest first, each as a merge of its own the other way round
   * (from what it brought to what was there before it, or to the commit both histories have where
   * that is later). A force push often takes away what should never have been committed, such as a
   * password; merging only what changed since the commit both have would keep it in the project, and
   * the next archive would write it back. Where the editor changed the same place since, the merge
   * says so as a conflict, and people choose.
   *
   * Which merges those are is found by going down the history taken away, first parents, from what
   * the platform had of it to the commit both have: archives of the platform's are passed, a commit
   * of GitHub's goes back to where the merge of it began (`repo_merges`), and one that changed
   * nothing of the project is passed. Whatever cannot be told so (a commit of GitHub's that changed
   * files of the project and no merge of the platform's says how it came in, a commit that is not
   * there any more, a history too long to go down) pauses, "unmerged", with the files it can name:
   * nothing is written until people choose. Resolves to the merge queued, or undefined once nothing
   * is left to take out.
   */
  async #takeOutDropped(w: MergingWork, tip: string): Promise<ArchiveOutcome | undefined> {
    const { link, session, state } = w;
    const base = state.mergeFrom;
    if (base === null || state.mergedSha !== null) return undefined;
    // Which of them GitHub does not have any more: those an archive would write back, and the only
    // ones people can take out of the project (`drop`).
    const unsure = async (files: readonly string[], why: string) => {
      const listed = [...new Set(files)].toSorted();
      const tipCommit = await session.commit(tip);
      const there = tipCommit ? (await this.#listed(session, tipCommit.tree)).managed : undefined;
      return new Pause("unmerged", why, {
        diverged: {
          sha: tip,
          files: listed,
          deleted: there ? listed.filter((path) => !there.has(path)) : [],
          base,
          merging: true,
        },
      });
    };
    const merges = await this.#db
      .select({
        id: repoMerges.id,
        fromSha: repoMerges.fromSha,
        toSha: repoMerges.toSha,
        seq: repoMerges.seq,
        result: repoMerges.result,
      })
      .from(repoMerges)
      .where(
        and(
          eq(repoMerges.projectId, link.projectId),
          eq(repoMerges.provider, link.provider),
          eq(repoMerges.repoId, link.repoId),
          eq(repoMerges.state, "applied"),
        ),
      )
      .orderBy(desc(repoMerges.seq), desc(repoMerges.createdAt));
    const undone = new Set(merges.flatMap(({ result }) => result?.undoes ?? []));
    // What GitHub merged into the project, by the commit it came to: a merge again of files that
    // waited (the same commit as before and after) is part of the one before it.
    const byTo = new Map<string, (typeof merges)[number]>();
    for (const merge of merges)
      if (
        merge.result?.undoes === undefined &&
        merge.fromSha !== merge.toSha &&
        !byTo.has(merge.toSha)
      )
        byTo.set(merge.toSha, merge);
    // From the newest of what the platform had: a merge since the last archive, or that archive.
    const newest = merges.find(
      (merge) =>
        merge.result?.undoes === undefined &&
        merge.fromSha !== merge.toSha &&
        (merge.seq ?? 0) > w.archivedSeq,
    );
    let at: string | null = newest?.toSha ?? state.known;
    const dropped: (typeof merges)[number][] = [];
    for (let step = 0; at !== null && at !== base; step++) {
      if (step >= TAKEN_OUT_STEPS)
        throw await unsure(
          dropped.flatMap(({ result }) => result?.files?.map(({ path }) => path) ?? []),
          "the history taken away on GitHub is too long to go down",
        );
      // Down to the commit both histories have, or one before it: the rest is still on the branch.
      if (await this.#reachable(session, at, base)) break;
      const commit = await session.commit(at);
      if (!commit)
        throw await unsure(
          dropped.flatMap(({ result }) => result?.files?.map(({ path }) => path) ?? []),
          "a commit of the history taken away on GitHub is not there any more",
        );
      const merge = byTo.get(at);
      if (merge) {
        if (!(await this.#reachable(session, merge.toSha, tip))) dropped.push(merge);
        at = merge.fromSha;
        continue;
      }
      const [parent] = commit.parents;
      if (trailersOf(commit.message)?.project === link.projectId) {
        at = parent ?? null;
        continue;
      }
      // GitHub's, and no merge says how it came in: only fine where it changed nothing of the
      // project, as one that was taken as it was.
      const before = parent === undefined ? undefined : await session.commit(parent);
      const changed = (
        await this.#differing(session, before?.tree, commit.tree, w.ours)
      ).files.filter((path) => path !== ATTRIBUTES_FILE && isProjectFile(path));
      if (changed.length > 0)
        throw await unsure(
          changed,
          "changes on GitHub from the history taken away came into the project long ago, and cannot be taken out by themselves: see to these files",
        );
      at = parent ?? null;
    }

    // One that takes a merge out is there already and waits for the hub: that one goes first, and
    // the rest after it, as making another would be a second "ready" merge of the project.
    const [waiting] = await this.#db
      .select({ id: repoMerges.id, result: repoMerges.result })
      .from(repoMerges)
      .where(and(eq(repoMerges.projectId, link.projectId), eq(repoMerges.state, "ready")));
    if (waiting?.result?.undoes !== undefined) {
      await this.#queueMerge(link, waiting.id);
      return { kind: "merging", merge: waiting.id };
    }
    for (const row of dropped) {
      if (undone.has(row.id)) continue;
      const brought = await session.commit(row.toSha);
      if (!brought)
        throw await unsure(
          row.result?.files?.map(({ path }) => path) ?? [],
          "what a merge brought from the history taken away is not there any more",
        );
      // Back to what was there before it, or to the commit both histories have, where that is later.
      const back = (await this.#reachable(session, row.fromSha, base)) ? base : row.fromSha;
      const backCommit = await session.commit(back);
      if (!backCommit)
        throw await unsure(
          row.result?.files?.map(({ path }) => path) ?? [],
          "what was there before a merge from the history taken away is not there any more",
        );
      const differing = await this.#differing(session, brought.tree, backCommit.tree, w.ours);
      const paths = differing.files.filter(
        (path) => path !== ATTRIBUTES_FILE && !w.ours.includes(path) && isProjectFile(path),
      );
      const read =
        paths.length === 0
          ? { input: [] as MergeInput[] }
          : await this.#readForMerge(w, backCommit, row.toSha, paths, new Map());
      if (read === "too-large")
        throw new Pause("too-large", `${paths.length} files to take out of the project`, {
          diverged: { sha: tip, files: paths, deleted: [], base, merging: true },
        });
      const madeAt = this.#now();
      const id = await this.#db.transaction(async (tx) => {
        const [now] = await tx
          .select({ mergedSha: projectRepos.mergedSha, mergeFrom: projectRepos.mergeFrom })
          .from(projectRepos)
          .where(this.#same(link))
          .for("update");
        if (!now || now.mergedSha !== null || now.mergeFrom !== base) throw new LinkChanged();
        const [made] = await tx
          .insert(repoMerges)
          .values({
            projectId: link.projectId,
            provider: link.provider,
            repoId: link.repoId,
            fromSha: row.toSha,
            toSha: back,
            // Nothing to take out: noted as done at once.
            state: read.input.length === 0 ? "applied" : "ready",
            input: read.input.length === 0 ? null : writeMergeInput(read.input),
            result: { undoes: row.id },
            createdAt: madeAt,
            ...(read.input.length === 0 && { appliedAt: madeAt }),
          })
          .returning({ id: repoMerges.id });
        return read.input.length === 0 ? undefined : made!.id;
      });
      if (id === undefined) continue;
      this.#log.info(
        { project: link.projectId, merge: id, undoes: row.id, files: read.input.length },
        "what history taken away on GitHub brought, to take out",
      );
      await this.#queueMerge(link, id);
      return { kind: "merging", merge: id };
    }
    return undefined;
  }

  /**
   * Files people chose to take out of the project as they went on with the editor's content
   * (`project_repos.dropping`, `replace` with `drop`): GitHub took them away in a rewritten history,
   * such as a secret, and the archive would write them back as the project has them. They go out as
   * a merge of their own before anything is written: from what the project has of each to nothing,
   * so that a place the editor changed since, or one something points at, comes up as a conflict
   * and waits for people rather than going out unseen. It leaves `merged_sha` as it is
   * (`RepoMergeResult.drops`). Resolves to the merge queued, or undefined where nothing is to go.
   */
  async #takeOutChosen(w: MergingWork, tip: string): Promise<ArchiveOutcome | undefined> {
    const { link } = w;
    const chosen = link.dropping ?? [];
    if (chosen.length === 0) return undefined;
    /** Nothing is written while what people chose to take out is not out. */
    const notOut = (why: string) =>
      new Pause("unmerged", why, {
        diverged: { sha: tip, files: chosen, deleted: chosen, merging: true },
      });
    if (link.droppingMerge !== null) {
      const [made] = await this.#db
        .select({ state: repoMerges.state })
        .from(repoMerges)
        .where(
          and(eq(repoMerges.id, link.droppingMerge), eq(repoMerges.projectId, link.projectId)),
        );
      if (made?.state === "ready") {
        await this.#queueMerge(link, link.droppingMerge);
        return { kind: "merging", merge: link.droppingMerge };
      }
      // Out: the hub clears both as it applies it; this is for one that did not.
      if (made?.state === "applied") {
        await this.#db
          .update(projectRepos)
          .set({ dropping: null, droppingMerge: null })
          .where(and(this.#same(link), eq(projectRepos.droppingMerge, link.droppingMerge)));
        link.dropping = null;
        link.droppingMerge = null;
        return undefined;
      }
      // Refused, or gone: the files are still in the project, and an archive would write them.
      if (made?.state === "refused" || made === undefined)
        throw notOut("the files people chose to take out could not be taken out");
      // Superseded (a newer merge took its place): made again below.
    }
    const exported = await w.exportProject();
    const input: MergeInput[] = chosen.flatMap((path) => {
      const file = exported.files.get(path);
      return file === undefined ? [] : [{ path, base: file.text }];
    });
    const at = this.#now();
    const id = await this.#db.transaction(async (tx) => {
      const [now] = await tx
        .select({ dropping: projectRepos.dropping, droppingMerge: projectRepos.droppingMerge })
        .from(projectRepos)
        .where(this.#same(link))
        .for("update");
      if (
        !now ||
        JSON.stringify(now.dropping ?? []) !== JSON.stringify(chosen) ||
        now.droppingMerge !== link.droppingMerge
      )
        throw new LinkChanged();
      // None of them is in the project any more: nothing to take out.
      if (input.length === 0) {
        await tx
          .update(projectRepos)
          .set({ dropping: null, droppingMerge: null })
          .where(this.#same(link));
        return undefined;
      }
      await tx
        .update(repoMerges)
        .set({ state: "superseded", input: null })
        .where(and(eq(repoMerges.projectId, link.projectId), eq(repoMerges.state, "ready")));
      const [row] = await tx
        .insert(repoMerges)
        .values({
          projectId: link.projectId,
          provider: link.provider,
          repoId: link.repoId,
          fromSha: tip,
          toSha: tip,
          input: writeMergeInput(input),
          result: { drops: input.map(({ path }) => path) },
          createdAt: at,
        })
        .returning({ id: repoMerges.id });
      // `dropping` stays until this is applied: refused, it pauses the archive (above).
      await tx.update(projectRepos).set({ droppingMerge: row!.id }).where(this.#same(link));
      return row!.id;
    });
    if (id === undefined) {
      link.dropping = null;
      link.droppingMerge = null;
      return undefined;
    }
    link.droppingMerge = id;
    this.#log.info(
      { project: link.projectId, merge: id, files: input.map(({ path }) => path) },
      "files people chose to take out of the project",
    );
    await this.#queueMerge(link, id);
    return { kind: "merging", merge: id };
  }

  /** Whether `sha` is `tip` or one of its ancestors, as GitHub says. */
  async #reachable(session: RepoSession, sha: string, tip: string): Promise<boolean> {
    const relation = await session.compare(sha, tip);
    return relation?.status === "ahead" || relation?.status === "identical";
  }

  /**
   * What GitHub has of the files of a merge, and what each was before (in `from`, or for a file that
   * was blocked, in the commit it was blocked on): read as text, or noted as unreadable (not UTF-8,
   * larger than `MERGE_FILE_BYTES`, a link, a submodule), which is never merged. "too-large" where
   * it is more than one merge takes: nothing is read then.
   */
  async #readForMerge(
    w: MergingWork,
    tipCommit: CommitInfo,
    from: string,
    paths: readonly string[],
    waiting: ReadonlyMap<string, BlockedFile>,
  ): Promise<
    | "too-large"
    | {
        readonly input: MergeInput[];
        readonly unreadable: BlockedFile[];
        readonly instructions: string | undefined;
      }
  > {
    const { session } = w;
    const folders = new Set(
      paths.flatMap((path) => (path.includes("/") ? [path.split("/")[0]!] : [])),
    );
    const listings = new Map<string, Promise<Map<string, TreeEntry>>>();
    const entriesOf = (commit: CommitInfo) => {
      let listing = listings.get(commit.sha);
      if (!listing) {
        listing = this.#listed(session, commit.tree, { folders }).then(({ files }) => files);
        listings.set(commit.sha, listing);
      }
      return listing;
    };
    const unreadableWhy = (entry: TreeEntry): string | undefined => {
      if (entry.type === "commit") return "a submodule";
      if (entry.type !== "blob") return "a folder";
      if (entry.mode === "120000") return "a symbolic link";
      if (entry.size !== undefined && entry.size > MERGE_FILE_BYTES)
        return `larger than ${MERGE_FILE_BYTES / 1024 / 1024} MiB`;
      return undefined;
    };
    const theirs = await entriesOf(tipCommit);
    const commits = new Map<string, CommitInfo | undefined>();
    const commitOf = async (sha: string) => {
      if (!commits.has(sha)) commits.set(sha, await session.commit(sha));
      return commits.get(sha);
    };
    /** Where each base is read from, and its entry there. */
    const bases = new Map<string, { readonly commit: CommitInfo; readonly entry: TreeEntry }>();
    const baseShaOf = (path: string) => waiting.get(path)?.baseSha ?? from;
    for (const path of paths) {
      const commit = (await commitOf(baseShaOf(path))) ?? (await commitOf(from));
      if (!commit) continue;
      const entry = (await entriesOf(commit)).get(path);
      if (entry && unreadableWhy(entry) === undefined) bases.set(path, { commit, entry });
    }
    const unreadable: BlockedFile[] = [];
    const readable: TreeEntry[] = [];
    let bytes = 0;
    for (const path of paths) {
      const entry = theirs.get(path);
      if (entry) {
        const why = unreadableWhy(entry);
        if (why !== undefined) {
          unreadable.push({ path, reason: "unreadable", detail: why, baseSha: baseShaOf(path) });
          continue;
        }
        readable.push(entry);
        bytes += entry.size ?? 0;
      }
      bytes += bases.get(path)?.entry.size ?? 0;
    }
    if (
      paths.length - unreadable.length > this.#mergeLimits.files ||
      bytes > this.#mergeLimits.bytes
    )
      return "too-large";
    const texts = await session.files(tipCommit.sha, readable);
    const baseTexts = new Map<string, Uint8Array>();
    const byCommit = new Map<string, { commit: CommitInfo; entries: TreeEntry[] }>();
    for (const { commit, entry } of bases.values()) {
      const group = byCommit.get(commit.sha) ?? { commit, entries: [] };
      group.entries.push(entry);
      byCommit.set(commit.sha, group);
    }
    for (const { commit, entries } of byCommit.values())
      for (const [path, data] of await session.files(commit.sha, entries))
        baseTexts.set(path, data);
    const decode = (data: Uint8Array | undefined) => {
      if (data === undefined) return undefined;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return null;
      }
    };
    const input: MergeInput[] = [];
    let instructions: string | undefined;
    for (const path of paths) {
      if (unreadable.some((file) => file.path === path)) continue;
      const entry = theirs.get(path);
      const text = decode(entry && texts.get(path));
      // A file of people's own in Git LFS: what Git has is the pointer, not the file, and the
      // platform never reads it into the project as if it were.
      if (
        text !== undefined &&
        text !== null &&
        Buffer.byteLength(text, "utf8") < LFS_POINTER_MAX_BYTES &&
        readLfsPointer(text) !== undefined
      ) {
        unreadable.push({
          path,
          reason: "unreadable",
          detail: "a pointer of Git LFS",
          baseSha: baseShaOf(path),
        });
        continue;
      }
      if (text === null) {
        unreadable.push({
          path,
          reason: "unreadable",
          detail: "not UTF-8 text",
          baseSha: baseShaOf(path),
        });
        continue;
      }
      const base = decode(baseTexts.get(path)) ?? undefined;
      const baseSha = bases.get(path)?.commit.sha;
      input.push({
        path,
        ...(base !== undefined && { base }),
        ...(text !== undefined && { theirs: text }),
        ...(baseSha !== undefined && baseSha !== from && { baseSha }),
      });
      if (path === INSTRUCTIONS_FILE && entry) instructions = entry.sha;
    }
    return { input, unreadable, instructions };
  }

  /**
   * Nothing of the project changed on GitHub since what the platform has of it: archives go on from
   * the branch as it is, which is what was merged where something was.
   */
  async #adoptMerged(w: MergingWork, tip: string): Promise<void> {
    const { state } = w;
    if (state.mergedSha === null && state.mergeFrom === null) {
      await this.#adopt(w.link, tip);
      state.known = tip;
      return;
    }
    const [noted] = await this.#db
      .update(projectRepos)
      .set({ mergedSha: tip })
      .where(
        and(
          this.#same(w.link),
          state.mergedSha === null
            ? isNull(projectRepos.mergedSha)
            : eq(projectRepos.mergedSha, state.mergedSha),
        ),
      )
      .returning({ projectId: projectRepos.projectId });
    if (!noted) throw new LinkChanged();
    state.mergedSha = tip;
  }

  /**
   * Whether anything waits that an archive may not go past: a merge for the API (queued again),
   * open conflicts, or blocked files (paused for). Read from the database as it is now.
   */
  async #waiting(w: MergingWork): Promise<ArchiveOutcome | undefined> {
    const { link } = w;
    const [ready] = await this.#db
      .select({ id: repoMerges.id })
      .from(repoMerges)
      .where(and(eq(repoMerges.projectId, link.projectId), eq(repoMerges.state, "ready")));
    if (ready) {
      await this.#queueMerge(link, ready.id);
      return { kind: "merging", merge: ready.id };
    }
    const [now] = await this.#db
      .select({ blocked: projectRepos.blocked })
      .from(projectRepos)
      .where(this.#same(link));
    if (!now) throw new LinkChanged();
    const [open] = await this.#db
      .select({ count: count() })
      .from(repoConflicts)
      .where(and(eq(repoConflicts.projectId, link.projectId), eq(repoConflicts.state, "open")));
    const reason = mergePauseOf(now.blocked, open?.count ?? 0);
    if (reason === undefined) return undefined;
    throw new Pause(
      reason,
      reason === "conflicts"
        ? `${open?.count ?? 0} conflicts with GitHub wait for people`
        : `${now.blocked.length} files on GitHub were not merged`,
      reason === "locked" ? { seq: w.project.head } : {},
    );
  }

  /**
   * The project as it was right before the first merge since the last archive, as a commit on top
   * of that archive (E of the plan, A2): where the editor had changes then that the repository did
   * not have, so that they stay in the history next to GitHub's. Made of the snapshot the merge took
   * (`project_snapshots`, "before-repo") by the rules of any archive, at the time of the snapshot:
   * made again, it is the same commit. Undefined where there is nothing of the editor's to keep, or
   * it cannot be made (the snapshot is gone, it would not read as a project, or it would write
   * over an AGENTS.md that no archive wrote): the snapshot stays on the platform then.
   */
  async #beforeMerge(w: MergingWork, looked: Looked): Promise<string | undefined> {
    const { link, session, state } = w;
    if (state.known === null) return undefined;
    // Since the last archive, and never from before people last went on with the editor's
    // content, which sets `archived_seq` back to 0 (`merge_floor`).
    const since = Math.max(w.archivedSeq, link.mergeFloor ?? 0);
    const [first] = await this.#db
      .select({ id: repoMerges.id, oursSeq: repoMerges.oursSeq, result: repoMerges.result })
      .from(repoMerges)
      .where(
        and(
          eq(repoMerges.projectId, link.projectId),
          eq(repoMerges.provider, link.provider),
          eq(repoMerges.repoId, link.repoId),
          eq(repoMerges.state, "applied"),
          gt(repoMerges.seq, since),
        ),
      )
      .orderBy(asc(repoMerges.seq))
      .limit(1);
    if (!first || first.oursSeq === null || first.oursSeq <= since) return undefined;
    // The project before files people took out has them: never into the history of GitHub.
    if (first.result?.drops !== undefined) return undefined;
    const [snapshot] = await this.#db
      .select({ state: projectSnapshots.state, createdAt: projectSnapshots.createdAt })
      .from(projectBatches)
      .innerJoin(projectSnapshots, eq(projectSnapshots.id, projectBatches.snapshotId))
      .where(and(eq(projectBatches.id, first.id), eq(projectBatches.projectId, link.projectId)));
    if (!snapshot) return undefined;
    const knownCommit = await session.commit(state.known);
    if (!knownCommit) return undefined;
    const exported = await w.exporter().export([snapshot.state], hereOf(link));
    if (exported.invalid.has("animaquill.json")) return undefined;
    const top = await session.tree(knownCommit.tree);
    const attributes = await this.#attributesOf(session, top);
    const lined = (attributesSection(attributes) ?? []).flatMap(
      (line) => pathOfAttributesLine(line) ?? [],
    );
    const candidates = new Set([...w.ours, ...lined]);
    const parent = await this.#listed(session, knownCommit.tree, {
      top,
      extra: topFoldersOf([...exported.lfs.map(({ path }) => path), ...candidates]),
    });
    try {
      await this.#assertOwnInstructions(session, link, exported, state.known, top, new Map(), true);
    } catch (error) {
      if (error instanceof Pause) return undefined;
      throw error;
    }
    const { plan } = await this.#plan(session, link, exported, parent, {
      attributes,
      candidates,
      looked,
    });
    if (plan.manifestInvalid || plan.changes.length === 0) return undefined;
    const documents = new Map<string, string>();
    for (const [path, file] of exported.files)
      if (isDocument(path) && !exported.invalid.has(path)) documents.set(path, file.text);
    if ((await w.exporter().check(documents)).length > 0) return undefined;
    const tree = await session.writeTree(knownCommit.tree, plan.changes);
    return session.writeCommit({
      tree,
      parents: [state.known],
      message: commitMessage({
        local: link.provider === "local",
        kind: "before-merge",
        changed: plan.changed,
        removed: plan.removed,
        kept: plan.kept,
        project: link.projectId,
        seq: first.oursSeq,
      }),
      author: w.project.author,
      at: snapshot.createdAt,
    });
  }

  /** Has the API merge what was found, see `ArchiverOptions.enqueueMerge`. */
  async #queueMerge(link: Link, merge: string): Promise<void> {
    if (!this.#enqueueMerge) {
      this.#log.warn({ project: link.projectId, merge }, "nothing merges: the merge waits");
      return;
    }
    await this.#enqueueMerge(merge).catch((error: unknown) => {
      // It waits "ready": the next archive that looks queues it again.
      this.#log.warn(
        { err: describeError(error), project: link.projectId, merge },
        "no merge queued",
      );
    });
  }

  /**
   * Whether AGENTS.md of this blob came into the project by a merge (`RepoMergeResult.instructions`):
   * then the project's is what it became, and an archive writes it over GitHub's.
   */
  async #instructionsMerged(link: Link, blob: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: repoMerges.id })
      .from(repoMerges)
      .where(
        and(
          eq(repoMerges.projectId, link.projectId),
          eq(repoMerges.provider, link.provider),
          eq(repoMerges.repoId, link.repoId),
          eq(repoMerges.state, "applied"),
          sql`${repoMerges.result}->>'instructions' = ${blob}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Stops before writing what people wrote into AGENTS.md in the project over an AGENTS.md on
   * GitHub that no archive of this project wrote, such as one people kept in the repository before
   * it held the project: an archive leaves that one alone as long as the project has only the
   * opening a new project starts with, see plan.ts. Which commit brought the file to what it is
   * now is looked up along the first parents, `INSTRUCTIONS_LOOK_BACK` at the most; where that is
   * not found, it counts as not ours.
   */
  async #assertOwnInstructions(
    session: RepoSession,
    link: Link,
    exported: ExportResult,
    base: string,
    top: readonly TreeEntry[],
    found: Map<string, boolean>,
    merging = false,
  ): Promise<void> {
    const ours = exported.files.get(INSTRUCTIONS_FILE);
    if (!ours || ours.text === INSTRUCTIONS_START) return;
    const there = top.find(({ path }) => path === INSTRUCTIONS_FILE);
    if (!there || there.type !== "blob" || there.sha === ours.sha) return;
    // People chose the project over what GitHub has (“以项目为准”, see `ArchiveService`), on this
    // very commit: the archive that follows writes all of the project again, AGENTS.md too.
    if (link.replacedSha !== null && link.replacedSha === base) return;
    // GitHub's came into the project by a merge: the project's is what became of it.
    if (merging && (await this.#instructionsMerged(link, there.sha))) return;
    const key = `${base}\n${there.sha}`;
    let isOurs = found.get(key);
    if (isOurs === undefined) {
      isOurs = await this.#broughtByArchive(session, link, base, there.sha);
      found.set(key, isOurs);
    }
    if (isOurs) return;
    throw new Pause("diverged", "AGENTS.md on GitHub is not what an archive wrote", {
      diverged: {
        sha: base,
        files: [INSTRUCTIONS_FILE],
        deleted: [],
        ...(merging && { merging: true }),
      },
    });
  }

  /**
   * Whether the commit that brought AGENTS.md to this blob, along the first parents from `base`, is
   * an archive of this project. A tree that did not change is passed without a look inside; a
   * parent that cannot be had, or a walk longer than `INSTRUCTIONS_LOOK_BACK`, says no.
   */
  async #broughtByArchive(
    session: RepoSession,
    link: Link,
    base: string,
    blob: string,
  ): Promise<boolean> {
    let commit = await session.commit(base);
    for (let step = 0; commit && step < INSTRUCTIONS_LOOK_BACK; step++) {
      const [first] = commit.parents;
      if (first === undefined) {
        // The first commit of all brought it.
        return trailersOf(commit.message)?.project === link.projectId;
      }
      const parent = await session.commit(first);
      if (!parent) return false;
      if (parent.tree !== commit.tree) {
        const before = (await session.tree(parent.tree)).find(
          ({ path }) => path === INSTRUCTIONS_FILE,
        );
        if (before?.sha !== blob) return trailersOf(commit.message)?.project === link.projectId;
      }
      commit = parent;
    }
    return false;
  }

  /**
   * What changes on top of a tree: plan.ts, with what it needs to know of the blobs there, and the
   * pointers of large files, pointers.ts, with the paths where a pointer could be the platform's
   * (`candidates`), what the files there point at, and what the storage has of all that. Also the
   * pointers that are the platform's afterwards. `attributes`: the parent's .gitattributes.
   */
  async #plan(
    session: RepoSession,
    link: Link,
    exported: ExportResult,
    parent: Listed,
    lfs: {
      readonly attributes: AttributesText;
      readonly candidates: ReadonlySet<string>;
      readonly looked: Looked;
      /** See `PointerInput.confirmed`. */
      readonly confirmed?: ReadonlySet<string> | undefined;
    },
  ) {
    const leaving = [...parent.managed.keys()].filter(
      (path) => !exported.files.has(path) && !exported.invalid.has(path),
    );
    const text = await this.#lookAt(session, blobsToLookAt(leaving, parent.managed));
    // An assets.json that cannot be written as it is stays as the parent has it: its pointers too.
    const assets = exported.invalid.has("assets.json") ? undefined : exported.lfs;
    // What the files that could be pointers of the platform's point at. The pointer of an asset as
    // it is now is known by its sha; any other small file there is looked at.
    const asWritten = new Map<string, LfsObjectId>();
    for (const { oid, size } of assets ?? []) {
      const pointer = pointerText(oid, size);
      if (pointer !== undefined) asWritten.set(blobShaOf(bytesOf(pointer)), { oid, size });
    }
    const pointers = new Map<string, LfsObjectId>();
    for (const path of lfs.candidates) {
      const entry = parent.files.get(path);
      if (!entry || entry.type !== "blob" || entry.mode === "120000") continue;
      const pointer = asWritten.get(entry.sha) ?? (await this.#pointerAt(session, entry));
      if (pointer) pointers.set(path, pointer);
    }
    const { stored, unknown } = await this.#storedOf(
      session,
      link,
      assets ?? [],
      [...pointers.values()],
      lfs.looked,
    );
    const planned = planPointers({
      assets,
      stored,
      unknown,
      ours: lfs.candidates,
      pointers,
      files: parent.files,
      folders: parent.folders,
      projectFiles: new Set([...exported.files.keys(), ...parent.managed.keys()]),
      // Our two lines in it are not one pair, or a link is where it would be: no line can be
      // written, so no pointer comes or goes.
      frozen: attributesSection(lfs.attributes) === undefined,
      ...(lfs.confirmed && { confirmed: lfs.confirmed }),
    });
    const plan = planArchive(
      exported,
      parent.managed,
      text,
      { text: lfs.attributes, section: planned.section },
      parent.others,
      planned,
    );
    return { plan, lfsPaths: [...planned.paths] };
  }

  /**
   * .gitattributes at the top of a tree: its text, nothing where there is none, and `NOT_TEXT`
   * for a link, a submodule or a folder there, which is neither read nor written over.
   */
  async #attributesOf(session: RepoSession, top: readonly TreeEntry[]): Promise<AttributesText> {
    const entry = top.find(({ path }) => path === ATTRIBUTES_FILE);
    if (!entry) return undefined;
    if (entry.type !== "blob" || entry.mode === "120000") return NOT_TEXT;
    return Buffer.from(await session.blob(entry.sha)).toString("utf8");
  }

  /** What a file points at, where it is a pointer of Git LFS: a small file that reads as one. */
  async #pointerAt(session: RepoSession, entry: TreeEntry): Promise<LfsObjectId | undefined> {
    if (entry.size === undefined || entry.size >= LFS_POINTER_MAX_BYTES) return undefined;
    let seen = POINTERS_SEEN.get(entry.sha);
    if (seen === undefined) {
      seen = readLfsPointer(Buffer.from(await session.blob(entry.sha)).toString("utf8")) ?? null;
      if (POINTERS_SEEN.size >= TEXT_SEEN_MOST)
        POINTERS_SEEN.delete(POINTERS_SEEN.keys().next().value as string);
      POINTERS_SEEN.set(entry.sha, seen);
    }
    return seen ?? undefined;
  }

  /**
   * What the large file storage of the repository has of these objects: size by oid, and those it
   * could not be asked about. What the platform noted (`lfs_objects`) counts, never what the project
   * says. For the objects of assets that are not noted GitHub is asked, once in an archive, and
   * what it has is noted again: so a database that came back from a backup, older than the objects,
   * finds them. Before uploads are noted nothing is written down as in Git LFS, so in the ordinary
   * way nobody is asked. What files of the repository point at (`pointed`) is only looked up: a
   * pointer is the platform's by what the platform noted, not by what GitHub has, which has the
   * objects of people's own pointers too.
   */
  async #storedOf(
    session: RepoSession,
    link: Link,
    assets: readonly LfsObject[],
    pointed: readonly LfsObject[],
    looked: Looked,
  ): Promise<{ stored: Map<string, number>; unknown: Set<string> }> {
    // Each object as large as it is said to be: two assets can say two sizes of one oid, and a
    // storage that minds the size has it under one of them only.
    const fresh = new Map<string, LfsObject[]>();
    for (const object of assets) {
      if (looked.has(object.oid)) continue;
      const said = fresh.get(object.oid) ?? [];
      if (!said.some(({ size }) => size === object.size)) said.push(object);
      fresh.set(object.oid, said);
    }
    const oids = [
      ...new Set([
        ...fresh.keys(),
        ...pointed.flatMap(({ oid }) => (looked.has(oid) ? [] : [oid])),
      ]),
    ];
    for (let at = 0; at < oids.length; at += 1000) {
      const rows = await this.#db
        .select({ oid: lfsObjects.oid, size: lfsObjects.size })
        .from(lfsObjects)
        .where(
          and(
            eq(lfsObjects.provider, link.provider),
            eq(lfsObjects.repoId, link.repoId),
            inArray(lfsObjects.oid, oids.slice(at, at + 1000)),
          ),
        );
      for (const row of rows) {
        looked.set(row.oid, row.size);
        fresh.delete(row.oid);
      }
    }
    // Asked one size of an oid at a time, as the batch API answers by oid: the next size only
    // where the one before was not there. So many in an archive at most, see `ASKED_MOST`: those
    // asked longest ago first, and not those GitHub said it has none of a moment ago, see
    // `ASKED_SEEN`.
    const now = this.#now().getTime();
    const seenOf = (object: LfsObject) =>
      ASKED_SEEN.get(`${link.provider}:${link.repoId}:${object.oid}:${object.size}`);
    const asked = new Set<LfsObject>();
    for (const said of fresh.values())
      for (const object of said) {
        const seen = seenOf(object);
        if (seen?.absent && now - seen.at < ABSENT_MS) asked.add(object);
      }
    const lastAsked = (said: readonly LfsObject[]) =>
      Math.min(...said.map((object) => seenOf(object)?.at ?? 0));
    const waiting = [...fresh.values()].toSorted((a, b) => lastAsked(a) - lastAsked(b));
    const note = (object: LfsObject, absent: boolean) => {
      const key = `${link.provider}:${link.repoId}:${object.oid}:${object.size}`;
      ASKED_SEEN.delete(key);
      if (ASKED_SEEN.size >= ASKED_SEEN_MOST)
        ASKED_SEEN.delete(ASKED_SEEN.keys().next().value as string);
      ASKED_SEEN.set(key, { at: now, absent });
    };
    let left = ASKED_MOST;
    let failed = false;
    const turns = Math.max(0, ...waiting.map((said) => said.length));
    for (let turn = 0; !failed && left > 0 && turn < turns; turn++) {
      const these = waiting.flatMap((said) => {
        const object = said[turn];
        return object && !asked.has(object) && typeof looked.get(object.oid) !== "number"
          ? [object]
          : [];
      });
      if (these.length === 0) continue;
      for (let at = 0; at < these.length && !failed && left > 0; at += ASKED_AT_ONCE) {
        const some = these.slice(at, at + Math.min(ASKED_AT_ONCE, left));
        left -= some.length;
        try {
          const sizes = await session.lfsSizes(some);
          const found: { provider: RepoProvider; repoId: number; oid: string; size: number }[] =
            [];
          for (const [index, object] of some.entries()) {
            asked.add(object);
            const size = sizes[index];
            note(object, size === undefined);
            if (size === undefined) continue;
            looked.set(object.oid, size);
            found.push({ provider: link.provider, repoId: link.repoId, oid: object.oid, size });
          }
          if (found.length > 0) {
            await this.#db.insert(lfsObjects).values(found).onConflictDoNothing();
            this.#log.info(
              { project: link.projectId, objects: found.length },
              "objects GitHub has in Git LFS noted again",
            );
          }
        } catch (error) {
          // Git LFS cannot be asked now (down, the account out of room, or it says no for a
          // reason of its own): the documents are archived all the same, and what points at
          // these objects stays as it is until it can. A repository that is gone says so to
          // what the archive does next.
          this.#log.warn(
            { err: describeError(error), project: link.projectId },
            "Git LFS could not be asked what it has",
          );
          failed = true;
        }
      }
    }
    // Not there in any size it is said to have: the storage does not have it. Not asked about in
    // all of them: unknown, until the next archive.
    for (const said of waiting) {
      const oid = (said[0] as LfsObject).oid;
      if (typeof looked.get(oid) === "number") continue;
      looked.set(oid, said.every((object) => asked.has(object)) ? null : "unknown");
    }
    const stored = new Map<string, number>();
    const unknown = new Set<string>();
    for (const { oid } of [...assets, ...pointed]) {
      const size = looked.get(oid);
      if (typeof size === "number") stored.set(oid, size);
      else if (size === "unknown") unknown.add(oid);
    }
    return { stored, unknown };
  }

  /**
   * The files of a tree that could be the platform's (`managedEntries`), and the others of the parts
   * of it that were listed: the top, the folders of the format, and those at the top in `extra`, where
   * pointers of large files are. `folders`: only those of these that are in it.
   */
  async #listed(
    session: RepoSession,
    tree: string,
    options: {
      readonly folders?: ReadonlySet<string>;
      readonly top?: readonly TreeEntry[];
      readonly extra?: ReadonlySet<string>;
    } = {},
  ): Promise<Listed> {
    const root = options.top ?? (await session.tree(tree));
    const entries: TreeEntry[] = root.filter((entry) => entry.type !== "tree");
    const folders = new Set<string>();
    for (const entry of root) {
      if (entry.type !== "tree") continue;
      folders.add(entry.path);
      // Also a folder whose name the line of a pointer would take along, see `spaced`.
      if (!isProjectFolder(entry.path) && !options.extra?.has(spaced(entry.path))) continue;
      if (options.folders && !options.folders.has(entry.path)) continue;
      for (const inner of await session.tree(entry.sha, { recursive: true })) {
        const path = `${entry.path}/${inner.path}`;
        if (inner.type === "tree") folders.add(path);
        else entries.push({ ...inner, path });
      }
    }
    const managed = managedEntries(entries);
    const others = new Set(entries.map(({ path }) => path).filter((path) => !managed.has(path)));
    // Folders at the top that were not listed are there all the same: a file of the project cannot
    // be where one of them is. One stands for each, as "<name>/", see `planArchive`.
    for (const entry of root)
      if (entry.type === "tree" && !entries.some(({ path }) => path.startsWith(`${entry.path}/`)))
        others.add(`${entry.path}/`);
    return {
      managed,
      others,
      files: new Map(entries.map((entry) => [entry.path, entry])),
      folders,
    };
  }

  /**
   * The files of the platform that differ between two trees (`before` undefined: none at all): of
   * the format, our section of .gitattributes, and the pointers of large files the platform wrote,
   * `pointers`. Only folders whose trees differ are listed.
   */
  async #differing(
    session: RepoSession,
    before: string | undefined,
    after: string,
    pointers: readonly string[],
  ) {
    const topBefore = before === undefined ? [] : await session.tree(before);
    const topAfter = await session.tree(after);
    const extra = topFoldersOf(pointers);
    const folderSha = (top: readonly TreeEntry[]) =>
      new Map(
        top
          .filter(
            (entry) =>
              entry.type === "tree" && (isProjectFolder(entry.path) || extra.has(entry.path)),
          )
          .map((entry) => [entry.path, entry.sha]),
      );
    const was = folderSha(topBefore);
    const now = folderSha(topAfter);
    const folders = new Set(
      [...new Set([...was.keys(), ...now.keys()])].filter(
        (name) => was.get(name) !== now.get(name),
      ),
    );
    const listedBefore =
      before === undefined
        ? undefined
        : await this.#listed(session, before, { folders, top: topBefore, extra });
    const listedAfter = await this.#listed(session, after, { folders, top: topAfter, extra });
    const old = listedBefore?.managed ?? new Map<string, TreeEntry>();
    const fresh = listedAfter.managed;
    const changed = [...new Set([...old.keys(), ...fresh.keys()])].filter(
      (path) => old.get(path)?.sha !== fresh.get(path)?.sha,
    );
    const text = await this.#lookAt(session, blobsToLookAt(changed, old, fresh));
    const attributes: { before?: AttributesText; after?: AttributesText } = {};
    const oldAttributes = old.get(ATTRIBUTES_FILE);
    const freshAttributes = fresh.get(ATTRIBUTES_FILE);
    if (
      oldAttributes?.sha !== freshAttributes?.sha ||
      oldAttributes?.mode !== freshAttributes?.mode
    ) {
      attributes.before = await this.#attributesOf(session, topBefore);
      attributes.after = await this.#attributesOf(session, topAfter);
    }
    const files = new Set(differingFiles(old, fresh, text, attributes));
    // A pointer of the platform's that is not as it was, in a folder that changed or at the top.
    const unlisted = (path: string) => {
      const at = path.indexOf("/");
      return at > 0 && !folders.has(path.slice(0, at));
    };
    const pointerBefore = (path: string) => listedBefore?.files.get(path);
    for (const path of pointers) {
      if (unlisted(path)) continue;
      const earlier = pointerBefore(path);
      const later = listedAfter.files.get(path);
      if (earlier?.sha !== later?.sha || earlier?.mode !== later?.mode) files.add(path);
    }
    const sorted = [...files].toSorted((a, b) => (a < b ? -1 : 1));
    // Which of them GitHub took away: what the editor tells people before an archive goes on top of
    // it, which writes back those the project has, and writes over or takes away the others.
    return {
      files: sorted,
      deleted: sorted.filter((path) => !fresh.has(path) && !listedAfter.files.has(path)),
    };
  }

  /** Whether blobs are text the editor reads, by looking at them, once each, see `TEXT_SEEN`. */
  async #lookAt(session: RepoSession, shas: ReadonlySet<string>): Promise<Map<string, boolean>> {
    const text = new Map<string, boolean>();
    for (const sha of shas) {
      let seen = TEXT_SEEN.get(sha);
      if (seen === undefined) {
        seen = isText(await session.blob(sha));
        if (TEXT_SEEN.size >= TEXT_SEEN_MOST)
          TEXT_SEEN.delete(TEXT_SEEN.keys().next().value as string);
        TEXT_SEEN.set(sha, seen);
      }
      text.set(sha, seen);
    }
    return text;
  }

  /** Whether `sha` is the tip or one of the commits just before it, on the first parents. */
  async #reaches(session: RepoSession, tip: string, sha: string): Promise<boolean> {
    let at: string | undefined = tip;
    for (let depth = 0; at !== undefined && depth < PENDING_DEPTH; depth++) {
      if (at === sha) return true;
      at = (await session.commit(at))?.parents[0];
    }
    return false;
  }

  /** Whether the person whose project it is is disabled, see admin/users.ts. */
  /** Whether the project is not there any more. */
  async #isGone(projectId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row === undefined;
  }

  /** Whether the working copy of the project is here, see `projects.copy_state`. */
  async #isLive(projectId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ copyState: projects.copyState })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.copyState === "live";
  }

  async #ownerDisabled(projectId: string): Promise<boolean> {
    const [owner] = await this.#db
      .select({ disabledAt: users.disabledAt })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(eq(projects.id, projectId));
    return owner?.disabledAt != null;
  }

  /** The working copy, all of one moment: the last snapshot, and every update after it, in order. */
  /** Whose a project is, and its name, as a repository of the server's own is made for it. */
  async #readOwner(projectId: string): Promise<{ ownerId: string; name: string }> {
    const [row] = await this.#db
      .select({ ownerId: projects.ownerId, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!row) throw new LinkChanged();
    return row;
  }

  async #readProject(projectId: string): Promise<ProjectAt> {
    return this.#db.transaction(
      async (tx) => {
        const [project] = await tx
          .select({ head: projects.head, login: users.login, githubId: users.githubId })
          .from(projects)
          .innerJoin(users, eq(users.id, projects.ownerId))
          .where(eq(projects.id, projectId));
        if (!project) throw new MissingUpdates(`no project ${projectId}`);
        const [snapshot] = await tx
          .select({ seq: projectSnapshots.seq, state: projectSnapshots.state })
          .from(projectSnapshots)
          .where(
            and(eq(projectSnapshots.projectId, projectId), eq(projectSnapshots.reason, "compact")),
          )
          .orderBy(desc(projectSnapshots.seq))
          .limit(1);
        const after = snapshot?.seq ?? 0;
        const rows = await tx
          .select({ seq: projectUpdates.seq, data: projectUpdates.data })
          .from(projectUpdates)
          .where(
            and(
              eq(projectUpdates.projectId, projectId),
              gt(projectUpdates.seq, after),
              lte(projectUpdates.seq, project.head),
            ),
          )
          .orderBy(asc(projectUpdates.seq));
        rows.forEach((row, index) => {
          if (row.seq !== after + index + 1)
            throw new MissingUpdates(`project ${projectId} misses update ${after + index + 1}`);
        });
        if (after + rows.length !== project.head)
          throw new MissingUpdates(`project ${projectId} does not reach its head ${project.head}`);
        return {
          head: project.head,
          parts: [...(snapshot ? [snapshot.state] : []), ...rows.map((row) => row.data)],
          author: {
            name: project.login,
            email: `${project.githubId}+${project.login}@users.noreply.github.com`,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** Updates of the link that only hold while it is the link this archive started with. */
  #same(link: Link) {
    return sameLink(link);
  }

  /**
   * The names of the repository and its branch as they are now, for showing, and that it was
   * looked at now (`checked_at`): the list of projects says how old what it shows is, and has
   * repositories looked at again that nobody looked at for a day. The account it was linked on
   * (`owner_id`) stays: that is what tells that it moved. Whatever a webhook said became of the
   * repository is over, as it is there.
   */
  async #remember(link: Link, info: RepoInfo, at: Date): Promise<void> {
    await this.#db
      .update(projectRepos)
      .set({
        ownerLogin: info.owner,
        name: info.name,
        branch: info.branch,
        private: info.private,
        checkedAt: at,
        goneCause: null,
      })
      .where(this.#same(link));
  }

  /**
   * `ready`: only while archiving still goes, as with merges, where conflicts that a change of an
   * editor brought (sync/hub.ts) pause it meanwhile: nothing is written then.
   */
  async #notePending(
    link: Link,
    sha: string,
    pending: PendingArchive,
    options: { readonly ready?: boolean } = {},
  ): Promise<void> {
    const [noted] = await this.#db
      .update(projectRepos)
      .set({ pendingSha: sha, pending })
      .where(and(this.#same(link), options.ready ? eq(projectRepos.state, "ready") : undefined))
      .returning({ projectId: projectRepos.projectId });
    if (!noted) throw new LinkChanged();
  }

  async #dropPending(link: Link, sha?: string): Promise<void> {
    await this.#db
      .update(projectRepos)
      .set({ pendingSha: null, pending: null })
      .where(
        and(this.#same(link), sha === undefined ? undefined : eq(projectRepos.pendingSha, sha)),
      );
  }

  /** The branch has the commit of an archive: it is one, and the project is archived up to it. */
  async #landed(
    link: Link,
    sha: string,
    pending: PendingArchive,
    at: Date,
    asked: Date | null,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [noted] = await tx
        .update(projectRepos)
        .set({
          headSha: sha,
          // What people chose the project over is the archive's now: no choice is left to keep.
          replacedSha: null,
          pendingSha: null,
          pending: null,
          archivedSeq: sql`greatest(${projectRepos.archivedSeq}, ${pending.seq})`,
          archivedAt: at,
          failures: 0,
          nextAttemptAt: null,
          transientSince: null,
          unusableSeenAt: null,
          detail: null,
          // The pointers the commit has, which are the platform's: from before 14.2, as they were.
          ...(pending.lfsPaths && { lfsPaths: [...pending.lfsPaths] }),
          // What was merged is in the repository now: unless a newer merge came since.
          ...(pending.merged !== undefined && mergedGone(pending.merged)),
        })
        .where(this.#same(link))
        .returning({ projectId: projectRepos.projectId });
      if (!noted) throw new LinkChanged();
      await tx.insert(archives).values({
        projectId: link.projectId,
        provider: link.provider,
        repoId: link.repoId,
        seq: pending.seq,
        sha,
        parentSha: pending.parent,
        kind: pending.kind,
        changed: pending.changed,
        removed: pending.removed,
        kept: [...pending.kept],
        byUser: pending.byUser,
        createdAt: at,
      });
      await this.#settleDirty(tx, link.projectId, pending.seq, at);
      await this.#answered(tx, link, asked);
    });
  }

  /**
   * Nothing to write: the repository has the project up to `seq`, on `tip`, and of the pointers of
   * large files there, `lfsPaths` are the platform's, where they were looked at.
   */
  async #settle(
    link: Link,
    seq: number,
    tip: string,
    at: Date,
    asked: Date | null,
    lfsPaths?: readonly string[],
    /** What was merged, which the branch has as it is: none is left to archive. */
    merged?: string | null,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [noted] = await tx
        .update(projectRepos)
        .set({
          headSha: tip,
          archivedSeq: sql`greatest(${projectRepos.archivedSeq}, ${seq})`,
          failures: 0,
          nextAttemptAt: null,
          transientSince: null,
          unusableSeenAt: null,
          detail: null,
          ...(lfsPaths && { lfsPaths: [...lfsPaths] }),
          ...(merged != null && mergedGone(merged)),
        })
        .where(this.#same(link))
        .returning({ projectId: projectRepos.projectId });
      if (!noted) throw new LinkChanged();
      await this.#settleDirty(tx, link.projectId, seq, at);
      await this.#answered(tx, link, asked);
    });
  }

  /**
   * The archive people asked for at `asked` is done: unless they asked again since. The database
   * keeps microseconds, a Date only milliseconds: what is within the millisecond is that request.
   */
  async #answered(tx: Executor, link: Link, asked: Date | null): Promise<void> {
    if (asked === null) return;
    await tx
      .update(projectRepos)
      .set({ requestedAt: null, requestedBy: null })
      .where(
        and(
          this.#same(link),
          sql`${projectRepos.requestedAt} < ${new Date(asked.getTime() + 1).toISOString()}::timestamptz`,
        ),
      );
  }

  /** The tip has nothing of the platform's that differs: archives go on top of it from now on. */
  async #adopt(link: Link, tip: string): Promise<void> {
    await this.#db.update(projectRepos).set({ headSha: tip }).where(this.#same(link));
  }

  /**
   * The project is archived up to `seq`: it has no changes waiting where nothing came since, and
   * where something did, its changes wait from now on.
   */
  async #settleDirty(tx: Executor, projectId: string, seq: number, at: Date): Promise<void> {
    await tx
      .update(projects)
      .set({
        dirtySince: sql`case when ${projects.head} <= ${seq} then null else ${at.toISOString()}::timestamptz end`,
      })
      .where(eq(projects.id, projectId));
  }

  async #pause(
    link: Link,
    reason: PauseReason,
    detail: string,
    more: { readonly diverged?: Diverged | undefined; readonly seq?: number | undefined },
  ) {
    await pauseLink(this.#db, link, {
      reason,
      detail,
      at: this.#now(),
      ...(more.diverged && { diverged: more.diverged }),
      ...(more.seq !== undefined && { seq: more.seq }),
    });
  }

  /**
   * Whether an archive that finds the repository cannot be used says so now: where one found the
   * same at least `CONFIRM_AFTER_MS` and at most `CONFIRM_WITHIN_MS` ago (`unusable_seen_at`).
   */
  #confirms(link: Link): boolean {
    const seen = link.unusableSeenAt?.getTime();
    if (seen === undefined) return false;
    const since = this.#now().getTime() - seen;
    return since >= CONFIRM_AFTER_MS && since <= CONFIRM_WITHIN_MS;
  }

  /**
   * The first time an archive finds the repository cannot be used: noted, and tried again once
   * `CONFIRM_AFTER_MS` are over, also for a project without changes (see `takeDue`). Nothing is
   * paused yet, and it is no failure of GitHub's or the platform's either.
   */
  async #suspect(link: Link, error: RepoPaused): Promise<ArchiveOutcome> {
    const now = this.#now().getTime();
    const seen = link.unusableSeenAt?.getTime();
    const from = seen !== undefined && now - seen < CONFIRM_AFTER_MS ? seen : now;
    const retryAt = new Date(from + CONFIRM_AFTER_MS);
    this.#log.warn(
      { project: link.projectId, reason: error.reason },
      "the repository cannot be used, as it seems: asked again in a few minutes",
    );
    await this.#db
      .update(projectRepos)
      .set({
        unusableSeenAt: new Date(from),
        failures: sql`${projectRepos.failures} + 1`,
        nextAttemptAt: retryAt,
        detail: error.message.slice(0, 200),
      })
      .where(this.#same(link));
    return { kind: "failed", error: error.message, retryAt };
  }

  /**
   * An archive that failed is tried again later, after a wait that grows. Whatever fails here is
   * nobody's to put right but GitHub's or the platform's (and the plan, 13.9): GitHub down,
   * limiting or cut off (`GitHubUnavailable`), GitHub turning down what should have worked
   * (`RepoRefused`), the export or the updates of the project (`ExportFailed`, `MissingUpdates`),
   * or anything else. What people can do something about pauses instead. So since when it fails is
   * noted (`transient_since`), from the first such failure: changes that are not saved for that are
   * not let go of, and failing for long is said to admins, see sync/sweep.ts.
   */
  async #fail(link: Link, error: unknown): Promise<ArchiveOutcome> {
    const retryAfter = error instanceof GitHubUnavailable ? error.retryAfterMs : undefined;
    const retryAt = new Date(this.#now().getTime() + backoffMs(link.failures, retryAfter));
    const said = describeError(error);
    const known =
      error instanceof GitHubUnavailable ||
      error instanceof RepoRefused ||
      error instanceof ExportFailed ||
      error instanceof MissingUpdates;
    this.#log[known ? "warn" : "error"](
      { err: said, project: link.projectId, failures: link.failures + 1 },
      "archive failed, trying again later",
    );
    await this.#db
      .update(projectRepos)
      .set({
        failures: sql`${projectRepos.failures} + 1`,
        nextAttemptAt: retryAt,
        transientSince: sql`coalesce(${projectRepos.transientSince}, ${this.#now().toISOString()}::timestamptz)`,
        detail: String(said.message ?? "failed").slice(0, 200),
      })
      .where(this.#same(link));
    return { kind: "failed", error: String(said.message), retryAt };
  }
}

/** What is wrong with a file of the project, for people. */
const problemsOf = (exported: ExportResult, file: string) =>
  exported.problems
    .filter((problem) => problem.startsWith(file))
    .slice(0, 3)
    .join("; ") || `${file} is not what the format says`;
