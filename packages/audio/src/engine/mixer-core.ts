import type { MixPlan, MixSound } from "@animaquill/core";
import { BLOCK, MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import { SampleStore } from "./samples.ts";

/** What the page tells the mixer in the audio thread. `run` tells one playing from the next. */
export type MixerMessage =
  | { readonly kind: "plan"; readonly plan: MixPlan }
  /**
   * Plays from now on: the context's frame `frame` is sample `sample` of the timeline, which goes
   * by `rate` samples of the timeline for each frame of the context (negative backwards).
   */
  | {
      readonly kind: "play";
      readonly run: number;
      readonly plan: MixPlan;
      readonly frame: number;
      readonly sample: number;
      readonly rate: number;
    }
  | { readonly kind: "stop" }
  /** A sound is being read: from now on, what of it is not here is late. */
  | { readonly kind: "open"; readonly run: number; readonly id: string }
  | {
      readonly kind: "chunk";
      readonly run: number;
      readonly id: string;
      readonly rate: number;
      readonly start: number;
      readonly channels: readonly Float32Array[];
      /** All of the file from this frame up to the end of the chunk was read. */
      readonly since: number;
    }
  /** The file of a sound ends before this frame. */
  | { readonly kind: "end"; readonly run: number; readonly id: string; readonly frame: number }
  /** For tests: sends what the engine gives, before it goes to the browser, see `captured`. */
  | { readonly kind: "capture"; readonly on: boolean };

/** What the mixer in the audio thread tells the page. */
export type MixerReport =
  /** A sound was silent for `ms` from `seconds` on the timeline, because its samples were late. */
  | { readonly kind: "late"; readonly id: string; readonly ms: number; readonly seconds: number }
  /** What the engine gave for samples `sample` on of the timeline, one quantum. */
  | {
      readonly kind: "captured";
      readonly sample: number;
      readonly rate: number;
      readonly left: Float32Array;
      readonly right: Float32Array;
    };

/** How much of a sound to keep behind where playing is, in samples of the timeline. */
const KEEP_BEHIND = MIX_RATE / 2;
/** How often to let go of what was played, in quanta. */
const TIDY_EVERY = 32;

interface Late {
  readonly from: number;
  count: number;
  /** Whether it was still late in this quantum. */
  now: boolean;
}

/**
 * The mixer of the preview, as the audio thread runs it (`mixer-worklet.ts`): the mix engine, the
 * samples the page sends it, and playing, from a sample of the timeline at a rate. Kept apart from
 * the worklet so that it can be tested without one.
 */
export class MixerCore {
  readonly #post: (report: MixerReport, transfer?: Transferable[]) => void;
  /** Frames of the context per second. */
  readonly #contextRate: number;
  readonly #stores = new Map<string, SampleStore>();
  readonly #engine: MixEngine;
  readonly #late = new Map<string, Late>();
  #run = -1;
  #sounds = new Map<string, MixSound>();
  #playing: { frame: number; sample: number; rate: number } | undefined;
  #capture = false;
  #quanta = 0;
  #scratch = [new Float32Array(BLOCK + 2), new Float32Array(BLOCK + 2)] as const;

  constructor(post: (report: MixerReport, transfer?: Transferable[]) => void, contextRate: number) {
    this.#post = post;
    this.#contextRate = contextRate;
    this.#engine = new MixEngine(
      { sounds: [], tracks: [] },
      (sound) => this.#stores.get(sound.id),
      (sound, from, count) => this.#missing(sound, from, count),
    );
  }

  receive(message: MixerMessage): void {
    switch (message.kind) {
      case "plan":
        this.#setPlan(message.plan);
        return;
      case "play":
        this.#stop();
        this.#run = message.run;
        this.#setPlan(message.plan);
        this.#playing = { frame: message.frame, sample: message.sample, rate: message.rate };
        return;
      case "stop":
        this.#stop();
        return;
      case "open":
        if (message.run === this.#run && !this.#stores.has(message.id)) {
          this.#stores.set(message.id, new SampleStore());
        }
        return;
      case "chunk": {
        if (message.run !== this.#run) return;
        const store = this.#storeOf(message.id);
        store.add(message);
        store.cover(message.since, message.start + (message.channels[0]?.length ?? 0));
        return;
      }
      case "end":
        if (message.run === this.#run) this.#storeOf(message.id).endAt(message.frame);
        return;
      case "capture":
        this.#capture = message.on;
        return;
    }
  }

  /** One quantum of the context, from its frame `frame` on, into `left` and `right`. */
  process(frame: number, left: Float32Array, right: Float32Array): void {
    const playing = this.#playing;
    const frames = left.length;
    if (!playing) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const rate = playing.rate * (MIX_RATE / this.#contextRate);
    const first = playing.sample + (frame - playing.frame) * rate;
    if (rate === 1) this.#engine.render(first, frames, left, right);
    else this.#stretch(first, rate, left, right);
    // What lies before where it started is not played, as with a player.
    const before = rate > 0 ? playing.sample - first : first - playing.sample;
    if (before > 0) {
      const silent = Math.min(Math.ceil(before / Math.abs(rate)), frames);
      left.fill(0, 0, silent);
      right.fill(0, 0, silent);
    }
    this.#reportLate();
    if (this.#capture) {
      const copies = { left: left.slice(), right: right.slice() };
      this.#post({ kind: "captured", sample: first, rate, ...copies }, [
        copies.left.buffer,
        copies.right.buffer,
      ]);
    }
    this.#quanta += 1;
    if (this.#quanta % TIDY_EVERY === 0) this.#tidy(first, rate);
  }

  /**
   * Faster, slower or backwards: the timeline as the engine has it, read at that rate, linear
   * between samples, as the browser plays a buffer at another rate. Only for J, K and L, and for a
   * device that cannot run at the rate of the mix.
   */
  #stretch(first: number, rate: number, left: Float32Array, right: Float32Array): void {
    const frames = left.length;
    const last = first + (frames - 1) * rate;
    const low = Math.floor(Math.min(first, last));
    const length = Math.floor(Math.max(first, last)) - low + 2;
    if (this.#scratch[0].length < length) {
      this.#scratch = [new Float32Array(length), new Float32Array(length)];
    }
    const [mixedLeft, mixedRight] = this.#scratch;
    this.#engine.render(low, length, mixedLeft, mixedRight);
    for (let index = 0; index < frames; index += 1) {
      const at = first + index * rate - low;
      const whole = Math.floor(at);
      const share = at - whole;
      const l0 = mixedLeft[whole] ?? 0;
      const r0 = mixedRight[whole] ?? 0;
      left[index] = l0 + share * ((mixedLeft[whole + 1] ?? 0) - l0);
      right[index] = r0 + share * ((mixedRight[whole + 1] ?? 0) - r0);
    }
  }

  #storeOf(id: string): SampleStore {
    let store = this.#stores.get(id);
    if (!store) {
      store = new SampleStore();
      this.#stores.set(id, store);
    }
    return store;
  }

  #missing(sound: MixSound, from: number, count: number): void {
    const late = this.#late.get(sound.id);
    if (late && late.from + late.count >= from - BLOCK && late.from <= from) {
      late.count = Math.max(late.count, from + count - late.from);
      late.now = true;
    } else {
      if (late) this.#flush(sound.id, late);
      this.#late.set(sound.id, { from, count, now: true });
    }
  }

  /** Says how long a sound was late once it is here again. */
  #reportLate(): void {
    for (const [id, late] of this.#late) {
      if (late.now) late.now = false;
      else this.#flush(id, late);
    }
  }

  #flush(id: string, late: Late): void {
    this.#late.delete(id);
    this.#post({
      kind: "late",
      id,
      ms: Math.round((late.count / MIX_RATE) * 1000),
      seconds: late.from / MIX_RATE,
    });
  }

  #stop(): void {
    for (const [id, late] of this.#late) this.#flush(id, late);
    this.#playing = undefined;
    this.#stores.clear();
    this.#run = -1;
  }

  #setPlan(plan: MixPlan): void {
    this.#engine.setPlan(plan);
    this.#sounds = new Map(plan.sounds.map((sound) => [sound.id, sound]));
  }

  /** Lets go of what was played, and of sounds that are no longer in the plan. */
  #tidy(at: number, rate: number): void {
    for (const [id, store] of this.#stores) {
      const sound = this.#sounds.get(id);
      if (!sound) {
        this.#stores.delete(id);
        continue;
      }
      const fileRate = store.rate;
      if (fileRate === undefined) continue;
      const frame = (at / MIX_RATE - sound.start + sound.offset) * fileRate;
      const keep = (KEEP_BEHIND * fileRate) / MIX_RATE;
      if (rate > 0) store.keepOnly(Math.floor(frame - keep), Number.POSITIVE_INFINITY);
      else store.keepOnly(Number.NEGATIVE_INFINITY, Math.ceil(frame + keep));
    }
  }
}
