import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

export { computePeaks, PEAKS_PER_SECOND } from "./peaks.ts";
export { wavOf } from "./wav.ts";
export {
  MIX_CHANNELS,
  MIX_PIECE_SECONDS,
  MIX_SAMPLE_RATE,
  placementsIn,
  SoundFailed,
  SoundMixer,
  type MixContext,
  type MixerOptions,
  type Placement,
  type SoundSource,
} from "./mix.ts";

/** How far ahead sound gets decoded and scheduled. It bridges a busy moment, and costs memory. */
const LEAD_SECONDS = 1;
const POLL_MS = 100;
/** Less than this nobody hears. */
const NOTICEABLE_LATE_MS = 5;
/** How often to look whether a sound that code is still making is there yet. */
const LOOK_AGAIN_MS = 500;

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
  /** For people looking into a problem. */
  readonly onNote?: (kind: string, data: Readonly<Record<string, string | number>>) => void;
}

interface Run {
  plan: AudioPlan;
  /** The timeline was here when the clock showed `at`. */
  readonly seconds: number;
  readonly at: number;
  /** What the device adds. It stays the same during a run, or chunks would not fit together. */
  readonly latency: number;
  readonly started: Set<string>;
  /** When to look again for what was not there yet, by sound. */
  readonly waiting: Map<string, number>;
  readonly nodes: Set<AudioBufferSourceNode>;
  /** By sound. */
  readonly gains: Map<string, GainNode>;
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
  readonly #note: NonNullable<PlaybackAudioOptions["onNote"]>;
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
    this.#note = options.onNote ?? (() => {});
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
      waiting: new Map(),
      nodes: new Set(),
      gains: new Map(),
      timer: undefined,
      stopped: false,
    };
    this.#run = run;
    this.#note("audio.play", {
      seconds,
      sounds: plan.sounds.length,
      state: context.state,
      latencyMs: Math.round(run.latency * 1000),
    });
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
    for (const gain of run.gains.values()) gain.disconnect();
  }

  /** Whether a plan only changes how loud things are, which `changeGains` does on the spot. */
  static sameButGains(a: AudioPlan, b: AudioPlan): boolean {
    if (a === b) return true;
    const plain = ({ sounds }: AudioPlan) => sounds.map((sound) => ({ ...sound, gain: 0 }));
    return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
  }

  /** Starting over for this would be a gap in the sound with every step of a slider. */
  changeGains({ sounds }: AudioPlan): void {
    const run = this.#run;
    if (!run) return;
    for (const { id, gain } of sounds) {
      const node = run.gains.get(id);
      if (node) node.gain.value = gain;
    }
    run.plan = { sounds };
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
    const now = this.#wallClock();
    for (const sound of run.plan.sounds) {
      const ahead = sound.start - position;
      if (run.started.has(sound.id) || sound.end <= run.seconds || ahead > LEAD_SECONDS) continue;
      const waiting = run.waiting.get(sound.id);
      if (waiting !== undefined && (now < waiting || sound.end <= position)) continue;
      run.started.add(sound.id);
      this.#feed(run, context, sound, waiting === undefined ? run.seconds : position).catch(
        (error: unknown) => {
          console.warn("A sound could not be played", error);
          if (!run.stopped) this.#onProblem(sound.file);
        },
      );
    }
  }

  /** Plays a sound from a place on the timeline on, when that is in it. */
  async #feed(run: Run, context: AudioContext, sound: SoundLayer, since: number): Promise<void> {
    const file = await this.#fileOf(sound.file);
    if (run.stopped) return;
    if (!file) {
      // Time goes on without it. When code is done with it, what is left of it comes in on time.
      if (sound.made) {
        run.started.delete(sound.id);
        run.waiting.set(sound.id, this.#wallClock() + LOOK_AGAIN_MS);
      } else this.#onProblem(sound.file);
      return;
    }
    const gain = context.createGain();
    gain.gain.value = run.plan.sounds.find(({ id }) => id === sound.id)?.gain ?? sound.gain;
    gain.connect(context.destination);
    run.gains.set(sound.id, gain);

    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    const from = toFile(Math.max(sound.start, since));
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
      const lateMs = Math.round((context.currentTime - when) * 1000);
      if (lateMs >= NOTICEABLE_LATE_MS) this.#note("audio.late", { ms: lateMs, seconds: at });
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
