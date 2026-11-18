import type { MixPlan, MixSound } from "@animaquill/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MixerCore, type MixerMessage, type MixerReport } from "./engine/mixer-core.ts";
import { MIX_RATE } from "./engine/resample.ts";
import type { DecodedChunk } from "./engine/samples.ts";
import { chunksOf, inFile, planOf, sound, track } from "./engine/test-support.ts";
import { PlaybackAudio, type PitchKeeper, type PlaybackAudioOptions } from "./index.ts";
import type { MixerNode } from "./mixer.ts";

const QUANTUM = 128;
const sampleOf = (seconds: number) => Math.round(seconds * MIX_RATE);
const f32 = Math.fround;
/** Four seconds of a file, in chunks of a tenth of a second. */
const FILE = chunksOf({ frames: 4 * MIX_RATE, size: MIX_RATE / 10 });

function fakeContext(latency = 0) {
  return {
    state: "running" as AudioContextState,
    currentTime: 10,
    sampleRate: MIX_RATE,
    outputLatency: latency,
    baseLatency: 0,
    destination: { name: "speakers" },
    resume: async () => {},
    close: async () => {},
  };
}

/**
 * The mixer of the audio thread, run right here: `quanta` plays some, as the audio thread would,
 * and `heard` has what the engine gave, by sample of the timeline.
 */
function fakeMixer(context: ReturnType<typeof fakeContext>) {
  const handlers: ((report: MixerReport) => void)[] = [];
  const sent: MixerMessage[] = [];
  const heard = new Map<number, [number, number]>();
  const core = new MixerCore((report) => {
    if (report.kind === "captured") {
      for (let index = 0; index < report.left.length; index += 1) {
        const at = report.sample + index * report.rate;
        heard.set(at, [report.left[index] ?? 0, report.right[index] ?? 0]);
      }
    }
    for (const handler of handlers) handler(report);
  }, MIX_RATE);
  core.receive({ kind: "capture", on: true });
  const output = {
    to: undefined as unknown,
    connect(to: unknown) {
      output.to = to;
    },
    disconnect() {
      output.to = undefined;
    },
  };
  const node: MixerNode = {
    output: output as unknown as AudioNode,
    send(message) {
      sent.push(message);
      core.receive(message);
    },
    listen: (handler) => handlers.push(handler),
  };
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  /** Plays for `seconds` of the context, a quantum at a time, and lets its clock go on. */
  let frame = Math.round(context.currentTime * MIX_RATE);
  let until = frame;
  const quanta = (seconds: number) => {
    until += seconds * MIX_RATE;
    while (frame + QUANTUM <= until + 1e-6) {
      core.process(frame, left, right);
      frame += QUANTUM;
    }
    context.currentTime = until / MIX_RATE;
  };
  return { node, output, sent, heard, quanta };
}

function setup(
  options: {
    latency?: number;
    chunks?: readonly DecodedChunk[];
    file?: boolean;
    /** Says whether the file is here by now. */
    arrived?: () => boolean;
    /** Holds reading back until it resolves. */
    gate?: Promise<void>;
    keepPitch?: PlaybackAudioOptions["keepPitch"];
    mixer?: "fails";
  } = {},
) {
  const context = fakeContext(options.latency);
  const mixer = fakeMixer(context);
  let wall = 0;
  const read = vi.fn(async function* (_file: Blob, from: number, to: number) {
    await options.gate;
    for (const chunk of options.chunks ?? FILE) {
      const start = chunk.start / chunk.rate;
      const end = start + (chunk.channels[0]?.length ?? 0) / chunk.rate;
      if (end > from && start < to) {
        // Each its own copy: what goes to the mixer is handed over.
        yield { ...chunk, channels: chunk.channels.map((channel) => channel.slice()) };
      }
    }
  });
  const onProblem = vi.fn();
  const onNoMixer = vi.fn();
  const notes: [string, Readonly<Record<string, string | number>>][] = [];
  const audio = new PlaybackAudio({
    fileOf: async () => {
      if (options.arrived) return options.arrived() ? new Blob() : undefined;
      return options.file === false ? undefined : new Blob();
    },
    onProblem,
    onNoMixer,
    read,
    createContext: () => context as unknown as AudioContext,
    wallClock: () => wall,
    onNote: (kind, data) => notes.push([kind, data]),
    mixer: async () => {
      if (options.mixer === "fails") throw new Error("no worklets");
      return mixer.node;
    },
    ...(options.keepPitch && { keepPitch: options.keepPitch }),
  });
  /** A while of playing: the timers go off, and the mixer plays. */
  const pass = async (ms: number) => {
    for (let done = 0; done < ms; done += 10) {
      wall += 10;
      await vi.advanceTimersByTimeAsync(10);
      mixer.quanta(0.01);
    }
  };
  const walk = (ms: number) => {
    wall += ms;
  };
  return { context, ...mixer, audio, read, onProblem, onNoMixer, notes, pass, walk };
}

