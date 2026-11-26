import type { IncomingHttpHeaders } from "node:http";
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

/**
 * How a browser shows which session it is, and how it is given one and has it taken away: the one
 * place that knows the names of the cookies of signing in and what they are written with. Every
 * route of the editor and the WebSocket of syncing find the session through this, never by a cookie
 * of their own. A deployment picks how (`Platform.credentials`):
 *
 * - on a site of its own over HTTPS, as the platform and a server of people's own are,
 *   `HOSTED_CREDENTIALS`: the cookies have the `__Host-` prefix and are `Secure`, see cookies.ts;
 * - the backend of `npx animaquill` on its own machine (online-offline.md, O4b) has another: over
 *   plain HTTP on `localhost`, its cookie cannot have the prefix, nor be `Secure`, and a cookie alone
 *   is not enough there, as other programs of the machine reach the same host. It takes a key of
 *   binding besides, which pages send in a header of their own, or for a WebSocket, where a page
 *   cannot add one, in `Sec-WebSocket-Protocol` (`socketProtocol`).
 */

/** The cookies of the way in through GitHub, besides the session. */
export type SignInCookie = "login" | "signup" | "install";

/** What of a request says who it is: as Fastify's request, and Node's of an upgrade, have it. */
export interface Carrying {
  readonly headers: IncomingHttpHeaders;
}

export interface SessionCredentials {
  /**
   * The session a request names, of HTTP or the upgrade to a WebSocket: undefined where it names
   * none, or not with everything this deployment takes a session by. Whether it is a session at
   * all, the database says (`Accounts.session`).
   */
  sessionOf(request: Carrying): string | undefined;
  /** What a request carries of one of the cookies of the way in, as it came. */
  cookieOf(request: Carrying, which: SignInCookie): string | undefined;
  /** The Set-Cookie that gives the browser `value` for `seconds`: of the session, or of the way in. */
  setCookie(which: "session" | SignInCookie, value: string, seconds: number): string;
  /** The Set-Cookie that takes it from the browser. */
  clearCookie(which: "session" | SignInCookie): string;
  /**
   * Where part of what shows the session comes in `Sec-WebSocket-Protocol`: the subprotocol the
   * WebSocket of syncing answers with, of those the page offered, or false to answer with none.
   * Undefined where nothing is taken from there: no subprotocol is answered, as before.
   */
  readonly socketProtocol?: ((offered: ReadonlySet<string>) => string | false) | undefined;
}

const NAMES: Readonly<Record<"session" | SignInCookie, string>> = {
  session: SESSION_COOKIE,
  login: LOGIN_COOKIE,
  signup: SIGNUP_COOKIE,
  install: INSTALL_COOKIE,
};

/**
 * A site of its own over HTTPS: the session is the cookie `__Host-aq_session`, `HttpOnly`,
 * `Secure`, `SameSite=Lax`, so that the way back from GitHub still brings it; so are the others.
 */
export const HOSTED_CREDENTIALS: SessionCredentials = {
  sessionOf: (request) => ourValue(readCookies(request.headers.cookie)[SESSION_COOKIE]),
  cookieOf: (request, which) => readCookies(request.headers.cookie)[NAMES[which]],
  setCookie: (which, value, seconds) => setCookie(NAMES[which], value, seconds),
  clearCookie: (which) => clearCookie(NAMES[which]),
};
