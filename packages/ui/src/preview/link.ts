import {
  buildRenderPlan,
  channelOf,
  fitOf,
  samePlan,
  type ProjectState,
  type ProjectStore,
  type RenderLayer,
  type RenderPlan,
} from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import {
  layerWith,
  type ChannelChanges,
  type FromCompositor,
  type LayerChanges,
  type ToCompositor,
} from "@animaquill/render";
import { BUILT_IN_PROPERTIES, type PropertyValue } from "@animaquill/schema";
import type { DiagnosticsRecorder } from "../diagnostics/recorder.ts";
import type { MediaLibrary } from "../media/library.ts";
import type { PreviewedValues, PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";

/** Over this a frame misses the next refresh of a 60 Hz screen. */
const SLOW_FRAME_MS = 17;

type ShownValues = ReturnType<PreviewedValues["get"]>;

const NOTHING_SHOWN: PreviewedValues = new Map();

/** A property the way the compositor gets it. Null when it has nothing to go on. */
function channelFor(path: string, value: PropertyValue | undefined) {
  const spec = Object.hasOwn(BUILT_IN_PROPERTIES, path) ? BUILT_IN_PROPERTIES[path] : undefined;
  return (value !== undefined && spec && channelOf(value, spec.type)) || null;
}

/** What a layer needs to hear to go from showing one thing on top of its plan to another. */
function changesOf(
  layer: RenderLayer,
  was: ShownValues,
  now: ShownValues,
): LayerChanges | undefined {
  const channels: Record<string, ChannelChanges[string]> = {};
  let fit: RenderLayer["fit"] | undefined;
  let changed = false;
  for (const path of new Set([...(was?.keys() ?? []), ...(now?.keys() ?? [])])) {
    const shown = now?.has(path) === true;
    const value = now?.get(path);
    if (shown && was?.has(path) === true && was.get(path) === value) continue;
    changed = true;
    if (path === "fit") fit = shown ? fitOf(value === undefined ? {} : { fit: value }) : layer.fit;
    else channels[path] = shown ? channelFor(path, value) : (layer.channels[path] ?? null);
  }
  if (!changed) return undefined;
  return { channels, ...(fit === undefined ? {} : { fit }) };
}

/** A plan with something on top of it, for the compositor to start from. */
function withShown(plan: RenderPlan, shown: PreviewedValues): RenderPlan {
  if (shown.size === 0) return plan;
  const layers = plan.layers.map((layer) => {
    const changes = changesOf(layer, undefined, shown.get(layer.id));
    return changes ? layerWith(layer, changes) : layer;
  });
  return { ...plan, layers };
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
  #layers: ReadonlyMap<string, RenderLayer> = new Map();
  /** What the plan was last made from. */
  #planned: ProjectState | undefined;
  /** What the compositor has on top of the plan, by layer. */
  #shown = NOTHING_SHOWN;
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
      this.#planned = undefined;
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
    const state = this.#store.getState();
    this.#planned = state;
    const plan = buildRenderPlan(state, model.id);
    if (!plan || (this.#plan && samePlan(plan, this.#plan))) return;
    this.#plan = plan;
    this.#layers = new Map(plan.layers.map((layer) => [layer.id, layer]));
    // A new plan replaces everything. What is shown on top of it goes along, because the compositor
    // starts to draw as soon as it gets a plan, and the picture must not jump back in between.
    this.#shown = this.#properties.getPreviewed();
    this.#send({ type: "plan", plan: withShown(plan, this.#shown) });
  };

  /** Only what changed crosses over, because this happens with every move of a drag. */
  #sendPreview = (): void => {
    if (!this.#ready) return;
    // What ends a preview can be the project taking over its values. That comes first, whoever gets
    // to hear about it first, or the old values would show for a moment.
    if (this.#planned !== this.#store.getState()) this.#sendPlan();
    const previewed = this.#properties.getPreviewed();
    if (!this.#plan || previewed === this.#shown) return;
    for (const id of new Set([...this.#shown.keys(), ...previewed.keys()])) {
      const layer = this.#layers.get(id);
      const changes = layer && changesOf(layer, this.#shown.get(id), previewed.get(id));
      if (changes) this.#send({ type: "channels", layer: id, ...changes });
    }
    this.#shown = previewed;
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
