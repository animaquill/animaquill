import type { RenderLayer } from "@animaquill/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameSource, TimedFrame } from "./cursor.ts";
import { FrameLoop } from "./frame-loop.ts";
import type { FrameTiming } from "./index.ts";
import { SETTLE_MS } from "./patience.ts";
import { VideoReads } from "./reads.ts";

/** A 4K video of a phone: 60 frames a second, a keyframe every second. */
const FILE_FPS = 60;
const KEYFRAME_EVERY = 60;
const FILE_FRAMES = 200 * FILE_FPS;
const TIMELINE_FPS = 30;

class FakeFrame implements TimedFrame {
  readonly timestamp: number;
  constructor(index: number) {
    this.timestamp = index / FILE_FPS;
  }
  close(): void {}
}

interface Job {
  readonly done: (finished: boolean) => void;
  over: boolean;
}

/**
 * The graphics card, which all reads share: one frame at a time, and the reads take turns. A read
 * that starts somewhere decodes from the keyframe before it. It can stall for a while, as it did on
 * a laptop with 4K videos.
 */
class Decoder {
  readonly frameMs: number;
  readonly #queue: Job[] = [];
  #current: { readonly job: Job; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  #stalledUntil = 0;
  /** Frames that were called off because their read was given up. */
  cancelled = 0;

  constructor(frameMs: number) {
    this.frameMs = frameMs;
  }

  stall(ms: number): void {
    this.#stalledUntil = Date.now() + ms;
  }

