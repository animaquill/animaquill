import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Executor } from "../database.ts";
import { installationFrom, type GitHubInstallation } from "../github/client.ts";
import { installations } from "../schema.ts";

/**
 * Where the GitHub App is installed. Webhooks keep this up to date as installations come and go;
 * signing in checks what the person's token sees as well, for installations from before the
 * platform listened, or a delivery that did not arrive.
 */

export const keepInstallation = async (
  db: Executor,
  installation: GitHubInstallation,
  now = new Date(),
) => {
  const values = {
    accountId: installation.accountId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    suspendedAt: installation.suspendedAt ?? null,
    updatedAt: now,
  };
  await db
    .insert(installations)
    .values({ id: installation.id, ...values })
    .onConflictDoUpdate({ target: installations.id, set: values });
};

export const forgetInstallation = async (db: Executor, id: number) => {
  await db.delete(installations).where(eq(installations.id, id));
};

/**
 * What a person's token sees of the installations on their own account is how it is: one there is
 * kept, and one GitHub does not show any more is gone.
 */
export const syncOwnInstallations = async (
  db: Executor,
  githubId: number,
  seen: readonly GitHubInstallation[],
  now = new Date(),
) => {
  const own = seen.filter((installation) => installation.accountId === githubId);
  for (const installation of own) await keepInstallation(db, installation, now);
  const ids = own.map((installation) => installation.id);
  await db
    .delete(installations)
    .where(
      and(
        eq(installations.accountId, githubId),
        ids.length > 0 ? notInArray(installations.id, ids) : undefined,
      ),
    );
};

/** Whether the App is installed on a person's own account, and not suspended there. */
export const isInstalledFor = async (db: Executor, githubId: number): Promise<boolean> => {
  const [row] = await db
    .select({ id: installations.id })
    .from(installations)
    .where(and(eq(installations.accountId, githubId), isNull(installations.suspendedAt)))
    .limit(1);
  return row !== undefined;
};

/**
 * What a webhook says about installations. Deliveries can come twice or out of order: each one sets
 * what it says, so the same one twice does nothing more.
 */
export const installationEvent = async (
  db: Executor,
  event: string,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<boolean> => {
  const installation = installationFrom(payload.installation);
  if (!installation) return false;
  const action = payload.action;
  if (event === "installation") {
    if (action === "deleted") {
      await forgetInstallation(db, installation.id);
      return true;
    }
    if (action === "suspend")
      await keepInstallation(db, { ...installation, suspendedAt: installation.suspendedAt ?? now });
    else if (action === "unsuspend")
      await keepInstallation(db, { ...installation, suspendedAt: undefined });
    else await keepInstallation(db, installation, now);
    return true;
  }
  if (event === "installation_repositories") {
    // Which repositories it has changed, and with that perhaps all or selected.
    const selection = payload.repository_selection;
    await keepInstallation(
      db,
      typeof selection === "string"
        ? { ...installation, repositorySelection: selection }
        : installation,
      now,
    );
    return true;
  }
  return false;
};
