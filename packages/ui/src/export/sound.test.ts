import type { EncodedFrame } from "@animaquill/media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSoundEncoding, SoundTrackEncoder, type MakeAudioEncoder } from "./sound.ts";

/** Enough of AudioData to see what goes to the encoder. */
class FakeAudioData {
  readonly timestamp: number;
  readonly numberOfFrames: number;
  readonly data: Float32Array;
  closed = false;
  constructor(init: { timestamp: number; numberOfFrames: number; data: Float32Array }) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
    this.data = init.data;
  }
  close() {
    this.closed = true;
  }
}

/** An encoder that gives one chunk per piece, of the same time. */
function fakeEncoder() {
  const encoded: FakeAudioData[] = [];
  let output: AudioEncoderInit["output"] = () => {};
  let error: AudioEncoderInit["error"] = () => {};
  const make: MakeAudioEncoder = (init) => {
    output = init.output;
    error = init.error;
    return {
      configure: vi.fn(),
      encodeQueueSize: 0,
      encode(data: AudioData) {
        const audio = data as unknown as FakeAudioData;
        encoded.push(audio);
        const chunk = {
          byteLength: 1,
          timestamp: audio.timestamp,
          duration: Math.round((audio.numberOfFrames * 1e6) / 48_000),
          copyTo: (into: Uint8Array) => into.set([7]),
        };
        output(chunk as unknown as EncodedAudioChunk, {
          decoderConfig: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
        });
      },
      flush: async () => {},
      close: vi.fn(),
    };
  };
  return { make, encoded, fail: (reason: Error) => error(reason as DOMException) };
}

const buffer = (length: number, value = 0.25) =>
  ({
    length,
    numberOfChannels: 2,
    getChannelData: (channel: number) => new Float32Array(length).fill(value + channel),
  }) as unknown as AudioBuffer;

function setup(range = { from: 5, to: 30 }) {
  const asked: { from: number; frames: number }[] = [];
  const mixer = {
    mix: vi.fn(async (from: number, frames: number) => {
      asked.push({ from, frames });
      return buffer(frames);
    }),
  };
  const chunks: EncodedFrame[] = [];
  const encoder = fakeEncoder();
  const encoding = {
    codec: "opus" as const,
    config: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
  };
  const track = new SoundTrackEncoder(
    mixer,
    range,
    encoding,
    (frame) => chunks.push(frame),
    encoder.make,
  );
  return { track, asked, chunks, encoder };
}

beforeEach(() => vi.stubGlobal("AudioData", FakeAudioData));
afterEach(() => vi.unstubAllGlobals());

describe("the sound of an export", () => {
  it("is mixed in pieces of ten seconds, from the start of the range", async () => {
    const { track, asked } = setup();
    await track.finish();
    expect(asked).toEqual([
      { from: 5, frames: 480_000 },
      { from: 15, frames: 480_000 },
      { from: 25, frames: 240_000 },
    ]);
  });

  it("is as long as the picture, to the sample", async () => {
    const { track, encoder } = setup({ from: 0, to: 2.5 });
    await track.finish();
    expect(encoder.encoded.reduce((all, { numberOfFrames }) => all + numberOfFrames, 0)).toBe(
      120_000,
    );
    expect(track.seconds).toBe(2.5);
  });

  it("starts the file at zero, like the picture, and goes on without gaps", async () => {
    const { track, encoder, chunks } = setup();
    await track.finish();
    expect(encoder.encoded.map(({ timestamp }) => timestamp)).toEqual([0, 10_000_000, 20_000_000]);
    expect(chunks.map(({ timestamp }) => timestamp)).toEqual([0, 10, 20]);
    expect(encoder.encoded.every(({ closed }) => closed)).toBe(true);
  });

  it("puts each channel after the other, as the encoder takes them", async () => {
    const { track, encoder } = setup({ from: 0, to: 1 });
    await track.finish();
    const { data } = encoder.encoded[0] as FakeAudioData;
    expect(data[0]).toBe(0.25);
    expect(data[48_000]).toBe(1.25);
  });

  it("only mixes as far as it is asked, so that it keeps up with the picture", async () => {
    const { track, asked } = setup();
    await track.until(1);
    expect(asked).toHaveLength(1);
    await track.until(10);
    expect(asked).toHaveLength(1);
    await track.until(10.5);
    expect(asked).toHaveLength(2);
  });

  it("stops when the encoder fails", async () => {
    const { track, encoder } = setup();
    await track.until(1);
    encoder.fail(new Error("broken"));
    await expect(track.until(20)).rejects.toThrow("broken");
  });

  it("stops when a sound does not make it into the mix", async () => {
    const { track, asked } = setup();
    const mixer = { mix: () => Promise.reject(new Error("missing")) };
    const failing = new SoundTrackEncoder(
      mixer,
      { from: 0, to: 5 },
      { codec: "opus", config: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 } },
      () => {},
      fakeEncoder().make,
    );
    await expect(failing.until(1)).rejects.toThrow("missing");
    expect(asked).toEqual([]);
    void track;
  });
});

describe("the codec of the sound", () => {
  const only = (codec: string) => async (config: AudioEncoderConfig) => config.codec === codec;

  it("is AAC in an MP4 where it can be", async () => {
    expect((await chooseSoundEncoding("mp4", async () => true))?.codec).toBe("aac");
    expect((await chooseSoundEncoding("mp4", async () => true))?.config).toMatchObject({
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: 192_000,
    });
  });

  it("is Opus in the same MP4 where there is no AAC", async () => {
    expect((await chooseSoundEncoding("mp4", only("opus")))?.codec).toBe("opus");
  });

  it("is always Opus in WebM, which takes nothing else", async () => {
    const asked: string[] = [];
    const encoding = await chooseSoundEncoding("webm", async ({ codec }) => {
      asked.push(codec);
      return true;
    });
    expect(encoding?.codec).toBe("opus");
    expect(asked).toEqual(["opus"]);
  });

  it("is nothing where nothing can be encoded", async () => {
    expect(await chooseSoundEncoding("mp4", async () => false)).toBeUndefined();
  });
});
