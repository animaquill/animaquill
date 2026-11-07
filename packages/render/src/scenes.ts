import type { RenderLayer, RenderPlan, SceneSource } from "@animaquill/core";
import { boxOf, clockOf } from "@animaquill/core/view";
import {
  OriginPool,
  RUNTIME_VERSION,
  SceneHost,
  type SceneFailure,
  type SceneHostOptions,
  type SceneHostState,
  type SceneProblem,
  type SceneView,
  type TimeBase,
} from "@animaquill/scene";
import { comesUpAfter, showsAt } from "./cursor.ts";
import type { FromCompositor, PlayBase, SceneSetup, SceneStatus, ToCompositor } from "./index.ts";

/** A moment that is this close to a frame is that frame: seconds are floats, frames are not. */
const FRAME_TOLERANCE = 1e-6;

/** Going over a clip and back again should not cost a new process each way. */
const LINGER_MS = 3000;

/**
 * Frames of scenes have to show at least a pixel on the screen, or the browser stops running them.
 * They go on a diagonal in the corner, so that none of them covers the pixel of another.
 */
const CORNER_SLOTS = 16;

/** How long a frame of the screen takes at most, on this page, when it is on the screen at all. */
const SCREEN_FRAME_MS = 250;

/** What a canvas can have. A clip box can be anything, and a scene is not worth losing the tab. */
const MAX_PICTURE_SIDE = 8192;

/** What this takes care of. */
type SceneMessage = Extract<
  ToCompositor,
  { type: "setup" | "scene-files" | "scene-retry" | "evict" | "play" | "pause" }
>;

/** What this needs of a scene. */
export type Host = Pick<
  SceneHost,
  "open" | "close" | "seek" | "play" | "pause" | "evict" | "focusTaken" | "state" | "origin"
>;

export interface SceneLayersOptions {
  /** Where frames go. */
  readonly mount: HTMLElement;
  /** The code that runs in a scene, only made when a scene needs it. */
  readonly runtime: () => Blob;
  readonly send: (message: FromCompositor) => void;
  /** There is something new to show. */
  readonly redraw: () => void;
  readonly makeHost?: (options: SceneHostOptions) => Host;
  readonly linger?: (run: () => void, ms: number) => () => void;
}

/** One picture of a scene, which stays usable for as long as somebody holds on to it. */
export class HeldPicture {
  readonly image: ImageBitmap;
  #holders = 0;
  #replaced = false;

  constructor(image: ImageBitmap) {
    this.image = image;
  }

  hold(): this {
    this.#holders += 1;
    return this;
  }

  release = (): void => {
    this.#holders -= 1;
    this.#closeIfDone();
  };

  /** A newer one came. A frame being drawn may still need this one. */
  replace(): void {
    this.#replaced = true;
    this.#closeIfDone();
  }

  #closeIfDone(): void {
    if (this.#replaced && this.#holders === 0) this.image.close();
  }
}

/** What a scene gets to run, once it came from the editor. */
interface SceneContent {
  readonly files: ReadonlyMap<string, Blob>;
  readonly assets: ReadonlyMap<string, Blob>;
}

/** A scene that was started for a layer, in one state of the project. */
interface Run {
  readonly key: string;
  readonly host: Host;
  /** The frame it was last sent to. Undefined while it follows the time. */
  frame: number | undefined;
}

/** A clip with a scene. It can have two runs: the new one takes over when it has a picture. */
interface Entry {
  layer: RenderLayer;
  current: Run | undefined;
  next: Run | undefined;
  picture: HeldPicture | undefined;
  status: SceneStatus;
  stopLingering: (() => void) | undefined;
}

/** What failed for good, which stays out until it changes or somebody asks, wherever people go. */
interface Failed {
  readonly key: string;
  readonly status: SceneStatus;
}

const isScene = (layer: RenderLayer): layer is RenderLayer & { source: SceneSource } =>
  layer.source.kind === "scene";

const contentKey = ({ scene, revision }: Pick<SceneSource, "scene" | "revision">) =>
  `${scene}\n${revision}`;

/**
 * Runs something if this page is on the screen right now. Behind another tab nothing gets painted,
 * also in the scenes, which nobody can see and nobody needs to hear. The page cannot ask whether it
 * shows, but it gets no frames of the screen either.
 */
