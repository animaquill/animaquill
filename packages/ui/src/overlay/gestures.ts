import {
  anchoredAt,
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
import { isAnimation, type Key, type PropertySpec, type PropertyValue } from "@animaquill/schema";

/**
 * What dragging a handle on the picture does, worked out from where the pointer is. A gesture keeps
 * what it started from, so that the values it shows while the picture changes under it are always
 * worked out from the same place, and the last of them is what gets written.
 */

/** Where the pointer is on the overlay, and the keys that change what a drag does. */
export interface OverlayPointer {
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
}

export interface Gesture {
  /** What the drag comes to with the pointer here: edits for `PropertyWriter`. */
  edits(pointer: OverlayPointer): readonly PropertyEdit[];
}

/** Enough for anything a person means, and it keeps float noise out of project files. */
const KEPT_DIGITS = 6;

/** A value as it gets written: within the limits of its property, without float noise. */
export function tidy(value: number, spec: PropertySpec): number {
  const kept = Number(value.toFixed(KEPT_DIGITS));
  return Math.min(Math.max(kept === 0 ? 0 : kept, spec.min ?? -Infinity), spec.max ?? Infinity);
}

/** A property that a drag writes: what it starts from, and how a value of it gets written. */
export interface Bound {
  readonly path: string;
  readonly spec: PropertySpec;
  readonly start: number;
  /** What it holds now, keys and all. */
  readonly stored: PropertyValue | undefined;
  /** Writes a value where the properties tab would: on the key of this frame, if it has keys. */
  readonly write: (value: number) => PropertyEdit;
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
        if (bound) edits.push(bound.write(tidy(value, bound.spec)));
      }
      return edits;
    },
  };
}

const keysOf = (value: PropertyValue | undefined): readonly Key[] =>
  value !== undefined && isAnimation(value) ? value.keys : [];

const isKeyed = (bound: Bound) => keysOf(bound.stored).length > 0;

/** Every key of a position somewhere else by the same distance, so that its path moves as a whole. */
function shifted(bound: Bound, clip: string, by: number): PropertyEdit {
  const keys = keysOf(bound.stored).map((key) =>
    typeof key.value === "number" ? { ...key, value: tidy(key.value + by, bound.spec) } : key,
  );
  return { owner: { clip }, path: bound.path, op: "putKeys", keys };
}

export interface AnchorBinds {
  readonly x: Bound;
  readonly y: Bound;
  readonly anchorX: Bound;
  readonly anchorY: Bound;
}

/** How close to a corner or a middle the anchor has to come to stop there, in pixels. */
export const ANCHOR_SNAP = 8;

/**
 * Moves the anchor and keeps the picture where it is: the position goes along. With keys on the
 * position and none on the anchor, the anchor changes for all of the clip, and so all keys of the
 * position move by the same distance. That keeps the picture still on every frame of a clip that
 * does not turn or scale over time, and its path keeps its shape. With keys on the anchor, both get
 * a key here, as any other change would. Alt leaves out stopping at corners and middles.
 */
export function anchorGesture(
  clip: string,
  placement: Placement,
  toScreen: Matrix,
  toWorld: Matrix,
  stops: readonly Point[],
  binds: AnchorBinds,
): Gesture {
  const keyedAnchor = isKeyed(binds.anchorX) || isKeyed(binds.anchorY);
  const onScreen = stops.map((stop) => ({ stop, at: transformPoint(toScreen, stop) }));
  return {
    edits(pointer) {
      let world = transformPoint(toWorld, pointer);
      if (!pointer.alt) {
        const near = onScreen.find(
          ({ at }) => Math.hypot(at.x - pointer.x, at.y - pointer.y) <= ANCHOR_SNAP,
        );
        if (near) world = near.stop;
      }
      const moved = anchoredAt(placement, world);
      if (!moved) return [];
      const edits = [
        binds.anchorX.write(tidy(moved.anchorX, binds.anchorX.spec)),
        binds.anchorY.write(tidy(moved.anchorY, binds.anchorY.spec)),
      ];
      const { transform } = placement;
      for (const [bound, value, from] of [
        [binds.x, moved.x, transform.x],
        [binds.y, moved.y, transform.y],
      ] as const) {
        if (!keyedAnchor && isKeyed(bound)) edits.push(shifted(bound, clip, value - from));
        else edits.push(bound.write(tidy(value, bound.spec)));
      }
      return edits;
    },
  };
}

/** A key of a position, as its path shows it. */
export interface PathKeyAt {
  readonly time: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Drags a key on the path of a clip: the position at that moment goes where the pointer goes. Only
 * a direction that has keys changes, because writing one that has none would move all of the path.
 * One without a key at that moment gets one. Shift keeps to the direction it went further in.
 */
export function pathKeyGesture(
  clip: string,
  key: PathKeyAt,
  toWorld: Matrix,
  binds: { readonly x: Bound; readonly y: Bound },
  pressed: OverlayPointer,
): Gesture {
  const from = transformPoint(toWorld, pressed);
  return {
    edits(pointer) {
      const to = transformPoint(toWorld, pointer);
      const [dx, dy] = straightened(to.x - from.x, to.y - from.y, pointer.shift);
      const edits: PropertyEdit[] = [];
      for (const [bound, value] of [
        [binds.x, key.x + dx],
        [binds.y, key.y + dy],
      ] as const) {
        if (!isKeyed(bound)) continue;
        const target = { owner: { clip }, path: bound.path };
        edits.push({ ...target, op: "setKey", time: key.time, value: tidy(value, bound.spec) });
      }
      return edits;
    },
  };
}
