import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { readSound, type SoundReader } from "./index.ts";

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
export class SoundMixer {
  readonly #plan: AudioPlan;
  readonly #options: MixerOptions;

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
    for (const placement of placementsIn(this.#plan, from, to)) {
      await this.#place(context, placement, from);
    }
    return context.startRendering();
  }

  async #readerOf(sound: SoundLayer) {
    const own = await this.#options.source?.(sound);
    if (own) return own;
    const file = await this.#options.fileOf(sound.file).catch(() => undefined);
    if (!file) throw new SoundFailed(sound, "missing-file");
    const read = this.#options.read ?? readSound;
    return (from: number, to: number) => read(file, from, to);
  }

  async #place(context: MixContext, { sound, from, to }: Placement, start: number): Promise<void> {
    const read = await this.#readerOf(sound);
    const gain = context.createGain();
    gain.gain.value = sound.gain;
    gain.connect(context.destination);
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    try {
      for await (const chunk of read(toFile(from), toFile(to))) {
        // Where the chunk is on the timeline, and the part of it that is heard here.
        const at = sound.start + chunk.timestamp - sound.offset;
        const begin = Math.max(at, from);
        const end = Math.min(at + chunk.duration, to);
        if (end <= begin) continue;
        const node = context.createBufferSource();
        node.buffer = chunk.buffer;
        node.connect(gain);
        node.start(begin - start, begin - at, end - begin);
      }
    } catch (error) {
      throw new SoundFailed(sound, "cannot-decode", error);
    }
  }
}
