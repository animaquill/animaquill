import { fadesGainAt, type SoundFade, type SoundLayer } from "@animaquill/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { faded, sampleTime } from "./fades.ts";
import { PlaybackAudio, type SoundChunk } from "./index.ts";
import { SoundMixer, type MixContext } from "./mix.ts";

/**
 * Transitions of sound as playback and the mix of an export play them: sample by sample the same,
 * however the file comes in chunks and the mix in pieces.
 */

/** Few samples a second, so that every one of them can be looked at. */
const RATE = 100;

/** A buffer as a context makes it, with samples of its own. */
class Samples {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly #channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.#channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.#channels[channel] as Float32Array;
  }
}

const make = (channels: number, length: number, sampleRate: number) =>
  new Samples(channels, length, sampleRate) as unknown as AudioBuffer;

/** What is in the file at a sample, in each channel: never 0, so that silence shows. */
const inFile = (index: number, channel: number) => 0.5 + 0.4 * Math.sin(index * 0.37 + channel);

const FILE_SAMPLES = 6 * RATE;

/** The file in chunks of the sizes given, one after the other, as a decoder gives them. */
function chunksOf(sizes: readonly number[]): SoundChunk[] {
  const chunks: SoundChunk[] = [];
  for (let at = 0, turn = 0; at < FILE_SAMPLES; turn += 1) {
    const length = Math.min(sizes[turn % sizes.length] as number, FILE_SAMPLES - at);
    const buffer = make(2, length, RATE);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) data[index] = inFile(at + index, channel);
    }
    chunks.push({ buffer, timestamp: at / RATE, duration: length / RATE });
    at += length;
  }
  return chunks;
}

/** Reads the chunks that have something from `from` up to `to`, in seconds of the file. */
const reader = (chunks: readonly SoundChunk[]) =>
  async function* read(_: Blob, from: number, to: number): AsyncGenerator<SoundChunk> {
    for (const chunk of chunks) {
      if (chunk.timestamp + chunk.duration > from && chunk.timestamp < to) yield chunk;
    }
  };

/** A part of a buffer that plays from a moment on the timeline. */
interface Played {
  readonly buffer: AudioBuffer;
  /** Seconds on the timeline where it starts. */
  readonly begin: number;
  /** Seconds into the buffer, and how long. */
  readonly offset: number;
  readonly duration: number;
}

/** What plays, by sample of the timeline, for the first channel. */
function heard(played: readonly Played[]): Map<number, number> {
  const samples = new Map<number, number>();
  for (const { buffer, begin, offset, duration } of played) {
    const first = Math.round((begin - offset) * RATE);
    const data = buffer.getChannelData(0);
    for (
      let index = Math.round(offset * RATE);
      index < Math.round((offset + duration) * RATE);
      index += 1
    ) {
      expect(samples.has(first + index), `sample ${first + index} twice`).toBe(false);
      samples.set(first + index, data[index] as number);
    }
  }
  return samples;
}

const transition = (fade: Omit<SoundFade, "duration">): SoundFade => ({
  ...fade,
  duration: fade.end - fade.start,
});

/**
 * A sound that starts before its file does, as the side after the cut of a join can: an equal power
 * fade in over the join, with a speed curve, and a linear fade out at its end.
 */
const SOUND: SoundLayer = {
  id: "s",
  file: "f",
  start: 1,
  end: 5,
  offset: -0.3,
  gain: 1,
  fades: [
    transition({
      use: "join",
      way: "in",
      shape: "power",
      start: 1,
      end: 2.2,
      curve: [0.42, 0, 0.58, 1],
    }),
    transition({ use: "exit", way: "out", shape: "gain", start: 3.95, end: 5 }),
  ],
};

/** What the timeline should have at a sample. */
function wanted(index: number): number {
  const seconds = index / RATE;
  const inTheFile = Math.round((seconds - SOUND.start + SOUND.offset) * RATE);
  return inFile(inTheFile, 0) * fadesGainAt(SOUND.fades, seconds);
}

