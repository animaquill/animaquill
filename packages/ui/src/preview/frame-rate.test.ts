import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import { PaintWindow, PreviewFrameRate } from "./frame-rate.ts";

/** Frames that reached the canvas evenly over the last `ms`, as the compositor tells it. */
const evenly = (count: number, ms: number) =>
  Array.from({ length: count }, (_, index) => (ms * index) / count);

describe("counting what reached the canvas", () => {
  it("counts the last second", () => {
    const window = new PaintWindow();
    window.add(10_000, evenly(57, 1000));
    expect(window.read(10_000, 0, 60)).toEqual({ painted: 57, fps: 60, dropped: 3, short: false });
  });

  it("forgets what is older than a second", () => {
    const window = new PaintWindow();
    window.add(9000, evenly(60, 1000));
    window.add(10_000, evenly(20, 1000));
    expect(window.read(10_000, 0, 60)).toMatchObject({ painted: 20, dropped: 40, short: true });
  });

  it("says it is short only well below the project frame rate", () => {
    const window = new PaintWindow();
    window.add(10_000, evenly(54, 1000));
    expect(window.read(10_000, 0, 60)?.short).toBe(false);
    const fewer = new PaintWindow();
    fewer.add(10_000, evenly(53, 1000));
    expect(fewer.read(10_000, 0, 60)?.short).toBe(true);
  });

  it("only counts since playing started", () => {
    const window = new PaintWindow();
    // Frames from moving the playhead before that are no part of it.
    window.add(9500, evenly(10, 400));
    window.add(10_000, evenly(15, 500));
    expect(window.read(10_000, 9500, 30)).toEqual({
      painted: 30,
      fps: 30,
      dropped: 0,
      short: false,
    });
  });

  it("says nothing with too little to go on", () => {
    const window = new PaintWindow();
    window.add(10_000, evenly(3, 100));
    expect(window.read(10_000, 9900, 30)).toBeUndefined();
  });

  it("goes by what was heard, which arrives a moment late", () => {
    const window = new PaintWindow();
    window.add(10_000, evenly(60, 1000));
    // The next word is on its way: what is between is not missing.
    expect(window.read(10_200, 0, 60)?.painted).toBe(60);
  });

  it("takes a compositor that went quiet for one that draws nothing", () => {
    const window = new PaintWindow();
    window.add(10_000, evenly(60, 1000));
    expect(window.read(11_500, 0, 60)).toMatchObject({ painted: 0, dropped: 60, short: true });
  });

  it("ignores what makes no sense", () => {
    const window = new PaintWindow();
    window.add(10_000, [Number.NaN, -5, Number.POSITIVE_INFINITY, 10]);
    expect(window.read(10_000, 0, 30)?.painted).toBe(1);
  });
});

describe("the meter in the status bar", () => {
  let now = 0;
  const emitter = new Emitter();
  let playing = false;
  const playback = {
    subscribe: emitter.subscribe,
    getSnapshot: () => ({ playing, model: { rate: { fps: 30 } } }),
  };
  const play = (on: boolean) => {
    playing = on;
    emitter.emit();
  };
  /** Time goes on, with the compositor drawing this many frames a second. */
  const run = (feed: { painted(ago: readonly number[]): void }, ms: number, fps: number) => {
    for (let step = 0; step < ms; step += 250) {
      now += 250;
      feed.painted(evenly(Math.round(fps / 4), 250));
      vi.advanceTimersByTime(250);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    playing = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has nothing to say without a preview", () => {
    const meter = new PreviewFrameRate(playback, () => now);
    play(true);
    expect(meter.getSnapshot()).toEqual({ state: "none" });
    const feed = meter.attach();
    expect(meter.getSnapshot()).toEqual({ state: "playing", reading: undefined });
    feed.dispose();
    expect(meter.getSnapshot()).toEqual({ state: "none" });
  });

  it("says what it counted once a second while playing, and stops when it pauses", () => {
    const meter = new PreviewFrameRate(playback, () => now);
    const feed = meter.attach();
    expect(meter.getSnapshot()).toEqual({ state: "paused" });
    const heard = vi.fn();
    meter.subscribe(heard);
    play(true);
    heard.mockClear();
    run(feed, 1000, 28);
    expect(meter.getSnapshot()).toEqual({
      state: "playing",
      reading: { painted: 28, fps: 30, dropped: 2, short: false },
    });
    run(feed, 2000, 20);
    // Once a second at most, however often frames come.
    expect(heard).toHaveBeenCalledTimes(2);
    expect(meter.getSnapshot()).toEqual({
      state: "playing",
      reading: { painted: 20, fps: 30, dropped: 10, short: true },
    });
    play(false);
    expect(meter.getSnapshot()).toEqual({ state: "paused" });
    heard.mockClear();
    vi.advanceTimersByTime(5000);
    expect(heard).not.toHaveBeenCalled();
  });

  it("does not tell anybody when nothing changed", () => {
    const meter = new PreviewFrameRate(playback, () => now);
    const feed = meter.attach();
    play(true);
    run(feed, 1000, 28);
    const heard = vi.fn();
    meter.subscribe(heard);
    run(feed, 3000, 28);
    expect(heard).not.toHaveBeenCalled();
  });

  it("counts the newest preview", () => {
    const meter = new PreviewFrameRate(playback, () => now);
    const old = meter.attach();
    const current = meter.attach();
    play(true);
    for (let step = 0; step < 4; step += 1) {
      now += 250;
      old.painted(evenly(7, 250));
      current.painted(evenly(5, 250));
      vi.advanceTimersByTime(250);
    }
    expect(meter.getSnapshot()).toMatchObject({ reading: { painted: 20 } });
  });
});
