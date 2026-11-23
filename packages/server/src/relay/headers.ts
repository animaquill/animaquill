import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { RELAY_PASS_PREFIX } from "@animaquill/host/relay";

/**
 * What crosses the relay besides the bodies: only what the libraries of services in the editor send
 * and read, and the headers people set for a service or a model of theirs (`aq-pass-<name>`), never
 * what belongs to this site. The browser sends the relay this site's cookies, its Origin, and the
 * header that says a request comes from its page: none of that goes on, and neither do the
 * gateway's headers about the browser. What comes back is the service's answer, which must not get
 * to set anything of this site: no cookies, no redirects, no `Clear-Site-Data`, no prompt for a
 * password.
 */

/** Request headers that go on to the service, by name in lower case. */
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  // The keys of services, as each of them takes it.
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-goog-api-client",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "idempotency-key",
  // Who is asking, as OpenRouter wants to know.
  "http-referer",
  "x-title",
]);
/** What the libraries of OpenAI and Anthropic say about themselves. */
const REQUEST_PREFIXES = ["x-stainless-"];

/** Never, whatever the lists above come to say: this site's, the gateway's, or the connection's. */
const NEVER = new Set([
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "x-animaquill",
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "x-client-ip",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "accept-encoding",
]);
const NEVER_PREFIXES = ["x-forwarded-", "sec-", "x-aq-", "x-animaquill-", "aq-"];

/** Answer headers that come back to the browser, besides the type, see `answerTypeOf`. */
const ANSWER_HEADERS = new Set([
  "content-encoding",
  "retry-after",
  "request-id",
  "x-request-id",
  "openai-processing-ms",
  "openai-version",
  "x-should-retry",
]);
/** How much of their limits people have left, which the libraries read to wait before trying again. */
const ANSWER_PREFIXES = ["x-ratelimit-", "anthropic-ratelimit-", "ratelimit"];

/** What the relay is to services. */
export const RELAY_USER_AGENT = "AnimaQuill-Relay/1";

/**
 * What every answer of the relay says, the service's and the relay's own: it is something for the
 * page to read with `fetch`, never a page of this site that runs anything, nor what a page elsewhere
 * may load. The gateway adds `nosniff`.
 */
export const ANSWER_POLICY = {
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
} as const;

/** The types of answers the libraries of services read; anything else is only bytes. */
const ANSWER_TYPES = [
  /^application\/(?:[a-z0-9.+-]+\+)?json$/,
  /^application\/(?:x-)?ndjson$/,
  /^text\/event-stream$/,
  /^text\/plain$/,
];

/**
 * The type of an answer as the browser gets it: as the service said, if it is one of those. One
 * type only: of several, joined with commas, browsers take the last.
 */
export function answerTypeOf(value: string | undefined): string {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    value !== undefined &&
    !value.includes(",") &&
    ANSWER_TYPES.some((pattern) => pattern.test(type)) &&
    printable(value)
  )
    return value;
  return "application/octet-stream";
}

/** What Node writes into a header as it is: visible ASCII, spaces and tabs. */
const printable = (value: string) => /^[\t\x20-\x7e]*$/.test(value);

const passes = (name: string, exact: ReadonlySet<string>, prefixes: readonly string[]) =>
  exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));

const valueOf = (value: string | string[] | number | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value.join(", ") : String(value);

/**
 * The headers of the request to the service: those of the browser that are on the list, and none
 * of what is never passed on. The body goes as it came, uncompressed answers are asked for so that
 * what comes back can be counted, and Host is the service's.
 */
export function requestHeadersFor(
  incoming: IncomingHttpHeaders,
  hostname: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const own: OutgoingHttpHeaders = {};
  for (const [raw, value] of Object.entries(incoming)) {
    const lower = raw.toLowerCase();
    // People's own headers go on under their own name, as long as it is none of the never.
    const passed = lower.startsWith(RELAY_PASS_PREFIX);
    const name = passed ? lower.slice(RELAY_PASS_PREFIX.length) : lower;
    if (name === "" || name === "user-agent") continue;
    if (NEVER.has(name) || NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (!passed && !passes(name, REQUEST_HEADERS, REQUEST_PREFIXES)) continue;
    const text = valueOf(value);
    if (text === undefined || !printable(text)) continue;
    if (passed) own[name] = text;
    else headers[name] = text;
  }
  // What the libraries send wins over what people set, which cannot stand in for a key.
  for (const [name, value] of Object.entries(own)) if (!(name in headers)) headers[name] = value;
  headers["host"] = hostname;
  headers["user-agent"] = RELAY_USER_AGENT;
  headers["accept-encoding"] = "identity";
  return headers;
}

/**
 * The headers of the service's answer that the browser gets: those on the list, with values Node can
 * write as they are (its parser takes more than its writer does), and the type, see `answerTypeOf`.
 */
export function answerHeadersOf(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [raw, value] of Object.entries(incoming)) {
    const name = raw.toLowerCase();
    if (!passes(name, ANSWER_HEADERS, ANSWER_PREFIXES)) continue;
    const text = valueOf(value);
    if (text !== undefined && printable(text)) headers[name] = text;
  }
  headers["content-type"] = answerTypeOf(valueOf(incoming["content-type"]));
  return headers;
}
