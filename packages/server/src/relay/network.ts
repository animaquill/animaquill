import { Resolver } from "node:dns/promises";
import { Agent } from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { RelayRefusal } from "@animaquill/host/relay";
import { Networks, parseAddress, publicAddress, type PublicAddress } from "./addresses.ts";

/**
 * How the relay reaches services. Names are looked up once for each connection, every address that
 * comes back is checked, and the connection goes to exactly those addresses: a name that answers
 * with an address on the internet the first time and with one inside the second (DNS rebinding)
 * never gets the second asked for. TLS still checks the certificate against the name.
 *
 * The relay asks DNS servers itself, those of the system, for A and AAAA, with short timeouts and a
 * deadline. Never getaddrinfo: that runs in the pool of threads Node shares with files, crypto and
 * the lookups of the database, and cannot be stopped, so a few names whose servers never answer
 * would hold up the whole API. This way it does not read /etc/hosts, which it has no use for.
 *
 * Connections are kept for a moment for the next request to the same service, the way a browser
 * keeps them: an AI task asks the service again right after each of its tools. A request that is
 * stopped takes its connection down with it.
 */

/** The relay did not pass a request on, and says why. */
export class RelayRefused extends Error {
  override name = "RelayRefused";
  readonly why: RelayRefusal;
  constructor(why: RelayRefusal, message: string) {
    super(message);
    this.why = why;
  }
}

/** Where the relay finds services and how it gets to them. Only tests change it. */
export interface RelayNetwork {
  /** Every address a name has now, as DNS says. */
  resolve(hostname: string): Promise<readonly string[]>;
  /** The port of services: always 443, but for tests, whose servers cannot have it. */
  readonly port?: number;
  /**
   * Where a connection to a checked address really goes. Only tests: their servers on this machine
   * stand in for services on the internet.
   */
  readonly reroute?: (address: string) => string;
  /** Certificates to trust in place of the usual ones. Only tests. */
  readonly ca?: string;
}

/** What a lookup that found nothing says, as Node's own would. */
const notFound = (hostname: string) =>
  Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND", hostname });

export interface ResolverOptions {
  /** The DNS servers to ask, such as "127.0.0.1:5353": the system's unless given. */
  readonly servers?: readonly string[];
  /** How long one try waits for an answer, and the longest wait between tries. */
  readonly timeoutMs?: number;
  /** How many times each server is asked. */
  readonly tries?: number;
  /** How long a lookup takes at the most, whatever the servers do. */
  readonly deadlineMs?: number;
  /** Names looked up at once, for all requests together. More are turned away at once. */
  readonly lookups?: number;
}

/** Lookups whose answers are no use, which say why in the same words. */
const failedLookup = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Looks names up by asking DNS servers, see above: about four seconds at the most for a server that
 * never answers (two tries of two seconds), IPv4 and IPv6 at the same time.
 */
export function resolverNetwork({
  servers,
  timeoutMs = 2000,
  tries = 2,
  deadlineMs = 5000,
  lookups = 16,
}: ResolverOptions = {}): RelayNetwork {
  let running = 0;
  return {
    async resolve(hostname) {
      if (running >= lookups)
        throw failedLookup("EBUSY", "the relay is looking up too many names at once");
      running += 1;
      // One for each lookup, so that its deadline cancels its own questions and nothing else.
      const resolver = new Resolver({ timeout: timeoutMs, tries, maxTimeout: timeoutMs });
      if (servers) resolver.setServers([...servers]);
      let late = false;
      const deadline = setTimeout(() => {
        late = true;
        resolver.cancel();
      }, deadlineMs);
      try {
        const [v4, v6] = await Promise.allSettled([
          resolver.resolve4(hostname),
          resolver.resolve6(hostname),
        ]);
        const found = [v4, v6].flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        if (found.length > 0) return found;
        if (late) throw failedLookup("ETIMEOUT", `${hostname} took too long to look up`);
        // Nothing found: not there, unless the servers could not say.
        const codes = [v4, v6].map((result) =>
          result.status === "rejected"
            ? String((result.reason as NodeJS.ErrnoException).code ?? "")
            : "ENODATA",
        );
        const failing = codes.find((code) => code !== "ENOTFOUND" && code !== "ENODATA");
        if (failing === "ETIMEOUT" || failing === "ECANCELLED")
          throw failedLookup("ETIMEOUT", `${hostname} took too long to look up`);
        if (failing) throw failedLookup(failing, `${hostname} could not be looked up`);
        throw notFound(hostname);
      } finally {
        clearTimeout(deadline);
        running -= 1;
      }
    },
  };
}

/** How the relay finds services on the platform. */
export const systemNetwork: RelayNetwork = resolverNetwork();

/**
 * The platform's own addresses, which the relay must not reach either although they are on the
 * internet: the gateway is there, with everything behind it. They are what its own names resolve
 * to, looked up again now and then, the networks of this machine, and whatever the configuration
 * adds. Until each name has been found once the relay does not go anywhere: the first request
 * looks them up.
 */