/** What the engine gives at a sample of the timeline for a sound with all of its file. */
const want = (played: MixSound, sample: number, gain = played.gain) =>
  f32(
    f32(inFile(Math.round((sample / MIX_RATE - played.start + played.offset) * MIX_RATE))) * gain,
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the clock", () => {
  it("goes by the wall until there is sound", () => {
    const { audio, walk } = setup();
    const start = audio.now();
    walk(250);
    expect(audio.now() - start).toBe(250);
  });

  it("goes by the sound once it runs, however the wall behaves", () => {
    const { audio, context, walk } = setup();
    audio.play(planOf([]), 0, audio.now());
    const start = audio.now();
    context.currentTime += 0.5;
    walk(9000);
    expect(audio.now() - start).toBeCloseTo(500);
  });

  it("carries on by the wall when sound gets suspended, without a jump", () => {
    const { audio, context, walk } = setup();
    audio.play(planOf([]), 0, audio.now());
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
    audio.play(planOf([sound()]), 0, audio.now());
    const start = audio.now();
    wall += 40;
    expect(audio.now() - start).toBe(40);
  });

  it("keeps going when the mixer cannot start, and says so", async () => {
    const { audio, notes, pass, onNoMixer } = setup({ mixer: "fails" });
    audio.play(planOf([sound()]), 0, audio.now());
    const start = audio.now();
    await pass(100);
    // The clock of the context, which goes by quanta.
    expect(audio.now() - start).toBeCloseTo(100, -1);
    expect(notes.map(([kind]) => kind)).toContain("audio.no-mixer");
    // People hear nothing, so they are told, once.
    expect(onNoMixer).toHaveBeenCalledTimes(1);
    audio.play(planOf([sound()]), 0, audio.now());
    await pass(50);
    expect(onNoMixer).toHaveBeenCalledTimes(1);
    audio.stop();
  });
});

describe("playing", () => {
  it("plays the file at its place, from its offset, with the gains of clip and track", async () => {
    const { audio, heard, pass, sent } = setup();
    const played = sound({ start: 0.5, end: 1.5, offset: 0.25, gain: 0.5 });
    audio.play(planOf([played], [track({ gain: 0.5 })]), 0, audio.now());
    await pass(1800);
    expect(sent[0]).toMatchObject({ kind: "play", frame: 480_000, sample: 0, rate: 1 });
    for (const at of [0, 23_999, 72_000, 80_000]) expect(heard.get(at)).toEqual([0, 0]);
    for (const at of [24_000, 40_000, 71_999]) {
      expect(heard.get(at)?.[0]).toBe(f32(want(played, at) * 0.5));
    }
    audio.stop();
  });

  it("reads the file from the place where the clip starts, up to where it ends", async () => {
    const { audio, read, pass } = setup();
    audio.play(planOf([sound({ start: 5, end: 6.5, offset: 1 })]), 5, audio.now());
    await pass(50);
    // A little around it, for resampling.
    expect(read.mock.calls[0]?.slice(1)).toEqual([0.99, 2.51]);
    audio.stop();
  });

  it("starts in the middle of a clip that is already going", async () => {
    const { audio, heard, pass, sent } = setup();
    const played = sound({ end: 3 });
    audio.play(planOf([played]), 1.25, audio.now());
    await pass(300);
    expect(sent[0]).toMatchObject({ kind: "play", sample: 60_000 });
    expect(heard.get(60_000)?.[0]).toBe(want(played, 60_000));
    expect(heard.has(59_999)).toBe(false);
    audio.stop();
  });

  it("leaves out what has passed when decoding is late, says so, and stays in step", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { audio, heard, pass, notes } = setup({ gate });
    const played = sound({ end: 3 });
    audio.play(planOf([played]), 0, audio.now());
    await pass(300);
    open();
    await pass(200);
    expect(heard.get(10_000)).toEqual([0, 0]);
    expect(heard.get(20_000)?.[0]).toBe(want(played, 20_000));
    const late = notes.find(([kind]) => kind === "audio.late");
    expect(late?.[1]).toMatchObject({ seconds: 0 });
    expect(Number(late?.[1].ms)).toBeGreaterThan(250);
    audio.stop();
  });

  it("says nothing is late for a clip that starts past the end of its file", async () => {
    const { audio, pass, notes } = setup();
    audio.play(planOf([sound({ end: 3, offset: 10 })]), 0, audio.now());
    await pass(300);
    // What was late is said once it is there again, or when playing stops.
    audio.stop();
    expect(notes.filter(([kind]) => kind === "audio.late")).toEqual([]);
  });

  it("plays sound earlier by what the device takes", async () => {
    const { audio, pass, sent } = setup({ latency: 0.1 });
    audio.play(planOf([sound()]), 0, audio.now());
    await pass(20);
    expect(sent[0]).toMatchObject({ kind: "play", frame: (10 - 0.1) * MIX_RATE, sample: 0 });
    audio.stop();
  });

  it("does not read a sound that is still far away, or that lies before the playhead", async () => {
    const { audio, read, pass } = setup();
    audio.play(planOf([sound({ start: 30, end: 31 }), sound({ id: "b", end: 2 })]), 5, audio.now());
    await pass(100);
    expect(read).not.toHaveBeenCalled();
    audio.stop();
  });

  it("goes quiet at once when stopped", async () => {
    const { audio, heard, pass, quanta } = setup();
    audio.play(planOf([sound({ end: 3 })]), 0, audio.now());
    await pass(200);
    audio.stop();
    heard.clear();
    quanta(0.1);
    expect([...heard.values()].every(([left]) => left === 0)).toBe(true);
  });

  it("says so when a file is gone, and the clock goes on", async () => {
    const { audio, onProblem, walk, pass } = setup({ file: false });
    audio.play(planOf([sound()]), 0, audio.now());
    await pass(20);
    expect(onProblem).toHaveBeenCalledWith("f");
    const start = audio.now();
    walk(10);
    expect(audio.now()).toBeGreaterThanOrEqual(start);
    audio.stop();
  });

  it("says nothing of a file gone on a track that is not heard", async () => {
    const { audio, onProblem, pass } = setup({ file: false });
    audio.play(planOf([sound()], [track({ muted: true })]), 0, audio.now());
    await pass(20);
    expect(onProblem).not.toHaveBeenCalled();
    audio.stop();
  });
});

