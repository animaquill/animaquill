/**
 * Measures the sound AI hears away from the page (`aq_audio_analyze`), see `SoundListens`: the mix
 * comes in pieces, the numbers go back once at the end.
 */
import { SoundMeter, type Measured, type MeterOptions } from "@animaquill/audio/meter";

export type MeterRequest =
  | { readonly kind: "start"; readonly options: MeterOptions }
  | { readonly kind: "piece"; readonly channels: readonly Float32Array[] }
  | { readonly kind: "end"; readonly envelope: boolean };

export type MeterAnswer =
  | { readonly kind: "done"; readonly measured: Measured }
  | { readonly kind: "failed"; readonly message: string };

let meter: SoundMeter | undefined;

addEventListener("message", (event: MessageEvent<MeterRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "start") meter = new SoundMeter(request.options);
    else if (request.kind === "piece") meter?.push(request.channels);
    else {
      const measured = meter?.result(request.envelope);
      meter = undefined;
      if (measured) postMessage({ kind: "done", measured } satisfies MeterAnswer);
      else postMessage({ kind: "failed", message: "nothing to measure" } satisfies MeterAnswer);
    }
  } catch (error) {
    meter = undefined;
    postMessage({
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    } satisfies MeterAnswer);
  }
});
