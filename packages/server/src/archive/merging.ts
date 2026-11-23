import { and, count, eq, sql } from "drizzle-orm";
import type { Executor } from "../database.ts";
import {
  projectRepos,
  projects,
  repoConflicts,
  type BlockedFile,
  type PauseReason,
} from "../schema.ts";
import type { Setting } from "../settings.ts";

/**
 * Merging what changed on GitHub into projects, as far as the archive, the API and the hub share
 * it: the switch of the admin site, which pauses go with a merge, and how such a pause follows from
 * what waits for people.
 */

/**
 * Whether changes on GitHub are merged into projects (2C): off unless an admin turned it on, after
 * the four checks on the real GitHub (2-0 of the plan). Off, archiving is as it was before merges:
 * a file of the project changed on GitHub pauses it, "diverged".
 */
export const REPO_MERGE_SETTING: Setting<{ readonly enabled: boolean }> = {
  key: "repo-merge",
  fallback: { enabled: false },
  read: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
      ? { enabled: (value as { enabled: boolean }).enabled }
      : undefined,
};

/**
 * Pauses that what waits in the platform decides on: open conflicts, and files on GitHub that a
 * merge did not take in (`project_repos.blocked`). They end once nothing waits, see
 * `settleMergePause`, and never by "archive now".
 */
export const MERGE_PAUSES: readonly PauseReason[] = ["conflicts", "blocked", "locked"];

/**
 * Pauses during which a push on GitHub is still looked at, and merged: merging goes on while people
 * see to what waits, and a newer push can put right what did not go in.
 */
export const LOOKED_WHILE_PAUSED: readonly PauseReason[] = [
  ...MERGE_PAUSES,
  "too-large",
  "unmerged",
];

/**
 * Pauses that "以编辑器的内容接着存" (`replace` of "archive now") ends: whatever GitHub has, the
 * project goes on top of it, as it is.
 */
export const REPLACEABLE: readonly PauseReason[] = [
  "diverged",
  "rewritten",
  "too-large",
  "unmerged",
  ...MERGE_PAUSES,
];

/**
 * One merge takes this many files at most, and this many bytes of text (what each was, and what
 * GitHub has): the hub's `SyncLimits.mergeFiles`, `mergeBytes` unless set otherwise, which the
 * worker checks before it reads anything.
 */
export const MERGE_FILES = 2000;
export const MERGE_BYTES = 32 * 1024 * 1024;

/**
 * A file on GitHub larger than this is not read into a merge: it is noted as unreadable, see
 * `BlockedFile`. The editor reads no file of code that large either.
 */
export const MERGE_FILE_BYTES = 8 * 1024 * 1024;

/** Why a link is to be paused for what waits: blocked files first, then conflicts. */
export const mergePauseOf = (
  blocked: readonly BlockedFile[],
  openConflicts: number,
): PauseReason | undefined => {
  if (blocked.some(({ reason }) => reason !== "locked")) return "blocked";
  if (blocked.length > 0) return "locked";
  if (openConflicts > 0) return "conflicts";
  return undefined;
};

/**
 * Pauses the link of a project for what waits of merges, or lets it go on once nothing does: open
 * conflicts, blocked files. A link that is paused for anything else stays as it is; with `merged`,
 * for a merge that went in, also one paused as an earlier merge did not ("too-large", "unmerged"),
 * which is over now. In the caller's transaction; the row of the link is locked for it. Resolves to
 * what it is afterwards: "ready", paused for one of `MERGE_PAUSES`, "other" for another pause, or
 * undefined for no link.
 */
export const settleMergePause = async (
  tx: Executor,
  projectId: string,
  at: Date,
  options: { readonly merged?: boolean } = {},
): Promise<PauseReason | "ready" | "other" | undefined> => {
  const [link] = await tx
    .select({
      state: projectRepos.state,
      pauseReason: projectRepos.pauseReason,
      blocked: projectRepos.blocked,
    })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .for("update");
  if (!link) return undefined;
  const settles = options.merged ? [...MERGE_PAUSES, "too-large", "unmerged"] : MERGE_PAUSES;
  if (link.state === "paused" && (link.pauseReason === null || !settles.includes(link.pauseReason)))
    return "other";
  const [open] = await tx
    .select({ count: count() })
    .from(repoConflicts)
    .where(and(eq(repoConflicts.projectId, projectId), eq(repoConflicts.state, "open")));
  const reason = mergePauseOf(link.blocked, open?.count ?? 0);
  if (reason === undefined) {
    if (link.state === "paused") {
      await tx
        .update(projectRepos)
        .set({
          state: "ready",
          pauseReason: null,
          detail: null,
          pausedAt: null,
          pausedSeq: null,
          diverged: null,
        })
        .where(eq(projectRepos.projectId, projectId));
    }
    return "ready";
  }
  if (link.state !== "paused" || link.pauseReason !== reason) {
    await tx
      .update(projectRepos)
      .set({
        state: "paused",
        pauseReason: reason,
        detail: null,
        pausedAt: at,
        diverged: null,
        // Locked: merged again once the project changes, see `CONTENT_REASONS`.
        pausedSeq:
          reason === "locked"
            ? sql`(select ${projects.head} from ${projects} where ${projects.id} = ${projectId})`
            : null,
        failures: 0,
        nextAttemptAt: null,
        transientSince: null,
      })
      .where(eq(projectRepos.projectId, projectId));
  }
  return reason;
};
