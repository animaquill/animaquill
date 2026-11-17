import type { Animation, Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { compileChannel, sample, type Channel } from "./curve.ts";

/**
 * Springs, presets and noise are worked out with every frame, in the editor page and in scenes, as
 * beziers are. The animation model counts on 1200 channels a frame (a skeleton of 300 bones with 4
 * properties each); with the new shapes and shaking on every one of them, they may cost no more than
 * twice what beziers do.
 */
const CHANNELS = 1200;
const FRAMES = 600;
const KEYS = 12;

const BEZIER = (index: number): Partial<Key> => ({
  interp: "bezier",
  out: [0.42, (index % 5) / 10],
  in: [0.58, 1],
});

const EASES: readonly ((index: number) => Partial<Key>)[] = [
  () => ({ interp: "preset", preset: "elasticOut" }),
  () => ({ interp: "preset", preset: "bounceOut" }),
  () => ({ interp: "preset", preset: "elasticInOut", presetParams: { amplitude: 1.3 } }),
  () => ({ interp: "preset", preset: "stepsEnd", presetParams: { steps: 6 } }),
  (index) => ({ interp: "spring", spring: { stiffness: 80 + index, damping: 6 } }),
];

function channels(ease: (channel: number, key: number) => Partial<Key>, noise: boolean) {
  return Array.from({ length: CHANNELS }, (_, channel): Channel => {
    const animation: Animation = {
      keys: Array.from({ length: KEYS }, (_unused, key) => ({
        time: String(key),
        value: key * 10 + channel,
        ...ease(channel, key),
      })),
      ...(noise && {
        modifiers: [{ type: "noise" as const, amount: 4, frequency: 2, seed: channel }],
      }),
    };
    const compiled = compileChannel(animation, "number");
    if (!compiled) throw new Error("no channel");
    return compiled;
  });
}

/** The fastest of a few runs through the frames, in milliseconds a frame. */
function perFrame(list: readonly Channel[]): number {
  let best = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now();
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const clock = (frame / 60) % KEYS;
      for (const channel of list) sum += sample(channel, clock) as number;
    }
    best = Math.min(best, (performance.now() - started) / FRAMES);
  }
  expect(Number.isFinite(sum)).toBe(true);
  return best;
}

describe("1200 channels with springs, presets and noise", () => {
  it("take no more than twice what beziers take, frame by frame", () => {
    const beziers = channels((_, key) => BEZIER(key), false);
    const shaped = channels(
      (channel, key) =>
        (EASES[(channel + key) % EASES.length] as (index: number) => Partial<Key>)(key),
      true,
    );
    // Once for whatever gets ready the first time, which is no part of playing.
    perFrame(beziers);
    perFrame(shaped);
    const bezier = perFrame(beziers);
    const shapes = perFrame(shaped);
    console.log(
      `1200 channels: beziers ${bezier.toFixed(3)} ms a frame, springs, presets and noise ${shapes.toFixed(3)} ms (${(shapes / bezier).toFixed(2)}×)`,
    );
    expect(shapes).toBeLessThanOrEqual(bezier * 2);
  }, 60_000);
});