  /** One frame. Resolves true once it is done, false when it was called off. */
  decode(): { readonly done: Promise<boolean>; readonly cancel: () => void } {
    let finish: (finished: boolean) => void = () => {};
    const done = new Promise<boolean>((resolve) => (finish = resolve));
    const job: Job = { done: (finished) => ((job.over = true), finish(finished)), over: false };
    this.#queue.push(job);
    this.#next();
    const cancel = () => {
      if (job.over) return;
      this.cancelled += 1;
      const index = this.#queue.indexOf(job);
      if (index >= 0) this.#queue.splice(index, 1);
      if (this.#current?.job === job) {
        clearTimeout(this.#current.timer);
        this.#current = undefined;
        this.#next();
      }
      job.done(false);
    };
    return { done, cancel };
  }

  #next(): void {
    if (this.#current) return;
    const job = this.#queue.shift();
    if (!job) return;
    const wait = Math.max(this.#stalledUntil - Date.now(), 0) + this.frameMs;
    const timer = setTimeout(() => {
      this.#current = undefined;
      job.done(true);
      this.#next();
    }, wait);
    this.#current = { job, timer };
  }
}

/** Reads like Mediabunny: `return` during a `next` ends it early. */
class FakeVideo implements FrameSource<FakeFrame> {
  readonly #decoder: Decoder;

  constructor(decoder: Decoder) {
    this.#decoder = decoder;
  }

  samples(seconds: number): AsyncGenerator<FakeFrame, void, unknown> {
    const decoder = this.#decoder;
    let index = Math.min(Math.max(Math.floor(seconds * FILE_FPS + 1e-6), 0), FILE_FRAMES);
    let first = true;
    let ended = false;
    let cancel: (() => void) | undefined;
    const decode = async (frames: number) => {
      try {
        for (let frame = 0; frame < frames; frame++) {
          const work = decoder.decode();
          cancel = work.cancel;
          if (!(await work.done) || ended) return false;
        }
        return true;
      } finally {
        cancel = undefined;
      }
    };
    const generator: AsyncGenerator<FakeFrame, void, unknown> = {
      async next() {
        if (ended || index > FILE_FRAMES) return { value: undefined, done: true };
        // The first frame takes all frames from the keyframe before it.
        const frames = first ? (index % KEYFRAME_EVERY) + 1 : 1;
        first = false;
        if (!(await decode(frames))) return { value: undefined, done: true };
        const value = new FakeFrame(index);
        index += 1;
        return { value, done: false };
      },
      async return() {
        ended = true;
        cancel?.();
        return { value: undefined, done: true };
      },
      async throw(error: unknown) {
        ended = true;
        throw error;
      },
      [Symbol.asyncIterator]() {
        return generator;
      },
    };
    return generator;
  }
}

const layerOf = (id: string, start: number, end: number, offset: number) =>
  ({
    id,
    start,
    end,
    offset,
    source: { kind: "video", file: "file" },
    fit: "contain",
    channels: {},
  }) as unknown as RenderLayer;

/** A quick cut of one long video, as in the project of the reports: clips of 0.4 to 0.9 seconds. */
function quickCut(count: number): RenderLayer[] {
  const lengths = [0.93, 0.7, 0.7, 0.4, 0.57, 0.5, 0.57, 0.6];
  const offsets = [0, 12.3, 146.2, 28.5, 61.7, 95.1, 39.47, 151.13, 110.4, 7.9];
  const layers: RenderLayer[] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const end = start + (lengths[index % lengths.length] ?? 0.5);
    layers.push(layerOf(`clip${index}`, start, end, offsets[index % offsets.length] ?? 0));
    start = end;
  }
  return layers;
}

type Drawn = FrameTiming & { readonly at: number };

function setup(layers: readonly RenderLayer[], frameMs: number) {
  const decoder = new Decoder(frameMs);
  const video = new FakeVideo(decoder);
  const reads = new VideoReads<FakeFrame>();
  const drawn: Drawn[] = [];
  // The same steps as the compositor, with one file for all clips.
  const loop: FrameLoop = new FrameLoop({
    layers: () => layers,
    async draw(frame) {
      const { seconds } = frame;
      const showing = loop.showing(seconds);
      const needed = [...showing, ...loop.upcoming(seconds)];
      await reads.closeExcept(new Set(needed.map(({ id }) => id)));
      await Promise.all(
        showing.map(async (layer) => {
          if (frame.jumped) frame.givenUp = true;
          if (frame.givenUp) return;
          const read = await reads.frameAt(layer, "file", video, seconds);
          if (read.cold) frame.cold.push({ layer: layer.id, kind: "video" });
        }),
      );
      return !frame.givenUp;
    },
    prepare: (layer, seconds) => reads.prepare(layer, "file", video, seconds),
    giveUpFor: (seconds) => reads.giveUpFor(layers, seconds),
    drew: (timing) => drawn.push({ ...timing, at: Date.now() }),
    wait(milliseconds, run) {
      const timer = setTimeout(run, milliseconds);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
  });

  /** Where the playhead is at each frame of the timeline, as the editor says while playing. */
  async function play(from: number, seconds: number, during?: (elapsed: number) => void) {
    const started = Date.now();
    loop.seek(from, true);
    void loop.refresh();
    let frame = Math.round(from * TIMELINE_FPS);
    for (;;) {
      await vi.advanceTimersByTimeAsync(1000 / TIMELINE_FPS / 2);
      const elapsed = (Date.now() - started) / 1000;
      during?.(elapsed);
      const now = Math.floor((from + elapsed) * TIMELINE_FPS + 1e-6);
      if (now === frame) continue;
      frame = now;
      if (elapsed > seconds) return;
      loop.seek(frame / TIMELINE_FPS, false);
      void loop.refresh();
    }
  }

  return { loop, decoder, drawn, play };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The clip a moment is in. */
const clipAt = (layers: readonly RenderLayer[], seconds: number) =>
  layers.findIndex(({ start, end }) => seconds >= start - 1e-9 && seconds < end - 1e-9);

describe("playing a quick cut", () => {
  // Decoding from a keyframe to where a clip starts takes up to 0.3 seconds, which a clip that gets
  // ready in time hides, as in the reports where nothing stuttered at a cut.
  const FRAME_MS = 5;

  it("starts no decoder at a cut when nothing goes wrong", async () => {
    const { drawn, play } = setup(quickCut(40), FRAME_MS);
    await play(0, 10);
    const along = drawn.filter(({ seconds }) => seconds > 0.5 && seconds < 9.5);
    expect(along.filter(({ cold }) => cold > 0)).toEqual([]);
    expect(Math.max(...along.map(({ behindMs }) => behindMs))).toBeLessThan(100);
  });

  it("gets back within two clips after a decode took three seconds", async () => {
    const layers = quickCut(40);
    const { drawn, decoder, play } = setup(layers, FRAME_MS);
    const stallAt = 2;
    const stallMs = 3000;
    let stalled = false;
    await play(0, 16, (elapsed) => {
      if (stalled || elapsed < stallAt) return;
      stalled = true;
      decoder.stall(stallMs);
    });
    const backAt = stallAt + stallMs / 1000;
    const after = drawn.filter(({ at }) => at / 1000 > backAt);
    const late = (frame: Drawn) => frame.cold > 0 || frame.behindMs > 150;
    const onTime = after.slice(after.findLastIndex(late) + 1);
    // The playhead was at `backAt` when the decoder came back, as playing started at 0.
    const lost = clipAt(layers, onTime[0]?.seconds ?? Infinity) - clipAt(layers, backAt);
    expect(lost).toBeLessThanOrEqual(2);
    // And on time from then on to the end, without starting a decoder again.
    expect(onTime.at(-1)?.seconds).toBeGreaterThan(15.5);
  });
});

describe("somebody moving the playhead", () => {
  it("lets the reads finish while the hand moves, and gives up once it rests", async () => {
    const { loop, drawn, decoder } = setup(quickCut(40), 5);
    loop.seek(1, true);
    void loop.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    decoder.stall(1000);
    for (let step = 1; step <= 20; step++) {
      loop.seek(1 + step * 0.4, true);
      void loop.refresh();
      await vi.advanceTimersByTimeAsync(SETTLE_MS / 3);
    }
    expect(decoder.cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(decoder.cancelled).toBeGreaterThan(0);
    expect(drawn.at(-1)?.seconds).toBe(9);
  });
});

describe("exporting", () => {
  it("leaves the drawing to the export", async () => {
    const { loop, drawn } = setup(quickCut(10), 5);
    loop.exporting = true;
    loop.seek(1, false);
    void loop.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(drawn).toEqual([]);
  });
});
