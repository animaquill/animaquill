import type { RenderLayer } from "@animaquill/core";
import { TIME_TOLERANCE } from "@animaquill/core/view";

/** Longer than any file takes to open, short enough to hold only the next clip or two. */
export const GET_READY_SECONDS = 1.5;

/** A jump this far ahead is cheaper by starting over at a keyframe than by decoding the way there. */
const MAX_WALK_SECONDS = 2;

export const showsAt = ({ start, end }: RenderLayer, seconds: number): boolean =>
  seconds >= start - TIME_TOLERANCE && seconds < end - TIME_TOLERANCE;

export const comesUpAfter = ({ start }: RenderLayer, seconds: number): boolean =>
  start - TIME_TOLERANCE > seconds && start - seconds <= GET_READY_SECONDS;

/** Where in its file a clip gets read when the playhead is at a moment, if at all. */
export function readingAt(layer: RenderLayer, seconds: number): number | undefined {
  if (showsAt(layer, seconds)) return layer.offset + seconds - layer.start;
  return comesUpAfter(layer, seconds) ? layer.offset : undefined;
}

export interface TimedFrame {
  readonly timestamp: number;
  close(): void;
}

export interface FrameSource<Frame extends TimedFrame> {
  /**
   * The frames from a moment on. Calling `return` during a `next` has to end that `next` early and
   * close every frame it does not hand out, because that is what gives up a decode under way.
   * Mediabunny does this, which an `async function*` would not.
   */
  samples(seconds: number): AsyncGenerator<Frame, void, unknown>;
}

/**
 * Reads a video forwards, because a frame in the middle of a file costs decoding everything since
 * the last keyframe. Going on from the last frame is what makes playing possible.
 */
export class VideoCursor<Frame extends TimedFrame> {
  readonly #source: FrameSource<Frame>;
  #samples: AsyncGenerator<Frame, void, unknown> | undefined;
  #current: Frame | undefined;
  #next: Frame | undefined;
  /** Whether decoding started over since it was last asked. */
  #cold = false;
  /** Getting ready and drawing can ask at once, and a generator takes one question at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Questions not answered yet, and where the last of them is going. */
  #reading = 0;
  #aim = 0;
  /** Goes up when all questions so far are given up. */
  #round = 0;
  #closed = false;

  constructor(source: FrameSource<Frame>) {
    this.#source = source;
  }

  async #pull(): Promise<Frame | undefined> {
    const result = await this.#samples?.next();
    return result?.done === false ? result.value : undefined;
  }

  takeCold(): boolean {
    const cold = this.#cold;
    this.#cold = false;
    return cold;
  }

  async #restart(seconds: number, round: number): Promise<void> {
    await this.#release();
    if (round !== this.#round) return;
    this.#cold = true;
    this.#samples = this.#source.samples(seconds);
    this.#current = await this.#pull();
    this.#next = await this.#pull();
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(work);
    this.#queue = turn.catch(() => {});
    return turn;
  }

  /**
   * The frame showing at a moment. It stays open until the cursor moves on. Nothing comes back for a
   * question that was given up.
   */
  at(seconds: number): Promise<Frame | undefined> {
    if (this.#closed) return Promise.resolve(undefined);
    const round = this.#round;
    this.#aim = seconds;
    this.#reading += 1;
    return this.#inTurn(async () => {
      try {
        if (round !== this.#round) return undefined;
        const frame = await this.#moveTo(seconds, round);
        return round === this.#round ? frame : undefined;
      } finally {
        this.#reading -= 1;
        // The frames that came in are from a read that stopped halfway, and a closed frame gives its
        // memory back to the decoder. The next question starts clean.
        if (round !== this.#round) await this.#release();
      }
    });
  }

  /**
   * Gives up what is being read when it does not lead to this moment, which is when reaching the
   * moment takes starting over anyway. A read that does lead there goes on: it is the way there, and
   * starting over would throw away what it has done. Says whether it gave up.
   */
  giveUpUnlessLeadsTo(seconds: number | undefined): boolean {
    if (this.#reading === 0) return false;
    const leads =
      seconds !== undefined && seconds >= this.#aim && seconds - this.#aim <= MAX_WALK_SECONDS;
    if (leads) return false;
    this.#giveUp();
    return true;
  }

  /** What is being read stops too, because nobody is waiting for it any more. */
  close(): Promise<void> {
    this.#closed = true;
    this.#giveUp();
    return this.#inTurn(() => this.#release());
  }

  /** The read under way finds no more frames, ends, and cleans up in its own turn. */
  #giveUp(): void {
    this.#round += 1;
    const samples = this.#samples;
    this.#samples = undefined;
    void samples?.return();
  }

  async #moveTo(seconds: number, round: number): Promise<Frame | undefined> {
    const current = this.#current;
    const behind = current === undefined || seconds + TIME_TOLERANCE < current.timestamp;
    const farAhead = this.#next && seconds - this.#next.timestamp > MAX_WALK_SECONDS;
    if (behind || farAhead) await this.#restart(seconds, round);
    // A frame that starts at this moment is the one that shows, also with a float a little short.
    while (this.#next && this.#next.timestamp <= seconds + TIME_TOLERANCE) {
      this.#current?.close();
      this.#current = this.#next;
      this.#next = await this.#pull();
    }
    return this.#current;
  }

  async #release(): Promise<void> {
    this.#current?.close();
    this.#next?.close();
    this.#current = undefined;
    this.#next = undefined;
    await this.#samples?.return();
    this.#samples = undefined;
  }
}
