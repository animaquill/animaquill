import type { RenderLayer } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { readingAt, VideoCursor, type FrameSource, type TimedFrame } from "./cursor.ts";

const STEP = 0.25;
const LAST = 400;

class FakeFrame implements TimedFrame {
  readonly #open: Set<FakeFrame>;
  readonly timestamp: number;

  constructor(timestamp: number, open: Set<FakeFrame>) {
    this.timestamp = timestamp;
    this.#open = open;
    open.add(this);
  }

  close(): void {
    this.#open.delete(this);
  }

  get closed(): boolean {
    return !this.#open.has(this);
  }
}

/** A decoder that hands out a frame when the test says so, and stops like Mediabunny's does. */
class FakeRead {
  readonly #source: FakeSource;
  #index: number;
  #waiting: ((result: IteratorResult<FakeFrame, void>) => void) | undefined;
  ended = false;

  constructor(source: FakeSource, seconds: number) {
    this.#source = source;
    this.#index = Math.max(Math.floor((seconds - source.first) / STEP), 0);
  }

  get waiting(): boolean {
    return this.#waiting !== undefined;
  }

  #frame(): IteratorResult<FakeFrame, void> {
    if (this.#index > LAST) return { value: undefined, done: true };
    const value = new FakeFrame(this.#source.first + this.#index * STEP, this.#source.open);
    this.#index += 1;
    return { value, done: false };
  }

  deliver(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.(this.#frame());
  }

  next(): Promise<IteratorResult<FakeFrame, void>> {
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (this.#source.instant) return Promise.resolve(this.#frame());
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  stop(): void {
    this.ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }
}

class FakeSource implements FrameSource<FakeFrame> {
  readonly open = new Set<FakeFrame>();
  readonly reads: FakeRead[] = [];
  instant = false;
  /** When the first frame starts, which is a little after the start of some files. */
  first = 0;

  samples(seconds: number): AsyncGenerator<FakeFrame, void, unknown> {
    const read = new FakeRead(this, seconds);
    this.reads.push(read);
    const generator: AsyncGenerator<FakeFrame, void, unknown> = {
      next: () => read.next(),
      return: () => {
        read.stop();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]: () => generator,
    };
    return generator;
  }

  get read(): FakeRead {
    const read = this.reads.at(-1);
    if (!read) throw new Error("nothing is being read");
    return read;
  }
}

/** Lets everything that can go on without the decoder go on. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- waiting is the point
    await Promise.resolve();
  }
}

function setup(instant = true) {
  const source = new FakeSource();
  source.instant = instant;
  return { source, cursor: new VideoCursor(source) };
}

describe("reading a video", () => {
  it("goes on forwards, and starts over backwards and far ahead", async () => {
    const { source, cursor } = setup();
    expect((await cursor.at(1))?.timestamp).toBe(1);
    expect((await cursor.at(1.6))?.timestamp).toBe(1.5);
    expect(source.reads).toHaveLength(1);
    expect((await cursor.at(0.5))?.timestamp).toBe(0.5);
    expect(source.reads).toHaveLength(2);
    expect((await cursor.at(50))?.timestamp).toBe(50);
    expect(source.reads).toHaveLength(3);
  });

  it("holds on to two frames, and to none once closed", async () => {
    const { source, cursor } = setup();
    await cursor.at(1);
    await cursor.at(3);
    expect(source.open.size).toBe(2);
    await cursor.close();
    expect(source.open.size).toBe(0);
  });
});

describe("a file whose first frame comes a little after its start", () => {
  it("stays on that frame before it, without starting over each time", async () => {
    const { source, cursor } = setup();
    source.first = 0.1;
    for (let ask = 0; ask < 5; ask += 1) expect((await cursor.at(0))?.timestamp).toBe(0.1);
    expect((await cursor.at(0.05))?.timestamp).toBe(0.1);
    expect((await cursor.at(0.4))?.timestamp).toBe(0.35);
    expect(source.reads).toHaveLength(1);
  });

  it("starts over for a moment before where its read started", async () => {
    const { source, cursor } = setup();
    source.first = 0.1;
    await cursor.at(0.05);
    expect((await cursor.at(0))?.timestamp).toBe(0.1);
    expect(source.reads).toHaveLength(2);
  });

  it("still starts over for a frame it went past", async () => {
    const { source, cursor } = setup();
    source.first = 0.1;
    await cursor.at(0);
    await cursor.at(0.4);
    expect((await cursor.at(0.2))?.timestamp).toBe(0.1);
    expect(source.reads).toHaveLength(2);
  });

  it("does not read again past the end of what there is", async () => {
    const { source, cursor } = setup();
    const end = (LAST + 10) * STEP;
    expect(await cursor.at(end)).toBeUndefined();
    expect(await cursor.at(end)).toBeUndefined();
    expect(source.reads).toHaveLength(1);
  });
});

describe("giving up", () => {
  it("does nothing while nothing is being read", async () => {
    const { source, cursor } = setup();
    const frame = await cursor.at(1);
    expect(cursor.giveUpUnlessLeadsTo(100)).toBe(false);
    expect(frame?.timestamp).toBe(1);
    expect(source.open.has(frame as FakeFrame)).toBe(true);
    expect((await cursor.at(1.25))?.timestamp).toBe(1.25);
    expect(source.reads).toHaveLength(1);
  });

  it("stops a decode on its way to the first frame", async () => {
    const { source, cursor } = setup(false);
    const old = cursor.at(50);
    await settle();
    expect(source.read.waiting).toBe(true);
    expect(cursor.giveUpUnlessLeadsTo(1)).toBe(true);
    expect(source.read.ended).toBe(true);
    await expect(old).resolves.toBeUndefined();
    await settle();
    expect(source.open.size).toBe(0);
    source.instant = true;
    expect((await cursor.at(1))?.timestamp).toBe(1);
  });

  it("drops what is waiting in line without decoding it", async () => {
    const { source, cursor } = setup(false);
    const running = cursor.at(50);
    const waiting = cursor.at(70);
    await settle();
    expect(cursor.giveUpUnlessLeadsTo(1)).toBe(true);
    await expect(running).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeUndefined();
    expect(source.reads).toHaveLength(1);
  });

  it("does not take a read that stopped halfway for the end of the video", async () => {
    const { source, cursor } = setup(false);
    const old = cursor.at(50);
    await settle();
    source.read.deliver();
    await settle();
    expect(source.read.waiting).toBe(true);
    cursor.giveUpUnlessLeadsTo(60);
    await old;
    source.instant = true;
    expect((await cursor.at(60))?.timestamp).toBe(60);
    expect(source.reads).toHaveLength(2);
  });

  it("stops walking through frames, and closes all it walked past", async () => {
    const { source, cursor } = setup();
    await cursor.at(0);
    source.instant = false;
    const old = cursor.at(1.9);
    await settle();
    source.read.deliver();
    await settle();
    source.read.deliver();
    await settle();
    expect(cursor.giveUpUnlessLeadsTo(0)).toBe(true);
    await expect(old).resolves.toBeUndefined();
    await settle();
    expect(source.open.size).toBe(0);
    source.instant = true;
    expect((await cursor.at(0))?.timestamp).toBe(0);
  });

  it("closes a frame that arrives at the moment of giving up", async () => {
    const { source, cursor } = setup(false);
    const old = cursor.at(50);
    await settle();
    source.read.deliver();
    cursor.giveUpUnlessLeadsTo(1);
    await old;
    await settle();
    expect(source.open.size).toBe(0);
  });

  it("goes on when the read is on the way to the new place", async () => {
    const { source, cursor } = setup(false);
    const going = cursor.at(50);
    await settle();
    expect(cursor.giveUpUnlessLeadsTo(50)).toBe(false);
    expect(cursor.giveUpUnlessLeadsTo(51.5)).toBe(false);
    source.read.deliver();
    await settle();
    source.read.deliver();
    expect((await going)?.timestamp).toBe(50);
    expect(source.reads).toHaveLength(1);
  });

  it("gives up for a place behind the read and for one too far ahead", async () => {
    const behind = setup(false);
    void behind.cursor.at(50);
    await settle();
    expect(behind.cursor.giveUpUnlessLeadsTo(49.75)).toBe(true);
    const ahead = setup(false);
    void ahead.cursor.at(50);
    await settle();
    expect(ahead.cursor.giveUpUnlessLeadsTo(52.25)).toBe(true);
    const gone = setup(false);
    void gone.cursor.at(50);
    await settle();
    expect(gone.cursor.giveUpUnlessLeadsTo(undefined)).toBe(true);
  });

  it("closing does not wait for a decode, and nothing reads after it", async () => {
    const { source, cursor } = setup(false);
    const old = cursor.at(50);
    await settle();
    await cursor.close();
    await expect(old).resolves.toBeUndefined();
    await expect(cursor.at(1)).resolves.toBeUndefined();
    expect(source.reads).toHaveLength(1);
    expect(source.open.size).toBe(0);
  });

  it("stays right and closes everything through any order of events", async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      let state = seed;
      const random = (below: number) => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return Math.floor((state / 2_147_483_648) * below);
      };
      const { source, cursor } = setup(false);
      const answers: Promise<void>[] = [];
      for (let step = 0; step < 60; step += 1) {
        const action = random(4);
        const seconds = random(80) / 4;
        if (action === 0) {
          answers.push(
            cursor.at(seconds).then((frame) => {
              if (!frame) return;
              // A frame comes back open and from before the moment, or from no read at all.
              expect(frame.timestamp).toBeLessThanOrEqual(seconds);
            }),
          );
        } else if (action === 1) {
          cursor.giveUpUnlessLeadsTo(random(5) === 0 ? undefined : seconds);
        } else {
          for (const read of source.reads) read.deliver();
          // oxlint-disable-next-line no-await-in-loop -- the order of events is the point
          await settle();
        }
        expect(source.reads.filter(({ ended }) => !ended).length).toBeLessThanOrEqual(1);
      }
      const closing = cursor.close();
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await Promise.all([closing, ...answers]);
      expect(source.open.size, `seed ${seed}`).toBe(0);
    }
  });
});

describe("where a clip gets read", () => {
  const layer = { start: 10, end: 20, offset: 3 } as RenderLayer;

  it("follows the playhead while the clip shows", () => {
    expect(readingAt(layer, 10)).toBe(3);
    expect(readingAt(layer, 12.5)).toBe(5.5);
  });

  it("stays at the start while the clip is getting ready", () => {
    expect(readingAt(layer, 9)).toBe(3);
  });

  it("is nowhere otherwise", () => {
    expect(readingAt(layer, 5)).toBeUndefined();
    expect(readingAt(layer, 20)).toBeUndefined();
  });
});
