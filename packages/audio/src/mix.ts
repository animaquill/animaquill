import type { MixPlan, MixSound, SoundLayer } from "@animaquill/core";
import { readSamples, type SampleReader } from "./engine/decode.ts";
import { MixEngine } from "./engine/engine.ts";
import { MIX_RATE } from "./engine/resample.ts";
import { SampleStore, type DecodedChunk } from "./engine/samples.ts";

/** What a mix is rendered at. Every encoder takes it, and video works with it. */
export const MIX_SAMPLE_RATE = MIX_RATE;
export const MIX_CHANNELS = 2;
/**
 * How much of the timeline gets mixed at once. A piece holds this much of every sound that plays in
 * it, decoded, and the mix itself: ten seconds of stereo are 3.8 MB of samples.
 */
export const MIX_PIECE_SECONDS = 10;
/**
 * Read around what a piece needs: the resampling of a sound at another rate takes in the samples
 * around each of its own, up to 64 of them at 192 kHz.
 */
const MARGIN_SECONDS = 0.01;

/** A sound that did not make it into the mix, by its clip. */
export class SoundFailed extends Error {
  readonly sound: SoundLayer;
  readonly reason: "missing-file" | "cannot-decode";

  constructor(sound: SoundLayer, reason: SoundFailed["reason"], cause?: unknown) {
    super(`Sound ${sound.id}: ${reason}`, { cause });
    this.sound = sound;
    this.reason = reason;
  }
}

/**
 * Where the samples of a sound come from when it is no file of the project, such as a sound that
 * code makes: its file. Undefined for the sounds it does not know.
 */
export type SoundSource = (sound: MixSound) => Promise<Blob | undefined>;

export interface MixerOptions {
  /** Resolves to undefined when the file is not here. */
  readonly fileOf: (file: string) => Promise<Blob | undefined>;
  readonly read?: SampleReader;
  /** Takes over for the sounds it knows, for sounds that are no file. */
  readonly source?: SoundSource;
}

/** A piece of the mix, as samples: what an `AudioBuffer` has of it. */
export interface MixedPiece {
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** A sound being read front to back, from one piece of the mix to the next. */
interface Stream {
  readonly chunks: AsyncIterator<DecodedChunk>;
  readonly store: SampleStore;
  /** Seconds in the file up to which it was read. */
  read: number;
  /** Seconds in the file up to which it was mixed. */
  mixed: number;
  done: boolean;
}

/** Further back than this is a new reading of the file: frames do not start exactly anywhere. */
const BACK_TOLERANCE = 1e-6;
/** Further ahead than this is quicker to get to by finding the place than by reading through. */
const SKIP_AHEAD_SECONDS = 5;

/** Where a moment of the timeline is in the file of a sound. */
const toFile = (sound: SoundLayer, seconds: number) => seconds - sound.start + sound.offset;

/**
 * Mixes what a plan says, one piece of the timeline at a time, with the mix engine (`MixEngine`),
 * the same code that plays the preview: so a piece is what the preview plays, sample by sample.
 * Muted and soloed tracks follow from the plan. Nothing here holds more than a piece.
 *
 * Each sound gets read once, front to back, over all the pieces it is in. Reading from somewhere in
 * the middle can take long: a file without an index, such as many MP3, gets read from its start for
 * that, and every piece would pay for it again.
 */
export class SoundMixer {
  readonly #options: MixerOptions;
  readonly #plan: MixPlan;
  readonly #engine: MixEngine;
  readonly #streams = new Map<string, Stream>();

  constructor(plan: MixPlan, options: MixerOptions) {
    this.#plan = plan;
    this.#options = options;
    this.#engine = new MixEngine(plan, (sound) => this.#streams.get(sound.id)?.store);
  }

  /** Whether there is anything to hear at all. */
  get silent(): boolean {
    return this.#engine.silent;
  }

  /** The samples of the timeline from `from` for `frames` samples, at the rate of the mix. */
  async mix(from: number, frames: number): Promise<MixedPiece> {
    const first = Math.round(from * MIX_RATE);
    // Effects take in what comes before a piece that does not follow on (see `MixEngine`), and
    // what comes after it, as far as limiters look ahead.
    const start = this.#engine.startFor(first) / MIX_RATE;
    const end = (first + frames + this.#engine.lookahead) / MIX_RATE;
    const heard = this.#plan.sounds.filter(
      (sound) => this.#engine.hears(sound) && sound.start < end && sound.end > start,
    );
    // What is over, or not in this piece, is not read any further.
    const ids = new Set(heard.map(({ id }) => id));
    for (const id of this.#streams.keys()) if (!ids.has(id)) this.#end(id);
    for (const sound of heard) {
      await this.#read(sound, Math.max(sound.start, start), Math.min(sound.end, end));
    }
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    this.#engine.render(first, frames, left, right);
    const channels = [left, right];
    return {
      length: frames,
      numberOfChannels: MIX_CHANNELS,
      getChannelData: (channel) => channels[channel] ?? left,
    };
  }

  /** Lets go of every file. */
  close(): void {
    for (const id of this.#streams.keys()) this.#end(id);
  }

  #end(id: string): void {
    const stream = this.#streams.get(id);
    this.#streams.delete(id);
    void stream?.chunks.return?.().catch(() => {});
  }

  async #open(sound: MixSound, from: number): Promise<Stream> {
    const own = await this.#options.source?.(sound);
    const file = own ?? (await this.#options.fileOf(sound.file).catch(() => undefined));
    if (!file) throw new SoundFailed(sound, "missing-file");
    const read = this.#options.read ?? readSamples;
    // Before the file begins there is nothing to read: it is silent there.
    const begin = Math.max(from - MARGIN_SECONDS, 0);
    const chunks = read(file, begin, toFile(sound, sound.end) + MARGIN_SECONDS)[
      Symbol.asyncIterator
    ]();
    return { chunks, store: new SampleStore(), read: begin, mixed: from, done: false };
  }

  /** Has the samples of a sound from `from` up to `to` on the timeline read, and those around. */
  async #read(sound: MixSound, from: number, to: number): Promise<void> {
    const fileFrom = toFile(sound, from);
    const fileTo = toFile(sound, to);
    let stream = this.#streams.get(sound.id);
    const elsewhere =
      stream &&
      (fileFrom + BACK_TOLERANCE < stream.mixed || fileFrom - stream.mixed > SKIP_AHEAD_SECONDS);
    if (!stream || elsewhere) {
      if (stream) this.#end(sound.id);
      stream = await this.#open(sound, fileFrom);
      this.#streams.set(sound.id, stream);
    }
    const { store } = stream;
    const rate = store.rate;
    // What earlier pieces needed and this one does not.
    if (rate !== undefined) {
      store.keepOnly(Math.floor((fileFrom - MARGIN_SECONDS) * rate), Number.POSITIVE_INFINITY);
    }
    try {
      while (!stream.done && stream.read < fileTo + MARGIN_SECONDS) {
        const next = await stream.chunks.next();
        if (next.done) {
          stream.done = true;
          break;
        }
        const chunk = next.value;
        const end = chunk.start + (chunk.channels[0]?.length ?? 0);
        store.add(chunk);
        // Everything from where it was read up to here: a gap before the chunk is silence.
        store.cover(Math.round(stream.read * chunk.rate), end);
        stream.read = end / chunk.rate;
      }
      const at = store.rate;
      if (stream.done && at !== undefined) store.endAt(Math.round(stream.read * at));
    } catch (error) {
      this.#end(sound.id);
      throw new SoundFailed(sound, "cannot-decode", error);
    }
    stream.mixed = fileTo;
  }
}
