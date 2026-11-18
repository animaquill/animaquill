import type { MixerMessage, MixerReport } from "./engine/mixer-core.ts";
import { MIX_CHANNELS } from "./mix.ts";

/** The mixer of the preview in the audio thread (`mixer-worklet.ts`), as the page talks to it. */
export interface MixerNode {
  /** What it plays, to connect to the speakers or to what keeps the pitch. */
  readonly output: AudioNode;
  send(message: MixerMessage, transfer?: Transferable[]): void;
  /** Hears what the mixer says, from now on. */
  listen(handler: (report: MixerReport) => void): void;
}

/** What the worklet registers itself as. */
const PROCESSOR = "aq-mixer";

/**
 * Puts the worklet of `moduleUrl` (from `mixer-worklet.ts`) into a context and makes its mixer.
 * Rejects when the browser cannot.
 */
export async function createMixer(
  context: BaseAudioContext,
  moduleUrl: string,
): Promise<MixerNode> {
  await context.audioWorklet.addModule(moduleUrl);
  const node = new AudioWorkletNode(context, PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [MIX_CHANNELS],
  });
  const { port } = node;
  const handlers: ((report: MixerReport) => void)[] = [];
  port.addEventListener("message", ({ data }: MessageEvent<MixerReport>) => {
    for (const handler of handlers) handler(data);
  });
  port.start();
  return {
    output: node,
    send: (message, transfer = []) => port.postMessage(message, transfer),
    listen: (handler) => handlers.push(handler),
  };
}