async function playback(chunks: readonly SoundChunk[], sound = SOUND): Promise<Played[]> {
  vi.useFakeTimers();
  const played: Played[] = [];
  const context = {
    state: "running",
    currentTime: 10,
    outputLatency: 0,
    baseLatency: 0,
    destination: {},
    resume: async () => {},
    close: async () => {},
    createBuffer: make,
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBufferSource() {
      const node = {
        buffer: undefined as unknown as AudioBuffer,
        connect() {},
        addEventListener() {},
        stop() {},
        start(when: number, offset: number, duration: number) {
          // Played from 0 on the timeline when the context showed 10, with nothing late.
          played.push({ buffer: node.buffer, begin: when - 10, offset, duration });
        },
      };
      return node;
    },
  };
  const audio = new PlaybackAudio({
    fileOf: async () => new Blob(),
    onProblem: () => {
      throw new Error("A problem");
    },
    read: reader(chunks),
    createContext: () => context as unknown as AudioContext,
    wallClock: () => 0,
  });
  audio.play({ sounds: [sound] }, 0, audio.now());
  // Time goes by as it does, a tenth of a second at a time.
  for (let step = 0; step < 70; step += 1) {
    context.currentTime += 0.1;
    await vi.advanceTimersByTimeAsync(100);
  }
  audio.stop();
  return played;
}

async function mix(chunks: readonly SoundChunk[], pieceSeconds: number, sound = SOUND) {
  const played: Played[] = [];
  let from = 0;
  const createContext = (_channels: number, length: number): MixContext => ({
    destination: {} as AudioDestinationNode,
    createBuffer: make,
    createGain: () => ({ gain: { value: 1 }, connect() {} }) as unknown as GainNode,
    createBufferSource() {
      const node = {
        buffer: undefined as unknown as AudioBuffer,
        connect() {},
        start(when: number, offset: number, duration: number) {
          played.push({ buffer: node.buffer, begin: from + when, offset, duration });
        },
      };
      return node as unknown as AudioBufferSourceNode;
    },
    startRendering: async () => ({ length }) as AudioBuffer,
  });
  const mixer = new SoundMixer(
    { sounds: [sound] },
    { fileOf: async () => new Blob(), read: reader(chunks), createContext },
  );
  const frames = Math.round(pieceSeconds * 48_000);
  for (; from < 6; from += frames / 48_000) await mixer.mix(from, frames);
  mixer.close();
  return played;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a chunk with transitions", () => {
  it("has each sample times the gain at its own moment", () => {
    const [chunk] = chunksOf([300]);
    if (!chunk) throw new Error("No chunk");
    const out = faded(SOUND, chunk, make);
    for (const index of [0, 30, 31, 100, 150, 299]) {
      const seconds = sampleTime(SOUND, 0, index, RATE);
      expect(out.buffer.getChannelData(1)[index]).toBeCloseTo(
        inFile(index, 1) * fadesGainAt(SOUND.fades, seconds),
        6,
      );
    }
  });

  it("is the same chunk where no transition is", () => {
    const [chunk] = chunksOf([50]);
    if (!chunk) throw new Error("No chunk");
    const plain = { ...SOUND, offset: 2 };
    const later = { ...chunk, timestamp: 3.7 };
    expect(faded(plain, later, make)).toBe(later);
    const { fades: _fades, ...without } = SOUND;
    expect(faded(without, chunk, make)).toBe(chunk);
  });
});

describe("playback and the mix of an export", () => {
  it("are the same sample by sample, wherever chunks and pieces begin", async () => {
    // Chunks and pieces that end in the middle of both transitions, and differ between the two.
    const live = heard(await playback(chunksOf([37, 101, 53])));
    const exported = heard(await mix(chunksOf([64, 29]), 0.73));
    expect([...live.keys()].toSorted((a, b) => a - b)).toEqual(
      [...exported.keys()].toSorted((a, b) => a - b),
    );
    for (const [index, value] of live) {
      expect(Math.abs(value - (exported.get(index) as number)), `sample ${index}`).toBeLessThan(
        1e-6,
      );
      expect(Math.abs(value - wanted(index)), `sample ${index}`).toBeLessThan(1e-6);
    }
    // Inside the transitions, where the gain is neither 0 nor 1.
    for (const seconds of [1.6, 4.5]) {
      expect(fadesGainAt(SOUND.fades, seconds)).toBeGreaterThan(0.1);
      expect(fadesGainAt(SOUND.fades, seconds)).toBeLessThan(0.9);
      expect(live.get(seconds * RATE)).toBeCloseTo(wanted(seconds * RATE), 6);
    }
  });

  it("have nothing where the file has not started yet", async () => {
    const live = heard(await playback(chunksOf([37, 101, 53])));
    const exported = heard(await mix(chunksOf([64, 29]), 0.73));
    // The sound starts at 1 s, which is 0.3 s before its file does.
    expect(Math.min(...live.keys())).toBe(130);
    expect(Math.min(...exported.keys())).toBe(130);
    expect(Math.max(...live.keys())).toBe(499);
  });
});
