import {
  clipOffset,
  clipStart,
  effectiveProperties,
  entryOf,
  secondsOf,
  type ClipState,
  type PropertyEdit,
} from "@animaquill/core";
import { add, parseTime, subtract, type Key, type Rational } from "@animaquill/schema";
import { RULER_HEIGHT } from "../timeline/editor.ts";
import type { Gesture, Marquee, Pointer } from "../timeline/gestures.ts";
import { forEachBetween, type ClipBox } from "../timeline/model.ts";
import type { SnapPoint } from "../timeline/snap.ts";
import type { TouchStart } from "../timeline/touch.ts";
import type { KeyframeEditor, ShownClips } from "./editor.ts";
import {
  CurveHeightGesture,
  KeyMarqueeGesture,
  KeyMoveGesture,
  type Grabbed,
  type KeyGestureHost,
  type KeyPreview,
} from "./gestures.ts";
import { LANE_HEIGHT, firstLaneBelow, laneAt, type Lane } from "./lanes.ts";
import { KeySelection, type KeyRef } from "./selection.ts";
import {
  SAME_MOMENT,
  animationIn,
  firstFrom,
  indexAt,
  keyTableOf,
  markFor,
  nearest,
  summaryOf,
  type KeyTable,
} from "./tables.ts";

/** How far the pointer can be from a key and still grab it. */
const KEY_REACH = 7;
/** A fingertip covers more than a mouse pointer. */
const TOUCH_KEY_REACH = 14;
/** How close to the bottom of a curve the pointer has to be to pull it. */
const CURVE_EDGE_REACH = 4;
/** More than a mouse can tell apart, and looking through them takes time at the start of a drag. */
const MAX_SNAP_KEYS = 4000;
/** Pixels between keys that are worth telling apart in a list for people who cannot see them. */
const MIN_KEY_GAP = 3;

/** A place keys are at. It can be more than one in a summary. */
export interface KeySpot {
  readonly lane: Lane;
  readonly box: ClipBox;
  /** On the clock of the clip. */
  readonly clock: number;
  readonly keys: readonly KeyRef[];
}

export type LaneHit =
  | ({ readonly kind: "key" } & KeySpot)
  | { readonly kind: "edge"; readonly lane: Lane }
  | { readonly kind: "lane"; readonly lane: Lane; readonly seconds: number }
  | { readonly kind: "empty" };

/** A key on screen, in pixels from the top left of the area. */
export interface VisibleKey {
  readonly id: string;
  readonly lane: Lane;
  readonly box: ClipBox;
  readonly x: number;
  readonly y: number;
  /** On the timeline. */
  readonly seconds: number;
  readonly mark: number;
  readonly selected: boolean;
  readonly tried: boolean;
}

/** Where a key is on the timeline, exactly. */
export const momentOfKey = (clip: ClipState, time: string): Rational =>
  add(clipStart(clip), subtract(parseTime(time), clipOffset(clip)));

/**
 * A list of lanes on a canvas, wherever it is: finding what is at a place, and what a press there
 * means. The tab of its own and the room under a track of the timeline both work like this.
 */
export abstract class KeyArea {
  readonly keyframes: KeyframeEditor;
  /** How far a key can be from the pointer. */
  #reach = KEY_REACH;

  constructor(keyframes: KeyframeEditor) {
    this.keyframes = keyframes;
  }

  abstract get lanes(): readonly Lane[];
  /** Hears about a new list of lanes. */
  abstract readonly subscribeLanes: (listener: () => void) => () => void;
  abstract readonly getLanes: () => readonly Lane[];
  /** Opens or closes what a lane holds. */
  abstract toggleLane(lane: Lane): void;
  abstract get width(): number;
  /** How far down the area goes on screen, from the same place as heights on screen. */
  abstract get screenHeight(): number;
  abstract get scrollX(): number;
  abstract get scrollY(): number;
  abstract get pixelsPerSecond(): number;
  abstract xAt(seconds: number): number;
  abstract timeAt(x: number): number;
  /** The distance from the top of the first lane to a height on screen. */
  abstract laneY(y: number): number;
  /** Back from there to a height on screen. */
  abstract screenY(laneTop: number): number;
  abstract snapDistance(pointer: Pointer): number;
  /** The clips this shows keys of, which are the only ones what people do here is about. */
  abstract readonly shownClips: ShownClips;

