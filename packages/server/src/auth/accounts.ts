import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db, Executor, Logger, Tx } from "../database.ts";
import {
  GitHubUnauthorized,
  GitHubUnavailable,
  type GitHubClient,
  type GitHubInstallation,
  type GitHubTokens,
  type GitHubUser,
} from "../github/client.ts";
import {
  githubTokens,
  loginAttempts,
  sessions,
  signups,
  users,
  webhookDeliveries,
} from "../schema.ts";
import { hashOf, randomToken, SealError, type Sealer } from "../seal.ts";
import { isInstalledFor, syncOwnInstallations } from "./installations.ts";
import { NOBODY_NEW, type PeoplePolicy } from "./people.ts";
import { HOME, type SignInOutcome } from "./return-to.ts";
import { forgetAuthorization, storeTokens } from "./tokens.ts";
import { describeUserAgent } from "./user-agent.ts";

/**
 * Accounts: signing in through GitHub, the sessions of browsers, and the first sign-in of a person,
 * which needs a code that the policy of people takes (people.ts; on the platform an invite code
 * during the closed beta). See the routes in routes.ts for how browsers get here, and
 * test/fake-github.ts for what GitHub does.
 */

/** A sign-in has this long to get through GitHub. */
export const LOGIN_MS = 10 * 60 * 1000;
/** A session lasts this long after it was last used. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** And this long at the most, however much it is used: then people sign in again. */
export const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Tokens stored this recently stay when tidying up, even without a session: a sign-in stores them
 * a moment before its session, see `cleanUp`.
 */
export const TOKEN_GRACE_MS = 10 * 60 * 1000;
/** Deliveries of webhooks are known again for this long, see auth/events.ts. */
export const DELIVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A session that is used moves on at most this often, so that not every request writes. */
export const SESSION_TOUCH_MS = 10 * 60 * 1000;
/** Someone without an account has this long to give an invite code. */
export const SIGNUP_MS = 30 * 60 * 1000;
/** Wrong codes before the sign-up goes, and with it what GitHub gave for it. */
export const SIGNUP_MAX_FAILURES = 5;

export interface AccountsOptions {
  readonly db: Db;
  readonly sealer: Sealer;
  readonly github: GitHubClient;
  /** The callback of the App, which the code is for. */
  readonly callbackUrl: string;
  readonly now?: () => Date;
  /** For what goes wrong on the side, such as GitHub not taking a token back. */
  readonly log?: Logger;
  /** Who may get an account, as they come or by the code they give: nobody new unless said. */
  readonly people?: PeoplePolicy | undefined;
}

/** Who is signed in, as the editor sees it. */
export interface SignedIn {
  readonly userId: string;
  readonly githubId: number;
  readonly login: string;
  readonly avatarUrl: string | null;
  /** Whether the App is installed on the person's own account, which saving to GitHub needs. */
  readonly installed: boolean;
  /** The session moved on, and its cookie with it. */
  readonly renewed: boolean;
  /** When the session ends, unless it is used again before. */
  readonly expiresAt: Date;
  /**
   * When the session began: when the person last came through GitHub in this browser. The admin
   * site takes only a recent one, see admin/sessions.ts.
   */
  readonly createdAt: Date;
}

/** GitHub tokens taken out of the database, still sealed, to be taken back on GitHub. */
export interface GoneTokens {
  readonly userId: string;
  readonly accessToken: Buffer;
}

export type LoginResult =
  | { readonly kind: "signedIn"; readonly sessionId: string; readonly returnTo: string }
  | { readonly kind: "signup"; readonly signupId: string; readonly returnTo: string }
  | { readonly kind: "failed"; readonly outcome: SignInOutcome; readonly returnTo: string };

export type RedeemResult =
  | { readonly kind: "signedIn"; readonly sessionId: string; readonly returnTo: string }
  /** The code is not one, or cannot be used (any more). */
  | { readonly kind: "invalid"; readonly triesLeft: number }
  /** There is no sign-up waiting, or it took too long, or had too many wrong codes. */
  | { readonly kind: "expired" };

const verifierChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const sameToken = (a: string, b: string) => {
  const left = hashOf(a);
  const right = hashOf(b);
  return timingSafeEqual(left, right);
};

const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown } | undefined)?.code === "23505" ||
  (error as { cause?: { code?: unknown } } | undefined)?.cause?.code === "23505";

