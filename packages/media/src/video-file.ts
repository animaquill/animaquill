import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from "mediabunny";

/** What an export can encode with, best first. H.264 is what every player takes. */
export type VideoCodecName = "avc" | "vp9" | "av1";

/** H.264 goes in MP4. The others go in WebM, which plays in browsers and not everywhere else. */
export const containerOf = (codec: VideoCodecName): "mp4" | "webm" =>
  codec === "avc" ? "mp4" : "webm";

/** Where the bytes go. Anything that can write anywhere in a file, see `GrowingFile`. */
export interface ByteSink {
  write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void>;
}

/** One frame as an encoder gives it. Times are in seconds. */
export interface EncodedFrame {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly timestamp: number;
  readonly duration: number;
}

/** What sound can be encoded with. AAC is what every player takes, Opus is what browsers have. */
export type SoundCodecName = "aac" | "opus";

export interface VideoFileOptions {
  readonly codec: VideoCodecName;
  /** Frames per second. */
  readonly frameRate: number;
  /** A track of sound, if there is any. */
  readonly sound?: SoundCodecName;
}

/**
 * Bytes get collected up to this before they are written: a write to a file people chose is a write
 * to the disk, and one per frame would be slow. It is also all the file that is ever in memory.
 */
const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * A video file that frames go into one after the other, and that gets written while that happens.
 * An MP4 has its index at the end, which takes going back to the start once to say how long the data
 * is. It does not keep the frames: nothing about it grows with the length of the video but that index.
 */
export class VideoFileWriter {
  readonly #output: Output;
  readonly #source: EncodedVideoPacketSource;
  readonly #sound: EncodedAudioPacketSource | undefined;
  #first = true;
  #firstSound = true;

  private constructor(
    output: Output,
    source: EncodedVideoPacketSource,
    sound: EncodedAudioPacketSource | undefined,
  ) {
    this.#output = output;
    this.#source = source;
    this.#sound = sound;
  }

  static async start(sink: ByteSink, { codec, frameRate, sound }: VideoFileOptions) {
    const writable = new WritableStream<StreamTargetChunk>({
      write: ({ data, position }) => sink.write(data, position),
    });
    const format =
      containerOf(codec) === "mp4"
        ? new Mp4OutputFormat({ fastStart: false })
        : new WebMOutputFormat();
    const target = new StreamTarget(writable, { chunked: true, chunkSize: CHUNK_BYTES });
    const output = new Output({ format, target });
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source, { frameRate });
    const soundSource = sound ? new EncodedAudioPacketSource(sound) : undefined;
    if (soundSource) output.addAudioTrack(soundSource);
    await output.start();
    return new VideoFileWriter(output, source, soundSource);
  }

  /** In the order of decoding. The first one needs what the encoder said about how to decode. */
  async add(frame: EncodedFrame, decoderConfig?: VideoDecoderConfig): Promise<void> {
    const { data, key, timestamp, duration } = frame;
    const packet = new EncodedPacket(data, key ? "key" : "delta", timestamp, duration);
    const meta = this.#first && decoderConfig ? { decoderConfig } : undefined;
    this.#first = false;
    await this.#source.add(packet, meta);
  }

  /**
   * Sound in the order it was encoded. It goes in between the frames of the same time, which is what
   * lets a player read the file front to back, so it should come along with the frames.
   */
  async addSound(frame: EncodedFrame, decoderConfig?: AudioDecoderConfig): Promise<void> {
    if (!this.#sound) throw new Error("This file has no sound");
    const { data, timestamp, duration } = frame;
    const packet = new EncodedPacket(data, "key", timestamp, duration);
    const meta = this.#firstSound && decoderConfig ? { decoderConfig } : undefined;
    this.#firstSound = false;
    await this.#sound.add(packet, meta);
  }

  /** Writes what is left, and the index. */
  async finish(): Promise<void> {
    this.#source.close();
    this.#sound?.close();
    await this.#output.finalize();
  }

  async cancel(): Promise<void> {
    await this.#output.cancel();
  }
}
