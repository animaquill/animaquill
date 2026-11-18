import { describe, expect, it } from "vitest";
import { SampleStore } from "./samples.ts";

const chunk = (start: number, channels: readonly (readonly number[])[], rate = 48_000) => ({
  start,
  rate,
  channels: channels.map((values) => Float32Array.from(values)),
});

function read(store: SampleStore, from: number, count: number) {
  const left = new Float64Array(count);
  const right = new Float64Array(count);
  const complete = store.read(from, count, left, right, 0);
  return { left: [...left], right: [...right], complete };
}

describe("down-mixing to the two channels of the mix, as Web Audio's speakers rules have it", () => {
  it("keeps mono as one channel, which the mix plays in both", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[0.5, -0.25]]));
    expect(store.channels).toBe(1);
    expect(read(store, 0, 2).left).toEqual([0.5, -0.25]);
  });

  it("keeps stereo", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[0.5], [0.25]]));
    expect(read(store, 0, 1)).toMatchObject({ left: [0.5], right: [0.25] });
  });

  it("brings quad down: left with surround left, right with surround right, at half each", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[0.5], [0.25], [0.125], [-0.5]]));
    expect(read(store, 0, 1)).toMatchObject({
      left: [0.5 * (0.5 + 0.125)],
      right: [0.5 * (0.25 - 0.5)],
    });
  });

  it("brings 5.1 down: the centre and the surrounds at √½, without the low frequencies", () => {
    const store = new SampleStore();
    // Left, right, centre, low frequencies, surround left, surround right.
    store.add(chunk(0, [[0.5], [0.25], [0.125], [1], [0.0625], [-0.25]]));
    const { left, right } = read(store, 0, 1);
    expect(left[0]).toBeCloseTo(0.5 + Math.SQRT1_2 * (0.125 + 0.0625), 7);
    expect(right[0]).toBeCloseTo(0.25 + Math.SQRT1_2 * (0.125 - 0.25), 7);
  });

  it("takes the first two of any other number of channels", () => {
    for (const count of [3, 5, 8]) {
      const store = new SampleStore();
      store.add(
        chunk(
          0,
          Array.from({ length: count }, (_, index) => [index + 1]),
        ),
      );
      expect(read(store, 0, 1)).toMatchObject({ left: [1], right: [2] });
    }
  });
});

describe("the samples of a sound", () => {
  it("are silent before the file and after its end, which is nothing missing", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[1, 2, 3]]));
    store.endAt(3);
    expect(read(store, -2, 7)).toEqual({
      left: [0, 0, 1, 2, 3, 0, 0],
      right: [0, 0, 0, 0, 0, 0, 0],
      complete: true,
    });
  });

  it("are missing where nothing was read", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[1, 2, 3]]));
    store.add(chunk(5, [[6, 7]]));
    expect(read(store, 0, 7)).toMatchObject({ left: [1, 2, 3, 0, 0, 6, 7], complete: false });
    expect(read(store, 5, 2).complete).toBe(true);
  });

  it("are silent in a gap that whoever read the file says it read", () => {
    const store = new SampleStore();
    store.add(chunk(5, [[6, 7]]));
    store.cover(0, 7);
    expect(read(store, 0, 7)).toMatchObject({ left: [0, 0, 0, 0, 0, 6, 7], complete: true });
  });

  it("keep what was read in pieces apart from each other, as backwards playing reads", () => {
    const store = new SampleStore();
    store.add(chunk(10, [[1, 2]]));
    store.add(chunk(0, [[3, 4]]));
    expect(read(store, 10, 2).complete).toBe(true);
    expect(read(store, 0, 2).complete).toBe(true);
    expect(read(store, 0, 12).complete).toBe(false);
  });

  it("let go of what is no longer needed", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[1, 2]]));
    store.add(chunk(2, [[3, 4]]));
    store.keepOnly(2, Number.POSITIVE_INFINITY);
    expect(store.frames).toBe(2);
    expect(read(store, 0, 4)).toMatchObject({ left: [0, 0, 3, 4], complete: false });
  });

  it("leave out a chunk at another rate", () => {
    const store = new SampleStore();
    store.add(chunk(0, [[1]], 44_100));
    store.add(chunk(1, [[2]], 48_000));
    expect(store.rate).toBe(44_100);
    expect(store.frames).toBe(1);
  });
});
