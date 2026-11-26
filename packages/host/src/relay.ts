/**
 * The relay of AI services, where the editor is hosted on a platform that has one: the browser
 * agent talks to services through it when they do not let a page read their answers (no CORS).
 * The browser sends the request to the platform, which passes it on to the service and the answer
 * back as it comes, and keeps none of it. Only for people signed in to the platform. In the offline
 * mode there is none, and services can only be reached straight.
 *
 * Node can use this file as well: the platform says why it did not pass a request on in the way
 * set here.
 */

export interface AiRelay {
  /**
   * The address to use in place of the address of a service, such as https://api.example.com/v1,
   * or undefined for an address the relay does not take. Requests go to what the service's own
   * address would have them go to, under this one. It has to keep the name of the service in it:
   * pi tells services apart by their address.
   */
  addressOf(baseUrl: string): string | undefined;
  /** What goes with every request through the relay, besides what the service needs. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Where the relay of a server (`@animaquill/server`, relay/target.ts) takes a service: one at
 * https://<name>/<path> is at /api/llm-relay/https/<name>/<path> of the editor's site, which keeps
 * the name of the service in the address, as pi needs. It takes https on its port only, and names
 * only, which `relayAddressOf` says before anything is sent. The server's tests check that it takes
 * what this makes (relay/address.test.ts there).
 */
export const RELAY_SERVICE_PATH = "/api/llm-relay/https/";

/** The address of a service through the relay at `origin`, or undefined for one it does not take. */
export function relayAddressOf(baseUrl: string, origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password)
    return undefined;
  if (url.search || url.hash) return undefined;
  // An address written as numbers, IPv6 in brackets or IPv4, which the relay does not go to.
  if (url.hostname.startsWith("[") || /^[\d.]+$/.test(url.hostname)) return undefined;
  return `${origin}${RELAY_SERVICE_PATH}${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Why the relay did not pass a request on, or did not finish it:
 *
 * - `off`: it is turned off on the platform.
 * - `forbidden`: the request did not come from a page of the editor.
 * - `signedOut`: nobody is signed in.
 * - `unavailable`: the platform cannot do it right now.
 * - `badTarget`: not an address it takes: only https, on port 443, to a name.
 * - `method`: not a request it passes on.
 * - `tooLarge`: the request is larger than it takes.
 * - `busy`: too many requests, of this person or of everyone.
 * - `blocked`: the name is the platform's own.
 * - `unreachable`: the service could not be reached: its name is not there, or points somewhere
 *   that is not on the internet (said the same way, so that nobody learns through the relay which
 *   names there are inside), or its certificate is not right.
 * - `timeout`: the service took too long.
 * - `redirect`: the service sent the request elsewhere, which the relay does not follow.
 * - `failed`: anything else.
 */
export const RELAY_REFUSALS = [
  "off",
  "forbidden",
  "signedOut",
  "unavailable",
  "badTarget",
  "method",
  "tooLarge",
  "busy",
  "blocked",
  "unreachable",
  "timeout",
  "redirect",
  "failed",
] as const;

export type RelayRefusal = (typeof RELAY_REFUSALS)[number];

const MARK = "aq-relay:";

/**
 * What the relay answers in place of the service: JSON that the library of every service shows in
 * its error, with `aq-relay:<why>` in the message so that the editor can tell it from the service.
 */
export const relayRefusalBody = (why: RelayRefusal, details: string) => ({
  error: { type: "aq_relay", code: why, message: `${MARK}${why} ${details}` },
});

/** Why the relay did not pass a request on, as an error about it says, if it was the relay. */
export function relayRefusalIn(text: string): RelayRefusal | undefined {
  const said = new RegExp(`${MARK}([A-Za-z]+)`).exec(text)?.[1];
  return RELAY_REFUSALS.find((why) => why === said);
}

/**
 * What headers of people's own (a service's or a model's, see the AI settings) are called on their
 * way through the relay: the relay passes on only the headers that the libraries of services send,
 * and these with the prefix taken off, as long as they are not of this site or the connection.
 */
export const RELAY_PASS_PREFIX = "aq-pass-";

/** People's own headers, as they go to the relay, see `RELAY_PASS_PREFIX`. */
export function relayPassHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      `${RELAY_PASS_PREFIX}${name.toLowerCase()}`,
      value,
    ]),
  );
}