  /**
   * All that a drawing depends on. When none of it changed, what is there is still right, which is
   * what playing comes down to: the playhead is an element and moves by itself.
   */
  get whatIsDrawn(): readonly unknown[] {
    const { keyframes, lanes, width, screenHeight, scrollX, scrollY, pixelsPerSecond } = this;
    const { selection, preview, previewedValues, model } = keyframes;
    return [
      pixelsPerSecond,
      scrollX,
      scrollY,
      width,
      screenHeight,
      lanes,
      model,
      selection,
      preview,
      previewedValues,
    ];
  }

  protected setTouch(on: boolean): void {
    this.#reach = on ? TOUCH_KEY_REACH : KEY_REACH;
  }

  /** The keys or the summary a lane shows of a clip. */
  tableOf(lane: Lane, box: ClipBox): KeyTable | undefined {
    const clip = this.keyframes.shown(box.clip);
    const { node } = lane;
    if (node.kind === "property") {
      const animation = animationIn(entryOf(effectiveProperties(clip), node.spec.path));
      return animation && keyTableOf(animation);
    }
    const paths = lane.listed.get(box.id);
    return paths && summaryOf(clip, paths);
  }

  /** The shape of a key in a lane. What cannot change gradually only holds, whatever a key says. */
  markIn({ node }: Lane, mark: number): number {
    return node.kind === "property" ? markFor(mark, node.spec.type) : mark;
  }

  /** Calls back with the clips a lane shows between two moments. */
  forEachBox(lane: Lane, from: number, to: number, visit: (box: ClipBox) => void): void {
    if (lane.box) visit(lane.box);
    else {
      forEachBetween(lane.row, from, to, (box) => {
        if (lane.listed.has(box.id)) visit(box);
      });
    }
  }

  /** The keys of a lane at a reading of the clock of a clip. */
  keysAt(lane: Lane, box: ClipBox, clock: number): readonly KeyRef[] {
    const properties = effectiveProperties(this.keyframes.shown(box.clip));
    return (lane.listed.get(box.id) ?? []).flatMap((path) => {
      const animation = animationIn(entryOf(properties, path));
      if (!animation) return [];
      const index = indexAt(keyTableOf(animation).seconds, clock);
      const key = animation.keys[index];
      return key ? [{ clip: box.id, path, time: key.time }] : [];
    });
  }

  /** All keys of a lane between two moments on the timeline. */
  keysBetween(lane: Lane, from: number, to: number): readonly KeyRef[] {
    const found: KeyRef[] = [];
    this.forEachBox(lane, from, to, (box) => {
      const properties = effectiveProperties(this.keyframes.shown(box.clip));
      const start = from - box.start + box.offset;
      const end = to - box.start + box.offset;
      for (const path of lane.listed.get(box.id) ?? []) {
        const animation = animationIn(entryOf(properties, path));
        if (!animation) continue;
        const { seconds } = keyTableOf(animation);
        for (let index = firstFrom(seconds, start); index < seconds.length; index += 1) {
          if ((seconds[index] as number) > end) break;
          found.push({ clip: box.id, path, time: (animation.keys[index] as Key).time });
        }
      }
    });
    return found;
  }

