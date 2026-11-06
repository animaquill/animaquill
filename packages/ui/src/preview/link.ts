import {
  buildRenderPlan,
  channelOf,
  samePlan,
  type ProjectStore,
  type RenderPlan,
} from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import type { ChannelChanges, FromCompositor, ToCompositor } from "@animaquill/render";
import { BUILT_IN_PROPERTIES, type PropertyValue } from "@animaquill/schema";
import type { DiagnosticsRecorder } from "../diagnostics/recorder.ts";
import type { MediaLibrary } from "../media/library.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";

/** Over this a frame misses the next refresh of a 60 Hz screen. */
const SLOW_FRAME_MS = 17;

/** A property the way the compositor gets it. Null when it has nothing to go on. */
function channelFor(path: string, value: PropertyValue | undefined) {
  const spec = Object.hasOwn(BUILT_IN_PROPERTIES, path) ? BUILT_IN_PROPERTIES[path] : undefined;
  return (value !== undefined && spec && channelOf(value, spec.type)) || null;
}

/**
 * The line to the compositor in its sandbox. The sandbox has no network and no storage, so the plan,
 * the time and the files all go through here.
 */
export class PreviewLink {
  readonly #frame: HTMLIFrameElement;
  readonly #timeline: TimelineEditor;
  readonly #properties: PropertyWriter;
  readonly #store: ProjectStore;
  readonly #projects: ProjectLibrary;
  readonly #onProblem: (file: string) => void;
  readonly #diagnostics: DiagnosticsRecorder;
  #ready = false;
  #recording = false;
  #plan: RenderPlan | undefined;
  /** The properties the compositor has from a preview instead of from the plan, by layer. */
  #previewed = new Map<string, ReadonlySet<string>>();
  #stop = () => {};

  constructor(
    frame: HTMLIFrameElement,
    timeline: TimelineEditor,
    properties: PropertyWriter,
    store: ProjectStore,
    projects: ProjectLibrary,
    onProblem: (file: string) => void,
    diagnostics: DiagnosticsRecorder,
    media: MediaLibrary,
  ) {
    this.#frame = frame;
    this.#timeline = timeline;
    this.#properties = properties;
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
    // The compositor only asks for a file once.
    const stopMedia = media.onRestored((hash) => void this.#sendFile(hash));
    const stopProperties = properties.subscribe(this.#sendPreview);
    this.#stop = () => {
      stopProperties();
      stopStore();
      stopView();
      stopTimeline();
      stopDiagnostics();
      stopMedia();
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
      this.#previewed = new Map();
      this.#lastSeconds = undefined;
      this.#recording = false;
      this.#sendAll();
      this.#sendRecording();
    } else if (data.type === "frames") {
      for (const frame of data.frames) {
        const { ms, seconds, cold, behindMs, decodeMs, gettingReady, abandoned } = frame;
        const slow = ms > SLOW_FRAME_MS || cold > 0;
        const facts = {
          seconds,
          cold,
          behindMs: Math.round(behindMs),
          decodeMs: Math.round(decodeMs),
          gettingReady,
          abandoned,
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
    if (!plan || (this.#plan && samePlan(plan, this.#plan))) return;
    this.#plan = plan;
    this.#send({ type: "plan", plan });
    // A new plan replaces everything, and a drag that is still going on has to stay in the picture.
    this.#previewed = new Map();
    this.#sendPreview();
  };

  /** Only what changed crosses over, because this happens with every move of a drag. */
  #sendPreview = (): void => {
    if (!this.#ready || !this.#plan) return;
    const previewed = this.#properties.getPreviewed();
    for (const [layer, values] of previewed) {
      const channels: Record<string, ChannelChanges[string]> = {};
      for (const [path, value] of values) channels[path] = channelFor(path, value);
      this.#send({ type: "channels", layer, channels });
    }
    for (const [id, paths] of this.#previewed) {
      const left = [...paths].filter((path) => !previewed.get(id)?.has(path));
      const layer = this.#plan.layers.find((candidate) => candidate.id === id);
      if (left.length === 0 || !layer) continue;
      const channels = left.map((path) => [path, layer.channels[path] ?? null] as const);
      this.#send({ type: "channels", layer: id, channels: Object.fromEntries(channels) });
    }
    this.#previewed = new Map(
      [...previewed].map(([layer, values]) => [layer, new Set(values.keys())]),
    );
  };

  #lastSeconds: number | undefined;
  #lastPlayback: TimelineEditor["playbackStart"];

  #sendTime = (): void => {
    const { model, frame, playbackStart } = this.#timeline;
    if (!this.#ready || !model) return;
    // Moving the playhead while playing starts playing over from there.
    const { playing } = this.#timeline.getSnapshot();
    const carried = playing && playbackStart && playbackStart === this.#lastPlayback;
    this.#lastPlayback = playbackStart;
    const seconds = frame / model.rate.fps;
    if (seconds === this.#lastSeconds) return;
    this.#lastSeconds = seconds;
    this.#send({ type: "seek", seconds, jump: !carried });
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
