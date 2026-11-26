import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { ourValue, readCookies } from "./cookies.ts";
import type { Carrying, SessionCredentials, SignInCookie } from "./credentials.ts";

/**
 * How the backend of `npx animaquill` knows the browser of the person who started it (design O4 of
 * AnimaQuill Cloud, section 2). It answers on `http://animaquill.localhost:<port>`, plain HTTP, so
 * its cookies cannot be `__Host-` nor `Secure`; and a cookie is not enough there: browsers send a
 * cookie of `animaquill.localhost` to every port of it, where another program of this machine (of
 * another user, say) may listen and take it. So a session takes two things:
 *
 * - the cookie `aq_local`, HttpOnly, SameSite=Strict;
 * - its key of binding, which the page was given with it and keeps in its storage, which is of its
 *   own port: in the header `x-animaquill-binding` of every request, and for the WebSocket of
 *   syncing, where a page cannot add a header, as a subprotocol `animaquill.binding.<key>` besides
 *   `animaquill.v1`, the only one the server answers with.
 *
 * The key is an HMAC of the session with a secret of the backend (`bindingSecretOf`), so nothing
 * more is kept for it. `x-animaquill: 1`, which says a request comes from a page of this site
 * (auth/guard.ts), stays what it is besides.
 */

export const LOCAL_SESSION_COOKIE = "aq_local";
export const BINDING_HEADER = "x-animaquill-binding";
/** The subprotocol of syncing, which the server answers with. */
export const SYNC_PROTOCOL = "animaquill.v1";
/** What the subprotocol with the key of binding starts with. */
export const BINDING_PROTOCOL = "animaquill.binding.";

const NAMES: Readonly<Record<"session" | SignInCookie, string>> = {
  session: LOCAL_SESSION_COOKIE,
  login: "aq_local_login",
  signup: "aq_local_signup",
  install: "aq_local_install",
};

/** The secret the keys of binding are made with, from the master key: it lasts as long as that. */
export const bindingSecretOf = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "animaquill local binding v1", 32));

/** The key of binding of a session. */
export const bindingOf = (secret: Buffer, session: string): string =>
  createHmac("sha256", secret).update(session).digest("base64url");

const KEY = /^[A-Za-z0-9_-]{43}$/;

/** The key of binding a request brings: in its header, or for a WebSocket among its subprotocols. */
const bindingIn = (headers: IncomingHttpHeaders): string | undefined => {
  const header = headers[BINDING_HEADER];
  if (typeof header === "string") return KEY.test(header) ? header : undefined;
  const offered = headers["sec-websocket-protocol"];
  if (typeof offered !== "string") return undefined;
  const found = offered
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith(BINDING_PROTOCOL))
    ?.slice(BINDING_PROTOCOL.length);
  return found !== undefined && KEY.test(found) ? found : undefined;
};

const cookie = (name: string, value: string, seconds: number, sameSite: "Strict" | "Lax") => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error(`a value for ${name} that needs escaping`);
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(seconds))}; HttpOnly; SameSite=${sameSite}`;
};

/**
 * The credentials of the backend of `npx animaquill`, with the secret of its keys of binding. The
 * cookies of the way in through GitHub are SameSite=Lax, as the way back from GitHub has to bring
 * them; the session is Strict.
 */
export const localCredentials = (secret: Buffer): SessionCredentials => ({
  sessionOf(request: Carrying) {
    const session = ourValue(readCookies(request.headers.cookie)[LOCAL_SESSION_COOKIE]);
    const given = bindingIn(request.headers);
    if (!session || !given) return undefined;
    const right = Buffer.from(bindingOf(secret, session));
    const said = Buffer.from(given);
    return said.length === right.length && timingSafeEqual(said, right) ? session : undefined;
  },
  cookieOf: (request, which) => readCookies(request.headers.cookie)[NAMES[which]],
  setCookie: (which, value, seconds) =>
    cookie(NAMES[which], value, seconds, which === "session" ? "Strict" : "Lax"),
  clearCookie: (which) => cookie(NAMES[which], "", 0, which === "session" ? "Strict" : "Lax"),
  socketProtocol: (offered) => (offered.has(SYNC_PROTOCOL) ? SYNC_PROTOCOL : false),
});
