/**
 * What the preview shows of a proxy, against what it shows of its video: the same frame at every
 * moment of the project, read the way the compositor reads videos. So the preview can go from one
 * to the other at any moment without a jump.
 */
import { TIME_TOLERANCE } from "@animaquill/core/view";
import { SAME_MOMENT, pickFrames, type FrameRate } from "@animaquill/media/proxy";
import { describe, expect, it } from "vitest";
import { VideoCursor, type FrameSource } from "../../../render/src/cursor.ts";

interface Frame {
  readonly timestamp: number;
  readonly duration: number;
  /** Which frame of the video it shows. */
  readonly index: number;
  close(): void;
}

const frame = (timestamp: number, duration: number, index: number): Frame => ({
  timestamp,
  duration,
  index,
  close() {},
});

/** Frames from the one that shows at a moment on, as mediabunny gives them. */
function sourceOf(frames: readonly Frame[]): FrameSource<Frame> {
  return {
    async *samples(seconds) {
      let from = 0;
      for (const [at, each] of frames.entries()) if (each.timestamp <= seconds) from = at;
      yield* frames.slice(from);
    },
  };
}

async function* all<T>(items: readonly T[]) {
  yield* items;
}

/** A pseudo-random number between 0 and 1 that is the same on every run. */
function randomly(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** The frames of a video of a phone: at about 60 a second, a little off, from about 0. */
function phone(random: () => number, count: number): Frame[] {
  const frames: Frame[] = [];
  let at = random() < 0.5 ? 0 : random() * 0.05;
  for (let index = 0; index < count; index += 1) {
    const step = (1 / 60) * (0.8 + random() * 0.4);
    frames.push(frame(at, step, index));
    at += step;
  }
  return frames;
}

/**
 * The frames of a video of a camera, evenly from 0: many of them start right at a moment of the
 * project, where whether a frame shows from its start decides which one it is.
 */
const camera = (fps: number, count: number): Frame[] =>
  Array.from({ length: count }, (_, index) => frame(index / fps, 1 / fps, index));

const CAMERAS = [60, 60_000 / 1001, 50, 30, 24, 120];

const RATES: readonly FrameRate[] = [
  { num: 30, den: 1 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30_000, den: 1001 },
  { num: 60, den: 1 },
];

describe("a proxy in the preview", () => {
  it("takes moments to be the same as the compositor does", () => {
    expect(SAME_MOMENT).toBe(TIME_TOLERANCE);
  });

  it("shows at every moment of the project the frame the video shows", async () => {
    const random = randomly(7);
    for (let trial = 0; trial < 60; trial += 1) {
      const rate = RATES[trial % RATES.length] as FrameRate;
      const count = 90 + Math.floor(random() * 60);
      const video =
        trial % 2 === 0
          ? phone(random, count)
          : camera(CAMERAS[Math.floor(trial / 2) % CAMERAS.length] as number, count);
      const picked: Frame[] = [];
      for await (const { sample, timestamp, duration } of pickFrames(all(video), rate)) {
        picked.push(frame(timestamp, duration, sample.index));
      }
      const original = new VideoCursor(sourceOf(video));
      const proxy = new VideoCursor(sourceOf(picked));
      const last = video.at(-1) as Frame;
      const moments = Math.ceil(((last.timestamp + last.duration) * rate.num) / rate.den) + 3;
      // Back and forth, as people move the playhead, and then along, as playing does.
      const order = [
        ...Array.from({ length: 20 }, () => Math.floor(random() * moments)),
        ...Array.from({ length: moments }, (_, index) => index),
      ];
      for (const index of order) {
        // A clip that starts on a frame of the project reads its video at moments like this.
        const seconds = 0.5 + (index * rate.den) / rate.num - 0.5;
        const [shown, standIn] = [await original.at(seconds), await proxy.at(seconds)];
        expect(standIn?.index, `${rate.num}/${rate.den} at ${seconds}`).toBe(shown?.index);
      }
      await original.close();
      await proxy.close();
    }
  });
});
