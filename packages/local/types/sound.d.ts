/**
 * What the code of an AnimaQuill sound can use: the global `aq` of the sound runtime, version 1
 * (`"runtime": 1` in sound.json). See the scene runtime of the manual, section "声音" (`animaquill
 * guide scene-runtime/声音`, or docs/scene-runtime.md of https://github.com/animaquill/animaquill).
 * Use it with `/// <reference types="animaquill/types/sound" />`.
 */

declare namespace AnimaQuill {
  interface SoundRequest {
    /** In seconds. */
    readonly duration: number;
    /** Samples in each channel: duration × sampleRate, whole. */
    readonly frames: number;
    /** Samples in a second, 48000 now. */
    readonly sampleRate: number;
    /** `param.seed`, a whole number. */
    readonly seed: number;
    /** Every `param.<id>`, with duration and seed. */
    readonly params: Readonly<Record<string, unknown>>;
    /** The output that the clip chose, if any. */
    readonly output: string | undefined;
  }

  /** One channel, or left and right of the same length. Samples between -1 and 1. */
  type Samples = Float32Array | readonly [Float32Array, Float32Array];

  interface SoundRuntime {
    /** The version of this interface. */
    readonly runtime: number;
    /** What makes the sound, called once after the module ran. The last one counts. */
    sound(make: (request: SoundRequest) => Samples | Promise<Samples>): void;
  }
}

declare const aq: AnimaQuill.SoundRuntime;
