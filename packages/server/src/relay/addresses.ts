import { isIP } from "node:net";

/**
 * Which addresses the relay of AI services may connect to: only someone on the internet. A request
 * of a browser must never reach what is around the platform instead: this machine, Docker's
 * networks and the database on them, the metadata service of the cloud, the gateway in front of the
 * platform (and through it what else it serves, and the platform itself). The containers of AI
 * tasks will go out by the same rule (egress).
 *
 * Only an address as `net.isIP` takes it is one: what else a resolver or a URL parser would read as
 * one (`2130706433`, `0x7f.1`, `0177.0.0.1`) is not, and is refused. An IPv6 address that carries an
 * IPv4 one (`::ffff:127.0.0.1`, and NAT64's `64:ff9b::7f00:1`) is judged by that IPv4 address,
 * which is where a connection to it goes.
 */

export type Family = 4 | 6;

/** An address that may be connected to, written the way to connect to it. */
export interface PublicAddress {
  readonly address: string;
  readonly family: Family;
}

interface Network {
  readonly family: Family;
  readonly base: bigint;
  readonly bits: number;
}

const WIDTH: Record<Family, number> = { 4: 32, 6: 128 };

const ipv4 = (text: string): bigint | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
};

const ipv6 = (text: string): bigint | undefined => {
  let rest = text.toLowerCase();
  // The last 32 bits written as IPv4, as in ::ffff:192.0.2.1.
  const low: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (dotted) {
    const value = ipv4(dotted[2]!);
    if (value === undefined) return undefined;
    low.push(Number(value >> 16n), Number(value & 0xffffn));
    rest = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - low.length - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  for (const group of low) value = (value << 16n) | BigInt(group);
  return value;
};

/** An address as a number, or undefined for what `net.isIP` does not take, or with a zone. */
export const parseAddress = (
  text: string,
): { readonly family: Family; readonly value: bigint } | undefined => {
  // A zone (fe80::1%eth0) is a link of this machine, whatever the address.
  if (text.includes("%")) return undefined;
  const family = isIP(text);
  if (family === 4) {
    const value = ipv4(text);
    return value === undefined ? undefined : { family, value };
  }
  if (family === 6) {
    const value = ipv6(text);
    return value === undefined ? undefined : { family, value };
  }
  return undefined;
};

/** A network written as `address/bits`, or one address. Throws on anything else. */
export const parseNetwork = (text: string): Network => {
  const [address = "", bits, ...more] = text.trim().split("/");
  const parsed = parseAddress(address);
  if (!parsed || more.length > 0) throw new Error(`not a network: ${text}`);
  const width = WIDTH[parsed.family];
  const length = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
  if (length < 0 || length > width) throw new Error(`not a network: ${text}`);
  const shift = BigInt(width - length);
  return { family: parsed.family, base: (parsed.value >> shift) << shift, bits: length };
};

const inside = (network: Network, family: Family, value: bigint) => {
  if (network.family !== family) return false;
  const shift = BigInt(WIDTH[family] - network.bits);
  return value >> shift === network.base >> shift;
};

/** A set of networks, such as the platform's own addresses. */
export class Networks {
  readonly #networks: Network[] = [];

  constructor(networks: Iterable<string> = []) {
    for (const network of networks) this.add(network);
  }

  /** Throws on what is not a network. */
  add(network: string): void {
    this.#networks.push(parseNetwork(network));
  }

  has(address: string): boolean {
    const parsed = parseAddress(address);
    return (
      parsed !== undefined &&
      this.#networks.some((network) => inside(network, parsed.family, parsed.value))
    );
  }

  get size(): number {
    return this.#networks.length;
  }
}

/**
 * IPv4 that is not someone on the internet: the special-purpose registry of IANA, multicast and
 * what is reserved. Each of these is either this machine, a network of its own, or nowhere.
 */
export const NOT_ON_THE_INTERNET_V4: readonly string[] = [
  "0.0.0.0/8", // "this network": 0.0.0.0 is this machine
  "10.0.0.0/8", // private
  "100.64.0.0/10", // shared address space, behind the NAT of a carrier
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, with the metadata service of clouds at 169.254.169.254
  "172.16.0.0/12", // private, where Docker's networks are
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // relays of 6to4, retired
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, and the broadcast address
];

/**
 * IPv6 on the internet is in 2000::/3 and nowhere else, which leaves out the loopback, link-local,
 * unique local and multicast networks, and the old IPv4-compatible addresses. Inside it these are
 * not someone on the internet either, or carry an IPv4 address that could be anything.
 */
const GLOBAL_V6 = "2000::/3";
export const NOT_ON_THE_INTERNET_V6: readonly string[] = [
  "2001::/23", // IETF protocol assignments, with Teredo (2001::/32), which carries IPv4
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, which carries IPv4
  "3fff::/20", // documentation
];

const notOnTheInternet = new Networks([...NOT_ON_THE_INTERNET_V4, ...NOT_ON_THE_INTERNET_V6]);
const globalV6 = parseNetwork(GLOBAL_V6);
/** IPv6 that carries an IPv4 address in its last 32 bits, which is where it goes. */
const CARRIERS = [parseNetwork("::ffff:0:0/96"), parseNetwork("64:ff9b::/96")];

const dottedOf = (value: bigint) =>
  [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");

/**
 * Whether an address may be connected to, and how: undefined for what is not an address, not on
 * the internet, or among `own`, the addresses of the platform itself. An IPv4-mapped address comes
 * back as the IPv4 address it is.
 */
export function publicAddress(text: string, own?: Networks): PublicAddress | undefined {
  const parsed = parseAddress(text);
  if (!parsed) return undefined;
  if (parsed.family === 6) {
    const carrier = CARRIERS.find((network) => inside(network, 6, parsed.value));
    if (carrier) {
      const v4 = dottedOf(parsed.value & 0xffffffffn);
      if (!publicAddress(v4, own) || own?.has(text)) return undefined;
      // NAT64 is reached as IPv6, through the translator; a mapped address is IPv4 itself.
      return carrier === CARRIERS[0] ? { address: v4, family: 4 } : { address: text, family: 6 };
    }
    if (!inside(globalV6, 6, parsed.value)) return undefined;
  }
  if (notOnTheInternet.has(text) || own?.has(text)) return undefined;
  return { address: text, family: parsed.family };
}
