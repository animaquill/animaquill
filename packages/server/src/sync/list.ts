import { OWNER_ONLY, type AccessPolicy } from "../access.ts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../database.ts";
import { deleteAtOf, unusableReasonOf } from "../archive/links.ts";
import {
  projectCovers,
  projectRepos,
  projects,
  type CopyProblem,
  type CopyState,
  type PauseReason,
  type ProjectStats,
} from "../schema.ts";

/**
 * The projects a person has on the platform, and the repository each is saved to: what the platform
 * keeps of them for good, and what people open one from on any computer.
 * One query of `projects` with `project_repos` and what
 * is known of their covers (not the pictures), by the owner: nothing of the working copies is read,
 * neither their updates nor their snapshots, and the hub is not asked, so that a list is there at
 * once however large the projects are, and also for one whose working copy is not here.
 *
 * What it says of a repository is what the platform last knew (`checkedAt`): GitHub is not asked
 * for a list. Repositories nobody looked at for a day are named (`stale`), for the route to have a
 * few of them looked at soon, so that the next list has them as they are now.
 */

/** What people have to do something about, of a project in the list. */
export type Attention =
  /** It is saved to no repository yet: one has to be chosen. */
  | "noRepository"
  /** Archiving into its repository paused, see `repository.reason`. */
  | "repository"
  /**
   * Its repository cannot be used, and so it cannot be edited, see `repository.unusable`.
   */
  | "unusable"
  /** Changes of the repository clash with the project's, and wait for people to choose. */
  | "conflicts"
  /** Files of the repository could not be taken in. */
  | "blocked";

/** A project as the list has it. Times are milliseconds since 1970. */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  /** What it says about itself, cut short (`DESCRIPTION_MOST`): the start page shows it on its card. */
  readonly description?: string;
  readonly createdAt: number;
  /** When it last changed. */
  readonly updatedAt: number;
  /** When a window that edits it last connected, on any computer (`opened_at`), where noted. */
  readonly openedAt?: number;
  /** Whether the platform has its working copy, see `CopyState`. */
  readonly copy: CopyState;
  /** When the platform let go of its working copy, while that is not here (`released_at`). */
  readonly releasedAt?: number;
  /**
   * Why making the working copy again from the repository failed the last time, see `CopyProblem`:
   * only while it is not here ("released").
   */
  readonly copyProblem?: CopyProblem;
  readonly size: {
    /** Bytes of its documents and code, as the platform keeps them (Yjs). */
    readonly documents: number;
    /** Its assets as the last archive counted them, once archives count. */
    readonly assets?: {
      readonly count: number;
      readonly bytes: number;
      readonly elsewhere: number;
    };
  };
  /** The repository it is saved to, as the platform last knew it. */
  readonly repository?: {
    readonly id: number;
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly private: boolean;
    /** Which provider it is on: missing for GitHub, as before there was another. */
    readonly place?: "local";
    /** Where people see it: only on GitHub. */
    readonly url?: string;
    readonly state: "ready" | "paused";
    /** Why archiving paused. */
    readonly reason?: string;
    /** When the platform last looked at it on GitHub. */
    readonly checkedAt?: number;
    /**
     * It cannot be used, and the project cannot be edited: why (the pause), since when the platform
     * found it so, and when the project goes unless it can be used again.
     */
    readonly unusable?: {
      readonly reason: PauseReason;
      readonly since: number;
      readonly deleteAt?: number;
      /**
       * For "gone", where GitHub said how (`gone_cause`): "deleted", or "unauthorized" for one
       * taken out of what the App may reach. Not asked of GitHub for a list.
       */
      readonly gone?: "deleted" | "unauthorized";
    };
  };
  /**
   * How far archiving got: when the last archive was, the update of the project the repository
   * has, and whether the platform has changes it does not have yet.
   */
  readonly archive?: {
    readonly at?: number;
    readonly seq: number;
    readonly behind: boolean;
    /** Since when archives fail for GitHub's or the platform's sake, see `transient_since`. */
    readonly failingSince?: number;
  };
  readonly attention?: Attention;
  /**
   * Its cover, see sync/covers.ts: what it is known by (`GET /api/projects/:id/cover` gives it),
   * when it was sent, and whether people chose it themselves. None until the editor sent one.
   */
  readonly cover?: { readonly etag: string; readonly at: number; readonly chosen?: true };
  /** How long its main timeline was when the cover was made, in milliseconds. */
  readonly durationMs?: number;
}

