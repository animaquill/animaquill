import type { Channel } from "@animaquill/core/curve";
import {
  BUILT_IN_SOUND_EFFECTS,
  effectParamRange,
  type MixEffect,
} from "@animaquill/core/mix-plan";
import { describe, expect, it } from "vitest";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { keyed, seedCount, seeded } from "./test-support.ts";

/**
 * What each effect remembers (`EffectChain.memory`): started from nothing that many samples before
 * a sample, it gives out that sample within 2⁻¹⁶ (−96 dBFS) of what it gives when it starts at the
 * start. That is how the preview, and AI listening to a part, sound as the export does.
 */

const LIMIT = 2 ** -16;

/** Parameters of an effect at random within their range, some of them with keys. */
function randomEffect(type: string, random: () => number): MixEffect {
  const params: Record<string, Channel> = {};
  for (const spec of BUILT_IN_SOUND_EFFECTS[type]?.properties ?? []) {
    const [min, max] = effectParamRange(type, spec.path);
    const pick = () => {
      // Frequencies and times are mostly low, as on a log scale.
      const share =
        spec.unit === "hz" || spec.unit === "ms" || spec.unit === "s" ? random() ** 3 : random();
      return min + share * (max - min);
    };
    if (spec.type === "boolean")
      params[spec.path] = { kind: "still", value: random() < 0.6 ? 1 : 0 };
    else if (spec.type === "choice")
      params[spec.path] = { kind: "still", value: random() < 0.5 ? 12 : 24 };
    else if (random() < 0.25)
      params[spec.path] = keyed([
        [0, pick()],
        [1 + random() * 3, pick()],
      ]);
    else params[spec.path] = { kind: "still", value: pick() };
  }
  // The reverb is heard at all.
  if (type === "reverb" && params["mix"]?.kind === "still") {
    params["mix"] = { kind: "still", value: 0.2 + 0.8 * random() };
  }
  return { id: "fx", type, params };
}

/** A signal of sound at random: noise and tones, quiet and loud, with peaks of +12 dBFS. */
function signalOf(length: number, random: () => number): [Float64Array, Float64Array] {
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  let level = random();
  let tone = 100 + random() * 5000;
  for (let index = 0; index < length; index += 1) {
    if (index % 4800 === 0) {
      level = random() < 0.2 ? 0 : random() ** 2 * 2;
      tone = 50 + random() ** 2 * 8000;
    }
    const t = (2 * Math.PI * tone * index) / MIX_RATE;
    left[index] = Math.fround(level * (0.5 * Math.sin(t) + 0.5 * (2 * random() - 1)));
    right[index] = Math.fround(level * (0.5 * Math.cos(t) + 0.5 * (2 * random() - 1)));
    if (random() < 0.0005) left[index] = 10 ** (12 / 20);
  }
  return [left, right];
}

function run(
  chain: EffectChain,
  left: Float64Array,
  right: Float64Array,
  from: number,
  to: number,
) {
  for (let at = from; at < to; at += 128) {
    const end = Math.min(at + 128, to);
    chain.process([left.subarray(at, end), right.subarray(at, end)], end - at, at);
  }
}

describe("what each effect remembers", () => {
  for (const type of Object.keys(BUILT_IN_SOUND_EFFECTS)) {
    it(
      `is all a ${type} needs to sound as from the start, within −96 dBFS`,
      { timeout: 300_000 },
      () => {
        const count = seedCount(3);
        for (let seed = 1; seed <= count; seed += 1) {
          const random = seeded(seed * 7919 + type.length);
          const effect = randomEffect(type, random);
          const memory = new EffectChain([effect], 2).memory;
          const span = 4096;
          // Where it starts, at random, past the memory, and not on a block.
          const start = memory + 1 + Math.floor(random() * MIX_RATE);
          const length = start + span;
          const [left, right] = signalOf(length, random);
          const wholeLeft = Float64Array.from(left);
          const wholeRight = Float64Array.from(right);
          run(new EffectChain([effect], 2), wholeLeft, wholeRight, 0, length);
          const partLeft = Float64Array.from(left);
          const partRight = Float64Array.from(right);
          run(new EffectChain([effect], 2), partLeft, partRight, start - memory, length);
          let most = 0;
          for (let index = start; index < length; index += 1) {
            most = Math.max(
              most,
              Math.abs((partLeft[index] as number) - (wholeLeft[index] as number)),
              Math.abs((partRight[index] as number) - (wholeRight[index] as number)),
            );
          }
          expect(most, `seed ${seed}: ${JSON.stringify(effect.params)}`).toBeLessThanOrEqual(LIMIT);
        }
      },
    );
  }
});

describe("the memory of a parameter with keys", () => {
  it("goes by where its keys go, not by all its range", () => {
    const keyedRelease: MixEffect = {
      id: "c",
      type: "compressor",
      params: {
        release: keyed([
          [0, 50],
          [2, 200],
        ]),
        threshold: { kind: "still", value: -20 },
      },
    };
    const still: MixEffect = {
      id: "c",
      type: "compressor",
      params: { release: { kind: "still", value: 200 }, threshold: { kind: "still", value: -20 } },
    };
    expect(new EffectChain([keyedRelease], 2).memory).toBe(new EffectChain([still], 2).memory);
  });
});
