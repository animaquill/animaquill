import { MIX_CHANNELS, MIX_PIECE_SECONDS, MIX_SAMPLE_RATE } from "@animaquill/audio";
import type { EncodedFrame, SoundCodecName } from "@animaquill/media";

/** Enough for music, as streaming services have it for stereo. */
const SOUND_BITRATE = 192_000;
/** Pieces waiting in the encoder. Each is ten seconds, so one is plenty. */
const ENCODER_QUEUE = 2;

export interface SoundEncoding {
  readonly codec: SoundCodecName;
  readonly config: AudioEncoderConfig;
}

export type SoundSupportCheck = (config: AudioEncoderConfig) => Promise<boolean>;

export const browserSoundSupport: SoundSupportCheck = async (config) => {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
};

const CODEC_STRINGS: Readonly<Record<SoundCodecName, string>> = {
  aac: "mp4a.40.2",
  opus: "opus",
};

/**
 * AAC where it can be, which is what every player takes. Browsers without it get Opus, which goes in
 * an MP4 just as well and keeps the H.264 of the picture: changing to WebM for the sound would also
 * take H.264 away, and that would cost more players than Opus does. WebM only takes Opus.
 */
export async function chooseSoundEncoding(
  container: "mp4" | "webm",
  supported: SoundSupportCheck = browserSoundSupport,
): Promise<SoundEncoding | undefined> {
  const codecs: readonly SoundCodecName[] = container === "mp4" ? ["aac", "opus"] : ["opus"];
  for (const codec of codecs) {
    const config: AudioEncoderConfig = {
      codec: CODEC_STRINGS[codec],
      sampleRate: MIX_SAMPLE_RATE,
      numberOfChannels: MIX_CHANNELS,
      bitrate: SOUND_BITRATE,
    };
    if (await supported(config)) return { codec, config };
  }
  return undefined;
}

/** What a mixer gives: a piece of the timeline as samples. */
export interface PieceMixer {
  mix(from: number, frames: number): Promise<AudioBuffer>;
}

export type MakeAudioEncoder = (
  init: AudioEncoderInit,
) => Pick<AudioEncoder, "configure" | "encode" | "flush" | "close" | "encodeQueueSize">;

/**
 * The sound of an export: mixed piece by piece and encoded as it goes, so that the sound of an hour
 * is never in memory. It keeps up with the picture: `until` mixes as far as the frames have got, and
 * the file gets both in turns. Times of the file start at zero, like those of the picture.
 */
export class SoundTrackEncoder {
  readonly #mixer: PieceMixer;
  readonly #from: number;
  readonly #total: number;
  readonly #encoder: ReturnType<MakeAudioEncoder>;
  #done = 0;
  #failed: unknown;

  constructor(
    mixer: PieceMixer,
    range: { readonly from: number; readonly to: number },
    encoding: SoundEncoding,
    onChunk: (frame: EncodedFrame, decoderConfig?: AudioDecoderConfig) => void,
    make: MakeAudioEncoder = (init) => new AudioEncoder(init),
  ) {
    this.#mixer = mixer;
    this.#from = range.from;
    this.#total = Math.round((range.to - range.from) * MIX_SAMPLE_RATE);
    this.#encoder = make({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const frame: EncodedFrame = {
          data,
          key: true,
          timestamp: chunk.timestamp / 1e6,
          duration: (chunk.duration ?? 0) / 1e6,
        };
        onChunk(frame, meta?.decoderConfig);
      },
      error: (error) => {
        this.#failed ??= error;
      },
    });
    this.#encoder.configure(encoding.config);
  }

  /** Seconds of sound encoded so far. */
  get seconds(): number {
    return this.#done / MIX_SAMPLE_RATE;
  }

  /** Mixes and encodes until there is sound for this many seconds of the file, or all of it. */
  async until(seconds: number): Promise<void> {
    const wanted = Math.min(Math.ceil(seconds * MIX_SAMPLE_RATE), this.#total);
    while (this.#done < wanted) {
      if (this.#failed !== undefined) throw this.#failed;
      const frames = Math.min(MIX_PIECE_SECONDS * MIX_SAMPLE_RATE, this.#total - this.#done);
      const piece = await this.#mixer.mix(this.#from + this.#done / MIX_SAMPLE_RATE, frames);
      this.#encode(piece, this.#done);
      this.#done += frames;
      while (this.#encoder.encodeQueueSize > ENCODER_QUEUE && this.#failed === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (this.#failed !== undefined) throw this.#failed;
  }

  #encode(piece: AudioBuffer, at: number): void {
    const frames = piece.length;
    const data = new Float32Array(frames * MIX_CHANNELS);
    for (let channel = 0; channel < MIX_CHANNELS; channel += 1) {
      const from = Math.min(channel, piece.numberOfChannels - 1);
      data.set(piece.getChannelData(from).subarray(0, frames), channel * frames);
    }
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: MIX_SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: MIX_CHANNELS,
      timestamp: Math.round((at * 1e6) / MIX_SAMPLE_RATE),
      data,
    });
    try {
      this.#encoder.encode(audio);
    } finally {
      audio.close();
    }
  }

  /** All of it, and everything out of the encoder. */
  async finish(): Promise<void> {
    await this.until(Infinity);
    await this.#encoder.flush();
    this.#encoder.close();
    if (this.#failed !== undefined) throw this.#failed;
  }

  close(): void {
    try {
      this.#encoder.close();
    } catch {
      // It was closed already.
    }
  }
}
