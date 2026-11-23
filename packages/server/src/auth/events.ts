import type { Executor, Logger } from "../database.ts";
import { repositoryEvent } from "../archive/events.ts";
import type { ArchiveJob } from "../archive/schedule.ts";
import type { GitHubEventHandler } from "../github/webhook.ts";
import { webhookDeliveries } from "../schema.ts";
import { revokedOnGitHub } from "./accounts.ts";
import { installationEvent } from "./installations.ts";

export interface AccountEventsOptions {
  /**
   * Archives that a delivery calls for, see archive/events.ts: queued once the delivery is taken in.
   * Should that fail, the archives find out for themselves the next time they run.
   */
  readonly onArchives?: (jobs: readonly ArchiveJob[]) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
}

/**
 * What the webhook hears about accounts: a person who took the App's authorization back on GitHub
 * is signed out everywhere, and installations come and go. The same deliveries say what happens to
 * the repositories projects are archived into, see archive/events.ts.
 *
 * Each delivery is taken in once, by its X-GitHub-Delivery, in the same transaction as what it
 * does: a delivery that failed is not noted, and can come again.
 */
export const accountEvents =
  (db: Executor, options: AccountEventsOptions = {}): GitHubEventHandler =>
  async (event, payload, delivery) => {
    const now = options.now?.() ?? new Date();
    const archives = await db.transaction(async (tx) => {
      if (delivery !== undefined) {
        const [fresh] = await tx
          .insert(webhookDeliveries)
          .values({ id: delivery, event })
          .onConflictDoNothing()
          .returning({ id: webhookDeliveries.id });
        if (!fresh) return [];
      }
      if (event === "github_app_authorization") {
        const sender = payload.sender as { id?: unknown } | undefined;
        if (payload.action === "revoked" && typeof sender?.id === "number")
          await revokedOnGitHub(tx, sender.id);
        return [];
      }
      await installationEvent(tx, event, payload, now);
      return repositoryEvent(tx, event, payload, now, options.log);
    });
    if (archives.length > 0) await options.onArchives?.(archives).catch(() => {});
  };
