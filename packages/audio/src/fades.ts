import { fadesDuring, fadesGainAt, type SoundLayer } from "@animaquill/core";
import type { SoundChunk } from "./index.ts";

/** Makes an empty buffer, as a context does. */
export type MakeBuffer = (channels: number, length: number, sampleRate: number) => AudioBuffer;

/** The moment on the timeline of a sample of a chunk, from where the chunk is in the file. */
export const sampleTime = (
  sound: Pick<SoundLayer, "start" | "offset">,
  timestamp: number,
  index: number,
  sampleRate: number,
): number => sound.start + (timestamp + index / sampleRate) - sound.offset;

/**
 * A chunk of a sound with its transitions worked into its samples, see `fadesGainAt`: each sample
 * by its own moment on the timeline, so that where chunks and pieces begin makes no difference.
 * Playback and the mix of an export both do this to every chunk they play, which is what makes the
 * two the same. A chunk that no transition changes is the same chunk.
 */
export function faded(sound: SoundLayer, chunk: SoundChunk, make: MakeBuffer): SoundChunk {
  const { fades } = sound;
  const at = sound.start + chunk.timestamp - sound.offset;
  if (!fadesDuring(fades, at, at + chunk.duration)) return chunk;
  const { buffer } = chunk;
  const { numberOfChannels, length, sampleRate } = buffer;
  const gains = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    gains[index] = fadesGainAt(fades, sampleTime(sound, chunk.timestamp, index, sampleRate));
  }
  const out = make(numberOfChannels, length, sampleRate);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const from = buffer.getChannelData(channel);
    const to = out.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      to[index] = (from[index] ?? 0) * (gains[index] ?? 0);
    }
  }
  return { ...chunk, buffer: out };
}
