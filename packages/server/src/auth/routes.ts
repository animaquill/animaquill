import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { describeError } from "../database.ts";
import { hashOf } from "../seal.ts";
import {
  describeSignedIn,
  SESSION_MS,
  SIGNUP_MS,
  type Accounts,
  type LoginResult,
  type SavesTo,
} from "./accounts.ts";
import {
  clearCookie,
  INSTALL_COOKIE,
  LOGIN_COOKIE,
  ourValue,
  readCookies,
  SESSION_COOKIE,
  setCookie,
  SIGNUP_COOKIE,
} from "./cookies.ts";
import { fromThisSite } from "./guard.ts";
import { clientOf, Limits } from "./limits.ts";
import {
  ADMIN_HANDOFF_PATH,
  HOME,
  OUTCOME_PARAM,
  safeReturnTo,
  withOutcome,
  type SignInOutcome,
} from "./return-to.ts";

/**
 * Signing in, for the editor:
 *
 * - `GET /api/auth/github/start?returnTo=` leaves for GitHub, and `…/callback` comes back from it,
 *   to `returnTo` with `?signIn=<how it ended>`, or to the page for an invite code.
 * - `GET /api/auth/github/install?returnTo=` leaves for installing the App. GitHub comes back from
 *   that to the callback without a state, which starts a sign-in of our own.
 * - `GET /api/auth/session` says who is signed in: `user.id` is the person on this platform,
 *   `user.login` what GitHub calls them. `POST /api/auth/logout` signs out.
 * - `GET /api/auth/signup`, `POST /api/auth/signup` with `{ code }`, `POST …/signup/cancel`: the
 *   first sign-in of a person, with an invite code, from the page `/signup.html`.
 * - `GET /api/auth/admin?to=&state=` is the way into the admin site, see admin/sessions.ts: for an
 *   admin who signed in lately, on to the admin site with a code that signs them in there, in the
 *   browser that set out from there with `state`. Someone who did not sign in lately signs in through
 *   GitHub first, and comes back here.
 *
 * What changes anything takes requests from pages of this site only, see guard.ts. Nothing here puts
 * a token, a code or a state into the log or into an answer.
 */

export interface AuthRoutesOptions {
  readonly origin: string;
  /** Undefined while sign-in cannot work: no master key, the App not set up, no database yet. */
  readonly accounts: () => Accounts | undefined;
  /** Where people install the App, when it is set up. */
  readonly installUrl: () => string | undefined;
  /** A session ended: what it opened, such as connections for syncing, goes too. By its hash. */
  readonly signedOut?: (session: string) => void;
  /** The way into the admin site, when there is one. */
  readonly admin?: AdminHandoff | undefined;
  /** Where projects are saved, see `RepositoryService.savesTo`: GitHub unless said. */
  readonly savesTo?: () => SavesTo;
  readonly now?: () => number;
}

/** What the way into the admin site needs, see admin/sessions.ts. */
export interface AdminHandoff {
  /** The admin site. */
  readonly origin: string;
  /** How recent a sign-in it takes. */
  readonly signedInWithinMs: number;
  /**
   * A code for this person to sign in to the admin site with, in the browser whose cookie has the
   * hash `stateHash`, which goes on to `to` there; undefined when they are no admin.
   */
  readonly issue: (userId: string, to: string, stateHash: string) => Promise<string | undefined>;
  /** Where on the admin site going in starts, and where the code goes. */
  readonly signInPath: string;
  readonly claimPath: string;
  /** What `state` looks like: the hash of the admin site's cookie. */
  readonly stateHash: RegExp;
}

/**
 * How going into the admin site ended, when it did not get there, as its pages hear of it: those of
 * signing in, and "forbidden" for someone who is no admin.
 */
export type AdminOutcome = Exclude<SignInOutcome, "ok"> | "forbidden";
const ADMIN_OUTCOMES: ReadonlySet<string> = new Set<AdminOutcome>([
  "cancelled",
  "failed",
  "expired",
  "busy",
  "unavailable",
  "disabled",
  "forbidden",
]);

