/** What code that makes a sound gets to know. */
export interface SoundSetup {
  readonly global: string;
  readonly runtime: number;
  readonly duration: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly output: string | undefined;
}

/** From the worker to the page that started it. What code in there says is not to be believed. */
export type FromSoundWorker =
  | { readonly type: "samples"; readonly channels: readonly Float32Array[] }
  | { readonly type: "no-sound" }
  /** A stack, which has the place in it. */
  | { readonly type: "error"; readonly thrown: string };

/**
 * Comes after the prelude of workers, so that time and random numbers are those of a scene. It adds
 * `aq.sound`, and runs what got registered as soon as the module has run. Nobody has to say when:
 * all there is to know comes with this.
 *
 * This function travels as text, so it has to stay on its own, with nothing from outside.
 */
function setUpSound(setup: SoundSetup): void {
  const { global, runtime, duration, frames, sampleRate, seed, params, output } = setup;
  const scope = self as unknown as Record<string, Record<string, unknown>> & {
    postMessage: (message: FromSoundWorker, transfer?: Transferable[]) => void;
  };
  const say = scope.postMessage.bind(scope);
  const fail = (error: unknown) =>
    say({ type: "error", thrown: String((error as Error | undefined)?.stack ?? error) });
  let make: ((info: unknown) => unknown) | undefined;

  Object.defineProperty(scope, "aq", {
    value: Object.freeze({
      runtime,
      sound(callback: (info: unknown) => unknown) {
        if (typeof callback !== "function") throw new TypeError("aq.sound takes a function");
        make = callback;
      },
    }),
    enumerable: true,
    // Scripts may declare a variable of that name, which cannot be done to what is fixed.
    configurable: true,
  });

  const run = async () => {
    if (!make) {
      say({ type: "no-sound" });
      return;
    }
    const info = { duration, frames, sampleRate, seed, params, output };
    const result = (await make(Object.freeze(info))) as Float32Array | readonly Float32Array[];
    const channels = result instanceof Float32Array ? [result] : result;
    if (!Array.isArray(channels)) {
      say({ type: "samples", channels: [] });
      return;
    }
    const buffers = channels.flatMap((channel: unknown) =>
      channel instanceof Float32Array ? [channel.buffer as ArrayBuffer] : [],
    );
    say({ type: "samples", channels }, [...new Set(buffers)]);
  };

  (scope[global] as Record<string, unknown>).start = (url: string) => {
    import(url).then(run).catch(fail);
  };
}

/** The text of a script that does all that. */
export const soundPrelude = (setup: SoundSetup) =>
  `(${String(setUpSound)})(${JSON.stringify(setup)});`;
