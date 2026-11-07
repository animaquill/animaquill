import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import type { SoundChunk } from "./index.ts";
import { MIX_SAMPLE_RATE, placementsIn, SoundFailed, SoundMixer, type MixContext } from "./mix.ts";

const sound = (changes: Partial<SoundLayer> = {}): SoundLayer => ({
  id: "s",
  file: "tone",
  start: 1,
  end: 3,
  offset: 0.5,
  gain: 0.5,
  ...changes,
});

interface Started {
  readonly buffer: unknown;
  readonly when: number;
  readonly offset: number;
  readonly duration: number;
  readonly gain: number;
}

/** A context that remembers what was asked of it, and renders nothing. */
function fakeContext() {
  const started: Started[] = [];
  const made: { channels: number; length: number; rate: number }[] = [];
  const create = (channels: number, length: number, rate: number): MixContext => {
    made.push({ channels, length, rate });
    return {
      destination: {} as AudioDestinationNode,
      createGain() {
        const gain = { gain: { value: 1 }, connect() {} };
        current = gain;
        return gain as unknown as GainNode;
      },
      createBufferSource() {
        const node = {
          buffer: undefined as unknown,
          connect() {},
          start(when: number, offset: number, duration: number) {
            started.push({ buffer: node.buffer, when, offset, duration, gain: current.gain.value });
          },
        };
        return node as unknown as AudioBufferSourceNode;
      },
      startRendering: async () => ({ length }) as AudioBuffer,
    };
  };
  let current = { gain: { value: 1 } };
  return { create, started, made };
}

/** A file read in chunks of one second, from where it was asked. */
function chunked(asked: { from: number; to: number }[] = []) {
  return async function* read(_: Blob, from: number, to: number): AsyncGenerator<SoundChunk> {
    asked.push({ from, to });
    for (let second = Math.floor(from); second < to; second += 1) {
      yield { buffer: { second } as unknown as AudioBuffer, timestamp: second, duration: 1 };
    }
  };
}

const plan = (...sounds: SoundLayer[]): AudioPlan => ({ sounds });
const file = async () => new Blob(["tone"]);

describe("what a piece of the timeline has to hear", () => {
  it("is the part of each sound in it", () => {
    expect(placementsIn(plan(sound()), 0, 10)).toEqual([{ sound: sound(), from: 1, to: 3 }]);
    expect(placementsIn(plan(sound()), 2, 10)[0]).toMatchObject({ from: 2, to: 3 });
    expect(placementsIn(plan(sound()), 0, 1.5)[0]).toMatchObject({ from: 1, to: 1.5 });
  });

  it("is nothing for sounds before or after it, or that cannot be heard", () => {
    expect(placementsIn(plan(sound()), 3, 10)).toEqual([]);
    expect(placementsIn(plan(sound()), 0, 1)).toEqual([]);
    expect(placementsIn(plan(sound({ gain: 0 })), 0, 10)).toEqual([]);
  });
});

