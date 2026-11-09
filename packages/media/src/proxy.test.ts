import { describe, expect, it } from "vitest";
import { KEY_SECONDS, pickFrames, type PickedFrame, type TimedSample } from "./proxy.ts";

interface Sample extends TimedSample {
  readonly index: number;
  closed: number;
}

/** Frames of a video, at these times, as a decoder gives them. */
function video(times: readonly number[], last = 1 / 60) {
  const samples: Sample[] = times.map((timestamp, index) => ({
    index,
    timestamp,
    duration: (times[index + 1] ?? timestamp + last) - timestamp,
    closed: 0,
    close() {
      this.closed += 1;
    },
  }));
  let given = 0;
  let ended = false;
  const iterable: AsyncIterable<Sample> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = samples[given];
        if (ended || !value) return { done: true, value: undefined };
        given += 1;
        return { done: false, value };
      },
      return: async () => {
        ended = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { samples, iterable, given: () => given, ended: () => ended };
}

const evenly = (count: number, fps: number, from = 0) =>
  Array.from({ length: count }, (_, index) => from + index / fps);

/** Takes all of them, closing each as whoever draws it does. */
async function all(frames: AsyncIterable<PickedFrame<Sample>>) {
  const taken: { index: number; timestamp: number; duration: number; key: boolean }[] = [];
  for await (const { sample, timestamp, duration, key } of frames) {
    taken.push({ index: sample.index, timestamp, duration, key });
    sample.close();
  }
  return taken;
}

const THIRTY = { num: 30, den: 1 };

describe("the frames of a proxy", () => {
  it("are every other one of a video at twice the rate, each at its moment", async () => {
    const { samples, iterable } = video(evenly(12, 60));
    const taken = await all(pickFrames(iterable, THIRTY));
    // At the moment the video ends its last frame still shows, as it does past its end.
    expect(taken.map(({ index }) => index)).toEqual([0, 2, 4, 6, 8, 10, 11]);
    for (const [at, frame] of taken.entries()) {
      expect(frame.timestamp).toBeCloseTo(at / 30, 9);
      expect(frame.duration).toBeCloseTo(1 / 30, 9);
    }
    // Every frame gets closed once: those that went out by whoever got them, the others here.
    expect(samples.map(({ closed }) => closed)).toEqual(samples.map(() => 1));
  });

  it("come once for a frame that shows at several moments, from the first of them", async () => {
    const { samples, iterable } = video(evenly(6, 24));
    const taken = await all(pickFrames(iterable, THIRTY));
    // At 0 and 1/30 the first frame shows; the second one from 2/30, which is after 1/24.
    expect(taken.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(taken.map(({ timestamp }) => Math.round(timestamp * 30))).toEqual([0, 2, 3, 4, 5, 7]);
    expect(Math.round((taken[0]?.duration ?? 0) * 30)).toBe(2);
    expect(samples.every(({ closed }) => closed === 1)).toBe(true);
  });

  it("have the first frame from the start, also of a video that starts later", async () => {
    const { iterable } = video([0.5, 0.6, 0.7]);
    const taken = await all(pickFrames(iterable, { num: 10, den: 1 }));
    expect(taken.map(({ index, timestamp }) => [index, Math.round(timestamp * 10)])).toEqual([
      [0, 0],
      [1, 6],
      [2, 7],
    ]);
  });

  it("end one moment after the last one the video shows a frame at", async () => {
    const { iterable } = video(evenly(4, 60), 1 / 60);
    const taken = await all(pickFrames(iterable, THIRTY));
    const last = taken.at(-1);
    // Four frames at 60 end at 2/30, where the last of them still shows.
    expect(last?.index).toBe(3);
    expect(last?.timestamp).toBeCloseTo(2 / 30, 9);
    expect((last?.timestamp ?? 0) + (last?.duration ?? 0)).toBeCloseTo(3 / 30, 9);
    const one = video([0], 10);
    const [only, ...more] = await all(pickFrames(one.iterable, THIRTY));
    expect(more).toEqual([]);
    expect(only?.duration).toBeCloseTo(10, 9);
  });

  it("have a key frame every half a second and at the start", async () => {
    const { iterable } = video(evenly(120, 60));
    const taken = await all(pickFrames(iterable, THIRTY));
    const keys = taken.filter(({ key }) => key).map(({ timestamp }) => timestamp);
    // Two seconds, and the moment they end.
    expect(keys.map((time) => Math.round(time / KEY_SECONDS))).toEqual([0, 1, 2, 3, 4]);
    expect(taken.filter(({ key }) => !key)).toHaveLength(taken.length - 5);
  });

  it("are exact at a rate that is no whole number", async () => {
    const ntsc = { num: 30_000, den: 1001 };
    const { iterable } = video(evenly(600, 60_000 / 1001));
    const taken = await all(pickFrames(iterable, ntsc));
    expect(taken).toHaveLength(301);
    for (const [at, frame] of taken.entries()) {
      expect(frame.index).toBe(Math.min(at * 2, 599));
      expect(frame.timestamp).toBe((at * 1001) / 30_000);
    }
  });

  it("leave out frames without a time, and get past a long gap at once", async () => {
    const { samples, iterable } = video([0, Number.NaN, 0.1, 1e7]);
    const started = performance.now();
    const taken = await all(pickFrames(iterable, THIRTY));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(taken.map(({ index }) => index)).toEqual([0, 2, 3]);
    expect(taken[2]?.timestamp).toBeCloseTo(1e7, 3);
    expect(samples[1]?.closed).toBe(1);
  });

  it("close what they hold when nobody wants more, and stop the decoder", async () => {
    const { samples, iterable, ended, given } = video(evenly(20, 60));
    const frames = pickFrames(iterable, THIRTY);
    const first = await frames.next();
    if (first.done) throw new Error("No frame");
    first.value.sample.close();
    await frames.return();
    expect(ended()).toBe(true);
    // What was decoded and not handed out is closed too: nothing of the decoder stays in use.
    expect(given()).toBeGreaterThan(2);
    expect(samples.slice(0, given()).map(({ closed }) => closed)).toEqual(
      Array.from({ length: given() }, () => 1),
    );
    expect(samples.slice(given()).every(({ closed }) => closed === 0)).toBe(true);
  });

  it("are none of a video without frames", async () => {
    const { iterable } = video([]);
    expect(await all(pickFrames(iterable, THIRTY))).toEqual([]);
  });
});
