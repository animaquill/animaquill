import { Emitter } from "../workbench/emitter.ts";

/** How far back the count looks. */
export const FRAME_RATE_WINDOW_MS = 1000;
/** How often what people see changes. More often only makes the number flicker. */
export const FRAME_RATE_EVERY_MS = 1000;
/** Below this share of the project frame rate, playback no longer looks smooth. */
export const SHORT_OF_RATE = 0.9;
/** Less than this to go on says nothing yet. */
const LEAST_SPAN_MS = 250;

export interface FrameRateReading {
  /** Frames of new places on the timeline that reached the canvas, per second. */
  readonly painted: number;
  /** What the project asks for. */
  readonly fps: number;
  /** Frames the project has in that time that never showed. */
  readonly dropped: number;
  /** Whether people would see it. */
  readonly short: boolean;
}

export type FrameRateSnapshot =
  /** No preview anywhere, so there is nothing to count. */
  | { readonly state: "none" }
  | { readonly state: "paused" }
  /** Without a reading for the first moment of playing. */
  | { readonly state: "playing"; readonly reading: FrameRateReading | undefined };

/**
 * When frames reached the canvas, by the clock of the editor. The compositor says how long ago, so
 * the two clocks never have to agree, and what it said is complete up to when it was heard.
 */
export class PaintWindow {
  #times: number[] = [];
  #heard = Number.NEGATIVE_INFINITY;

  add(now: number, ago: readonly number[]): void {
    for (const before of ago) {
      if (Number.isFinite(before) && before >= 0) this.#times.push(now - before);
    }
    this.#times.sort((a, b) => a - b);
    this.#heard = Math.max(this.#heard, now);
    const keep = now - 2 * FRAME_RATE_WINDOW_MS;
    const first = this.#times.findIndex((time) => time > keep);
    this.#times = first === -1 ? [] : this.#times.slice(first);
  }

  /**
   * The last second of playing that started at `since`. The compositor only speaks when it drew
   * something, so silence for longer than the window means it drew nothing.
   */
  read(now: number, since: number, fps: number): FrameRateReading | undefined {
    const end = now - this.#heard > FRAME_RATE_WINDOW_MS ? now : Math.min(this.#heard, now);
    const start = Math.max(end - FRAME_RATE_WINDOW_MS, since);
    const span = end - start;
    if (span < LEAST_SPAN_MS || !(fps > 0)) return undefined;
    let count = 0;
    for (const time of this.#times) if (time > start && time <= end) count += 1;
    const painted = Math.round((count * 1000) / span);
    const dropped = Math.max(Math.round((fps * span) / 1000 - count), 0);
    return { painted, fps, dropped, short: painted < fps * SHORT_OF_RATE };
  }
}

/** What the meter needs to know about the timeline. */
export interface PlaybackSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly playing: boolean;
    readonly model: { readonly rate: { readonly fps: number } } | undefined;
  };
}

/** What one preview tells the meter. */
export interface FrameRateFeed {
  painted(ago: readonly number[]): void;
  dispose(): void;
}

const sameReading = (a: FrameRateReading | undefined, b: FrameRateReading | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.painted === b.painted &&
    a.fps === b.fps &&
    a.dropped === b.dropped);

/**
 * How many frames the preview really shows, for the status bar. Counting happens with every frame
 * and costs nothing; people hear about it once a second, and only while it plays.
 */
export class PreviewFrameRate {
  readonly #emitter = new Emitter();
  readonly #playback: PlaybackSource;
  readonly #now: () => number;
  /** The newest preview is the one being counted. */
  #feeds: { readonly window: PaintWindow }[] = [];
  #since: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #snapshot: FrameRateSnapshot = { state: "none" };

  constructor(playback: PlaybackSource, now: () => number = () => performance.now()) {
    this.#playback = playback;
    this.#now = now;
    playback.subscribe(this.#follow);
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): FrameRateSnapshot => this.#snapshot;

  /** A preview that came up. What it says counts until it goes. */
  attach(): FrameRateFeed {
    const feed = { window: new PaintWindow() };
    this.#feeds.push(feed);
    this.#follow();
    return {
      painted: (ago) => feed.window.add(this.#now(), ago),
      dispose: () => {
        this.#feeds = this.#feeds.filter((other) => other !== feed);
        this.#follow();
      },
    };
  }

  #follow = (): void => {
    const playing = this.#playback.getSnapshot().playing && this.#feeds.length > 0;
    if (!playing) {
      this.#since = undefined;
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#set(this.#feeds.length > 0 ? { state: "paused" } : { state: "none" });
      return;
    }
    if (this.#since !== undefined) return;
    this.#since = this.#now();
    this.#set({ state: "playing", reading: undefined });
    this.#timer = setInterval(this.#read, FRAME_RATE_EVERY_MS);
  };

  #read = (): void => {
    const feed = this.#feeds.at(-1);
    const fps = this.#playback.getSnapshot().model?.rate.fps;
    if (!feed || this.#since === undefined || fps === undefined) return;
    const reading = feed.window.read(this.#now(), this.#since, fps);
    const current = this.#snapshot;
    if (current.state === "playing" && sameReading(current.reading, reading)) return;
    this.#set({ state: "playing", reading });
  };

  #set(snapshot: FrameRateSnapshot): void {
    const current = this.#snapshot;
    if (current.state === snapshot.state && snapshot.state !== "playing") return;
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