describe("a sound that code is still making", () => {
  const made = (changes: Partial<MixSound> = {}) => sound({ made: true, end: 10, ...changes });
  const long = chunksOf({ frames: 10 * MIX_RATE, size: MIX_RATE / 10 });

  it("is no problem, and the clock goes on without it", async () => {
    const { audio, onProblem, read, pass, notes } = setup({ file: false });
    audio.play(planOf([made()]), 0, audio.now());
    const start = audio.now();
    await pass(300);
    expect(audio.now() - start).toBeCloseTo(300, -1);
    expect(onProblem).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(notes.filter(([kind]) => kind === "audio.late")).toEqual([]);
    audio.stop();
  });

  it("comes in when it is there, at the place the timeline has got to", async () => {
    let here = false;
    const { audio, read, heard, pass } = setup({ arrived: () => here, chunks: long });
    const played = made();
    audio.play(planOf([played]), 0, audio.now());
    await pass(2000);
    expect(read).not.toHaveBeenCalled();
    here = true;
    await pass(700);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toBeGreaterThan(2);
    expect(heard.get(sampleOf(2.6))?.[0]).toBe(want(played, sampleOf(2.6)));
    audio.stop();
  });

  it("does not bother the store for every turn of the timer", async () => {
    const looks = vi.fn(() => false);
    const { audio, pass } = setup({ arrived: looks });
    audio.play(planOf([made()]), 0, audio.now());
    await pass(1000);
    expect(looks.mock.calls.length).toBeLessThanOrEqual(4);
    audio.stop();
  });

  it("is left alone once its clip went by", async () => {
    const looks = vi.fn(() => false);
    const { audio, pass } = setup({ arrived: looks });
    audio.play(planOf([made({ end: 1 })]), 0, audio.now());
    await pass(1500);
    const before = looks.mock.calls.length;
    await pass(2000);
    expect(looks.mock.calls.length).toBe(before);
    audio.stop();
  });
});