export const createAccounts = ({
  db,
  sealer,
  github,
  callbackUrl,
  now: clock,
  log,
  people = NOBODY_NEW,
}: AccountsOptions) => {
  const now = clock ?? (() => new Date());
  const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

  /**
   * Takes tokens that are gone from here back on GitHub too, so that a copy of them, say in an old
   * backup, is no use. One that does not open any more cannot be taken back, nor needs to be: it is
   * useless to anyone without the old master key. What fails is only noted.
   */
  const takeBack = async (gone: readonly GoneTokens[]) => {
    for (const { userId, accessToken } of gone) {
      let token: string;
      try {
        token = sealer.open(accessToken, "github-token", `access:${userId}`);
      } catch {
        continue;
      }
      if (!(await github.revokeToken(token)))
        log?.warn({ userId }, "a GitHub token could not be taken back");
    }
  };

  /** A token GitHub just gave, which nothing here keeps. */
  const revokeNow = async (token: string) => {
    if (!(await github.revokeToken(token))) log?.warn({}, "a GitHub token could not be taken back");
  };

  const newSession = async (tx: Tx, userId: string, userAgent: string | undefined, at: Date) => {
    const id = randomToken();
    await tx.insert(sessions).values({
      idHash: hashOf(id),
      userId,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: later(at, SESSION_MS),
      userAgent: describeUserAgent(userAgent),
    });
    return id;
  };

  /** The account of a person GitHub knows, with these tokens from now on, and a new session. */
  const signInAs = async (
    tx: Tx,
    userId: string,
    tokens: GitHubTokens,
    userAgent: string | undefined,
    at: Date,
  ) => {
    // Tokens first: signing out elsewhere waits for their row, see `logout`.
    await storeTokens(tx, sealer, userId, tokens, at);
    return newSession(tx, userId, userAgent, at);
  };

  const failed = (outcome: SignInOutcome, returnTo = HOME): LoginResult => ({
    kind: "failed",
    outcome,
    returnTo,
  });

  return {
    /** A new sign-in: where to send the browser, and the state it has to keep in a cookie. */
    async startLogin(returnTo: string) {
      const state = randomToken();
      const verifier = randomToken(48);
      const at = now();
      const stateHash = hashOf(state);
      // Sign-ins that never came back go as new ones start.
      await db.delete(loginAttempts).where(lt(loginAttempts.expiresAt, at));
      await db.insert(loginAttempts).values({
        stateHash,
        verifier: sealer.seal(verifier, "login-verifier", stateHash.toString("hex")),
        returnTo,
        createdAt: at,
        expiresAt: later(at, LOGIN_MS),
      });
      return {
        state,
        url: github.authorizeUrl({
          state,
          codeChallenge: verifierChallenge(verifier),
          redirectUri: callbackUrl,
        }),
        maxAgeSeconds: LOGIN_MS / 1000,
      };
    },

    /**
     * The way back from GitHub. The state has to be the one in this browser's cookie, so that nobody
     * can sign a browser in with their own account, and one this server gave out in the last ten
     * minutes, which works once. GitHub failing ends it as failed, back where it started; only the
     * database failing throws.
     */
    async finishLogin(callback: {
      readonly state: string | undefined;
      readonly cookieState: string | undefined;
      readonly code: string | undefined;
      readonly error: string | undefined;
      readonly userAgent: string | undefined;
    }): Promise<LoginResult> {
      const { state, cookieState, code, error, userAgent } = callback;
      if (!state || !cookieState || !sameToken(state, cookieState)) return failed("failed");
      const stateHash = hashOf(state);
      const [attempt] = await db
        .delete(loginAttempts)
        .where(eq(loginAttempts.stateHash, stateHash))
        .returning();
      // Used already, or never given out.
      if (!attempt) return failed("expired");
      const { returnTo } = attempt;
      if (attempt.expiresAt <= now()) return failed("expired", returnTo);
      if (error) return failed(error === "access_denied" ? "cancelled" : "failed", returnTo);
      if (!code) return failed("failed", returnTo);
      let verifier: string;
      try {
        verifier = sealer.open(attempt.verifier, "login-verifier", stateHash.toString("hex"));
      } catch (problem) {
        if (problem instanceof SealError) return failed("failed", returnTo);
        throw problem;
      }

      const isGitHub = (problem: unknown) =>
        problem instanceof GitHubUnavailable || problem instanceof GitHubUnauthorized;
      let tokens: GitHubTokens;
      let person: GitHubUser;
      try {
        const exchanged = await github.exchangeCode(code, verifier, callbackUrl);
        if (!exchanged.ok) return failed("failed", returnTo);
        tokens = exchanged.tokens;
        person = await github.user(tokens.accessToken);
      } catch (problem) {
        if (isGitHub(problem)) return failed("failed", returnTo);
        throw problem;
      }
      // What the token sees of the installations; without it the webhooks still know.
      let seen: readonly GitHubInstallation[] | undefined;
      try {
        seen = await github.installations(tokens.accessToken);
      } catch (problem) {
        if (!isGitHub(problem)) throw problem;
      }

      const at = now();
      const result = await db.transaction(async (tx): Promise<LoginResult> => {
        if (seen) await syncOwnInstallations(tx, person.id, seen, at);
        // With the row locked until the session is in: disabling the account at the same moment
        // either comes first, and is seen here, or waits, and ends this session with the others.
        const [user] = await tx
          .update(users)
          .set({ login: person.login, avatarUrl: person.avatarUrl ?? null })
          .where(eq(users.githubId, person.id))
          .returning({ id: users.id, disabledAt: users.disabledAt });
        if (user?.disabledAt) return failed("disabled", returnTo);
        if (user) {
          const sessionId = await signInAs(tx, user.id, tokens, userAgent, at);
          return { kind: "signedIn", sessionId, returnTo };
        }
        // Someone the policy lets in as they come: their account is made now.
        const admitted = await people.admit?.(tx, { id: person.id, login: person.login }, at);
        if (admitted) {
          const [made] = await tx
            .insert(users)
            .values({
              githubId: person.id,
              login: person.login,
              avatarUrl: person.avatarUrl ?? null,
              createdAt: at,
            })
            .onConflictDoNothing({ target: users.githubId })
            .returning({ id: users.id });
          let userId = made?.id;
          if (made) await admitted.onCreated(tx, made.id);
          else {
            // Made in another browser at this moment: that account is theirs.
            const [other] = await tx
              .select({ id: users.id, disabledAt: users.disabledAt })
              .from(users)
              .where(eq(users.githubId, person.id))
              .for("share");
            if (!other) return failed("failed", returnTo);
            if (other.disabledAt) return failed("disabled", returnTo);
            userId = other.id;
          }
          const sessionId = await signInAs(tx, userId!, tokens, userAgent, at);
          return { kind: "signedIn", sessionId, returnTo };
        }
        // Someone else without an account: GitHub's tokens wait, sealed, for a code.
        const signupId = randomToken();
        const context = `signup:${person.id}`;
        await tx.delete(signups).where(eq(signups.githubId, person.id));
        await tx.insert(signups).values({
          idHash: hashOf(signupId),
          githubId: person.id,
          login: person.login,
          avatarUrl: person.avatarUrl ?? null,
          accessToken: sealer.seal(tokens.accessToken, "github-token", `access:${context}`),
          accessExpiresAt: tokens.accessExpiresAt ?? null,
          refreshToken:
            tokens.refreshToken === undefined
              ? null
              : sealer.seal(tokens.refreshToken, "github-token", `refresh:${context}`),
          refreshExpiresAt: tokens.refreshExpiresAt ?? null,
          returnTo,
          createdAt: at,
          expiresAt: later(at, SIGNUP_MS),
        });
        return { kind: "signup", signupId, returnTo };
      });
      // A disabled account keeps nothing of GitHub's, and GitHub does not keep what it just gave.
      if (result.kind === "failed" && result.outcome === "disabled")
        await revokeNow(tokens.accessToken);
      return result;
    },

    /** Who a session is, moving it on when it was used a while ago. Undefined: not signed in. */
    async session(sessionId: string): Promise<SignedIn | undefined> {
      const at = now();
      const idHash = hashOf(sessionId);
      const [row] = await db
        .select({
          userId: users.id,
          githubId: users.githubId,
          login: users.login,
          avatarUrl: users.avatarUrl,
          lastUsedAt: sessions.lastUsedAt,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.idHash, idHash),
            gt(sessions.expiresAt, at),
            gt(sessions.createdAt, later(at, -SESSION_MAX_MS)),
            // Disabling ends the sessions too; this is for one that got past that all the same.
            isNull(users.disabledAt),
          ),
        );
      if (!row) return undefined;
      const renewed = at.getTime() - row.lastUsedAt.getTime() >= SESSION_TOUCH_MS;
      let { expiresAt } = row;
      if (renewed) {
        // On by 30 days from now, but never past its longest life.
        const latest = later(row.createdAt, SESSION_MAX_MS);
        const next = later(at, SESSION_MS);
        expiresAt = next < latest ? next : latest;
        await db
          .update(sessions)
          .set({ lastUsedAt: at, expiresAt })
          .where(eq(sessions.idHash, idHash));
      }
      return {
        userId: row.userId,
        githubId: row.githubId,
        login: row.login,
        avatarUrl: row.avatarUrl,
        installed: await isInstalledFor(db, row.githubId),
        renewed,
        expiresAt,
        createdAt: row.createdAt,
      };
    },

    /**
     * Ends a session. With the last one of a person, their GitHub tokens go too: the next sign-in
     * gets new ones, and nothing needs them in between.
     */
    async logout(sessionId: string): Promise<void> {
      const idHash = hashOf(sessionId);
      const gone = await db.transaction(async (tx) => {
        const [session] = await tx
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(eq(sessions.idHash, idHash));
        if (!session) return [];
        // A sign-in at the same moment stores its tokens with this row locked: one of the two
        // waits, and the other sessions it counts are all there are.
        await tx
          .select({ userId: githubTokens.userId })
          .from(githubTokens)
          .where(eq(githubTokens.userId, session.userId))
          .for("update");
        await tx.delete(sessions).where(eq(sessions.idHash, idHash));
        const [other] = await tx
          .select({ idHash: sessions.idHash })
          .from(sessions)
          .where(and(eq(sessions.userId, session.userId), gt(sessions.expiresAt, now())))
          .limit(1);
        if (other) return [];
        return tx
          .delete(githubTokens)
          .where(eq(githubTokens.userId, session.userId))
          .returning({ userId: githubTokens.userId, accessToken: githubTokens.accessToken });
      });
      // Once it is gone from here: should taking it back fail, it is gone here all the same.
      await takeBack(gone);
    },

    /** The sign-up waiting in a browser: who GitHub says it is. */
    async signup(signupId: string) {
      const [row] = await db
        .select({ login: signups.login, avatarUrl: signups.avatarUrl, returnTo: signups.returnTo })
        .from(signups)
        .where(and(eq(signups.idHash, hashOf(signupId)), gt(signups.expiresAt, now())));
      return row;
    },

    /**
     * The invite code of a sign-up. Right, and the person has an account and a session; wrong,
     * and they can try again a few times. Someone who has an account by now needs no code.
     */
    async redeem(signupId: string, code: string, userAgent: string | undefined) {
      let disabledTokens: GitHubTokens | undefined;
      const attempt = async (): Promise<RedeemResult> => {
        disabledTokens = undefined;
        const at = now();
        const idHash = hashOf(signupId);
        return db.transaction(async (tx): Promise<RedeemResult> => {
          const [pending] = await tx
            .select()
            .from(signups)
            .where(and(eq(signups.idHash, idHash), gt(signups.expiresAt, at)))
            .for("update");
          if (!pending) return { kind: "expired" };
          const context = `signup:${pending.githubId}`;
          let tokens: GitHubTokens;
          try {
            tokens = {
              accessToken: sealer.open(pending.accessToken, "github-token", `access:${context}`),
              accessExpiresAt: pending.accessExpiresAt ?? undefined,
              refreshToken: pending.refreshToken
                ? sealer.open(pending.refreshToken, "github-token", `refresh:${context}`)
                : undefined,
              refreshExpiresAt: pending.refreshExpiresAt ?? undefined,
            };
          } catch (error) {
            if (!(error instanceof SealError)) throw error;
            // Sealed with a master key that is not there any more: what GitHub gave is no use, and
            // people sign in again.
            await tx.delete(signups).where(eq(signups.idHash, idHash));
            return { kind: "expired" };
          }
          // Locked like a sign-in locks it, see `finishLogin`.
          const [existing] = await tx
            .select({ id: users.id, disabledAt: users.disabledAt })
            .from(users)
            .where(eq(users.githubId, pending.githubId))
            .for("share");
          if (existing?.disabledAt) {
            // An account made in another browser meanwhile, and disabled since: this sign-up is
            // over, and signing in again says why.
            await tx.delete(signups).where(eq(signups.idHash, idHash));
            disabledTokens = tokens;
            return { kind: "expired" };
          }
          let userId = existing?.id;
          if (userId === undefined) {
            const admitted = await people.redeem(tx, code, at);
            if (!admitted) {
              const failures = pending.failures + 1;
              if (failures >= SIGNUP_MAX_FAILURES)
                await tx.delete(signups).where(eq(signups.idHash, idHash));
              else await tx.update(signups).set({ failures }).where(eq(signups.idHash, idHash));
              return { kind: "invalid", triesLeft: Math.max(0, SIGNUP_MAX_FAILURES - failures) };
            }
            const [user] = await tx
              .insert(users)
              .values({
                githubId: pending.githubId,
                login: pending.login,
                avatarUrl: pending.avatarUrl,
                createdAt: at,
              })
              .returning({ id: users.id });
            userId = user!.id;
            await admitted.onCreated(tx, userId);
          }
          const sessionId = await signInAs(tx, userId, tokens, userAgent, at);
          await tx.delete(signups).where(eq(signups.idHash, idHash));
          return { kind: "signedIn", sessionId, returnTo: pending.returnTo };
        });
      };
      let result: RedeemResult;
      try {
        result = await attempt();
      } catch (error) {
        // The same person signed up in another browser at this moment: that account is theirs, and
        // this goes in as a sign-in, without the code.
        if (!isUniqueViolation(error)) throw error;
        result = await attempt();
      }
      if (disabledTokens) await revokeNow(disabledTokens.accessToken);
      return result;
    },

    /**
     * Takes back on GitHub the tokens that went from here, such as with the sessions of someone an
     * admin signed out everywhere, see admin/users.ts. Never rejects: what fails is noted.
     */
    async revokeTokens(gone: readonly GoneTokens[]): Promise<void> {
      await takeBack(gone);
    },

    /** People would rather not sign in after all. Resolves to where they came from. */
    async cancelSignup(signupId: string): Promise<string> {
      const [gone] = await db
        .delete(signups)
        .where(eq(signups.idHash, hashOf(signupId)))
        .returning({ returnTo: signups.returnTo });
      return gone?.returnTo ?? HOME;
    },

    /**
     * Takes away what is over: sign-ins that never came back, sign-ups without a code, sessions
     * nobody used for 30 days or that reached their longest life, deliveries of webhooks a week
     * old, and the GitHub tokens of people with no session left, which are taken back on GitHub.
     * Tokens stored in the last minutes stay: a sign-in stores them just before its session.
     */
    async cleanUp() {
      const at = now();
      const attempts = await db.delete(loginAttempts).where(lt(loginAttempts.expiresAt, at));
      const waiting = await db.delete(signups).where(lt(signups.expiresAt, at));
      const ended = await db
        .delete(sessions)
        .where(or(lt(sessions.expiresAt, at), lt(sessions.createdAt, later(at, -SESSION_MAX_MS))));
      const live = db
        .select({ one: sql`1` })
        .from(sessions)
        .where(and(eq(sessions.userId, githubTokens.userId), gt(sessions.expiresAt, at)));
      const gone = await db
        .delete(githubTokens)
        .where(and(lt(githubTokens.updatedAt, later(at, -TOKEN_GRACE_MS)), notExists(live)))
        .returning({ userId: githubTokens.userId, accessToken: githubTokens.accessToken });
      const deliveries = await db
        .delete(webhookDeliveries)
        .where(lt(webhookDeliveries.receivedAt, later(at, -DELIVERY_KEEP_MS)));
      await takeBack(gone);
      return {
        loginAttempts: attempts.rowCount ?? 0,
        signups: waiting.rowCount ?? 0,
        sessions: ended.rowCount ?? 0,
        githubTokens: gone.length,
        deliveries: deliveries.rowCount ?? 0,
      };
    },
  };
};

export type Accounts = ReturnType<typeof createAccounts>;

/**
 * The person took the App's authorization back on GitHub: what we have of it does not work any
 * more, so it goes, and so do their sessions. Needs nothing but the database, so that it happens
 * also while nobody can sign in.
 */
export const revokedOnGitHub = async (db: Executor, githubId: number): Promise<void> => {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubId, githubId));
    if (user) await forgetAuthorization(tx, user.id);
    await tx.delete(signups).where(eq(signups.githubId, githubId));
  });
};

/**
 * For the session of a request: what goes into the answer, and nothing that is a secret. `id` is
 * the person on this platform, which the editor tells its links to projects here apart by: whose a
 * project in the browser is, where another person signs in.
 */
export const describeSignedIn = (signedIn: SignedIn, savesTo: SavesTo = "github") => ({
  status: "signedIn" as const,
  user: { id: signedIn.userId, login: signedIn.login, avatarUrl: signedIn.avatarUrl },
  app: { installed: signedIn.installed },
  repositories: savesTo,
});

/**
 * Where the projects of this server are saved: to GitHub (people choose a repository), to
 * repositories of the server's own (each project has one from the start), or nowhere.
 */
export type SavesTo = "github" | "local" | "none";
