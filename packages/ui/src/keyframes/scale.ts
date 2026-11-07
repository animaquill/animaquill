import { SHAPE, type Channel, type CurveChannel } from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";

/**
 * A row of a number is the curve of that number: higher values sit higher up. This is where values
 * go in a row, which covers what the keys and the curve between them reach, whatever is on screen.
 */

/** The numbers a row covers. */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** Where the values of a row are, in pixels from the top of its lane. */
export interface ValueScale {
  readonly height: number;
  /** Room above the highest value and under the lowest, so that their keys show whole. */
  readonly padding: number;
  /** The values at the bottom and at the top of the room for values. */
  readonly low: number;
  readonly high: number;
}

/** A key is this far from the edge at least, so that one at the top shows whole. */
const MIN_PADDING = 7;
const MAX_PADDING = 16;
const PADDING_SHARE = 0.1;

/** What a row of one value shows around it, by unit: about what a drag goes through. */
const FLAT_SPANS: Readonly<Record<string, number>> = {
  world: 1080,
  deg: 360,
  ratio: 1,
  db: 24,
  semitone: 24,
};

/** How much a row of one value shows: the range of the property, or what fits its unit. */
function flatSpanOf(spec: PropertySpec, value: number): number {
  const { min, max, softMin, softMax, unit } = spec;
  if (min !== undefined && max !== undefined && max > min) return max - min;
  if (softMin !== undefined && softMax !== undefined && softMax > softMin) return softMax - softMin;
  return FLAT_SPANS[unit ?? ""] ?? Math.max(Math.abs(value) * 2, 2);
}

/** Where values go in a lane of a height. One value sits in the middle. */
export function scaleOf(range: ValueRange, spec: PropertySpec, height: number): ValueScale {
  const padding = Math.min(Math.max(height * PADDING_SHARE, MIN_PADDING), MAX_PADDING);
  if (range.max > range.min) return { height, padding, low: range.min, high: range.max };
  const half = flatSpanOf(spec, range.min) / 2;
  return { height, padding, low: range.min - half, high: range.min + half };
}

const roomOf = ({ height, padding }: ValueScale) => Math.max(height - padding * 2, 1);

/** How far down from the top of its lane a value is. */
export function yIn(scale: ValueScale, value: number): number {
  const { padding, low, high } = scale;
  return padding + roomOf(scale) * (1 - (value - low) / (high - low));
}

/** The value at a height from the top of the lane, also beyond what the lane shows. */
export function valueIn(scale: ValueScale, y: number): number {
  const { padding, low, high } = scale;
  return low + (1 - (y - padding) / roomOf(scale)) * (high - low);
}

/** What one pixel up is worth. */
export const perPixel = (scale: ValueScale): number => (scale.high - scale.low) / roomOf(scale);

export const unionOf = (a: ValueRange, b: ValueRange | undefined): ValueRange =>
  b ? { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } : a;

/** What a value of a bezier goes through, at the places where it turns. */
function bezierTurns(
  from: number,
  to: number,
  y1: number,
  y2: number,
  visit: (value: number) => void,
): void {
  const change = to - from;
  const p1 = from + y1 * change;
  const p2 = from + y2 * change;
  // The derivative of a cubic in Bernstein form, as a quadratic in the parameter.
  const a = p1 - from;
  const b = p2 - p1;
  const c = to - p2;
  const square = a - 2 * b + c;
  const linear = 2 * (b - a);
  const valueAt = (s: number) => {
    const r = 1 - s;
    return r * r * r * from + 3 * r * r * s * p1 + 3 * r * s * s * p2 + s * s * s * to;
  };
  const roots: number[] = [];
  if (Math.abs(square) < 1e-12) {
    if (Math.abs(linear) > 1e-12) roots.push(-a / linear);
  } else {
    const discriminant = linear * linear - 4 * square * a;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-linear + root) / (2 * square), (-linear - root) / (2 * square));
    }
  }
  for (const s of roots) if (s > 0 && s < 1) visit(valueAt(s));
}

const ranges = new WeakMap<CurveChannel, ValueRange | undefined>();

/**
 * What a property covers: all of its keys, and where a bezier between them goes further. Undefined
 * when it is not a number.
 */
export function rangeOfChannel(channel: Channel): ValueRange | undefined {
  if (channel.kind === "still") {
    const { value } = channel;
    return typeof value === "number" ? { min: value, max: value } : undefined;
  }
  if (ranges.has(channel)) return ranges.get(channel);
  const { values, shapes, handles } = channel;
  let range: ValueRange | undefined;
  if (values instanceof Float64Array) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const visit = (value: number) => {
      if (value < min) min = value;
      if (value > max) max = value;
    };
    values.forEach(visit);
    shapes.forEach((shape, index) => {
      if (shape !== SHAPE.bezier) return;
      const y1 = handles[index * 4 + 1] as number;
      const y2 = handles[index * 4 + 3] as number;
      bezierTurns(values[index] as number, values[index + 1] as number, y1, y2, visit);
    });
    range = Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
  }
  ranges.set(channel, range);
  return range;
}
