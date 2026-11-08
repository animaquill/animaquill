import {
  buildRenderPlan,
  channelOf,
  clipEnd,
  clipOffset,
  clipStart,
  clockOf,
  cornersOf,
  effectiveProperties,
  entryOf,
  handleReach,
  invert,
  isInside,
  multiply,
  naturalSizeOf,
  objectPath,
  objectsOf,
  paramTextOf,
  placementOf,
  sample,
  sceneFrameOf,
  sceneMatrix,
  sceneViewOf,
  showsAt,
  shownAt,
  transformPoint,
  type ClipDescription,
  type ClipState,
  type GrabHandle,
  type HandleSpec,
  type Matrix,
  type ObjectHandles,
  type Placement,
  type Point,
  type ProjectState,
  type ProjectStore,
  type PropertyEdit,
  type Registration,
  type RenderLayer,
  type RenderPlan,
  type SceneRegistry,
} from "@animaquill/core";
import {
  add,
  compare,
  formatTime,
  subtract,
  toSeconds,
  type ObjectDescriptor,
  type PropertySpec,
  type PropertyValue,
} from "@animaquill/schema";
import { inspectProperty, writeEdit } from "../properties/inspect.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TrialSession } from "../properties/trial.ts";
import type { QualitySnapshot } from "../preview/quality.ts";
import { withShown } from "../preview/link.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { frameTime, type FrameRate } from "../timeline/frames.ts";
import type { ClipBox, TimelineModel } from "../timeline/model.ts";
import { Emitter } from "../workbench/emitter.ts";
import { clipVisual } from "./clip-visual.ts";
import type { FrameMoment } from "./compensate.ts";
import {
  resizeCursor,
  type Binder,
  type EditorExtension,
  type ExtensionHandle,
  type ExtensionTarget,
  type GripLook,
  type GripRole,
  type Mark,
} from "./extension.ts";
import {
  declarativeGesture,
  type Bound,
  type Gesture,
  type Live,
  type OverlayPointer,
} from "./gestures.ts";
import type { SceneHandles } from "./scene-handles.ts";
import { worldToScreen } from "./screen.ts";

export { ROTATE_REACH } from "./clip-visual.ts";
export { SIDES, type GripLook, type GripRole, type Mark, type Side } from "./extension.ts";

/** The editing of the kinds of objects the editor knows, by their type. */
const EXTENSIONS: ReadonlyMap<string, EditorExtension> = new Map(
  [clipVisual].map((extension) => [extension.objectType, extension]),
);

/** Something on the overlay to grab, with what happens then. */
export interface Grip {
  /** The same from one picture to the next, for as long as it is the same handle. */
  readonly id: string;
  readonly role: GripRole;
  readonly detail: string;
  readonly clip: string;
  /** The name of the object a handle of code is of. */
  readonly object?: string;
  /** Where it is on the overlay. */
  readonly at: Point;
  readonly look: GripLook;
  /** Which way the box it belongs to is turned on the screen, in radians, for drawing it. */
  readonly angle: number;
  readonly cursor: string;
  readonly begin: (pointer: OverlayPointer) => Gesture | undefined;
}

/** A clip on the picture, for clicking on it. */
export interface Body {
  readonly clip: string;
  readonly corners: readonly Point[];
}

export interface OverlayScene {
  readonly marks: readonly Mark[];
  /** In the order they are drawn: the last is on top. */
  readonly grips: readonly Grip[];
  /** The clips on the picture, front first. */
  readonly bodies: readonly Body[];
  /** The clip with handles. */
  readonly target: Body | undefined;
}

export interface OverlaySnapshot {
  readonly scene: OverlayScene;
  /** What the pointer is over: a grip, or `body <clip>`. */
  readonly hovered: string | undefined;
  /** What is being dragged, in the same terms. */
  readonly dragging: string | undefined;
}

