import { audibleTracks, type MixPlan, type MixSound } from "@animaquill/core/mix-plan";
import { fadesDuring, fadesGainAt } from "@animaquill/core/sound-fades";
import { MIX_RATE, WHOLE, kernelFor, resample } from "./resample.ts";
import { SampleStore } from "./samples.ts";

/**
 * Samples that the engine works out at a time. Blocks start at whole multiples of it on the
 * timeline, wherever a mix starts, so that how a mix is cut into calls changes nothing.
 */
export const BLOCK = 128;

/** Where a sound gets its samples from, if anywhere yet. */
export type SamplesOf = (sound: MixSound) => SampleStore | undefined;

/** A sound should have played from sample `from` for `count` samples, but its samples were not here. */
export type OnMissing = (sound: MixSound, from: number, count: number) => void;

interface Voice {
  readonly sound: MixSound;
  /** The samples of the timeline it plays, from `first` up to `end`. */
  readonly first: number;
  readonly end: number;
}

interface Lane {
  readonly gain: number;
  readonly voices: readonly Voice[];
}

/**
 * Every step of the mix is rounded to 32 bits, as the browser's mix was (Web Audio works in 32-bit
 * floats): a project of one sound on a track at 0 dB sounds as before to the last bit.
 */
const f32 = Math.fround;

/** The first sample at or after a moment on the timeline. */
const sampleAt = (seconds: number) => Math.ceil(seconds * MIX_RATE - WHOLE);

/**
 * The mix: every sound at its place, from its offset, at the rate of the mix (see `resample.ts`),
 * down-mixed to two channels, with its transitions and the gain of its clip; the sounds of a track
 * added up, with the gain of the track; the tracks added up. Each step in 32-bit floats. Muted and soloed tracks follow from the
 * plan. Plain TypeScript, without Web Audio, so that the preview (in the audio thread), the export
 * and what AI hears (in a worker) all run this same code and get the same samples.
 *
 * It holds no state from one block to the next: the same plan and samples give the same block,
 * whichever came before it.
 */
export class MixEngine {
  readonly #samplesOf: SamplesOf;
  readonly #onMissing: OnMissing;
  #lanes: readonly Lane[] = [];
  #heard: ReadonlySet<MixSound> = new Set();
  readonly #master = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  readonly #lane = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  readonly #sound = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  #input = [new Float64Array(1024), new Float64Array(1024)] as const;
  /** The last block that only part of was asked for: the next call mostly wants the rest of it. */
  #cached: { block: number; left: Float32Array; right: Float32Array } | undefined;

  constructor(plan: MixPlan, samplesOf: SamplesOf, onMissing: OnMissing = () => {}) {
    this.#samplesOf = samplesOf;
    this.#onMissing = onMissing;
    this.setPlan(plan);
  }

