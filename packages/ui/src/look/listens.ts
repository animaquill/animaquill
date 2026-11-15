import {
  MIX_CHANNELS,
  MIX_PIECE_SECONDS,
  MIX_SAMPLE_RATE,
  SoundFailed,
  SoundMeter,
  type Measured,
  type MeterOptions,
} from "@animaquill/audio";
import { buildAudioPlan, type AudioPlan, type ProjectState } from "@animaquill/core";
import type { Heard, ListenAnswer, ListenFailure, ListenRequest } from "@animaquill/tools";
import type { PieceMixer } from "../export/sound.ts";
import { SoundNotMade } from "../export/made-sounds.ts";
import type { MeterAnswer, MeterRequest } from "./meter-worker.ts";

/**
 * What AI hears in the browser (`aq_audio_analyze`, mcp.md 8 of AnimaQuill Cloud): a part of a
 * timeline mixed as the export mixes it, offline and piece by piece, and measured away from the page
 * in a worker. Nothing plays; a sound made by code is waited for, as the export waits for it; a mix
 * with a sound missing gives no numbers, only why.
 */

/** Measures what is mixed: in a worker in the browser, right here in tests. */
export interface MeterPort {
  push(channels: readonly Float32Array[]): void;
  result(envelope: boolean): Promise<Measured>;
  close(): void;
}

export interface SoundListensOptions {
  /** A mixer of a plan as the export makes one: with the files and the sounds made by code. */
  readonly mixer: (
    plan: AudioPlan,
    state: ProjectState,
    timeline: string,
    signal: AbortSignal,
  ) => PieceMixer;
  /** Where the samples are measured; without it, in a worker of its own. */
  readonly meter?: (options: MeterOptions) => MeterPort;
}

/** The meter right here, as tests and a browser without workers have it. */
export function localMeter(options: MeterOptions): MeterPort {
  const meter = new SoundMeter(options);
  return {
    push: (channels) => meter.push(channels),
    result: async (envelope) => meter.result(envelope),
    close: () => {},
  };
}

/** The meter in a worker: pieces go over as they are mixed, without copies. */
export function workerMeter(options: MeterOptions): MeterPort {
  if (typeof Worker === "undefined") return localMeter(options);
  const worker = new Worker(new URL("./meter-worker.ts", import.meta.url), { type: "module" });
  const send = (request: MeterRequest, transfer: Transferable[] = []) =>
    worker.postMessage(request, transfer);
  send({ kind: "start", options });
  return {
    push: (channels) => {
      // Copies: an AudioBuffer's own channels cannot be handed over.
      const copies = channels.map((channel) => new Float32Array(channel));
      send(
        { kind: "piece", channels: copies },
        copies.map(({ buffer }) => buffer),
      );
    },
    result: (envelope) =>
      new Promise<Measured>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent<MeterAnswer>) => {
          const answer = event.data;
          if (answer.kind === "done") resolve(answer.measured);
          else reject(new Error(answer.message));
        });
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          reject(new Error(event.message || "the worker that measures sound stopped"));
        });
        send({ kind: "end", envelope });
      }),
    close: () => worker.terminate(),
  };
}

/** What measured numbers are as the tools take them: silence has no level, rather than −∞. */
function heardOf(measured: Measured): Heard {
  const level = (value: number) => (Number.isFinite(value) ? value : null);
  return {
    seconds: measured.seconds,
    ...(measured.integrated !== undefined && { integrated: measured.integrated }),
    ...(measured.shortTermMax !== undefined && { shortTermMax: measured.shortTermMax }),
    ...(measured.momentaryMax !== undefined && { momentaryMax: measured.momentaryMax }),
    truePeak: level(measured.truePeak),
    samplePeak: level(measured.samplePeak),
    clipping: measured.clipping,
    clips: measured.clips,
    silences: measured.silences,
    silent: measured.silent,
    ...(measured.envelope && { envelope: measured.envelope }),
    wave: measured.wave,
  };
}

function failureOf(error: unknown, signal: AbortSignal): ListenFailure {
  if (signal.aborted) return { reason: "stopped" };
  if (error instanceof SoundNotMade)
    return { reason: "not-made", layer: error.sound.id, why: error.why };
  if (error instanceof SoundFailed)
    return { reason: error.reason, layer: error.sound.id, file: error.sound.file };
  return { reason: "failed", message: error instanceof Error ? error.message : String(error) };
}

export class SoundListens {
  readonly #options: SoundListensOptions;

  constructor(options: SoundListensOptions) {
    this.#options = options;
  }

  /** Mixes and measures what a call asks, until it is done or the task stops. */
  async listen(request: ListenRequest, signal: AbortSignal): Promise<ListenAnswer> {
    const full = buildAudioPlan(request.state, request.timeline);
    const plan: AudioPlan =
      request.only === undefined
        ? full
        : { sounds: full.sounds.filter(({ id }) => id === request.only) };
    const seconds = request.to - request.from;
    const meter = (this.#options.meter ?? workerMeter)({
      rate: MIX_SAMPLE_RATE,
      channels: MIX_CHANNELS,
      seconds,
      buckets: request.buckets,
    });
    const mixer = this.#options.mixer(plan, request.state, request.timeline, signal);
    try {
      const total = Math.round(seconds * MIX_SAMPLE_RATE);
      const piece = MIX_PIECE_SECONDS * MIX_SAMPLE_RATE;
      for (let done = 0; done < total; done += piece) {
        if (signal.aborted) return { ok: false, failure: { reason: "stopped" } };
        const frames = Math.min(piece, total - done);
        const buffer = await mixer.mix(request.from + done / MIX_SAMPLE_RATE, frames);
        meter.push(
          Array.from({ length: MIX_CHANNELS }, (_, channel) =>
            buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)),
          ),
        );
      }
      const measured = await meter.result(request.envelope);
      return { ok: true, heard: heardOf(measured) };
    } catch (error) {
      return { ok: false, failure: failureOf(error, signal) };
    } finally {
      mixer.close?.();
      meter.close();
    }
  }
}
