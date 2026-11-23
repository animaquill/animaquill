import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../database.ts";
import { describeError } from "../database.ts";
import { keepInstallation } from "../auth/installations.ts";
import type { GitHubApp } from "../github/app.ts";
import { installations, projectRepos, type PauseReason } from "../schema.ts";
import {
  isUnusable,
  pauseLink,
  recheckAfterMs,
  RECHECK_UNKNOWN_MS,
  resumeLinks,
  sameLink,
  UNUSABLE_REASONS,
  type Link,
} from "./links.ts";
import { RepoPaused, type GitHubPlace, type RepoHost } from "./repo-host.ts";

/**
 * Asks GitHub whether the repository of a project that cannot be used (archive/links.ts,
 * `UNUSABLE_REASONS`) can be used again: by itself now and then (`recheck_at`, see sync/sweep.ts),
 * as people ask ("再检查一次", `RepositoryService.recheck`), and before the platform takes such a
 * project away. With the App's token for the repository, by its number, through the installation on
 * the account it was linked on. Nothing here depends on what webhooks said, which can be lost, and
 * what a deleted repository that was put back sends is not known: where GitHub says the App is not
 * installed there, is suspended, or does not reach the repository, it is asked with the App's own
 * key which installation the account has now (`GitHubApp.installationOf`), which the platform then
 * knows too, and that one is asked again, as after the App was installed again and the webhook was
 * lost.
 *
 * - "usable": the App reaches it, on the account it was linked on. Archiving goes on (its timer
 *   ends), and an archive finds out what else is the matter with it, if anything.
 * - "unusable": it is gone to the App, the App is not installed or is suspended there, or it is on
 *   another account. Where that says more than the pause had ("gone" said nothing of why), the pause
 *   says it now; when it was first found stays as it was. GitHub is asked again later by itself.
 * - "unknown": GitHub could not be asked, or said something that makes no sense. Nothing changes,
 *   and nothing is taken away on that; it is asked again a while later.
 *
 * Each time is noted (`rechecked_at`), which also puts it at the end of what is asked next.
 */

export type Recheck =
  | { readonly kind: "usable" }
  | { readonly kind: "unusable"; readonly reason: PauseReason }
  | { readonly kind: "unknown"; readonly detail: string };

const detailOf = (error: unknown) => String(describeError(error).message ?? "failed");

export const recheckLink = async (
  db: Db,
  host: RepoHost<GitHubPlace>,
  link: Link,
  now: Date,
  /** The App, to ask which installation the account has now. Without it, only what is known. */
  app?: Pick<GitHubApp, "installationOf">,
): Promise<Recheck> => {
  // Only GitHub is asked again: a repository of the server's own is there, or the disk is not.
  if (link.provider !== "github" || link.installationId === null)
    return { kind: "unknown", detail: "not a repository on GitHub" };
  const ask = async (installationId: number): Promise<Recheck> => {
    try {
      const info = await host
        .open({ provider: "github", installationId, repoId: link.repoId })
        .info();
      return info.ownerId === link.ownerId
        ? { kind: "usable" }
        : { kind: "unusable", reason: "transferred" };
    } catch (error) {
      if (error instanceof RepoPaused && isUnusable(error.reason))
        return { kind: "unusable", reason: error.reason };
      return { kind: "unknown", detail: detailOf(error) };
    }
  };
  // The installation on the account it was linked on, as the platform knows it now.
  const [installed] = await db
    .select({ id: installations.id })
    .from(installations)
    .where(eq(installations.accountId, link.ownerId))
    .orderBy(desc(installations.createdAt))
    .limit(1);
  let installationId = installed?.id ?? link.installationId;
  let found = await ask(installationId);
  if (found.kind === "unusable" && found.reason !== "transferred" && app) {
    // What GitHub says the account has now, which a lost webhook keeps from the platform.
    try {
      const current = await app.installationOf({ id: link.ownerId, login: link.ownerLogin });
      if (!current) found = { kind: "unusable", reason: "uninstalled" };
      else {
        await keepInstallation(db, current, now);
        if (current.id !== installationId) {
          installationId = current.id;
          found = await ask(current.id);
        }
      }
    } catch (error) {
      found = { kind: "unknown", detail: detailOf(error) };
    }
  }
  const same = sameLink(link);
  if (found.kind === "usable") {
    await db.transaction(async (tx) => {
      if (installationId !== link.installationId)
        await tx.update(projectRepos).set({ installationId }).where(same);
      await resumeLinks(tx, same, UNUSABLE_REASONS);
    });
    return found;
  }
  // What it says, where that is more than the pause said: "gone" is what an archive that finds
  // nothing says, whatever the reason, and so is what the App's token says of a repository that
  // moved to where the App is not.
  if (
    found.kind === "unusable" &&
    link.state === "paused" &&
    isUnusable(link.pauseReason) &&
    found.reason !== link.pauseReason &&
    found.reason !== "gone"
  )
    await pauseLink(db, link, {
      reason: found.reason,
      detail:
        found.reason === "transferred"
          ? "the repository is on another account now than the one it was linked on"
          : found.reason === "uninstalled"
            ? "the App is not installed on the account"
            : "the App is suspended on the account",
      at: now,
    });
  // When it is asked again: later each time GitHub says no, soon where it could not say.
  const rechecks = found.kind === "unusable" ? link.rechecks + 1 : link.rechecks;
  const wait = found.kind === "unusable" ? recheckAfterMs(rechecks) : RECHECK_UNKNOWN_MS;
  await db
    .update(projectRepos)
    .set({
      recheckedAt: now,
      recheckAt: new Date(now.getTime() + wait),
      rechecks: sql`${projectRepos.rechecks} + ${found.kind === "unusable" ? 1 : 0}`,
    })
    .where(and(same, isNotNull(projectRepos.unusableSince)));
  return found;
};
