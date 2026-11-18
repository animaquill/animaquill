import type { MixPlan, MixSound } from "@animaquill/core";
import type { SampleReader } from "./engine/decode.ts";
import { SoundFailed, SoundMixer, type MixedPiece, type MixerOptions } from "./mix.ts";

/**
 * A `SoundMixer` in a worker: the export and what AI hears mix there, away from the page, with the
 * same engine as the preview. The page keeps what only it can do, finding the file of a sound (and
 * waiting for code to make it), and answers the worker's questions for them.
 */

/** What the page asks of the mixer's side. */
export type ToMixer =
  | { readonly kind: "start"; readonly plan: MixPlan }
  | { readonly kind: "mix"; readonly ask: number; readonly from: number; readonly frames: number }
  /** The file of a sound the mixer asked for; none when there is none, `failed` when finding it failed. */
  | { readonly kind: "file"; readonly ask: number; readonly file?: Blob; readonly failed?: true };

/** What the mixer's side tells the page. */
export type FromMixer =
  | { readonly kind: "file"; readonly ask: number; readonly sound: MixSound }
  | {
      readonly kind: "mixed";
      readonly ask: number;
      readonly left: Float32Array;
      readonly right: Float32Array;
    }
  | {
      readonly kind: "failed";
      readonly ask: number;
      /** A sound that could not be mixed, and why. */
      readonly sound?: MixSound;
      readonly reason?: SoundFailed["reason"];
      /** Finding a file failed on the page, with the error it has, for that question. */
      readonly asked?: number;
      readonly message: string;
    };

/** What both sides of a port have: a worker, its global scope, or a `MessagePort`. */
export interface MixPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** Finding a file failed on the page: the page knows the error. */
class FileFailed extends Error {
  readonly asked: number;

  constructor(asked: number) {
    super("finding the file failed");
    this.asked = asked;
  }
}

/** The mixer's side: mixes what the page asks, with the files it gets from the page. */
export function serveMixer(port: MixPort, read?: SampleReader): void {
  let mixer: SoundMixer | undefined;
  let asks = 0;
  const files = new Map<number, (answer: Extract<ToMixer, { kind: "file" }>) => void>();
  const fileOf = (sound: MixSound) =>
    new Promise<Blob | undefined>((resolve, reject) => {
      asks += 1;
      const ask = asks;
      files.set(ask, ({ file, failed }) => {
        if (failed) reject(new FileFailed(ask));
        else resolve(file);
      });
      port.postMessage({ kind: "file", ask, sound } satisfies FromMixer);
    });
  // One piece after the other, as the mixer reads each file front to back.
  let queue = Promise.resolve();
  port.addEventListener("message", ({ data }: MessageEvent<ToMixer>) => {
    if (data.kind === "start") {
      mixer?.close();
      const options: MixerOptions = {
        fileOf: async () => undefined,
        source: fileOf,
        ...(read && { read }),
      };
      mixer = new SoundMixer(data.plan, options);
    } else if (data.kind === "file") {
      files.get(data.ask)?.(data);
      files.delete(data.ask);
    } else {
      const { ask, from, frames } = data;
      const working = mixer;
      queue = queue.then(async () => {
        try {
          if (!working) throw new Error("Nothing to mix");
          const piece = await working.mix(from, frames);
          const left = piece.getChannelData(0);
          const right = piece.getChannelData(1);
          port.postMessage({ kind: "mixed", ask, left, right } satisfies FromMixer, [
            left.buffer as ArrayBuffer,
            right.buffer as ArrayBuffer,
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure: FromMixer =
            error instanceof SoundFailed
              ? {
                  kind: "failed",
                  ask,
                  sound: error.sound as MixSound,
                  reason: error.reason,
                  message,
                }
              : error instanceof FileFailed
                ? { kind: "failed", ask, asked: error.asked, message }
                : { kind: "failed", ask, message };
          port.postMessage(failure);
        }
      });
    }
  });
}

/** A mixer that runs elsewhere, as the page has it. */
export interface PortMixer {
  readonly silent: boolean;
  mix(from: number, frames: number): Promise<MixedPiece>;
  /** The other side stopped working: every piece asked for fails with this. */
  fail(error: unknown): void;
  close(): void;
}

/** The page's side of a mixer that runs elsewhere, as the export and what AI hears use one. */
export function portMixer(
  port: MixPort,
  plan: MixPlan,
  options: Pick<MixerOptions, "fileOf" | "source">,
  close: () => void,
): PortMixer {
  const local = new SoundMixer(plan, options);
  const failures = new Map<number, unknown>();
  const waiting = new Map<
    number,
    { resolve: (piece: MixedPiece) => void; reject: (error: unknown) => void }
  >();
  let asks = 0;
  let broken: unknown;
  const answerFile = async (ask: number, sound: MixSound) => {
    try {
      const own = await options.source?.(sound);
      const file = own ?? (await options.fileOf(sound.file).catch(() => undefined));
      port.postMessage({ kind: "file", ask, ...(file && { file }) } satisfies ToMixer);
    } catch (error) {
      failures.set(ask, error);
      port.postMessage({ kind: "file", ask, failed: true } satisfies ToMixer);
    }
  };
  port.addEventListener("message", ({ data }: MessageEvent<FromMixer>) => {
    if (data.kind === "file") {
      void answerFile(data.ask, data.sound);
      return;
    }
    const pending = waiting.get(data.ask);
    waiting.delete(data.ask);
    if (!pending) return;
    if (data.kind === "mixed") {
      const channels = [data.left, data.right];
      pending.resolve({
        length: data.left.length,
        numberOfChannels: channels.length,
        getChannelData: (channel) => channels[channel] ?? data.left,
      });
    } else if (data.asked !== undefined && failures.has(data.asked)) {
      pending.reject(failures.get(data.asked));
    } else if (data.sound && data.reason) {
      pending.reject(new SoundFailed(data.sound, data.reason, data.message));
    } else pending.reject(new Error(data.message));
  });
  port.postMessage({ kind: "start", plan } satisfies ToMixer);
  return {
    get silent() {
      return local.silent;
    },
    mix(from, frames) {
      if (broken !== undefined) return Promise.reject(broken);
      asks += 1;
      const ask = asks;
      return new Promise((resolve, reject) => {
        waiting.set(ask, { resolve, reject });
        port.postMessage({ kind: "mix", ask, from, frames } satisfies ToMixer);
      });
    },
    fail(error) {
      broken ??= error;
      for (const { reject } of waiting.values()) reject(broken);
      waiting.clear();
    },
    close() {
      this.fail(new Error("The mixer was closed"));
      close();
    },
  };
}
