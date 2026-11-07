import {
  canMix,
  clipOffset,
  clipStart,
  effectiveProperties,
  entryOf,
  secondsOf,
  type ClipState,
  type PropertyEdit,
} from "@animaquill/core";
import {
  add,
  parseTime,
  subtract,
  type Animation,
  type Key,
  type Rational,
} from "@animaquill/schema";
import { RULER_HEIGHT } from "../timeline/editor.ts";
import type { Gesture, Marquee, Pointer } from "../timeline/gestures.ts";
import { forEachBetween, type ClipBox } from "../timeline/model.ts";
import type { SnapPoint } from "../timeline/snap.ts";
import type { TouchStart } from "../timeline/touch.ts";
import type { KeyframeEditor, ShownClips } from "./editor.ts";
import {
  HandleGesture,
  KeyMarqueeGesture,
  KeyMoveGesture,
  TallHeightGesture,
  liftKey,
  type Grabbed,
  type KeyGestureHost,
  type KeyPreview,
  type LiftedChannel,
} from "./gestures.ts";
import { farPoint, handlePoint, type CurvePoint, type HandleSide } from "./handles.ts";
import { firstLaneBelow, laneAt, type Lane } from "./lanes.ts";
import { perPixel, scaleOf, valueIn, yIn, type ValueScale } from "./scale.ts";
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
/** How close to the bottom of a row that was made taller the pointer has to be to pull it. */
const TALL_EDGE_REACH = 4;
/** Half the size of a key as it is drawn, which is what a box has to reach to take it. */
const KEY_SIZE = 5;
/** A handle right on its key shows this far out, so that it can be taken hold of. */
const MIN_HANDLE_LENGTH = 12;
/** Keys closer together than this have no room for handles in between. */
const MIN_HANDLE_STRETCH = 16;
/** More handles than this are not something to drag one of. */
const MAX_HANDLES = 400;
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

/** A handle of a selected key, where it shows. */
export interface ShownHandle {
  readonly id: string;
  readonly lane: Lane;
  readonly box: ClipBox;
  readonly path: string;
  /** The key it belongs to, and where that is among the keys. */
  readonly time: string;
  readonly index: number;
  readonly side: HandleSide;
  /** On screen: the key, and the end of the handle. */
  readonly keyX: number;
  readonly keyY: number;
  readonly x: number;
  readonly y: number;
}

