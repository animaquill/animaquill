/**
 * The mixer of the preview in the audio thread (`aq-mixer`): the same mix engine as the export, one
 * quantum at a time, see `MixerCore`. A module of the audio thread, loaded from the editor's own
 * address, because the editor runs no scripts from elsewhere.
 */
import { MixerCore, type MixerMessage } from "./engine/mixer-core.ts";

/** What an audio worklet has, which the DOM types leave out. */
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options?: unknown) => AudioWorkletProcessor,
): void;

class Mixer extends AudioWorkletProcessor {
  readonly #core: MixerCore;

  constructor() {
    super();
    this.#core = new MixerCore(
      (report, transfer = []) => this.port.postMessage(report, transfer),
      sampleRate,
    );
    this.port.addEventListener("message", ({ data }: MessageEvent<MixerMessage>) =>
      this.#core.receive(data),
    );
    this.port.start();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (left && right) this.#core.process(currentFrame, left, right);
    return true;
  }
}

registerProcessor("aq-mixer", Mixer);