export class OwnAddresses {
  readonly #names: readonly string[];
  readonly #fixed: readonly string[];
  readonly #resolve: (hostname: string) => Promise<readonly string[]>;
  readonly #warn: (message: string) => void;
  #found = new Map<string, readonly string[]>();
  #networks: Networks;
  #timer: ReturnType<typeof setInterval> | undefined;
  #looking: Promise<void> | undefined;
  readonly #refreshMs: number;

  constructor(options: {
    /** The names of the platform, such as editor.example.com, or its addresses. */
    readonly names: readonly string[];
    /** Networks and addresses, such as the public ones of the server. */
    readonly networks: readonly string[];
    readonly resolve: (hostname: string) => Promise<readonly string[]>;
    readonly refreshMs?: number;
    readonly warn?: (message: string) => void;
  }) {
    this.#names = options.names.filter((name) => isIP(name) === 0);
    this.#fixed = [...options.networks, ...options.names.filter((name) => isIP(name) !== 0)];
    this.#resolve = options.resolve;
    this.#warn = options.warn ?? (() => {});
    this.#networks = this.#networksOf(this.#fixed);
    this.#refreshMs = options.refreshMs ?? 10 * 60_000;
  }

  /** Whether every name was found at least once. */
  get ready(): boolean {
    return this.#names.every((name) => this.#found.has(name));
  }

  /**
   * Looks the names up again, and from the first time on every few minutes. A name that cannot be
   * found now keeps what it had. Never rejects.
   */
  refresh(): Promise<void> {
    if (this.#timer === undefined && this.#names.length > 0) {
      this.#timer = setInterval(() => void this.refresh(), this.#refreshMs);
      this.#timer.unref?.();
    }
    this.#looking ??= (async () => {
      for (const name of this.#names) {
        try {
          // Only what is an address: a scoped one (fe80::1%eth0) is of this machine anyway.
          const addresses = (await this.#resolve(name)).filter((address) => parseAddress(address));
          if (addresses.length > 0) this.#found.set(name, addresses);
        } catch (error) {
          this.#warn(
            `the relay cannot look up ${name}, an address of the platform (${error instanceof Error ? error.message : "?"})`,
          );
        }
      }
      this.#networks = this.#networksOf([...this.#fixed, ...[...this.#found.values()].flat()]);
    })().finally(() => {
      this.#looking = undefined;
    });
    return this.#looking;
  }

  /** The networks, leaving out what is not one, which the log hears of. */
  #networksOf(list: readonly string[]): Networks {
    const networks = new Networks();
    for (const network of list) {
      try {
        networks.add(network);
      } catch {
        this.#warn(`the relay leaves out ${network}, which is not a network`);
      }
    }
    return networks;
  }

  /** Whether a name is one of the platform's own. */
  isName(hostname: string): boolean {
    return this.#names.includes(hostname.toLowerCase());
  }

  get networks(): Networks {
    return this.#networks;
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}

/** The networks this machine is on, such as Docker's, apart from the loopback. */
export function interfaceNetworks(): string[] {
  const networks: string[] = [];
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (!address.internal && address.cidr && !address.address.includes("%"))
        networks.push(address.cidr);
  return networks;
}

/**
 * Looks a name up for a connection: every address must be on the internet and none the platform's
 * own, or the connection does not happen at all. The connection goes to these addresses and no
 * others, IPv4 first, as the platform's Docker networks have no IPv6.
 */
export function guardedLookup(network: RelayNetwork, own: () => Networks) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    network.resolve(hostname).then(
      (found) => {
        const checked: PublicAddress[] = [];
        for (const text of found) {
          const address = publicAddress(text, own());
          if (!address) {
            callback(
              new RelayRefused(
                "blocked",
                `${hostname} points at an address that is not on the internet, or is the platform's own`,
              ),
              "",
            );
            return;
          }
          checked.push(address);
        }
        const family =
          options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const usable = checked
          .filter((address) => !family || address.family === family)
          .toSorted((a, b) => a.family - b.family)
          .map(({ address, family: of }) => ({
            address: network.reroute?.(address) ?? address,
            family: of,
          }));
        const first = usable[0];
        if (!first) callback(notFound(hostname), "");
        else if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, ""),
    );
  };
}

export interface AgentLimits {
  /** Connections at once, which the relay limits on its own anyway. */
  readonly sockets: number;
  /** How long a connection waits for the next request before it goes. */
  readonly keepMs: number;
}

/** The connections of the relay, kept for a moment between requests to the same service. */
export function relayAgent(network: RelayNetwork, own: () => Networks, limits: AgentLimits) {
  return new Agent({
    keepAlive: true,
    // Shorter than services keep a connection open that has nothing to do, so that the next request
    // does not go out on one they are closing. Node goes by what a service says when it says less.
    timeout: limits.keepMs,
    // As many as requests run at once, to all services together and to each.
    maxTotalSockets: limits.sockets,
    maxSockets: limits.sockets,
    maxFreeSockets: Math.min(limits.sockets, 16),
    scheduling: "lifo",
    lookup: guardedLookup(network, own) as never,
    ...(network.ca !== undefined && { ca: network.ca }),
  });
}
