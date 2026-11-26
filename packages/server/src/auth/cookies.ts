/**
 * The cookies of signing in, on a site of its own over HTTPS: routes of the editor find and give the
 * session and the cookies of the way in through `SessionCredentials` (credentials.ts), whose
 * `HOSTED_CREDENTIALS` are these. All of them have the `__Host-` prefix, so that only this site, over
 * HTTPS, can set them, and no other site under the same domain can put one in front of ours. They
 * are HttpOnly, so that no script reads them, and SameSite=Lax, so that the way back from GitHub,
 * a top-level navigation, still brings them along.
 */

/** The session of a signed-in browser. */
export const SESSION_COOKIE = "__Host-aq_session";
/** The state of a sign-in on its way through GitHub, which has to come back to this browser. */
export const LOGIN_COOKIE = "__Host-aq_login";
/** Someone GitHub knows, waiting for an invite code, see `signups` in schema.ts. */
export const SIGNUP_COOKIE = "__Host-aq_signup";
/** Where to go back to after installing the App: GitHub comes back from that without a state. */
export const INSTALL_COOKIE = "__Host-aq_install";
/**
 * The session of the admin site, on its own host (see admin/sessions.ts), SameSite=Strict: nothing
 * there needs it to come along from another site, as the pages ask for everything themselves.
 */
export const ADMIN_COOKIE = "__Host-aq_admin";
/**
 * The admin site's cookie from setting out to taking the code of the way in, which the code is tied
 * to, see admin/sessions.ts. SameSite=Lax: the way back may come through GitHub, another site.
 */
export const ADMIN_STATE_COOKIE = "__Host-aq_admin_state";

/** The cookies of a request, the first of each name. */
export const readCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
};

/** Only values that need no escaping: what this API puts there is URL-safe base64. */
const SAFE_VALUE = /^[A-Za-z0-9_-]*$/;

export const setCookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  sameSite: "Lax" | "Strict" = "Lax",
): string => {
  if (!SAFE_VALUE.test(value)) throw new Error(`a value for ${name} that needs escaping`);
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=${sameSite}`;
};

export const clearCookie = (name: string, sameSite: "Lax" | "Strict" = "Lax"): string =>
  setCookie(name, "", 0, sameSite);

/** A value of ours, which is never anything else: whatever else a cookie holds is not there. */
export const ourValue = (value: string | undefined): string | undefined =>
  value !== undefined && /^[A-Za-z0-9_-]{16,512}$/.test(value) ? value : undefined;
