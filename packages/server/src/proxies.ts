import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Which peers the API takes X-Forwarded-For from: the gateway, and nobody else, so that nobody who
 * can reach the API another way can say which address they come from. The gateway is a name on the
 * Docker network, whose address changes when its container is made again:
 * names are looked up now and then, and again soon when a peer the API does not know turns up. An
 * address given as one is trusted as it is, like the loopback of the tests.
 */

export interface TrustedProxies {
  /** Whether a peer at this address is a proxy whose X-Forwarded-For is true. */
  trusts(address: string): boolean;
  /** Looks the names up again. Never rejects. */
  refresh(): Promise<void>;
  /** Resolves once a lookup on its way is done. */
  settled(): Promise<void>;
  stop(): void;
}

export interface TrustedProxiesOptions {
  readonly lookup?: (name: string) => Promise<readonly string[]>;
  /** How often names are looked up again. */
  readonly refreshMs?: number;
  /** How soon a peer the API does not know makes it look again. */
  readonly againMs?: number;
  readonly warn?: (message: string) => void;
}

/** The same address however the socket writes it: IPv4 in IPv6 as IPv4. */
const plain = (address: string) => {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
};

const lookupAll = async (name: string) =>
  (await dnsLookup(name, { all: true })).map((found) => found.address);

export const trustedProxies = (
  names: readonly string[],
  {
    lookup = lookupAll,
    refreshMs = 60_000,
    againMs = 5_000,
    warn = () => {},
  }: TrustedProxiesOptions = {},
): TrustedProxies => {
  const fixed = new Set(names.filter((name) => isIP(name) !== 0).map(plain));
  const hosts = names.filter((name) => isIP(name) === 0);
  let found = new Set<string>();
  let looking: Promise<void> | undefined;
  let lookedAt = 0;

  const refresh = (): Promise<void> => {
    if (looking) return looking;
    lookedAt = Date.now();
    looking = (async () => {
      const next = new Set<string>();
      for (const host of hosts) {
        try {
          for (const address of await lookup(host)) next.add(plain(address));
        } catch (error) {
          warn(
            `the proxy ${host} cannot be found (${error instanceof Error ? error.message : "?"}): its requests count by its own address`,
          );
        }
      }
      found = next;
    })().finally(() => {
      looking = undefined;
    });
    return looking;
  };

  const timer = hosts.length > 0 ? setInterval(() => void refresh(), refreshMs) : undefined;
  timer?.unref();
  if (hosts.length > 0) void refresh();

  return {
    trusts(address) {
      const peer = plain(address);
      if (fixed.has(peer) || found.has(peer)) return true;
      // The gateway may have come back with another address.
      if (hosts.length > 0 && Date.now() - lookedAt >= againMs) void refresh();
      return false;
    },
    refresh,
    settled: async () => {
      await looking;
    },
    stop: () => clearInterval(timer),
  };
};