/** The parts of the workbench the overlay goes by. */
export interface OverlaySources {
  readonly session: {
    readonly store: ProjectStore | undefined;
    subscribe(listener: () => void): () => void;
  };
  readonly timeline: TimelineEditor;
  readonly properties: PropertyWriter;
  readonly trials: TrialSession;
  readonly quality: { getSnapshot(): QualitySnapshot; subscribe(listener: () => void): () => void };
  readonly handles: SceneHandles;
  readonly registrations: SceneRegistry & {
    subscribe(listener: () => void): () => void;
    getVersion(): number;
  };
  /** What a clip offers beyond what the editor knows by itself, as the properties tab has it. */
  readonly describe: (clip: ClipState) => ClipDescription | undefined;
  readonly messages: OverlayMessages;
}

export interface OverlayMessages {
  /** A drag stopped because what it changes went away, for an undo or in another window. */
  gone(): void;
}

/** Moving less than this is a click, as on the timeline. */
const CLICK_REACH = 4;
/** How far from a handle the pointer can be and still grab it, in pixels. A finger needs more. */
const REACH = 7;
const TOUCH_REACH = 16;
const EMPTY: OverlayScene = { marks: [], grips: [], bodies: [], target: undefined };

/** What a clip shows: its properties with what is being tried or dragged on top. */
function shownProperties(
  clip: ClipState,
  previewed: ReadonlyMap<string, PropertyValue | undefined> | undefined,
): Readonly<Record<string, PropertyValue>> {
  const properties = effectiveProperties(clip);
  if (!previewed || previewed.size === 0) return properties;
  const shown: Record<string, PropertyValue> = { ...properties };
  for (const [path, value] of previewed) {
    if (value === undefined) delete shown[path];
    else shown[path] = value;
  }
  return shown;
}

/** A number of a property at a reading of the clock of its clip, or its default. */
function numberIn(
  properties: Readonly<Record<string, PropertyValue>>,
  spec: PropertySpec,
  clock: number,
): number | undefined {
  const value = entryOf(properties, spec.path);
  const channel = value === undefined ? undefined : channelOf(value, spec.type);
  const found = channel ? sample(channel, clock) : spec.default;
  return typeof found === "number" ? found : undefined;
}

/** What is the same about every clip while one picture is worked out. */
interface Frame {
  readonly state: ProjectState;
  readonly model: TimelineModel;
  readonly frame: number;
  readonly seconds: number;
  readonly plan: RenderPlan;
  readonly settled: ReadonlyMap<string, RenderLayer>;
  readonly toScreen: Matrix;
  readonly toWorld: Matrix;
}

/** A clip on the picture. */
interface Placed {
  readonly layer: RenderLayer;
  readonly box: ClipBox;
  readonly placement: Placement;
  /** From its box to the overlay. */
  readonly boxToScreen: Matrix;
  readonly corners: readonly Point[];
}

interface Drag {
  readonly start: OverlayPointer;
  readonly frame: number;
  /** What is grabbed, in the terms of `OverlaySnapshot`. */
  readonly what: string | undefined;
  readonly gesture: Gesture | undefined;
  /** What the gesture writes where it started, which is no change at all. */
  readonly unchanged: string;
  /** What letting go without moving does. */
  readonly click: (() => void) | undefined;
  moved: boolean;
  /** What it changes went away, and it stopped. */
  stopped: boolean;
  edits: readonly PropertyEdit[];
}

/**
 * The layer over the picture of the preview, where people grab what they see: the box of the
 * selected clip with its handles, the path its keys make, and what code objects say can be grabbed.
 * The editor draws it and works out what the pointer is on, nothing of it gets into the compositor
 * or a scene, so it never ends up in a picture that gets exported. Like the timeline, this works
 * without the DOM: the component only passes on the pointer and draws what this says.
 */
export class OverlayEditor {
  readonly #sources: OverlaySources;
  readonly #emitter = new Emitter();
  #width = 0;
  #height = 0;
  #touch = false;
  #drag: Drag | undefined;
  #snapshot: OverlaySnapshot = { scene: EMPTY, hovered: undefined, dragging: undefined };
  /** What the scene was last worked out from, to tell when it has to be worked out again. */
  #inputs: readonly unknown[] = [];
  #stop: () => void;

