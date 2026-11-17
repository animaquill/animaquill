/** The fastest J and L go, as in Premiere. */
export const MAX_SHUTTLE_RATE = 8;
/** How fast holding K with J or L goes. */
export const SLOW_RATE = 0.25;
/** A tap of J or L with K held is one frame. Held longer than this, it plays slowly. */
export const HOLD_MS = 250;

/** What J, K and L drive. */
export interface ShuttleTarget {
  /** Timeline seconds per real second while playing, negative backwards; undefined when stopped. */
  readonly playingRate: number | undefined;
  play(rate: number): void;
  pause(): void;
  stepFrames(count: number): void;
}

export interface ShuttleTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const TIMERS: ShuttleTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

type Direction = 1 | -1;

/** How fast J and L play, as the preview shows it: 2×, −1×, 1/4× for slowly. */
export function rateText(rate: number): string {
  const speed = Math.abs(rate);
  const amount = speed >= 1 ? String(speed) : `1/${Math.round(1 / speed)}`;
  return `${rate < 0 ? "−" : ""}${amount}×`;
}

/**
 * J, K and L as every editor has them since Avid: L plays, and each press doubles the speed up to
 * eight times; J does the same backwards; K stops. With K held, a tap of J or L is one frame, and
 * holding it plays slowly until either key comes up. Which keys these are is up to people: this
 * only hears that one went down or up.
 */
export class Shuttle {
  readonly #target: ShuttleTarget;
  readonly #timers: ShuttleTimers;
  #stopHeld = false;
  /** J or L, pressed while K was held and not up yet. */
  #held: Direction | undefined;
  #holdTimer: unknown;
  /** Playing slowly because J or L is held with K. */
  #slow = false;

  constructor(target: ShuttleTarget, timers: ShuttleTimers = TIMERS) {
    this.#target = target;
    this.#timers = timers;
  }

  /** K went down. */
  stop(): void {
    this.#stopHeld = true;
    this.#endHold();
    this.#target.pause();
  }

  /** K came up, which ends playing slowly. */
  stopUp(): void {
    this.#stopHeld = false;
    this.#endHold();
  }

  /** L went down. */
  forward(): void {
    this.#press(1);
  }

  /** J went down. */
  backward(): void {
    this.#press(-1);
  }

  /** L came up. */
  forwardUp(): void {
    if (this.#held === 1) this.#endHold();
  }

  /** J came up. */
  backwardUp(): void {
    if (this.#held === -1) this.#endHold();
  }

  #press(direction: Direction): void {
    if (this.#stopHeld) {
      this.#endHold();
      this.#target.pause();
      this.#target.stepFrames(direction);
      this.#held = direction;
      this.#holdTimer = this.#timers.setTimeout(() => {
        this.#holdTimer = undefined;
        this.#slow = true;
        this.#target.play(direction * SLOW_RATE);
      }, HOLD_MS);
      return;
    }
    const rate = this.#target.playingRate ?? 0;
    const speed = Math.abs(rate);
    // The other way, or slower than normal, starts again at normal speed.
    const next = Math.sign(rate) === direction && speed >= 1 ? speed * 2 : 1;
    this.#target.play(direction * Math.min(next, MAX_SHUTTLE_RATE));
  }

  #endHold(): void {
    if (this.#holdTimer !== undefined) this.#timers.clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
    this.#held = undefined;
    if (this.#slow) {
      this.#slow = false;
      this.#target.pause();
    }
  }
}