  /** From the next block on, mixes what this plan says. */
  setPlan(plan: MixPlan): void {
    const audible = audibleTracks(plan.tracks);
    const heard = new Set<MixSound>();
    this.#lanes = plan.tracks.flatMap((track): Lane[] => {
      if (!audible.has(track.id) || !(track.gain > 0)) return [];
      const voices = plan.sounds.flatMap((sound): Voice[] => {
        if (sound.track !== track.id || !(sound.gain > 0)) return [];
        const first = sampleAt(sound.start);
        const end = sampleAt(sound.end);
        if (end <= first) return [];
        heard.add(sound);
        return [{ sound, first, end }];
      });
      return voices.length > 0 ? [{ gain: track.gain, voices }] : [];
    });
    this.#heard = heard;
    this.#cached = undefined;
  }

  /** Whether a sound of the plan is heard at all: on a track that is, and louder than nothing. */
  hears(sound: MixSound): boolean {
    return this.#heard.has(sound);
  }

  /** Whether any sound of the plan is heard. */
  get silent(): boolean {
    return this.#heard.size === 0;
  }

  /**
   * Samples `from` up to `from + frames` of the timeline (at the rate of the mix, from its start)
   * into `left` and `right` from `at` on.
   */
  render(from: number, frames: number, left: Float32Array, right: Float32Array, at = 0): void {
    const end = from + frames;
    let sample = from;
    while (sample < end) {
      const block = Math.floor(sample / BLOCK) * BLOCK;
      const upTo = Math.min(block + BLOCK, end);
      const into = at + sample - from;
      if (sample === block && upTo === block + BLOCK) {
        this.#block(block);
        const [masterLeft, masterRight] = this.#master;
        for (let index = 0; index < BLOCK; index += 1) {
          left[into + index] = masterLeft[index] ?? 0;
          right[into + index] = masterRight[index] ?? 0;
        }
      } else {
        const cached = this.#cachedBlock(block);
        left.set(cached.left.subarray(sample - block, upTo - block), into);
        right.set(cached.right.subarray(sample - block, upTo - block), into);
      }
      sample = upTo;
    }
  }

  #cachedBlock(block: number): { left: Float32Array; right: Float32Array } {
    const cached = this.#cached;
    if (cached?.block === block) return cached;
    const complete = this.#block(block);
    const [masterLeft, masterRight] = this.#master;
    const made = {
      block,
      left: cached?.left ?? new Float32Array(BLOCK),
      right: cached?.right ?? new Float32Array(BLOCK),
    };
    made.left.set(masterLeft);
    made.right.set(masterRight);
    // A block with samples missing could be complete by the next call.
    this.#cached = complete ? made : undefined;
    return made;
  }

  /** The block from sample `block` into the master. Returns whether no samples were missing. */
  #block(block: number): boolean {
    const [masterLeft, masterRight] = this.#master;
    masterLeft.fill(0);
    masterRight.fill(0);
    let complete = true;
    const [laneLeft, laneRight] = this.#lane;
    for (const lane of this.#lanes) {
      let used = false;
      for (const voice of lane.voices) {
        const from = Math.max(block, voice.first);
        const to = Math.min(block + BLOCK, voice.end);
        if (to <= from) continue;
        if (!used) {
          laneLeft.fill(0);
          laneRight.fill(0);
          used = true;
        }
        if (!this.#voice(voice, block, from, to)) complete = false;
      }
      if (!used) continue;
      const gain = f32(lane.gain);
      for (let index = 0; index < BLOCK; index += 1) {
        masterLeft[index] = f32((masterLeft[index] ?? 0) + f32((laneLeft[index] ?? 0) * gain));
        masterRight[index] = f32((masterRight[index] ?? 0) + f32((laneRight[index] ?? 0) * gain));
      }
    }
    return complete;
  }

  /**
   * Adds what a sound plays from sample `from` up to `to` of the block from sample `block` to the
   * lane. Returns false, and adds nothing, when its samples are not all here.
   */
  #voice({ sound }: Voice, block: number, from: number, to: number): boolean {
    const store = this.#samplesOf(sound);
    // Not being read (yet): nothing to miss, as a sound that code is still making.
    if (!store) return true;
    const rate = store.rate;
    const count = to - from;
    if (rate === undefined) {
      // The file ended before anything of it came: there is nothing to miss.
      if (store.ended) return true;
      this.#onMissing(sound, from, count);
      return false;
    }
    const [soundLeft, soundRight] = this.#sound;
    const mono = store.channels === 1;
    // Where the block starts in the file, in its samples: from its own start, so that every sample
    // has the same position however the mix is cut.
    const anchor = (block / MIX_RATE - sound.start + sound.offset) * rate;
    const offset = from - block;
    let complete: boolean;
    if (rate === MIX_RATE && Math.abs(anchor - Math.round(anchor)) < WHOLE) {
      complete = store.read(Math.round(anchor) + offset, count, soundLeft, soundRight, offset);
    } else {
      complete = this.#resample(store, rate, anchor, offset, count, mono);
    }
    if (!complete) {
      this.#onMissing(sound, from, count);
      return false;
    }
    const [laneLeft, laneRight] = this.#lane;
    const { fades } = sound;
    const gain = f32(sound.gain);
    const fading = fadesDuring(fades, from / MIX_RATE, to / MIX_RATE);
    for (let index = offset; index < offset + count; index += 1) {
      // The transitions first, then the gain of the clip, each in 32 bits as the browser had them.
      const fade = fading ? f32(fadesGainAt(fades, (block + index) / MIX_RATE)) : 1;
      let left = f32(soundLeft[index] ?? 0);
      if (fading) left = f32(left * fade);
      left = f32(left * gain);
      laneLeft[index] = f32((laneLeft[index] ?? 0) + left);
      let right = left;
      if (!mono) {
        right = f32(soundRight[index] ?? 0);
        if (fading) right = f32(right * fade);
        right = f32(right * gain);
      }
      laneRight[index] = f32((laneRight[index] ?? 0) + right);
    }
    return true;
  }

  /** Samples `offset` up to `offset + count` of the block, from a file at another rate. */
  #resample(
    store: SampleStore,
    rate: number,
    anchor: number,
    offset: number,
    count: number,
    mono: boolean,
  ): boolean {
    const kernel = kernelFor(rate);
    const { width } = kernel;
    const step = rate / MIX_RATE;
    const firstAt = anchor + offset * step;
    const lastAt = anchor + (offset + count - 1) * step;
    const first = Math.floor(firstAt) - width + 1;
    const length = Math.floor(lastAt) + width - first + 1;
    if (this.#input[0].length < length) {
      this.#input = [new Float64Array(length * 2), new Float64Array(length * 2)];
    }
    const [inputLeft, inputRight] = this.#input;
    const complete = store.read(first, length, inputLeft, inputRight, 0);
    if (!complete) return false;
    const [soundLeft, soundRight] = this.#sound;
    resample(
      kernel,
      inputLeft,
      mono ? undefined : inputRight,
      first,
      anchor,
      step,
      offset,
      count,
      soundLeft,
      soundRight,
    );
    return true;
  }
}

