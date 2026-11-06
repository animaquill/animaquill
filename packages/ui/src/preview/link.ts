import { buildRenderPlan, type ProjectStore, type RenderPlan } from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import type { FromCompositor, ToCompositor } from "@animaquill/render";
import type { TimelineEditor } from "../timeline/editor.ts";

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
  #ready = false;
  #plan: RenderPlan | undefined;
  #stop = () => {};

  constructor(
    frame: HTMLIFrameElement,
    timeline: TimelineEditor,
    store: ProjectStore,
    projects: ProjectLibrary,
    onProblem: (file: string) => void,
  ) {
    this.#frame = frame;
    this.#timeline = timeline;
    this.#store = store;
    this.#projects = projects;
    this.#onProblem = onProblem;
    addEventListener("message", this.#onMessage);
    const stopStore = store.subscribe(this.#sendPlan);
    const stopView = timeline.subscribeView(this.#sendTime);
    // The timeline may get its model after the compositor said hello.
    const stopTimeline = timeline.subscribe(this.#sendAll);
    this.#stop = () => {
      stopStore();
      stopView();
      stopTimeline();
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
      this.#sendAll();
    } else if (data.type === "needs") {
      void this.#sendFile(data.id);
    } else if (data.type === "cannot-decode") {
      this.#onProblem(data.id);
    }
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
