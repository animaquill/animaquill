import { OWNER_ONLY, type AccessPolicy } from "../access.ts";
import { randomBytes } from "node:crypto";
import { isProjectFile, isProjectFolder } from "@animaquill/core";
import { MANIFEST_FILE } from "@animaquill/schema";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SignedIn } from "../auth/accounts.ts";
import { SignInNeeded, type TokenOptions } from "../auth/tokens.ts";
import { describeError, type Db, type Logger, type Tx } from "../database.ts";
import type { GitHubApp } from "../github/app.ts";
import { GitHubUnauthorized, GitHubUnavailable } from "../github/client.ts";
import {
  archives,
  installations,
  projectRepos,
  projects,
  repoConflicts,
  repoMerges,
  type BlockedFile,
  type CopyProblem,
  type CopyState,
  type Diverged,
  type MergePrefer,
  type PauseReason,
  type ReleasedFrom,
  type RepoProvider,
} from "../schema.ts";
import { PROJECT_ID, SYNC_HUB_LIMITS, lockProject } from "../sync/hub.ts";
import { GitHubPersonRepos, type PersonRepo } from "./github-host.ts";
import {
  deleteAtOf,
  linkOf,
  notifyLink,
  onGitHub,
  sameLink,
  unusableReasonOf,
  type Link,
} from "./links.ts";
import { DESCRIPTION_MOST } from "../sync/copies.ts";
import {
  LOOKED_WHILE_PAUSED,
  MERGE_PAUSES,
  REPLACEABLE,
  REPO_MERGE_SETTING,
  settleMergePause,
} from "./merging.ts";
import { readSetting } from "../settings.ts";
import { recheckLink } from "./recheck.ts";
import type { LocalGitRepoHost } from "./local/host.ts";
import { RepoPaused, type GitHubPlace, type RepoHost } from "./repo-host.ts";
import { dueAt, type ArchiveJob } from "./schedule.ts";
import { notifyPerson } from "../me/events.ts";

/**
 * Saving a project to a repository, as people ask for it: which repositories they can choose,
 * whether one could take a project (`check`, before anything is made or linked, by the rules
 * linking goes by), linking one (a new private one, or one they have), how archiving goes, and
 * archiving now. The routes are in routes.ts; this is what they do.
 *
 * Their own token does what only it can (making a repository on their account, listing what their
 * installation covers); the App's token for the one repository checks what an archive will find
 * there. Only an installation on the person's own account counts: repositories of organizations are
 * not supported yet.
 */

/** Something people asked for that cannot be done: `code` for the editor, with an HTTP status. */
export class RepositoryRefused extends Error {
  override name = "RepositoryRefused";
  readonly code: string;
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  constructor(code: string, status: number, message = code, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** A repository people can choose, as the editor lists it. */
export interface ChoosableRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly pushable: boolean;
  /** As far as GitHub's numbers tell: an empty one can also look not empty, never the other way. */
  readonly empty: boolean;
  readonly archived: boolean;
  /** Another project of the platform is saved there. */
  readonly linked: boolean;
  /** Which one, where it is the person's own: what someone else has is not theirs to know. */
  readonly linkedProject?: ProjectName;
}

/** A project of the platform, as an answer names it. */
export interface ProjectName {
  readonly id: string;
  readonly name: string;
}

/** A repository people choose for a project: a new private one of this name, or one they have. */
export type RepositoryChoice =
  | { readonly create: { readonly name: string } }
  | { readonly existing: { readonly id: number }; readonly confirmPublic?: boolean };

/**
 * Whether a repository could take a project, see `RepositoryService.check`: yes, or why not, in the
 * codes linking refuses with, and with what it says along with them (`files` for "hasProject",
 * `project` for "linkedElsewhere").
 */
export type RepositoryCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: CheckReason;
      readonly files?: readonly string[];
      readonly project?: ProjectName;
    };

/** Why a repository cannot take a project, as far as a check says: what people can do something about. */
const CHECK_REASONS = [
  "nameTaken",
  "invalidName",
  "hasProject",
  "linkedElsewhere",
  "notPushable",
  "public",
  "notFound",
  "notInstalled",
] as const;
export type CheckReason = (typeof CHECK_REASONS)[number];

export interface RepositoryStatus {
  readonly repository?: {
    /** Which provider it is on, see `project_repos.provider`. */
    readonly place: RepoProvider;
    readonly id: number;
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly private: boolean;
    readonly branch: string;
    /** Where people see it: only on GitHub. */
    readonly url?: string;
    readonly createdHere: boolean;
    readonly linkedAt: number;
    /** For one of the server's own: its folder as the server has it, for `git clone`. */
    readonly clone?: string;
  };
  /** "none": no repository; "ready": archiving as it should; "paused": see `reason`. */
  readonly state: "none" | "ready" | "paused";
  readonly reason?: PauseReason;
  /**
   * For "gone", which of the two it is, where the platform knows: "deleted", GitHub said it deleted
   * it; "unauthorized", it is there, and people took it out of what the App may touch. Missing where
   * nothing tells them apart ("找不到"): see `RepositoryService.status`.
   */
  readonly gone?: "deleted" | "unauthorized";
  /**
   * The repository cannot be used, and so the project cannot be edited (archive/links.ts,
   * `UNUSABLE_REASONS`): why, as the pause says it, since when the platform found it so, and when
   * the project goes unless it can be used again. Milliseconds since 1970.
   */
  readonly unusable?: {
    readonly reason: PauseReason;
    readonly since: number;
    readonly deleteAt?: number;
    /** For "gone", as `gone` says it. */
    readonly gone?: "deleted" | "unauthorized";
  };
  /** A short word about the pause or the last failure. */
  readonly detail?: string;
  /** Why archives fail now, where it is something people know a word for: the disk is full. */
  readonly failure?: "diskFull";
  /** An archive is waiting or running. */
  readonly archiving: boolean;
  readonly lastArchive?: {
    readonly sha: string;
    readonly seq: number;
    readonly at: number;
    readonly kind: string;
    readonly changed: number;
    readonly removed: number;
    /** Where people see the commit: only on GitHub. */
    readonly url?: string;
  };
  /** Documents the last archive could not write: the repository has an older version of them. */
  readonly kept?: readonly string[];
  /** Since when changes wait to be archived. */
  readonly dirtySince?: number;
  /** When they are due, as things are now. */
  readonly nextAt?: number;
  /** After a failure: when it is tried again, and how many failed in a row. */
  readonly retryAt?: number;
  readonly failures?: number;
  /**
   * Since when archives fail for what only GitHub or the platform can put right (`transient_since`,
   * see `Archiver`): an editor takes failing for long as something people have to know about.
   */
  readonly failingSince?: number;
  /**
   * For "diverged": what changed on GitHub, on which commit, for "archive now" with `replace`; and
   * which of those files GitHub took away (`deleted`), as against changed or new there.
   */
  readonly diverged?: {
    readonly sha: string;
    readonly files: readonly string[];
    readonly deleted: readonly string[];
    /** Those of `files` that are pointers of large files of the platform's (merges on). */
    readonly pointers?: readonly string[];
    /** For "rewritten": the last commit both histories have, which "merge now" goes from. */
    readonly base?: string;
  };
  /**
   * The last merge of changes on GitHub into the project: when, the commit, how many files, and
   * where people see that commit.
   */
  readonly merge?: {
    readonly at: number;
    readonly sha: string;
    readonly files: number;
    /** Where people see the commit: only on GitHub. */
    readonly url?: string;
  };
  /** Conflicts with GitHub that wait for people, see `RepositoryService.conflicts`. */
  readonly conflicts?: number;
  /** Files on GitHub that the merge did not take in: which, why, and what was wrong. */
  readonly blocked?: readonly {
    readonly path: string;
    readonly reason: string;
    readonly detail?: string;
  }[];
  /**
   * Which side a merge keeps first where both changed the same place (`project_repos.prefer`),
   * which people change in the project's properties, see `setPrefer`.
   */
  readonly prefer?: MergePrefer;
  /** The update of the project the platform has, and the one the repository has. */
  readonly head: number;
  readonly archivedSeq: number;
  /**
   * Whether the platform has the working copy (`CopyState`), which one it is, and why making it
   * again from the repository failed the last time (`copyProblem`, see `CopyProblem`).
   */
  readonly copy: CopyState;
  readonly generation: number;
  readonly copyProblem?: CopyProblem;
  /**
   * Where the copy before this one was when the platform let go of it: which one it was, and the
   * update of it that the archive this one began as has (0: none it has in common, as that archive
   * was not there any more). What a window of that copy puts its changes onto this one by (the plan
   * of the redesign, 13.5).
   */
  readonly rebuiltFrom?: {
    readonly generation: number;
    readonly archivedSeq: number;
    /**
     * Whether this copy began as the archive at `archivedSeq`, which is then what a window of the
     * copy before has in common with it. False: it began as something else (that archive was not
     * there any more, or people asked for the branch as it is), and there is nothing in common.
     */
    readonly commonBase: boolean;
  };
}

