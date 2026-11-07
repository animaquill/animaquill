import type { TimeBase } from "../protocol.ts";

/** The part of the clock that moving through time needs. */
export interface Walkable {
  readonly frame: number;
  readonly stateful: boolean;
  step(target: number): Promise<void>;
  rewind(frame: number): boolean;
}

export interface TransportHooks {
  /** The first frame of a `seek` got there. Goes on until what is on it is ready to be seen. */
  arrived(): Promise<void>;
  seeked(request: number, frame: number, stateful: boolean): void;
  needsReplay(request: number, frame: number): void;
  /** Where a playing scene got to. */
  position(frame: number): void;
  /** A step of a walk is done. It may be a long walk, and somebody is keeping an eye on it. */
  walked(frame: number): void;
  /** The real time, in the same terms as a `TimeBase`. */
  wall(): number;
  /** Runs something on the next frame of the screen. */
  onScreenFrame(run: () => void): void;
  /** The walk itself failed, which is not the project's doing, and nobody would hear otherwise. */
  broke(error: unknown): void;
  /** Frames per second. */
  readonly fps: number;
}

/** The frame a base says it is at a moment. */
export const frameAt = ({ frame, at, rate }: TimeBase, wall: number, fps: number) =>
  frame + Math.floor((((wall - at) * rate) / 1000) * fps);

/**
 * Moves a scene to where it was asked to be. Only one walk runs at a time, and it always heads for
 * the latest request, so a walk that a new request overtook does not have to finish first.
 */
export class Transport {
  readonly #clock: Walkable;
  readonly #hooks: TransportHooks;
  /** Where to go, and who to tell. A playing scene tells nobody. */
  #wanted: number | undefined;
  #request: number | undefined;
  #base: TimeBase | undefined;
  #walking = false;
  #ticking = false;

  constructor(clock: Walkable, hooks: TransportHooks) {
    this.#clock = clock;
    this.#hooks = hooks;
  }

  seek(request: number, frame: number): void {
    this.#base = undefined;
    this.#request = request;
    this.#wanted = frame;
    void this.#walk();
  }

  play(base: TimeBase): void {
    this.#base = base.rate > 0 ? base : undefined;
    if (this.#base) this.#nextTick();
  }

  pause(): void {
    this.#base = undefined;
  }

  /**
   * What the frame shows changed while nothing moves, like a value people drag: the frame gets
   * there again, and is seen again. Whatever is under way gets there with the change anyway.
   */
  refresh(): void {
    if (this.#base || this.#walking || this.#clock.frame < 0) return;
    this.#wanted = this.#clock.frame;
    void this.#walk();
  }

  /** Only one at a time, however often playing starts and stops within a frame of the screen. */
  #nextTick(): void {
    if (this.#ticking) return;
    this.#ticking = true;
    this.#hooks.onScreenFrame(this.#tick);
  }

  #tick = (): void => {
    this.#ticking = false;
    const base = this.#base;
    if (!base) return;
    this.#nextTick();
    // Somebody is waiting to hear about the frame they asked for, and time catches up after that.
    if (this.#request !== undefined) return;
    const frame = frameAt(base, this.#hooks.wall(), this.#hooks.fps);
    // Time that went back a little is a correction, and it passes by itself.
    if (frame > (this.#wanted ?? this.#clock.frame)) {
      this.#wanted = frame;
      void this.#walk();
    }
  };

  async #walk(): Promise<void> {
    if (this.#walking) return;
    this.#walking = true;
    try {
      while (this.#wanted !== undefined) {
        const wanted = this.#wanted;
        if (wanted > this.#clock.frame) {
          await this.#clock.step(wanted);
          this.#hooks.walked(this.#clock.frame);
        } else if (wanted === this.#clock.frame || this.#clock.rewind(wanted))
          await this.#arrive(wanted);
        else this.#cannotGoBack(wanted);
      }
    } catch (error) {
      this.#wanted = undefined;
      this.#hooks.broke(error);
    } finally {
      this.#walking = false;
    }
  }

  async #arrive(frame: number): Promise<void> {
    await this.#hooks.arrived();
    // Somebody may have asked for something else in the meantime. A playing scene often gets here
    // with the next frame already wanted, and it did get here.
    if (this.#wanted !== frame) {
      if (this.#request === undefined) this.#hooks.position(frame);
      return;
    }
    this.#wanted = undefined;
    if (this.#request === undefined) {
      this.#hooks.position(frame);
    } else {
      this.#hooks.seeked(this.#request, frame, this.#clock.stateful);
      this.#request = undefined;
    }
  }

  #cannotGoBack(frame: number): void {
    this.#wanted = undefined;
    if (this.#request !== undefined) this.#hooks.needsReplay(this.#request, frame);
    this.#request = undefined;
  }
}