  constructor(sources: OverlaySources) {
    this.#sources = sources;
    const changed = () => this.#changed();
    const { session, timeline, properties, trials, quality, handles, registrations } = sources;
    let store: ProjectStore | undefined;
    let stopStore: (() => void) | undefined;
    const follow = () => {
      if (session.store === store) return;
      stopStore?.();
      store = session.store;
      stopStore = store?.subscribe(changed);
      changed();
    };
    const timelineChanged = () => {
      // Whatever was in somebody's hands is not where it was any more.
      const drag = this.#drag;
      if (drag && (timeline.getSnapshot().playing || timeline.frame !== drag.frame)) this.cancel();
      changed();
    };
    const stops = [
      session.subscribe(follow),
      timeline.subscribe(timelineChanged),
      timeline.subscribeView(timelineChanged),
      properties.subscribe(changed),
      trials.subscribe(changed),
      quality.subscribe(changed),
      handles.subscribe(changed),
      registrations.subscribe(changed),
    ];
    follow();
    this.#stop = () => {
      stopStore?.();
      for (const stop of stops) stop();
      handles.want(undefined);
    };
  }

  subscribe = this.#emitter.subscribe;

  getSnapshot = (): OverlaySnapshot => {
    this.#update();
    return this.#snapshot;
  };

  dispose(): void {
    this.cancel();
    this.#stop();
  }

  /** The size of the frame of the compositor, in CSS pixels. */
  setViewport(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#changed();
  }

  /** Fingers get more room around handles. */
  setTouchInput(on: boolean): void {
    if (on === this.#touch) return;
    this.#touch = on;
    this.#changed();
  }

  get isDragging(): boolean {
    return this.#drag !== undefined;
  }

  #changed(): void {
    this.#emitter.emit();
  }

  #set(changes: Partial<OverlaySnapshot>): void {
    const next = { ...this.#snapshot, ...changes };
    if (
      next.scene === this.#snapshot.scene &&
      next.hovered === this.#snapshot.hovered &&
      next.dragging === this.#snapshot.dragging
    ) {
      return;
    }
    this.#snapshot = next;
    this.#emitter.emit();
  }

  /* Pointer. */

  /** The cursor for a place, and what it is over. */
  hover(pointer: OverlayPointer): string {
    const hit = this.#hit(pointer);
    this.#set({ hovered: hit?.what });
    return hit?.cursor ?? "default";
  }

  leave(): void {
    this.#set({ hovered: undefined });
  }

  press(pointer: OverlayPointer): void {
    this.cancel();
    const { timeline } = this.#sources;
    const hit = this.#hit(pointer);
    const frame = timeline.frame;
    if (!hit) {
      this.#drag = this.#newDrag(pointer, frame, undefined, undefined, () =>
        timeline.clearSelection(),
      );
      return;
    }
    if (hit.select) {
      if (pointer.shift) {
        timeline.addToSelection(hit.select);
        return;
      }
      timeline.selectOnly(hit.select);
    }
    this.#drag = this.#newDrag(pointer, frame, hit.what, hit.begin?.(pointer), undefined);
    this.#set({ dragging: hit.what });
  }

  #newDrag(
    start: OverlayPointer,
    frame: number,
    what: string | undefined,
    gesture: Gesture | undefined,
    click: (() => void) | undefined,
  ): Drag {
    const unchanged = JSON.stringify(gesture?.edits(start) ?? []);
    return {
      start,
      frame,
      what,
      gesture,
      unchanged,
      click,
      moved: false,
      stopped: false,
      edits: [],
    };
  }

  drag(pointer: OverlayPointer): void {
    const drag = this.#drag;
    if (!drag || drag.stopped) return;
    if (!drag.moved) {
      const distance = Math.hypot(pointer.x - drag.start.x, pointer.y - drag.start.y);
      if (distance < CLICK_REACH) return;
      drag.moved = true;
    }
    if (!drag.gesture) return;
    const edits = drag.gesture.edits(pointer);
    if (!edits) {
      this.#stopDrag(drag);
      return;
    }
    drag.edits = edits;
    this.#sources.properties.preview(edits);
  }

  /** What a drag changes went away: what it showed goes, and people hear why nothing happened. */
  #stopDrag(drag: Drag): void {
    drag.stopped = true;
    drag.edits = [];
    this.#sources.properties.cancel();
    this.#set({ dragging: undefined });
    this.#sources.messages.gone();
  }

  release(pointer: OverlayPointer): void {
    const drag = this.#drag;
    if (!drag) return;
    // What gets written is worked out from the properties as they are when it lets go.
    this.drag(pointer);
    this.#drag = undefined;
    this.#set({ dragging: undefined });
    const { properties } = this.#sources;
    if (drag.stopped) return;
    if (!drag.moved) {
      properties.cancel();
      drag.click?.();
      return;
    }
    // A drag that ends where it started leaves nothing to undo.
    if (drag.edits.length === 0 || JSON.stringify(drag.edits) === drag.unchanged) {
      properties.cancel();
    } else properties.commit(drag.edits);
  }

  /** Esc, the pointer going somewhere nobody can see, or the playhead moving away from it. */
  cancel(): void {
    if (!this.#drag) return;
    this.#drag = undefined;
    this.#sources.properties.cancel();
    this.#set({ dragging: undefined });
  }

  /** What is under the pointer: a handle first, then the selected clip, then any clip, front first. */
  #hit(pointer: OverlayPointer):
    | {
        readonly what: string;
        readonly cursor: string;
        readonly select?: string;
        readonly begin?: (pointer: OverlayPointer) => Gesture | undefined;
      }
    | undefined {
    const { scene } = this.getSnapshot();
    const reach = this.#touch ? TOUCH_REACH : REACH;
    let best: Grip | undefined;
    let nearest = reach;
    for (const grip of scene.grips) {
      const distance = Math.hypot(grip.at.x - pointer.x, grip.at.y - pointer.y);
      // What is drawn later is on top, and wins at the same distance.
      if (distance <= nearest) {
        best = grip;
        nearest = distance;
      }
    }
    if (best) return { what: best.id, cursor: best.cursor, begin: best.begin };
    const { target } = scene;
    if (target && isInside(target.corners, pointer)) {
      return {
        what: `body ${target.clip}`,
        cursor: "move",
        begin: (at) => this.#moveGesture(target.clip, at),
      };
    }
    const body = scene.bodies.find(({ corners }) => isInside(corners, pointer));
    if (!body) return undefined;
    return {
      what: `body ${body.clip}`,
      cursor: "default",
      select: body.clip,
      begin: (at) => this.#moveGesture(body.clip, at),
    };
  }

  /* What there is to see. */

  #update(): void {
    const { session, timeline, properties, trials, quality, handles, registrations } =
      this.#sources;
    const { model } = timeline;
    const { selection, playing } = timeline.getSnapshot();
    const inputs = [
      session.store?.getState(),
      model,
      timeline.frame,
      selection,
      playing,
      properties.getPreviewed(),
      trials.getSnapshot(),
      quality.getSnapshot().size,
      this.#width,
      this.#height,
      this.#touch,
      handles.getVersion(),
      registrations.getVersion(),
    ];
    if (
      inputs.length === this.#inputs.length &&
      inputs.every((input, index) => input === this.#inputs[index])
    ) {
      return;
    }
    this.#inputs = inputs;
    const scene = this.#scene();
    if (scene !== this.#snapshot.scene) this.#snapshot = { ...this.#snapshot, scene };
  }

  #frame(): Frame | undefined {
    const { session, timeline, properties, quality } = this.#sources;
    const state = session.store?.getState();
    const { model } = timeline;
    const size = quality.getSnapshot().size;
    if (!state || !model || !size || timeline.getSnapshot().playing) return undefined;
    const settledPlan = buildRenderPlan(state, model.id);
    if (!settledPlan) return undefined;
    const frame = timeline.frame;
    const seconds = frame / model.rate.fps;
    const sizes = { frame: { width: this.#width, height: this.#height }, ...size };
    const toScreen = worldToScreen(settledPlan, sizes, seconds);
    const toWorld = toScreen && invert(toScreen);
    if (!toScreen || !toWorld) return undefined;
    return {
      state,
      model,
      frame,
      seconds,
      plan: withShown(settledPlan, properties.getPreviewed()),
      settled: new Map(settledPlan.layers.map((layer) => [layer.id, layer])),
      toScreen,
      toWorld,
    };
  }

  #placed(frame: Frame, layer: RenderLayer): Placed | undefined {
    const box = frame.model.boxes.get(layer.id);
    if (!box) return undefined;
    const natural = naturalSizeOf(frame.state, box.clip);
    const placement = placementOf(layer, frame.seconds, natural, frame.plan.stage);
    const boxToScreen = multiply(frame.toScreen, placement.matrix);
    return {
      layer,
      box,
      placement,
      boxToScreen,
      corners: cornersOf(boxToScreen, placement.picture),
    };
  }

  #scene(): OverlayScene {
    const frame = this.#frame();
    const { handles, timeline } = this.#sources;
    if (!frame) {
      handles.want(undefined);
      return EMPTY;
    }
    const { selection } = timeline.getSnapshot();
    const showing = frame.plan.layers.filter((layer) => showsAt(layer, frame.seconds));
    const placed = showing.flatMap((layer) => this.#placed(frame, layer) ?? []);
    const selected = placed.filter(({ layer }) => selection.has(layer.id));
    // Handles are for one clip with a picture, as the properties tab is, wherever the others are.
    const pictures = frame.plan.layers.filter(({ id }) => selection.has(id)).length;
    const bodies = placed
      .filter(({ layer }) => selection.has(layer.id) || shownAt(layer, frame.seconds) > 0)
      .map(({ layer, corners }) => ({ clip: layer.id, corners }))
      .toReversed();
    const marks: Mark[] = [];
    const grips: Grip[] = [];
    const [only] = selected;
    const target = pictures === 1 && only && this.#isChangeable(only) ? only : undefined;
    for (const one of selected) {
      if (one === target) continue;
      const locked = frame.model.rowOfClip.get(one.layer.id)?.track.locked === true;
      marks.push({
        kind: "outline",
        clip: one.layer.id,
        corners: one.corners,
        style: locked ? "locked" : "selected",
      });
    }
    if (target) this.#targetScene(frame, target, marks, grips);
    handles.want(target?.layer.source.kind === "scene" ? target.layer.id : undefined);
    return {
      marks,
      grips,
      bodies,
      target: target && { clip: target.layer.id, corners: target.corners },
    };
  }

  /** Whether a handle there can be seen and grabbed. */
  #fits({ x, y }: Point): boolean {
    return x >= REACH && y >= REACH && x <= this.#width - REACH && y <= this.#height - REACH;
  }

  /** Whether the handles of a clip can change anything now: not on a locked track, not while comparing. */
  #isChangeable({ layer }: Placed): boolean {
    const { timeline, trials } = this.#sources;
    if (trials.getSnapshot().comparing) return false;
    return timeline.model?.rowOfClip.get(layer.id)?.track.locked !== true;
  }

  #targetScene(frame: Frame, target: Placed, marks: Mark[], grips: Grip[]): void {
    const { layer, corners } = target;
    marks.push({ kind: "outline", clip: layer.id, corners, style: "target" });
    const context = this.#extensionTarget(frame, target);
    for (const { object, extension } of this.#extensionsOf(target)) {
      const scene = extension.handles(context);
      marks.push(...scene.marks);
      for (const handle of scene.handles) {
        grips.push(this.#extensionGrip(frame, target, object, context, handle));
      }
    }
    // What code objects say is inside the clip, so it goes on top, and wins where both are.
    if (layer.source.kind === "scene") this.#codeHandles(frame, target, marks, grips);
  }

  /** The built-in kinds of object of a clip that have an extension, in the order it has them. */
  #extensionsOf({ box }: Placed) {
    const objects = this.#sources.describe(box.clip)?.objects ?? objectsOf(box.clip);
    return objects.flatMap((object) => {
      const extension = object.type === undefined ? undefined : EXTENSIONS.get(object.type);
      return extension ? [{ object, extension }] : [];
    });
  }

  #extensionTarget(frame: Frame, target: Placed): ExtensionTarget {
    const { layer, box, placement } = target;
    const previewed = this.#sources.properties.getPreviewed().get(layer.id);
    return {
      clip: layer.id,
      layer,
      placement,
      toScreen: frame.toScreen,
      toWorld: frame.toWorld,
      properties: shownProperties(box.clip, previewed),
      clock: clockOf(layer, frame.seconds),
      fps: frame.model.rate.fps,
      frames: (from, to) => framesOf(box.clip, frame.model.rate, from, to),
      fits: (point) => this.#fits(point),
    };
  }

  #extensionGrip(
    frame: Frame,
    target: Placed,
    object: ObjectDescriptor,
    context: ExtensionTarget,
    handle: ExtensionHandle,
  ): Grip {
    const { id, role, detail, at, look, angle, cursor } = handle;
    return {
      id: `${target.layer.id} ${id}`,
      role,
      detail,
      clip: target.layer.id,
      at,
      look,
      angle,
      cursor,
      begin: (pointer) => {
        if (!handle.handle) return handle.solve?.(this.#binder(frame, target, object), pointer);
        const binds = this.#binds(
          frame,
          target,
          handle.handle,
          specsOf(object),
          context.properties,
        );
        return binds && declarativeGesture(handle.handle, frame.toWorld, binds, pointer);
      },
    };
  }

  /** How a drag writes the properties of one object of a clip: see `Binder`. */
  #binder(frame: Frame, target: Placed, object: ObjectDescriptor): Binder {
    const specs = specsOf(object);
    return (path, start) => {
      const spec = specs(path);
      return spec && this.#bound(frame, target.box, spec, start);
    };
  }

  /**
   * What a handle of a kind that says what a drag does binds, ready to be written, by the names the
   * handle uses: each from the value the picture shows right now. Nothing when any of it cannot be.
   */
  #binds(
    frame: Frame,
    target: Placed,
    handle: GrabHandle,
    specOf: (name: string) => PropertySpec | undefined,
    properties: Readonly<Record<string, PropertyValue>>,
  ): ReadonlyMap<string, Bound> | undefined {
    const clock = clockOf(target.layer, frame.seconds);
    const binds = new Map<string, Bound>();
    for (const name of bindsOf(handle)) {
      const spec = specOf(name);
      const start = spec && numberIn(properties, spec, clock);
      const bound = spec && start !== undefined && this.#bound(frame, target.box, spec, start);
      if (!bound) return undefined;
      binds.set(name, bound);
    }
    return binds;
  }

  /**
   * How a property of a clip gets written from here, the way the properties tab writes it. Nothing
   * when the clip cannot change now.
   */
  #bound(frame: Frame, box: ClipBox, spec: PropertySpec, start: number): Bound | undefined {
    const now = (): Live | undefined => {
      const { trials, session, timeline } = this.#sources;
      const state = session.store?.getState();
      const { model } = timeline;
      const current = model?.boxes.get(box.id);
      if (!state || !model || !current) return undefined;
      const view = { look: trials.look, comparing: trials.getSnapshot().comparing };
      const inspected = inspectProperty(state, model, current, spec, frame.frame, view);
      const { row, blocked, time } = inspected;
      if (blocked) return undefined;
      return { stored: row.stored, write: (value) => writeEdit(box.id, row, time, value) };
    };
    return now() && { path: spec.path, spec, start, now };
  }

  /** Dragging a clip itself, where it has no handle. */
  #moveGesture(clip: string, pointer: OverlayPointer): Gesture | undefined {
    const frame = this.#frame();
    const layer = frame?.plan.layers.find(({ id }) => id === clip);
    const target = frame && layer && this.#placed(frame, layer);
    if (!frame || !target || !this.#isChangeable(target)) return undefined;
    const context = this.#extensionTarget(frame, target);
    for (const { object, extension } of this.#extensionsOf(target)) {
      const handle = extension.body?.(context);
      if (!handle) continue;
      const binds = this.#binds(frame, target, handle, specsOf(object), context.properties);
      return binds && declarativeGesture(handle, frame.toWorld, binds, pointer);
    }
    return undefined;
  }

  /* Code objects. */

  #codeHandles(frame: Frame, target: Placed, marks: Mark[], grips: Grip[]): void {
    const { layer, box, placement, boxToScreen } = target;
    const { source } = layer;
    if (source.kind !== "scene") return;
    const { handles, registrations, describe } = this.#sources;
    // What the scene registered with the parameters of this clip, as far as that is known.
    const found = registrations.registrationOf(source.revision, (path) =>
      paramTextOf(box.clip, path),
    );
    const registration = found?.registration;
    const sceneFrame = sceneFrameOf(clockOf(layer, frame.seconds), frame.plan.scenes.fps);
    const settled = frame.settled.get(layer.id) ?? layer;
    const view = sceneViewOf(settled, frame.plan.stage);
    const reach = handleReach(view);
    const objects = handles.of(layer.id, source.revision, sceneFrame, registration, reach);
    if (objects.length === 0 || !registration) return;
    const sceneToScreen = multiply(boxToScreen, sceneMatrix(view, placement.box));
    const toScene = invert(sceneToScreen);
    if (!toScene) return;
    const described = describe(box.clip)?.objects ?? [];
    const shown = shownProperties(box.clip, this.#sources.properties.getPreviewed().get(layer.id));
    const clock = clockOf(layer, frame.seconds);
    const onScreen = ([x, y]: readonly [number, number]) => transformPoint(sceneToScreen, { x, y });
    for (const entry of objects) {
      const registered = registration.objects.find(({ id }) => id === entry.object);
      const own = described.find(({ id }) => id === `object.${entry.object}`);
      if (!registered || !own) continue;
      const specOf = (bind: string) => specFor(registration, registered, own, bind);
      const valueOf = (bind: string) => {
        const spec = specOf(bind);
        return spec && numberIn(shown, spec, clock);
      };
      if (entry.bounds) {
        const [x, y, width, height] = entry.bounds;
        marks.push({
          kind: "bounds",
          corners: cornersOf(sceneToScreen, { x, y, width, height }),
        });
      }
      for (const handle of entry.handles) {
        const grip = this.#codeGrip(frame, target, entry, handle, {
          name: registered.name ?? registered.id,
          onScreen,
          toScene,
          specOf,
          valueOf,
          shown,
          marks,
        });
        if (grip) grips.push(grip);
      }
    }
  }

  #codeGrip(
    frame: Frame,
    target: Placed,
    entry: ObjectHandles,
    handle: HandleSpec,
    tools: {
      readonly name: string;
      readonly onScreen: (point: readonly [number, number]) => Point;
      readonly toScene: Matrix;
      readonly specOf: (bind: string) => PropertySpec | undefined;
      readonly valueOf: (bind: string) => number | undefined;
      readonly shown: Readonly<Record<string, PropertyValue>>;
      readonly marks: Mark[];
    },
  ): Grip | undefined {
    const { name, onScreen, toScene, specOf, valueOf, shown, marks } = tools;
    // What does not bind properties of its own object is no handle of it.
    if ("id" in handle && bindsOf(handle).some((bind) => !specOf(bind))) return undefined;
    if (!("id" in handle)) {
      if (handle.kind === "circle") {
        const radius = this.#onScreenLength(onScreen, handle.at, handle.radius);
        marks.push({ kind: "ring", at: onScreen(handle.at), radius });
      } else marks.push({ kind: "line", points: handle.points.map(onScreen), closed: false });
      return undefined;
    }
    let at = onScreen(handle.at);
    let look: GripLook = handle.kind === "move" ? "point" : "scale";
    if (handle.kind === "rotate") {
      const value = valueOf(handle.bind) ?? 0;
      const turn = (value * Math.PI) / 180;
      const [x, y] = handle.at;
      const ring = this.#onScreenLength(onScreen, handle.at, handle.radius);
      marks.push({ kind: "ring", at: onScreen(handle.at), radius: ring });
      at = onScreen([x + Math.cos(turn) * handle.radius, y + Math.sin(turn) * handle.radius]);
      look = "knob";
    }
    const { layer } = target;
    const cursor =
      handle.kind === "scale"
        ? resizeCursor(at.x - onScreen(handle.center).x, at.y - onScreen(handle.center).y)
        : handle.kind === "rotate"
          ? "grab"
          : "move";
    return {
      id: `${layer.id} object ${entry.object} ${handle.id}`,
      role: "object",
      detail: handle.id,
      clip: layer.id,
      object: name,
      at,
      look,
      angle: 0,
      cursor,
      begin: (pointer) => {
        const binds = this.#binds(frame, target, handle, specOf, shown);
        return binds && declarativeGesture(handle, toScene, binds, pointer);
      },
    };
  }

  /** How long a length of a scene is on the screen, which is the same in every direction. */
  #onScreenLength(
    onScreen: (point: readonly [number, number]) => Point,
    [x, y]: readonly [number, number],
    length: number,
  ): number {
    const from = onScreen([x, y]);
    const to = onScreen([x + length, y]);
    return Math.hypot(to.x - from.x, to.y - from.y);
  }
}

