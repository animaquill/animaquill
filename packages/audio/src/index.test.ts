import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import {
  PlaybackAudio,
  backwardsOf,
  joined,
  type PitchKeeper,
  type PlaybackAudioOptions,
  type SoundChunk,
} from "./index.ts";

interface Started {
  readonly when: number;
  readonly offset: number;
  readonly duration: number;
  readonly stop: ReturnType<typeof vi.fn>;
  /** How fast it plays. */
  readonly rate: number;
  readonly buffer: unknown;
}

/** Enough of an AudioBuffer for what playing backwards does to one. */
function fakeBuffer(channels: number, length: number, sampleRate: number) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => data[channel] as Float32Array,
  };
}

function fakeContext(latency = 0) {
  const started: Started[] = [];
  const gains: number[] = [];
  const context = {
    state: "running",
    currentTime: 10,
    outputLatency: latency,
    baseLatency: 0,
    destination: { name: "speakers" },
    resume: async () => {},
    createBuffer: fakeBuffer,
    close: async () => {},
    createGain() {
      const gain = {
        gain: { value: 1 },
        to: undefined as unknown,
        connect(to: unknown) {
          gain.to = to;
        },
        disconnect() {},
      };
      queueMicrotask(() => gains.push(gain.gain.value));
      return gain;
    },
    createBufferSource() {
      const stop = vi.fn();
      const node = {
        buffer: undefined as unknown,
        playbackRate: { value: 1 },
        connect() {},
        addEventListener() {},
        stop,
        start(when: number, offset: number, duration: number) {
          const { buffer } = node;
          started.push({ when, offset, duration, stop, rate: node.playbackRate.value, buffer });
        },
      };
      return node;
    },
  };
  return { context, started, gains };
}

const chunks = (...times: number[]) =>
  times.map((timestamp) => ({ buffer: {}, timestamp, duration: 1 }) as unknown as SoundChunk);

const sound = (changes: Partial<SoundLayer> = {}): SoundLayer => ({
  id: "s",
  file: "f",
  start: 0,
  end: 3,
  offset: 0,
  gain: 1,
  ...changes,
});

const planOf = (...sounds: SoundLayer[]): AudioPlan => ({ sounds });

function setup(
  options: {
    latency?: number;
    list?: readonly SoundChunk[];
    file?: boolean;
    /** Says whether the file is here by now. */
    arrived?: () => boolean;
    keepPitch?: PlaybackAudioOptions["keepPitch"];
  } = {},
) {
  const fake = fakeContext(options.latency);
  let wall = 0;
  const read = vi.fn(async function* (_file: Blob, from: number, to: number) {
    for (const chunk of options.list ?? chunks(0, 1, 2)) {
      if (chunk.timestamp + chunk.duration > from && chunk.timestamp < to) yield chunk;
    }
  });
  const onProblem = vi.fn();
  const audio = new PlaybackAudio({
    fileOf: async () => {
      if (options.arrived) return options.arrived() ? new Blob() : undefined;
      return options.file === false ? undefined : new Blob();
    },
    onProblem,
    read,
    createContext: () => fake.context as unknown as AudioContext,
    wallClock: () => wall,
    ...(options.keepPitch && { keepPitch: options.keepPitch }),
  });
  const walk = (ms: number) => {
    wall += ms;
  };
  const settled = () => vi.waitFor(() => expect(read).toHaveBeenCalled());
  return { ...fake, audio, read, onProblem, walk, settled };
}

const close = (value: number) => expect.closeTo(value, 5);

describe("the clock", () => {
  it("goes by the wall until there is sound", () => {
    const { audio, walk } = setup();
    const start = audio.now();
    walk(250);
    expect(audio.now() - start).toBe(250);
  });

  it("goes by the sound once it runs, however the wall behaves", () => {
    const { audio, context, walk } = setup();
    audio.play(planOf(), 0, audio.now());
    const start = audio.now();
    context.currentTime += 0.5;
    walk(9000);
    expect(audio.now() - start).toBeCloseTo(500);
  });

  it("carries on by the wall when sound gets suspended, without a jump", () => {
    const { audio, context, walk } = setup();
    audio.play(planOf(), 0, audio.now());
    const start = audio.now();
    context.state = "suspended";
    walk(100);
    expect(audio.now() - start).toBeCloseTo(100);
    context.currentTime += 50;
    context.state = "running";
    expect(audio.now() - start).toBeCloseTo(100);
    context.currentTime += 0.1;
    expect(audio.now() - start).toBeCloseTo(200);
  });

  it("keeps going when a browser has no audio at all", () => {
    const fail = () => {
      throw new Error("no audio");
    };
    let wall = 0;
    const audio = new PlaybackAudio({
      fileOf: async () => undefined,
      onProblem() {},
      createContext: fail,
      wallClock: () => wall,
    });
    audio.play(planOf(sound()), 0, audio.now());
    const start = audio.now();
    wall += 40;
    expect(audio.now() - start).toBe(40);
  });
});

