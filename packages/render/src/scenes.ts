import type { RenderLayer, RenderPlan, SceneSource } from "@animaquill/core";
import {
  MAX_SCENE_FRAME,
  clockOf,
  sceneFrameOf as frameOf,
  sceneViewOf,
} from "@animaquill/core/view";
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
import {
  SCENE_CORNER,
  type FromCompositor,
  type PlayBase,
  type SceneSetup,
  type SceneStatus,
  type ToCompositor,
} from "./index.ts";
import { StillFailed } from "./still.ts";

export { MAX_SCENE_FRAME, frameOf };

/** Going over a clip and back again should not cost a new process each way. */
const LINGER_MS = 3000;

/** How long a frame of the screen takes at most, on this page, when it is on the screen at all. */
const SCREEN_FRAME_MS = 250;

/** How far ahead of the sound a playing scene can get, see `#stayIfAhead`. */
const PAUSE_SLACK_MS = 500;
/**
 * How long the picture of a frame may come after the scene said it got there. It comes before that,
 * unless the capture failed or has to wait for a screen, and that wait does not count.
 */
export const PICTURE_GRACE_MS = 5000;

const GRACE_STEP_MS = 250;

/** What a canvas can have. A clip box can be anything, and a scene is not worth losing the tab. */
const MAX_PICTURE_SIDE = 8192;

/** What this takes care of. */
type SceneMessage = Extract<
  ToCompositor,
  { type: "setup" | "scene-files" | "scene-retry" | "evict" | "play" | "pause" | "handles" }
>;

/** What this needs of a scene. */
export type Host = Pick<
  SceneHost,
  | "open"
  | "close"
  | "seek"
  | "play"
  | "pause"
  | "channels"
  | "handles"
  | "evict"
  | "focusTaken"
  | "state"
  | "origin"
  | "position"
  | "stateful"
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
  /** Runs something after a while of the page being on the screen. */
  readonly grace?: (run: () => void, ms: number) => () => void;
}

/** One picture of a scene, which stays usable for as long as somebody holds on to it. */
export class HeldPicture {
  readonly image: ImageBitmap;
  /** The frame of the scene this is a picture of. */
  readonly frame: number;
  #holders = 0;
  #replaced = false;

  constructor(image: ImageBitmap, frame: number) {
    this.image = image;
    this.frame = frame;
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
  /** It stopped a little past `frame` and stays there, see `#stayIfAhead`. */
  ahead?: boolean;
  /** What it got of what the clip holds for it, by path, as text to tell a change by. */
  readonly sent: Map<string, { readonly value: unknown; readonly text: string }>;
}

/** Somebody who only takes the picture of one frame. */
interface ExactWait {
  readonly frame: number;
  readonly got: (picture: HeldPicture) => void;
  readonly failed: (reason: StillFailed) => void;
  stopGrace: (() => void) | undefined;
}

/** A clip with a scene. It can have two runs: the new one takes over when it has a picture. */
interface Entry {
  layer: RenderLayer;
  current: Run | undefined;
  next: Run | undefined;
  picture: HeldPicture | undefined;
  status: SceneStatus;
  stopLingering: (() => void) | undefined;
  /** The frame the scene last said it got to, as long as nothing else was asked since. */
  reached: number | undefined;
  exact: ExactWait | undefined;
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

/** A page behind another tab gets no paint, and that is no reason to give up on a scene. */
function whileOnScreen(run: () => void, ms: number): () => void {
  let left = ms;
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    left -= GRACE_STEP_MS;
    if (left > 0) return;
    clearInterval(timer);
    run();
  }, GRACE_STEP_MS);
  return () => clearInterval(timer);
}

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

/**
 * Code that does not parse never ran, so what a new state of a scene shows without it says nothing
 * about what somebody wrote. It is the moment to stay with the picture that worked. Code that ran
 * and threw is different: it may be most of what people want to see.
 */
