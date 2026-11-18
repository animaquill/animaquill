import { PARAMETER_STEP, effectParamAt, type MixEffect } from "@animaquill/core/mix-plan";
import { MIX_RATE, WHOLE } from "../resample.ts";
import { Compressor, compressorMemory } from "./compressor.ts";
import { Equalizer, equalizerMemory } from "./eq.ts";
import { LOOKAHEAD, Limiter, limiterMemory } from "./limiter.ts";
import type { Processor } from "./processor.ts";
import { Reverb, reverbMemory } from "./reverb.ts";

/**
 * The effects of a clip, a track or the master, one after the other, as the mix engine runs them:
 * sample `n` of what goes in is sample `n` of the timeline (a sound's clip has its own clock for its
 * keys), and comes out `latency` samples later. Parameters with keys are read at sample 32·k of the
 * timeline for samples 32·k to 32·k + 31. A clip's effect that works only in a stretch of it starts
 * from nothing where that begins, and outside it lets the sound through, as late as it would be.
 */

/** The first sample at or after a moment on the timeline. */
const sampleAt = (seconds: number) => Math.ceil(seconds * MIX_RATE - WHOLE);

/** What reads the parameters of an effect at sample `n` of the timeline. */
export type ClockOf = (sample: number) => number;

const timeline: ClockOf = (sample) => sample / MIX_RATE;

interface Link {
  readonly id: string;
  readonly type: string;
  effect: MixEffect;
  readonly processor: Processor & {
    adopt?(effect: MixEffect): void;
    /** Lets sound through as late as it would be, and starts over: for one with latency. */
    pass?(channels: readonly Float64Array[], at: number, count: number): void;
  };
  /** The step of `PARAMETER_STEP` its parameters were last read for, for those with keys. */
  readAt: number;
  moving: boolean;
  /** Samples of the timeline it works in, for those of clips that say. */
  from: number;
  to: number;
  /** Whether it worked on the last sample. */
  working: boolean;
}

function processorOf(effect: MixEffect, channels: number): Link["processor"] | undefined {
  switch (effect.type) {
    case "eq":
      return new Equalizer(channels, effect);
    case "compressor":
      return new Compressor();
    case "limiter":
      return new Limiter(channels);
    case "reverb":
      return new Reverb(channels, effect);
    default:
      return undefined;
  }
}

/** Samples an effect's sound comes out later, without making it. */
export const latencyOf = (effect: MixEffect): number => (effect.type === "limiter" ? LOOKAHEAD : 0);

/** Samples an effect has to take in before it holds no memory of where it started. */
export function memoryOf(effect: MixEffect): number {
  const param = (name: string) => effectParamAt(effect, name, 0);
  switch (effect.type) {
    case "eq":
      return equalizerMemory(effect, param);
    case "compressor":
      return compressorMemory(effect);
    case "limiter":
      return limiterMemory(effect);
    case "reverb":
      return reverbMemory(effect);
    default:
      return 0;
  }
}

/** How a list of effects stands: one with the same ids and types in the same order keeps its memory. */
const shapeOf = (effects: readonly MixEffect[]) =>
  effects.map(({ id, type }) => `${id}\u0000${type}`).join("\u0001");

export class EffectChain {
  readonly channels: number;
  readonly latency: number;
  readonly memory: number;
  readonly #shape: string;
  readonly #links: Link[];
  #clock: ClockOf;
  /** The next sample it expects; another one starts it over. */
  #next: number | undefined;
  #settled = true;

