import { buildRenderPlan, type ProjectStore, type RenderPlan } from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import type { FromCompositor, ToCompositor } from "@animaquill/render";
import type { DiagnosticsRecorder } from "../diagnostics/recorder.ts";
import type { TimelineEditor } from "../timeline/editor.ts";

/** Over this a frame misses the next refresh of a 60 Hz screen. */
const SLOW_FRAME_MS = 17;

/**
 * The line to the compositor in its sandbox. The sandbox has no network and no storage, so the plan,
 * the time and the files all go through here.
 */
export class PreviewLink {
  readonly #frame: HTMLIFrameElement;
  readonly #timeline: TimelineEditor;
  readonly #store: ProjectStore;
  readonly #projects: ProjectLibrary;
  readonly #onProblem: (file: string) => void;
  readonly #diagnostics: DiagnosticsRecorder;
  #ready = false;
  #recording = false;
  #plan: RenderPlan | undefined;
  #stop = () => {};

  constructor(
    frame: HTMLIFrameElement,
    timeline: TimelineEditor,
    store: ProjectStore,
    projects: ProjectLibrary,
    onProblem: (file: string) => void,
    diagnostics: DiagnosticsRecorder,
  ) {
    this.#frame = frame;
    this.#timeline = timeline;
    this.#store = store;
    this.#projects = projects;
    this.#onProblem = onProblem;
    this.#diagnostics = diagnostics;
    addEventListener("message", this.#onMessage);
    const stopStore = store.subscribe(this.#sendPlan);
    const stopView = timeline.subscribeView(this.#sendTime);
    // The timeline may get its model after the compositor said hello.
    const stopTimeline = timeline.subscribe(this.#sendAll);
    const stopDiagnostics = diagnostics.subscribe(this.#sendRecording);
    this.#stop = () => {
      stopStore();
      stopView();
      stopTimeline();
      stopDiagnostics();
      removeEventListener("message", this.#onMessage);
    };
  }

  dispose(): void {
    this.#stop();
  }

  #send(message: ToCompositor): void {
    // The sandbox has no origin of its own to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
    this.#frame.contentWindow?.postMessage(message, "*");
  }

  #onMessage = ({ data, source }: MessageEvent<FromCompositor>): void => {
    if (source !== this.#frame.contentWindow) return;
    if (data.type === "ready") {
      // A page that loaded again knows nothing.
      this.#ready = true;
      this.#plan = undefined;
      this.#lastSeconds = undefined;
      this.#recording = false;
      this.#sendAll();
      this.#sendRecording();
    } else if (data.type === "frames") {
      for (const { ms, seconds, cold, behindMs, decodeMs, gettingReady } of data.frames) {
        const slow = ms > SLOW_FRAME_MS || cold > 0;
        const facts = {
          seconds,
          cold,
          behindMs: Math.round(behindMs),
          decodeMs: Math.round(decodeMs),
          gettingReady,
        };
        this.#diagnostics.noteFrame(ms, facts, slow);
      }
    } else if (data.type === "needs") {
      void this.#sendFile(data.id);
    } else if (data.type === "cannot-decode") {
      this.#onProblem(data.id);
    }
  };

  #sendRecording = (): void => {
    const on = this.#diagnostics.getRecording();
    if (!this.#ready || on === this.#recording) return;
    this.#recording = on;
    this.#send({ type: "record", on });
  };

  #sendAll = (): void => {
    this.#sendPlan();
    this.#sendTime();
  };

  #sendPlan = (): void => {
    const { model } = this.#timeline;
    if (!this.#ready || !model) return;
    const plan = buildRenderPlan(this.#store.getState(), model.id);
    if (!plan || JSON.stringify(plan) === JSON.stringify(this.#plan)) return;
    this.#plan = plan;
    this.#send({ type: "plan", plan });
  };

  #lastSeconds: number | undefined;

  #sendTime = (): void => {
    const { model, frame } = this.#timeline;
    if (!this.#ready || !model) return;
    const seconds = frame / model.rate.fps;
    if (seconds === this.#lastSeconds) return;
    this.#lastSeconds = seconds;
    this.#send({ type: "seek", seconds });
  };

  /** The sandbox will run code from projects one day, so it only gets what the plan uses. */
  async #sendFile(id: string): Promise<void> {
    const used = this.#plan?.layers.some(
      ({ source }) => source.kind !== "color" && source.file === id,
    );
    if (!used) return;
    const project = this.#store.getState().manifest.id;
    const file = await this.#projects.media(project).get(id);
    if (file) this.#send({ type: "file", id, file });
    else this.#onProblem(id);
  }
}
