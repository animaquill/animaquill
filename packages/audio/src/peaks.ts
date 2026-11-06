import type { SoundChunk } from "./index.ts";

/** Enough to see words in speech when zoomed in, at a third of a megabyte per hour. */
export const PEAKS_PER_SECOND = 100;

/** Decoding is slow but not urgent, so it lets the editor breathe in between. */
const CHUNKS_PER_BREATH = 16;

const breathe = () => new Promise((resolve) => setTimeout(resolve));

/** How loud a sound is over time: the highest level of each moment, from 0 to 255. */
export async function computePeaks(chunks: AsyncIterable<SoundChunk>): Promise<Uint8Array> {
  let peaks = new Uint8Array(PEAKS_PER_SECOND * 60);
  let length = 0;
  let count = 0;
  for await (const { buffer, timestamp } of chunks) {
    const first = Math.floor(timestamp * PEAKS_PER_SECOND);
    const last = Math.ceil((timestamp + buffer.duration) * PEAKS_PER_SECOND);
    if (last > peaks.length) {
      const larger = new Uint8Array(Math.max(last, peaks.length * 2));
      larger.set(peaks);
      peaks = larger;
    }
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1) {
        const moment = timestamp + index / buffer.sampleRate;
        const slot = Math.max(Math.floor(moment * PEAKS_PER_SECOND), first);
        const level = Math.min(Math.round(Math.abs(samples[index] ?? 0) * 255), 255);
        if (level > (peaks[slot] ?? 0)) peaks[slot] = level;
      }
    }
    length = Math.max(length, last);
    count += 1;
    if (count % CHUNKS_PER_BREATH === 0) await breathe();
  }
  return peaks.slice(0, length);
}
