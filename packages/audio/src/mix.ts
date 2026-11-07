import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { readSound, type SoundChunk, type SoundReader } from "./index.ts";

/** What a mix is rendered at. Every encoder takes it, and video works with it. */
export const MIX_SAMPLE_RATE = 48_000;
export const MIX_CHANNELS = 2;
/**
 * How much of the timeline gets mixed at once. A piece holds this much of every sound that plays in
 * it, decoded, and the mix itself: ten seconds of stereo are 3.8 MB of samples.
 */
export const MIX_PIECE_SECONDS = 10;

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

/** Where the samples of a sound come from. Sounds made by code get theirs from somewhere else. */
export type SoundSource = (
  sound: SoundLayer,
) => Promise<((from: number, to: number) => ReturnType<SoundReader>) | undefined>;

/** What a mix needs of the context it renders in, so that it can be tested without one. */
export type MixContext = Pick<
  OfflineAudioContext,
  "createGain" | "createBufferSource" | "destination" | "startRendering"
>;

export interface MixerOptions {
  /** Resolves to undefined when the file is not here. */
  readonly fileOf: (file: string) => Promise<Blob | undefined>;
  readonly read?: SoundReader;
  /** Takes over for the sounds it knows, for sounds that are no file. */
  readonly source?: SoundSource;
  readonly createContext?: (channels: number, length: number, sampleRate: number) => MixContext;
}

/** Where a sound plays in a piece of the timeline, and which part of its file that is. */
export interface Placement {
  readonly sound: SoundLayer;
  /** Seconds on the timeline. */
  readonly from: number;
  readonly to: number;
}

/** The sounds that are heard in a piece of the timeline, and for how long. */
export function placementsIn(plan: AudioPlan, from: number, to: number): Placement[] {
  return plan.sounds.flatMap((sound) => {
    const begin = Math.max(sound.start, from);
    const end = Math.min(sound.end, to);
    return end > begin && sound.gain > 0 ? [{ sound, from: begin, to: end }] : [];
  });
}

/**
 * Mixes what a plan says, one piece of the timeline at a time, the way playback would sound: each
 * sound at its place, from its offset, with its volume. Muted and soloed tracks are already in the
 * plan. Nothing here holds more than a piece.
 */
/** A sound being read front to back, from one piece of the mix to the next. */
interface Stream {
  readonly chunks: AsyncIterator<SoundChunk>;
  /** What was read for the next piece already. */
  held: SoundChunk[];
  /** Seconds in the file up to which it was mixed. */
  mixed: number;
}

/** Further back than this is a new reading of the file: frames do not start exactly anywhere. */
const BACK_TOLERANCE = 1e-6;
/** Further ahead than this is quicker to get to by finding the place than by reading through. */
const SKIP_AHEAD_SECONDS = 5;

/**
 * Mixes what a plan says, one piece of the timeline at a time, the way playback would sound: each
 * sound at its place, from its offset, with its volume. Muted and soloed tracks are already in the
 * plan. Nothing here holds more than a piece.
 *
 * Each sound gets read once, front to back, over all the pieces it is in. Reading from somewhere in
 * the middle can take long: a file without an index, such as many MP3, gets read from its start for
 * that, and every piece would pay for it again.
 */
export class SoundMixer {
  readonly #plan: AudioPlan;
  readonly #options: MixerOptions;
  readonly #streams = new Map<string, Stream>();

  constructor(plan: AudioPlan, options: MixerOptions) {
    this.#plan = plan;
    this.#options = options;
  }

  /** Whether there is anything to hear at all. */
  get silent(): boolean {
    return this.#plan.sounds.every(({ gain, end, start }) => gain <= 0 || end <= start);
  }

  /** The samples of the timeline from `from` for `frames` samples, at the rate of the mix. */
  async mix(from: number, frames: number): Promise<AudioBuffer> {
    const create =
      this.#options.createContext ??
      ((channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate));
    const context = create(MIX_CHANNELS, frames, MIX_SAMPLE_RATE);
    const to = from + frames / MIX_SAMPLE_RATE;
    const placements = placementsIn(this.#plan, from, to);
    // What is over, or not in this piece, is not read any further.
    const heard = new Set(placements.map(({ sound }) => sound.id));
    for (const id of this.#streams.keys()) if (!heard.has(id)) this.#end(id);
    for (const placement of placements) await this.#place(context, placement, from);
    return context.startRendering();
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

  async #open(sound: SoundLayer, from: number): Promise<Stream> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    let read: (from: number, to: number) => ReturnType<SoundReader>;
    const own = await this.#options.source?.(sound);
    if (own) read = own;
    else {
      const file = await this.#options.fileOf(sound.file).catch(() => undefined);
      if (!file) throw new SoundFailed(sound, "missing-file");
      const reader = this.#options.read ?? readSound;
      read = (start, end) => reader(file, start, end);
    }
    const chunks = read(from, toFile(sound.end))[Symbol.asyncIterator]();
    return { chunks, held: [], mixed: from };
  }

  async #place(context: MixContext, { sound, from, to }: Placement, start: number): Promise<void> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    const fileFrom = toFile(from);
    const fileTo = toFile(to);
    let stream = this.#streams.get(sound.id);
    const elsewhere =
      stream &&
      (fileFrom + BACK_TOLERANCE < stream.mixed || fileFrom - stream.mixed > SKIP_AHEAD_SECONDS);
    if (!stream || elsewhere) {
      if (stream) this.#end(sound.id);
      stream = await this.#open(sound, fileFrom);
      this.#streams.set(sound.id, stream);
    }
    const gain = context.createGain();
    gain.gain.value = sound.gain;
    gain.connect(context.destination);
    try {
      for (;;) {
        const chunk = stream.held.shift() ?? (await this.#pull(stream));
        if (!chunk) break;
        const ends = chunk.timestamp + chunk.duration;
        // What was read past the last piece and is still before this one.
        if (ends <= fileFrom) continue;
        if (chunk.timestamp >= fileTo) {
          stream.held.unshift(chunk);
          break;
        }
        // Where the chunk is on the timeline, and the part of it that is heard here.
        const at = sound.start + chunk.timestamp - sound.offset;
        const begin = Math.max(at, from);
        const end = Math.min(at + chunk.duration, to);
        if (end > begin) {
          const node = context.createBufferSource();
          node.buffer = chunk.buffer;
          node.connect(gain);
          node.start(begin - start, begin - at, end - begin);
        }
        // It goes on into the next piece.
        if (ends > fileTo) {
          stream.held.unshift(chunk);
          break;
        }
      }
      stream.mixed = fileTo;
    } catch (error) {
      this.#end(sound.id);
      throw new SoundFailed(sound, "cannot-decode", error);
    }
  }

  async #pull(stream: Stream): Promise<SoundChunk | undefined> {
    const result = await stream.chunks.next();
    return result.done ? undefined : result.value;
  }
}