  #spotNear(lane: Lane, x: number): KeySpot | undefined {
    const reach = this.#reach / this.pixelsPerSecond;
    const moment = this.timeAt(x);
    let best: { box: ClipBox; clock: number; distance: number } | undefined;
    this.forEachBox(lane, moment - reach, moment + reach, (box) => {
      const table = this.tableOf(lane, box);
      if (!table) return;
      const target = moment - box.start + box.offset;
      const found = table.seconds[nearest(table.seconds, target)];
      if (found === undefined) return;
      const distance = Math.abs(found - target);
      if (distance <= reach && (!best || distance < best.distance)) {
        best = { box, clock: found, distance };
      }
    });
    if (!best) return undefined;
    const { box, clock } = best;
    const keys = this.keysAt(lane, box, clock);
    return keys.length > 0 ? { lane, box, clock, keys } : undefined;
  }

  /** What is at a place. The ruler covers what has scrolled under it, so there is nothing there. */
  hitAt(pointer: Pointer): LaneHit {
    if (pointer.y < RULER_HEIGHT) return { kind: "empty" };
    const y = this.laneY(pointer.y);
    const lane = laneAt(this.lanes, y);
    if (!lane) return { kind: "empty" };
    const fromBottom = lane.top + lane.height - y;
    if (lane.node.kind === "property" && lane.open && fromBottom <= CURVE_EDGE_REACH) {
      return { kind: "edge", lane };
    }
    const spot = y - lane.top < LANE_HEIGHT ? this.#spotNear(lane, pointer.x) : undefined;
    return spot
      ? { kind: "key", ...spot }
      : { kind: "lane", lane, seconds: this.timeAt(pointer.x) };
  }

  /** What the pointer looks like over a place. */
  protected cursorAt(pointer: Pointer): string {
    const { kind } = this.hitAt(pointer);
    if (kind === "edge") return "ns-resize";
    return kind === "key" ? "pointer" : "default";
  }

  /** What a press on the lanes means. */
  protected pressLanes(pointer: Pointer): Gesture {
    const hit = this.hitAt(pointer);
    if (hit.kind === "key") return this.#pressKey(hit, pointer);
    if (hit.kind === "edge") {
      const { id } = hit.lane;
      const resize = (height: number) => this.keyframes.setCurveHeight(id, height);
      const before = this.keyframes.curveHeightOf(id);
      return new CurveHeightGesture(resize, before, pointer);
    }
    return new KeyMarqueeGesture(this.#host, pointer);
  }

  #grabbed({ box, clock, keys }: KeySpot): Grabbed {
    const [key] = keys;
    const clip = this.keyframes.shown(box.clip);
    return {
      seconds: box.start + clock - box.offset,
      exact: () => momentOfKey(clip, (key as KeyRef).time),
    };
  }

  #pressKey(spot: KeySpot, pointer: Pointer): Gesture {
    const { keyframes } = this;
    const { selection } = keyframes;
    const { keys, box } = spot;
    const wasSelected = selection.includes(keys);
    const adding = pointer.shift || pointer.mod || keyframes.multiSelecting;
    const selected = adding ? selection.with(keys) : KeySelection.of(keys);
    // What a press on a selected key means shows when it ends: it may be the start of a drag.
    const onClick = () => {
      keyframes.select(adding && wasSelected ? selection.without(keys) : selected);
    };
    // A locked key can be looked at, but nothing moves it: a drag from there is a drag from nowhere.
    if (!keyframes.canMove(box.id)) return new KeyMarqueeGesture(this.#host, pointer, onClick);
    if (!wasSelected) keyframes.select(selected);
    return new KeyMoveGesture(this.#host, this.#grabbed(spot), pointer, onClick);
  }

  /** The lanes at least partly between two heights, as distances from the top of the first lane. */
  lanesBetween(top: number, bottom: number): readonly Lane[] {
    const { lanes } = this;
    const found: Lane[] = [];
    for (let index = firstLaneBelow(lanes, top); index < lanes.length; index += 1) {
      const lane = lanes[index] as Lane;
      if (lane.top >= bottom) break;
      found.push(lane);
    }
    return found;
  }

  /** A box is for doing something with keys, so what cannot change stays out of it. */
  #keysIn({ from, to, top, bottom }: Marquee): readonly KeyRef[] {
    return this.lanesBetween(top, bottom).flatMap((lane) =>
      this.keysBetween(lane, from, to).filter(({ clip }) => this.keyframes.canMove(clip)),
    );
  }

  /**
   * The keys in sight that something can stick to. Keys of a row that moves stay out of it: what lands
   * on one of those replaces it, and that should take more than coming close.
   */
  #snapTargets(): readonly SnapPoint[] {
    const { keyframes } = this;
    const moving = new Set(keyframes.movingChannels().map(({ clip, path }) => `${clip} ${path}`));
    const points: SnapPoint[] = [];
    const [from, to] = [this.timeAt(0), this.timeAt(this.width)];
    for (const lane of this.lanesBetween(this.laneY(0), this.laneY(this.screenHeight))) {
      for (const key of this.keysBetween(lane, from, to)) {
        const box = keyframes.model?.boxes.get(key.clip);
        if (!box || moving.has(`${key.clip} ${key.path}`)) continue;
        const seconds = box.start + secondsOf(key.time) - box.offset;
        points.push({ seconds, exact: () => momentOfKey(box.clip, key.time) });
        if (points.length >= MAX_SNAP_KEYS) return points;
      }
    }
    return points;
  }

  get #host(): KeyGestureHost {
    const { keyframes } = this;
    return {
      get model() {
        return keyframes.model as NonNullable<typeof keyframes.model>;
      },
      get frame() {
        return keyframes.frame;
      },
      get selection() {
        return keyframes.selection;
      },
      get multiSelecting() {
        return keyframes.multiSelecting;
      },
      timeAt: (x) => this.timeAt(x),
      laneAt: (y) => this.laneY(y),
      snapDistance: (pointer) => this.snapDistance(pointer),
      snapTargets: () => this.#snapTargets(),
      moving: () => keyframes.movingChannels(),
      keysIn: (marquee) => this.#keysIn(marquee),
      select: (selection) => keyframes.select(selection),
      show: (preview: KeyPreview | undefined) => keyframes.showPreview(preview, this),
      preview: (edits: readonly PropertyEdit[]) => keyframes.previewEdits(edits),
      cancelPreview: () => keyframes.cancelEdits(),
      commit: (edits, selection) => keyframes.commitMove(edits, selection),
    };
  }

  /** What a finger starts on a key: only selected keys go along right away. */
  protected touchAtLanes(pointer: Pointer): TouchStart {
    const hit = this.hitAt(pointer);
    if (hit.kind === "edge") return "grab";
    const held = hit.kind === "key" && this.keyframes.selection.includes(hit.keys);
    return held ? "selected" : "plain";
  }

  /** A long press selects the key that is there. */
  protected holdLanes(pointer: Pointer): void {
    const hit = this.hitAt(pointer);
    if (hit.kind !== "key" || this.keyframes.selection.includes(hit.keys)) return;
    const { keyframes } = this;
    const { selection, multiSelecting } = keyframes;
    keyframes.select(multiSelecting ? selection.with(hit.keys) : KeySelection.of(hit.keys));
  }

  /** Makes the keys of a place what is selected. */
  selectSpot({ keys }: KeySpot): void {
    this.keyframes.select(KeySelection.of(keys));
  }

  /** All keys at the moment of a key, in everything this shows. */
  selectColumn(spot: KeySpot, adding: boolean): void {
    const moment = spot.box.start + spot.clock - spot.box.offset;
    // What is at the top covers all that is under it.
    const found = this.lanes.flatMap((lane) =>
      lane.depth === 0 ? this.keysBetween(lane, moment - SAME_MOMENT, moment + SAME_MOMENT) : [],
    );
    const { keyframes } = this;
    keyframes.select(adding ? keyframes.selection.with(found) : KeySelection.of(found));
  }

  /** All keys in this list that can be worked on. */
  selectAll(): void {
    const everywhere = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const;
    const found = this.lanes.flatMap((lane) =>
      lane.depth === 0
        ? this.keysBetween(lane, ...everywhere).filter(({ clip }) => this.keyframes.canMove(clip))
        : [],
    );
    this.keyframes.select(KeySelection.of(found));
  }

  /** The keys of one row, or all that is below a parent. */
  selectLane(lane: Lane, adding: boolean): void {
    const found = this.keysBetween(lane, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    const { keyframes } = this;
    keyframes.select(adding ? keyframes.selection.with(found) : KeySelection.of(found));
  }

  /** The keys on screen, up to a limit: this is for reading, not for drawing. */
  visibleKeys(limit: number): readonly VisibleKey[] {
    const found: VisibleKey[] = [];
    const { selection } = this.keyframes;
    const from = this.timeAt(0);
    const to = this.timeAt(this.width);
    const top = this.laneY(0);
    for (const lane of this.lanesBetween(top, this.laneY(this.screenHeight))) {
      const y = this.screenY(lane.top) + LANE_HEIGHT / 2;
      this.forEachBox(lane, from, to, (box) => {
        const table = this.tableOf(lane, box);
        if (!table) return;
        const { seconds, marks } = table;
        let lastX = Number.NEGATIVE_INFINITY;
        const start = firstFrom(seconds, from - box.start + box.offset);
        for (let index = start; index < seconds.length && found.length < limit; index += 1) {
          const moment = box.start + (seconds[index] as number) - box.offset;
          if (moment > to) break;
          const x = this.xAt(moment);
          if (x - lastX < MIN_KEY_GAP) continue;
          lastX = x;
          const clock = seconds[index] as number;
          const keys = this.keysAt(lane, box, clock);
          found.push({
            id: `${lane.id} ${box.id} ${clock}`,
            lane,
            box,
            x,
            y,
            seconds: moment,
            mark: this.markIn(lane, marks[index] as number),
            selected: keys.length > 0 && selection.includes(keys),
            tried: keys.some((key) => this.keyframes.isTriedKey(key)),
          });
        }
      });
    }
    return found;
  }
}
