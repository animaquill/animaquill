import { beforeAll, describe, expect, it } from "vitest";
import { semitonesFor } from "./pitch.ts";

/**
 * The worklet of Signalsmith Stretch, run here as the audio thread would run it: sound that comes in
 * too high or too low because it plays faster or slower goes out at the pitch it has.
 */

const RATE = 48_000;
const BLOCK = 128;

interface Processor {
  readonly port: { onmessage: ((event: { data: unknown[] }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: object): boolean;
}

type ProcessorClass = new (options: object) => Processor;

const scope = globalThis as unknown as Record<string, unknown>;
const registered = new Map<string, ProcessorClass>();
const posted: unknown[][] = [];

beforeAll(async () => {
  scope["sampleRate"] = RATE;
  scope["currentTime"] = 0;
  scope["AudioWorkletProcessor"] = class {
    readonly port = {
      onmessage: null,
      postMessage: (data: unknown[]) => posted.push(data),
    };
  };
  scope["registerProcessor"] = (name: string, processor: ProcessorClass) =>
    registered.set(name, processor);
  await import("signalsmith-stretch");
});

async function keeper(semitones: number): Promise<Processor> {
  const Processor = registered.get("signalsmith-stretch");
  if (!Processor) throw new Error("not registered");
  posted.length = 0;
  scope["currentTime"] = 0;
  const processor = new Processor({ numberOfOutputs: 1, outputChannelCount: [1] });
  for (let tries = 0; !posted.some(([id]) => id === "ready"); tries++) {
    if (tries > 200) throw new Error("not ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  processor.port.onmessage?.({ data: [1, "schedule", { active: true, semitones, output: 0 }] });
  return processor;
}

/** Runs a tone through, block by block, and gives back what came out after it settled. */
function run(processor: Processor, frequency: number, seconds: number): Float32Array {
  const blocks = Math.ceil((seconds * RATE) / BLOCK);
  const out = new Float32Array(blocks * BLOCK);
  for (let block = 0; block < blocks; block++) {
    const input = new Float32Array(BLOCK);
    for (let index = 0; index < BLOCK; index++) {
      const time = (block * BLOCK + index) / RATE;
      input[index] = 0.5 * Math.sin(2 * Math.PI * frequency * time);
    }
    const output = new Float32Array(BLOCK);
    processor.process([[input]], [[output]], {});
    out.set(output, block * BLOCK);
    scope["currentTime"] = ((block + 1) * BLOCK) / RATE;
  }
  return out.subarray(Math.floor(out.length / 2));
}

/** How loud a frequency is in a window of samples. */
function power(samples: Float32Array, frequency: number): number {
  let re = 0;
  let im = 0;
  const size = samples.length;
  for (let index = 0; index < size; index++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
    const angle = (2 * Math.PI * frequency * index) / RATE;
    const value = (samples[index] ?? 0) * window;
    re += value * Math.cos(angle);
    im -= value * Math.sin(angle);
  }
  return re * re + im * im;
}

/** The loudest frequency between 100 Hz and 2 kHz: roughly first, then to a hertz. */
function mainFrequency(samples: Float32Array): number {
  const part = samples.subarray(0, Math.min(samples.length, 8192));
  const loudest = (from: number, to: number, step: number) => {
    let best = from;
    let most = -1;
    for (let frequency = from; frequency <= to; frequency += step) {
      const found = power(part, frequency);
      if (found > most) [best, most] = [frequency, found];
    }
    return best;
  };
  const rough = loudest(100, 2000, 10);
  return loudest(rough - 10, rough + 10, 1);
}

describe("keeping the pitch at other speeds", { timeout: 30_000 }, () => {
  it("shifts by an octave for each doubling", () => {
    expect(semitonesFor(2)).toBe(-12);
    expect(semitonesFor(8)).toBe(-36);
    expect(semitonesFor(0.25)).toBe(24);
    expect(semitonesFor(1)).toBe(-0);
  });

  // An A at 440 Hz, as it comes in at each speed: played twice as fast, it is an octave higher.
  for (const speed of [2, 4, 8, 0.25]) {
    it(`gives back 440 Hz at ${speed} times the speed`, async () => {
      const processor = await keeper(semitonesFor(speed));
      const out = run(processor, 440 * speed, 1);
      const frequency = mainFrequency(out);
      expect(Math.abs(frequency - 440) / 440).toBeLessThan(0.03);
    });
  }

  it("lets the tone through as it is without a shift, which the test would see", async () => {
    const processor = await keeper(0);
    expect(Math.abs(mainFrequency(run(processor, 880, 1)) - 880)).toBeLessThan(15);
  });
});
