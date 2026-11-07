import {
  anchorStops,
  clockOf,
  entryOf,
  motionPath,
  multiply,
  transformPoint,
  type GrabHandle,
  type HandlePoint,
  type Point,
} from "@animaquill/core";
import {
  SIDES,
  resizeCursor,
  type EditorExtension,
  type ExtensionHandle,
  type ExtensionTarget,
  type Mark,
  type Side,
} from "./extension.ts";
import { anchorGesture, pathKeyGesture } from "./gestures.ts";

/**
 * The handles of a clip with a picture, as in After Effects and Figma: a box around what it shows,
 * a handle at each corner and side that scales, one above it that turns, and the anchor that both
 * go around, which can be moved itself. Keys on the position make a path, with a handle for each.
 * Scaling changes `transform.scale` and never the size of the box, which keeps a clip following
 * its stage: see the design of the animation model. So a clip always keeps its shape.
 */

/** Where on the part of a box with a picture each side is, as shares of it. */
const SIDE_AT: Readonly<Record<Side, readonly [number, number]>> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

/** How far above its box the rotate handle sits, in pixels. */
export const ROTATE_REACH = 24;

const pointOf = ({ x, y }: Point): HandlePoint => [x, y];

/** The handles that change the transform, which only work on the picture as it is. */
function transformHandles(target: ExtensionTarget, marks: Mark[]): ExtensionHandle[] {
  const { placement, toScreen, fits } = target;
  const { picture, matrix, transform } = placement;
  const boxToScreen = multiply(toScreen, matrix);
  const [a, b, c, d] = boxToScreen;
  const angle = Math.atan2(b, a);
  const anchor = { x: transform.x, y: transform.y };
  const anchorOnScreen = transformPoint(toScreen, anchor);
  const handles: ExtensionHandle[] = SIDES.map((side) => {
    const [shareX, shareY] = SIDE_AT[side];
    const inBox = { x: picture.x + picture.width * shareX, y: picture.y + picture.height * shareY };
    const world = transformPoint(matrix, inBox);
    const at = transformPoint(toScreen, world);
    return {
      id: `scale ${side}`,
      role: "scale",
      detail: side,
      look: side.length === 2 ? "corner" : "side",
      at,
      angle,
      cursor: resizeCursor(at.x - anchorOnScreen.x, at.y - anchorOnScreen.y),
      handle: {
        kind: "scale",
        id: side,
        at: pointOf(world),
        center: pointOf(anchor),
        bind: "transform.scale",
      },
    };
  });
  // Above the top of the picture, whichever way the box is turned on the screen. A picture that
  // fills the preview has no room above it, and there it goes inside, where people can get to it.
  const length = Math.hypot(c, d);
  if (length > 0) {
    const top = transformPoint(boxToScreen, { x: picture.x + picture.width / 2, y: picture.y });
    const away = (by: number) => ({ x: top.x - (c / length) * by, y: top.y - (d / length) * by });
    const outside = away(ROTATE_REACH);
    const inside = away(-ROTATE_REACH);
    const knob = fits(outside) || !fits(inside) ? outside : inside;
    marks.push({ kind: "stem", from: top, to: knob });
    handles.push({
      id: "rotate",
      role: "rotate",
      detail: "rotate",
      look: "rotate",
      at: knob,
      angle,
      cursor: "grab",
      handle: {
        kind: "rotate",
        id: "rotate",
        at: pointOf(anchor),
        radius: 1,
        bind: "transform.rotation",
      },
    });
  }
  handles.push({
    id: "anchor",
    role: "anchor",
    detail: "anchor",
    look: "anchor",
    at: anchorOnScreen,
    angle,
    cursor: "crosshair",
    solve: (bind) => {
      const x = bind("transform.x", transform.x);
      const y = bind("transform.y", transform.y);
      const anchorX = bind("transform.anchorX", transform.anchorX);
      const anchorY = bind("transform.anchorY", transform.anchorY);
      if (!x || !y || !anchorX || !anchorY) return undefined;
      return anchorGesture(
        target.clip,
        placement,
        toScreen,
        target.toWorld,
        anchorStops(placement),
        {
          x,
          y,
          anchorX,
          anchorY,
        },
      );
    },
  });
  return handles;
}

/** The path that keys on the position make, with a handle for each key. */
function pathHandles(target: ExtensionTarget, marks: Mark[]): ExtensionHandle[] {
  const { layer, placement, properties, toScreen, toWorld, fps, clip } = target;
  const path = motionPath(
    entryOf(properties, "transform.x"),
    entryOf(properties, "transform.y"),
    { from: clockOf(layer, layer.start), to: clockOf(layer, layer.end) },
    fps,
    { x: placement.transform.x, y: placement.transform.y },
  );
  if (!path) return [];
  const onScreen = (point: Point) => transformPoint(toScreen, point);
  marks.push({
    kind: "path",
    points: path.points.map(onScreen),
    frames: path.frames.map(onScreen),
  });
  return path.keys.map((key) => ({
    id: `key ${key.time}`,
    role: "key",
    detail: key.time,
    look: "key",
    at: onScreen(key),
    angle: 0,
    cursor: "move",
    solve: (bind, pointer) => {
      const x = bind("transform.x", key.x);
      const y = bind("transform.y", key.y);
      return x && y ? pathKeyGesture(clip, key, toWorld, { x, y }, pointer) : undefined;
    },
  }));
}

export const clipVisual: EditorExtension = {
  objectType: "clip.visual",
  handles(target) {
    const marks: Mark[] = [];
    // The path goes under the handles of the box, which are what people grab most.
    const handles = [...pathHandles(target, marks), ...transformHandles(target, marks)];
    return { marks, handles };
  },
  body({ placement: { transform } }): GrabHandle {
    return {
      kind: "move",
      id: "move",
      at: [transform.x, transform.y],
      bind: { x: "transform.x", y: "transform.y" },
    };
  },
};
