import type { AudioPlan, SoundLayer } from "@animaquill/core";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

import { faded } from "./fades.ts";
import { semitonesFor, type PitchKeeper } from "./pitch.ts";

export { faded, sampleTime, type MakeBuffer } from "./fades.ts";
export { createPitchKeeper, semitonesFor, type PitchKeeper } from "./pitch.ts";
export { computePeaks, PEAKS_PER_SECOND } from "./peaks.ts";
export { wavOf } from "./wav.ts";
export {
  MOST_PLACES,
  SoundMeter,
  type ClipPlace,
  type Envelope,
  type Measured,
  type MeterOptions,
  type Stretch,
} from "./meter.ts";
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
/** Backwards, sound is read in pieces this long from the end on, at least, and longer when faster. */
const BACKWARDS_SECONDS = 1;

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
  /**
   * Makes what keeps the pitch of sound played faster, slower or backwards, see `PitchKeeper`. Without
   * it, or when it fails, such sound plays higher or lower: never silent.
   */
  readonly keepPitch?: (context: AudioContext) => Promise<PitchKeeper>;
}

interface Run {
  plan: AudioPlan;
  /** The timeline was here when the clock showed `at`. */
  readonly seconds: number;
  readonly at: number;
  /** Timeline seconds per real second, negative backwards. */
  readonly rate: number;
  /**
   * What the device adds, and what keeps the pitch. It stays the same during a run, or chunks would
   * not fit together.
   */
  latency: number;
  /** Where sound goes: the speakers, or what keeps its pitch first, once that is there. */
  output: Promise<AudioNode>;
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
  readonly #keepPitch: PlaybackAudioOptions["keepPitch"];
  #context: AudioContext | undefined;
  #keeper: Promise<PitchKeeper | undefined> | undefined;
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
    this.#keepPitch = options.keepPitch;
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

