import {
  anchorStops,
  clockOf,
  entryOf,
  motionPath,
  multiply,
  transformPoint,
  type GrabHandle,
  type HandlePoint,
  type PathKey,
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
import { anchorGesture, pathKeyGesture, stretchGesture, type BoxSide } from "./gestures.ts";

/**
 * The handles of a clip with a picture, as in After Effects and Figma: a box around what it shows,
 * a handle at each corner and side that scales, one above it that turns, and the anchor that both
 * go around, which can be moved itself. Keys on the position make a path, with a handle for each.
 * Scaling changes `transform.scale` and never the size of the box, which keeps a clip following
 * its stage: see the design of the animation model. So a clip keeps its shape, except where its
 * picture fills its box out of shape anyway (`fit` "stretch"): there the handles on the sides
 * change the width or the height of the box, and those at the corners still scale.
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
  const stretches = target.layer.fit === "stretch";
  const handles: ExtensionHandle[] = SIDES.map((side) => {
    const [shareX, shareY] = SIDE_AT[side];
    const inBox = { x: picture.x + picture.width * shareX, y: picture.y + picture.height * shareY };
    const world = transformPoint(matrix, inBox);
    const at = transformPoint(toScreen, world);
    if (stretches && side.length === 1) return stretchHandle(target, side as BoxSide, at, angle);
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
    solve: (bind, pointer) => {
      const x = bind("transform.x", transform.x);
      const y = bind("transform.y", transform.y);
      const anchorX = bind("transform.anchorX", transform.anchorX);
      const anchorY = bind("transform.anchorY", transform.anchorY);
      if (!x || !y || !anchorX || !anchorY) return undefined;
      const { clip, clock, frames, toWorld } = target;
      const stops = anchorStops(placement);
      const place = { clip, placement, clock, toScreen, toWorld, stops, frames };
      return anchorGesture(place, { x, y, anchorX, anchorY }, pointer);
    },
  });
  return handles;
}

/**
 * A handle on a side of a box whose picture fills it out of shape: it changes the width or the
 * height, see `stretchGesture`. A box that has neither written gets both as they are, once.
 */
function stretchHandle(
  target: ExtensionTarget,
  side: BoxSide,
  at: Point,
  angle: number,
): ExtensionHandle {
  const { placement, toScreen, toWorld, properties } = target;
  const { box, transform } = placement;
  const across = side === "e" || side === "w";
  // The way the side goes on the screen, which is the way the cursor points.
  const [a, b, c, d] = multiply(toScreen, placement.matrix);
  return {
    id: `stretch ${side}`,
    role: "stretch",
    detail: side,
    look: "side",
    at,
    angle,
    cursor: across ? resizeCursor(a, b) : resizeCursor(c, d),
    solve: (bind, pointer) => {
      const written = (path: string) => entryOf(properties, path) !== undefined;
      const width = bind("transform.width", box.width);
      const height = bind("transform.height", box.height);
      const x = bind("transform.x", transform.x);
      const y = bind("transform.y", transform.y);
      if (!width || !height || !x || !y) return undefined;
      const [size, other] = across ? [width, height] : [height, width];
      const neither = !written("transform.width") && !written("transform.height");
      const binds = { size, x, y, ...(neither && { other }) };
      return stretchGesture(side, placement, toWorld, binds, pointer);
    },
  };
}

/** Keys that get a handle at most: more would be in each other's way, and take the page with them. */
export const MAX_KEY_HANDLES = 200;
/** How many keys around the playhead get looked at for those, at most. */
const KEYS_LOOKED_AT = 4000;

/** The keys nearest to the playhead that show on the overlay, nearest first. */
function nearKeys(keys: readonly PathKey[], clock: number, shows: (key: PathKey) => boolean) {
  let after = keys.findIndex((key) => key.clock >= clock);
  if (after < 0) after = keys.length;
  let before = after - 1;
  const near: PathKey[] = [];
  for (let looked = 0; looked < KEYS_LOOKED_AT && near.length < MAX_KEY_HANDLES; looked += 1) {
    const earlier = keys[before];
    const later = keys[after];
    if (!earlier && !later) break;
    const takeEarlier = earlier && (!later || clock - earlier.clock <= later.clock - clock);
    const key = (takeEarlier ? earlier : later) as PathKey;
    if (takeEarlier) before -= 1;
    else after += 1;
    if (shows(key)) near.push(key);
  }
  return near;
}

/**
 * The path that keys on the position make, with a handle for each key near the playhead that shows
 * on the overlay. A clip can have tens of thousands of keys, and a handle for each would be no use.
 */
function pathHandles(target: ExtensionTarget, marks: Mark[]): ExtensionHandle[] {
  const { layer, placement, properties, toScreen, toWorld, fps, clip, fits } = target;
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
  const placed = new Map<PathKey, Point>();
  const shows = (key: PathKey) => {
    const at = onScreen(path.at(key.clock));
    placed.set(key, at);
    return fits(at);
  };
  return nearKeys(path.keys, target.clock, shows)
    .toSorted((a, b) => a.clock - b.clock)
    .map((key) => {
      const world = path.at(key.clock);
      const at = placed.get(key) as Point;
      return {
        id: `key ${key.time}`,
        role: "key",
        detail: key.time,
        look: "key",
        at,
        angle: 0,
        cursor: "move",
        solve: (bind, pointer) => {
          const x = bind("transform.x", world.x);
          const y = bind("transform.y", world.y);
          const spot = { ...key, ...world };
          return x && y ? pathKeyGesture(clip, spot, toWorld, { x, y }, pointer) : undefined;
        },
      };
    });
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
