import { compileChannel, type Channel } from "@animaquill/core/curve";
import type { MixEffect } from "@animaquill/core/mix-plan";

/** Effects for tests of the processors. */

/** An effect of a type with these parameters, still. */
export function effectOf(
  type: string,
  params: Readonly<Record<string, number>> = {},
  id = "fx",
): MixEffect {
  const channels: Record<string, Channel> = {};
  for (const [name, value] of Object.entries(params)) channels[name] = { kind: "still", value };
  return { id, type, params: channels };
}

/** A parameter with keys, at times in seconds. */
export const keyed = (keys: readonly (readonly [number, number])[]): Channel =>
  compileChannel(
    { keys: keys.map(([time, value]) => ({ time: String(time), value })) },
    "number",
  ) as Channel;

/** Numbers that look random and are the same every time, in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

/** Noise between −amplitude and amplitude. */
export function noise(length: number, amplitude: number, random: () => number): Float64Array {
  return Float64Array.from({ length }, () => amplitude * (2 * random() - 1));
}

export const db = (level: number) => 20 * Math.log10(level);

/** How many seeds a test of random cases runs: `FUZZ_SEEDS`, as on the test machine. */
export const seedCount = (fallback: number) =>
  Number(
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[
      "FUZZ_SEEDS"
    ] ?? fallback,
  );
