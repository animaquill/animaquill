/**
 * Keeps the pitch of sound that plays faster or slower, with Signalsmith Stretch (MIT) in the audio
 * thread. Sound played at twice the speed comes in an octave too high, and goes out shifted down by
 * as much: what comes out is as fast, at the pitch it has. Backwards it is the same, because the
 * samples go in backwards.
 */
export interface PitchKeeper {
  /** Where sound goes in, on its way to the speakers. */
  readonly input: AudioNode;
  /** Seconds it holds sound back, which whoever schedules sound has to start that much earlier. */
  readonly latency: number;
  /** Shifts what comes in by semitones from now on, or stops shifting and lets nothing through. */
  shift(semitones: number | undefined): void;
}

/** How far to shift sound that plays at a speed, to have its own pitch again. */
export const semitonesFor = (speed: number): number => -12 * Math.log2(speed);

/** What the worklet registers itself as, see `stretch-worklet.ts`. */
const PROCESSOR = "signalsmith-stretch";

/** The worklet needs time to compile, and answers this soon once it has. */
const READY_MS = 5000;

const added = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * Puts the worklet of `moduleUrl` (from `stretch-worklet.ts`) into a context and makes a keeper
 * that goes to its speakers. Rejects when the browser cannot, so that sound plays without it.
 */
export async function createPitchKeeper(
  context: BaseAudioContext,
  moduleUrl: string,
): Promise<PitchKeeper> {
  let adding = added.get(context);
  if (!adding) {
    adding = context.audioWorklet.addModule(moduleUrl);
    added.set(context, adding);
  }
  await adding;
  const node = new AudioWorkletNode(context, PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const port = connect(node.port);
  await port.ready;
  const latency = Number(await port.call("latency")) || 0;
  const input = context.createGain();
  input.connect(node);
  node.connect(context.destination);
  port.call("schedule", { active: false, output: context.currentTime });
  return {
    input,
    latency,
    shift(semitones) {
      const output = context.currentTime;
      if (semitones === undefined) port.call("schedule", { active: false, output });
      else port.call("schedule", { active: true, semitones, output });
    },
  };
}

/** The messages of the worklet: `[id, method, ...args]` there, `[id, result]` back. */
function connect(port: MessagePort) {
  const waiting = new Map<number, (value: unknown) => void>();
  let next = 0;
  let readyNow: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyNow = resolve;
    setTimeout(() => reject(new Error("The pitch keeper did not start")), READY_MS);
  });
  port.addEventListener("message", ({ data }: MessageEvent<readonly unknown[]>) => {
    const [id, value] = data;
    if (id === "ready") readyNow();
    if (typeof id !== "number") return;
    waiting.get(id)?.(value);
    waiting.delete(id);
  });
  port.start();
  return {
    ready,
    call(method: string, ...args: readonly unknown[]): Promise<unknown> {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        port.postMessage([id, method, ...args]);
      });
    },
  };
}
