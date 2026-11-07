import { MESSAGE_RULES, MessageBudget, type MessageRules } from "./budget.ts";
import type { OriginPool } from "./origins.ts";
import { SCENE_PAGE_PATH, SCENE_SANDBOX } from "./policy.ts";
import {
  readFromScene,
  readSamples,
  readSoundFailure,
  RUNTIME_VERSION,
  type SceneProblem,
  type SoundFailureReason,
  type SoundLoad,
  type SoundSamples,
  type ToScene,
} from "./protocol.ts";

/** On top of the time of the code: a page to load and a project to read. */
export const SOUND_START_LIMIT_MS = 20_000;

/**
 * How long a frame stays for what it made to be read. A blob gets to the browser bit by bit, from
 * the process that made it, so that process has to be there until somebody has all of it.
 */
const HOLD_MS = 120_000;

/** The most problems one sound gets to report. */
const MAX_PROBLEMS = 20;

export type SoundOutcome =
  | ({ readonly ok: true } & SoundSamples)
  | { readonly ok: false; readonly reason: SoundFailureReason };

export interface SoundHostOptions {
  /** Where the frame goes. */
  readonly mount: HTMLElement;
  readonly origins: OriginPool;
  /** The code of the runtime, from `virtual:animaquill-sound-runtime`. */
  readonly runtime: Blob;
  readonly load: SoundLoad;
  readonly onProblem?: (problem: SceneProblem) => void;
  readonly messageRules?: MessageRules;
}

/**
 * One sound being made, seen from the compositor. It takes a frame on the sites scenes run on, and
 * the code of the project runs in a worker in there. So code that never ends takes a core and
 * nothing else: the page in the frame goes on answering and ends the worker when time is up, the
 * origin stays usable, and only a frame that gets that wrong counts as one that hung.
 *
 * What comes out of the frame gets looked at like what comes out of a scene. Only the samples are
 * large, and those are a blob of the size that was asked for or nothing at all.
 */
export class SoundHost {
  readonly #options: SoundHostOptions;
  readonly #problems = new Set<string>();
  #frame: HTMLIFrameElement | undefined;
  #origin: string | undefined;
  #budget: MessageBudget | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #done: ((outcome: SoundOutcome | undefined) => void) | undefined;

  constructor(options: SoundHostOptions) {
    this.#options = options;
  }

  /** Finishes with what came out, or with nothing when somebody cancelled it. */
  run(): Promise<SoundOutcome | undefined> {
    const { mount, origins, messageRules = MESSAGE_RULES } = this.#options;
    const finished = new Promise<SoundOutcome | undefined>((done) => {
      this.#done = done;
    });
    const origin = origins.take();
    if (origin === undefined) {
      this.#finish({ ok: false, reason: "no-origin" });
      return finished;
    }
    this.#origin = origin;
    this.#budget = new MessageBudget(performance.now(), messageRules);
    addEventListener("message", this.#onMessage);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", SCENE_SANDBOX);
    frame.src = `${origin}${SCENE_PAGE_PATH}`;
    // Nothing shows here, and a worker does not care.
    frame.style.display = "none";
    frame.tabIndex = -1;
    mount.append(frame);
    this.#frame = frame;
    // A browser that does not say who is around a page gets no further than hello, see the page.
    this.#timer = setTimeout(
      () => this.#finish({ ok: false, reason: "silent" }),
      SOUND_START_LIMIT_MS,
    );
    return finished;
  }

  /** From here on the page ends what runs. What keeps it from doing that can outlast the frame. */
  #started(): void {
    const { origins, load } = this.#options;
    const origin = this.#origin;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (origin !== undefined) origins.retire(origin);
      this.#finish({ ok: false, reason: "silent" });
    }, load.limitMs + SOUND_START_LIMIT_MS);
  }

  cancel(): void {
    this.#finish(undefined);
  }

  /** Whoever got the samples has read them, so the frame that made them can go. */
  release(): void {
    this.#finish(undefined);
  }

  #finish(outcome: SoundOutcome | undefined): void {
    removeEventListener("message", this.#onMessage);
    clearTimeout(this.#timer);
    this.#frame?.remove();
    this.#frame = undefined;
    if (this.#origin !== undefined) this.#options.origins.give(this.#origin);
    this.#origin = undefined;
    this.#done?.(outcome);
    this.#done = undefined;
  }

  #send(message: ToScene): void {
    // A sandboxed page has no origin to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
    this.#frame?.contentWindow?.postMessage(message, "*");
  }

  /** Nothing here may touch `event.data` before the budget has had its say, see `SceneHost`. */
  #onMessage = (event: MessageEvent): void => {
    const budget = this.#budget;
    if (!budget || !this.#frame || event.source !== this.#frame.contentWindow) return;
    const now = performance.now();
    const admitted = budget.admit(now);
    if (admitted !== "ok") {
      this.#finish({ ok: false, reason: "flood" });
      return;
    }
    const data: unknown = event.data;
    if ((data as { readonly type?: unknown } | null)?.type === "samples") {
      this.#samples(data);
      return;
    }
    const weighed = budget.weigh(data, now);
    if (weighed !== "ok") {
      this.#finish({ ok: false, reason: weighed });
      return;
    }
    this.#handle(data);
  };

  #samples(data: unknown): void {
    const samples = readSamples(data, this.#options.load);
    if (!samples) {
      this.#finish({ ok: false, reason: "bad-result" });
      return;
    }
    // Nothing more comes from there that anybody needs, but the frame has to stay a while.
    removeEventListener("message", this.#onMessage);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.release(), HOLD_MS);
    this.#done?.({ ok: true, ...samples });
    this.#done = undefined;
  }

  #handle(data: unknown): void {
    const message = readFromScene(data);
    if (message?.type === "hello") {
      const { runtime, load } = this.#options;
      this.#send({ type: "boot", runtime: RUNTIME_VERSION, code: runtime, scene: load });
    } else if (message?.type === "ready") {
      this.#started();
    } else if (message?.type === "failed") {
      this.#finish({ ok: false, reason: readSoundFailure(message.message) });
    } else if (message?.type === "problem") {
      this.#problem(message.problem);
    }
  }

  #problem(problem: SceneProblem): void {
    const { kind, code, message, file, line } = problem;
    const key = JSON.stringify([kind, code, message, file, line]);
    if (this.#problems.has(key) || this.#problems.size >= MAX_PROBLEMS) return;
    this.#problems.add(key);
    this.#options.onProblem?.(problem);
  }
}
