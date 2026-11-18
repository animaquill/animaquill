import { portMixer, SoundMixer, type MixerOptions, type MixPort } from "@animaquill/audio";
import type { MixPlan } from "@animaquill/core";
import type { PieceMixer } from "./sound.ts";

/**
 * A mixer for the export and for what AI hears: in a worker (`mix-worker.ts`), so that mixing and
 * resampling do not hold up the page; here where there are no workers.
 */
export function workerMixer(
  plan: MixPlan,
  options: Pick<MixerOptions, "fileOf" | "source">,
): PieceMixer & { readonly silent: boolean } {
  if (typeof Worker === "undefined") return new SoundMixer(plan, options);
  const worker = new Worker(new URL("./mix-worker.ts", import.meta.url), { type: "module" });
  const mixer = portMixer(worker as unknown as MixPort, plan, options, () => worker.terminate());
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    mixer.fail(new Error(event.message || "the worker that mixes sound stopped"));
  });
  return mixer;
}
