import type { FrameRate } from "../protocol.ts";

/** Moments this close are the same moment. A billionth of a second, as in the project format. */
const SAME_MOMENT_MS = 1e-6;

/** From this depth on, a timer that a timer started waits at least `CLAMPED_TIMER_MS`. */
const TIMER_NESTING_LIMIT = 5;
const CLAMPED_TIMER_MS = 4;

/** What the clock needs from the page. */
export interface ClockHooks {
  /** Returns when everything the project just started in the page ran as far as it can. */
  turn(): Promise<void>;
  /** Puts what follows the clock by itself, like animations, in its place for this moment. */
  settle(): void;
  /** The next moment something has to hear about, even if nothing is scheduled for then. */
  due(): number | undefined;
  /** Tells whoever is waiting. Gives whether that ran any code of the project. */
  announce(): Promise<boolean>;
  /** Code of the project threw, and that is no reason to stop time. */
  failed(error: unknown): void;
}

interface Timer {
  readonly id: number;
  at: number;
  readonly every: number | undefined;
  readonly callback: () => void;
  nesting: number;
}

type FrameCallback = (time: number) => void;

/**
 * Time in a scene. It stands still until somebody moves it, and it only moves in frames, so that
 * whatever the project does happens at the same moments every time.
 *
 * A moment always comes from the number of its frame. Added up, 60 steps of 1/60 make
 * 999.9999999999999 ms, and something due at 1000 comes a frame late.
 */
export class SceneClock {
  readonly #rate: FrameRate;
  readonly #hooks: ClockHooks;
  #frame = -1;
  #now = 0;
  /** In the order they are due. */
  readonly #timers: Timer[] = [];
  #nextTimer = 1;
  #nesting = 0;
  readonly #frames = new Map<number, FrameCallback>();
  /** The callbacks of the frame that is running, as long as nothing cancelled them. */
  #running = new Map<number, FrameCallback>();
  #nextFrame = 1;
  #lastRanAt = Number.NEGATIVE_INFINITY;

  constructor(rate: FrameRate, hooks: ClockHooks) {
    this.#rate = rate;
    this.#hooks = hooks;
  }

  /** Where in time the scene is, in milliseconds. */
  get now(): number {
    return this.#now;
  }

  /** The frame the scene is on. −1 before its first one. */
  get frame(): number {
    return this.#frame;
  }

  /** The frame that the present moment belongs to, also while frames are still being run up to it. */
  get frameNow(): number {
    return Math.max(this.#frameAt(this.#now), 0);
  }

  /** Whether code of the project ever ran on this clock. */
  get stateful(): boolean {
    return this.#lastRanAt !== Number.NEGATIVE_INFINITY;
  }

  /** Whether the project waits for time to pass. */
  get waiting(): boolean {
    return this.#timers.length > 0 || this.#frames.size > 0;
  }

  momentOf(frame: number): number {
    return (frame * 1000 * this.#rate.den) / this.#rate.num;
  }

  #frameAt(moment: number): number {
    return Math.ceil(((moment - SAME_MOMENT_MS) * this.#rate.num) / (1000 * this.#rate.den));
  }

  requestFrame(callback: FrameCallback): number {
    const id = this.#nextFrame;
    this.#nextFrame += 1;
    this.#frames.set(id, callback);
    return id;
  }

  cancelFrame(id: number): void {
    this.#frames.delete(id);
    this.#running.delete(id);
  }

  /** Like the browser's timers, down to clamping, which also keeps a timer loop from stopping time. */
  setTimer(callback: () => void, delay: number, repeat: boolean): number {
    const wait = this.#clamped(Math.max(Number(delay) | 0, 0), this.#nesting);
    const id = this.#nextTimer;
    this.#nextTimer += 1;
    this.#schedule({
      id,
      at: this.#now + wait,
      every: repeat ? Math.max(Number(delay) | 0, 0) : undefined,
      callback,
      nesting: this.#nesting + 1,
    });
    return id;
  }

  clearTimer(id: number): void {
    const index = this.#timers.findIndex((timer) => timer.id === id);
    if (index !== -1) this.#timers.splice(index, 1);
  }

  #clamped(wait: number, nesting: number): number {
    return nesting > TIMER_NESTING_LIMIT ? Math.max(wait, CLAMPED_TIMER_MS) : wait;
  }

  #schedule(timer: Timer): void {
    let low = 0;
    let high = this.#timers.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#timers[middle] as Timer).at <= timer.at) low = middle + 1;
      else high = middle;
    }
    this.#timers.splice(low, 0, timer);
  }

  #call(run: () => void): void {
    this.#lastRanAt = this.#now;
    try {
      run();
    } catch (error) {
      this.#hooks.failed(error);
    }
  }

  async #runTimers(moment: number): Promise<void> {
    for (;;) {
      const timer = this.#timers[0];
      if (!timer || timer.at > moment + SAME_MOMENT_MS) return;
      this.#timers.shift();
      this.#now = Math.min(timer.at, moment);
      this.#nesting = timer.nesting;
      if (timer.every !== undefined) {
        timer.at += this.#clamped(timer.every, timer.nesting);
        timer.nesting += 1;
        this.#schedule(timer);
      }
      this.#call(timer.callback);
      // What `await` continues in here belongs to this timer.
      await this.#hooks.turn();
      this.#nesting = 0;
      this.#hooks.settle();
    }
  }

  async #runFrameCallbacks(): Promise<void> {
    if (this.#frames.size === 0) return;
    this.#running = new Map(this.#frames);
    this.#frames.clear();
    for (const [id, callback] of this.#running) {
      // Deleted by a callback before it, the Map's iteration skips it.
      this.#running.delete(id);
      this.#call(() => callback(this.#now));
      await this.#hooks.turn();
    }
    this.#hooks.settle();
  }

  /** The next frame that has anything to run, and at most `target`. */
  #nextStop(target: number): number {
    const next = this.#frame + 1;
    if (this.#frames.size > 0) return next;
    const timer = this.#timers[0]?.at;
    const other = this.#hooks.due();
    const due = timer === undefined ? other : Math.min(timer, other ?? timer);
    if (due === undefined) return target;
    return Math.min(Math.max(this.#frameAt(due), next), target);
  }

  /**
   * Moves forward, to `target` or to the first frame that has something to run on the way there.
   * Frames in between would do nothing, so a scene with nothing to run gets there in one step.
   * What order frames are asked for in changes nothing about what happens on them.
   */
  async step(target: number): Promise<void> {
    const frame = this.#nextStop(target);
    const moment = this.momentOf(frame);
    await this.#runTimers(moment);
    this.#frame = frame;
    this.#now = moment;
    this.#hooks.settle();
    if (await this.#hooks.announce()) {
      this.#lastRanAt = moment;
      this.#hooks.settle();
    }
    await this.#runFrameCallbacks();
  }

  /**
   * Goes back, if that is possible. It is as long as no code ran after that frame: time can move
   * back through animations, but not through what code did to the scene.
   */
  rewind(frame: number): boolean {
    const moment = this.momentOf(frame);
    if (moment < this.#lastRanAt - SAME_MOMENT_MS) return false;
    this.#frame = frame;
    this.#now = moment;
    this.#hooks.settle();
    return true;
  }
}
