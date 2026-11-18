import { audibleTracks, type MixPlan, type MixSound } from "@animaquill/core";
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

import { readSamples, type SampleReader } from "./engine/decode.ts";
import type { DecodedChunk } from "./engine/samples.ts";
import type { Levels } from "./engine/levels.ts";
import { prerollSeconds } from "./engine/engine.ts";
import { MIX_RATE } from "./engine/resample.ts";
import type { MixerNode } from "./mixer.ts";
import { semitonesFor, type PitchKeeper } from "./pitch.ts";

export {
  MixEngine,
  BLOCK,
  mixMemory,
  prerollSeconds,
  type OnMissing,
  type SamplesOf,
} from "./engine/engine.ts";
export { readSamples, type SampleReader } from "./engine/decode.ts";
export { MixerCore, type MixerMessage, type MixerReport } from "./engine/mixer-core.ts";
export { LEVELS_PER_SECOND, MasterLevels, type Levels } from "./engine/levels.ts";
export { MIX_RATE } from "./engine/resample.ts";
export { cookbook, responseDb, type BandKind, type Biquad } from "./engine/effects/eq.ts";
export { staticCurve } from "./engine/effects/compressor.ts";
export { SampleStore, type DecodedChunk } from "./engine/samples.ts";
export { createMixer, type MixerNode } from "./mixer.ts";
export {
  portMixer,
  serveMixer,
  type FromMixer,
  type MixPort,
  type PortMixer,
  type ToMixer,
} from "./mix-port.ts";
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
  SoundFailed,
  SoundMixer,
  type MixedPiece,
  type MixerOptions,
  type SoundSource,
} from "./mix.ts";

/** How far ahead sound gets decoded and sent to the mixer. It bridges a busy moment, and costs memory. */
const LEAD_SECONDS = 1;
const POLL_MS = 100;
/** Less than this nobody hears. */
const NOTICEABLE_LATE_MS = 5;
/** How often to look whether a sound that code is still making is there yet. */
const LOOK_AGAIN_MS = 500;
/** Backwards, sound is read in pieces this long from the end on, at least, and longer when faster. */
const BACKWARDS_SECONDS = 1;
/** Read around what plays, for the resampling of sound at another rate, see `mix.ts`. */
const MARGIN_SECONDS = 0.01;

/** A piece of a file decoded for the waveform: see `computePeaks`. */
export interface SoundChunk {
  readonly buffer: AudioBuffer;
  /** Seconds in the file. */
  readonly timestamp: number;
  readonly duration: number;
}

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

/** The context of the preview: at the rate of the mix, which the browser takes to the device's. */
function mixContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: MIX_RATE });
  } catch {
    // A browser that cannot: the mixer goes from the rate of the mix to the context's itself.
    return new AudioContext();
  }
}

export interface PlaybackAudioOptions {
  /** Resolves to undefined when the file is not here. */
  readonly fileOf: (file: string) => Promise<Blob | undefined>;
  readonly onProblem: (file: string) => void;
  /**
   * The mixer could not start in this context, see `mixer`: nothing will be heard, which people
   * should know. Once for each context.
   */
  readonly onNoMixer?: () => void;
  readonly read?: SampleReader;
  readonly createContext?: () => AudioContext;
  readonly wallClock?: () => number;
  /** For people looking into a problem. */
  readonly onNote?: (kind: string, data: Readonly<Record<string, string | number>>) => void;
  /**
   * Makes the mixer in the audio thread of a context, see `createMixer`. Without it, or when it
   * fails, nothing is heard; the clock goes on all the same.
   */
  readonly mixer?: (context: AudioContext) => Promise<MixerNode>;
  /**
   * Makes what keeps the pitch of sound played faster, slower or backwards, see `PitchKeeper`. Without
   * it, or when it fails, such sound plays higher or lower: never silent.
   */
  readonly keepPitch?: (context: AudioContext) => Promise<PitchKeeper>;
}