/**
 * Has the engine work out a little of every kind of sound once, so that the first quanta of real
 * playing do not wait for the JavaScript engine to compile it: rates to resample from, one channel
 * and six, transitions. Takes some tens of milliseconds; the audio thread does it once, when it is
 * made, before anything plays.
 */
export function warmUp(): void {
  const fades = [
    { use: "enter", way: "in", shape: "power", start: 0, end: 1, duration: 1 },
    { use: "exit", way: "out", shape: "gain", start: 0, end: 1, duration: 1 },
  ] as const;
  const kinds = [
    { rate: MIX_RATE, channels: 2, offset: 0 },
    { rate: MIX_RATE, channels: 1, offset: 0.3 / MIX_RATE },
    { rate: 44_100, channels: 2, offset: 0 },
    { rate: 22_050, channels: 1, offset: 0 },
    { rate: 96_000, channels: 6, offset: 0 },
  ];
  const stores = kinds.map(({ rate, channels }) => {
    const store = new SampleStore();
    store.add({
      start: 0,
      rate,
      channels: Array.from({ length: channels }, () => new Float32Array(rate / 2)),
    });
    store.endAt(rate / 2);
    return store;
  });
  const sounds = kinds.map(({ offset }, index) => ({
    id: String(index),
    file: String(index),
    track: "warm",
    start: 0,
    end: 0.5,
    offset,
    gain: 0.5,
    fades: index % 2 === 0 ? fades : [],
  }));
  const engine = new MixEngine(
    { sounds, tracks: [{ id: "warm", gain: 0.5, muted: false, solo: false }] },
    (sound) => stores[Number(sound.id)],
  );
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let at = 0; at < MIX_RATE / 4; at += BLOCK) engine.render(at, BLOCK, left, right);
}
