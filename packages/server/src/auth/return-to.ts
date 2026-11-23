/**
 * Where a sign-in goes back to: a page of this site, never anywhere else, so that nobody can make
 * the sign-in of this site a way to send people to theirs. What comes back of the sign-in goes
 * along in the address, see `withOutcome`, for the editor to tell people.
 */

const MAX_LENGTH = 2000;
export const HOME = "/";

/**
 * How a sign-in ended, as the editor hears of it in the `signIn` part of its address. "disabled": an
 * admin disabled the account.
 */
export type SignInOutcome =
  "ok" | "cancelled" | "failed" | "expired" | "busy" | "unavailable" | "disabled";
export const OUTCOME_PARAM = "signIn";

/**
 * The way from the editor into the admin site, see admin/sessions.ts: the one route of the API that a
 * sign-in can come back to, when that route started it to make the sign-in recent.
 */
export const ADMIN_HANDOFF_PATH = "/api/auth/admin";

/**
 * A path of this site to go back to, without its fragment, or the start page. Anything with a
 * host, another scheme, a backslash or a control character in it is not one, and neither is the API,
 * except, with `handoff`, the way into the admin site.
 */
export const safeReturnTo = (value: unknown, origin: string, { handoff = false } = {}): string => {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return HOME;
  // Browsers read a backslash as a slash, and "//x" is another host.
  // oxlint-disable-next-line no-control-regex -- control characters are what it looks for
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value))
    return HOME;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return HOME;
  }
  if (url.origin !== origin) return HOME;
  if (url.pathname.startsWith("/api/") && !(handoff && url.pathname === ADMIN_HANDOFF_PATH))
    return HOME;
  url.searchParams.delete(OUTCOME_PARAM);
  return url.pathname + url.search;
};

/**
 * The path with how the sign-in ended, for the editor there to say, or for the way into the admin
 * site, which only ever starts a sign-in itself: what a browser asks to go back to never is that.
 */
export const withOutcome = (path: string, outcome: SignInOutcome, origin: string): string => {
  const url = new URL(safeReturnTo(path, origin, { handoff: true }), origin);
  url.searchParams.set(OUTCOME_PARAM, outcome);
  return url.pathname + url.search;
};