describe("changing the mix while it plays", () => {
  it("is no reason to start over when only gains, muting and soloing change", () => {
    const base = planOf([sound()], [track()]);
    const onTheSpot = (plan: MixPlan) => PlaybackAudio.onTheSpot(base, plan);
    expect(onTheSpot(planOf([sound({ gain: 0.5 })], [track({ gain: 0.1 })]))).toBe(true);
    expect(onTheSpot(planOf([sound()], [track({ muted: true })]))).toBe(true);
    expect(onTheSpot(planOf([sound()], [track({ solo: true })]))).toBe(true);
    expect(onTheSpot(planOf([sound({ end: 4 })]))).toBe(false);
    expect(onTheSpot(planOf([sound(), sound({ id: "t" })]))).toBe(false);
    expect(onTheSpot(planOf([sound()], [track(), track({ id: "u" })]))).toBe(false);
  });

  it("is heard from the next quantum on, without reading anything again", async () => {
    const { audio, read, heard, pass } = setup();
    const played = sound({ end: 3 });
    audio.play(planOf([played]), 0, audio.now());
    await pass(200);
    audio.change(planOf([sound({ end: 3, gain: 0.25 })]));
    await pass(200);
    const at = 0.3 * MIX_RATE;
    expect(heard.get(at)?.[0]).toBe(want(played, at, 0.25));
    audio.change(planOf([sound({ end: 3, gain: 0.25 })], [track({ muted: true })]));
    await pass(100);
    expect(heard.get(sampleOf(0.45))).toEqual([0, 0]);
    audio.change(planOf([played]));
    await pass(100);
    // Unmuted, it is right there.
    expect(heard.get(sampleOf(0.55))?.[0]).toBe(want(played, sampleOf(0.55)));
    expect(read).toHaveBeenCalledTimes(1);
    audio.stop();
  });

  it("reads the sounds of muted tracks too, so that unmuting them is heard at once", async () => {
    const { audio, read, pass } = setup();
    audio.play(planOf([sound()], [track({ muted: true })]), 0, audio.now());
    await pass(50);
    expect(read).toHaveBeenCalledTimes(1);
    audio.stop();
  });
});

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
  it("plays the timeline at twice the speed, through what keeps the pitch an octave down", async () => {
    const pitch = keeper();
    const { audio, heard, pass, output, sent } = setup({ keepPitch: pitch.keepPitch });
    const played = sound({ end: 4 });
    audio.play(planOf([played]), 0, audio.now(), 2);
    await pass(400);
    expect(pitch.shifts).toEqual([-12]);
    expect(output.to).toBe(pitch.input);
    expect(sent[0]).toMatchObject({ kind: "play", rate: 2 });
    // Every other sample of the timeline, as it is.
    expect(heard.get(20_000)?.[0]).toBe(want(played, 20_000));
    expect(heard.get(20_002)?.[0]).toBe(want(played, 20_002));
    expect(heard.has(20_001)).toBe(false);
    audio.stop();
    expect(pitch.shifts).toEqual([-12]);
    await pass(10);
    expect(pitch.shifts).toEqual([-12, undefined]);
  });

  it("shifts slow sound up: two octaves at a quarter of the speed", async () => {
    const pitch = keeper();
    const { audio, pass } = setup({ keepPitch: pitch.keepPitch });
    audio.play(planOf([sound()]), 0, audio.now(), 0.25);
    await pass(20);
    expect(pitch.shifts).toEqual([24]);
    audio.stop();
  });

  it("starts earlier by what keeping the pitch holds back", async () => {
    const pitch = keeper(0.05);
    const { audio, pass, sent } = setup({ keepPitch: pitch.keepPitch, latency: 0.1 });
    audio.play(planOf([sound()]), 0, audio.now(), 2);
    await pass(20);
    expect(sent[0]).toMatchObject({ kind: "play", frame: Math.round((10 - 0.15) * MIX_RATE) });
    audio.stop();
  });

  it("still plays, at another pitch, when the pitch cannot be kept", async () => {
    const { audio, pass, output, context, sent } = setup({
      keepPitch: () => Promise.reject(new Error("no worklets")),
    });
    audio.play(planOf([sound()]), 0, audio.now(), 2);
    await pass(20);
    expect(output.to).toBe(context.destination);
    expect(sent[0]).toMatchObject({ kind: "play", rate: 2 });
    audio.stop();
  });

  it("plays at one speed straight to the speakers", async () => {
    const pitch = keeper();
    const { audio, pass, output, context } = setup({ keepPitch: pitch.keepPitch });
    audio.play(planOf([sound()]), 0, audio.now(), 2);
    await pass(20);
    audio.play(planOf([sound()]), 0, audio.now(), 1);
    await pass(20);
    expect(output.to).toBe(context.destination);
    audio.stop();
  });
});

describe("playing backwards", () => {
  it("reads a second at a time from the end on, and plays the timeline back", async () => {
    const pitch = keeper();
    const { audio, read, heard, pass, output, context } = setup({
      keepPitch: pitch.keepPitch,
    });
    const played = sound({ end: 4 });
    audio.play(planOf([played]), 2.5, audio.now(), -1);
    await pass(800);
    expect(read.mock.calls[0]?.slice(1)).toEqual([expect.closeTo(1.51), 2.51]);
    expect(read.mock.calls[1]?.slice(1)).toEqual([expect.closeTo(0.51), expect.closeTo(1.51)]);
    // At one speed, straight to the speakers.
    expect(pitch.shifts).toEqual([]);
    expect(output.to).toBe(context.destination);
    for (const at of [2.4, 2, 1.9]) {
      expect(heard.get(sampleOf(at))?.[0]).toBe(want(played, sampleOf(at)));
    }
    // Nothing after where it started.
    expect(heard.get(sampleOf(2.6))).toBeUndefined();
    audio.stop();
  });
});