function whenOnScreen(run: () => void): void {
  const frame = requestAnimationFrame(() => {
    clearTimeout(timer);
    run();
  });
  const timer = setTimeout(() => cancelAnimationFrame(frame), SCREEN_FRAME_MS);
}

/** What frame a scene is on when the clock of its clip reads this. */
export function frameOf(clock: number, { num, den }: RenderPlan["scenes"]["fps"]): number {
  return Math.max(Math.floor((clock * num) / den + FRAME_TOLERANCE), 0);
}

/** One unit of the world is one CSS pixel, and the picture has the pixels of the output. */
export function viewOf(layer: RenderLayer, plan: RenderPlan): SceneView {
  const box = boxOf(layer, layer.start, undefined, plan.stage);
  const width = Math.max(box.width, 1);
  const height = Math.max(box.height, 1);
  const wanted = plan.width / plan.stage.width;
  const pixelRatio = Math.min(wanted, MAX_PICTURE_SIDE / Math.max(width, height));
  return {
    width,
    height,
    pixelRatio,
    format: plan.scenes.format,
    language: plan.scenes.language,
  };
}

/** How a scene follows a time base from its own point of view. */
export function baseFor(layer: RenderLayer, plan: RenderPlan, base: PlayBase): TimeBase {
  const { fps } = plan.scenes;
  const { rate } = base;
  // It waits for its clip, and the frames of a clip start on the first one of the clip.
  const from = Math.max(base.seconds, layer.start);
  const at = base.at + ((from - base.seconds) * 1000) / (rate || 1);
  const exact = (clockOf(layer, from) * fps.num) / fps.den;
  const frame = frameOf(clockOf(layer, from), fps);
  const late = ((exact - frame) * fps.den * 1000) / fps.num / (rate || 1);
  return { frame, at: at - late, rate };
}

/**
 * The scenes of a plan, seen from the compositor: which ones have to be running, where they are in
 * time, and what they look like now. A scene is made ready before its clip comes up, like a video,
 * and goes away when its clip is out of reach. `SceneHost` takes care of one scene getting replaced
 * by itself. What happens here is for when the project changed: the new one starts next to the old
 * one, on another origin, and takes over when there is something to show.
 */
export class SceneLayers {
  readonly #options: SceneLayersOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #contents = new Map<string, SceneContent>();
  readonly #asked = new Set<string>();
  readonly #failed = new Map<string, Failed>();
  #setup: SceneSetup | undefined;
  #origins: OriginPool | undefined;
  #plan: RenderPlan | undefined;
  #seconds = 0;
  #base: PlayBase | undefined;
  /** False once a page said that this browser cannot capture. */
  #canCapture = true;
  #nextSlot = 0;

  constructor(options: SceneLayersOptions) {
    this.#options = options;
  }

  /** Whether a message is for this. Whoever calls this keeps the rest. */
  handle(message: ToCompositor): message is SceneMessage {
    switch (message.type) {
      case "setup":
        this.#setup = message;
        this.#origins = this.#poolOf(message);
        this.#follow();
        return true;
      case "scene-files":
        this.#contents.set(contentKey(message), message);
        this.#follow();
        return true;
      case "scene-retry":
        this.#retry(message.layer);
        return true;
      case "evict":
        this.#evict(message.index, message.frames);
        return true;
      case "play":
        this.#play(message);
        return true;
      case "pause":
        this.#pause();
        return true;
      default:
        return false;
    }
  }

