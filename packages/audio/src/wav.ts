/** How much gets written in one go, so that a long sound leaves room for everything else. */
const FRAMES_PER_BLOCK = 1 << 16;

const FLOAT_FORMAT = 3;
const BYTES_PER_SAMPLE = 4;
const HEADER_BYTES = 44;

const breathe = () => new Promise((resolve) => setTimeout(resolve));

function header(channels: number, frames: number, sampleRate: number): ArrayBuffer {
  const bytes = frames * channels * BYTES_PER_SAMPLE;
  const view = new DataView(new ArrayBuffer(HEADER_BYTES));
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(at + index, value.charCodeAt(index));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + bytes, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FLOAT_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  return view.buffer as ArrayBuffer;
}

/** Nothing that goes on from here can be louder than full scale, or not a number. */
const sane = (sample: number) => (sample >= -1 ? (sample <= 1 ? sample : 1) : sample < -1 ? -1 : 0);

/**
 * A sound file out of what code came up with: all of one channel, then the next, as 32-bit floats.
 * Those samples are not to be trusted, so nothing of them gets through unchecked. A float file keeps
 * them as they were, and it is what everything else can already read.
 */
export async function wavOf(
  samples: Blob,
  channels: number,
  frames: number,
  sampleRate: number,
): Promise<Blob> {
  const parts: BlobPart[] = [header(channels, frames, sampleRate)];
  const bytesPerChannel = frames * BYTES_PER_SAMPLE;
  for (let first = 0; first < frames; first += FRAMES_PER_BLOCK) {
    const count = Math.min(FRAMES_PER_BLOCK, frames - first);
    const block = new Float32Array(count * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      const from = channel * bytesPerChannel + first * BYTES_PER_SAMPLE;
      const part = samples.slice(from, from + count * BYTES_PER_SAMPLE);
      const read = new Float32Array(await part.arrayBuffer());
      for (let index = 0; index < count; index += 1) {
        block[index * channels + channel] = sane(read[index] as number);
      }
    }
    parts.push(block.buffer as ArrayBuffer);
    await breathe();
  }
  return new Blob(parts, { type: "audio/wav" });
}