  /**
   * Plays from a place on the timeline, which the clock passed at `at`, at a rate: timeline seconds
   * per real second, negative backwards.
   */
  play(plan: AudioPlan, seconds: number, at: number, rate = 1): void {
    this.stop();
    const context = this.#ensureContext();
    if (!context || rate === 0 || !Number.isFinite(rate)) return;
    void context.resume().catch((error: unknown) => console.warn("No sound", error));
    const latency = context.outputLatency || context.baseLatency || 0;
    const speed = Math.abs(rate);
    const run: Run = {
      plan,
      seconds,
      at,
      rate,
      latency,
      output: Promise.resolve(context.destination),
      started: new Set(),
      waiting: new Map(),
      nodes: new Set(),
      gains: new Map(),
      timer: undefined,
      stopped: false,
    };
    if (speed !== 1) {
      const keeper = this.#keeper ?? Promise.resolve(undefined);
      this.#keeper = keeper;
      run.output = keeper.then((found) => {
        if (!found || run.stopped) return context.destination;
        found.shift(semitonesFor(speed));
        run.latency = latency + found.latency;
        return found.input;
      });
    }
    this.#run = run;
    this.#note("audio.play", {
      seconds,
      rate,
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
    if (Math.abs(run.rate) !== 1) void this.#keeper?.then((keeper) => keeper?.shift(undefined));
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
      if (!this.#context) {
        const context = this.#createContext();
        this.#context = context;
        // Made right away, so that it is there by the time people play at another speed.
        this.#keeper = this.#keepPitch?.(context).catch((error: unknown) => {
          console.warn("Sound at other speeds keeps no pitch", error);
          this.#note("audio.no-pitch", { error: String(error) });
          return undefined;
        });
      }
    } catch (error) {
      console.warn("No sound", error);
    }
    return this.#context;
  }

  #position(run: Run): number {
    return run.seconds + ((this.now() - run.at) / 1000) * run.rate;
  }

  #startDue(run: Run, context: AudioContext): void {
    const position = this.#position(run);
    const now = this.#wallClock();
    const backwards = run.rate < 0;
    // Faster, the same time ahead is more of the timeline.
    const lead = LEAD_SECONDS * Math.max(Math.abs(run.rate), 1);
    for (const sound of run.plan.sounds) {
      const passed = backwards ? sound.start >= run.seconds : sound.end <= run.seconds;
      const ahead = backwards ? position - sound.end : sound.start - position;
      if (run.started.has(sound.id) || passed || ahead > lead) continue;
      const waiting = run.waiting.get(sound.id);
      const gone = backwards ? sound.start >= position : sound.end <= position;
      if (waiting !== undefined && (now < waiting || gone)) continue;
      run.started.add(sound.id);
      this.#feed(run, context, sound, waiting === undefined ? run.seconds : position).catch(
        (error: unknown) => {
          console.warn("A sound could not be played", error);
          if (!run.stopped) this.#onProblem(sound.file);
        },
      );
    }
  }

  /** Plays a sound from a place on the timeline on, or back from it, when that is in it. */
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
    const output = await run.output;
    if (run.stopped) return;
    const gain = context.createGain();
    gain.gain.value = run.plan.sounds.find(({ id }) => id === sound.id)?.gain ?? sound.gain;
    gain.connect(output);
    run.gains.set(sound.id, gain);
    if (run.rate < 0) await this.#feedBackwards(run, context, gain, sound, file, since);
    else await this.#feedForwards(run, context, gain, sound, file, since);
  }

  async #feedForwards(
    run: Run,
    context: AudioContext,
    gain: GainNode,
    sound: SoundLayer,
    file: Blob,
    since: number,
  ): Promise<void> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    // Before the file begins there is nothing to read: it is silent there.
    const from = Math.max(toFile(Math.max(sound.start, since)), 0);
    for await (const chunk of this.#read(file, from, toFile(sound.end))) {
      if (!(await this.#whileRunning(run, context))) return;
      const at = sound.start + chunk.timestamp - sound.offset;
      const when = this.#schedule(run, context, gain, sound, chunk, at);
      if (!(await this.#untilDue(run, context, when))) return;
    }
  }

  /**
   * Backwards, a piece at a time from the end on: read forwards as files can be, with their
   * transitions worked in, then turned around.
   */
  async #feedBackwards(
    run: Run,
    context: AudioContext,
    gain: GainNode,
    sound: SoundLayer,
    file: Blob,
    since: number,
  ): Promise<void> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    const toTimeline = (seconds: number) => sound.start + seconds - sound.offset;
    const length = BACKWARDS_SECONDS * Math.max(Math.abs(run.rate), 1);
    const bottom = Math.max(toFile(sound.start), 0);
    let top = toFile(Math.min(sound.end, since));
    while (top > bottom) {
      const from = Math.max(top - length, bottom);
      const chunks: SoundChunk[] = [];
      for await (const chunk of this.#read(file, from, top)) chunks.push(chunk);
      if (!(await this.#whileRunning(run, context))) return;
      const piece = joined(chunks, (...size) => context.createBuffer(...size));
      if (piece) {
        const fadedPiece = faded(sound, piece, (...size) => context.createBuffer(...size));
        const at = sound.start + piece.timestamp - sound.offset;
        const span = { from: toTimeline(from), top: toTimeline(top) };
        const when = this.#scheduleBackwards(run, context, gain, sound, fadedPiece, at, span);
        if (!(await this.#untilDue(run, context, when))) return;
      }
      top = from;
    }
  }

  /** A suspended context does not move, so nothing it would schedule can be right. */
  async #whileRunning(run: Run, context: AudioContext): Promise<boolean> {
    while (context.state !== "running" && !run.stopped) await sleep(POLL_MS / 2);
    return !run.stopped;
  }

  /** Waits until what was scheduled for `when` is near, so that only a little is decoded ahead. */
  async #untilDue(run: Run, context: AudioContext, when: number): Promise<boolean> {
    while (when - context.currentTime > LEAD_SECONDS && !run.stopped) await sleep(POLL_MS);
    return !run.stopped;
  }

  /** The moment on the context's clock at which a moment on the timeline should leave for the ears. */
  #contextTime(run: Run, context: AudioContext, seconds: number): number {
    const clockTarget = run.at + ((seconds - run.seconds) / run.rate) * 1000;
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
      begin += (context.currentTime - when) * run.rate;
      when = context.currentTime;
    }
    const end = Math.min(at + chunk.duration, sound.end);
    if (end <= begin) return when;
    // Its transitions, sample by sample as the mix of an export has them.
    const { buffer } = faded(sound, chunk, (...size) => context.createBuffer(...size));
    this.#start(run, context, gain, buffer, when, begin - at, end - begin);
    return when;
  }

  /**
   * A piece of a sound that plays backwards: what it has from `span.top` down to `span.from` on the
   * timeline, turned around. The piece starts at `at`, and can reach past both.
   */
  #scheduleBackwards(
    run: Run,
    context: AudioContext,
    gain: GainNode,
    sound: SoundLayer,
    piece: SoundChunk,
    at: number,
    span: { readonly from: number; readonly top: number },
  ): number {
    let begin = Math.min(span.top, at + piece.duration, sound.end, run.seconds);
    let when = this.#contextTime(run, context, begin);
    if (when < context.currentTime) {
      const lateMs = Math.round((context.currentTime - when) * 1000);
      if (lateMs >= NOTICEABLE_LATE_MS) this.#note("audio.late", { ms: lateMs, seconds: begin });
      begin += (context.currentTime - when) * run.rate;
      when = context.currentTime;
    }
    const end = Math.max(at, sound.start, span.from);
    if (begin <= end) return when;
    const turned = backwardsOf(piece.buffer, (...size) => context.createBuffer(...size));
    this.#start(run, context, gain, turned, when, at + piece.duration - begin, begin - end);
    return when;
  }

  /** `offset` and `duration` are seconds of the buffer, which plays at the speed of the run. */
  #start(
    run: Run,
    context: AudioContext,
    gain: GainNode,
    buffer: AudioBuffer,
    when: number,
    offset: number,
    duration: number,
  ): void {
    const node = context.createBufferSource();
    node.buffer = buffer;
    const speed = Math.abs(run.rate);
    if (speed !== 1) node.playbackRate.value = speed;
    node.connect(gain);
    node.addEventListener("ended", () => run.nodes.delete(node));
    run.nodes.add(node);
    node.start(when, offset, duration);
  }
}

