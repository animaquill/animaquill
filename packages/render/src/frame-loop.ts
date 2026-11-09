import type { RenderLayer } from "@animaquill/core";
import { comesUpAfter, showsAt } from "./cursor.ts";
import type { ColdClip, FrameTiming } from "./index.ts";
import { GiveUpTimer, type Wait } from "./patience.ts";

/** A frame on its way to the screen. */
export class PendingFrame {
  readonly seconds: number;
  /** Nothing of it may reach the screen any more. */
  givenUp = false;
  /** How long it waited for pictures. */
  decodeMs = 0;
  /** Clips that had to start decoding at a keyframe for it. */
  readonly cold: ColdClip[] = [];
  readonly #jumps: number;
  readonly #loop: FrameLoop;

  constructor(seconds: number, loop: FrameLoop) {
    this.seconds = seconds;
    this.#loop = loop;
    this.#jumps = loop.jumps;
  }

  /** Somebody moved the playhead since it started, so the playhead does not wait for it. */
  get jumped(): boolean {
    return this.#loop.jumps !== this.#jumps;
  }
}

export interface FrameLoopParts {
  /** The clips there are now. */
  layers(): readonly RenderLayer[];
  /**
   * Draws a frame, and says whether it reached the screen. A frame that got given up meanwhile does
   * not: it waits for nothing more, and nothing of it reaches the screen.
   */
  draw(frame: PendingFrame): Promise<boolean>;
  /** Gets a clip that comes up soon ready to show, with the playhead at a moment. */
  prepare(layer: RenderLayer, seconds: number): Promise<void>;
  /** Gives up reads that do not lead to a moment, see `VideoReads`. Says which clips gave up. */
  giveUpFor(seconds: number): readonly string[];
  /** After each frame that was not given up, and whether it showed a new place. */
  drew(timing: FrameTiming, newPlace: boolean): void;
  wait: Wait;
  now(): number;
}

/**
 * Draws the preview, one frame at a time. When time runs ahead of it, frames in between are skipped.
 * It is apart from the compositor so that how it keeps up can be tried with a decoder that is slow on
 * purpose, see the tests.
 */
export class FrameLoop {
  readonly #parts: FrameLoopParts;
  #wanted = 0;
  /** How many times somebody moved the playhead. */
  jumps = 0;
  /** It only draws what an export asks for, which goes on another way. */
  exporting = false;
  #drawing: PendingFrame | undefined;
  #again = false;
  #preparing = false;
  /** Frames given up since the last one that was drawn. */
  #abandoned = 0;
  /** The place the last frame showed. Drawing a place again is not another frame of it. */
  #lastPainted: number | undefined;
  /** Only somebody moving the playhead starts this. Time carries it along without any rest. */
  readonly #patience: GiveUpTimer;

  constructor(parts: FrameLoopParts) {
    this.#parts = parts;
    this.#patience = new GiveUpTimer(parts.wait, () => this.#giveUp());
  }

  get wanted(): number {
    return this.#wanted;
  }

  /** Where the playhead is, for what is drawn another way, such as for an export. */
  set wanted(seconds: number) {
    this.#wanted = seconds;
  }

  /** The playhead moved: by somebody, which is a jump, or with time while playing. */
  seek(seconds: number, jump: boolean): void {
    this.#wanted = seconds;
    if (!jump) return;
    this.jumps += 1;
    this.#patience.jumped();
  }

  /** The clips showing at a moment. */
  showing(seconds: number): RenderLayer[] {
    return this.#parts.layers().filter((layer) => showsAt(layer, seconds));
  }

  /** The clips that come up soon after a moment. */
  upcoming(seconds: number): RenderLayer[] {
    return this.#parts.layers().filter((layer) => comesUpAfter(layer, seconds));
  }

  /** Reading to a place the playhead left is what keeps it from getting to where it is now. */
  #giveUp(): boolean {
    const gaveUp = this.#parts.giveUpFor(this.#wanted).length > 0;
    if (gaveUp) {
      if (this.#drawing) this.#drawing.givenUp = true;
      void this.refresh();
    }
    return gaveUp;
  }

  async refresh(): Promise<void> {
    if (this.exporting) return;
    if (this.#drawing) {
      this.#again = true;
      return;
    }
    do {
      this.#again = false;
      const frame = new PendingFrame(this.#wanted, this);
      this.#drawing = frame;
      const started = this.#parts.now();
      const preparing = this.#preparing;
      let painted = false;
      try {
        painted = await this.#parts.draw(frame);
      } catch (error) {
        console.warn("A frame could not be drawn", error);
      }
      // Whatever gave it up asked for the next round.
      if (frame.givenUp) {
        this.#abandoned += 1;
        continue;
      }
      this.#patience.drew();
      // Getting ready for a place the playhead left would only be in the way.
      if (!this.#preparing && !frame.jumped) this.#prepare(frame.seconds);
      const newPlace = painted && frame.seconds !== this.#lastPainted;
      if (newPlace) this.#lastPainted = frame.seconds;
      this.#parts.drew(
        {
          seconds: frame.seconds,
          ms: this.#parts.now() - started,
          decodeMs: frame.decodeMs,
          gettingReady: preparing,
          cold: frame.cold.length,
          behindMs: Math.max(this.#wanted - frame.seconds, 0) * 1000,
          abandoned: this.#abandoned,
          ...(frame.cold.length > 0 && { coldClips: frame.cold }),
        },
        newPlace,
      );
      this.#abandoned = 0;
    } while (this.#again);
    this.#drawing = undefined;
  }

  /**
   * Opening a file and decoding up to a first frame takes longer than a frame may, so a clip does
   * that before it shows, and playing goes straight from one clip into the next.
   */
  #prepare(seconds: number): void {
    this.#preparing = true;
    void this.#prepareAll(seconds)
      .catch((error: unknown) => console.warn("A clip could not get ready", error))
      .finally(() => {
        this.#preparing = false;
      });
  }

  async #prepareAll(seconds: number): Promise<void> {
    for (const layer of this.upcoming(seconds)) await this.#parts.prepare(layer, seconds);
  }
}
