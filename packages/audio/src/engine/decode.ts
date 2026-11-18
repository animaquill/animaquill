import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import type { DecodedChunk } from "./samples.ts";

/** Reads a file from `from` up to `to`, in seconds of it, as chunks of samples. */
export type SampleReader = (file: Blob, from: number, to: number) => AsyncIterable<DecodedChunk>;

/**
 * Decodes bit by bit, because an hour of decoded sound would not fit in memory. Works in a worker
 * too, where there is no `AudioBuffer`: the samples are the same that `AudioBufferSink` gives.
 */
export async function* readSamples(
  file: Blob,
  from: number,
  to: number,
): AsyncGenerator<DecodedChunk> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error("Cannot decode this sound");
    for await (const sample of new AudioSampleSink(track).samples(from, to)) {
      let chunk: DecodedChunk;
      try {
        const channels: Float32Array[] = [];
        for (let plane = 0; plane < sample.numberOfChannels; plane += 1) {
          const data = new Float32Array(sample.numberOfFrames);
          sample.copyTo(data, { planeIndex: plane, format: "f32-planar" });
          channels.push(data);
        }
        const rate = sample.sampleRate;
        chunk = { start: Math.round(sample.timestamp * rate), rate, channels };
      } finally {
        sample.close();
      }
      yield chunk;
    }
  } finally {
    input.dispose();
  }
}
