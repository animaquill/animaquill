import { compileChannel, numberAt, type Channel } from "@animaquill/core/curve";
import {
  type MixEffect,
  audibleTracks,
  canSound,
  clockOfSound,
  gainOfDecibels,
  monoPan,
  stereoPan,
  type MixPlan,
  type MixSound,
  type MixTrack,
} from "@animaquill/core/mix-plan";
import { fadesDuring, fadesGainAt } from "@animaquill/core/sound-fades";
import { MIX_RATE, WHOLE, kernelFor, resample } from "./resample.ts";
import { SampleStore } from "./samples.ts";
import { EffectChain, latencyOf, memoryOf, type ClockOf } from "./effects/chain.ts";
import { LOOKAHEAD, Limiter, limiterMemoryOf } from "./effects/limiter.ts";

/**
 * Samples that the engine works out at a time. Blocks start at whole multiples of it on the
 * timeline, wherever a mix starts, so that how a mix is cut into calls changes nothing.
 */
export const BLOCK = 128;

/** Where a sound gets its samples from, if anywhere yet. */
export type SamplesOf = (sound: MixSound) => SampleStore | undefined;

/** A sound should have played from sample `from` for `count` samples, but its samples were not here. */
export type OnMissing = (sound: MixSound, from: number, count: number) => void;

interface Voice {
  readonly sound: MixSound;
  /** The samples of the timeline it plays, from `first` up to `end`. */
  readonly first: number;
  readonly end: number;
  /** Samples its effects put it later, which it makes up for by reading ahead. */
  readonly latency: number;
  /** Its effects, once its file says how many channels they work on. */
  chain: EffectChain | undefined;
}

interface Lane {
  readonly track: MixTrack;
  readonly voices: readonly Voice[];
  readonly chain: EffectChain | undefined;
  /** The latency of its effects, and the most of any of its sounds'. */
  readonly latency: number;
  readonly reach: number;
}

/**
 * Blocks it keeps of what it gave out: a call for some of them again, as the preview makes for the
 * rest of a block, or after a little going back, gets them without working them out again.
 */
const HISTORY_BLOCKS = 64;

/**
 * Every step of the mix is rounded to 32 bits, as the browser's mix was (Web Audio works in 32-bit
 * floats): a project of one sound on a track at 0 dB sounds as before to the last bit.
 */
const f32 = Math.fround;

/**
 * The gain of a volume with keys at a reading of its clock: worked out in decibels, then a gain, in
 * 32 bits as every gain of the mix.
 */
const decibelGain = (volume: Channel, clock: number) =>
  f32(gainOfDecibels(numberAt(volume, clock, 0)));

/** The first sample at or after a moment on the timeline. */
const sampleAt = (seconds: number) => Math.ceil(seconds * MIX_RATE - WHOLE);

const blockOf = (sample: number) => Math.floor(sample / BLOCK) * BLOCK;

/** How effects of a list put sound later, in samples. */
const latencyIn = (effects: readonly MixEffect[] | undefined) =>
  (effects ?? []).reduce((sum, effect) => sum + latencyOf(effect), 0);

/** How long effects of a list remember, in samples. */
const memoryIn = (effects: readonly MixEffect[] | undefined) =>
  (effects ?? []).reduce((sum, effect) => sum + memoryOf(effect), 0);

/**
 * How long a plan remembers, in samples: what has to be mixed before a sample, from nothing, for
 * that sample to be what it is when the mix starts at the start, to 2⁻¹⁶ (−96 dBFS). The longest
 * way through the effects of a sound, its track and the master, the safe limiter last. 0 without
 * any effect, and then a mix from anywhere is the same to the sample.
 */
export function mixMemory(plan: MixPlan): number {
  const audible = audibleTracks(plan.tracks);
  let deepest = 0;
  for (const track of plan.tracks) {
    if (!audible.has(track.id)) continue;
    let sounds = 0;
    for (const sound of plan.sounds) {
      if (sound.track === track.id) sounds = Math.max(sounds, memoryIn(sound.effects));
    }
    deepest = Math.max(deepest, sounds + memoryIn(track.effects));
  }
  const { master } = plan;
  if (!master) return deepest;
  const limit = master.limit ? limiterMemoryOf(SAFE_RELEASE) : 0;
  return deepest + memoryIn(master.effects) + limit;
}

