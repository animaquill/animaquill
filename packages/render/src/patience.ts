/** Longer than the gap between two moves of a hand that is still dragging. */
export const SETTLE_MS = 150;

/** How long a read gets when one was given up already and no frame came since. */
export const SECOND_CHANCE_MS = 1000;

/** Runs something after a while, and gives back how to call that off. */
export type Wait = (milliseconds: number, run: () => void) => () => void;

/**
 * Decides when a read to a place the playhead left gets given up. While the playhead moves, reads
 * finish, because those frames are what people see while dragging. A read that is given up each
 * time would show nothing until they let go. Once the playhead rests, only its place counts.
 *
 * A hand can also move in slow steps that look like rests, and then no read would ever finish. So
 * after giving up once it waits longer, until a frame came. It still gives up in the end, because a
 * decoder that hangs must not hold the picture back for good.
 */
export class GiveUpTimer {
  readonly #wait: Wait;
  readonly #giveUp: () => boolean;
  #cancel = () => {};
  #gaveUp = false;

  /** `giveUp` says whether there was anything to give up. */
  constructor(wait: Wait, giveUp: () => boolean) {
    this.#wait = wait;
    this.#giveUp = giveUp;
  }

  jumped(): void {
    this.#cancel();
    this.#cancel = this.#wait(this.#gaveUp ? SECOND_CHANCE_MS : SETTLE_MS, () => {
      if (this.#giveUp()) this.#gaveUp = true;
    });
  }

  drew(): void {
    this.#gaveUp = false;
  }
}
