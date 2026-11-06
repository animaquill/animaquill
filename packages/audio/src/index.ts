import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

export { computePeaks, PEAKS_PER_SECOND } from "./peaks.ts";

/** How far ahead sound gets decoded and scheduled. It bridges a busy moment, and costs memory. */
const LEAD_SECONDS = 1;
const POLL_MS = 100;

export interface SoundChunk {
  readonly buffer: AudioBuffer;
  /** Seconds in the file. */
  readonly timestamp: number;
  readonly duration: number;
}

export type SoundReader = (file: Blob, from: number, to: number) => AsyncIterable<SoundChunk>;

/** Decodes bit by bit, because an hour of decoded sound would not fit in memory. */
export async function* readSound(file: Blob, from: number, to: number): AsyncGenerator<SoundChunk> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error("Cannot decode this sound");
    yield* new AudioBufferSink(track).buffers(from, to);
  } finally {
    input.dispose();
  }
}

export interface PlaybackAudioOptions {
  /** Resolves to undefined when the file is not here. */
  readonly fileOf: (file: string) => Promise<Blob | undefined>;
  readonly onProblem: (file: string) => void;
  readonly read?: SoundReader;
  readonly createContext?: () => AudioContext;
  readonly wallClock?: () => number;
}

interface Run {
  readonly plan: AudioPlan;
  /** The timeline was here when the clock showed `at`. */
  readonly seconds: number;
  readonly at: number;
  /** What the device adds. It stays the same during a run, or chunks would not fit together. */
  readonly latency: number;
  readonly started: Set<string>;
  readonly nodes: Set<AudioBufferSourceNode>;
  readonly gains: Set<GainNode>;
  timer: ReturnType<typeof setInterval> | undefined;
  stopped: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays what a plan says, and is the clock of playback: picture follows sound, because a stutter in
 * sound is what people notice. Without sound the clock goes on by itself, so that a blocked or
 * missing audio device never stops the playhead.
 */
export class PlaybackAudio {
  readonly #fileOf: (file: string) => Promise<Blob | undefined>;
  readonly #onProblem: (file: string) => void;
  readonly #read: SoundReader;
  readonly #createContext: () => AudioContext;
  readonly #wallClock: () => number;
  #context: AudioContext | undefined;
  #run: Run | undefined;
  #time = 0;
  #lastWall: number;
  #lastContext: number | undefined;

  constructor(options: PlaybackAudioOptions) {
    this.#fileOf = options.fileOf;
    this.#onProblem = options.onProblem;
    this.#read = options.read ?? readSound;
    this.#createContext = options.createContext ?? (() => new AudioContext());
    this.#wallClock = options.wallClock ?? (() => performance.now());
    this.#lastWall = this.#wallClock();
  }

  /** Milliseconds that only go forward, whichever of the two clocks is running. */
  now(): number {
    const wall = this.#wallClock();
    const context = this.#context;
    const audio = context?.state === "running" ? context.currentTime : undefined;
    const passed =
      audio !== undefined && this.#lastContext !== undefined
        ? (audio - this.#lastContext) * 1000
        : wall - this.#lastWall;
    this.#time += Math.max(passed, 0);
    this.#lastWall = wall;
    this.#lastContext = audio;
    return this.#time;
  }

  /** Plays from a place on the timeline, which the clock passed at `at`. */
  play(plan: AudioPlan, seconds: number, at: number): void {
    this.stop();
    const context = this.#ensureContext();
    if (!context) return;
    void context.resume().catch((error: unknown) => console.warn("No sound", error));
    const run: Run = {
      plan,
      seconds,
      at,
      latency: context.outputLatency || context.baseLatency || 0,
      started: new Set(),
      nodes: new Set(),
      gains: new Set(),
      timer: undefined,
      stopped: false,
    };
    this.#run = run;
    this.#startDue(run, context);
    run.timer = setInterval(() => this.#startDue(run, context), POLL_MS);
  }

  stop(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    run.stopped = true;
    clearInterval(run.timer);
    for (const node of run.nodes) node.stop();
    for (const gain of run.gains) gain.disconnect();
  }

  dispose(): void {
    this.stop();
    void this.#context?.close().catch(() => {});
    this.#context = undefined;
  }

  #ensureContext(): AudioContext | undefined {
    try {
      this.#context ??= this.#createContext();
    } catch (error) {
      console.warn("No sound", error);
    }
    return this.#context;
  }

  #position(run: Run): number {
    return run.seconds + (this.now() - run.at) / 1000;
  }

  #startDue(run: Run, context: AudioContext): void {
    const position = this.#position(run);
    for (const sound of run.plan.sounds) {
      const ahead = sound.start - position;
      if (run.started.has(sound.id) || sound.end <= run.seconds || ahead > LEAD_SECONDS) continue;
      run.started.add(sound.id);
      this.#feed(run, context, sound).catch((error: unknown) => {
        console.warn("A sound could not be played", error);
        if (!run.stopped) this.#onProblem(sound.file);
      });
    }
  }

  async #feed(run: Run, context: AudioContext, sound: SoundLayer): Promise<void> {
    const file = await this.#fileOf(sound.file);
    if (run.stopped) return;
    if (!file) {
      this.#onProblem(sound.file);
      return;
    }
    const gain = context.createGain();
    gain.gain.value = sound.gain;
    gain.connect(context.destination);
    run.gains.add(gain);

    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    const from = toFile(Math.max(sound.start, run.seconds));
    for await (const chunk of this.#read(file, from, toFile(sound.end))) {
      // A suspended context does not move, so nothing it would schedule can be right.
      while (context.state !== "running" && !run.stopped) await sleep(POLL_MS / 2);
      if (run.stopped) return;
      const at = sound.start + chunk.timestamp - sound.offset;
      const when = this.#schedule(run, context, gain, sound, chunk, at);
      while (when - context.currentTime > LEAD_SECONDS && !run.stopped) await sleep(POLL_MS);
      if (run.stopped) return;
    }
  }

  /** The moment on the context's clock at which a moment on the timeline should leave for the ears. */
  #contextTime(run: Run, context: AudioContext, seconds: number): number {
    const clockTarget = run.at + (seconds - run.seconds) * 1000;
    return context.currentTime + (clockTarget - this.now()) / 1000 - run.latency;
  }

  #schedule(
    run: Run,
    context: AudioContext,
    gain: GainNode,
    sound: SoundLayer,
    chunk: SoundChunk,
    at: number,
  ): number {
    let begin = Math.max(at, sound.start, run.seconds);
    let when = this.#contextTime(run, context, begin);
    // Sound that arrives late stays in step by leaving out what has passed.
    if (when < context.currentTime) {
      begin += context.currentTime - when;
      when = context.currentTime;
    }
    const end = Math.min(at + chunk.duration, sound.end);
    if (end <= begin) return when;
    const node = context.createBufferSource();
    node.buffer = chunk.buffer;
    node.connect(gain);
    node.addEventListener("ended", () => run.nodes.delete(node));
    run.nodes.add(node);
    node.start(when, begin - at, end - begin);
    return when;
  }
}