/** The page where someone without an account gives a code, a page of the editor's site. */
export const SIGNUP_PAGE = "/signup.html";

const TEN_MINUTES = 10 * 60 * 1000;
/** Where to go after installing the App, while that takes: an hour is plenty. */
const INSTALL_SECONDS = 60 * 60;

/** A path in a cookie: its characters are not all ones a cookie may have. */
const encodePath = (path: string) => Buffer.from(path, "utf8").toString("base64url");
const decodePath = (value: string | undefined) =>
  value && /^[A-Za-z0-9_-]{1,2800}$/.test(value)
    ? Buffer.from(value, "base64url").toString("utf8")
    : undefined;

const one = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 4096 ? value : undefined;

type Query = Record<string, unknown>;

export const authRoutes = async (app: FastifyInstance, options: AuthRoutesOptions) => {
  const { origin, accounts, installUrl } = options;
  // Signing out has nothing to say, whatever type the request gives it: an empty body is none.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 1024 },
    (_request, body, done) => {
      if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch {
        done(Object.assign(new Error("the body is not JSON"), { statusCode: 400 }), undefined);
      }
    },
  );
  const now = options.now ?? Date.now;
  const guard = fromThisSite(origin);
  /**
   * By the address of the browser where it says who that is; otherwise, as for every IPv6 visitor
   * through docker-proxy now, by what the request carries, under a ceiling: see `Limits`.
   */
  const limits = {
    /** Leaving for GitHub and coming back. */
    navigation: new Limits({ perClient: 30, perOwn: 10, ceiling: 300 }, TEN_MINUTES, now),
    /** Asking who is signed in, which the editor does when it opens and when people come back. */
    session: new Limits({ perClient: 300, perOwn: 120, ceiling: 6000 }, TEN_MINUTES, now),
    /** Invite codes: guessing them is what this is against. */
    signup: new Limits({ perClient: 10, perOwn: 10, ceiling: 100 }, TEN_MINUTES, now),
    /** Signing out, and giving up on signing up. */
    change: new Limits({ perClient: 60, perOwn: 30, ceiling: 600 }, TEN_MINUTES, now),
  };
  /** What a request carries, as a key of limits: never the value itself. */
  const ownOf = (value: string | undefined) =>
    value === undefined ? undefined : hashOf(value).toString("base64url").slice(0, 22);
  /** Takes a turn of `limit`. False when the request has to wait. */
  const allowed = (request: FastifyRequest, limit: Limits, own: string | undefined) =>
    limit.take(clientOf(request.ip), ownOf(own));

  const goBack = (
    reply: FastifyReply,
    returnTo: string,
    outcome: SignInOutcome,
    cookies: readonly string[] = [],
  ) => {
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    return reply.redirect(withOutcome(returnTo, outcome, origin), 303);
  };

  const busy = (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
    own: string | undefined,
  ) =>
    reply
      .code(429)
      .header("retry-after", String(limit.retryAfter(clientOf(request.ip), ownOf(own))))
      .send({ error: "busy" });

  const jar = (request: FastifyRequest) => readCookies(request.headers.cookie);

  /** Leaves for a sign-in of GitHub, which comes back to `returnTo`. */
  const leaveToSignIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
    work: Accounts,
    returnTo: string,
    cookies: readonly string[] = [],
  ) => {
    let start: Awaited<ReturnType<Accounts["startLogin"]>>;
    try {
      start = await work.startLogin(returnTo);
    } catch (error) {
      request.log.error({ err: describeError(error) }, "sign-in could not start");
      return goBack(reply, returnTo, "unavailable", cookies);
    }
    return reply
      .header("set-cookie", [...cookies, setCookie(LOGIN_COOKIE, start.state, start.maxAgeSeconds)])
      .redirect(start.url, 303);
  };

  app.get<{ Querystring: Query }>(
    "/api/auth/github/start",
    { config: { access: { none: "signing in" } } },
    async (request, reply) => {
      const returnTo = safeReturnTo(request.query.returnTo, origin);
      const own = ourValue(jar(request)[SESSION_COOKIE]);
      if (!allowed(request, limits.navigation, own)) return goBack(reply, returnTo, "busy");
      const work = accounts();
      if (!work) return goBack(reply, returnTo, "unavailable");
      return leaveToSignIn(request, reply, work, returnTo);
    },
  );

  app.get<{ Querystring: Query }>(
    "/api/auth/github/install",
    { config: { access: { none: "installing the GitHub App" } } },
    async (request, reply) => {
      const returnTo = safeReturnTo(request.query.returnTo, origin);
      const own = ourValue(jar(request)[SESSION_COOKIE]);
      if (!allowed(request, limits.navigation, own)) return goBack(reply, returnTo, "busy");
      const to = installUrl();
      if (!to || !accounts()) return goBack(reply, returnTo, "unavailable");
      return reply
        .header("set-cookie", setCookie(INSTALL_COOKIE, encodePath(returnTo), INSTALL_SECONDS))
        .redirect(to, 303);
    },
  );

  app.get<{ Querystring: Query }>(
    "/api/auth/github/callback",
    { config: { access: { none: "signing in" } } },
    async (request, reply) => {
      const query = request.query;
      const cookies = jar(request);
      const state = one(query.state);
      const installing = decodePath(cookies[INSTALL_COOKIE]);
      const own =
        ourValue(cookies[LOGIN_COOKIE]) ??
        (installing === undefined ? undefined : cookies[INSTALL_COOKIE]);
      if (!allowed(request, limits.navigation, own)) return goBack(reply, HOME, "busy");
      const work = accounts();

      // Back from installing the App, which GitHub does without our state. The code that comes with
      // it is not ours to use: anyone could have sent this browser here with a code of their own,
      // and signing in with it would sign the browser in as them. A sign-in of our own, with a
      // state, finds out who this is; GitHub lets it through without asking, as the App is
      // authorized already. Only when this browser left from here to install, though: otherwise a
      // link to this address would sign anyone in as whoever their browser is on GitHub, in place
      // of who they are here.
      if (query.setup_action !== undefined && state === undefined) {
        request.log.info({ setupAction: one(query.setup_action) ?? null }, "back from installing");
        if (installing === undefined) return reply.redirect(HOME, 303);
        const returnTo = safeReturnTo(installing, origin);
        const clear = [clearCookie(INSTALL_COOKIE)];
        if (!work) return goBack(reply, returnTo, "unavailable", clear);
        return leaveToSignIn(request, reply, work, returnTo, clear);
      }

      const clear = clearCookie(LOGIN_COOKIE);
      if (!work) return goBack(reply, HOME, "unavailable", [clear]);
      let result: LoginResult;
      try {
        result = await work.finishLogin({
          state,
          cookieState: ourValue(cookies[LOGIN_COOKIE]),
          code: one(query.code),
          error: one(query.error),
          userAgent: request.headers["user-agent"],
        });
      } catch (error) {
        request.log.error({ err: describeError(error) }, "sign-in failed");
        return goBack(reply, HOME, "failed", [clear]);
      }
      request.log.info(
        { signIn: result.kind === "failed" ? result.outcome : result.kind },
        "back from GitHub",
      );
      if (result.kind === "failed") return goBack(reply, result.returnTo, result.outcome, [clear]);
      if (result.kind === "signup") {
        return reply
          .header("set-cookie", [
            clear,
            setCookie(SIGNUP_COOKIE, result.signupId, SIGNUP_MS / 1000),
          ])
          .redirect(SIGNUP_PAGE, 303);
      }
      // A session that was here before is over: this browser is someone else's now, or theirs again.
      const before = ourValue(cookies[SESSION_COOKIE]);
      if (before) await work.logout(before).catch(() => {});
      return goBack(reply, result.returnTo, "ok", [
        clear,
        setCookie(SESSION_COOKIE, result.sessionId, SESSION_MS / 1000),
      ]);
    },
  );

  app.get(
    "/api/auth/session",
    { config: { access: { none: "who is signed in" } } },
    async (request, reply) => {
      const id = ourValue(jar(request)[SESSION_COOKIE]);
      // Without a session nothing needs the database: the editor asks this every time it opens.
      if (!id) return { status: "signedOut" };
      if (!allowed(request, limits.session, id)) return busy(request, reply, limits.session, id);
      const work = accounts();
      if (!work) return reply.code(503).send({ status: "unavailable" });
      const signedIn = await work.session(id);
      if (!signedIn) {
        return reply
          .header("set-cookie", clearCookie(SESSION_COOKIE))
          .send({ status: "signedOut" });
      }
      // The cookie lasts as long as the session, which has a longest life, see accounts.ts.
      if (signedIn.renewed) {
        const seconds = (signedIn.expiresAt.getTime() - now()) / 1000;
        reply.header("set-cookie", setCookie(SESSION_COOKIE, id, seconds));
      }
      return describeSignedIn(signedIn, options.savesTo?.() ?? "github");
    },
  );

  app.post(
    "/api/auth/logout",
    { config: { access: { none: "signing out" } }, preHandler: guard, bodyLimit: 1024 },
    async (request, reply) => {
      const id = ourValue(jar(request)[SESSION_COOKIE]);
      if (!allowed(request, limits.change, id)) return busy(request, reply, limits.change, id);
      const work = accounts();
      if (id && work) {
        try {
          await work.logout(id);
        } catch (error) {
          // The browser forgets the session all the same; the database lets it run out.
          request.log.error({ err: describeError(error) }, "signing out failed");
        }
      }
      if (id) options.signedOut?.(hashOf(id).toString("base64url"));
      return reply.header("set-cookie", clearCookie(SESSION_COOKIE)).code(204).send();
    },
  );

  const admin = options.admin;
  if (admin)
    // Not for HEAD, which nothing but a browser on its way has any business sending here.
    app.get<{ Querystring: Query }>(
      ADMIN_HANDOFF_PATH,
      { config: { access: { none: "the way into the admin site" } }, exposeHeadRoute: false },
      async (request, reply) => {
        // Only ever a page of the admin site, never anywhere else, nor its API.
        const to = safeReturnTo(request.query.to, admin.origin);
        // Going in starts on the admin site, which ties the code to the browser: without what it
        // gave for that, the browser goes there first, and comes back with it.
        const state = one(request.query["state"]);
        if (state === undefined || !admin.stateHash.test(state)) {
          const start = new URL(admin.signInPath, admin.origin);
          start.searchParams.set("to", to);
          return reply.redirect(start.href, 303);
        }
        const back = (outcome: AdminOutcome, cookies: readonly string[] = []) => {
          const url = new URL(to, admin.origin);
          url.searchParams.set(OUTCOME_PARAM, outcome);
          if (cookies.length > 0) reply.header("set-cookie", cookies);
          return reply.redirect(url.href, 303);
        };
        const id = ourValue(jar(request)[SESSION_COOKIE]);
        if (!allowed(request, limits.navigation, id)) return back("busy");
        const work = accounts();
        if (!work) return back("unavailable");
        let signedIn: Awaited<ReturnType<Accounts["session"]>>;
        try {
          signedIn = id ? await work.session(id) : undefined;
        } catch (error) {
          request.log.error({ err: describeError(error) }, "the way into the admin site failed");
          return back("unavailable");
        }
        // The cookie lasts as long as the session, as in /api/auth/session.
        const cookies =
          id && signedIn?.renewed
            ? [setCookie(SESSION_COOKIE, id, (signedIn.expiresAt.getTime() - now()) / 1000)]
            : [];
        if (signedIn && now() - signedIn.createdAt.getTime() < admin.signedInWithinMs) {
          let code: string | undefined;
          try {
            code = await admin.issue(signedIn.userId, to, state);
          } catch (error) {
            request.log.error({ err: describeError(error) }, "the way into the admin site failed");
            return back("unavailable", cookies);
          }
          request.log.info({ admin: code !== undefined }, "to the admin site");
          if (code === undefined) return back("forbidden", cookies);
          if (cookies.length > 0) reply.header("set-cookie", cookies);
          const claim = new URL(admin.claimPath, admin.origin);
          claim.searchParams.set("code", code);
          return reply.redirect(claim.href, 303);
        }
        // Back from signing in, and still no recent sign-in: that is how it ended, and it does not go
        // round again.
        const came = one(request.query[OUTCOME_PARAM]);
        if (came !== undefined)
          return back(ADMIN_OUTCOMES.has(came) ? (came as AdminOutcome) : "failed", cookies);
        // Not signed in, or long ago: through GitHub first, and back here.
        const here = `${ADMIN_HANDOFF_PATH}?to=${encodeURIComponent(to)}&state=${state}`;
        return leaveToSignIn(request, reply, work, here, cookies);
      },
    );

  app.get(
    "/api/auth/signup",
    { config: { access: { none: "the first sign-in" } } },
    async (request, reply) => {
      const id = ourValue(jar(request)[SIGNUP_COOKIE]);
      if (!allowed(request, limits.session, id)) return busy(request, reply, limits.session, id);
      const work = accounts();
      const pending = id && work ? await work.signup(id) : undefined;
      if (!pending) {
        return reply
          .header("set-cookie", clearCookie(SIGNUP_COOKIE))
          .code(404)
          .send({ error: "expired" });
      }
      return { login: pending.login, avatarUrl: pending.avatarUrl };
    },
  );

  app.post<{ Body: { code?: unknown } | undefined }>(
    "/api/auth/signup",
    { config: { access: { none: "the first sign-in" } }, preHandler: guard, bodyLimit: 1024 },
    async (request, reply) => {
      const id = ourValue(jar(request)[SIGNUP_COOKIE]);
      if (!allowed(request, limits.signup, id)) return busy(request, reply, limits.signup, id);
      const work = accounts();
      const code = request.body?.code;
      if (typeof code !== "string") return reply.code(400).send({ error: "invalid" });
      if (!id || !work) {
        return reply
          .header("set-cookie", clearCookie(SIGNUP_COOKIE))
          .code(410)
          .send({ error: "expired" });
      }
      const result = await work.redeem(id, code, request.headers["user-agent"]);
      request.log.info({ signup: result.kind }, "invite code");
      if (result.kind === "expired") {
        return reply
          .header("set-cookie", clearCookie(SIGNUP_COOKIE))
          .code(410)
          .send({ error: "expired" });
      }
      if (result.kind === "invalid") {
        if (result.triesLeft === 0) reply.header("set-cookie", clearCookie(SIGNUP_COOKIE));
        return reply.code(400).send({ error: "invalid", triesLeft: result.triesLeft });
      }
      return reply
        .header("set-cookie", [
          clearCookie(SIGNUP_COOKIE),
          setCookie(SESSION_COOKIE, result.sessionId, SESSION_MS / 1000),
        ])
        .send({ returnTo: withOutcome(result.returnTo, "ok", origin) });
    },
  );

  app.post(
    "/api/auth/signup/cancel",
    { config: { access: { none: "the first sign-in" } }, preHandler: guard, bodyLimit: 1024 },
    async (request, reply) => {
      const id = ourValue(jar(request)[SIGNUP_COOKIE]);
      if (!allowed(request, limits.change, id)) return busy(request, reply, limits.change, id);
      const work = accounts();
      const returnTo = id && work ? await work.cancelSignup(id) : HOME;
      return reply
        .header("set-cookie", clearCookie(SIGNUP_COOKIE))
        .send({ returnTo: withOutcome(returnTo, "cancelled", origin) });
    },
  );
};
