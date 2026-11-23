import { eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../database.ts";
import type { GitHubClient, GitHubTokens } from "../github/client.ts";
import { GitHubUnavailable } from "../github/client.ts";
import { githubTokens, sessions } from "../schema.ts";
import { SealError, type Sealer } from "../seal.ts";

/**
 * The GitHub tokens of a person, sealed in the database, and the one way to get a working access
 * token: `githubTokenFor`. GitHub's refresh tokens work once, and a refresh ends the old access
 * token at that moment: two refreshes at the same time leave one of them with `bad_refresh_token`,
 * which must not be taken for a person who signed out, nor overwrite the tokens the other one got.
 * So refreshing goes one at a time per person, with their row locked, and the new tokens are stored
 * in the same transaction, before anyone uses them.
 */

/** Refreshed this long before it would expire, so that a request on its way does not get a 401. */
export const REFRESH_EARLY_MS = 5 * 60 * 1000;

/** The person has to sign in again: the authorization is gone, or what we had of it stopped working. */
export class SignInNeeded extends Error {
  override name = "SignInNeeded";
}

const sealedFor = (sealer: Sealer, userId: string) => ({
  seal: (token: string, kind: "access" | "refresh") =>
    sealer.seal(token, "github-token", `${kind}:${userId}`),
  open: (token: Buffer, kind: "access" | "refresh") =>
    sealer.open(token, "github-token", `${kind}:${userId}`),
});

/** The tokens as the row has them: sealed for this person. */
export const sealTokens = (sealer: Sealer, userId: string, tokens: GitHubTokens) => {
  const { seal } = sealedFor(sealer, userId);
  return {
    accessToken: seal(tokens.accessToken, "access"),
    accessExpiresAt: tokens.accessExpiresAt ?? null,
    refreshToken: tokens.refreshToken === undefined ? null : seal(tokens.refreshToken, "refresh"),
    refreshExpiresAt: tokens.refreshExpiresAt ?? null,
  };
};

/** Keeps the tokens of a new authorization, in place of whatever was there. */
export const storeTokens = async (
  db: Executor,
  sealer: Sealer,
  userId: string,
  tokens: GitHubTokens,
  now = new Date(),
) => {
  const sealed = sealTokens(sealer, userId, tokens);
  await db
    .insert(githubTokens)
    .values({ userId, ...sealed, generation: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: githubTokens.userId,
      set: { ...sealed, generation: 1, updatedAt: now },
    });
};

/** Who hears that a person is signed out everywhere, see `whenSignedOutEverywhere`. */
const signedOutEverywhere = new Set<(userId: string) => void>();

/**
 * Hears of a person whose sessions all went at once, as when they took the App's authorization back
 * on GitHub: whatever they have open, such as connections for syncing, ends too. Returns how to stop.
 */
export const whenSignedOutEverywhere = (listener: (userId: string) => void): (() => void) => {
  signedOutEverywhere.add(listener);
  return () => signedOutEverywhere.delete(listener);
};

/** What else goes with a person's authorization, see `alsoForget`. */
const forgetting = new Set<(db: Executor, userId: string) => Promise<void>>();

/**
 * Has what a deployment keeps of a person's signing in go with their authorization, in the same
 * transaction (`forgetAuthorization`): on the platform, the sessions of its admin site.
 * Returns how to stop.
 */
export const alsoForget = (
  forget: (db: Executor, userId: string) => Promise<void>,
): (() => void) => {
  forgetting.add(forget);
  return () => forgetting.delete(forget);
};

/**
 * Forgets the authorization of a person and signs them out everywhere, of what a deployment adds too
 * (`alsoForget`): what is left of it does not work, and they have to go through GitHub again.
 */
export const forgetAuthorization = async (db: Executor, userId: string) => {
  await db.delete(githubTokens).where(eq(githubTokens.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  for (const forget of forgetting) await forget(db, userId);
  // Ended a moment early, should the transaction not get through: they come back and sign in.
  for (const listener of signedOutEverywhere) listener(userId);
};

export interface TokenOptions {
  /** The access token that GitHub just turned down: a new one, even if this one should still work. */
  readonly rejected?: string;
  readonly now?: () => Date;
  /** How long to wait for a refresh of someone else, see LOCK_TIMEOUT_MS. */
  readonly lockTimeoutMs?: number;
}

/**
 * How long a refresh waits for another one of the same person to be done. It holds a connection of
 * the pool while it waits, so not for long: the other one takes as long as GitHub does, at most the
 * timeout of the GitHub client (github/client.ts), and then this one finds its tokens.
 */
export const LOCK_TIMEOUT_MS = 15_000;
/**
 * The longest a refresh may sit in its transaction doing nothing, as while GitHub answers. Past
 * that the database ends it, rather than hold a connection and a lock for nothing.
 */
export const IDLE_TIMEOUT_MS = 30_000;

type Row = typeof githubTokens.$inferSelect;

const usable = (row: Row, now: Date) =>
  row.accessExpiresAt === null || row.accessExpiresAt.getTime() - REFRESH_EARLY_MS > now.getTime();

/** The code PostgreSQL gives a statement that waited too long for a lock. */
const LOCK_NOT_AVAILABLE = "55P03";

const codeOf = (error: unknown): unknown =>
  (error as { code?: unknown } | undefined)?.code ??
  (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;

/**
 * A working access token of a person, refreshed when it is about to expire, or when GitHub turned
 * it down (`rejected`). Throws SignInNeeded when there is none to be had, and GitHubUnavailable when
 * GitHub could not be asked, or another refresh takes too long: then nothing changed, and the next
 * call tries again.
 *
 * Tokens that do not open with the master keys there are now (the key was replaced) are no use to
 * anyone: the authorization goes, the person is signed out, and signs in again.
 *
 * The token is a secret: it goes to GitHub and nowhere else, not into logs, answers or reports.
 */
export const githubTokenFor = async (
  db: Db,
  sealer: Sealer,
  github: GitHubClient,
  userId: string,
  options: TokenOptions = {},
): Promise<string> => {
  const now = options.now ?? (() => new Date());
  const { open } = sealedFor(sealer, userId);
  const lockTimeoutMs = Math.max(1, Math.round(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS));

  /** What is kept of the person does not open any more: they sign in again. */
  const forget = async (): Promise<never> => {
    await db.transaction((tx) => forgetAuthorization(tx, userId));
    throw new SignInNeeded("the GitHub tokens do not open with the master keys there are");
  };

  // Most of the time the token works, and no lock is needed to read it.
  const [row] = await db.select().from(githubTokens).where(eq(githubTokens.userId, userId));
  if (!row) throw new SignInNeeded("no GitHub authorization");
  let access: string;
  try {
    access = open(row.accessToken, "access");
  } catch (error) {
    if (error instanceof SealError) return forget();
    throw error;
  }
  if (usable(row, now()) && access !== options.rejected) return access;

  // What has to be undone goes in the transaction; signing out has to stay done, so it is said
  // after the transaction, not thrown in it.
  let result: { token: string } | { signIn: string };
  try {
    result = await db.transaction(async (tx): Promise<{ token: string } | { signIn: string }> => {
      // Neither waiting for someone else's refresh nor waiting for GitHub may hold the connection
      // for long: the pool has few of them.
      await tx.execute(sql.raw(`set local lock_timeout = ${lockTimeoutMs}`));
      await tx.execute(
        sql.raw(`set local idle_in_transaction_session_timeout = ${IDLE_TIMEOUT_MS}`),
      );
      // One refresh at a time for this person: whoever comes second waits here, and then finds what
      // the first one stored.
      const [locked] = await tx
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.userId, userId))
        .for("update");
      if (!locked) return { signIn: "no GitHub authorization" };
      const current = open(locked.accessToken, "access");
      // Someone refreshed while this waited: that one works.
      if (locked.generation !== row.generation && current !== options.rejected)
        return { token: current };
      if (usable(locked, now()) && current !== options.rejected) return { token: current };

      const refresh = locked.refreshToken ? open(locked.refreshToken, "refresh") : undefined;
      if (
        refresh === undefined ||
        (locked.refreshExpiresAt !== null && locked.refreshExpiresAt <= now())
      ) {
        await forgetAuthorization(tx, userId);
        return { signIn: "the GitHub authorization expired" };
      }

      const answer = await github.refresh(refresh);
      if (answer.ok) {
        const sealed = sealTokens(sealer, userId, answer.tokens);
        await tx
          .update(githubTokens)
          .set({ ...sealed, generation: locked.generation + 1, updatedAt: now() })
          .where(eq(githubTokens.userId, userId));
        return { token: answer.tokens.accessToken };
      }
      if (answer.error === "bad_refresh_token") {
        // Before taking that for an authorization that is gone: read again, in case the tokens
        // changed after all. With the row locked nothing of ours can have, so this is for anything
        // that does not go through here.
        const [again] = await tx
          .select({ generation: githubTokens.generation })
          .from(githubTokens)
          .where(eq(githubTokens.userId, userId));
        if (again && again.generation !== locked.generation)
          throw new GitHubUnavailable("the tokens changed while refreshing");
        await forgetAuthorization(tx, userId);
        return { signIn: "GitHub does not take the refresh token any more" };
      }
      throw new GitHubUnavailable(`refreshing failed: ${answer.error}`);
    });
  } catch (error) {
    if (error instanceof SealError) return forget();
    if (codeOf(error) === LOCK_NOT_AVAILABLE)
      throw new GitHubUnavailable("another refresh of these tokens takes too long");
    throw error;
  }
  if ("signIn" in result) throw new SignInNeeded(result.signIn);
  return result.token;
};
