import type { Point, Rect } from "@animaquill/core";

/**
 * What of lines and circles is on the picture. A scene can put them anywhere and make them any size
 * within its reach, which is far more than the picture: drawn as they are, a dashed circle of a
 * million pixels takes the editor seconds. So only what shows gets drawn, and that is never more
 * than the picture, whatever it was cut from.
 */

/** How long a piece of an arc is drawn at most, in pixels. Short enough to look round. */
const ARC_STEP = 4;
/** How many pieces an arc gets at most. */
const MAX_ARC_STEPS = 1024;

/**
 * The part of a line from one point to another within an area, as the shares of the way along the
 * line where it comes in and goes out: Liang and Barsky. Nothing when it stays outside.
 */
function within(from: Point, to: Point, area: Rect): readonly [number, number] | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let enter = 0;
  let leave = 1;
  const sides: readonly (readonly [number, number])[] = [
    [-dx, from.x - area.x],
    [dx, area.x + area.width - from.x],
    [-dy, from.y - area.y],
    [dy, area.y + area.height - from.y],
  ];
  for (const [toward, room] of sides) {
    if (toward === 0) {
      if (room < 0) return undefined;
      continue;
    }
    const share = room / toward;
    if (toward < 0) enter = Math.max(enter, share);
    else leave = Math.min(leave, share);
    if (enter > leave) return undefined;
  }
  return [enter, leave];
}

const along = (from: Point, to: Point, share: number): Point =>
  share === 0
    ? from
    : share === 1
      ? to
      : { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };

/**
 * The parts of a line through points that are within an area, each as a line of its own. A shape
 * that is `closed` goes back to its first point.
 */
export function visibleLines(points: readonly Point[], area: Rect, closed: boolean): Point[][] {
  const all = closed && points.length > 2 ? [...points, points[0] as Point] : points;
  const lines: Point[][] = [];
  let line: Point[] | undefined;
  for (let index = 1; index < all.length; index += 1) {
    const from = all[index - 1] as Point;
    const to = all[index] as Point;
    const part = within(from, to, area);
    if (!part) {
      line = undefined;
      continue;
    }
    const [enter, leave] = part;
    const start = along(from, to, enter);
    const end = along(from, to, leave);
    if (!line || enter > 0) {
      line = [start];
      lines.push(line);
    }
    line.push(end);
    if (leave < 1) line = undefined;
  }
  return lines;
}

const isIn = ({ x, y }: Point, area: Rect) =>
  x >= area.x && y >= area.y && x <= area.x + area.width && y <= area.y + area.height;

/** Where a circle crosses the sides of an area, as angles. */
function crossings(center: Point, radius: number, area: Rect): number[] {
  const angles: number[] = [];
  const across = (
    offset: number,
    alongCenter: number,
    low: number,
    high: number,
    vertical: boolean,
  ) => {
    if (Math.abs(offset) > radius) return;
    const half = Math.sqrt(radius * radius - offset * offset);
    for (const side of [-half, half]) {
      const at = alongCenter + side;
      if (at < low || at > high) continue;
      angles.push(vertical ? Math.atan2(side, offset) : Math.atan2(offset, side));
    }
  };
  // The left and right sides, then the top and the bottom.
  for (const x of [area.x, area.x + area.width]) {
    across(x - center.x, center.y, area.y, area.y + area.height, true);
  }
  for (const y of [area.y, area.y + area.height]) {
    across(y - center.y, center.x, area.x, area.x + area.width, false);
  }
  return angles;
}

/**
 * What of a circle is within an area: all of it, or the arcs that are, each as a line through a few
 * points, which is nothing for a circle that goes around the area or stays away from it.
 */
export function visibleCircle(center: Point, radius: number, area: Rect): "whole" | Point[][] {
  if (!(radius > 0) || !Number.isFinite(radius)) return [];
  const left = center.x - radius;
  const top = center.y - radius;
  const right = center.x + radius;
  const bottom = center.y + radius;
  if (
    right < area.x ||
    bottom < area.y ||
    left > area.x + area.width ||
    top > area.y + area.height
  ) {
    return [];
  }
  if (
    left >= area.x &&
    top >= area.y &&
    right <= area.x + area.width &&
    bottom <= area.y + area.height
  ) {
    return "whole";
  }
  const angles = crossings(center, radius, area).toSorted((a, b) => a - b);
  if (angles.length === 0) return [];
  const arcs: Point[][] = [];
  const at = (angle: number): Point => ({
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  });
  for (const [index, from] of angles.entries()) {
    const next = angles[index + 1];
    const to = next ?? (angles[0] as number) + Math.PI * 2;
    if (!(to - from > 1e-12) || !isIn(at((from + to) / 2), area)) continue;
    const steps = Math.min(
      Math.max(Math.ceil(((to - from) * radius) / ARC_STEP), 1),
      MAX_ARC_STEPS,
    );
    const arc: Point[] = [];
    for (let step = 0; step <= steps; step += 1) arc.push(at(from + ((to - from) * step) / steps));
    arcs.push(arc);
  }
  return arcs;
}
