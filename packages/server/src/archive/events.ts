import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import type { Executor, Logger } from "../database.ts";
import { archives, projectRepos } from "../schema.ts";
import { pauseLink, resumeLinks, UNUSABLE_REASONS } from "./links.ts";
import { readSetting } from "../settings.ts";
import { LOOKED_WHILE_PAUSED, REPO_MERGE_SETTING } from "./merging.ts";
import type { ArchiveJob } from "./schedule.ts";

/**
 * What GitHub's webhooks say about the repositories projects are archived into, in the transaction
 * that takes the delivery in once (see auth/events.ts). Resolves to the archives to queue once that
 * is committed.
 *
 * - A push to the default branch of a linked repository that is not a commit of the platform's (by
 *   `head_sha` or `pending_sha`: the webhook can come before the archive notes its commit) queues a
 *   check: are the files of the project still as the platform left them.
 * - A repository taken out of an installation pauses its archives ("gone"), and that it was taken
 *   out is noted (`gone_cause`), which is what tells it from one that was deleted; put back, they
 *   go on, but only on the account it was linked on, also where they had paused because it had
 *   moved away from there: added to another account's installation, it was transferred, and is
 *   someone else's ("transferred").
 * - An installation deleted or suspended pauses them ("uninstalled", "suspended"); unsuspended, or
 *   installed again on the same account, they go on.
 * - What happens to the repository itself, where the App hears of it ("repository", which the App
 *   has to be subscribed to): renamed, made private or public, or its default branch changed, the
 *   link has it as the delivery says, for showing; deleted, its archives pause ("gone"), noted as
 *   deleted; moved to another account, they pause ("transferred") with its new names, and go on
 *   once it is back on the account it was linked on; archived, they pause ("archived"), and go on
 *   once it is not.
 *
 * A repository that cannot be used pauses archiving also where it had paused for another reason
 * (files changed on GitHub, a protected branch...): that it cannot be used is what counts now, and
 * whatever else is the matter with it an archive finds again once it can be (see links.ts,
 * `UNUSABLE_REASONS`). One paused for such a reason already keeps its reason, and so when that was
 * first found.
 *
 * Nothing here depends on GitHub saying any of that: an archive finds a repository that is gone,
 * moved or archived itself, and notes its names as they are, and the list of projects has
 * repositories nobody looked at for a day looked at again (sync/list.ts). Deliveries can come twice
 * or out of order: each one sets what it says, and an archive checks with GitHub anyway, which is
 * why a delivery about a repository whose archives go on queues a check.
 */

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

/** A name as a delivery says it: some text, and not more of it than any name has. */
const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= 255 ? value : undefined;

const repositoryIds = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const id = numberOf((item as { id?: unknown } | null)?.id);
        return id === undefined ? [] : [id];
      })
    : [];

/** Links that archive as they should, or that paused for something else than the repository. */
const usable = or(
  eq(projectRepos.state, "ready"),
  isNull(projectRepos.pauseReason),
  notInArray(projectRepos.pauseReason, [...UNUSABLE_REASONS]),
);

