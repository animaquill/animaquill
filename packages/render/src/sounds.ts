import { OriginPool, SoundHost, type SoundHostOptions, type SoundOutcome } from "@animaquill/scene";
import type { FromCompositor, SceneSetup, ToCompositor } from "./index.ts";

type SoundMessage = Extract<
  ToCompositor,
  { type: "sound-make" | "sound-cancel" | "sound-release" }
>;

/** What this needs of a sound being made. */
export type Host = Pick<SoundHost, "run" | "cancel" | "release">;

export interface SoundJobsOptions {
  /** Where frames go. */
  readonly mount: HTMLElement;
  /** The code that runs around a sound, only made when one needs it. */
  readonly runtime: () => Blob;
  readonly send: (message: FromCompositor, transfer?: Transferable[]) => void;
  readonly makeHost?: (options: SoundHostOptions) => Host;
}

/**
 * Sounds being made, seen from the compositor, which is the only place that can reach the sites
 * they run on. The editor decides what gets made and when, and this just does what it says. What
 * comes out goes on to the editor as it is: it has to look at that itself.
 */
export class SoundJobs {
  readonly #options: SoundJobsOptions;
  readonly #running = new Map<number, Host>();
  /** What made samples that the editor has not read yet. */
  readonly #held = new Map<number, Host>();
  #origins: OriginPool | undefined;

  constructor(options: SoundJobsOptions) {
    this.#options = options;
  }

  /** Whether a message is for this and nobody else. The setup is for others as well. */
  handle(message: ToCompositor): message is SoundMessage {
    if (message.type === "setup") this.#setUp(message);
    else if (message.type === "sound-make") void this.#make(message);
    else if (message.type === "sound-cancel") this.#cancel(message.request);
    else if (message.type === "sound-release") this.#release(message.request);
    return (
      message.type === "sound-make" ||
      message.type === "sound-cancel" ||
      message.type === "sound-release"
    );
  }

  /**
   * Sounds go through the sites from the other end. Scenes of the preview have a pool of their own
   * and start at the front, and a sound that takes all the memory should not take a scene along.
   */
  #setUp({ origins, compositor, retired = [] }: SceneSetup): void {
    if (origins.length === 0) return;
    const onRetire = (origin: string) => this.#options.send({ type: "origin-retired", origin });
    this.#origins = new OriginPool(origins.toReversed(), compositor, { retired, onRetire });
  }

  #cancel(request: number): void {
    this.#running.get(request)?.cancel();
    this.#release(request);
  }

  #release(request: number): void {
    this.#held.get(request)?.release();
    this.#held.delete(request);
  }

  async #make({ request, load }: Extract<SoundMessage, { type: "sound-make" }>): Promise<void> {
    const { mount, runtime, send, makeHost = (options) => new SoundHost(options) } = this.#options;
    const origins = this.#origins;
    if (!origins) {
      send({ type: "sound-failed", request, reason: "no-origin" });
      return;
    }
    const host = makeHost({
      mount,
      origins,
      runtime: runtime(),
      load,
      onProblem: (problem) => send({ type: "sound-problem", request, problem }),
    });
    this.#running.set(request, host);
    const outcome = await host.run();
    this.#running.delete(request);
    if (outcome?.ok) this.#held.set(request, host);
    if (outcome) this.#answer(request, outcome);
  }

  #answer(request: number, outcome: SoundOutcome): void {
    const { send } = this.#options;
    if (outcome.ok) {
      const { channels, frames, samples } = outcome;
      send({ type: "sound-done", request, channels, frames, samples });
    } else send({ type: "sound-failed", request, reason: outcome.reason });
  }
}
