import type { MixPlan, MixSound, MixTrack } from "@animaquill/core";
import { MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import { SampleStore, type DecodedChunk } from "./samples.ts";

/** Plans, sounds and files for the tests of the engine and what uses it. */

export const sound = (changes: Partial<MixSound> = {}): MixSound => ({
  id: "s",
  file: "f",
  track: "t",
  start: 0,
  end: 1,
  offset: 0,
  gain: 1,
  ...changes,
});

export const track = (changes: Partial<MixTrack> = {}): MixTrack => ({
  id: "t",
  gain: 1,
  muted: false,
  solo: false,
  ...changes,
});

export const planOf = (sounds: readonly MixSound[], tracks: readonly MixTrack[] = [track()]) =>
  ({ sounds, tracks }) satisfies MixPlan;

/** What a file has at a frame, in a channel: never 0 for long, so that silence shows. */
export const inFile = (frame: number, channel = 0) =>
  0.4 * Math.sin(frame * 0.0123 + channel * 1.7) + 0.05 * Math.sin(frame * 0.31 + channel);

/** A file as a decoder gives it: `frames` frames from `start`, in chunks of `size`. */
export function chunksOf(options: {
  readonly frames: number;
  readonly size?: number;
  readonly rate?: number;
  readonly channels?: number;
  readonly start?: number;
  readonly value?: (frame: number, channel: number) => number;
}): DecodedChunk[] {
  const { frames, size = 1000, rate = MIX_RATE, channels = 2, start = 0, value = inFile } = options;
  const chunks: DecodedChunk[] = [];
  for (let at = start; at < start + frames; at += size) {
    const length = Math.min(size, start + frames - at);
    chunks.push({
      start: at,
      rate,
      channels: Array.from({ length: channels }, (_, channel) =>
        Float32Array.from({ length }, (_value, index) => value(at + index, channel)),
      ),
    });
  }
  return chunks;
}

/** A store with all of a file in it. */
export function storeOf(chunks: readonly DecodedChunk[]): SampleStore {
  const store = new SampleStore();
  for (const chunk of chunks) store.add(chunk);
  const last = chunks.at(-1);
  if (last) store.endAt(last.start + (last.channels[0]?.length ?? 0));
  return store;
}

/** A file made of a signal, which anyone can make again from these numbers alone. */
export interface Signal {
  readonly rate: number;
  readonly channels: number;
  readonly seconds: number;
  /**
   * `sine`: `0.5 sin(2π (frequency + 50 channel) t)`. `noise`: `0.5 (2u − 1)` with `u` from the
   * generator `x ← (1103515245 x + 12345) mod 2³¹`, starting at `seed + channel`, `u = x / 2³¹`.
   * `impulse`: 0.9 every `every` frames, from frame `channel`, and 0 elsewhere.
   */
  readonly signal: "sine" | "noise" | "impulse";
  readonly frequency?: number;
  readonly seed?: number;
  readonly every?: number;
}

/** The chunks of a file of a signal. */
export function signalChunks(signal: Signal): DecodedChunk[] {
  const frames = Math.round(signal.seconds * signal.rate);
  const channels = Array.from({ length: signal.channels }, (_, channel) => {
    const data = new Float32Array(frames);
    let state = (signal.seed ?? 1) + channel;
    for (let frame = 0; frame < frames; frame += 1) {
      if (signal.signal === "sine") {
        const frequency = (signal.frequency ?? 440) + 50 * channel;
        data[frame] = 0.5 * Math.sin((2 * Math.PI * frequency * frame) / signal.rate);
      } else if (signal.signal === "noise") {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        data[frame] = 0.5 * ((2 * state) / 2_147_483_648 - 1);
      } else {
        const every = signal.every ?? 1000;
        data[frame] = frame >= channel && (frame - channel) % every === 0 ? 0.9 : 0;
      }
    }
    return data;
  });
  const chunks: DecodedChunk[] = [];
  for (let start = 0; start < frames; start += 1000) {
    const end = Math.min(start + 1000, frames);
    chunks.push({
      start,
      rate: signal.rate,
      channels: channels.map((data) => data.slice(start, end)),
    });
  }
  return chunks;
}

/** A case of `schema/fixtures/mix/cases.json`: a plan with its files, and the hash of its mix. */
export interface MixCase {
  readonly name: string;
  readonly seconds: number;
  readonly files: Readonly<Record<string, Signal>>;
  readonly plan: MixPlan;
  readonly sha256: string;
  /** Every `every`th sample of each channel, from the first: what another platform is held to. */
  readonly samples: {
    readonly every: number;
    readonly left: readonly number[];
    readonly right: readonly number[];
  };
}

/** The mix of a case, from its start, a quantum at a time as the preview has it. */
export function mixOfCase(mixCase: Omit<MixCase, "sha256">): {
  left: Float32Array;
  right: Float32Array;
} {
  const stores = Object.fromEntries(
    Object.entries(mixCase.files).map(([name, signal]) => [name, storeOf(signalChunks(signal))]),
  );
  const engine = new MixEngine(mixCase.plan, (each) => stores[each.file]);
  const frames = Math.round(mixCase.seconds * MIX_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let at = 0; at < frames; at += 128) {
    engine.render(at, Math.min(128, frames - at), left, right, at);
  }
  return { left, right };
}

/** The SHA-256 of a mix: its left channel, then its right, as 32-bit floats, little-endian. */
export async function hashOfMix(mix: { left: Float32Array; right: Float32Array }) {
  const bytes = new Uint8Array(mix.left.byteLength + mix.right.byteLength);
  const view = new DataView(bytes.buffer);
  [...mix.left, ...mix.right].forEach((value, index) => view.setFloat32(index * 4, value, true));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