interface Run {
  /** Tells what the mixer gets for this run from what it got for others. */
  readonly id: number;
  plan: MixPlan;
  /** The timeline was here when the clock showed `at`. */
  readonly seconds: number;
  readonly at: number;
  /** Timeline seconds per real second, negative backwards. */
  readonly rate: number;
  /**
   * Seconds before `seconds` that sounds are sent from, for what effects remember (see
   * `MixEngine`): none backwards or faster, where effects are left out.
   */
  readonly preroll: number;
  /** What the device adds, and what keeps the pitch. It stays the same during a run. */
  latency: number;
  /** The mixer once it plays this run: sound goes to it from then on. */
  ready: Promise<MixerNode | undefined>;
  readonly started: Set<string>;
  /** When to look again for what was not there yet, by sound. */
  readonly waiting: Map<string, number>;
  timer: ReturnType<typeof setInterval> | undefined;
  stopped: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The sounds of a plan as playing has them, apart from what the mixer changes on the spot. */
const placesOf = ({ sounds, tracks }: MixPlan) =>
  JSON.stringify({
    sounds: sounds.map(
      ({ gain: _gain, volume: _volume, pan: _pan, effects: _effects, ...place }) => place,
    ),
    tracks: tracks.map(({ id }) => id),
  });

let runs = 0;

/**
 * Plays what a plan says, and is the clock of playback: picture follows sound, because a stutter in
 * sound is what people notice. Without sound the clock goes on by itself, so that a blocked or
 * missing audio device never stops the playhead.
 *
 * The mix itself is the mix engine's in the audio thread (`MixerCore`), the same as the export's:
 * this decodes the sounds a little ahead and hands their samples over, and tells the mixer where
 * the timeline is when.
 */
export class PlaybackAudio {
  readonly #fileOf: (file: string) => Promise<Blob | undefined>;
  readonly #onProblem: (file: string) => void;
  readonly #onNoMixer: () => void;
  readonly #read: SampleReader;
  readonly #createContext: () => AudioContext;
  readonly #wallClock: () => number;
  readonly #note: NonNullable<PlaybackAudioOptions["onNote"]>;
  readonly #makeMixer: PlaybackAudioOptions["mixer"];
  readonly #keepPitch: PlaybackAudioOptions["keepPitch"];
  #context: AudioContext | undefined;
  #mixer: Promise<MixerNode | undefined> = Promise.resolve(undefined);
  /** The mixer once it is there, to stop it right away. */
  #mixerNow: MixerNode | undefined;
  #keeper: Promise<PitchKeeper | undefined> | undefined;
  #run: Run | undefined;
  #time = 0;
  #lastWall: number;
  #lastContext: number | undefined;
  readonly #levelListeners = new Set<(levels: Levels | undefined) => void>();