export type LaneHit =
  | ({ readonly kind: "key" } & KeySpot)
  | { readonly kind: "handle"; readonly handle: ShownHandle }
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
    const { selection, preview, previewedValues, model, heldRanges } = keyframes;
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
      heldRanges,
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

  /**
   * Where values are in a lane of a number with keys, which is the curve of that number. Undefined
   * for anything else: summaries, and what only holds, keep their keys in the middle.
   */
  scaleOf(lane: Lane, box: ClipBox): ValueScale | undefined {
    const { node } = lane;
    if (node.kind !== "property" || !canMix(node.spec.type)) return undefined;
    const { keyframes } = this;
    const { path } = node.spec;
    const value = keyframes.shownValue(box.clip, path);
    if (!animationIn(value)) return undefined;
    const range = keyframes.rangeOf(box.id, path, value as Animation, node.spec);
    return range && scaleOf(range, node.spec, lane.height);
  }

  /** How far down from the top of its lane a key of a table is. */
  keyY(lane: Lane, table: KeyTable, index: number, scale: ValueScale | undefined): number {
    const value = table.numbers?.[index];
    return scale && value !== undefined ? yIn(scale, value) : lane.height / 2;
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

  /**
   * The key nearest to a place in a lane. A row of the usual height is about the time, and a row
   * made taller about where on its curve the key is as well.
   */
  #spotNear(lane: Lane, x: number, y: number): KeySpot | undefined {
    const reach = this.#reach / this.pixelsPerSecond;
    const moment = this.timeAt(x);
    const top = this.screenY(lane.top);
    let best: { box: ClipBox; clock: number; distance: number } | undefined;
    this.forEachBox(lane, moment - reach, moment + reach, (box) => {
      const table = this.tableOf(lane, box);
      if (!table) return;
      const target = moment - box.start + box.offset;
      const scale = lane.tall ? this.scaleOf(lane, box) : undefined;
      if (scale) {
        const vertical = Math.max(this.#reach, lane.keyHeight / 2);
        const { seconds } = table;
        for (let index = firstFrom(seconds, target - reach); index < seconds.length; index += 1) {
          const clock = seconds[index] as number;
          if (clock > target + reach) break;
          const dy = Math.abs(top + this.keyY(lane, table, index, scale) - y);
          if (dy > vertical) continue;
          const distance = Math.hypot((clock - target) * this.pixelsPerSecond, dy);
          if (!best || distance < best.distance) best = { box, clock, distance };
        }
        return;
      }
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

  /**
   * What is at a place. The ruler covers what has scrolled under it, so there is nothing there. The
   * handles of selected keys are on top of everything, also where they reach over another row.
   */
  hitAt(pointer: Pointer): LaneHit {
    if (pointer.y < RULER_HEIGHT) return { kind: "empty" };
    const handle = this.#handleNear(pointer);
    if (handle) return { kind: "handle", handle };
    const y = this.laneY(pointer.y);
    const lane = laneAt(this.lanes, y);
    if (!lane) return { kind: "empty" };
    const fromBottom = lane.top + lane.height - y;
    if (lane.tall && fromBottom <= TALL_EDGE_REACH) return { kind: "edge", lane };
    const spot = this.#spotNear(lane, pointer.x, pointer.y);
    return spot
      ? { kind: "key", ...spot }
      : { kind: "lane", lane, seconds: this.timeAt(pointer.x) };
  }

  #handleNear(pointer: Pointer): ShownHandle | undefined {
    let best: ShownHandle | undefined;
    let distance = this.#reach;
    for (const handle of this.visibleHandles()) {
      const away = Math.hypot(handle.x - pointer.x, handle.y - pointer.y);
      if (away <= distance) [best, distance] = [handle, away];
    }
    return best;
  }

  /** What the pointer looks like over a place. */
  protected cursorAt(pointer: Pointer): string {
    const { kind } = this.hitAt(pointer);
    if (kind === "edge") return "ns-resize";
    return kind === "key" || kind === "handle" ? "pointer" : "default";
  }

  /** What a press on the lanes means. */
  protected pressLanes(pointer: Pointer): Gesture {
    const hit = this.hitAt(pointer);
    if (hit.kind === "key") return this.#pressKey(hit, pointer);
    if (hit.kind === "handle") return this.#pressHandle(hit.handle, pointer);
    if (hit.kind === "edge" && hit.lane.node.kind === "property" && hit.lane.box) {
      const { box, node } = hit.lane;
      const resize = (height: number) =>
        this.keyframes.setTallHeight(box.id, node.spec.path, height);
      return new TallHeightGesture(resize, hit.lane.height, pointer);
    }
    return new KeyMarqueeGesture(this.#host, pointer);
  }

  #pressHandle({ lane, box, path, index, side }: ShownHandle, pointer: Pointer): Gesture {
    const { keyframes } = this;
    const animation = animationIn(keyframes.shownValue(box.clip, path)) as Animation;
    const scale = this.scaleOf(lane, box) as ValueScale;
    const toClock = box.offset - box.start;
    const { top } = lane;
    const grab = {
      clip: box.id,
      path,
      keys: animation.keys,
      index,
      side,
      pointAt: (at: Pointer): CurvePoint => ({
        t: this.timeAt(at.x) + toClock,
        v: valueIn(scale, at.y - this.screenY(top)),
      }),
    };
    return new HandleGesture(this.#host, grab, pointer);
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
    const lifted = this.#lifted(spot);
    return new KeyMoveGesture(this.#host, this.#grabbed(spot), pointer, onClick, lifted);
  }

  /**
   * The selected numbers that go up and down with a key of a number that is dragged. Each one goes
   * as far as the mouse does in its own row, so what a pixel is worth comes from there. Keys of rows
   * that are not here only move along the time.
   */
  #lifted({ lane, box }: KeySpot): readonly LiftedChannel[] {
    if (!this.scaleOf(lane, box)) return [];
    const { keyframes } = this;
    const rows = new Map<string, Lane>();
    for (const one of this.lanes) {
      if (one.node.kind === "property" && one.box)
        rows.set(liftKey(one.box.id, one.node.spec.path), one);
    }
    return keyframes.movingChannels().flatMap(({ clip, path, times }): LiftedChannel[] => {
      const row = rows.get(liftKey(clip, path));
      const rowBox = row?.box;
      const scale = row && rowBox ? this.scaleOf(row, rowBox) : undefined;
      if (!row || !rowBox || !scale || row.node.kind !== "property") return [];
      const animation = animationIn(
        entryOf(effectiveProperties(keyframes.shown(rowBox.clip)), path),
      );
      const wanted = new Set(times);
      const keys = new Map<string, Key>();
      for (const key of animation?.keys ?? []) {
        if (wanted.has(key.time) && typeof key.value === "number") keys.set(key.time, key);
      }
      const { spec } = row.node;
      return keys.size > 0 ? [{ clip, path, spec, perPixel: perPixel(scale), keys }] : [];
    });
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

  /**
   * A box is for doing something with keys, so what cannot change stays out of it. In a row made
   * taller it takes the keys it covers on the curve, and elsewhere what is in the rows it covers.
   */
  #keysIn({ from, to, top, bottom }: Marquee): readonly KeyRef[] {
    return this.lanesBetween(top, bottom).flatMap((lane) => {
      const keys = lane.tall
        ? this.#keysCovered(lane, from, to, top, bottom)
        : this.keysBetween(lane, from, to);
      return keys.filter(({ clip }) => this.keyframes.canMove(clip));
    });
  }

  #keysCovered(lane: Lane, from: number, to: number, top: number, bottom: number): KeyRef[] {
    const { box, node } = lane;
    if (!box || node.kind !== "property") return [...this.keysBetween(lane, from, to)];
    const scale = this.scaleOf(lane, box);
    const table = this.tableOf(lane, box);
    const animation = animationIn(
      entryOf(effectiveProperties(this.keyframes.shown(box.clip)), node.spec.path),
    );
    if (!table || !animation) return [];
    const found: KeyRef[] = [];
    const { seconds } = table;
    const toClock = box.offset - box.start;
    for (let index = firstFrom(seconds, from + toClock); index < seconds.length; index += 1) {
      if ((seconds[index] as number) > to + toClock) break;
      const y = lane.top + this.keyY(lane, table, index, scale);
      if (y + KEY_SIZE < top || y - KEY_SIZE > bottom) continue;
      found.push({ clip: box.id, path: node.spec.path, time: (animation.keys[index] as Key).time });
    }
    return found;
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
      holdRanges: (rows) => keyframes.holdRanges(rows),
      releaseRanges: () => keyframes.releaseRanges(),
    };
  }

  /** What a finger starts on a key: only selected keys go along right away. */
  protected touchAtLanes(pointer: Pointer): TouchStart {
    const hit = this.hitAt(pointer);
    if (hit.kind === "edge" || hit.kind === "handle") return "grab";
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

  /**
   * The handles of the selected keys on screen, in rows of numbers, where they show. A handle right
   * on its key shows a little way out along the curve, so that it can be taken hold of. Nothing
   * shows while keys move, or where keys are too close together to have room for handles.
   */
  visibleHandles(): readonly ShownHandle[] {
    const { keyframes } = this;
    if (keyframes.selection.size === 0 || keyframes.preview?.shift !== undefined) return [];
    const found: ShownHandle[] = [];
    const from = this.timeAt(0);
    const to = this.timeAt(this.width);
    for (const lane of this.lanesBetween(this.laneY(RULER_HEIGHT), this.laneY(this.screenHeight))) {
      const { box } = lane;
      if (!box || lane.node.kind !== "property" || !keyframes.canMove(box.id)) continue;
      this.#handlesOf(lane, box, from, to, found);
      if (found.length >= MAX_HANDLES) return [];
    }
    return found;
  }

  #handlesOf(lane: Lane, box: ClipBox, from: number, to: number, found: ShownHandle[]): void {
    const { keyframes } = this;
    const selected = keyframes.selectedSeconds(lane, box);
    const scale = selected && this.scaleOf(lane, box);
    if (!selected || !scale || lane.node.kind !== "property") return;
    const { path } = lane.node.spec;
    const animation = animationIn(keyframes.shownValue(box.clip, path));
    if (!animation) return;
    const { keys } = animation;
    const { seconds } = keyTableOf(animation);
    const toClock = box.offset - box.start;
    const top = this.screenY(lane.top);
    const place = ({ t, v }: CurvePoint) => ({ x: this.xAt(t - toClock), y: top + yIn(scale, v) });
    // Keys just off screen have handles that reach onto it.
    const first = seconds[Math.max(firstFrom(seconds, from + toClock) - 1, 0)] ?? 0;
    const last = seconds[Math.min(firstFrom(seconds, to + toClock), seconds.length - 1)] ?? 0;
    for (let at = firstFrom(selected, first); at < selected.length; at += 1) {
      const clock = selected[at] as number;
      if (clock > last) break;
      const index = indexAt(seconds, clock);
      const key = keys[index];
      if (!key || typeof key.value !== "number") continue;
      const center = place({ t: clock, v: key.value });
      for (const side of ["in", "out"] as const) {
        const neighbour = keys[side === "out" ? index + 1 : index - 1];
        const point = handlePoint(keys, index, side);
        if (!point || !neighbour || typeof neighbour.value !== "number") continue;
        const other = place({ t: secondsOf(neighbour.time), v: neighbour.value });
        if (Math.abs(other.x - center.x) < MIN_HANDLE_STRETCH) continue;
        let end = place(point);
        if (Math.hypot(end.x - center.x, end.y - center.y) < MIN_HANDLE_LENGTH) {
          // Where the curve heads from the key, or else where the next key is.
          const far = farPoint(keys, index, side);
          const heading = far ? place(far) : other;
          const toward =
            Math.hypot(heading.x - center.x, heading.y - center.y) > 1 ? heading : other;
          const length = Math.hypot(toward.x - center.x, toward.y - center.y);
          if (length < 1) continue;
          end = {
            x: center.x + ((toward.x - center.x) / length) * MIN_HANDLE_LENGTH,
            y: center.y + ((toward.y - center.y) / length) * MIN_HANDLE_LENGTH,
          };
        }
        // Keys just off screen are here for handles that reach onto it, and only for those.
        const { width } = this;
        if ((center.x < 0 && end.x < 0) || (center.x > width && end.x > width)) continue;
        found.push({
          id: `${lane.id} ${key.time} ${side}`,
          lane,
          box,
          path,
          time: key.time,
          index,
          side,
          keyX: center.x,
          keyY: center.y,
          x: end.x,
          y: end.y,
        });
      }
    }
  }

  /** The keys on screen, up to a limit: this is for reading, not for drawing. */
  visibleKeys(limit: number): readonly VisibleKey[] {
    const found: VisibleKey[] = [];
    const { selection } = this.keyframes;
    const from = this.timeAt(0);
    const to = this.timeAt(this.width);
    const top = this.laneY(0);
    for (const lane of this.lanesBetween(top, this.laneY(this.screenHeight))) {
      const laneTop = this.screenY(lane.top);
      this.forEachBox(lane, from, to, (box) => {
        const table = this.tableOf(lane, box);
        if (!table) return;
        const scale = this.scaleOf(lane, box);
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
            y: laneTop + this.keyY(lane, table, index, scale),
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