/** Chunks that follow each other as one, from the first on: what is missing between them is silent. */
export function joined(
  chunks: readonly SoundChunk[],
  make: (channels: number, length: number, sampleRate: number) => AudioBuffer,
): SoundChunk | undefined {
  const [first] = chunks;
  const last = chunks.at(-1);
  if (!first || !last) return undefined;
  if (chunks.length === 1) return first;
  const { sampleRate, numberOfChannels } = first.buffer;
  const timestamp = first.timestamp;
  const length = Math.round((last.timestamp + last.duration - timestamp) * sampleRate);
  const out = make(numberOfChannels, Math.max(length, 1), sampleRate);
  for (const chunk of chunks) {
    const start = Math.round((chunk.timestamp - timestamp) * sampleRate);
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const from = chunk.buffer.getChannelData(
        Math.min(channel, chunk.buffer.numberOfChannels - 1),
      );
      const room = Math.max(Math.min(from.length, out.length - start), 0);
      out.getChannelData(channel).set(from.subarray(0, room), start);
    }
  }
  return { buffer: out, timestamp, duration: out.length / sampleRate };
}

/** The samples of a buffer the other way around. */
export function backwardsOf(
  buffer: AudioBuffer,
  make: (channels: number, length: number, sampleRate: number) => AudioBuffer,
): AudioBuffer {
  const { numberOfChannels, length, sampleRate } = buffer;
  const out = make(numberOfChannels, length, sampleRate);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const from = buffer.getChannelData(channel);
    const to = out.getChannelData(channel);
    for (let index = 0; index < length; index += 1) to[index] = from[length - 1 - index] ?? 0;
  }
  return out;
}