  constructor(effects: readonly MixEffect[], channels: number, clock: ClockOf = timeline) {
    this.channels = channels;
    this.#clock = clock;
    this.#shape = shapeOf(effects);
    this.#links = effects.flatMap((effect): Link[] => {
      const processor = processorOf(effect, channels);
      return processor ? [this.#linkOf(effect, processor)] : [];
    });
    this.latency = effects.reduce((sum, effect) => sum + latencyOf(effect), 0);
    this.memory = effects.reduce((sum, effect) => sum + memoryOf(effect), 0);
  }

  #linkOf(effect: MixEffect, processor: Link["processor"]): Link {
    const moving = Object.values(effect.params).some((channel) => channel.kind === "curve");
    const link: Link = {
      id: effect.id,
      type: effect.type,
      effect,
      processor,
      readAt: Number.NaN,
      moving,
      from: effect.from === undefined ? Number.NEGATIVE_INFINITY : sampleAt(effect.from),
      to: effect.to === undefined ? Number.POSITIVE_INFINITY : sampleAt(effect.to),
      working: false,
    };
    if (!moving) processor.configure((name) => effectParamAt(effect, name, 0));
    return link;
  }

  /**
   * Takes other values for the same effects, keeping what they remember. False when they are not
   * the same effects any more, in the same order: then it takes a new chain.
   */
  adopt(effects: readonly MixEffect[], clock: ClockOf = timeline): boolean {
    if (shapeOf(effects) !== this.#shape) return false;
    if (effects.reduce((sum, effect) => sum + latencyOf(effect), 0) !== this.latency) return false;
    this.#clock = clock;
    for (const link of this.#links) {
      const effect = effects.find(({ id }) => id === link.id) as MixEffect;
      link.effect = effect;
      link.processor.adopt?.(effect);
      link.moving = Object.values(effect.params).some((channel) => channel.kind === "curve");
      link.from = effect.from === undefined ? Number.NEGATIVE_INFINITY : sampleAt(effect.from);
      link.to = effect.to === undefined ? Number.POSITIVE_INFINITY : sampleAt(effect.to);
      link.readAt = Number.NaN;
      if (!link.moving) link.processor.configure((name) => effectParamAt(effect, name, 0));
    }
    return true;
  }

  /**
   * What its compressors and limiters took off since this was asked last, in dB, by `prefix` and
   * the id of the effect, into `into`.
   */
  takeReductions(prefix: string, into: Map<string, number>): void {
    for (const link of this.#links) {
      const reduction = link.processor.takeReduction?.();
      if (reduction !== undefined) into.set(`${prefix}${link.id}`, reduction);
    }
  }

  /** As if nothing ever went in. */
  reset(): void {
    for (const link of this.#links) {
      link.processor.reset();
      link.working = false;
    }
    this.#next = undefined;
    this.#settled = true;
  }

  /**
   * Works on `count` samples of each channel in place, from sample `start` of the timeline on, in
   * 32-bit floats out as every step of the mix. Samples that do not follow on from the last ones
   * start it over.
   */
  process(channels: readonly Float64Array[], count: number, start: number): void {
    if (this.#next !== start) {
      if (this.#next !== undefined) this.reset();
    }
    this.#next = start + count;
    if (this.#links.length === 0) return;
    const quiet = silent(channels, count);
    if (this.#settled && quiet) return;
    let at = 0;
    while (at < count) {
      const sample = start + at;
      const step = Math.floor(sample / PARAMETER_STEP);
      let upTo = Math.min(count, (step + 1) * PARAMETER_STEP - start);
      for (const link of this.#links) {
        if (sample < link.from) upTo = Math.min(upTo, link.from - start);
        else if (sample < link.to) upTo = Math.min(upTo, link.to - start);
      }
      const run = upTo - at;
      for (const link of this.#links) {
        const working = sample >= link.from && sample < link.to;
        if (!working) {
          // A limiter goes on giving out what came in a while ago, and starts over by itself.
          link.working = false;
          link.processor.pass?.(channels, at, run);
          continue;
        }
        if (!link.working) {
          link.working = true;
          if (!link.processor.pass) link.processor.reset();
          link.readAt = Number.NaN;
        }
        if (link.moving && link.readAt !== step) {
          const clock = this.#clock(step * PARAMETER_STEP);
          const { effect } = link;
          link.processor.configure((name) => effectParamAt(effect, name, clock));
          link.readAt = step;
        }
        link.processor.process(channels, at, run);
      }
      at = upTo;
    }
    for (const samples of channels) {
      for (let index = 0; index < count; index += 1) {
        samples[index] = Math.fround(samples[index] as number);
      }
    }
    this.#settled = quiet && this.#links.every((link) => link.processor.settle());
  }
}

function silent(channels: readonly Float64Array[], count: number): boolean {
  for (const samples of channels) {
    for (let index = 0; index < count; index += 1) if (samples[index] !== 0) return false;
  }
  return true;
}
