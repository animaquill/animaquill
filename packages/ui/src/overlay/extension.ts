import type { GrabHandle, Matrix, Placement, Point, RenderLayer } from "@animaquill/core";
import type { PropertyValue } from "@animaquill/schema";
import type { FrameMoment } from "./compensate.ts";
import type { Bound, Gesture, OverlayPointer } from "./gestures.ts";

/**
 * How the editing of a built-in kind of object comes in: what of it people can grab on the picture,
 * and what that does. An extension runs on the editor page and can be trusted. Besides the kinds of
 * handles that code objects declare, which it uses the same way, it can work out what a drag does
 * itself, like a `custom` handle that needs no sandbox. `clip.visual` is the first one, and the
 * bones and 3D nodes of later versions come in the same way.
 */

/** How the scale handles of a box are called, clockwise from the top left. */
export const SIDES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type Side = (typeof SIDES)[number];

export type GripLook = "corner" | "side" | "rotate" | "anchor" | "key" | "point" | "knob" | "scale";

export type GripRole =
  /** Scales a clip. `detail` is its side. */
  | "scale"
  | "rotate"
  | "anchor"
  /** A key on the path of a clip. `detail` is its time on the clock of the clip. */
  | "key"
  /** A handle of a code object. `detail` is its id. */
  | "object";

/** What the overlay shows apart from handles. Places are on the overlay. */
export type Mark =
  /** The part of a box with a picture: the selected clip, another selected one, or one that is locked. */
  | {
      readonly kind: "outline";
      readonly clip: string;
      readonly corners: readonly Point[];
      readonly style: "target" | "selected" | "locked";
    }
  /** What holds the rotate handle above its box. */
  | { readonly kind: "stem"; readonly from: Point; readonly to: Point }
  | {
      readonly kind: "path";
      readonly points: readonly Point[];
      readonly frames: readonly Point[];
    }
  /** Where a code object is, and what its handles draw. */
  | { readonly kind: "bounds"; readonly corners: readonly Point[] }
  | { readonly kind: "line"; readonly points: readonly Point[]; readonly closed: boolean }
  | { readonly kind: "ring"; readonly at: Point; readonly radius: number };

/** What an extension gets to know about the clip it says the handles of. */
export interface ExtensionTarget {
  readonly clip: string;
  readonly layer: RenderLayer;
  readonly placement: Placement;
  /** From the world to the overlay, and back. */
  readonly toScreen: Matrix;
  readonly toWorld: Matrix;
  /** What the clip shows: its properties with what is being tried or dragged on top. */
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** The clock of the clip at the playhead. */
  readonly clock: number;
  /** Frames per second of the project, for what goes frame by frame. */
  readonly fps: number;
  /** The frames of the clip from one reading of its clock to another, as far as it shows. */
  readonly frames: (from: number, to: number) => readonly FrameMoment[];
  /** Whether a place on the overlay can be seen and grabbed. */
  readonly fits: (point: Point) => boolean;
}

/**
 * How a drag gets to write a property of the clip, from a value it starts at: see `Bound`. Nothing
 * when the clip cannot change now, and then nothing gets dragged.
 */
export type Binder = (path: string, start: number) => Bound | undefined;

/** A handle that an extension shows. */
export interface ExtensionHandle {
  /** Within its clip. */
  readonly id: string;
  readonly role: GripRole;
  readonly detail: string;
  readonly look: GripLook;
  /** Where it shows and gets grabbed, on the overlay. */
  readonly at: Point;
  /** Which way it is turned, in radians, for drawing it. */
  readonly angle: number;
  readonly cursor: string;
  /** A kind that says what a drag does, in the coordinates of the world. It binds paths of the clip. */
  readonly handle?: GrabHandle;
  /** What a drag does otherwise. */
  readonly solve?: (bind: Binder, pointer: OverlayPointer) => Gesture | undefined;
}

export interface ExtensionScene {
  readonly marks: readonly Mark[];
  readonly handles: readonly ExtensionHandle[];
}

export interface EditorExtension {
  /** The `type` of the objects it is for, as in `clip.visual`. */
  readonly objectType: string;
  handles(target: ExtensionTarget): ExtensionScene;
  /** What dragging the object itself does, where there is no handle. */
  body?(target: ExtensionTarget): GrabHandle | undefined;
}

/** The cursor that says which way a scale handle goes, by that direction on the screen. */
export function resizeCursor(dx: number, dy: number): string {
  const degrees = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 180) + 180) % 180;
  if (degrees < 22.5 || degrees >= 157.5) return "ew-resize";
  if (degrees < 67.5) return "nwse-resize";
  if (degrees < 112.5) return "ns-resize";
  return "nesw-resize";
}