describe("playing", () => {
  it("lines chunks up one after the other", async () => {
    const { audio, started, settled } = setup();
    audio.play(planOf(sound()), 0, audio.now());
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started.map(({ when }) => when)).toEqual([close(10), close(11), close(12)]);
    audio.stop();
  });

  it("starts in the file where the clip starts, and ends where the clip ends", async () => {
    const { audio, started, read, settled } = setup();
    audio.play(planOf(sound({ start: 5, end: 6.5, offset: 1 })), 5, audio.now());
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(read.mock.calls[0]?.slice(1)).toEqual([1, 2.5]);
    expect(started[1]).toMatchObject({ when: close(11), offset: close(0), duration: close(0.5) });
    audio.stop();
  });

  it("starts in the middle of a clip that is already going", async () => {
    const { audio, started, settled } = setup();
    audio.play(planOf(sound()), 1.25, audio.now());
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started[0]).toMatchObject({ when: close(10), offset: close(0.25) });
    audio.stop();
  });

  it("leaves out what has passed when decoding is late, and stays in step", async () => {
    const { audio, context, started, settled } = setup({ list: chunks(0) });
    audio.play(planOf(sound()), 0, audio.now());
    context.currentTime += 0.3;
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ when: close(10.3), offset: close(0.3) });
    audio.stop();
  });

  it("sends sound earlier by what the device takes", async () => {
    const { audio, started, settled } = setup({ latency: 0.1 });
    audio.play(planOf(sound({ start: 0.5 })), 0, audio.now());
    await settled();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
    expect(started[0]?.when).toBeCloseTo(10.4);
    audio.stop();
  });

  it("does not touch a sound that is still far away", async () => {
    const { audio, read } = setup();
    audio.play(planOf(sound({ start: 30, end: 31 })), 0, audio.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
    audio.stop();
  });

  it("does not play what lies before the playhead", async () => {
    const { audio, read } = setup();
    audio.play(planOf(sound({ end: 2 })), 5, audio.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
    audio.stop();
  });

  it("uses the volume of the plan", async () => {
    const { audio, gains, settled } = setup();
    audio.play(planOf(sound({ gain: 0.5 })), 0, audio.now());
    await settled();
    await vi.waitFor(() => expect(gains).toEqual([0.5]));
    audio.stop();
  });

  it("goes quiet at once when stopped", async () => {
    const { audio, started, settled } = setup();
    audio.play(planOf(sound()), 0, audio.now());
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    audio.stop();
    for (const { stop } of started) expect(stop).toHaveBeenCalled();
  });

  it("says so when a file is gone, and the clock goes on", async () => {
    const { audio, onProblem, walk } = setup({ file: false });
    audio.play(planOf(sound()), 0, audio.now());
    await vi.waitFor(() => expect(onProblem).toHaveBeenCalledWith("f"));
    const start = audio.now();
    walk(10);
    expect(audio.now()).toBeGreaterThanOrEqual(start);
    audio.stop();
  });
});