/**
 * How far ahead of the timeline a plan reads sounds, in samples: limiters look ahead, and what comes
 * before one is worked out that much earlier.
 */
export function mixLookahead(plan: MixPlan): number {
  let deepest = 0;
  for (const track of plan.tracks) {
    let sounds = 0;
    for (const sound of plan.sounds) {
      if (sound.track === track.id) sounds = Math.max(sounds, latencyIn(sound.effects));
    }
    deepest = Math.max(deepest, sounds + latencyIn(track.effects));
  }
  const { master } = plan;
  if (!master) return deepest;
  return deepest + latencyIn(master.effects) + (master.limit ? LOOKAHEAD : 0);
}

/**
 * Seconds of the timeline before where it starts that a plan mixes first, see `mixMemory`: what
 * playing from there has to have the samples of.
 */
export const prerollSeconds = (plan: MixPlan): number =>
  (mixMemory(plan) + mixLookahead(plan) + 2 * BLOCK) / MIX_RATE;

/**
 * The release of the safe limiter of the master, in milliseconds: the default of `limiter`, which it
 * is with its own ceiling.
 */
export const SAFE_RELEASE = 100;

/**
 * The mix: every sound at its place, from its offset, at the rate of the mix (see `resample.ts`),
 * down-mixed to two channels, through its effects, with its transitions, the volume of its clip and
 * its pan; the sounds of a track added up, through the track's effects, with its volume and its
 * pan; the tracks added up, through the master's effects, its volume and its safe limiter, and kept
 * within [−1, 1]. Each step in 32-bit floats. Volume and pan with keys are worked out for every
 * sample (see `mix-plan.ts`), parameters of effects every 32 (see `effects/chain.ts`). Muted and
 * soloed tracks follow from the plan. Plain TypeScript, without Web Audio, so that the preview (in
 * the audio thread), the export and what AI hears (in a worker) all run this same code and get the
 * same samples.
 *
 * Effects that delay the sound (limiters) are made up for: whatever comes before one is worked out
 * that much ahead, so that sample n of the mix is sample n of the timeline.
 *
 * Effects remember what came before, so the engine works from block to block in order. Asked for a
 * sample somewhere else, it starts over from `mixMemory` samples before it ("preroll"), from nothing:
 * the export, which starts at the start, is what everything else comes within −96 dBFS of. Without
 * effects it remembers nothing, and a mix from anywhere is the same to the sample.
 */
