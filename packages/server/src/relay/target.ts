import { isIP } from "node:net";

/**
 * Where a request to the relay goes: `/api/llm-relay/https/<name>/<path>?<query>`, which the
 * editor makes of the address of a service. Only https, and only on its
 * port, 443: the address cannot even say another one. Only a name, never an address written as
 * numbers, and only a name that can be on the internet.
 */

export const RELAY_PATH = "/api/llm-relay/";

export interface Target {
  /** The name of the service, in lower case: what DNS, TLS and the Host header get. */
  readonly hostname: string;
  /** The path and query, exactly as the editor sent them. */
  readonly path: string;
}

/** Longer than any name DNS has. */
const MAX_NAME = 253;
/** A path of a service is short; this is against what is not one. */
const MAX_PATH = 8192;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Letters, or an internationalized name: one of digits would be an address. */
const TOP_LEVEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Names that are this machine or a network of its own, whatever they resolve to. */
const LOCAL_ENDINGS = ["localhost", "local", "internal", "arpa", "onion"];

/**
 * The name as the relay goes to it, or undefined: a single label (Docker's names of services, such
 * as `db`), an address written in any way, an empty label (a dot at the end), or a local name.
 */
export function checkHostname(text: string): string | undefined {
  if (text.length === 0 || text.length > MAX_NAME) return undefined;
  const name = text.toLowerCase();
  if (isIP(name) !== 0) return undefined;
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  const last = labels.at(-1)!;
  if (!TOP_LEVEL.test(last) || LOCAL_ENDINGS.includes(last)) return undefined;
  return name;
}

/** The service a request is for, from the address it came to as the browser wrote it. */
export function targetOf(url: string): Target | undefined {
  if (!url.startsWith(RELAY_PATH)) return undefined;
  const match = /^https\/([^/?#]*)([^#]*)$/.exec(url.slice(RELAY_PATH.length));
  if (!match) return undefined;
  const hostname = checkHostname(match[1]!);
  const rest = match[2]!;
  if (!hostname || rest.length > MAX_PATH) return undefined;
  // Nothing that is not printable ASCII, which Node would not send anyway.
  if (!/^[\x21-\x7e]*$/.test(rest)) return undefined;
  return { hostname, path: rest.startsWith("/") ? rest : `/${rest}` };
}