describe("a sound that code is still making", () => {
  const made = (changes: Partial<SoundLayer> = {}) => sound({ made: true, end: 10, ...changes });

  /** A while of playing, with the timer of the sound going off. */
  async function pass(walk: (ms: number) => void, context: { currentTime: number }, ms: number) {
    walk(ms);
    context.currentTime += ms / 1000;
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("is no problem, and the clock goes on without it", async () => {
    vi.useFakeTimers();
    try {
      const { audio, onProblem, read, walk, context } = setup({ file: false });
      audio.play(planOf(made()), 0, audio.now());
      const start = audio.now();
      await pass(walk, context, 300);
      expect(audio.now() - start).toBeCloseTo(300);
      expect(onProblem).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      audio.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes in when it is there, at the place the timeline has got to", async () => {
    vi.useFakeTimers();
    try {
      let here = false;
      const { audio, read, walk, context, started } = setup({
        arrived: () => here,
        list: chunks(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
      });
      audio.play(planOf(made()), 0, audio.now());
      await pass(walk, context, 2000);
      expect(read).not.toHaveBeenCalled();
      here = true;
      await pass(walk, context, 600);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[1]).toBeGreaterThan(2);
      expect(started.length).toBeGreaterThan(0);
      audio.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bother the store for every turn of the timer", async () => {
    vi.useFakeTimers();
    try {
      const looks = vi.fn(() => false);
      const { audio, walk, context } = setup({ arrived: looks });
      audio.play(planOf(made()), 0, audio.now());
      await pass(walk, context, 1000);
      expect(looks.mock.calls.length).toBeLessThanOrEqual(4);
      audio.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is left alone once its clip went by", async () => {
    vi.useFakeTimers();
    try {
      const looks = vi.fn(() => false);
      const { audio, walk, context } = setup({ arrived: looks });
      audio.play(planOf(made({ end: 1 })), 0, audio.now());
      await pass(walk, context, 1500);
      const before = looks.mock.calls.length;
      await pass(walk, context, 2000);
      expect(looks.mock.calls.length).toBe(before);
      audio.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays a problem for a file that nobody makes", async () => {
    const { audio, onProblem } = setup({ file: false });
    audio.play(planOf(sound()), 0, audio.now());
    await vi.waitFor(() => expect(onProblem).toHaveBeenCalledWith("f"));
    audio.stop();
  });
});

describe("changing how loud something is", () => {
  it("is no reason to start over", () => {
    expect(
      PlaybackAudio.sameButGains(planOf(sound({ gain: 1 })), planOf(sound({ gain: 0.5 }))),
    ).toBe(true);
    expect(PlaybackAudio.sameButGains(planOf(sound()), planOf(sound({ end: 4 })))).toBe(false);
    expect(PlaybackAudio.sameButGains(planOf(sound()), planOf(sound(), sound({ id: "t" })))).toBe(
      false,
    );
  });

  it("changes what is playing, on the spot", async () => {
    const { audio, settled, context, read } = setup();
    const nodes: { gain: { value: number } }[] = [];
    const make = context.createGain.bind(context);
    context.createGain = () => {
      const node = make();
      nodes.push(node);
      return node;
    };
    audio.play(planOf(sound()), 0, audio.now());
    await settled();
    audio.changeGains(planOf(sound({ gain: 0.25 })));
    expect(nodes[0]?.gain.value).toBe(0.25);
    expect(read).toHaveBeenCalledTimes(1);
    audio.stop();
  });

  it("holds for what starts later too", async () => {
    const { audio, gains, walk, context } = setup();
    audio.play(planOf(sound({ start: 0.5 })), 0, audio.now());
    audio.changeGains(planOf(sound({ start: 0.5, gain: 0.25 })));
    context.currentTime += 0.1;
    walk(100);
    await vi.waitFor(() => expect(gains).toEqual([0.25]));
    audio.stop();
  });
});

/** Chunks of a second with four samples each, which say where they are: 0, 1, 2, 3, then 4, 5… */
const counted = (...times: number[]) =>
  times.map((timestamp) => {
    const buffer = fakeBuffer(1, 4, 4);
    buffer.getChannelData(0).set([0, 1, 2, 3].map((index) => timestamp * 4 + index));
    return { buffer, timestamp, duration: 1 } as unknown as SoundChunk;
  });

const samplesOf = (buffer: unknown) => [
  ...(buffer as ReturnType<typeof fakeBuffer>).getChannelData(0),
];

function keeper(latency = 0) {
  const shifts: (number | undefined)[] = [];
  const input = { name: "keeper" };
  const keepPitch = vi.fn(async (): Promise<PitchKeeper> => ({
    input: input as unknown as AudioNode,
    latency,
    shift: (semitones) => shifts.push(semitones),
  }));
  return { keepPitch, shifts, input };
}

describe("playing faster and slower", () => {
  it("lines chunks up at twice the speed, each played twice as fast", async () => {
    const { keepPitch } = keeper();
    const { audio, started, settled } = setup({ keepPitch });
    audio.play(planOf(sound()), 0, audio.now(), 2);
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started.map(({ when }) => when)).toEqual([close(10), close(10.5), close(11)]);
    expect(started.map(({ rate }) => rate)).toEqual([2, 2, 2]);
    audio.stop();
  });

  it("goes through what keeps the pitch, shifted down an octave at twice the speed", async () => {
    const { keepPitch, shifts, input } = keeper();
    const { audio, context, settled } = setup({ keepPitch });
    const gains: { to: unknown }[] = [];
    const make = context.createGain.bind(context);
    context.createGain = () => {
      const gain = make();
      gains.push(gain);
      return gain;
    };
    audio.play(planOf(sound()), 0, audio.now(), 2);
    await settled();
    await vi.waitFor(() => expect(gains).toHaveLength(1));
    expect(gains[0]?.to).toBe(input);
    expect(shifts).toEqual([-12]);
    audio.stop();
    await vi.waitFor(() => expect(shifts).toEqual([-12, undefined]));
    // At normal speed sound goes straight to the speakers.
    audio.play(planOf(sound()), 0, audio.now());
    await vi.waitFor(() => expect(gains).toHaveLength(2));
    expect(gains[1]?.to).toBe(context.destination);
    expect(keepPitch).toHaveBeenCalledTimes(1);
    audio.stop();
  });

  it("shifts slow sound up: two octaves at a quarter of the speed", async () => {
    const { keepPitch, shifts } = keeper();
    const { audio, started, settled } = setup({ keepPitch });
    audio.play(planOf(sound()), 0, audio.now(), 0.25);
    await settled();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
    expect(shifts).toEqual([24]);
    expect(started[0]).toMatchObject({ when: close(10), rate: 0.25 });
    audio.stop();
  });

  it("starts earlier by what keeping the pitch holds back", async () => {
    const { keepPitch } = keeper(0.05);
    const { audio, started, settled } = setup({ keepPitch });
    audio.play(planOf(sound({ start: 0.5 })), 0, audio.now(), 2);
    await settled();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
    expect(started[0]?.when).toBeCloseTo(10.2);
    audio.stop();
  });

  it("still plays, at another pitch, when the pitch cannot be kept", async () => {
    const keepPitch = vi.fn(async (): Promise<PitchKeeper> => {
      throw new Error("no worklets here");
    });
    const { audio, started, settled } = setup({ keepPitch });
    audio.play(planOf(sound()), 0, audio.now(), 4);
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started[0]).toMatchObject({ when: close(10), rate: 4 });
    audio.stop();
  });
});

describe("playing backwards", () => {
  it("plays each second from its end, turned around, one after the other", async () => {
    const { keepPitch, shifts } = keeper();
    const { audio, started, read, settled } = setup({ keepPitch, list: counted(0, 1, 2) });
    audio.play(planOf(sound()), 3, audio.now(), -1);
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(read.mock.calls.map((call) => call.slice(1))).toEqual([
      [2, 3],
      [1, 2],
      [0, 1],
    ]);
    expect(started.map(({ when }) => when)).toEqual([close(10), close(11), close(12)]);
    expect(started.map(({ rate }) => rate)).toEqual([1, 1, 1]);
    expect(samplesOf(started[0]?.buffer)).toEqual([11, 10, 9, 8]);
    expect(samplesOf(started[2]?.buffer)).toEqual([3, 2, 1, 0]);
    // Backwards at normal speed the pitch is what it is.
    expect(shifts).toEqual([]);
    audio.stop();
  });

  it("starts in the middle of a clip, and plays no part twice", async () => {
    const { audio, started, settled } = setup({ list: counted(0, 1, 2) });
    audio.play(planOf(sound()), 2.5, audio.now(), -1);
    await settled();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started[0]).toMatchObject({ when: close(10), offset: close(0.5), duration: close(1) });
    expect(started[1]).toMatchObject({ when: close(11), offset: close(0.5), duration: close(1) });
    expect(started[2]).toMatchObject({ when: close(12), offset: close(0.5), duration: close(0.5) });
    audio.stop();
  });

  it("goes twice as fast, shifted down to its own pitch", async () => {
    const { keepPitch, shifts } = keeper();
    const { audio, started, settled } = setup({ keepPitch, list: counted(0, 1, 2) });
    audio.play(planOf(sound()), 3, audio.now(), -2);
    await settled();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
    expect(started[0]).toMatchObject({ when: close(10), rate: 2, offset: close(0) });
    expect(shifts).toEqual([-12]);
    audio.stop();
  });

  it("leaves alone what lies after where it starts", async () => {
    const { audio, read } = setup();
    audio.play(planOf(sound({ start: 5, end: 6 })), 4, audio.now(), -1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
    audio.stop();
  });
});

describe("pieces of sound", () => {
  const make = fakeBuffer as unknown as (c: number, l: number, r: number) => AudioBuffer;

  it("join into one, in their places", () => {
    const piece = joined(counted(1, 2), make);
    expect(piece?.timestamp).toBe(1);
    expect(samplesOf(piece?.buffer)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("turn around", () => {
    const [chunk] = counted(0);
    expect(samplesOf(backwardsOf(chunk?.buffer as AudioBuffer, make))).toEqual([3, 2, 1, 0]);
  });
});