export class MixEngine {
  readonly #samplesOf: SamplesOf;
  readonly #onMissing: OnMissing;
  #plan: MixPlan = { sounds: [], tracks: [] };
  #lanes: readonly Lane[] = [];
  #heard: ReadonlySet<MixSound> = new Set();
  #masterChain: EffectChain | undefined;
  readonly #safe = new Limiter(2);
  #limiting = false;
  /** Samples the master's effects and its limiter put the sound later. */
  #masterLatency = 0;
  #limitLatency = 0;
  /** The furthest ahead of the timeline that any sound gets read. */
  #lookahead = 0;
  #memory = 0;
  /** Without effects and limiter: for playing backwards, see `dry`. */
  #dry = false;
  /** The next block it works out, or undefined to start over. */
  #next: number | undefined;
  /** Whether starting over takes no preroll: once, after a change that made it start over. */
  #cold = false;
  #waiting = false;
  readonly #history = {
    left: new Float32Array(HISTORY_BLOCKS * BLOCK),
    right: new Float32Array(HISTORY_BLOCKS * BLOCK),
    blocks: new Float64Array(HISTORY_BLOCKS).fill(Number.NaN),
    /** Which plan each was mixed with, see `#plans`. */
    plans: new Uint32Array(HISTORY_BLOCKS),
  };
  /** How many plans it had: a block of an older one is mixed again where nothing remembers. */
  #plans = 0;
  readonly #master = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  readonly #lane = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  readonly #sound = [new Float64Array(BLOCK), new Float64Array(BLOCK)] as const;
  readonly #mono = [this.#sound[0]] as const;
  /** How a pan splits the sides at a sample, see `monoPan` and `stereoPan`. */
  readonly #sides = new Float64Array(4);
  #input = [new Float64Array(1024), new Float64Array(1024)] as const;
  /** The largest sample of each track after its fader and pan, while metering: see `takePeak`. */
  readonly #peaks = new Map<string, number>();
  /**
   * Whether to keep the peaks of tracks, for the meters of the mixer. It changes no sample: only
   * the preview turns it on.
   */
  metering = false;

  constructor(plan: MixPlan, samplesOf: SamplesOf, onMissing: OnMissing = () => {}) {
    this.#samplesOf = samplesOf;
    this.#onMissing = onMissing;
    this.setPlan(plan);
  }

  /**
   * From the next block on, mixes what this plan says. Effects that are still there keep what they
   * remember; when what delays the sound changes, it all starts over from there, without preroll.
   */
  setPlan(plan: MixPlan): void {
    const audible = audibleTracks(plan.tracks);
    const heard = new Set<MixSound>();
    const before = new Map<string, Voice>();
    const tracksBefore = new Map<string, Lane>();
    for (const lane of this.#lanes) {
      tracksBefore.set(lane.track.id, lane);
      for (const voice of lane.voices) before.set(voice.sound.id, voice);
    }
    this.#lanes = plan.tracks.flatMap((track): Lane[] => {
      if (!audible.has(track.id) || !canSound(track)) return [];
      let reach = 0;
      const voices = plan.sounds.flatMap((sound): Voice[] => {
        if (sound.track !== track.id || !canSound(sound)) return [];
        const first = sampleAt(sound.start);
        const end = sampleAt(sound.end);
        if (end <= first) return [];
        heard.add(sound);
        const latency = latencyIn(sound.effects);
        reach = Math.max(reach, latency);
        const kept = before.get(sound.id);
        const chain =
          kept?.chain && sound.effects && kept.chain.adopt(sound.effects, clipClock(sound))
            ? kept.chain
            : undefined;
        return [{ sound, first, end, latency, chain }];
      });
      const old = tracksBefore.get(track.id)?.chain;
      const effects = track.effects ?? [];
      const chain =
        effects.length === 0 ? undefined : old?.adopt(effects) ? old : new EffectChain(effects, 2);
      if (voices.length === 0 && !chain) return [];
      return [{ track, voices, chain, latency: chain?.latency ?? 0, reach }];
    });
    this.#heard = heard;
    const effects = plan.master?.effects ?? [];
    this.#masterChain =
      effects.length === 0
        ? undefined
        : this.#masterChain?.adopt(effects)
          ? this.#masterChain
          : new EffectChain(effects, 2);
    const limit = plan.master?.limit;
    if (limit) {
      this.#safe.setCeiling(limit.ceiling);
      this.#safe.setRelease(SAFE_RELEASE);
    }
    const lookahead = this.#lookahead;
    const limiting = this.#limiting;
    this.#limiting = limit !== undefined;
    this.#limitLatency = limit ? this.#safe.latency : 0;
    this.#masterLatency = this.#masterChain?.latency ?? 0;
    this.#lookahead =
      this.#limitLatency +
      this.#masterLatency +
      Math.max(0, ...this.#lanes.map((lane) => lane.latency + lane.reach));
    this.#memory = mixMemory(plan);
    this.#plan = plan;
    this.#plans += 1;
    if (this.#lookahead !== lookahead || this.#limiting !== limiting) this.#startOver();
  }

  /** Starts over at the next call, without preroll: what is late now has to be heard now. */
  #startOver(): void {
    if (this.#next !== undefined) this.#cold = true;
    this.#next = undefined;
    this.#history.blocks.fill(Number.NaN);
  }

  /**
   * Without effects and the master's limiter, remembering nothing: for playing backwards, which
   * effects cannot do. What is the same either way is the same to the sample.
   */
  get dry(): boolean {
    return this.#dry;
  }

  set dry(dry: boolean) {
    if (dry === this.#dry) return;
    this.#dry = dry;
    this.#startOver();
    this.#cold = false;
  }

  /** Whether a sound of the plan is heard at all: on a track that is, and louder than nothing. */
  hears(sound: MixSound): boolean {
    return this.#heard.has(sound);
  }

  /**
   * The largest sample of a track, either side, after its fader and pan, since it was taken last;
   * 0 when it was not heard. Only while `metering`.
   */
  takePeak(track: string): number {
    const peak = this.#peaks.get(track) ?? 0;
    if (peak !== 0) this.#peaks.set(track, 0);
    return peak;
  }

  /**
   * What compressors and limiters took off since this was asked last, in dB, by where they are:
   * `<clip>/<effect>` for those of clips, `~track:<track>/<effect>` for those of tracks,
   * `~master/<effect>` for those of the master, and `~master/~limit` for its safe limiter. Only
   * while `metering`.
   */
  takeReductions(): Map<string, number> {
    const into = new Map<string, number>();
    for (const lane of this.#lanes) {
      lane.chain?.takeReductions(`~track:${lane.track.id}/`, into);
      for (const voice of lane.voices) voice.chain?.takeReductions(`${voice.sound.id}/`, into);
    }
    this.#masterChain?.takeReductions("~master/", into);
    if (this.#limiting) into.set("~master/~limit", this.#safe.takeReduction());
    return into;
  }

  /** The gain of the master's safe limiter on the last sample it gave out: 1 when it does nothing. */
  get limiting(): number {
    return this.#limiting && !this.#dry ? this.#safe.gain : 1;
  }

  /** Whether any sound of the plan is heard. */
  get silent(): boolean {
    return this.#heard.size === 0;
  }

  /** Samples it mixes before a sample when it starts there, see `mixMemory`. */
  get memory(): number {
    return this.#dry ? 0 : this.#memory;
  }

  /** How far ahead of the timeline it reads the samples of sounds, in samples. */
  get lookahead(): number {
    return this.#dry ? 0 : this.#lookahead;
  }

  /**
   * The first sample of the timeline it reads to give out sample `from`: before it when it starts
   * over there, which it has to have the samples of sounds from (see `SoundMixer`).
   */
  startFor(from: number): number {
    const block = blockOf(from);
    if (this.#kept(block) !== undefined) return from;
    if (this.#follows(block)) return Math.min(from, this.#next as number);
    return Math.min(from, this.#restartAt(block));
  }

  /**
   * Samples `from` up to `from + frames` of the timeline (at the rate of the mix, from its start)
   * into `left` and `right` from `at` on.
   */
  render(from: number, frames: number, left: Float32Array, right: Float32Array, at = 0): void {
    const end = from + frames;
    let sample = from;
    while (sample < end) {
      const block = blockOf(sample);
      const upTo = Math.min(block + BLOCK, end);
      let slot = this.#kept(block);
      // Without effects or the limiter a block can be mixed again, with the plan of now: a new
      // volume is heard from the next sample asked for on.
      if (slot !== undefined && this.#history.plans[slot] !== this.#plans && this.#stateless) {
        this.#store(block);
      }
      if (slot === undefined) {
        this.#reach(block, Number.POSITIVE_INFINITY, false);
        slot = this.#kept(block) as number;
      }
      const offset = slot * BLOCK + sample - block;
      const into = at + sample - from;
      left.set(this.#history.left.subarray(offset, offset + upTo - sample), into);
      right.set(this.#history.right.subarray(offset, offset + upTo - sample), into);
      sample = upTo;
    }
  }

  /**
   * Gets ready to give out sample `from`, working out at most `blocks` blocks now: true once it
   * is. With `wait`, it works out nothing while samples of sounds it needs are not here yet, so
   * that what it remembers is what it would be.
   */
  ready(from: number, blocks: number, wait = false): boolean {
    this.#waiting = false;
    const block = blockOf(from);
    if (this.#kept(block) !== undefined) return true;
    return this.#reach(block, blocks, wait);
  }

  /** Whether the last `ready` stopped for samples of sounds that are not here yet. */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** Whether nothing it does remembers anything, so that any block can be mixed at any time. */
  get #stateless(): boolean {
    return this.memory === 0 && this.lookahead === 0;
  }

  /** The slot of the history that has a block, if it has it. */
  #kept(block: number): number | undefined {
    const slot = (((block / BLOCK) % HISTORY_BLOCKS) + HISTORY_BLOCKS) % HISTORY_BLOCKS;
    return this.#history.blocks[slot] === block ? slot : undefined;
  }

  /** Whether going on from where it is gets to a block sooner than starting over. */
  #follows(block: number): boolean {
    const next = this.#next;
    if (next === undefined || block < next) return false;
    return block - next <= Math.max(this.memory + this.lookahead, HISTORY_BLOCKS * BLOCK);
  }

  /** Where it starts over to give out a block, see `mixMemory`. */
  #restartAt(block: number): number {
    const lookahead = this.lookahead;
    const memory = this.#cold ? 0 : this.memory;
    // Before the timeline all is silence, and starting there is starting from nothing.
    return Math.max(blockOf(block - memory - lookahead), blockOf(-lookahead) - BLOCK);
  }

  /** Works out blocks up to and with `block`, at most `blocks` of them. */
  #reach(block: number, blocks: number, wait: boolean): boolean {
    if (!this.#follows(block)) {
      this.#next = this.#restartAt(block);
      this.#cold = false;
      this.#reset();
    }
    let left = blocks;
    while ((this.#next as number) <= block) {
      if (left <= 0) return false;
      const next = this.#next as number;
      // What comes before the block is only for what effects remember.
      if (wait && next < block && !this.#covered(next)) {
        this.#waiting = true;
        return false;
      }
      this.#store(next);
      this.#next = next + BLOCK;
      left -= 1;
    }
    return true;
  }

  /** As if nothing ever played. */
  #reset(): void {
    for (const lane of this.#lanes) {
      lane.chain?.reset();
      for (const voice of lane.voices) voice.chain?.reset();
    }
    this.#masterChain?.reset();
    this.#safe.reset();
  }

  /** Works out the block from sample `block` and keeps it. */
  #store(block: number): void {
    this.#block(block);
    const slot = (((block / BLOCK) % HISTORY_BLOCKS) + HISTORY_BLOCKS) % HISTORY_BLOCKS;
    const [masterLeft, masterRight] = this.#master;
    const base = slot * BLOCK;
    const { left, right } = this.#history;
    for (let index = 0; index < BLOCK; index += 1) {
      left[base + index] = masterLeft[index] as number;
      right[base + index] = masterRight[index] as number;
    }
    this.#history.blocks[slot] = block;
    this.#history.plans[slot] = this.#plans;
  }

  /** Whether the samples of every sound that the block from `block` takes in are here. */
  #covered(block: number): boolean {
    const dry = this.#dry;
    const at = block + (dry ? 0 : this.#limitLatency + this.#masterLatency);
    for (const lane of this.#lanes) {
      const laneAt = at + (dry ? 0 : lane.latency);
      for (const voice of lane.voices) {
        const from = laneAt + (dry ? 0 : voice.latency);
        const first = Math.max(from, voice.first);
        const last = Math.min(from + BLOCK, voice.end);
        if (last <= first) continue;
        const store = this.#samplesOf(voice.sound);
        if (!store) continue;
        const rate = store.rate;
        if (rate === undefined) {
          if (store.ended) continue;
          return false;
        }
        const { sound } = voice;
        const fileFrom = Math.floor((first / MIX_RATE - sound.start + sound.offset) * rate) - 64;
        const fileTo = Math.ceil((last / MIX_RATE - sound.start + sound.offset) * rate) + 64;
        if (!store.has(fileFrom, fileTo - fileFrom)) return false;
      }
    }
    return true;
  }

  /** The block from sample `block` into the master. */
  #block(block: number): void {
    const [masterLeft, masterRight] = this.#master;
    masterLeft.fill(0);
    masterRight.fill(0);
    const dry = this.#dry;
    // Where in the timeline each step works, ahead of the block by what comes after it.
    const limitAt = block + (dry ? 0 : this.#limitLatency);
    const masterAt = limitAt + (dry ? 0 : this.#masterLatency);
    const [laneLeft, laneRight] = this.#lane;
    for (const lane of this.#lanes) {
      const laneAt = masterAt + (dry ? 0 : lane.latency);
      let used = false;
      for (const voice of lane.voices) {
        const ahead = dry ? 0 : voice.latency;
        // What goes into its effects, and what comes out of them.
        if (laneAt + ahead + BLOCK <= voice.first || laneAt >= voice.end) continue;
        if (!used) {
          laneLeft.fill(0);
          laneRight.fill(0);
          used = true;
        }
        this.#voice(voice, laneAt, dry);
      }
      const chain = dry ? undefined : lane.chain;
      if (chain) {
        if (!used) {
          laneLeft.fill(0);
          laneRight.fill(0);
        }
        chain.process(this.#lane, BLOCK, laneAt);
      } else if (!used) continue;
      this.#mixLane(lane.track, masterAt);
    }
    const master = this.#plan.master;
    if (!master) return;
    if (!dry) this.#masterChain?.process(this.#master, BLOCK, masterAt);
    const { volume } = master;
    const still = f32(master.gain);
    if (volume || still !== 1) {
      for (let index = 0; index < BLOCK; index += 1) {
        const gain = volume ? decibelGain(volume, (limitAt + index) / MIX_RATE) : still;
        masterLeft[index] = f32((masterLeft[index] as number) * gain);
        masterRight[index] = f32((masterRight[index] as number) * gain);
      }
    }
    if (this.#limiting && !dry) this.#safe.process(this.#master, 0, BLOCK);
    for (let index = 0; index < BLOCK; index += 1) {
      const l = masterLeft[index] as number;
      const r = masterRight[index] as number;
      masterLeft[index] = f32(l > 1 ? 1 : l < -1 ? -1 : l);
      masterRight[index] = f32(r > 1 ? 1 : r < -1 ? -1 : r);
    }
  }

  /** Adds a lane to the master, after the volume of its track and then its pan. */
  #mixLane(track: MixTrack, block: number): void {
    const [masterLeft, masterRight] = this.#master;
    const [laneLeft, laneRight] = this.#lane;
    const { volume, pan } = track;
    const still = f32(track.gain);
    const panning = pan !== undefined;
    const sides = this.#sides;
    if (pan?.kind === "still") stereoPan(pan.value as number, sides);
    const metering = this.metering;
    let peak = 0;
    for (let index = 0; index < BLOCK; index += 1) {
      const seconds = (block + index) / MIX_RATE;
      const gain = volume ? decibelGain(volume, seconds) : still;
      let left = f32((laneLeft[index] ?? 0) * gain);
      let right = f32((laneRight[index] ?? 0) * gain);
      if (panning) {
        if (pan.kind === "curve") stereoPan(numberAt(pan, seconds, 0), sides);
        const l = left;
        left = f32(f32(l * (sides[0] as number)) + f32(right * (sides[1] as number)));
        right = f32(f32(l * (sides[2] as number)) + f32(right * (sides[3] as number)));
      }
      masterLeft[index] = f32((masterLeft[index] ?? 0) + left);
      masterRight[index] = f32((masterRight[index] ?? 0) + right);
      if (metering) {
        const level = Math.max(Math.abs(left), Math.abs(right));
        if (level > peak) peak = level;
      }
    }
    if (metering && peak > (this.#peaks.get(track.id) ?? 0)) this.#peaks.set(track.id, peak);
  }

  /**
   * Adds what a sound plays from sample `at` of the timeline for a block to the lane: through its
   * effects, which take in its file that much ahead, then its transitions, volume and pan. A sound
   * whose samples are not all here is silent for the block, which says so.
   */
  #voice(voice: Voice, at: number, dry: boolean): void {
    const { sound } = voice;
    const store = this.#samplesOf(sound);
    // Not being read (yet): nothing to miss, as a sound that code is still making.
    if (!store) return;
    const ahead = dry ? 0 : voice.latency;
    const effects = dry ? undefined : sound.effects;
    // What of its file goes in, in the samples of the timeline.
    const inFrom = Math.max(at + ahead, voice.first);
    const inTo = Math.min(at + ahead + BLOCK, voice.end);
    const [soundLeft, soundRight] = this.#sound;
    let mono = store.channels === 1;
    if (effects && effects.length > 0) {
      soundLeft.fill(0);
      soundRight.fill(0);
      const complete = inTo <= inFrom || this.#source(voice, store, inFrom, inTo, at + ahead);
      if (store.rate === undefined) return;
      mono = store.channels === 1;
      if (!voice.chain || voice.chain.channels !== (mono ? 1 : 2)) {
        voice.chain = new EffectChain(effects, mono ? 1 : 2, clipClock(sound));
      }
      voice.chain.process(mono ? this.#mono : this.#sound, BLOCK, at + ahead);
      if (!complete) return;
    } else {
      const from = Math.max(at, voice.first);
      const to = Math.min(at + BLOCK, voice.end);
      if (to <= from || !this.#source(voice, store, from, to, at)) return;
    }
    const [laneLeft, laneRight] = this.#lane;
    const { fades, volume, pan } = sound;
    const still = f32(sound.gain);
    const from = Math.max(at, voice.first);
    const to = Math.min(at + BLOCK, voice.end);
    if (to <= from) return;
    const fading = fadesDuring(fades, from / MIX_RATE, to / MIX_RATE);
    const panning = pan !== undefined;
    const sides = this.#sides;
    if (pan?.kind === "still") (mono ? monoPan : stereoPan)(pan.value as number, sides);
    for (let index = from - at; index < to - at; index += 1) {
      const seconds = (at + index) / MIX_RATE;
      // The transitions first, then the volume of the clip, each in 32 bits as the browser had them,
      // then the pan.
      const fade = fading ? f32(fadesGainAt(fades, seconds)) : 1;
      const gain = volume ? decibelGain(volume, clockOfSound(sound, seconds)) : still;
      let left = f32(soundLeft[index] ?? 0);
      if (fading) left = f32(left * fade);
      left = f32(left * gain);
      let right = left;
      if (!mono) {
        right = f32(soundRight[index] ?? 0);
        if (fading) right = f32(right * fade);
        right = f32(right * gain);
      }
      if (panning) {
        if (pan.kind === "curve") {
          (mono ? monoPan : stereoPan)(numberAt(pan, clockOfSound(sound, seconds), 0), sides);
        }
        if (mono) {
          right = f32(left * (sides[1] as number));
          left = f32(left * (sides[0] as number));
        } else {
          const l = left;
          left = f32(f32(l * (sides[0] as number)) + f32(right * (sides[1] as number)));
          right = f32(f32(l * (sides[2] as number)) + f32(right * (sides[3] as number)));
        }
      }
      laneLeft[index] = f32((laneLeft[index] ?? 0) + left);
      laneRight[index] = f32((laneRight[index] ?? 0) + right);
    }
  }

  /**
   * The samples of a sound's file for samples `from` up to `to` of the timeline, into its buffers
   * from where sample `base` would be. Each block of the timeline is read as on its own, so that
   * every sample has the same place in the file however far ahead the mix reads. Returns whether
   * they were all here, and says it when not.
   */
  #source(voice: Voice, store: SampleStore, from: number, to: number, base: number): boolean {
    const { sound } = voice;
    const rate = store.rate;
    if (rate === undefined) {
      // The file ended before anything of it came: there is nothing to miss.
      if (store.ended) return true;
      this.#onMissing(sound, from, to - from);
      return false;
    }
    const mono = store.channels === 1;
    let complete = true;
    for (let start = from; start < to;) {
      const block = blockOf(start);
      const upTo = Math.min(block + BLOCK, to);
      // Where the block starts in the file, in its samples: from its own start, so that every
      // sample has the same position however the mix is cut.
      const anchor = (block / MIX_RATE - sound.start + sound.offset) * rate;
      const into = start - base;
      const offset = start - block;
      const count = upTo - start;
      let read: boolean;
      if (rate === MIX_RATE && Math.abs(anchor - Math.round(anchor)) < WHOLE) {
        const [left, right] = this.#sound;
        read = store.read(Math.round(anchor) + offset, count, left, right, into);
      } else {
        read = this.#resample(store, rate, anchor, offset, count, mono, into);
      }
      if (!read) complete = false;
      start = upTo;
    }
    if (!complete) this.#onMissing(sound, from, to - from);
    return complete;
  }

  /** Samples `offset` up to `offset + count` of a block, from a file at another rate, at `into`. */
  #resample(
    store: SampleStore,
    rate: number,
    anchor: number,
    offset: number,
    count: number,
    mono: boolean,
    into: number,
  ): boolean {
    const kernel = kernelFor(rate);
    const { width } = kernel;
    const step = rate / MIX_RATE;
    const firstAt = anchor + offset * step;
    const lastAt = anchor + (offset + count - 1) * step;
    const first = Math.floor(firstAt) - width + 1;
    const length = Math.floor(lastAt) + width - first + 1;
    if (this.#input[0].length < length) {
      this.#input = [new Float64Array(length * 2), new Float64Array(length * 2)];
    }
    const [inputLeft, inputRight] = this.#input;
    const complete = store.read(first, length, inputLeft, inputRight, 0);
    if (!complete) return false;
    const [soundLeft, soundRight] = this.#sound;
    resample(
      kernel,
      inputLeft,
      mono ? undefined : inputRight,
      first,
      anchor,
      step,
      offset,
      count,
      soundLeft,
      soundRight,
      into - offset,
    );
    return true;
  }
}

/** How a clip's effects read their keys: on the clock of the clip. */
const clipClock =
  (sound: MixSound): ClockOf =>
  (sample) =>
    clockOfSound(sound, sample / MIX_RATE);

/**
 * Has the engine work out a little of every kind of sound once, so that the first quanta of real
 * playing do not wait for the JavaScript engine to compile it: rates to resample from, one channel
 * and six, transitions, keys of volume and pan. Takes some tens of milliseconds; the audio thread does it once, when it is
 * made, before anything plays.
 */
export function warmUp(): void {
  const fades = [
    { use: "enter", way: "in", shape: "power", start: 0, end: 1, duration: 1 },
    { use: "exit", way: "out", shape: "gain", start: 0, end: 1, duration: 1 },
  ] as const;
  const kinds = [
    { rate: MIX_RATE, channels: 2, offset: 0 },
    { rate: MIX_RATE, channels: 1, offset: 0.3 / MIX_RATE },
    { rate: 44_100, channels: 2, offset: 0 },
    { rate: 22_050, channels: 1, offset: 0 },
    { rate: 96_000, channels: 6, offset: 0 },
  ];
  const stores = kinds.map(({ rate, channels }) => {
    const store = new SampleStore();
    store.add({
      start: 0,
      rate,
      channels: Array.from({ length: channels }, () => new Float32Array(rate / 2)),
    });
    store.endAt(rate / 2);
    return store;
  });
  // Keys of the volume and of the pan, on the first two: one channel and two.
  const keyed = compileChannel(
    {
      keys: [
        { time: "0", value: -6 },
        { time: "0.25", value: 0 },
      ],
    },
    "number",
  ) as Channel;
  const sounds = kinds.map(({ offset }, index) => ({
    id: String(index),
    file: String(index),
    track: "warm",
    start: 0,
    end: 0.5,
    offset,
    gain: 0.5,
    fades: index % 2 === 0 ? fades : [],
    ...(index < 2 && { volume: keyed, pan: keyed }),
  }));
  // Every effect once, on a sound, the track and the master, with the safe limiter.
  const effect = (type: string, values: Readonly<Record<string, number>>): MixEffect => ({
    id: type,
    type,
    params: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, { kind: "still", value }]),
    ),
  });
  const effects = [
    effect("eq", { "hp.on": 1, "mid2.gain": 3 }),
    effect("compressor", { threshold: -20, ratio: 3 }),
    effect("limiter", { ceiling: -6 }),
    effect("reverb", { mix: 0.3, decay: 0.2 }),
  ];
  const engine = new MixEngine(
    {
      sounds: sounds.map((sound, index) => (index === 0 ? { ...sound, effects } : sound)),
      tracks: [
        { id: "warm", gain: 0.5, volume: keyed, pan: keyed, muted: false, solo: false, effects },
      ],
      master: { gain: 1, effects, limit: { ceiling: -1 } },
    },
    (sound) => stores[Number(sound.id)],
  );
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let at = 0; at < MIX_RATE / 4; at += BLOCK) engine.render(at, BLOCK, left, right);
}