  #poolOf({ origins, compositor, retired = [] }: SceneSetup): OriginPool | undefined {
    if (origins.length === 0) return undefined;
    const onRetire = (origin: string) => this.#options.send({ type: "origin-retired", origin });
    return new OriginPool(origins, compositor, { retired, onRetire });
  }

  /** The plan or the time changed. Curves that changed count too: a box can get another size. */
  follow(plan: RenderPlan | undefined, seconds: number): void {
    this.#plan = plan;
    this.#seconds = seconds;
    this.#follow();
  }

  /** The newest picture of a layer, to hold on to until it has been drawn. */
  pictureOf(layer: string): HeldPicture | undefined {
    return this.#entries.get(layer)?.picture?.hold();
  }

  /** Whether a layer has no picture and is not going to get one for now. */
  showsPlaceholder(layer: string): boolean {
    const entry = this.#entries.get(layer);
    if (!entry || entry.picture) return false;
    const { state } = entry.status;
    const blocked = state === "unsupported" || state === "too-new" || state === "off";
    return blocked || state === "stopped" || this.#setup?.stage === "plain";
  }

  /** Something in here took the keyboard, and only a host can tell whose it was. */
  focusTaken(): void {
    for (const run of this.#runs()) run.host.focusTaken();
  }

  *#runs(): Generator<Run> {
    for (const { current, next } of this.#entries.values()) {
      if (current) yield current;
      if (next) yield next;
    }
  }

  /** When frames came or went since, this is another one now. It gets reported again if it goes on. */
  #evict(index: number, frames: number): void {
    if (window.length !== frames) return;
    const source = (window as unknown as Record<number, Window | undefined>)[index];
    if (!source) return;
    for (const run of this.#runs()) run.host.evict(source, "flood");
  }

  #setStatus(entry: Entry, status: SceneStatus): void {
    const { state, reason } = entry.status;
    if (state === status.state && reason === status.reason) return;
    entry.status = status;
    this.#options.send({ type: "scene-status", layer: entry.layer.id, status });
  }

  /** Which layers need a scene now: those on the picture, and those that are about to be. */
  #wanted(): readonly (RenderLayer & { source: SceneSource })[] {
    const seconds = this.#seconds;
    const layers = this.#plan?.layers ?? [];
    return layers
      .filter(isScene)
      .filter((layer) => showsAt(layer, seconds) || comesUpAfter(layer, seconds));
  }

  #follow(): void {
    const plan = this.#plan;
    if (!plan || !this.#setup) return;
    const wanted = this.#wanted();
    const ids = new Set(wanted.map(({ id }) => id));
    for (const entry of this.#entries.values()) {
      if (!ids.has(entry.layer.id)) this.#leave(entry);
    }
    for (const layer of wanted) this.#keepUp(layer, plan);
    this.#forgetContent();
    if (!this.#base) for (const entry of this.#entries.values()) this.#seek(entry, plan);
  }

  /** The clip left the part of the timeline that counts, so its scene goes after a moment. */
  #leave(entry: Entry): void {
    if (entry.stopLingering) return;
    const linger = this.#options.linger ?? this.#lingerByTimer;
    entry.stopLingering = linger(() => this.#close(entry), LINGER_MS);
  }

  #lingerByTimer = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  };

  #close(entry: Entry): void {
    entry.stopLingering?.();
    entry.current?.host.close();
    entry.next?.host.close();
    entry.picture?.replace();
    this.#entries.delete(entry.layer.id);
    this.#options.send({
      type: "scene-status",
      layer: entry.layer.id,
      status: { state: "closed" },
    });
  }

  #keepUp(layer: RenderLayer & { source: SceneSource }, plan: RenderPlan): void {
    const entry = this.#entryOf(layer);
    const wasGoing = entry.stopLingering !== undefined;
    const moved = entry.layer.start !== layer.start || entry.layer.offset !== layer.offset;
    entry.stopLingering?.();
    entry.stopLingering = undefined;
    entry.layer = layer;
    if ((wasGoing || (moved && this.#base)) && entry.current) {
      this.#startMoving(entry, entry.current, plan);
    }
    const blocked = this.#blocked(layer);
    if (blocked) {
      this.#setStatus(entry, { state: blocked });
      return;
    }
    const key = this.#keyOf(layer, plan);
    const failed = this.#failed.get(layer.id);
    if (failed?.key === key) {
      this.#setStatus(entry, failed.status);
      return;
    }
    if (entry.current?.key === key || entry.next?.key === key) return;
    const content = this.#contentOf(layer.source);
    if (!content) return;
    this.#failed.delete(layer.id);
    entry.next?.host.close();
    entry.next = undefined;
    const run = this.#start(entry, key, content, plan);
    if (entry.current) entry.next = run;
    else entry.current = run;
  }

  #entryOf(layer: RenderLayer): Entry {
    const known = this.#entries.get(layer.id);
    if (known) return known;
    const entry: Entry = {
      layer,
      current: undefined,
      next: undefined,
      picture: undefined,
      status: { state: "opening" },
      stopLingering: undefined,
    };
    this.#entries.set(layer.id, entry);
    this.#options.send({ type: "scene-status", layer: layer.id, status: entry.status });
    return entry;
  }

  /** Why a scene does not get started at all. */
  #blocked({ source }: { readonly source: SceneSource }): SceneStatus["state"] | undefined {
    if (this.#setup?.run === false) return "off";
    if (source.runtime > RUNTIME_VERSION) return "too-new";
    return this.#canCapture && this.#origins ? undefined : "unsupported";
  }

  /** Whatever makes a scene another one, which is what takes a new document. */
  #keyOf(layer: RenderLayer & { source: SceneSource }, plan: RenderPlan): string {
    const { width, height, pixelRatio } = viewOf(layer, plan);
    const { format, language, fps } = plan.scenes;
    return JSON.stringify([
      layer.source,
      width,
      height,
      pixelRatio,
      format,
      language,
      fps.num,
      fps.den,
    ]);
  }

  #contentOf(source: SceneSource): SceneContent | undefined {
    const key = contentKey(source);
    const content = this.#contents.get(key);
    if (content) return content;
    if (!this.#asked.has(key)) {
      this.#asked.add(key);
      const { scene, revision } = source;
      this.#options.send({ type: "needs-scene", scene, revision });
    }
    return undefined;
  }

  /** What no layer needs any more stays out of memory. A running scene has its own copy. */
  #forgetContent(): void {
    const keep = new Set(
      this.#plan?.layers.filter(isScene).map(({ source }) => contentKey(source)),
    );
    for (const key of this.#contents.keys()) {
      if (!keep.has(key)) {
        this.#contents.delete(key);
        this.#asked.delete(key);
      }
    }
  }

  #place(frame: HTMLIFrameElement, { width, height }: SceneView): void {
    const slot = this.#nextSlot % CORNER_SLOTS;
    this.#nextSlot += 1;
    Object.assign(frame.style, {
      position: "fixed",
      left: `calc(100vw - ${slot + 1}px)`,
      top: `calc(100vh - ${CORNER_SLOTS - slot}px)`,
      width: `${width}px`,
      height: `${height}px`,
      border: "0",
    });
  }

  #start(entry: Entry, key: string, content: SceneContent, plan: RenderPlan): Run {
    const { layer } = entry;
    const { source } = layer as RenderLayer & { source: SceneSource };
    const view = viewOf(layer, plan);
    const avoid = entry.current?.host.origin;
    const { num, den } = plan.scenes.fps;
    const { stage } = this.#setup as SceneSetup;
    let run: Run | undefined;
    const options: SceneHostOptions = {
      mount: this.#options.mount,
      origins: this.#origins as OriginPool,
      runtime: this.#options.runtime(),
      load: {
        entry: source.entry,
        files: content.files,
        assets: content.assets,
        fps: { num, den },
        seed: source.seed,
        view,
      },
      ...(stage && { stage }),
      ...(avoid !== undefined && { avoid }),
      place: (frame) => this.#place(frame, view),
      onState: (state) => run && this.#onState(entry, run, state),
      onProblem: (problem) => this.#onProblem(entry, problem),
      onFailure: (failure) => run && this.#onFailure(entry, run, failure),
      onPicture: ({ image }) => {
        if (run) this.#onPicture(entry, run, new HeldPicture(image));
        else image.close();
      },
    };
    const host = (this.#options.makeHost ?? ((all) => new SceneHost(all)))(options);
    const started: Run = { key, host, frame: undefined };
    run = started;
    void host.open();
    this.#startMoving(entry, started, plan);
    return started;
  }

  /** Time only goes forwards by itself, so getting somewhere else always takes a seek first. */
  #startMoving(entry: Entry, run: Run, plan: RenderPlan): void {
    const { layer } = entry;
    const frame = this.#frameFor(layer, plan);
    run.frame = frame;
    void run.host.seek(frame);
    if (!this.#base) return;
    run.frame = undefined;
    run.host.play(baseFor(layer, plan, this.#base));
  }

  #frameFor(layer: RenderLayer, plan: RenderPlan): number {
    const seconds = Math.min(Math.max(this.#seconds, layer.start), layer.end);
    return frameOf(clockOf(layer, seconds), plan.scenes.fps);
  }

  #seek(entry: Entry, plan: RenderPlan): void {
    const frame = this.#frameFor(entry.layer, plan);
    for (const run of [entry.current, entry.next]) {
      if (!run || run.frame === frame) continue;
      run.frame = frame;
      void run.host.seek(frame);
    }
  }

  #play(base: PlayBase): void {
    this.#base = base;
    const plan = this.#plan;
    if (!plan) return;
    this.#seconds = base.seconds;
    this.#follow();
    for (const entry of this.#entries.values()) {
      // Past its clip a scene has nothing left to do, and it is on its way out.
      if (entry.stopLingering) continue;
      for (const run of [entry.current, entry.next]) {
        if (!run) continue;
        if (base.jump) this.#startMoving(entry, run, plan);
        else {
          run.frame = undefined;
          run.host.play(baseFor(entry.layer, plan, base));
        }
      }
    }
  }

  /** Where it ended up is up to the editor, which sends the time it stopped at. */
  #pause(): void {
    this.#base = undefined;
    for (const run of this.#runs()) run.host.pause();
    this.#follow();
  }

  #onProblem(entry: Entry, problem: SceneProblem): void {
    const tell = () =>
      this.#options.send({ type: "scene-problem", layer: entry.layer.id, problem });
    if (problem.code === "capture-timeout") whenOnScreen(tell);
    else tell();
  }

  #onState(entry: Entry, run: Run, state: SceneHostState): void {
    if (state === "ready") {
      if (run === entry.current) this.#setStatus(entry, { state: "ready" });
      // Nothing else is coming to say that it got there.
      if (run === entry.next && this.#setup?.stage === "plain") this.#takeOver(entry, run);
    } else if (state === "unsupported") {
      this.#canCapture = false;
      for (const other of this.#entries.values()) {
        other.current?.host.close();
        other.next?.host.close();
        other.current = undefined;
        other.next = undefined;
        this.#setStatus(other, { state: "unsupported" });
      }
      this.#options.redraw();
    }
  }

  #onPicture(entry: Entry, run: Run, picture: HeldPicture): void {
    if (run === entry.next) this.#takeOver(entry, run);
    if (run !== entry.current) {
      picture.image.close();
      return;
    }
    entry.picture?.replace();
    entry.picture = picture;
    if (entry.status.state !== "ready") this.#setStatus(entry, { state: "ready" });
    this.#options.redraw();
  }

  #takeOver(entry: Entry, run: Run): void {
    entry.current?.host.close();
    entry.current = run;
    entry.next = undefined;
  }

  #onFailure(entry: Entry, run: Run, failure: SceneFailure): void {
    const { reason, message, phase, frame, target, retrying } = failure;
    const details = {
      reason,
      phase,
      frame,
      ...(message !== undefined && { message }),
      ...(target !== undefined && { target }),
    };
    if (retrying) {
      this.#setStatus(entry, { state: "retrying", ...details });
      // The new frame only comes after this. A picture says that it got over it, if it has any.
      queueMicrotask(() => this.#confirm(entry, run));
      return;
    }
    const status: SceneStatus = { state: "stopped", ...details };
    this.#failed.set(entry.layer.id, { key: run.key, status });
    this.#setStatus(entry, status);
    // What was there before an update failed is still the best picture there is.
    if (run === entry.next) {
      entry.next = undefined;
      return;
    }
    entry.picture?.replace();
    entry.picture = undefined;
    this.#options.redraw();
  }

  #confirm(entry: Entry, run: Run): void {
    if (run.frame === undefined) return;
    void run.host.seek(run.frame).then((reached) => {
      if (reached && entry.status.state === "retrying") this.#setStatus(entry, { state: "ready" });
    });
  }

  /** Starts over, with its own history wiped clean: what went wrong may have been fixed by now. */
  #retry(id: string): void {
    const entry = this.#entries.get(id);
    const plan = this.#plan;
    if (!entry || !plan) return;
    this.#failed.delete(id);
    const run = entry.current;
    if (run?.host.state === "stopped") {
      this.#setStatus(entry, { state: "opening" });
      void run.host.open();
      this.#startMoving(entry, run, plan);
    } else this.#follow();
  }
}
