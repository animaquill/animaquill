import { describe, expect, it } from "vitest";
import { MixEngine } from "./engine/engine.ts";
import type { DecodedChunk } from "./engine/samples.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./engine/test-support.ts";
import { MIX_SAMPLE_RATE, SoundFailed, SoundMixer } from "./mix.ts";
import { portMixer, serveMixer, type MixPort } from "./mix-port.ts";

const RATE = MIX_SAMPLE_RATE;
/** Thirty seconds of a file, in chunks of a tenth of a second. */
const FILE = chunksOf({ frames: 30 * RATE, size: RATE / 10 });

/** Reads the chunks of a file that have something from `from` up to `to`, in its seconds. */
function reader(
  chunks: readonly DecodedChunk[] = FILE,
  asked: { from: number; to: number }[] = [],
) {
  return async function* read(_: Blob, from: number, to: number): AsyncGenerator<DecodedChunk> {
    asked.push({ from, to });
    for (const chunk of chunks) {
      const start = chunk.start / chunk.rate;
      const end = start + (chunk.channels[0]?.length ?? 0) / chunk.rate;
      if (end > from && start < to) yield chunk;
    }
  };
}

const file = async () => new Blob(["sound"]);

/** What the engine gives for the whole of a plan, with all of its file at once. */
function wanted(plan: Parameters<typeof planOf>[0], from: number, frames: number) {
  const store = storeOf(FILE);
  const engine = new MixEngine(planOf(plan), () => store);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  engine.render(from, frames, left, right);
  return { left, right };
}

describe("the mix of an export", () => {
  it("is what the engine gives, piece by piece", async () => {
    const sounds = [sound({ start: 1, end: 23, offset: 0.5, gain: 0.5 })];
    const mixer = new SoundMixer(planOf(sounds), { fileOf: file, read: reader() });
    const whole = wanted(sounds, 0, 25 * RATE);
    for (const from of [0, 10, 20]) {
      const frames = Math.min(10, 25 - from) * RATE;
      const piece = await mixer.mix(from, frames);
      expect(piece.length).toBe(frames);
      expect(piece.numberOfChannels).toBe(2);
      expect(piece.getChannelData(0)).toEqual(
        whole.left.subarray(from * RATE, from * RATE + frames),
      );
      expect(piece.getChannelData(1)).toEqual(
        whole.right.subarray(from * RATE, from * RATE + frames),
      );
    }
  });

  it("reads a sound once over all the pieces it is in, front to back, from its offset", async () => {
    const asked: { from: number; to: number }[] = [];
    const mixer = new SoundMixer(planOf([sound({ start: 1, end: 28, offset: 0.5 })]), {
      fileOf: file,
      read: reader(FILE, asked),
    });
    for (const from of [0, 10, 20]) await mixer.mix(from, 10 * RATE);
    // A little around what it plays, for resampling.
    expect(asked).toEqual([{ from: 0.49, to: 27.51 }]);
  });

  it("reads again from where it is asked when that is further back", async () => {
    const asked: { from: number; to: number }[] = [];
    const mixer = new SoundMixer(planOf([sound({ end: 30 })]), {
      fileOf: file,
      read: reader(FILE, asked),
    });
    await mixer.mix(10, 10 * RATE);
    await mixer.mix(0, 10 * RATE);
    expect(asked.map(({ from }) => from)).toEqual([9.99, 0]);
  });

  it("does not read what nobody hears", async () => {
    const asked: { from: number; to: number }[] = [];
    const plan = planOf(
      [sound({ end: 30 }), sound({ id: "m", track: "u", end: 30 })],
      [track({ gain: 0 }), track({ id: "u", muted: true })],
    );
    const mixer = new SoundMixer(plan, { fileOf: file, read: reader(FILE, asked) });
    expect(mixer.silent).toBe(true);
    const piece = await mixer.mix(0, RATE);
    expect(piece.getChannelData(0).every((value) => value === 0)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("stops when the file of a sound is missing, and says which", async () => {
    const mixer = new SoundMixer(planOf([sound()]), { fileOf: async () => undefined });
    const error = await mixer.mix(0, RATE).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SoundFailed);
    expect(error).toMatchObject({ reason: "missing-file", sound: sound() });
  });

  it("stops when a sound cannot be decoded", async () => {
    const mixer = new SoundMixer(planOf([sound()]), {
      fileOf: file,
      // oxlint-disable-next-line require-yield -- it fails before it yields
      read: async function* broken() {
        throw new Error("not a sound");
      },
    });
    await expect(mixer.mix(0, RATE)).rejects.toMatchObject({ reason: "cannot-decode" });
  });

  it("takes sounds from elsewhere when something knows them, such as sounds made by code", async () => {
    const made = sound({ file: "made-by-code", made: true });
    const files: string[] = [];
    const mixer = new SoundMixer(planOf([made]), {
      fileOf: async () => undefined,
      source: async (layer) => (layer === made ? new Blob(["made"]) : undefined),
      read: async function* (blob, from, to) {
        files.push(await blob.text());
        yield* reader()(blob, from, to);
      },
    });
    const piece = await mixer.mix(0, RATE);
    expect(files).toEqual(["made"]);
    expect(piece.getChannelData(0)).toEqual(wanted([made], 0, RATE).left);
  });
});

/** Two ends of a channel, as a worker and its page have. */
function ports(): [MixPort, MixPort] {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port2.start();
  return [port1 as unknown as MixPort, port2 as unknown as MixPort];
}

describe("a mixer in a worker", () => {
  it("mixes what the mixer here would", async () => {
    const [page, worker] = ports();
    serveMixer(worker, reader());
    const sounds = [sound({ start: 1, end: 12, offset: 0.5 })];
    const mixer = portMixer(page, planOf(sounds), { fileOf: file }, () => {});
    expect(mixer.silent).toBe(false);
    const first = await mixer.mix(0, 10 * RATE);
    const second = await mixer.mix(10, 2 * RATE);
    const whole = wanted(sounds, 0, 12 * RATE);
    expect(first.getChannelData(0)).toEqual(whole.left.subarray(0, 10 * RATE));
    expect(second.getChannelData(1)).toEqual(whole.right.subarray(10 * RATE));
    mixer.close();
  });

  it("fails with the error of the page when finding a file failed there", async () => {
    const [page, worker] = ports();
    serveMixer(worker, reader());
    class NotMade extends Error {}
    const failure = new NotMade("not made");
    const mixer = portMixer(
      page,
      planOf([sound()]),
      { fileOf: file, source: () => Promise.reject(failure) },
      () => {},
    );
    await expect(mixer.mix(0, RATE)).rejects.toBe(failure);
    mixer.close();
  });

  it("says which sound is missing", async () => {
    const [page, worker] = ports();
    serveMixer(worker, reader());
    const mixer = portMixer(page, planOf([sound()]), { fileOf: async () => undefined }, () => {});
    const error = await mixer.mix(0, RATE).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SoundFailed);
    expect(error).toMatchObject({ reason: "missing-file", sound: { id: "s" } });
    mixer.close();
  });

  it("fails what it was asked once the worker stopped", async () => {
    const [page] = ports();
    const mixer = portMixer(page, planOf([sound()]), { fileOf: file }, () => {});
    const asked = mixer.mix(0, RATE);
    mixer.fail(new Error("gone"));
    await expect(asked).rejects.toThrow("gone");
    await expect(mixer.mix(0, RATE)).rejects.toThrow("gone");
    mixer.close();
  });
});