/** A repository restored as a project of the platform, see `RepositoryService.restore`. */
export interface Restored {
  readonly project: ProjectName;
  /** "live": there to open; "restoring": still being read, see the list for when it is. */
  readonly copy: "live" | "restoring";
}

export interface RepositoryServiceOptions {
  /**
   * Who may do what with which project, see access.ts: only the owner unless said. The routes ask
   * it of each project they name; here it says which project a repository is saved to.
   */
  readonly access?: AccessPolicy | undefined;
  readonly db: Db;
  /** The App's side, for checking a repository on GitHub as an archive will find it. */
  readonly host: RepoHost<GitHubPlace> | undefined;
  /** People's repositories on GitHub, as their tokens see them: undefined where there is no GitHub. */
  readonly people: GitHubPersonRepos | undefined;
  /**
   * The repositories of the server's own (archive/local/), where it keeps those: for the command
   * that clones one, starting archiving over, and restoring one.
   */
  readonly local?: LocalGitRepoHost | undefined;
  /** A working token of a person, see auth/tokens.ts. */
  readonly tokenFor: ((userId: string, options?: TokenOptions) => Promise<string>) | undefined;
  readonly enqueue: (job: ArchiveJob) => Promise<void>;
  /** Where what goes wrong after an answer is logged. */
  readonly log?: Logger | undefined;
  /** The App, to ask which installation an account has now, see `recheckLink`. */
  readonly app?: Pick<GitHubApp, "installationOf"> | undefined;
  readonly isQueued: (project: string) => Promise<boolean>;
  /** github.com, or a GitHub of a company. */
  readonly webUrl: string;
  /**
   * Has the worker make the working copy of a project from its repository, see archive/rebuild.ts.
   * Undefined where nothing does: nothing is restored.
   */
  readonly rebuild?: ((projectId: string) => Promise<void>) | undefined;
  /** Projects of one person: `SYNC_HUB_LIMITS.projectsPerUser` unless said. */
  readonly projectsPerUser?: number;
  /** How long restoring waits for the worker before it answers that it goes on: about a minute. */
  readonly restoreWaitMs?: number;
  readonly now?: () => Date;
  /**
   * Since when projects whose repository cannot be used are taken away, see `deleteAtOf`: none
   * unless said.
   */
  readonly deletesFrom?: string | undefined;
}

/**
 * A project is held for linking a repository to it this long at most, see `RepositoryService.link`:
 * longer than all GitHub is asked for that can take, each request of which has its time.
 */
export const LINKING_MS = 10 * 60_000;
/** Linking answers within this, before the editor gives up on it: the work goes on after. */
const LINK_ANSWER_MS = 55_000;

/** How long restoring waits for the worker, and how often it looks meanwhile. */
const RESTORE_WAIT_MS = 50_000;
const RESTORE_LOOK_MS = 250;
/** An animaquill.json larger than this is no manifest: it is not read into the API. */
const MANIFEST_MOST_BYTES = 1024 * 1024;
/**
 * The space of the locks on people, for counting their projects while one is made: two restores at
 * once do not both find room for one more.
 */
const PERSON_LOCK = 0x61712d75; // "aq-u"

/** Where a refusal of making a project from a repository is said to people, see `restore`. */
const refusalOf = (problem: CopyProblem): RepositoryRefused => {
  switch (problem.code) {
    case "unreadable":
      return new RepositoryRefused("unreadable", 422, "unreadable", { files: problem.files ?? [] });
    case "notProject":
    case "identity":
      return new RepositoryRefused("noProject", 409);
    case "tooLarge":
      return new RepositoryRefused("tooLarge", 413, "tooLarge", {
        ...(problem.files && { files: problem.files }),
      });
    case "tooNew":
      return new RepositoryRefused("tooNew", 409);
    case "quota":
      return new RepositoryRefused("quota", 409);
    case "unusable":
      return new RepositoryRefused("notInstalled", 409);
    case "unavailable":
      return new RepositoryRefused("unavailable", 503);
  }
};

/** Work that did not end within its time, see `withinTime`. */
class TooLong extends Error {}
const withinTime = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TooLong()), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

/** A repository nobody looked at for this long is looked at as an editor asks, see `#lookSoon`. */
export const LOOK_SOON_MS = 5 * 60_000;

/** An id of a conflict, as the database makes them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What GitHub takes as the name of a repository. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** A repository found under the name people chose counts as one made a moment ago for this long. */
const JUST_MADE_MS = 10 * 60_000;
/** Repositories in a page of the list. */
const PAGE = 100;
/** What the person's token saw of a repository that is gone is asked again after this long... */
const SEEN_MS = 5 * 60_000;
/** ...and after this long where GitHub could not be asked. */
const SEEN_AGAIN_MS = 60_000;
/** Repositories that what was seen of is remembered for, at most. */
const SEEN_MOST = 1000;

/** Whether GitHub takes this as the name of a new repository. */
const isRepoName = (name: string) =>
  REPO_NAME.test(name) && name !== "." && name !== ".." && !/\.git$/i.test(name);