  constructor(options: PlaybackAudioOptions) {
    this.#fileOf = options.fileOf;
    this.#onProblem = options.onProblem;
    this.#onNoMixer = options.onNoMixer ?? (() => {});
    this.#read = options.read ?? readSamples;
    this.#createContext = options.createContext ?? mixContext;
    this.#wallClock = options.wallClock ?? (() => performance.now());
    this.#lastWall = this.#wallClock();
    this.#note = options.onNote ?? (() => {});
    this.#makeMixer = options.mixer;
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
  play(plan: MixPlan, seconds: number, at: number, rate = 1): void {
    this.stop();
    const context = this.#ensureContext();
    if (!context || rate === 0 || !Number.isFinite(rate)) return;
    void context.resume().catch((error: unknown) => console.warn("No sound", error));
    const latency = context.outputLatency || context.baseLatency || 0;
    runs += 1;
    const run: Run = {
      id: runs,
      plan,
      seconds,
      at,
      rate,
      preroll: rate > 0 && rate <= 1 ? prerollSeconds(plan) : 0,
      latency,
      ready: Promise.resolve(undefined),
      started: new Set(),
      waiting: new Map(),
      timer: undefined,
      stopped: false,
    };
    run.ready = this.#start(run, context);
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

  /**
   * Hears what the meters show while playing, `LEVELS_PER_SECOND` times a second, and undefined
   * once it stops. Returns how to stop hearing it.
   */
  listenLevels(listener: (levels: Levels | undefined) => void): () => void {
    this.#levelListeners.add(listener);
    return () => this.#levelListeners.delete(listener);
  }

  #tellLevels(levels: Levels | undefined): void {
    for (const listener of this.#levelListeners) listener(levels);
  }

  stop(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    this.#tellLevels(undefined);
    run.stopped = true;
    clearInterval(run.timer);
    this.#mixerNow?.send({ kind: "stop" });
    if (Math.abs(run.rate) !== 1) void this.#keeper?.then((keeper) => keeper?.shift(undefined));
  }

  /**
   * Whether a plan differs from another only in what the mixer changes on the spot, see `change`:
   * how loud things are and where they sit (volume and pan, with their keys), which tracks are
   * muted or soloed, and the effects and the master (effects that stay keep what they remember).
   */
  static onTheSpot(a: MixPlan, b: MixPlan): boolean {
    return a === b || placesOf(a) === placesOf(b);
  }

  /**
   * Starting over for this would be a gap in the sound with every step of a slider: the mixer takes
   * it from its next quantum on.
   */
  change(plan: MixPlan): void {
    const run = this.#run;
    if (!run) return;
    run.plan = plan;
    void run.ready.then((mixer) => {
      if (!run.stopped && run.plan === plan) mixer?.send({ kind: "plan", plan });
    });
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
        this.#mixer = (this.#makeMixer?.(context) ?? Promise.resolve(undefined)).then(
          (mixer) => {
            mixer?.listen((report) => {
              if (report.kind === "levels") {
                // What was on its way when it stopped is not what plays.
                if (this.#run) this.#tellLevels(report);
                return;
              }
              if (report.kind !== "late" || report.ms < NOTICEABLE_LATE_MS) return;
              this.#note("audio.late", { ms: report.ms, seconds: report.seconds });
            });
            this.#mixerNow = mixer;
            return mixer;
          },
          (error: unknown) => {
            console.warn("No sound", error);
            this.#note("audio.no-mixer", { error: String(error) });
            this.#onNoMixer();
            return undefined;
          },
        );
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

  /**
   * Has the mixer play a run, through what keeps the pitch at another speed: from the moment of the
   * clock that `at` is, less what the device and that take.
   */
  async #start(run: Run, context: AudioContext): Promise<MixerNode | undefined> {
    const mixer = await this.#mixer;
    if (!mixer || run.stopped) return undefined;
    let output: AudioNode = context.destination;
    const speed = Math.abs(run.rate);
    if (speed !== 1) {
      const keeper = await (this.#keeper ?? Promise.resolve(undefined));
      if (run.stopped) return undefined;
      if (keeper) {
        keeper.shift(semitonesFor(speed));
        run.latency += keeper.latency;
        output = keeper.input;
      }
    }
    mixer.output.disconnect();
    mixer.output.connect(output);
    if (!(await this.#whileRunning(run, context))) return undefined;
    const contextTime = context.currentTime + (run.at - this.now()) / 1000 - run.latency;
    mixer.send({
      kind: "play",
      run: run.id,
      plan: run.plan,
      frame: Math.round(contextTime * context.sampleRate),
      sample: Math.round(run.seconds * MIX_RATE),
      rate: run.rate,
    });
    return mixer;
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
    const since = run.seconds - run.preroll;
    for (const sound of run.plan.sounds) {
      const passed = backwards ? sound.start >= run.seconds : sound.end <= since;
      const ahead = backwards ? position - sound.end : sound.start - position;
      if (run.started.has(sound.id) || passed || ahead > lead) continue;
      const waiting = run.waiting.get(sound.id);
      const gone = backwards ? sound.start >= position : sound.end <= position;
      if (waiting !== undefined && (now < waiting || gone)) continue;
      run.started.add(sound.id);
      this.#feed(run, context, sound, waiting === undefined ? since : position).catch(
        (error: unknown) => {
          console.warn("A sound could not be played", error);
          if (!run.stopped) this.#problem(run, sound);
        },
      );
    }
  }

  /** A file that is not there or cannot be read: a problem only where it would be heard. */
  #problem(run: Run, sound: MixSound): void {
    if (audibleTracks(run.plan.tracks).has(sound.track)) this.#onProblem(sound.file);
  }

  /**
   * Sends the samples of a sound from a place on the timeline on, or back from it, when that is in
   * it. Sounds of muted tracks too, so that unmuting them is heard at once.
   */
  async #feed(run: Run, context: AudioContext, sound: MixSound, since: number): Promise<void> {
    const file = await this.#fileOf(sound.file);
    if (run.stopped) return;
    if (!file) {
      // Time goes on without it. When code is done with it, what is left of it comes in on time.
      if (sound.made) {
        run.started.delete(sound.id);
        run.waiting.set(sound.id, this.#wallClock() + LOOK_AGAIN_MS);
      } else this.#problem(run, sound);
      return;
    }
    const mixer = await run.ready;
    if (!mixer || run.stopped) return;
    mixer.send({ kind: "open", run: run.id, id: sound.id });
    if (run.rate < 0) await this.#feedBackwards(run, context, mixer, sound, file, since);
    else await this.#feedForwards(run, context, mixer, sound, file, since);
  }

  async #feedForwards(
    run: Run,
    context: AudioContext,
    mixer: MixerNode,
    sound: MixSound,
    file: Blob,
    since: number,
  ): Promise<void> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    // Before the file begins there is nothing to read: it is silent there.
    const from = Math.max(toFile(Math.max(sound.start, since)) - MARGIN_SECONDS, 0);
    let read: number | undefined;
    for await (const chunk of this.#read(file, from, toFile(sound.end) + MARGIN_SECONDS)) {
      if (!(await this.#whileRunning(run, context))) return;
      const end = chunk.start + (chunk.channels[0]?.length ?? 0);
      this.#send(mixer, run, sound, chunk, read ?? Math.round(from * chunk.rate));
      read = end;
      const when = this.#contextTime(
        run,
        context,
        sound.start + chunk.start / chunk.rate - sound.offset,
      );
      if (!(await this.#untilDue(run, context, when))) return;
    }
    // Also when nothing came, such as when the clip starts past the end of its file: then all of
    // it is silent, and nothing is late.
    if (!run.stopped) mixer.send({ kind: "end", run: run.id, id: sound.id, frame: read ?? 0 });
  }

  /** Backwards, a piece at a time from the end on, each read forwards as files can be. */
  async #feedBackwards(
    run: Run,
    context: AudioContext,
    mixer: MixerNode,
    sound: MixSound,
    file: Blob,
    since: number,
  ): Promise<void> {
    const toFile = (seconds: number) => seconds - sound.start + sound.offset;
    const toTimeline = (seconds: number) => sound.start + seconds - sound.offset;
    const length = BACKWARDS_SECONDS * Math.max(Math.abs(run.rate), 1);
    const bottom = Math.max(toFile(sound.start) - MARGIN_SECONDS, 0);
    let top = toFile(Math.min(sound.end, since)) + MARGIN_SECONDS;
    let any = false;
    while (top > bottom) {
      const from = Math.max(top - length, bottom);
      let read: number | undefined;
      for await (const chunk of this.#read(file, from, top)) {
        if (run.stopped) return;
        this.#send(mixer, run, sound, chunk, read ?? Math.round(from * chunk.rate));
        read = chunk.start + (chunk.channels[0]?.length ?? 0);
        any = true;
      }
      if (!(await this.#whileRunning(run, context))) return;
      const when = this.#contextTime(run, context, toTimeline(from));
      if (!(await this.#untilDue(run, context, when))) return;
      top = from;
    }
    // Nothing of the file is where it plays: silent, and nothing late.
    if (!any && !run.stopped) mixer.send({ kind: "end", run: run.id, id: sound.id, frame: 0 });
  }

  /** Hands a chunk over to the mixer, and with it all of the file from `since` up to its end. */
  #send(mixer: MixerNode, run: Run, sound: MixSound, chunk: DecodedChunk, since: number): void {
    const { start, rate, channels } = chunk;
    mixer.send(
      { kind: "chunk", run: run.id, id: sound.id, rate, start, channels, since },
      channels.map(({ buffer }) => buffer as ArrayBuffer),
    );
  }

  /** A suspended context does not move, so nothing it would play can be on time. */
  async #whileRunning(run: Run, context: AudioContext): Promise<boolean> {
    while (context.state !== "running" && !run.stopped) await sleep(POLL_MS / 2);
    return !run.stopped;
  }

  /** Waits until what plays at `when` is near, so that only a little is decoded ahead. */
  async #untilDue(run: Run, context: AudioContext, when: number): Promise<boolean> {
    while (when - context.currentTime > LEAD_SECONDS && !run.stopped) await sleep(POLL_MS);
    return !run.stopped;
  }

  /** The moment on the context's clock at which a moment on the timeline gets mixed. */
  #contextTime(run: Run, context: AudioContext, seconds: number): number {
    const clockTarget = run.at + ((seconds - run.seconds) / run.rate) * 1000;
    return context.currentTime + (clockTarget - this.now()) / 1000 - run.latency;
  }
}