/** A repository is looked at again once nobody did for this long. */
export const STALE_MS = 24 * 3600_000;
/** Repositories of one list that are looked at again at most. */
export const STALE_MOST = 5;
/** Projects in a list at most: more than anyone may have, see `projectsPerUser`. */
const MOST = 500;

/**
 * What needs people, from the link of a project to its repository. A pause for "conflicts" or
 * "blocked" is one the merging of changes on GitHub makes, from its step on; until then no link
 * says either.
 */
export const attentionOf = (
  link:
    | { readonly state: string; readonly pauseReason: string | null; readonly unusable?: boolean }
    | undefined,
): Attention | undefined => {
  if (!link) return "noRepository";
  if (link.unusable === true) return "unusable";
  if (link.state !== "paused") return undefined;
  if (link.pauseReason === "conflicts" || link.pauseReason === "blocked") return link.pauseReason;
  return "repository";
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The assets an archive counted, as far as what is kept says so. */
const assetsOf = (stats: ProjectStats | null): ProjectSummary["size"]["assets"] => {
  const assets = stats?.assets;
  if (!assets || !isCount(assets.count) || !isCount(assets.bytes) || !isCount(assets.elsewhere))
    return undefined;
  return { count: assets.count, bytes: assets.bytes, elsewhere: assets.elsewhere };
};

/**
 * The projects of a person, most recently changed first, and those of them whose repositories are
 * due to be looked at again (`stale`, their ids): archiving goes as it should, the working copy is
 * here, nobody looked for a day, and no archive of theirs waits after failing. The one looked at
 * the longest ago first, and `STALE_MOST` of them at most.
 */
export const listProjects = async (
  db: Db,
  userId: string,
  options: {
    /** github.com, or a GitHub of a company: where people see a repository. */
    readonly webUrl: string;
    readonly now: number;
    /** Since when such projects are taken away, see `deleteAtOf`: none unless said. */
    readonly deletesFrom?: string | undefined;
    /** Which projects the person may read, see access.ts: their own unless said. */
    readonly access?: AccessPolicy | undefined;
  },
): Promise<{
  readonly projects: ProjectSummary[];
  readonly stale: string[];
  /** Those whose repository cannot be used, to have GitHub asked about soon, `STALE_MOST` at most. */
  readonly unusable: string[];
}> => {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      openedAt: projects.openedAt,
      releasedAt: projects.releasedAt,
      copyState: projects.copyState,
      copyProblem: projects.copyProblem,
      bytes: projects.bytes,
      stats: projects.stats,
      head: projects.head,
      repoId: projectRepos.repoId,
      provider: projectRepos.provider,
      ownerLogin: projectRepos.ownerLogin,
      repoName: projectRepos.name,
      private: projectRepos.private,
      state: projectRepos.state,
      pauseReason: projectRepos.pauseReason,
      checkedAt: projectRepos.checkedAt,
      unusableSince: projectRepos.unusableSince,
      goneCause: projectRepos.goneCause,
      archivedAt: projectRepos.archivedAt,
      archivedSeq: projectRepos.archivedSeq,
      nextAttemptAt: projectRepos.nextAttemptAt,
      transientSince: projectRepos.transientSince,
      coverEtag: projectCovers.etag,
      coverAt: projectCovers.updatedAt,
      coverChosen: projectCovers.chosen,
      durationMs: projectCovers.durationMs,
    })
    .from(projects)
    .leftJoin(projectRepos, eq(projectRepos.projectId, projects.id))
    .leftJoin(projectCovers, eq(projectCovers.projectId, projects.id))
    .where((options.access ?? OWNER_ONLY).visible(userId))
    .orderBy(desc(projects.updatedAt))
    .limit(MOST);

  const from = options.deletesFrom;
  const due: { readonly id: string; readonly checkedAt: number }[] = [];
  const cannot: string[] = [];
  const list = rows.map((row): ProjectSummary => {
    const assets = assetsOf(row.stats);
    const base = {
      id: row.id,
      name: row.name,
      ...(row.description !== "" && { description: row.description }),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      ...(row.openedAt && { openedAt: row.openedAt.getTime() }),
      copy: row.copyState,
      // Let go of, rather than restored from a repository as a new project.
      ...(row.copyState !== "live" && row.releasedAt && { releasedAt: row.releasedAt.getTime() }),
      ...(row.copyState !== "live" && row.copyProblem && { copyProblem: row.copyProblem }),
      size: { documents: row.bytes, ...(assets && { assets }) },
      ...(row.coverEtag !== null &&
        row.coverAt !== null && {
          cover: {
            etag: row.coverEtag,
            at: row.coverAt.getTime(),
            ...(row.coverChosen === true && { chosen: true as const }),
          },
        }),
      ...(row.durationMs !== null && { durationMs: row.durationMs }),
    };
    // No row of `project_repos`: every column of it is null, also those that never are in one.
    if (row.repoId === null || row.ownerLogin === null || row.repoName === null)
      return { ...base, attention: "noRepository" };
    const state = row.state === "paused" ? "paused" : "ready";
    const checkedAt = row.checkedAt?.getTime();
    // A look is an archive that only checks, which reads the working copy: one that is not here
    // waits until it is.
    if (
      state === "ready" &&
      row.copyState === "live" &&
      (checkedAt === undefined || options.now - checkedAt >= STALE_MS) &&
      (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= options.now)
    )
      due.push({ id: row.id, checkedAt: checkedAt ?? 0 });
    const archivedSeq = row.archivedSeq ?? 0;
    const unusable = unusableReasonOf({
      unusableSince: row.unusableSince,
      pauseReason: row.pauseReason,
    });
    if (unusable !== undefined) cannot.push(row.id);
    const attention = attentionOf({
      state,
      pauseReason: row.pauseReason,
      unusable: unusable !== undefined,
    });
    return {
      ...base,
      repository: {
        id: row.repoId,
        owner: row.ownerLogin,
        name: row.repoName,
        fullName: `${row.ownerLogin}/${row.repoName}`,
        private: row.private === true,
        ...(row.provider === "local"
          ? { place: "local" as const }
          : { url: `${options.webUrl}/${row.ownerLogin}/${row.repoName}` }),
        state,
        ...(state === "paused" && row.pauseReason && { reason: row.pauseReason }),
        ...(checkedAt !== undefined && { checkedAt }),
        ...(unusable !== undefined && {
          unusable: {
            reason: unusable,
            since: row.unusableSince!.getTime(),
            ...(deleteAtOf(row.unusableSince!, from) && {
              deleteAt: deleteAtOf(row.unusableSince!, from)!.getTime(),
            }),
            // How it is gone, only as far as GitHub said so: what people read on the card.
            ...(unusable === "gone" &&
              row.goneCause !== null && {
                gone: row.goneCause === "deleted" ? "deleted" : "unauthorized",
              }),
          },
        }),
      },
      archive: {
        ...(row.archivedAt && { at: row.archivedAt.getTime() }),
        seq: archivedSeq,
        behind: row.head > archivedSeq,
        ...(row.transientSince && { failingSince: row.transientSince.getTime() }),
      },
      ...(attention && { attention }),
    };
  });
  const stale = due
    .toSorted((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, STALE_MOST)
    .map(({ id }) => id);
  return { projects: list, stale, unusable: cannot.slice(0, STALE_MOST) };
};
