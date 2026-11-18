import { expect, it } from "vitest";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { db, effectOf, seeded } from "./test-support.ts";

/** Long, so not in `pnpm check`: ten minutes of loud white noise through the longest reverb. */
it(
  "never runs away: ten minutes of loud white noise stay under +6 dBFS",
  { timeout: 120_000 },
  () => {
    const random = seeded(9);
    const chain = new EffectChain(
      [effectOf("reverb", { decay: 10, size: 1, mix: 1, width: 1, damping: 20_000, predelay: 0 })],
      2,
    );
    const left = new Float64Array(128);
    const right = new Float64Array(128);
    let peak = 0;
    for (let at = 0; at < MIX_RATE * 600; at += 128) {
      for (let index = 0; index < 128; index += 1) {
        left[index] = Math.fround(2 * random() - 1);
        right[index] = Math.fround(2 * random() - 1);
      }
      chain.process([left, right], 128, at);
      for (let index = 0; index < 128; index += 1) {
        peak = Math.max(peak, Math.abs(left[index] as number), Math.abs(right[index] as number));
      }
    }
    expect(db(peak)).toBeLessThan(6);
  },
);
