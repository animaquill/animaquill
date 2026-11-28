import type { CopyState, PauseReason } from "../schema.ts";

/**
 * Whether the working copy of a project can be let go of now, and why not (see
 * `SyncHub.release`): the one place that says so, for the hub as it lets go of it (in the
 * project's lock, on rows it holds) and for the list of what people keep on the platform
 * (`GET /api/me/storage`, on rows as they are, which only says what releasing would find). No
 * database here: what it needs is read by whoever asks, see `ReleaseFacts`.
 */

/** What of a project and its repository decides whether its copy can go. */
export interface ReleaseFacts {
  readonly copyState: CopyState;
  readonly head: number;
  readonly dirtySince: Date | null;
  readonly linkingUntil: Date | null;
  /** Its repository, as `project_repos` has it; undefined for none. */
  readonly link:
    | {
        readonly state: string;
        readonly pauseReason: PauseReason | null;
        readonly detail: string | null;
        readonly archivedSeq: number;
        readonly headSha: string | null;
        readonly requestedAt: Date | null;
        readonly failures: number;
        readonly transientSince: Date | null;
        readonly unusableSince: Date | null;
        readonly unusableSeenAt: Date | null;
        readonly pendingSha: string | null;
        readonly dropping: readonly string[] | null;
        readonly droppingMerge: string | null;
      }
    | undefined;
  /** Merges from GitHub that wait to go into the copy (`repo_merges`, "ready"). */
  readonly mergesReady: number;
  /** Conflicts with GitHub that wait for people (`repo_conflicts`, "open"). */
  readonly conflictsOpen: number;
  /**
   * Something else may change it yet: an archive of it runs (its lock is taken), or an AI task of
   * it has not ended. Not known to the list, which takes it for no.
   */
  readonly held: boolean;
}

/**
 * Why a copy is not let go of, see `SyncHub.release`: not "live" (let go of already, or being
 * made again); no repository, or one that cannot be used (`reason` the pause); something goes on
 * with it (`busy`); changes wait that only GitHub or the platform keep from being archived, or that
 * are not tried yet (`transient`); conflicts with GitHub wait for people; or the repository does
 * not have everything of it (`notArchived`, as archiving is paused, fails, or is behind).
 */
export type NotReleasable =
  | { readonly kind: "notLive" | "noRepository" | "busy" | "transient" }
  | { readonly kind: "unusable"; readonly reason?: PauseReason }
  | { readonly kind: "conflicts"; readonly count: number }
  | {
      readonly kind: "notArchived";
      readonly head: number;
      readonly archivedSeq: number;
      readonly state: string;
      readonly reason?: string;
      /** Archives that failed in a row, and what the last one said. */
      readonly failures?: number;
      readonly detail?: string;
      /** The repository has no archive of it at all. */
      readonly never?: true;
    };

/**
 * Undefined where the copy can go; otherwise why not, in the order the hub has always looked:
 * what it is, its repository, what goes on, what waits. With `unarchived` (an admin said to let go
 * of what the repository does not have), only that it is archived is not asked, nor are conflicts:
 * what is let go of then was said to go. A copy that was never archived never goes: there is
 * nothing to make it again from.
 */
