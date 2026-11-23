import { BlockList, isIP } from "node:net";

/**
 * How often one address or one account can do something, such as starting a sign-in, in a window
 * of time. In memory: the API is one process, and after a restart everyone starts from nothing,
 * which costs little. It is there against floods and guessing, not as a quota.
 */
export class RateLimit {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #counts = new Map<string, { start: number; count: number }>();
  #lastSweep = 0;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Counts `count` more for `key`, one unless said. False when that is too many for now; what is
   * too many is not counted.
   */
  take(key: string, count = 1): boolean {
    const now = this.#now();
    this.#sweep(now);
    const entry = this.#counts.get(key);
    if (!entry || now - entry.start >= this.#windowMs) {
      if (count > this.#limit) return false;
      this.#counts.set(key, { start: now, count });
      return true;
    }
    if (count > 1 && entry.count + count > this.#limit) return false;
    entry.count += count;
    return entry.count <= this.#limit;
  }

  /** Seconds until `key` can go on, for Retry-After. */
  retryAfter(key: string): number {
    const entry = this.#counts.get(key);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.start + this.#windowMs - this.#now()) / 1000));
  }

  /** What is over is forgotten now and then, so that memory does not grow with every address. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;
    for (const [key, entry] of this.#counts)
      if (now - entry.start >= this.#windowMs) this.#counts.delete(key);
  }
}

/**
 * Addresses that are not someone on the internet: this machine, private networks (where Docker's
 * bridges are), link-local, shared address space, unique local IPv6. A request from one of them
 * says nothing about who sent it. Right now every IPv6 visitor arrives that way, through
 * docker-proxy, from the address of the bridge.
 */
const NOBODY = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  NOBODY.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  NOBODY.addSubnet(network, bits, "ipv6");

/** The eight groups of an IPv6 address, as numbers. Undefined for what is not one. */
const groupsOf = (address: string): number[] | undefined => {
  let text = address.split("%")[0]!.toLowerCase();
  // The last 32 bits written as IPv4, as in 64:ff9b::192.0.2.1.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const bytes = dotted[2]!.split(".").map(Number);
    text = `${dotted[1]}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const part = (half: string | undefined) => (half ? half.split(":") : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail];
  const numbers = all.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
};

/**
 * Who a request comes from, as far as limits go: an address on the internet, and for IPv6 its /64,
 * which is what one line gets. Undefined where the address says nothing, see NOBODY.
 */
export const clientOf = (address: string): string | undefined => {
  let ip = address.trim();
  if (/^::ffff:/i.test(ip) && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = isIP(ip);
  if (family === 4) return NOBODY.check(ip, "ipv4") ? undefined : ip;
  if (family !== 6 || NOBODY.check(ip, "ipv6")) return undefined;
  const groups = groupsOf(ip);
  if (!groups) return undefined;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};

export interface LimitRule {
  /** For each address on the internet, see `clientOf`. */
  readonly perClient: number;
  /**
   * For each thing a request carries where its address says nothing: the session, the sign-in on
   * its way, the sign-up, as the route has them.
   */
  readonly perOwn: number;
  /** For all requests whose address says nothing, together: a ceiling against a flood. */
  readonly ceiling: number;
}

/**
 * One kind of limit, counted by address where the address says who it is, and otherwise by what the
 * request carries, under a ceiling for all of those together: one person behind a shared address
 * must not use up everyone's turns.
 */
export class Limits {
  readonly #client: RateLimit;
  readonly #own: RateLimit;
  readonly #ceiling: RateLimit;

  constructor(rule: LimitRule, windowMs: number, now: () => number = Date.now) {
    this.#client = new RateLimit(rule.perClient, windowMs, now);
    this.#own = new RateLimit(rule.perOwn, windowMs, now);
    this.#ceiling = new RateLimit(rule.ceiling, windowMs, now);
  }

  /** Counts a request from `client` (see `clientOf`) carrying `own`. False: one too many. */
  take(client: string | undefined, own: string | undefined): boolean {
    if (client !== undefined) return this.#client.take(client);
    if (own !== undefined && !this.#own.take(own)) return false;
    return this.#ceiling.take("all");
  }

  /** Seconds to wait, for Retry-After: at most the window. */
  retryAfter(client: string | undefined, own: string | undefined): number {
    if (client !== undefined) return this.#client.retryAfter(client);
    return Math.max(
      own === undefined ? 0 : this.#own.retryAfter(own),
      this.#ceiling.retryAfter("all"),
    );
  }
}