/** What a query failed for, as PostgreSQL says it, however drizzle passed it on. */
const codeOf = (error: unknown): unknown =>
  (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;

/** What changed on GitHub as the editor gets it: rows from before `deleted` was kept say none. */
const divergedOf = (diverged: Diverged) => ({
  sha: diverged.sha,
  files: diverged.files,
  deleted: diverged.deleted ?? [],
  // Which of them are pointers of large files of the platform's, not files of the project: with
  // `replace` (merges on) the archive writes them as the project has them, or takes them away.
  ...(diverged.merging && {
    pointers: diverged.files.filter((path) => path !== ".gitattributes" && !isProjectFile(path)),
  }),
  ...(diverged.base !== undefined && { base: diverged.base }),
});

/** A conflict with GitHub as the editor gets it, see `RepositoryService.conflicts`. */
export interface ConflictShown {
  readonly id: string;
  readonly file: string;
  readonly path: readonly string[];
  readonly label: string;
  readonly kind: string;
  readonly lines?: unknown;
  readonly around?: unknown;
  /** What the project has, and what went; missing where `large` says they are too large here. */
  readonly ours?: unknown;
  readonly theirs?: unknown;
  readonly large?: true;
  /** Whose side went: "batch", GitHub's; "change", the editor's. */
  readonly lost: string;
  /** "merge": found as the merge was made; "late": as a change made without it came. */
  readonly source: string;
  readonly oursBy?: string;
  readonly oursAt?: number;
  /** The commit of GitHub's it is of, and where people see it. */
  readonly theirsSha?: string;
  readonly theirsUrl?: string;
  readonly theirsAt?: number;
  /** "open", or what people chose ("ours", "theirs"), or "stale": that place changed again since. */
  readonly state: string;
  readonly at: number;
  readonly resolvedAt?: number;
}

/** Conflicts one list has at most, and the largest value a row of it has in place. */
const CONFLICTS_MOST = 500;
const CONFLICT_VALUE_MOST = 64 * 1024;
/** Conflicts one request settles at most. */
export const RESOLVE_MOST = 1000;

/** What a status says of the working copy of a project, see `RepositoryStatus.copy`. */
const copyOf = (project: {
  readonly copyState: CopyState;
  readonly generation: number;
  readonly copyProblem: CopyProblem | null;
  readonly releasedFrom: ReleasedFrom | null;
}) => ({
  copy: project.copyState,
  generation: project.generation,
  ...(project.copyProblem && { copyProblem: project.copyProblem }),
  // Only once this copy is the next one: before that, it is where this one went.
  ...(project.releasedFrom &&
    project.releasedFrom.generation < project.generation && {
      rebuiltFrom: {
        generation: project.releasedFrom.generation,
        archivedSeq: project.releasedFrom.archivedSeq,
        commonBase: project.releasedFrom.commonBase !== false,
      },
    }),
});

/**
 * What a person's own token sees of a repository: it as it is there, or that there is none for it
 * to see.
 */
type Seen = { readonly private: boolean; readonly ownerId: number } | "missing";

/** How the description of a repository the platform makes begins, whatever the project. */
const DESCRIPTION_START = "AnimaQuill 项目：";

/** Pauses whose `replace` can take files of `diverged.files` out of the project (`drop`). */
const DROPS_FOR: readonly PauseReason[] = ["rewritten", "unmerged", "too-large"];

export const descriptionOf = (projectName: string) =>
  `${DESCRIPTION_START}${projectName}`.slice(0, 350);

export class RepositoryService {
  readonly #options: RepositoryServiceOptions;
  readonly #now: () => Date;
  /**
   * What people's own tokens saw of repositories that are gone, see `#seenBy`, by project and
   * repository.
   */
  readonly #seen = new Map<string, { readonly at: number; readonly seen: Seen | undefined }>();

  /** See `RepositoryServiceOptions.deletesFrom`. */
  readonly #deletesFrom: string | undefined;

  constructor(options: RepositoryServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#deletesFrom = options.deletesFrom;
  }

  /** People's repositories on GitHub: "unavailable" where the server is not set up for GitHub. */
  get #people(): GitHubPersonRepos {
    const people = this.#options.people;
    if (!people) throw new RepositoryRefused("unavailable", 503);
    return people;
  }

  /** Runs `work` with the person's token, with a new one where GitHub turns the first down. */
  async #withToken<T>(userId: string, work: (token: string) => Promise<T>): Promise<T> {
    const tokenFor = this.#options.tokenFor;
    if (!tokenFor) throw new RepositoryRefused("unavailable", 503);
    try {
      const token = await tokenFor(userId);
      try {
        return await work(token);
      } catch (error) {
        if (!(error instanceof GitHubUnauthorized)) throw error;
        return await work(await tokenFor(userId, { rejected: token }));
      }
    } catch (error) {
      if (error instanceof SignInNeeded || error instanceof GitHubUnauthorized)
        throw new RepositoryRefused("signedOut", 401);
      if (error instanceof GitHubUnavailable) throw new RepositoryRefused("unavailable", 503);
      throw error;
    }
  }

  /** The installation on the person's own account, which saving to GitHub needs. */
  async #installation(user: SignedIn): Promise<number> {
    const [row] = await this.#options.db
      .select({ id: installations.id })
      .from(installations)
      .where(and(eq(installations.accountId, user.githubId), isNull(installations.suspendedAt)))
      .limit(1);
    if (!row) throw new RepositoryRefused("notInstalled", 409);
    return row.id;
  }

  /**
   * The project a route names, which asked whether the person may do this with it (access.ts):
   * here only whether it is there.
   */
  async #project(_user: SignedIn, projectId: string) {
    const [project] = await this.#options.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new RepositoryRefused("notFound", 404);
    return project;
  }

  /**
   * Where new projects are saved: to GitHub where the App is set up (people choose a repository),
   * else to repositories of the server's own, which the hub links each new project to.
   */
  get savesTo(): "github" | "local" | "none" {
    if (this.#options.host) return "github";
    return this.#options.local ? "local" : "none";
  }

  /** The policy of access the service goes by, which the routes have to go by too (app.ts). */
  get access(): AccessPolicy {
    return this.#options.access ?? OWNER_ONLY;
  }

  /** Whether the person may read a project, to name it as the one a repository is saved to. */
  #mayRead(user: SignedIn, project: { readonly id: string; readonly ownerId: string }) {
    return this.access.may(this.#options.db, user.userId, project, "read");
  }

  /** A page of the repositories the person's installation covers. */
  async list(user: SignedIn, page: number) {
    const installation = await this.#installation(user);
    const { total, repositories } = await this.#withToken(user.userId, (token) =>
      this.#people.ofInstallation(token, installation, page, PAGE),
    );
    const ids = repositories.map((repo) => repo.id);
    // The project each is saved to, and whose that is.
    const linked = new Map(
      ids.length === 0
        ? []
        : (
            await this.#options.db
              .select({
                repoId: projectRepos.repoId,
                id: projects.id,
                name: projects.name,
                ownerId: projects.ownerId,
              })
              .from(projectRepos)
              .innerJoin(projects, eq(projects.id, projectRepos.projectId))
              .where(onGitHub(ids))
          ).map((row) => [row.repoId, row] as const),
    );
    const readable = new Set<string>();
    for (const project of linked.values())
      if (await this.#mayRead(user, project)) readable.add(project.id);
    return {
      repositories: repositories.map((repo): ChoosableRepository => {
        const project = linked.get(repo.id);
        return {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          fullName: `${repo.owner}/${repo.name}`,
          private: repo.private,
          pushable: repo.pushable,
          empty: repo.size === 0,
          archived: repo.archived,
          linked: project !== undefined,
          ...(project !== undefined &&
            readable.has(project.id) && {
              linkedProject: { id: project.id, name: project.name },
            }),
        };
      }),
      page,
      more: page * PAGE < total,
      // Where people choose which repositories the App may touch.
      manageUrl: `${this.#options.webUrl}/settings/installations/${installation}`,
    };
  }

  /**
   * Whether a repository could take a project, without making or linking anything: for telling
   * people before they go on, as a project is linked once it is on the platform, which it need not
   * be yet. By the very rules `link` goes by, and in its codes; what is found is the answer, and
   * only what keeps the platform from looking is refused (signedOut, unavailable).
   *
   * A name for a new repository is free where the person's token sees none of it. It does not see
   * a private repository their installation does not cover: such a name looks free here, and
   * making the repository says it is taken. A name taken by what a try of the platform's made a
   * moment ago is free too, as linking takes that one: here by any project's description, as
   * which project asks is not known, and only where no project is saved to it.
   */
  async check(user: SignedIn, choice: RepositoryChoice): Promise<RepositoryCheck> {
    try {
      const installation = await this.#installation(user);
      if ("create" in choice) {
        const name = choice.create.name;
        if (!isRepoName(name)) throw new RepositoryRefused("invalidName", 400);
        const taken = await this.#withToken(user.userId, async (token) => {
          const there = await this.#people.byName(token, user.login, name);
          if (there === undefined) return false;
          // One a project is saved to is not what a try left, however new and empty it is, as
          // before its first archive: linking would not take it either.
          if (await this.#linkedTo(there.id, user, undefined)) return true;
          return !(await this.#madeJustNow(token, there, undefined));
        });
        if (taken) throw new RepositoryRefused("nameTaken", 409);
      } else {
        await this.#existing(
          user,
          installation,
          undefined,
          choice.existing.id,
          choice.confirmPublic === true,
        );
      }
      return { ok: true };
    } catch (error) {
      if (!(error instanceof RepositoryRefused)) throw error;
      const reason = CHECK_REASONS.find((known) => known === error.code);
      if (reason === undefined) throw error;
      const { files, project } = (error.extra ?? {}) as {
        files?: readonly string[];
        project?: ProjectName;
      };
      return { ok: false, reason, ...(files && { files }), ...(project && { project }) };
    }
  }

  /**
   * Links a project to a repository: a new private one, or one people have. Then the first archive
   * is queued. The same repository again is fine. Another one in place of the one it has ("换一个仓库"):
   * while archiving is paused, as when the old one is gone, or, while it goes as it should, only
   * where people say so (`switch`). What was archived stays in the old repository, which the
   * platform does not touch again.
   */
  async link(
    user: SignedIn,
    projectId: string,
    choice: RepositoryChoice & { readonly switch?: boolean },
  ): Promise<RepositoryStatus> {
    const project = await this.#project(user, projectId);
    const installation = await this.#installation(user);
    const current = await linkOf(this.#options.db, projectId);
    if ("existing" in choice && current?.repoId === choice.existing.id)
      return this.status(user, projectId);
    const inPlace = current?.state === "ready" && choice.switch !== true;
    if ("create" in choice) {
      const name = choice.create.name;
      if (!isRepoName(name)) throw new RepositoryRefused("invalidName", 400);
      // The same request again, as after an answer that did not come back: only while archiving
      // goes as it should and nobody says to take another repository. Otherwise GitHub is asked:
      // a repository of that name that is still this one gives the same answer (see `#create`),
      // and where this one is gone, as deleted there, a new one of its name is made in its place,
      // which is the name the editor proposes.
      if (inPlace && current?.createdHere && current.name.toLowerCase() === name.toLowerCase())
        return this.status(user, projectId);
    }
    if (inPlace) throw new RepositoryRefused("alreadyLinked", 409);

    // The project is held from before anything is made on GitHub until the repository is linked
    // (`linking_until`), in a short transaction each, nothing held while GitHub answers: taking it
    // away meanwhile finds it has a repository ("hasRepository"), which the editor keeps, and a
    // second link waits ("busy"). Otherwise a repository made for a project that went while GitHub
    // made it would be left there, empty, for nobody. A hold that nothing lets go of, as of a process
    // that died, is over after `LINKING_MS`.
    const until = await this.#hold(user, projectId);
    let repo: PersonRepo | undefined;
    const work = (async (): Promise<void> => {
      try {
        let createdHere: boolean;
        if ("create" in choice) {
          repo = await this.#create(user, current, choice.create.name, descriptionOf(project.name));
          // The same request again, as one whose answer did not come back: linked already.
          if (current?.repoId === repo.id) return;
          createdHere = true;
        } else {
          repo = await this.#existing(
            user,
            installation,
            projectId,
            choice.existing.id,
            choice.confirmPublic === true,
          );
          createdHere = false;
        }
        const made = repo;
        await this.#options.db.transaction(async (tx) => {
          await lockProject(tx, projectId);
          const [held] = await tx
            .select({ linkingUntil: projects.linkingUntil })
            .from(projects)
            .where(eq(projects.id, projectId))
            .for("update");
          // Only while it is still this request's: it cannot have gone meanwhile otherwise.
          if (held?.linkingUntil?.getTime() !== until.getTime()) {
            if (createdHere)
              this.#options.log?.warn(
                { project: projectId, repo: made.id },
                "a repository was made for a project that is not held for it any more",
              );
            throw held
              ? new RepositoryRefused("busy", 429, "busy", { retryAfter: 5 })
              : new RepositoryRefused("notFound", 404);
          }
          await this.#insert(tx, user, projectId, installation, made, createdHere);
          await tx.update(projects).set({ linkingUntil: null }).where(eq(projects.id, projectId));
        });
        await this.#options.enqueue({ project: projectId, kind: "first", by: user.userId });
      } finally {
        await this.#letGo(projectId, until).catch(() => {});
      }
    })();
    try {
      await withinTime(work, LINK_ANSWER_MS);
    } catch (error) {
      if (error instanceof TooLong) {
        // GitHub takes its time: the editor hears it is not done, and the work goes on, linking
        // whatever GitHub made. Asked again, it finds it linked, or held a little longer ("busy").
        void work.catch((late: unknown) => {
          this.#options.log?.warn(
            { err: describeError(late), project: projectId },
            "linking a repository failed after its request was answered",
          );
        });
        throw new RepositoryRefused("unavailable", 503, "GitHub takes its time");
      }
      if (error instanceof RepositoryRefused) throw error;
      const code = codeOf(error);
      // The project went meanwhile, as deleted in another window: the row has nothing to be of.
      if (code === "23503") throw new RepositoryRefused("notFound", 404);
      if (code === "23505" && repo) {
        // The repository is another project's by now.
        const elsewhere = await this.#linkedTo(repo.id, user, projectId);
        if (elsewhere)
          throw new RepositoryRefused("linkedElsewhere", 409, "linkedElsewhere", {
            ...(elsewhere.project && { project: elsewhere.project }),
          });
        const now = await linkOf(this.#options.db, projectId);
        if (now?.provider === "github" && now.repoId === repo.id)
          return this.status(user, projectId);
        throw new RepositoryRefused("alreadyLinked", 409);
      }
      throw error;
    }
    return this.status(user, projectId);
  }

  /**
   * Holds the project for linking a repository to it, see `link`: one held by another request now
   * is "busy" until that is done. Resolves to until when it is held, which is what tells this hold.
   */
  async #hold(user: SignedIn, projectId: string): Promise<Date> {
    const now = this.#now();
    const until = new Date(now.getTime() + LINKING_MS);
    return this.#options.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      const [row] = await tx
        .select({ linkingUntil: projects.linkingUntil })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      if (!row) throw new RepositoryRefused("notFound", 404);
      if (row.linkingUntil !== null && row.linkingUntil > now)
        throw new RepositoryRefused("busy", 429, "busy", {
          retryAfter: Math.min(60, Math.ceil((row.linkingUntil.getTime() - now.getTime()) / 1000)),
        });
      await tx.update(projects).set({ linkingUntil: until }).where(eq(projects.id, projectId));
      return until;
    });
  }

  /** Lets go of the project as `#hold` held it, unless something else holds it by now. */
  async #letGo(projectId: string, until: Date): Promise<void> {
    await this.#options.db
      .update(projects)
      .set({ linkingUntil: null })
      .where(and(eq(projects.id, projectId), eq(projects.linkingUntil, until)));
  }

  /**
   * The project is saved to `repo` from now on, in place of whatever it had: the history stays
   * there. A repository that could not be used is behind it with that, and the hub hears so.
   */
  async #insert(
    tx: Tx,
    user: SignedIn,
    projectId: string,
    installation: number,
    repo: PersonRepo,
    createdHere: boolean,
  ): Promise<void> {
    await tx.delete(projectRepos).where(eq(projectRepos.projectId, projectId));
    await tx.insert(projectRepos).values({
      projectId,
      installationId: installation,
      repoId: repo.id,
      ownerId: repo.ownerId,
      ownerLogin: repo.owner,
      name: repo.name,
      branch: repo.branch,
      private: repo.private,
      createdHere,
      linkedBy: user.userId,
      linkedAt: this.#now(),
      // As GitHub just said it.
      checkedAt: this.#now(),
      // The first archive is asked for: whatever job of the project runs next does it.
      requestedAt: this.#now(),
      requestedBy: user.userId,
    });
    await notifyLink(tx, [projectId]);
  }

  /**
   * Whether a repository is saved to by a project other than `except`, and which one, where that
   * is one the person may read: another is said to be there, and nothing more.
   */
  async #linkedTo(
    repoId: number,
    user: SignedIn,
    except: string | undefined,
  ): Promise<{ readonly project?: ProjectName } | undefined> {
    const [row] = await this.#options.db
      .select({ id: projects.id, name: projects.name, ownerId: projects.ownerId })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(onGitHub(repoId));
    if (!row || row.id === except) return undefined;
    return (await this.#mayRead(user, row)) ? { project: { id: row.id, name: row.name } } : {};
  }

  /**
   * Whether a repository found under a name people chose is one a try of the platform's made a
   * moment ago, whose answer did not come back: private, with the description the platform gives
   * (the project's where that is known, of any project otherwise), made in the last ten minutes,
   * and empty.
   */
  async #madeJustNow(
    token: string,
    there: PersonRepo,
    description: string | undefined,
  ): Promise<boolean> {
    return (
      there.private &&
      (description === undefined
        ? there.description?.startsWith(DESCRIPTION_START) === true
        : there.description === description) &&
      there.createdAt !== undefined &&
      this.#now().getTime() - there.createdAt < JUST_MADE_MS &&
      (await this.#people.isEmpty(token, there))
    );
  }

  /**
   * A new private repository. A name taken by now is fine only where it is the one a try a moment
   * ago made, which a network that failed on the way back leaves: empty, private, made in the last
   * ten minutes, with our description.
   */
  async #create(
    user: SignedIn,
    current: Link | undefined,
    name: string,
    description: string,
  ): Promise<PersonRepo> {
    return this.#withToken(user.userId, async (token) => {
      let made: Awaited<ReturnType<GitHubPersonRepos["create"]>>;
      try {
        made = await this.#people.create(token, { name, description });
      } catch (error) {
        // The answer did not come back: the repository may be there all the same.
        if (!(error instanceof GitHubUnavailable) || error.retryAfterMs !== undefined) throw error;
        made = await this.#people.create(token, { name, description });
      }
      if (made.kind === "made") return made.repo;
      if (made.kind === "refused") {
        if (made.status === 403) throw new RepositoryRefused("notInstalled", 409);
        throw new RepositoryRefused("unavailable", 503, made.message);
      }
      const there = await this.#people.byName(token, user.login, name);
      if (there && there.id === current?.repoId) return there;
      if (!there || !(await this.#madeJustNow(token, there, description)))
        throw new RepositoryRefused("nameTaken", 409);
      return there;
    });
  }

  /**
   * A repository people have, if it is one an archive can go into: for the project that is being
   * linked, or, with none, for any (`check`).
   */
  async #existing(
    user: SignedIn,
    installation: number,
    projectId: string | undefined,
    id: number,
    confirmPublic: boolean,
  ): Promise<PersonRepo> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new RepositoryRefused("notFound", 404);
    const repo = await this.#withToken(user.userId, (token) => this.#people.byId(token, id));
    // Only the person's own account: organizations come later.
    if (!repo || repo.ownerType !== "User" || repo.ownerId !== user.githubId)
      throw new RepositoryRefused("notFound", 404);
    if (!repo.pushable || repo.archived) throw new RepositoryRefused("notPushable", 409);
    if (!repo.private && !confirmPublic) throw new RepositoryRefused("public", 409);
    const elsewhere = await this.#linkedTo(id, user, projectId);
    if (elsewhere)
      throw new RepositoryRefused("linkedElsewhere", 409, "linkedElsewhere", {
        ...(elsewhere.project && { project: elsewhere.project }),
      });
    const host = this.#options.host;
    if (!host) throw new RepositoryRefused("unavailable", 503);
    // As an archive will find it, with the App's token for it.
    try {
      const session = host.open({ provider: "github", installationId: installation, repoId: id });
      const info = await session.info();
      const tip = await session.tip(info.branch);
      if (tip !== undefined) {
        const commit = await session.commit(tip);
        const top = commit ? await session.tree(commit.tree) : [];
        const project = top
          .filter((entry) =>
            entry.type === "tree" ? isProjectFolder(entry.path) : isProjectFile(entry.path),
          )
          .map((entry) => entry.path);
        // A project there, or files where a project's go, which archives would write over.
        if (project.length > 0)
          throw new RepositoryRefused("hasProject", 409, "hasProject", {
            files: project.toSorted().slice(0, 20),
          });
      }
    } catch (error) {
      if (error instanceof RepoPaused) throw new RepositoryRefused("notInstalled", 409);
      if (error instanceof GitHubUnavailable) throw new RepositoryRefused("unavailable", 503);
      throw error;
    }
    return repo;
  }

  /**
   * Restores a repository as a new project of the person's: one of theirs that has a project at its
   * top, which "hasProject" turns away for linking, as after its project was deleted on the
   * platform, or the platform lost it. As for linking one they have: their own account, one they
   * may push to and that is not archived, a public one only where they said so, and none that a
   * project of the platform is saved to ("linkedElsewhere", with which, where it is theirs). It has
   * to have animaquill.json at its top ("noProject"), and the person room for another project
   * ("quota").
   *
   * A project is made for it, saved to it, without a working copy ("restoring"), and the worker
   * makes the copy from the last commit of its branch (archive/rebuild.ts), as it would one the
   * platform let go of: it is archived up to that commit. This waits for that, about a minute.
   * Where the repository does not make a project ("unreadable" with the documents that do not read,
   * "noProject", "tooLarge", "tooNew", "quota"), or the work failed ("unavailable"), the project
   * goes again, and that is what is said. Where it takes longer, it goes on, and the answer says
   * so ("restoring"): the list says once it is there, or that it could not be made
   * (`copyProblem`).
   */
  async restore(
    user: SignedIn,
    choice: { readonly existing: { readonly id: number }; readonly confirmPublic?: boolean },
  ): Promise<Restored> {
    const rebuild = this.#options.rebuild;
    const host = this.#options.host;
    if (!rebuild || !host) throw new RepositoryRefused("unavailable", 503);
    const installation = await this.#installation(user);
    const id = choice.existing.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new RepositoryRefused("notFound", 404);
    const repo = await this.#withToken(user.userId, (token) => this.#people.byId(token, id));
    if (!repo || repo.ownerType !== "User" || repo.ownerId !== user.githubId)
      throw new RepositoryRefused("notFound", 404);
    if (!repo.pushable || repo.archived) throw new RepositoryRefused("notPushable", 409);
    if (!repo.private && choice.confirmPublic !== true) throw new RepositoryRefused("public", 409);
    const elsewhere = await this.#linkedTo(id, user, undefined);
    if (elsewhere)
      throw new RepositoryRefused("linkedElsewhere", 409, "linkedElsewhere", {
        ...(elsewhere.project && { project: elsewhere.project }),
      });
    // What its animaquill.json says the project is, as the App will find it.
    let manifest: { readonly id: string; readonly name: string; readonly description: string };
    try {
      const session = host.open({ provider: "github", installationId: installation, repoId: id });
      const info = await session.info();
      const tip = await session.tip(info.branch);
      const commit = tip === undefined ? undefined : await session.commit(tip);
      const top = commit ? await session.tree(commit.tree) : [];
      const entry = top.find((each) => each.path === MANIFEST_FILE && each.type === "blob");
      if (!entry) throw new RepositoryRefused("noProject", 409);
      // Read into the API only as large as a manifest is.
      if (entry.size === undefined || entry.size > MANIFEST_MOST_BYTES)
        throw new RepositoryRefused("tooLarge", 413, "tooLarge", { files: [MANIFEST_FILE] });
      const text = Buffer.from(await session.blob(entry.sha)).toString("utf8");
      const said = (() => {
        try {
          return JSON.parse(text) as { id?: unknown; name?: unknown; description?: unknown };
        } catch {
          return undefined;
        }
      })();
      if (typeof said?.id !== "string" || !PROJECT_ID.test(said.id))
        throw new RepositoryRefused("unreadable", 422, "unreadable", { files: [MANIFEST_FILE] });
      manifest = {
        id: said.id,
        name: typeof said.name === "string" ? said.name.slice(0, 200) : repo.name,
        description:
          typeof said.description === "string"
            ? [...said.description].slice(0, DESCRIPTION_MOST).join("")
            : "",
      };
    } catch (error) {
      if (error instanceof RepositoryRefused) throw error;
      if (error instanceof RepoPaused) throw new RepositoryRefused("notInstalled", 409);
      if (error instanceof GitHubUnavailable) throw new RepositoryRefused("unavailable", 503);
      throw error;
    }
    const projectId = randomBytes(16).toString("base64url");
    const now = this.#now();
    const most = this.#options.projectsPerUser ?? SYNC_HUB_LIMITS.projectsPerUser;
    const wait = this.#options.restoreWaitMs ?? RESTORE_WAIT_MS;
    // Held while this waits for the answer: a restore that fails meanwhile stays, for this to say
    // why, and goes once nothing waits for it (see `Rebuilder`).
    const until = new Date(now.getTime() + wait + 30_000);
    try {
      await this.#options.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${PERSON_LOCK}, hashtext(${user.userId}))`,
        );
        await lockProject(tx, projectId);
        const [held] = await tx
          .select({ count: count() })
          .from(projects)
          .where(eq(projects.ownerId, user.userId));
        if ((held?.count ?? 0) >= most) throw new RepositoryRefused("quota", 409);
        await tx.insert(projects).values({
          id: projectId,
          ownerId: user.userId,
          projectId: manifest.id,
          name: manifest.name,
          description: manifest.description,
          copyState: "restoring",
          createdAt: now,
          updatedAt: now,
          openedAt: now,
          linkingUntil: until,
        });
        await notifyPerson(tx, [user.userId]);
        await tx.insert(projectRepos).values({
          projectId,
          installationId: installation,
          repoId: repo.id,
          ownerId: repo.ownerId,
          ownerLogin: repo.owner,
          name: repo.name,
          branch: repo.branch,
          private: repo.private,
          createdHere: false,
          linkedBy: user.userId,
          linkedAt: now,
          checkedAt: now,
        });
      });
    } catch (error) {
      if (error instanceof RepositoryRefused) throw error;
      if (codeOf(error) === "23505") {
        // Another project took the repository meanwhile, as the same request twice.
        const taken = await this.#linkedTo(id, user, undefined);
        throw new RepositoryRefused("linkedElsewhere", 409, "linkedElsewhere", {
          ...(taken?.project && { project: taken.project }),
        });
      }
      throw error;
    }
    this.#options.log?.info({ project: projectId, repo: repo.id }, "a repository is restored");
    try {
      await rebuild(projectId);
    } catch (error) {
      await this.#forget(projectId);
      throw error;
    }
    const deadline = Date.now() + wait;
    const project = { id: projectId, name: manifest.name };
    try {
      for (;;) {
        const [row] = await this.#options.db
          .select({ copyState: projects.copyState, copyProblem: projects.copyProblem })
          .from(projects)
          .where(eq(projects.id, projectId));
        if (!row) throw new RepositoryRefused("notFound", 404);
        if (row.copyState === "live") return { project, copy: "live" };
        if (row.copyState === "released") {
          // Nothing was made of it: the project goes again, and why is what people hear.
          await this.#forget(projectId);
          throw refusalOf(row.copyProblem ?? { code: "unavailable", at: Date.now() });
        }
        if (Date.now() >= deadline) return { project, copy: "restoring" };
        await new Promise((resolve) => setTimeout(resolve, RESTORE_LOOK_MS));
      }
    } finally {
      // Nothing waits for it any more: one that fails from now on goes at once.
      await this.#options.db
        .update(projects)
        .set({ linkingUntil: null })
        .where(and(eq(projects.id, projectId), eq(projects.linkingUntil, until)))
        .catch(() => {});
    }
  }

  /**
   * Takes away a project that restoring made, while nothing was made of it: never one that has a
   * working copy, or had one.
   */
  async #forget(projectId: string): Promise<void> {
    await this.#options.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      await tx
        .delete(projects)
        .where(
          and(
            eq(projects.id, projectId),
            inArray(projects.copyState, ["released", "restoring"]),
            isNull(projects.releasedFrom),
            eq(projects.head, 0),
          ),
        );
    });
  }

  /**
   * The repository of a project, and how archiving goes. For a repository that is gone it says
   * which of the two that is, as far as anything tells (`gone`), see `#goneAs`.
   */
  async status(user: SignedIn, projectId: string): Promise<RepositoryStatus> {
    const project = await this.#project(user, projectId);
    const link = await linkOf(this.#options.db, projectId);
    const waiting = {
      ...(project.dirtySince && { dirtySince: project.dirtySince.getTime() }),
    };
    const copy = copyOf(project);
    if (!link)
      return {
        state: "none",
        archiving: false,
        ...waiting,
        head: project.head,
        archivedSeq: 0,
        ...copy,
      };
    await this.#lookSoon(link);
    const [last] = await this.#options.db
      .select()
      .from(archives)
      .where(
        and(
          eq(archives.projectId, projectId),
          eq(archives.provider, link.provider),
          eq(archives.repoId, link.repoId),
        ),
      )
      .orderBy(desc(archives.createdAt), desc(archives.seq))
      .limit(1);
    const web = this.#options.webUrl;
    const repoUrl =
      link.provider === "github" ? `${web}/${link.ownerLogin}/${link.name}` : undefined;
    const gone =
      link.provider === "github" && link.state === "paused" && link.pauseReason === "gone"
        ? await this.#goneAs(user, link)
        : undefined;
    const local = this.#options.local;
    const next =
      link.state === "ready"
        ? dueAt(project.updatedAt, project.dirtySince, link.nextAttemptAt)
        : undefined;
    const unusable = unusableReasonOf(link);
    return {
      repository: {
        place: link.provider,
        id: link.repoId,
        owner: link.ownerLogin,
        name: link.name,
        fullName: `${link.ownerLogin}/${link.name}`,
        private: link.private,
        branch: link.branch,
        ...(repoUrl !== undefined && { url: repoUrl }),
        createdHere: link.createdHere,
        linkedAt: link.linkedAt.getTime(),
        ...(link.provider === "local" &&
          local &&
          link.localDir !== null && { clone: local.pathOf({ dir: link.localDir }) }),
      },
      state: link.state === "paused" ? "paused" : "ready",
      ...(link.pauseReason && { reason: link.pauseReason }),
      ...(gone && { gone }),
      ...(unusable !== undefined && {
        unusable: {
          reason: unusable,
          since: link.unusableSince!.getTime(),
          ...(deleteAtOf(link.unusableSince!, this.#deletesFrom) && {
            deleteAt: deleteAtOf(link.unusableSince!, this.#deletesFrom)!.getTime(),
          }),
          // As the list says it too.
          ...(unusable === "gone" && gone && { gone }),
        },
      }),
      ...(link.detail && { detail: link.detail }),
      ...(link.transientSince && link.detail === "diskFull" && { failure: "diskFull" as const }),
      archiving: link.requestedAt !== null || (await this.#options.isQueued(projectId)),
      ...(last && {
        lastArchive: {
          sha: last.sha,
          seq: last.seq,
          at: last.createdAt.getTime(),
          kind: last.kind,
          changed: last.changed,
          removed: last.removed,
          ...(repoUrl !== undefined && { url: `${repoUrl}/commit/${last.sha}` }),
        },
        ...(last.kept.length > 0 && { kept: last.kept }),
      }),
      ...waiting,
      ...(next && { nextAt: next.getTime() }),
      ...(link.failures > 0 &&
        link.nextAttemptAt && { retryAt: link.nextAttemptAt.getTime(), failures: link.failures }),
      ...(link.transientSince && { failingSince: link.transientSince.getTime() }),
      ...(link.diverged && { diverged: divergedOf(link.diverged) }),
      ...(await this.#mergeOf(link, repoUrl)),
      prefer: link.prefer,
      head: project.head,
      archivedSeq: link.archivedSeq,
      ...copy,
    };
  }

  /**
   * While merges are on, an editor that asks how archiving goes has the repository looked at where
   * nobody did for `LOOK_SOON_MS`: what a webhook that got lost would have said is found within
   * minutes. Nothing that goes wrong here keeps the status.
   */
  async #lookSoon(link: Link): Promise<void> {
    const looks =
      link.state === "ready" ||
      (link.pauseReason !== null && LOOKED_WHILE_PAUSED.includes(link.pauseReason));
    const at = link.checkedAt?.getTime();
    if (!looks || (at !== undefined && this.#now().getTime() - at < LOOK_SOON_MS)) return;
    try {
      // A repository of the server's own always merges: the switch is about GitHub.
      if (
        link.provider === "github" &&
        !(await readSetting(this.#options.db, REPO_MERGE_SETTING)).enabled
      )
        return;
      if (await this.#options.isQueued(link.projectId)) return;
      await this.#options.enqueue({ project: link.projectId, kind: "check" });
    } catch (error) {
      this.#options.log?.warn(
        { err: describeError(error), project: link.projectId },
        "the repository is not looked at now",
      );
    }
  }

  /** What a status says of merges, see `RepositoryStatus.merge`. */
  async #mergeOf(link: Link, repoUrl: string | undefined) {
    const db = this.#options.db;
    const [last] = await db
      .select({
        toSha: repoMerges.toSha,
        appliedAt: repoMerges.appliedAt,
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
      .orderBy(desc(repoMerges.appliedAt))
      .limit(1);
    const [open] = await db
      .select({ count: count() })
      .from(repoConflicts)
      .where(and(eq(repoConflicts.projectId, link.projectId), eq(repoConflicts.state, "open")));
    return {
      ...(last?.appliedAt && {
        merge: {
          at: last.appliedAt.getTime(),
          sha: last.toSha,
          files: last.result?.files?.length ?? 0,
          ...(repoUrl !== undefined && { url: `${repoUrl}/commit/${last.toSha}` }),
        },
      }),
      conflicts: open?.count ?? 0,
      blocked: link.blocked.map(({ path, reason, detail }) => ({
        path,
        reason,
        ...(detail !== undefined && { detail }),
      })),
    };
  }

  /**
   * The conflicts of a project with GitHub, those that wait first, then the newest:
   * `CONFLICTS_MOST` at most. A value too large to be in the list (`CONFLICT_VALUE_MOST`) is had
   * with `conflict`.
   */
  async conflicts(user: SignedIn, projectId: string): Promise<{ conflicts: ConflictShown[] }> {
    await this.#project(user, projectId);
    const link = await linkOf(this.#options.db, projectId);
    const rows = await this.#options.db
      .select()
      .from(repoConflicts)
      .where(eq(repoConflicts.projectId, projectId))
      .orderBy(
        sql`case when ${repoConflicts.state} = 'open' then 0 else 1 end`,
        desc(repoConflicts.createdAt),
        asc(repoConflicts.id),
      )
      .limit(CONFLICTS_MOST);
    return { conflicts: rows.map((row) => this.#shown(row, link, true)) };
  }

  /** One conflict, with its values however large. */
  async conflict(user: SignedIn, projectId: string, id: string): Promise<ConflictShown> {
    await this.#project(user, projectId);
    if (!UUID.test(id)) throw new RepositoryRefused("notFound", 404);
    const [row] = await this.#options.db
      .select()
      .from(repoConflicts)
      .where(and(eq(repoConflicts.projectId, projectId), eq(repoConflicts.id, id)));
    if (!row) throw new RepositoryRefused("notFound", 404);
    return this.#shown(row, await linkOf(this.#options.db, projectId), false);
  }

  #shown(
    row: typeof repoConflicts.$inferSelect,
    link: Link | undefined,
    cut: boolean,
  ): ConflictShown {
    const sizeOf = (value: unknown) =>
      value === null || value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
    const large =
      cut && sizeOf(row.ours) + sizeOf(row.theirs) + sizeOf(row.lines) > CONFLICT_VALUE_MOST;
    const repoUrl =
      link?.provider === "github" && `${this.#options.webUrl}/${link.ownerLogin}/${link.name}`;
    return {
      id: row.id,
      file: row.file,
      path: row.path,
      label: row.label,
      kind: row.kind,
      ...(large
        ? { large: true as const }
        : {
            ...(row.lines !== null && { lines: row.lines }),
            ...(row.ours !== null && { ours: row.ours }),
            ...(row.theirs !== null && { theirs: row.theirs }),
          }),
      ...(row.around !== null && !large && { around: row.around }),
      lost: row.lost,
      source: row.source,
      ...(row.oursBy !== null && { oursBy: row.oursBy }),
      ...(row.oursAt !== null && { oursAt: row.oursAt.getTime() }),
      ...(row.theirsSha !== null && {
        theirsSha: row.theirsSha,
        ...(repoUrl && { theirsUrl: `${repoUrl}/commit/${row.theirsSha}` }),
      }),
      ...(row.theirsAt !== null && { theirsAt: row.theirsAt.getTime() }),
      state: row.state,
      at: row.createdAt.getTime(),
      ...(row.resolvedAt !== null && { resolvedAt: row.resolvedAt.getTime() }),
    };
  }

  /**
   * People chose for conflicts (A3): "ours", what the project has stays; "theirs", the editor took
   * GitHub's side with `conflict.take` already, which `seq` is the update of, where it says: the
   * platform has to have it first ("behind" otherwise), so that the archive that follows has it.
   * Only open ones change. Once nothing waits, archiving goes on, and an archive is queued.
   */
  async resolveConflicts(
    user: SignedIn,
    projectId: string,
    choice: {
      readonly ids: readonly string[];
      readonly keep: "ours" | "theirs";
      readonly seq?: number;
    },
  ): Promise<{ resolved: number; status: RepositoryStatus }> {
    const project = await this.#project(user, projectId);
    if (
      choice.ids.length === 0 ||
      choice.ids.length > RESOLVE_MOST ||
      !choice.ids.every((id) => UUID.test(id))
    )
      throw new RepositoryRefused("invalid", 400);
    if (choice.seq !== undefined && project.head < choice.seq)
      throw new RepositoryRefused("behind", 409, "behind", { head: project.head });
    const now = this.#now();
    const { resolved, settled } = await this.#options.db.transaction(async (tx) => {
      const rows = await tx
        .update(repoConflicts)
        .set({ state: choice.keep, resolvedBy: user.userId, resolvedAt: now })
        .where(
          and(
            eq(repoConflicts.projectId, projectId),
            eq(repoConflicts.state, "open"),
            inArray(repoConflicts.id, [...choice.ids]),
          ),
        )
        .returning({ id: repoConflicts.id });
      return { resolved: rows.length, settled: await settleMergePause(tx, projectId, now) };
    });
    if (settled === "ready" && resolved > 0)
      await this.#options.enqueue({ project: projectId, kind: "auto" });
    return { resolved, status: await this.status(user, projectId) };
  }

  /**
   * "用编辑器的版本覆盖" a file on GitHub that the merge did not take in (A4): it waits no more, and
   * the next archive writes the project's version over it, or takes it away where the project has
   * none. Once nothing waits, archiving goes on.
   */
  async useEditorFor(user: SignedIn, projectId: string, path: string): Promise<RepositoryStatus> {
    await this.#project(user, projectId);
    const now = this.#now();
    const settled = await this.#options.db.transaction(async (tx) => {
      const [link] = await tx
        .select({ blocked: projectRepos.blocked })
        .from(projectRepos)
        .where(eq(projectRepos.projectId, projectId))
        .for("update");
      if (!link) throw new RepositoryRefused("notLinked", 404);
      if (!link.blocked.some((file) => file.path === path))
        throw new RepositoryRefused("notBlocked", 409);
      const blocked: BlockedFile[] = link.blocked.filter((file) => file.path !== path);
      await tx.update(projectRepos).set({ blocked }).where(eq(projectRepos.projectId, projectId));
      return settleMergePause(tx, projectId, now);
    });
    if (settled === "ready") await this.#options.enqueue({ project: projectId, kind: "auto" });
    return this.status(user, projectId);
  }

  /**
   * "把 GitHub 上现在的版本并进来" where the history on GitHub was rewritten (A4): `sha` is the commit
   * people saw. The next merge goes from the last commit both histories have, and the archive after
   * it has GitHub's commit as its one parent, so that nothing taken away on GitHub comes back.
   */
  async mergeNow(user: SignedIn, projectId: string, sha: string): Promise<RepositoryStatus> {
    await this.#project(user, projectId);
    const link = await linkOf(this.#options.db, projectId);
    if (!link) throw new RepositoryRefused("notLinked", 404);
    if (link.state !== "paused" || link.pauseReason !== "rewritten")
      throw new RepositoryRefused("notRewritten", 409);
    if (link.diverged?.sha !== sha)
      throw new RepositoryRefused("diverged", 409, "diverged", {
        ...(link.diverged && { diverged: divergedOf(link.diverged) }),
      });
    const base = link.diverged.base;
    if (base === undefined) throw new RepositoryRefused("noCommonBase", 409);
    await this.#options.db
      .update(projectRepos)
      .set({
        state: "ready",
        pauseReason: null,
        detail: null,
        pausedAt: null,
        pausedSeq: null,
        diverged: null,
        mergeFrom: base,
        mergedSha: null,
      })
      .where(
        and(
          eq(projectRepos.projectId, projectId),
          eq(projectRepos.repoId, link.repoId),
          eq(projectRepos.state, "paused"),
        ),
      );
    // A merge from the history that was taken away, which the API has not done yet, never is.
    await this.#options.db
      .update(repoMerges)
      .set({ state: "superseded", input: null })
      .where(and(eq(repoMerges.projectId, projectId), eq(repoMerges.state, "ready")));
    await this.#options.enqueue({ project: projectId, kind: "auto" });
    return this.status(user, projectId);
  }

  /**
   * Which side merges keep first where both changed the same place: only people choose it, in the
   * project's properties. The hub reads it again at once (`SyncHub.linkChanged`, by the notice of
   * the link), also for changes that come late.
   */
  async setPrefer(
    user: SignedIn,
    projectId: string,
    prefer: MergePrefer,
  ): Promise<RepositoryStatus> {
    await this.#project(user, projectId);
    await this.#options.db.transaction(async (tx) => {
      const [changed] = await tx
        .update(projectRepos)
        .set({ prefer })
        .where(eq(projectRepos.projectId, projectId))
        .returning({ projectId: projectRepos.projectId });
      if (!changed) throw new RepositoryRefused("notLinked", 404);
      await notifyLink(tx, [projectId]);
    });
    return this.status(user, projectId);
  }

  /**
   * Archives now, also where archiving paused: it goes on, and the archive finds out whether what
   * paused it is still so. Files that changed on GitHub are written over only with `replace`, the
   * commit people saw them on (Q3 of the plan): the archive goes on top of it, never forced.
   */
  async archiveNow(
    user: SignedIn,
    projectId: string,
    replace?: string,
    /** Whether an archive may be queued now: undefined where it may, or seconds to wait. */
    wait: () => number | undefined = () => undefined,
    /**
     * With `replace`: files of what changed on GitHub (`diverged.files`) to take out of the project
     * before the archive, as GitHub took them away, see `project_repos.dropping`. Any other path is
     * refused ("invalid"): only what people were shown goes.
     */
    drop: readonly string[] = [],
  ): Promise<RepositoryStatus> {
    await this.#project(user, projectId);
    let link = await linkOf(this.#options.db, projectId);
    if (!link) throw new RepositoryRefused("notLinked", 404);
    // A repository that cannot be used is asked about first, as "check again" does: archiving goes
    // on only once GitHub says it can be used, which keeps when it was first found otherwise.
    if (link.unusableSince !== null) {
      const seconds = wait();
      if (seconds !== undefined)
        throw new RepositoryRefused("busy", 429, "busy", { retryAfter: seconds });
      if ((await this.#recheck(link)) !== "usable") return this.status(user, projectId);
      link = await linkOf(this.#options.db, projectId);
      if (!link) throw new RepositoryRefused("notLinked", 404);
      await this.#options.db
        .update(projectRepos)
        .set({ requestedAt: this.#now(), requestedBy: user.userId })
        .where(sameLink(link));
      await this.#options.enqueue({ project: projectId, kind: "manual", by: user.userId });
      return this.status(user, projectId);
    }
    const reason = link.state === "paused" ? link.pauseReason : null;
    // What waits for people of merges (conflicts, blocked files) is not gone past by archiving now,
    // as from an editor before merges: archiving goes on once they chose.
    const waits = reason !== null && MERGE_PAUSES.includes(reason);
    if (waits && replace === undefined) return this.status(user, projectId);
    // Anything else of GitHub's that the project would be written over: only with `replace`, the
    // commit people saw ("以编辑器的内容接着存").
    const diverged = reason !== null && REPLACEABLE.includes(reason);
    const seen = waits ? (link.mergedSha ?? link.headSha) : link.diverged?.sha;
    if (diverged && (replace === undefined || replace !== seen))
      throw new RepositoryRefused("diverged", 409, "diverged", {
        ...(link.diverged && { diverged: divergedOf(link.diverged) }),
      });
    if (drop.length > 0) {
      // Only where merges are on: an archive that does not merge never takes anything out.
      const takesOut = reason !== null && DROPS_FOR.includes(reason);
      // Only what GitHub took away: what it changed and still has is not for taking out.
      const deleted = new Set(link.diverged?.deleted ?? []);
      const listed = new Set(
        takesOut ? (link.diverged?.files ?? []).filter((path) => deleted.has(path)) : [],
      );
      if (!drop.every((path) => listed.has(path))) throw new RepositoryRefused("invalid", 400);
    }
    const seconds = wait();
    if (seconds !== undefined)
      throw new RepositoryRefused("busy", 429, "busy", { retryAfter: seconds });
    // Asked for, in the database first: whatever job of the project runs next does it, also where
    // the queue has one waiting already and drops this one, see `Archiver`.
    const same = sameLink(link);
    const asked = { requestedAt: this.#now(), requestedBy: user.userId };
    const goesOn = {
      state: "ready",
      pauseReason: null,
      detail: null,
      pausedAt: null,
      pausedSeq: null,
      diverged: null,
    } as const;
    if (diverged) {
      // On top of their commit, as the platform's own from now on; and as it has none of the
      // project's files as the platform has them, the archive writes all of them again. Whatever
      // of merges waited is over: the project's side stays everywhere ("全部用编辑器的").
      const now = this.#now();
      await this.#options.db.transaction(async (tx) => {
        const [taken] = await tx
          .update(projectRepos)
          .set({
            ...goesOn,
            ...asked,
            headSha: replace,
            replacedSha: replace,
            archivedSeq: 0,
            mergedSha: null,
            mergeFrom: null,
            blocked: [],
            dropping: drop.length > 0 ? [...new Set(drop)].toSorted() : null,
            droppingMerge: null,
            // `archived_seq` goes back to 0: no project from before a merge until now goes into
            // the history the next archive writes (E), as it can have what was taken away.
            mergeFloor: sql`greatest(coalesce(${projectRepos.mergeFloor}, 0), coalesce((select max(${repoMerges.seq}) from ${repoMerges} where ${repoMerges.projectId} = ${projectId}), 0))`,
          })
          .where(and(same, eq(projectRepos.state, "paused")))
          .returning({ projectId: projectRepos.projectId });
        if (!taken) return;
        await tx
          .update(repoConflicts)
          .set({ state: "ours", resolvedBy: user.userId, resolvedAt: now })
          .where(and(eq(repoConflicts.projectId, projectId), eq(repoConflicts.state, "open")));
        await tx
          .update(repoMerges)
          .set({ state: "superseded", input: null })
          .where(and(eq(repoMerges.projectId, projectId), eq(repoMerges.state, "ready")));
      });
    } else if (link.state === "paused") {
      // Whatever it paused for, the archive finds out whether that is still so. (One whose
      // repository cannot be used is asked about above.)
      await this.#options.db
        .update(projectRepos)
        .set({ ...goesOn, ...asked })
        .where(and(same, eq(projectRepos.state, "paused")));
    } else {
      await this.#options.db.update(projectRepos).set(asked).where(same);
    }
    await this.#options.enqueue({ project: projectId, kind: "manual", by: user.userId });
    return this.status(user, projectId);
  }

  /**
   * "Check again": for a repository that cannot be used, GitHub is asked now, with the App's token,
   * whether it can be used again, see `recheckLink`; the status says what it came to. Refused as
   * "unavailable" where GitHub could not be asked. For any other, an archive that only looks is
   * queued where archiving goes as it should. At most once a minute for a project (`wait`, as for
   * "archive now").
   */
  async recheck(
    user: SignedIn,
    projectId: string,
    wait: () => number | undefined = () => undefined,
  ): Promise<RepositoryStatus> {
    await this.#project(user, projectId);
    const link = await linkOf(this.#options.db, projectId);
    if (!link) throw new RepositoryRefused("notLinked", 404);
    const seconds = wait();
    if (seconds !== undefined)
      throw new RepositoryRefused("busy", 429, "busy", { retryAfter: seconds });
    if (link.unusableSince === null) {
      if (link.state === "ready")
        await this.#options.enqueue({ project: projectId, kind: "check" });
      return this.status(user, projectId);
    }
    await this.#recheck(link);
    return this.status(user, projectId);
  }

  /** Asks GitHub about a repository that cannot be used, see `recheckLink`. */
  async #recheck(link: Link): Promise<"usable" | "unusable"> {
    const host = this.#options.host;
    if (!host) throw new RepositoryRefused("unavailable", 503);
    const found = await recheckLink(this.#options.db, host, link, this.#now(), this.#options.app);
    if (found.kind === "unknown") throw new RepositoryRefused("unavailable", 503, found.detail);
    if (found.kind === "usable")
      await this.#options.enqueue({ project: link.projectId, kind: "check" });
    return found.kind;
  }

  /**
   * Has the repositories of these projects looked at again soon: each gets a check, which notes
   * the repository as it is now, see `Archiver`. For projects nobody edits, whose archives would
   * never look, see `listProjects`.
   */
  async lookAgain(projectIds: readonly string[]): Promise<void> {
    for (const project of projectIds) await this.#options.enqueue({ project, kind: "check" });
  }

  /**
   * Why a repository is not there to the App, as far as anything tells: deleted on GitHub, or
   * there, and taken out of what the App may touch. Both look the same to the App, and to
   * everything GitHub lets it ask.
   *
   * What a webhook said counts first (`gone_cause`). Without one, the person's own token is asked
   * about the repository, once in a while: it sees the repository, public, on the account it was
   * linked on, so it is there, and it is the App that may not touch it. Nothing else tells: a token
   * of the person's that sees nothing does not say it was deleted (it may be private and taken out,
   * or on another account now), so it is "not found", see `RepositoryStatus.gone`.
   */
  async #goneAs(user: SignedIn, link: Link): Promise<"deleted" | "unauthorized" | undefined> {
    if (link.goneCause === "deleted") return "deleted";
    if (link.goneCause === "removed") return "unauthorized";
    const seen = await this.#seenBy(user, link);
    if (seen === undefined || seen === "missing") return undefined;
    return !seen.private && seen.ownerId === link.ownerId ? "unauthorized" : undefined;
  }

  /**
   * Whether the person's own token sees a repository: asked once, and again after a while, as the
   * editor asks how archiving goes over and over. Undefined where GitHub could not be asked, or
   * they have to sign in again: that is no reason for how archiving goes not to be said.
   */
  async #seenBy(user: SignedIn, link: Link): Promise<Seen | undefined> {
    const key = `${link.projectId}:${link.repoId}`;
    const now = this.#now().getTime();
    const known = this.#seen.get(key);
    if (known && now - known.at < (known.seen === undefined ? SEEN_AGAIN_MS : SEEN_MS))
      return known.seen;
    let seen: Seen | undefined;
    try {
      const repo = await this.#withToken(user.userId, (token) =>
        this.#people.byId(token, link.repoId),
      );
      seen = repo ? { private: repo.private, ownerId: repo.ownerId } : "missing";
    } catch {
      seen = undefined;
    }
    if (this.#seen.size >= SEEN_MOST) this.#seen.clear();
    this.#seen.set(key, { at: now, seen });
    return seen;
  }
}