/** The properties of an object by their paths. */
function specsOf(object: ObjectDescriptor): (path: string) => PropertySpec | undefined {
  const specs = new Map(object.properties.map((spec) => [spec.path, spec]));
  return (path) => specs.get(path);
}

/** What a handle binds, by the names it uses for them. */
function bindsOf(handle: GrabHandle): readonly string[] {
  const { bind } = handle;
  if (typeof bind === "string") return [bind];
  return [bind.x, bind.y].filter((name): name is string => name !== undefined);
}

/** The paths of everything a scene registered, by what it registered. */
const registeredPaths = new WeakMap<Registration, ReadonlySet<string>>();

function pathsOf(registration: Registration): ReadonlySet<string> {
  let paths = registeredPaths.get(registration);
  if (!paths) {
    paths = new Set(
      registration.objects.flatMap(({ id, properties }) =>
        properties.map(({ path }) => objectPath(id, path)),
      ),
    );
    registeredPaths.set(registration, paths);
  }
  return paths;
}

/**
 * The property a handle of a code object binds, as the clip has it: the description says where its
 * keys are, which can be a path the property or its object went by before. Such a path is only this
 * property's as long as no property that is registered now has it: a handle never writes the keys of
 * another object. Registered and described properties come in the same order.
 */
function specFor(
  registration: Registration,
  registered: ObjectDescriptor,
  described: ObjectDescriptor,
  bind: string,
): PropertySpec | undefined {
  const index = registered.properties.findIndex(({ path }) => path === bind);
  const property = registered.properties[index];
  const spec = described.properties[index];
  if (!property || !spec) return undefined;
  if (spec.path === objectPath(registered.id, bind)) return spec;
  const names = [bind, ...(property.aliases ?? [])];
  const before = [
    ...names.slice(1).map((name) => objectPath(registered.id, name)),
    ...(registered.aliases ?? []).flatMap((was) => names.map((name) => objectPath(was, name))),
  ];
  return before.includes(spec.path) && !pathsOf(registration).has(spec.path) ? spec : undefined;
}

/** The most frames one change looks at: eleven minutes of a clip at 30 frames a second. */
const MAX_FRAMES = 20000;

/** The frames of the timeline that show a clip, from one reading of its clock to another. */
function framesOf(clip: ClipState, rate: FrameRate, from: number, to: number): FrameMoment[] {
  const start = clipStart(clip);
  const end = clipEnd(clip);
  const offset = clipOffset(clip);
  const startSeconds = toSeconds(start);
  const shift = startSeconds - toSeconds(offset);
  const first = Math.max(from + shift, startSeconds);
  const last = Math.min(to + shift, toSeconds(end));
  if (!(last >= first)) return [];
  const frames: FrameMoment[] = [];
  const firstFrame = Math.max(Math.ceil(first * rate.fps - 1e-6), 0);
  const lastFrame = Math.min(Math.floor(last * rate.fps + 1e-6), firstFrame + MAX_FRAMES);
  for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
    const moment = frameTime(frame, rate);
    if (compare(moment, start) < 0 || compare(moment, end) >= 0) continue;
    const clock = add(offset, subtract(moment, start));
    frames.push({ time: formatTime(clock), clock: toSeconds(clock) });
  }
  return frames;
}
