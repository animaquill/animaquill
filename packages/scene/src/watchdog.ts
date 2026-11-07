/**
 * When a scene counts as stuck. All of this is decided here, without timers or a page, so that the
 * rules can be tested. The caller brings the time.
 *
 * A scene has to get somewhere, not just make noise: anything it sends can be sent by code that does
 * nothing else, so the only things that count are an answer to a ping that a scene that is really
 * running can read, and progress towards what it was asked to do.
 */

/** What a scene is doing, for the problems list. */
export type ScenePhase = "hello" | "loading" | "running" | "seeking";

export interface WatchdogRules {
  /** How many times in a row a scene can get a new frame for going back, and how fast that recovers. */
  readonly replayBurst: number;
  readonly replaysPerSecond: number;
  /** How often to ask a running scene whether it is there. */
  readonly pingEveryMs: number;
  /** How long it may take to say hello, to load, and to answer a ping. */
  readonly limitMs: Readonly<Record<"hello" | "loading" | "running", number>>;
  /** How long a seek may go without getting further, and how long it may take at all. */
  readonly seekStallMs: number;
  readonly seekLimitMs: number;
  /** Checks that are further apart than this mean that the page that checks stood still itself. */
  readonly maxCheckGapMs: number;
  /** Hangs in a row after which a scene is left alone until somebody asks for it again. */
  readonly strikes: number;
  /** How long a scene has to work before earlier hangs are forgotten. */
  readonly forgiveAfterMs: number;
}

/**
 * A hidden frame's timers run about once a second, so an answer can take two seconds without
 * anything being wrong. Every limit has to stay above that.
 */
export const THROTTLED_ANSWER_MS = 2000;

export const WATCHDOG_RULES: WatchdogRules = {
  // People dragging back are well below this.
  replayBurst: 30,
  replaysPerSecond: 2,
  pingEveryMs: 500,
  limitMs: { hello: 5000, loading: 20000, running: 5000 },
  seekStallMs: 10000,
  seekLimitMs: 300000,
  maxCheckGapMs: 500,
  strikes: 3,
  forgiveAfterMs: 30000,
};

/** `silent` means no answer, `stuck` means answers and no progress. */
export type WatchdogVerdict = "wait" | "ping" | "silent" | "stuck";

/** Pings older than this are not worth waiting for. */
const OPEN_PINGS = 4;

interface Seek {
  readonly target: number;
  readonly since: number;
  reached: number;
  movedAt: number;
}

/**
 * Decides, for one frame, whether to ask and whether to give up. Time here only counts while the
 * page could have seen an answer: not while it is hidden, and not while it stood still itself,
 * because of a long task, a throttled timer or a laptop lid. Each `check` adds what passed since the
 * one before, unless that was too long ago.
 */
export class Watchdog {
  readonly #rules: WatchdogRules;
  #phase: Exclude<ScenePhase, "seeking"> = "hello";
  #lastCheck: number;
  /** The time that counted so far. Everything below is in these terms. */
  #counted = 0;
  #phaseSince = 0;
  #answeredAt = 0;
  #pingedAt = 0;
  readonly #open: number[] = [];
  #seek: Seek | undefined;

  constructor(now: number, rules: WatchdogRules = WATCHDOG_RULES) {
    for (const limit of Object.values(rules.limitMs)) {
      if (limit <= THROTTLED_ANSWER_MS) {
        throw new Error(`A limit of ${limit} ms would take a throttled frame for a hung one`);
      }
    }
    this.#rules = rules;
    this.#lastCheck = now;
  }

  get phase(): ScenePhase {
    return this.#seek ? "seeking" : this.#phase;
  }

  /** The frame it is on its way to. */
  get target(): number | undefined {
    return this.#seek?.target;
  }

  /**
   * Whether it stopped answering, for longer than a working frame takes when it is throttled. This
   * comes before the limit that makes it `silent`, for a frame that goes away before that. A frame
   * that never answered yet says nothing: it may only be slow to load.
   */
  get isQuiet(): boolean {
    return this.#phase === "running" && this.#counted - this.#answeredAt > THROTTLED_ANSWER_MS;
  }

  /** A new phase gets its full patience. */
  enter(phase: "loading" | "running"): void {
    this.#phase = phase;
    this.#phaseSince = this.#counted;
    this.#answeredAt = this.#counted;
  }

  /** A ping went out with this number, which nobody can guess. */
  pinged(nonce: number): void {
    this.#open.push(nonce);
    if (this.#open.length > OPEN_PINGS) this.#open.shift();
  }

  /** Only the answer to a ping that went out counts. Gives whether this was one. */
  answered(nonce: number): boolean {
    const index = this.#open.indexOf(nonce);
    if (index === -1) return false;
    this.#open.splice(0, index + 1);
    this.#answeredAt = this.#counted;
    return true;
  }

  /** It was asked to go to a frame. A new target does not take away what it has done. */
  seeking(target: number): void {
    this.#seek = this.#seek
      ? { ...this.#seek, target, movedAt: this.#counted }
      : { target, since: this.#counted, reached: -1, movedAt: this.#counted };
  }

  /** It says it got this far. That only counts when it is further than before. */
  progressed(frame: number): void {
    const seek = this.#seek;
    if (!seek || frame <= seek.reached || frame > seek.target) return;
    seek.reached = frame;
    seek.movedAt = this.#counted;
  }

  /** It got there, or the seek is not its business any more. */
  settled(): void {
    this.#seek = undefined;
  }

  /** Call this regularly. */
  check(now: number, visible: boolean): WatchdogVerdict {
    const gap = now - this.#lastCheck;
    this.#lastCheck = now;
    if (!visible || gap > this.#rules.maxCheckGapMs) return "wait";
    this.#counted += gap;
    const { limitMs, seekLimitMs, seekStallMs, pingEveryMs } = this.#rules;
    if (this.#phase !== "running") {
      return this.#counted - this.#phaseSince > limitMs[this.#phase] ? "silent" : "wait";
    }
    if (this.#counted - this.#answeredAt > limitMs.running) return "silent";
    const seek = this.#seek;
    if (seek && this.#counted - seek.movedAt > seekStallMs) return "stuck";
    if (seek && this.#counted - seek.since > seekLimitMs) return "stuck";
    if (this.#counted - this.#pingedAt >= pingEveryMs) {
      this.#pingedAt = this.#counted;
      return "ping";
    }
    return "wait";
  }
}

/** Counts hangs of one scene. Only working for a while makes up for them. */
export class Strikes {
  readonly #limit: number;
  readonly #forgiveAfterMs: number;
  #count = 0;
  #lastHang = Number.NEGATIVE_INFINITY;

  constructor(
    limit: number = WATCHDOG_RULES.strikes,
    forgiveAfterMs: number = WATCHDOG_RULES.forgiveAfterMs,
  ) {
    this.#limit = limit;
    this.#forgiveAfterMs = forgiveAfterMs;
  }

  /** Whether to try again after this one. */
  hung(now: number): boolean {
    this.#count += 1;
    this.#lastHang = now;
    return this.#count < this.#limit;
  }

  /**
   * The scene did what it was asked. That alone proves little: a scene that hangs on purpose can do
   * so right after it answered, and would start over for ever.
   */
  worked(now: number): void {
    if (now - this.#lastHang >= this.#forgiveAfterMs) this.#count = 0;
  }
}
