import {
  anchoredAt,
  applyEdit,
  CommandError,
  secondsOf,
  solveHandle,
  straightened,
  transformPoint,
  turnBetween,
  type GrabHandle,
  type HandlePoint,
  type Matrix,
  type Placement,
  type Point,
  type PropertyEdit,
} from "@animaquill/core";
import {
  compare,
  isAnimation,
  parseTime,
  type Key,
  type PropertySpec,
  type PropertyValue,
} from "@animaquill/schema";
import { compensation, type AnchorMove, type FrameMoment } from "./compensate.ts";
import { numberAt, tidy } from "./numbers.ts";

export { tidy };

/**
 * What dragging a handle on the picture does, worked out from where the pointer is. A gesture keeps
 * where it started and what the picture showed then, which is what a drag goes by. What it writes
 * is worked out from the properties as they are at every step, and when it lets go, so that what
 * somebody else changed in the meantime stays changed. When what it changes is gone, it stops.
 */

/** Where the pointer is on the overlay, and the keys that change what a drag does. */
export interface OverlayPointer {
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface Gesture {
  /**
   * What the drag comes to with the pointer here: edits for `PropertyWriter`. Nothing once what it
   * changes went away, for an undo or in another window.
   */
  edits(pointer: OverlayPointer): readonly PropertyEdit[] | undefined;
}

/** A property as it is right now. */
export interface Live {
  /** What it holds, keys and all, with what is being tried on top. */
  readonly stored: PropertyValue | undefined;
  /** Writes a value where the properties tab would: on the key of this frame, if it has keys. */
  readonly write: (value: number) => PropertyEdit;
}

/** A property that a drag writes. */
export interface Bound {
  readonly path: string;
  readonly spec: PropertySpec;
  /** What the picture showed when the drag started, which is what it goes from. */
  readonly start: number;
  /** As it is now. Nothing once it cannot be written: its clip is gone, or got locked. */
  readonly now: () => Live | undefined;
}

const pointOf = ({ x, y }: Point): HandlePoint => [x, y];

/**
 * A handle that says what it binds: the values come from `solveHandle`, in the coordinates of the
 * handle, which is where `toSpace` takes the pointer.
 */
export function declarativeGesture(
  handle: GrabHandle,
  toSpace: Matrix,
  binds: ReadonlyMap<string, Bound>,
  pressed: OverlayPointer,
): Gesture {
  const from = pointOf(transformPoint(toSpace, pressed));
  let last = from;
  let turned = 0;
  return {
    edits(pointer) {
      const to = pointOf(transformPoint(toSpace, pointer));
      if (handle.kind === "rotate") {
        turned += turnBetween(handle.at, last, to);
        last = to;
      }
      const values = solveHandle(
        handle,
        { from, to, turned, shift: pointer.shift },
        (bind) => binds.get(bind)?.start,
      );
      const edits: PropertyEdit[] = [];
      for (const [bind, value] of values) {
        const bound = binds.get(bind);
        const live = bound?.now();
        if (!bound || !live) return undefined;
        edits.push(live.write(tidy(value, bound.spec)));
      }
      return edits;
    },
  };
}

const keysOf = (value: PropertyValue | undefined): readonly Key[] =>
  value !== undefined && isAnimation(value) ? value.keys : [];

export interface AnchorBinds {
  readonly x: Bound;
  readonly y: Bound;
  readonly anchorX: Bound;
  readonly anchorY: Bound;
}

/** Where a drag of the anchor goes by. */
export interface AnchorPlace {
  readonly clip: string;
  /** Where the clip was when the drag started. */
  readonly placement: Placement;
  /** The clock of the clip at the playhead. */
  readonly clock: number;
  readonly toScreen: Matrix;
  readonly toWorld: Matrix;
  /** Corners and middles to stop at, in the world. */
  readonly stops: readonly Point[];
  /** The frames of the clip between two readings of its clock. */
  readonly frames: (from: number, to: number) => readonly FrameMoment[];
}

/** How close to a corner or a middle the anchor has to come to stop there, in pixels. */
export const ANCHOR_SNAP = 8;

/** What a write does to a value, or nothing when it cannot. */
function written(stored: PropertyValue | undefined, edit: PropertyEdit) {
  try {
    return { value: applyEdit(stored, edit) };
  } catch (error) {
    if (error instanceof CommandError) return undefined;
    throw error;
  }
}

/**
 * Moves the anchor and keeps the picture where it is, on every frame: the position goes along, see
 * `compensation`. The anchor goes as far as the pointer went, wherever it was grabbed, and stops at
 * corners and middles on the way, which Alt leaves out. It gets written like any other value, on the
 * key of this frame where it has keys.
 */
export function anchorGesture(
  place: AnchorPlace,
  binds: AnchorBinds,
  pressed: OverlayPointer,
): Gesture {
  const { placement, toScreen, toWorld, clip } = place;
  const { transform, box, matrix } = placement;
  const grabbed = transformPoint(toScreen, { x: transform.x, y: transform.y });
  const stops = place.stops.map((stop) => transformPoint(toScreen, stop));
  // How far one share of the box moves the position in each direction.
  const [a, b, c, d] = matrix;
  return {
    edits(pointer) {
      let aim = { x: grabbed.x + pointer.x - pressed.x, y: grabbed.y + pointer.y - pressed.y };
      if (!pointer.alt) {
        const near = stops.find(({ x, y }) => Math.hypot(x - aim.x, y - aim.y) <= ANCHOR_SNAP);
        if (near) aim = near;
      }
      const moved = anchoredAt(placement, transformPoint(toWorld, aim));
      const live = {
        x: binds.x.now(),
        y: binds.y.now(),
        anchorX: binds.anchorX.now(),
        anchorY: binds.anchorY.now(),
      };
      const { x, y, anchorX, anchorY } = live;
      if (!x || !y || !anchorX || !anchorY) return undefined;
      if (!moved) return [];
      const toX = anchorX.write(tidy(moved.anchorX, binds.anchorX.spec));
      const toY = anchorY.write(tidy(moved.anchorY, binds.anchorY.spec));
      // What the position needs goes by where the anchor really went, which is round where the
      // pointer went a round way: the few digits of a share that get written are not.
      const afterX = written(anchorX.stored, anchorX.write(moved.anchorX));
      const afterY = written(anchorY.stored, anchorY.write(moved.anchorY));
      if (!afterX || !afterY) return undefined;
      const side = (
        bound: Bound,
        before: Live,
        after: { value: PropertyValue | undefined },
        edit: PropertyEdit,
        perShare: number,
      ) => ({
        spec: bound.spec,
        before: before.stored,
        after: after.value,
        at: edit.op === "write" && keysOf(after.value).length > 0 ? edit.time : undefined,
        perShare,
      });
      const move = (perX: number, perY: number): AnchorMove => ({
        clock: place.clock,
        x: side(binds.anchorX, anchorX, afterX, toX, perX),
        y: side(binds.anchorY, anchorY, afterY, toY, perY),
        frames: place.frames,
      });
      const position = (bound: Bound, now: Live) => ({
        clip,
        path: bound.path,
        spec: bound.spec,
        stored: now.stored,
        write: now.write,
      });
      return [
        toX,
        toY,
        ...compensation(position(binds.x, x), move(a * box.width, c * box.height)),
        ...compensation(position(binds.y, y), move(b * box.width, d * box.height)),
      ];
    },
  };
}

/** A key of a position, as its path shows it. */
export interface PathKeyAt {
  readonly time: string;
  readonly x: number;
  readonly y: number;
  /** Which of the two directions have a key there. */
  readonly hasX: boolean;
  readonly hasY: boolean;
}

/**
 * Drags a key on the path of a clip: the position at that moment goes as far as the pointer went.
 * Only a direction that has keys changes, because writing one that has none would move all of the
 * path. One without a key at that moment gets one. Shift keeps to the direction it went further in.
 * It goes from the keys as they are at every step, and stops when a key it moves went away.
 */
export function pathKeyGesture(
  clip: string,
  key: PathKeyAt,
  toWorld: Matrix,
  binds: { readonly x: Bound; readonly y: Bound },
  pressed: OverlayPointer,
): Gesture {
  const from = transformPoint(toWorld, pressed);
  const moment = parseTime(key.time);
  return {
    edits(pointer) {
      const to = transformPoint(toWorld, pointer);
      const [dx, dy] = straightened(to.x - from.x, to.y - from.y, pointer.shift);
      const edits: PropertyEdit[] = [];
      for (const [bound, by, had, start] of [
        [binds.x, dx, key.hasX, key.x],
        [binds.y, dy, key.hasY, key.y],
      ] as const) {
        const live = bound.now();
        if (!live) return undefined;
        const keys = keysOf(live.stored);
        const there = keys.find(({ time }) => compare(parseTime(time), moment) === 0);
        // A key that this moves is not there any more.
        if (had && (!there || typeof there.value !== "number")) return undefined;
        if (keys.length === 0) continue;
        const now = numberAt(live.stored, bound.spec, secondsOf(key.time)) ?? start;
        const value = there ? (there.value as number) : now;
        const target = { owner: { clip }, path: bound.path };
        edits.push({
          ...target,
          op: "setKey",
          time: there?.time ?? key.time,
          value: tidy(value + by, bound.spec),
        });
      }
      return edits;
    },
  };
}