describe("a mix", () => {
  it("has the length it was asked for, at the rate of the mix", async () => {
    const context = fakeContext();
    const mixer = new SoundMixer(plan(), { fileOf: file, createContext: context.create });
    const mixed = await mixer.mix(0, 480_000);
    expect(mixed.length).toBe(480_000);
    expect(context.made).toEqual([{ channels: 2, length: 480_000, rate: MIX_SAMPLE_RATE }]);
  });

  it("reads each sound from its offset, and puts it at its place with its volume", async () => {
    const context = fakeContext();
    const asked: { from: number; to: number }[] = [];
    const mixer = new SoundMixer(plan(sound()), {
      fileOf: file,
      read: chunked(asked),
      createContext: context.create,
    });
    await mixer.mix(0, 10 * MIX_SAMPLE_RATE);
    // Seconds 1 to 3 of the timeline are seconds 0.5 to 2.5 of the file.
    expect(asked).toEqual([{ from: 0.5, to: 2.5 }]);
    expect(context.started).toEqual([
      { buffer: { second: 0 }, when: 1, offset: 0.5, duration: 0.5, gain: 0.5 },
      { buffer: { second: 1 }, when: 1.5, offset: 0, duration: 1, gain: 0.5 },
      { buffer: { second: 2 }, when: 2.5, offset: 0, duration: 0.5, gain: 0.5 },
    ]);
  });

  it("puts a piece that starts later at the start of its own samples", async () => {
    const context = fakeContext();
    const mixer = new SoundMixer(plan(sound({ start: 8, end: 14, offset: 0 })), {
      fileOf: file,
      read: chunked(),
      createContext: context.create,
    });
    await mixer.mix(10, 10 * MIX_SAMPLE_RATE);
    // Second 10 of the timeline is the first sample of this piece, and second 2 of the file.
    expect(context.started[0]).toMatchObject({ when: 0, offset: 0, duration: 1 });
    expect(context.started.map(({ buffer }) => buffer)).toEqual([
      { second: 2 },
      { second: 3 },
      { second: 4 },
      { second: 5 },
    ]);
  });

  it("reads a sound once over all the pieces it is in, front to back", async () => {
    const context = fakeContext();
    const asked: { from: number; to: number }[] = [];
    const long = sound({ start: 0, end: 30, offset: 0 });
    const mixer = new SoundMixer(plan(long), {
      fileOf: file,
      read: chunked(asked),
      createContext: context.create,
    });
    for (const from of [0, 10, 20]) await mixer.mix(from, 10 * MIX_SAMPLE_RATE);
    expect(asked).toEqual([{ from: 0, to: 30 }]);
    expect(context.started.map(({ buffer }) => (buffer as { second: number }).second)).toEqual(
      Array.from({ length: 30 }, (_, second) => second),
    );
  });

  it("puts a chunk that goes over the end of a piece into both", async () => {
    const context = fakeContext();
    // Chunks of a second that start half a second into the timeline.
    const mixer = new SoundMixer(plan(sound({ start: 0.5, end: 20, offset: 0 })), {
      fileOf: file,
      read: chunked(),
      createContext: context.create,
    });
    await mixer.mix(0, 10 * MIX_SAMPLE_RATE);
    await mixer.mix(10, 10 * MIX_SAMPLE_RATE);
    const across = context.started.filter(
      ({ buffer }) => (buffer as { second: number }).second === 9,
    );
    expect(across).toEqual([
      expect.objectContaining({ when: 9.5, offset: 0, duration: 0.5 }),
      expect.objectContaining({ when: 0, offset: 0.5, duration: 0.5 }),
    ]);
  });

  it("reads again from where it is asked when that is further back", async () => {
    const asked: { from: number; to: number }[] = [];
    const mixer = new SoundMixer(plan(sound({ start: 0, end: 30, offset: 0 })), {
      fileOf: file,
      read: chunked(asked),
      createContext: fakeContext().create,
    });
    await mixer.mix(10, 10 * MIX_SAMPLE_RATE);
    await mixer.mix(0, 10 * MIX_SAMPLE_RATE);
    expect(asked).toEqual([
      { from: 10, to: 30 },
      { from: 0, to: 30 },
    ]);
  });

  it("stops when the file of a sound is missing, and says which", async () => {
    const mixer = new SoundMixer(plan(sound()), {
      fileOf: async () => undefined,
      createContext: fakeContext().create,
    });
    const error = await mixer.mix(0, 480_000).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SoundFailed);
    expect(error).toMatchObject({ reason: "missing-file", sound: sound() });
  });

  it("stops when a sound cannot be decoded", async () => {
    const mixer = new SoundMixer(plan(sound()), {
      fileOf: file,
      // oxlint-disable-next-line require-yield -- it fails before it yields
      read: async function* broken() {
        throw new Error("not a sound");
      },
      createContext: fakeContext().create,
    });
    await expect(mixer.mix(0, 480_000)).rejects.toMatchObject({ reason: "cannot-decode" });
  });

  it("takes sounds from elsewhere when something knows them, such as sounds made by code", async () => {
    const context = fakeContext();
    const made = sound({ file: "made-by-code" });
    const mixer = new SoundMixer(plan(made), {
      fileOf: async () => undefined,
      source: async (layer) =>
        layer === made ? (from, to) => chunked()(new Blob(), from, to) : undefined,
      createContext: context.create,
    });
    await mixer.mix(0, 480_000);
    expect(context.started).toHaveLength(3);
  });

  it("knows when there is nothing to hear", () => {
    expect(new SoundMixer(plan(), { fileOf: file }).silent).toBe(true);
    expect(new SoundMixer(plan(sound({ gain: 0 })), { fileOf: file }).silent).toBe(true);
    expect(new SoundMixer(plan(sound()), { fileOf: file }).silent).toBe(false);
  });
});