export const repositoryEvent = async (
  db: Executor,
  event: string,
  payload: Record<string, unknown>,
  now: Date,
  log?: Logger,
): Promise<ArchiveJob[]> => {
  const installation = payload.installation as
    { id?: unknown; account?: { id?: unknown } } | undefined;
  const installationId = numberOf(installation?.id);

  if (event === "push") {
    const repoId = numberOf((payload.repository as { id?: unknown } | undefined)?.id);
    if (repoId === undefined) return [];
    const [link] = await db.select().from(projectRepos).where(eq(projectRepos.repoId, repoId));
    // Paused for what waits of merges, a push is merged all the same (see `LOOKED_WHILE_PAUSED`):
    // the archive only looks then, and only while merges are on.
    const looked =
      link?.state === "paused" &&
      link.pauseReason !== null &&
      LOOKED_WHILE_PAUSED.includes(link.pauseReason) &&
      (await readSetting(db, REPO_MERGE_SETTING)).enabled;
    if (!link || (link.state !== "ready" && !looked)) return [];
    if (payload.ref !== `refs/heads/${link.branch}`) return [];
    const after = payload.after;
    if (typeof after !== "string" || after === link.headSha || after === link.pendingSha) return [];
    // An archive of the platform's that comes late, after a newer one.
    const [known] = await db
      .select({ sha: archives.sha })
      .from(archives)
      .where(and(eq(archives.projectId, link.projectId), eq(archives.sha, after)))
      .limit(1);
    if (known) return [];
    // A forced push (GitHub's `forced`) says the history may have been rewritten: the archive goes by
    // what it reads of the branch, not by what the event says, as events come late or twice.
    if (payload.forced === true)
      log?.info({ project: link.projectId, after }, "a forced push to the branch of a project");
    return [{ project: link.projectId, kind: "check" }];
  }

  if (event === "repository") return repositoryChanged(db, payload, now, log);

  if (event === "installation_repositories" && installationId !== undefined) {
    const removed = repositoryIds(payload.repositories_removed);
    if (removed.length > 0) {
      const gone = await db
        .select({ projectId: projectRepos.projectId, repoId: projectRepos.repoId })
        .from(projectRepos)
        .where(and(inArray(projectRepos.repoId, removed), usable));
      for (const link of gone) {
        await pauseLink(db, link, {
          reason: "gone",
          detail: "the repository was taken out of what the App may touch",
          at: now,
        });
      }
      // Why they are not there, whatever paused their archives, and whenever they are found gone:
      // unless GitHub said they were deleted, which also takes them out.
      await db
        .update(projectRepos)
        .set({ goneCause: "removed" })
        .where(and(inArray(projectRepos.repoId, removed), isNull(projectRepos.goneCause)));
    }
    const added = repositoryIds(payload.repositories_added);
    if (added.length === 0) return [];
    // Back in, through this installation, which can be a new one: only on the account the repository
    // was linked on. On another account it is someone else's now, wherever it came from.
    const accountId = numberOf(installation?.account?.id);
    if (accountId === undefined) return [];
    const links = await db
      .select({
        projectId: projectRepos.projectId,
        repoId: projectRepos.repoId,
        ownerId: projectRepos.ownerId,
        state: projectRepos.state,
        pauseReason: projectRepos.pauseReason,
      })
      .from(projectRepos)
      .where(inArray(projectRepos.repoId, added));
    const back: ArchiveJob[] = [];
    for (const link of links) {
      if (link.ownerId !== accountId) {
        if (link.pauseReason !== "transferred")
          await pauseLink(db, link, {
            reason: "transferred",
            detail: "the repository is on another account now than the one it was linked on",
            at: now,
          });
        continue;
      }
      // Back in what the App may touch: whatever was noted about why it was not is over.
      await db
        .update(projectRepos)
        .set({ goneCause: null })
        .where(
          and(eq(projectRepos.projectId, link.projectId), eq(projectRepos.repoId, link.repoId)),
        );
      // On the account it was linked on, and in what the App may touch: archiving goes on where
      // it paused because the repository was not there, or because it had moved to another account
      // and is back now, of which this can be all GitHub says. An archive looks whether it is so.
      if (
        link.state !== "paused" ||
        (link.pauseReason !== "gone" && link.pauseReason !== "transferred")
      )
        continue;
      await db
        .update(projectRepos)
        .set({ installationId })
        .where(
          and(eq(projectRepos.projectId, link.projectId), eq(projectRepos.repoId, link.repoId)),
        );
      const resumed = await resumeLinks(
        db,
        and(eq(projectRepos.projectId, link.projectId), eq(projectRepos.repoId, link.repoId)),
        ["gone", "transferred"],
      );
      back.push(...resumed.map((project) => ({ project, kind: "check" as const })));
    }
    return back;
  }

  if (event === "installation" && installationId !== undefined) {
    const action = payload.action;
    if (action === "deleted" || action === "suspend") {
      const reason = action === "deleted" ? "uninstalled" : "suspended";
      const affected = await db
        .select({ projectId: projectRepos.projectId, repoId: projectRepos.repoId })
        .from(projectRepos)
        .where(and(eq(projectRepos.installationId, installationId), usable));
      for (const link of affected) {
        await pauseLink(db, link, {
          reason,
          detail:
            reason === "uninstalled"
              ? "the App was uninstalled from the account"
              : "the App is suspended on the account",
          at: now,
        });
      }
      return [];
    }
    if (action === "unsuspend") {
      const back = await resumeLinks(db, eq(projectRepos.installationId, installationId), [
        "suspended",
      ]);
      return back.map((project) => ({ project, kind: "check" }));
    }
    if (action === "created") {
      const accountId = numberOf(installation?.account?.id);
      if (accountId === undefined) return [];
      // Installed again: the archives of the account go on through the new installation, and an
      // archive finds out whether it covers their repositories.
      await db
        .update(projectRepos)
        .set({ installationId })
        .where(
          and(eq(projectRepos.ownerId, accountId), eq(projectRepos.pauseReason, "uninstalled")),
        );
      const back = await resumeLinks(db, eq(projectRepos.ownerId, accountId), ["uninstalled"]);
      return back.map((project) => ({ project, kind: "check" }));
    }
  }
  return [];
};