export const whyNotReleasable = (
  facts: ReleaseFacts,
  now: Date,
  options: { readonly unarchived?: boolean } = {},
): NotReleasable | undefined => {
  const { link } = facts;
  if (facts.copyState !== "live") return { kind: "notLive" };
  if (!link) return { kind: "noRepository" };
  if (link.unusableSince !== null)
    return { kind: "unusable", ...(link.pauseReason !== null && { reason: link.pauseReason }) };
  // What it is cannot be told now: in a few minutes, or once the merge or the files went.
  if (link.unusableSeenAt !== null || link.dropping !== null || link.droppingMerge !== null)
    return { kind: "busy" };
  if (facts.mergesReady > 0) return { kind: "busy" };
  if ((facts.linkingUntil !== null && facts.linkingUntil > now) || link.pendingSha !== null)
    return { kind: "busy" };
  if (facts.held) return { kind: "busy" };
  const waiting = facts.dirtySince !== null || link.archivedSeq < facts.head;
  // Changes that wait for GitHub or the platform, or for their first try: never let go of.
  if (waiting && link.state === "ready" && (link.transientSince !== null || link.failures === 0))
    return { kind: "transient" };
  // What people still choose between: the side GitHub has would be what comes back.
  if (facts.conflictsOpen > 0 && options.unarchived !== true)
    return { kind: "conflicts", count: facts.conflictsOpen };
  const archived =
    link.state === "ready" &&
    !waiting &&
    link.requestedAt === null &&
    link.failures === 0 &&
    link.headSha !== null;
  const notArchived = (): NotReleasable => ({
    kind: "notArchived",
    head: facts.head,
    archivedSeq: link.archivedSeq,
    state: link.state,
    ...(link.pauseReason !== null && link.state === "paused" && { reason: link.pauseReason }),
    ...(link.failures > 0 && { failures: link.failures }),
    ...(link.detail !== null && { detail: link.detail }),
    ...(link.headSha === null && { never: true as const }),
  });
  if (!archived && options.unarchived !== true) return notArchived();
  // Never archived at all: there is nothing to make it again from.
  if (link.headSha === null) return notArchived();
  return undefined;
};

/**
 * Why a copy is not let go of, as people are told it (`why` of the list, and the error of `POST
 * /api/projects/:id/release`): its code, and what goes with it.
 *
 * - "noRepository": nothing to make it again from;
 * - "unusable" (`reason`): its repository cannot be used;
 * - "conflicts" (`count`): changes of GitHub clash with the project's, and wait for people;
 * - "paused" (`reason`, `detail?`): archiving into the repository paused;
 * - "failing" (`failures`, `detail?`): archives fail;
 * - "neverArchived": the repository has nothing of it yet;
 * - "pending": changes are not in the repository yet, and go there by themselves;
 * - "busy": an archive, a merge or a task goes on with it, a moment;
 * - "connected": a window has it open;
 * - "repository" (`reason`): the repository was looked at just now and could not give it back:
 *   "gone" (deleted, or the App may not touch it), "unauthorized", "transferred", "missing" (it
 *   does not have the last archive), "unreachable" (it could not be asked).
 */
export type ReleaseBlock =
  | { readonly code: "noRepository" | "neverArchived" | "pending" | "busy" | "connected" }
  | { readonly code: "unusable"; readonly reason?: string }
  | { readonly code: "conflicts"; readonly count: number }
  | { readonly code: "paused"; readonly reason?: string; readonly detail?: string }
  | { readonly code: "failing"; readonly failures: number; readonly detail?: string }
  | { readonly code: "repository"; readonly reason: RepositoryLook };

/** What looking at the repository right before letting go of a copy found, see `ReleaseBlock`. */
export type RepositoryLook = "gone" | "unauthorized" | "transferred" | "missing" | "unreachable";

/** Shorter than this, what archiving said goes with why: longer is the platform's to read. */
const DETAIL_MOST = 200;

const shortDetail = (detail: string | undefined) =>
  detail === undefined || detail === "" ? {} : { detail: detail.slice(0, DETAIL_MOST) };

/** What people are told of a copy that is not let go of, see `ReleaseBlock`. */
export const blockOf = (
  refusal: NotReleasable | { readonly kind: "connected" },
): ReleaseBlock | undefined => {
  switch (refusal.kind) {
    case "notLive":
      return undefined;
    case "noRepository":
    case "busy":
    case "connected":
      return { code: refusal.kind };
    case "transient":
      return { code: "pending" };
    case "unusable":
      return { code: "unusable", ...(refusal.reason !== undefined && { reason: refusal.reason }) };
    case "conflicts":
      return { code: "conflicts", count: refusal.count };
    case "notArchived":
      if (refusal.state === "paused")
        return {
          code: "paused",
          ...(refusal.reason !== undefined && { reason: refusal.reason }),
          ...shortDetail(refusal.detail),
        };
      if ((refusal.failures ?? 0) > 0)
        return { code: "failing", failures: refusal.failures ?? 0, ...shortDetail(refusal.detail) };
      if (refusal.never === true) return { code: "neverArchived" };
      return { code: "pending" };
  }
};