const isNotCode = ({ kind, message }: SceneProblem) =>
  kind === "error" && message !== undefined && /\bSyntaxError\b/.test(message);

/** Whether a clip gets to a moment of its scene that no scene can get to, by its offset or rate. */
export function isOutOfReach(
  layer: RenderLayer,
  { num, den }: RenderPlan["scenes"]["fps"],
): boolean {
  const last = (clockOf(layer, layer.end) * num) / den;
  return !(last <= MAX_SCENE_FRAME);
}

/** One unit of the world is one CSS pixel, and the picture has the pixels of the output. */
export function viewOf(layer: RenderLayer, plan: RenderPlan): SceneView {
  const { width, height } = sceneViewOf(layer, plan.stage);
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
  const late =
    frame === MAX_SCENE_FRAME ? 0 : ((exact - frame) * fps.den * 1000) / fps.num / (rate || 1);
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
  /** What was asked for, and on which plan. An answer can stay away, see `#contentOf`. */
  readonly #asked = new Map<string, RenderPlan | undefined>();
  readonly #failed = new Map<string, Failed>();
  #setup: SceneSetup | undefined;
  #origins: OriginPool | undefined;
  #plan: RenderPlan | undefined;
  /** What shows, with what is being tried and dragged, which is what scenes work out values of. */
  #shown: RenderPlan | undefined;
  #shownLayers:
    { readonly plan: RenderPlan; readonly layers: Map<string, RenderLayer> } | undefined;
  #seconds = 0;
  #base: PlayBase | undefined;
  /** The layer whose scene says where the objects of its code are. */
  #handlesFor: string | undefined;
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
      case "scene-files": {
        const key = contentKey(message);
        const had = this.#contents.has(key);
        this.#contents.set(key, message);
        // More of the same scene: an asset whose file came back. What runs started without it.
        if (had) this.#renew(key, message);
        this.#follow();
        return true;
      }
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
      case "handles":
        this.#handlesFor = message.layer ?? undefined;
        for (const entry of this.#entries.values()) {
          const on = entry.layer.id === this.#handlesFor;
          entry.current?.host.handles(on);
          entry.next?.host.handles(on);
        }
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

  /**
   * The plan or the time changed. Curves that changed count too: a box can get another size. Which
   * scenes run, and how large, goes by what is saved, so that trying something out does not open
   * them again. What they show of their clips goes by what `shown` has on top of that.
   */
  follow(
    plan: RenderPlan | undefined,
    seconds: number,
    shown: RenderPlan | undefined = plan,
  ): void {
    this.#plan = plan;
    this.#shown = shown;
    this.#seconds = seconds;
    this.#follow();
  }

  /** The newest picture of a layer, to hold on to until it has been drawn. */
  pictureOf(layer: string): HeldPicture | undefined {
    return this.#entries.get(layer)?.picture?.hold();
  }

  /**
   * The picture of the frame the time says, and of no other, to hold on to until it has been drawn.
   * What a scene last had can be any frame, which is fine for a preview that moves on anyway. This
   * waits, and rejects with `StillFailed` when the scene is not going to get there. A scene that
   * hangs gets started again by its host, and this goes on waiting for that one.
   */
  exactPicture(layer: string): Promise<HeldPicture> {
    const entry = this.#entries.get(layer);
    const plan = this.#plan;
    if (!entry || !plan) {
      const status: SceneStatus = { state: "closed" };
      return Promise.reject(new StillFailed({ reason: "scene", layer, status }));
    }
    const frame = this.#frameFor(entry.layer, plan);
    if (entry.picture?.frame === frame) return Promise.resolve(entry.picture.hold());
    if (this.#isOut(entry)) return Promise.reject(this.#notRunning(entry));
    return new Promise((got, failed) => {
      this.#endExact(entry, this.#notRunning(entry));
      entry.exact = { frame, got, failed, stopGrace: undefined };
      // What stayed a little ahead is fine to look at, and not the frame: it goes back after all.
      for (const run of [entry.current, entry.next]) {
        if (run?.ahead) void this.#goTo(entry, run, frame);
      }
      this.#expectPicture(entry);
    });
  }

  /** Whether a layer has no picture and is not going to get one for now. */
  showsPlaceholder(layer: string): boolean {
    const entry = this.#entries.get(layer);
    return entry !== undefined && !entry.picture && this.#isOut(entry);
  }

  #isOut({ status: { state } }: Entry): boolean {
    const blocked = state === "unsupported" || state === "too-new" || state === "off";
    return blocked || state === "stopped" || this.#setup?.stage === "plain";
  }

  #notRunning({ layer: { id }, status }: Entry): StillFailed {
    const out =
      this.#setup?.stage === "plain" ? { ...status, state: "unsupported" as const } : status;
    return new StillFailed({ reason: "scene", layer: id, status: out });
  }

  #endExact(entry: Entry, reason: StillFailed): void {
    const wait = entry.exact;
    entry.exact = undefined;
    wait?.stopGrace?.();
    wait?.failed(reason);
  }

  /** The scene is on the frame, so that its picture should be here or nearly here. */
  #expectPicture(entry: Entry): void {
    const wait = entry.exact;
    if (!wait || wait.stopGrace || entry.reached !== wait.frame) return;
    const grace = this.#options.grace ?? whileOnScreen;
    wait.stopGrace = grace(() => {
      const { id } = entry.layer;
      const got = entry.picture?.frame;
      this.#endExact(
        entry,
        new StillFailed({
          reason: "scene-frame",
          layer: id,
          wanted: wait.frame,
          ...(got !== undefined && { got }),
        }),
      );
    }, PICTURE_GRACE_MS);
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
    const { state, reason, message } = entry.status;
    if (state === status.state && reason === status.reason && message === status.message) return;
    entry.status = status;
    this.#options.send({ type: "scene-status", layer: entry.layer.id, status });
    if (this.#isOut(entry)) this.#endExact(entry, this.#notRunning(entry));
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
    for (const entry of this.#entries.values()) this.#sendValues(entry);
    if (!this.#base) for (const entry of this.#entries.values()) this.#seek(entry, plan);
  }

  /** A layer the way it shows. */
  #shownLayer(layer: RenderLayer): RenderLayer {
    const shown = this.#shown;
    if (!shown || shown === this.#plan) return layer;
    if (this.#shownLayers?.plan !== shown) {
      this.#shownLayers = {
        plan: shown,
        layers: new Map(shown.layers.map((one) => [one.id, one])),
      };
    }
    return this.#shownLayers.layers.get(layer.id) ?? layer;
  }

  /**
   * What changed of what a clip holds for its scene goes to each run of it. A run that just started
   * gets all of it, before it runs any code. Only what changed goes, because a drag changes one
   * value at a time and a skeleton has thousands. What is the same object is the same.
   */
  #sendValues(entry: Entry): void {
    const { id } = entry.layer;
    const content = this.#shownLayer(entry.layer).content ?? {};
    for (const run of [entry.current, entry.next]) {
      if (!run) continue;
      const changes: Record<string, unknown> = {};
      let changed = false;
      for (const [path, value] of Object.entries(content)) {
        const known = run.sent.get(path);
        if (known?.value === value) continue;
        const text = JSON.stringify(value);
        run.sent.set(path, { value, text });
        if (known?.text === text) continue;
        changes[path] = value;
        changed = true;
      }
      for (const path of run.sent.keys()) {
        if (Object.hasOwn(content, path)) continue;
        run.sent.delete(path);
        changes[path] = null;
        changed = true;
      }
      if (changed) run.host.channels(id, changes);
    }
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
    entry.status = { state: "closed" };
    this.#endExact(entry, this.#notRunning(entry));
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
    const blocked = this.#blocked(layer, plan);
    if (blocked) {
      this.#stopRuns(entry);
      this.#setStatus(entry, blocked);
      return;
    }
    const key = this.#keyOf(layer, plan);
    const failed = this.#failed.get(layer.id);
    if (failed?.key === key) {
      this.#setStatus(entry, failed.status);
      return;
    }
    if (entry.current?.key === key) {
      // Taken back while the new one was on its way. It must not take over when it gets there.
      if (entry.next && entry.next.key !== key) {
        entry.next.host.close();
        entry.next = undefined;
      }
      return;
    }
    if (entry.next?.key === key) return;
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
      reached: undefined,
      exact: undefined,
    };
    this.#entries.set(layer.id, entry);
    this.#options.send({ type: "scene-status", layer: layer.id, status: entry.status });
    return entry;
  }

  /** Why a scene does not get started at all. */
  #blocked(
    layer: RenderLayer & { source: SceneSource },
    plan: RenderPlan,
  ): SceneStatus | undefined {
    if (this.#setup?.run === false) return { state: "off" };
    if (layer.source.runtime > RUNTIME_VERSION) return { state: "too-new" };
    if (isOutOfReach(layer, plan.scenes.fps)) {
      return { state: "stopped", reason: "failed", message: "frame-out-of-range" };
    }
    return this.#canCapture && this.#origins ? undefined : { state: "unsupported" };
  }

  /** Whatever ran for this clip is not going to show any more. */
  #stopRuns(entry: Entry): void {
    entry.current?.host.close();
    entry.next?.host.close();
    entry.current = undefined;
    entry.next = undefined;
    if (!entry.picture) return;
    entry.picture.replace();
    entry.picture = undefined;
    this.#options.redraw();
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
    // The editor only answers for what its own plan shows, which can be a step behind or ahead of
    // this one, so an answer can stay away. A new plan asks again for whatever is still missing.
    if (!this.#asked.has(key) || this.#asked.get(key) !== this.#plan) {
      this.#asked.set(key, this.#plan);
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
    for (const key of this.#contents.keys()) if (!keep.has(key)) this.#contents.delete(key);
    for (const key of this.#asked.keys()) if (!keep.has(key)) this.#asked.delete(key);
  }

  #place(frame: HTMLIFrameElement, { width, height }: SceneView): void {
    const slot = this.#nextSlot % SCENE_CORNER;
    this.#nextSlot += 1;
    Object.assign(frame.style, {
      position: "fixed",
      left: `calc(100vw - ${slot + 1}px)`,
      top: `calc(100vh - ${SCENE_CORNER - slot}px)`,
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
        params: source.params,
        view,
      },
      ...(stage && { stage }),
      ...(avoid !== undefined && { avoid }),
      place: (frame) => this.#place(frame, view),
      onState: (state) => run && this.#onState(entry, run, state),
      onProblem: (problem) => run && this.#onProblem(entry, run, source.revision, problem),
      onFailure: (failure) => run && this.#onFailure(entry, run, failure),
      onPicture: ({ frame, image }) => {
        if (run) this.#onPicture(entry, run, new HeldPicture(image, frame));
        else image.close();
      },
      onObjects: (registration) => {
        const { id } = entry.layer;
        const { revision } = source;
        this.#options.send({ type: "scene-objects", layer: id, revision, registration });
      },
      onObjectsUnsure: () => {
        const { id } = entry.layer;
        this.#options.send({ type: "scene-objects-unsure", layer: id, revision: source.revision });
      },
      onHandles: (frame, handles) => {
        const { id } = entry.layer;
        // Only the clip that asked, which may have stopped asking on the way.
        if (id !== this.#handlesFor) return;
        const { revision } = source;
        this.#options.send({ type: "scene-handles", layer: id, revision, frame, handles });
      },
    };
    const host = (this.#options.makeHost ?? ((all) => new SceneHost(all)))(options);
    const started: Run = { key, host, frame: undefined, sent: new Map() };
    run = started;
    try {
      if (layer.id === this.#handlesFor) host.handles(true);
      void host.open();
      this.#startMoving(entry, started, plan);
    } catch (error) {
      // Nobody would ever close it: it would not be part of the clip yet.
      host.close();
      throw error;
    }
    return started;
  }

  /** Time only goes forwards by itself, so getting somewhere else always takes a seek first. */
  #startMoving(entry: Entry, run: Run, plan: RenderPlan): void {
    const { layer } = entry;
    this.#goTo(entry, run, this.#frameFor(layer, plan));
    if (!this.#base) return;
    run.frame = undefined;
    run.ahead = false;
    run.host.play(baseFor(layer, plan, this.#base));
  }

  #frameFor(layer: RenderLayer, plan: RenderPlan): number {
    const seconds = Math.min(Math.max(this.#seconds, layer.start), layer.end);
    return frameOf(clockOf(layer, seconds), plan.scenes.fps);
  }

  #seek(entry: Entry, plan: RenderPlan): void {
    const frame = this.#frameFor(entry.layer, plan);
    for (const run of [entry.current, entry.next]) {
      if (run && run.frame !== frame) this.#goTo(entry, run, frame);
    }
  }

  #goTo(entry: Entry, run: Run, frame: number): Promise<boolean> {
    run.frame = frame;
    run.ahead = false;
    entry.reached = undefined;
    return run.host.seek(frame).then((reached) => {
      if (reached && run.frame === frame) {
        entry.reached = frame;
        this.#expectPicture(entry);
      }
      return reached;
    });
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
          run.ahead = false;
          run.host.play(baseFor(entry.layer, plan, base));
        }
      }
    }
  }

  /** Where it ended up is up to the editor, which sends the time it stopped at. */
  #pause(): void {
    this.#base = undefined;
    const plan = this.#plan;
    for (const entry of this.#entries.values()) {
      for (const run of [entry.current, entry.next]) {
        if (!run) continue;
        run.host.pause();
        if (plan) this.#stayIfAhead(entry, run, plan);
      }
    }
    this.#follow();
  }

  /**
   * A playing scene gets a little ahead of the sound now and then, and code that draws frame by
   * frame cannot go back without starting over from the first frame. Stopping is not worth that:
   * the picture stays where it got to until somebody moves the playhead.
   */
  #stayIfAhead(entry: Entry, run: Run, plan: RenderPlan): void {
    const { position, stateful } = run.host;
    const frame = this.#frameFor(entry.layer, plan);
    if (!stateful || position === undefined || position <= frame) return;
    const { num, den } = plan.scenes.fps;
    if (position - frame > Math.ceil((PAUSE_SLACK_MS * num) / den / 1000)) return;
    run.frame = frame;
    run.ahead = true;
  }

  /** The same scene with more of what it needs. Each clip of it gets a new run, which takes over. */
  #renew(key: string, content: SceneContent): void {
    const plan = this.#plan;
    if (!plan) return;
    for (const entry of this.#entries.values()) {
      const { current } = entry;
      if (!current || entry.stopLingering || !isScene(entry.layer)) continue;
      if (contentKey(entry.layer.source) !== key) continue;
      entry.next?.host.close();
      entry.next = this.#start(entry, current.key, content, plan);
    }
  }

  #onProblem(entry: Entry, run: Run, revision: string, problem: SceneProblem): void {
    const { id } = entry.layer;
    const tell = () => this.#options.send({ type: "scene-problem", layer: id, revision, problem });
    if (problem.code === "capture-timeout") whenOnScreen(tell);
    else tell();
    if (run === entry.next && isNotCode(problem)) {
      const { message = "" } = problem;
      run.host.close();
      this.#onFailure(entry, run, {
        reason: "failed",
        phase: "loading",
        frame: 0,
        retrying: false,
        message,
      });
    }
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
    const wait = entry.exact;
    if (wait?.frame === picture.frame) {
      entry.exact = undefined;
      wait.stopGrace?.();
      wait.got(picture.hold());
    }
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
    void this.#goTo(entry, run, run.frame).then((reached) => {
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