/**
 * What a "repository" delivery says about the repository of a project. The repository in it is as
 * it was when GitHub sent it: its names and whether it is private go into the link, and what it
 * says happened decides about archiving. Resolves to the checks to queue.
 */
const repositoryChanged = async (
  db: Executor,
  payload: Record<string, unknown>,
  now: Date,
  log: Logger | undefined,
): Promise<ArchiveJob[]> => {
  const repository = payload.repository as
    | {
        id?: unknown;
        name?: unknown;
        private?: unknown;
        archived?: unknown;
        default_branch?: unknown;
        owner?: { id?: unknown; login?: unknown };
      }
    | undefined;
  const repoId = numberOf(repository?.id);
  if (!repository || repoId === undefined) return [];
  const [link] = await db
    .select({
      projectId: projectRepos.projectId,
      repoId: projectRepos.repoId,
      ownerId: projectRepos.ownerId,
      state: projectRepos.state,
      pauseReason: projectRepos.pauseReason,
    })
    .from(projectRepos)
    .where(eq(projectRepos.repoId, repoId));
  if (!link) return [];
  // What happened, for the log: renamed, moved, made public or private are kept for later (a
  // public project), and nothing of what is in the repository is said.
  const action = typeof payload.action === "string" ? payload.action.slice(0, 40) : undefined;
  if (
    action === "renamed" ||
    action === "transferred" ||
    action === "publicized" ||
    action === "privatized" ||
    action === "deleted"
  )
    log?.info(
      { project: link.projectId, repo: repoId, action },
      "GitHub says the repository of a project changed",
    );
  const same = and(
    eq(projectRepos.projectId, link.projectId),
    eq(projectRepos.repoId, link.repoId),
  );
  const check: ArchiveJob[] = [{ project: link.projectId, kind: "check" }];

  // Gone for good, whatever else was the matter with it: nothing is there to archive into.
  if (payload.action === "deleted") {
    await pauseLink(db, link, {
      reason: "gone",
      detail: "the repository was deleted on GitHub",
      at: now,
      goneCause: "deleted",
    });
    return [];
  }

  // As the delivery has it, for showing. Never the account it was linked on.
  const ownerLogin = textOf(repository.owner?.login);
  const name = textOf(repository.name);
  const branch = textOf(repository.default_branch);
  const seen = {
    ...(ownerLogin !== undefined && { ownerLogin }),
    ...(name !== undefined && { name }),
    ...(branch !== undefined && { branch }),
    ...(typeof repository.private === "boolean" && { private: repository.private }),
  };
  if (Object.keys(seen).length > 0) await db.update(projectRepos).set(seen).where(same);

  // On another account than the one it was linked on: someone else's now, with its new names.
  const ownerId = numberOf(repository.owner?.id);
  if (ownerId !== undefined && ownerId !== link.ownerId) {
    if (link.pauseReason !== "transferred")
      await pauseLink(db, link, {
        reason: "transferred",
        detail: `the repository is on the account ${ownerLogin ?? ownerId} now`,
        at: now,
      });
    return [];
  }
  // Back on the account it was linked on: an archive finds out whether the App reaches it there.
  if (ownerId !== undefined && link.state === "paused" && link.pauseReason === "transferred") {
    const back = await resumeLinks(db, same, ["transferred"]);
    return back.map((project) => ({ project, kind: "check" }));
  }

  if (repository.archived === true) {
    if (link.state !== "ready") return [];
    await pauseLink(db, link, {
      reason: "archived",
      detail: "the repository is archived on GitHub",
      at: now,
    });
    return [];
  }
  if (repository.archived === false && link.state === "paused" && link.pauseReason === "archived") {
    const back = await resumeLinks(db, same, ["archived"]);
    return back.map((project) => ({ project, kind: "check" }));
  }

  // A delivery can be older than the one before it: an archive that looks at GitHub puts right
  // what this one set. One whose archives are paused is not looked at until people see to that.
  return link.state === "ready" ? check : [];
};
