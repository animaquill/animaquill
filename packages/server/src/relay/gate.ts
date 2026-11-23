import { RateLimit } from "../auth/limits.ts";

/**
 * How much the relay takes on: how large, how long, how often and how many at once. The numbers are
 * for people talking to AI, with some room: a task asks the service once for each turn, the request
 * carries the conversation and the tools (tens of KB, more with pictures), and the answer streams
 * for as long as the model writes. Counted in memory, like the other limits of the API.
 */
export interface RelayLimits {
  /**
   * Bytes of a request, as the gateway takes them (`max_size 20MB`). They also have to arrive in
   * time: the API takes a minute for a whole request (`requestTimeout` in app.ts, for every route),
   * and Node looks every 30 seconds, so after 60 to 90 seconds the browser gets 408 and the service
   * nothing more. 20 MB in a minute is about 2.7 Mbit/s up.
   */
  readonly requestBytes: number;
  /** Bytes of an answer. */
  readonly answerBytes: number;
  /** Requests one person can start in a window. */
  readonly requestsPerUser: number;
  /** Bytes one person can send and get in a window, against using the relay for anything else. */
  readonly bytesPerUser: number;
  readonly windowMs: number;
  /** Requests of one person at once: a few windows with a task each. */
  readonly concurrentPerUser: number;
  /** Requests of everyone at once. */
  readonly concurrent: number;
  /** To have a connection to the service, with looking up its name. */
  readonly connectMs: number;
  /** Without a byte either way, which also bounds the wait for the answer to begin. */
  readonly idleMs: number;
  /** For all of a request, however much it streams. */
  readonly totalMs: number;
  /** How long a connection waits for the next request to the same service before it goes. */
  readonly keepMs: number;
  /**
   * How often what goes through looks whether the relay was turned off meanwhile, and stops then.
   * Settings are read every ten seconds anyway (settings.ts).
   */
  readonly offCheckMs: number;
}

export const RELAY_LIMITS: RelayLimits = {
  requestBytes: 20_000_000,
  answerBytes: 32 * 1024 * 1024,
  requestsPerUser: 600,
  bytesPerUser: 1024 ** 3,
  windowMs: 10 * 60_000,
  concurrentPerUser: 6,
  concurrent: 64,
  connectMs: 15_000,
  idleMs: 5 * 60_000,
  totalMs: 60 * 60_000,
  keepMs: 4_000,
  offCheckMs: 5_000,
};

/** A request that the gate let in: it counts its bytes, and leaves once, whatever happens. */
export interface Pass {
  bytes(count: number): void;
  leave(): void;
}

export type Entry =
  | { readonly ok: true; readonly pass: Pass }
  | {
      readonly ok: false;
      /** `everyone`: the relay as a whole is at its limit, not this person. */
      readonly who: "user" | "everyone";
      /** Seconds to wait, for Retry-After. */
      readonly retryAfter: number;
    };

/** Who may start a request through the relay now. */
export class RelayGate {
  readonly #limits: RelayLimits;
  readonly #now: () => number;
  readonly #requests: RateLimit;
  readonly #bytes = new Map<string, { start: number; bytes: number }>();
  readonly #running = new Map<string, number>();
  #all = 0;
  #lastSweep = 0;

  constructor(limits: RelayLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
    this.#requests = new RateLimit(limits.requestsPerUser, limits.windowMs, now);
  }

  /** How many requests run now, of one person or of everyone. */
  running(user?: string): number {
    return user === undefined ? this.#all : (this.#running.get(user) ?? 0);
  }

  enter(user: string): Entry {
    const now = this.#now();
    this.#sweep(now);
    const window = Math.ceil(this.#limits.windowMs / 1000);
    if (this.#all >= this.#limits.concurrent) return { ok: false, who: "everyone", retryAfter: 5 };
    if ((this.#running.get(user) ?? 0) >= this.#limits.concurrentPerUser)
      return { ok: false, who: "user", retryAfter: 5 };
    const sent = this.#bytes.get(user);
    if (sent && now - sent.start < this.#limits.windowMs && sent.bytes >= this.#limits.bytesPerUser)
      return {
        ok: false,
        who: "user",
        retryAfter: Math.max(1, Math.ceil((sent.start + this.#limits.windowMs - now) / 1000)),
      };
    if (!this.#requests.take(user))
      return { ok: false, who: "user", retryAfter: this.#requests.retryAfter(user) || window };
    this.#all += 1;
    this.#running.set(user, (this.#running.get(user) ?? 0) + 1);
    let left = false;
    return {
      ok: true,
      pass: {
        bytes: (count) => {
          const at = this.#now();
          const entry = this.#bytes.get(user);
          if (!entry || at - entry.start >= this.#limits.windowMs)
            this.#bytes.set(user, { start: at, bytes: count });
          else entry.bytes += count;
        },
        leave: () => {
          if (left) return;
          left = true;
          this.#all -= 1;
          const running = (this.#running.get(user) ?? 1) - 1;
          if (running > 0) this.#running.set(user, running);
          else this.#running.delete(user);
        },
      },
    };
  }

  /** What is over is forgotten now and then, so that memory does not grow with every person. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#limits.windowMs) return;
    this.#lastSweep = now;
    for (const [user, entry] of this.#bytes)
      if (now - entry.start >= this.#limits.windowMs) this.#bytes.delete(user);
  }
}
