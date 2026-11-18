import { staticCurve } from "@animaquill/audio";

/**
 * The picture of a compressor (audio-mixing.md 1.6): what comes out for what goes in, from −60 to
 * 0 dB each way, with its knee at the threshold, rounded as wide as the knee is; and what dragging
 * the knee or the line after it changes. Nothing here touches the DOM or the project.
 */

export const FLOOR_DB = -60;

/** Where a level is, from 0 (−60 dB) to 1 (0 dB), across or up. */
export const shareOfDb = (db: number): number => (db - FLOOR_DB) / -FLOOR_DB;

export const dbOfShare = (share: number): number =>
  Math.min(Math.max(FLOOR_DB + share * -FLOOR_DB, FLOOR_DB), 0);

export interface CompressorShape {
  readonly threshold: number;
  readonly ratio: number;
  readonly knee: number;
}

/** The curve as points across `width` and down `height` (0 dB at the top), for an SVG path. */
export function curvePath(shape: CompressorShape, width: number, height: number, steps = 120) {
  const parts: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const inDb = FLOOR_DB + (step / steps) * -FLOOR_DB;
    const out = staticCurve(inDb, shape.threshold, shape.ratio, shape.knee);
    const x = shareOfDb(inDb) * width;
    const y = (1 - shareOfDb(Math.max(out, FLOOR_DB))) * height;
    parts.push(`${step === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

/** The knee: where the threshold is on the diagonal. */
export const kneePoint = ({ threshold }: CompressorShape) => ({
  x: shareOfDb(threshold),
  y: 1 - shareOfDb(threshold),
});

/** The threshold that dragging the knee across to `x` (0 to 1) makes, to a tenth of a dB. */
export const thresholdAt = (x: number): number => Math.round(dbOfShare(x) * 10) / 10;

/**
 * The ratio that dragging the line after the knee to a point makes: how far the level goes in for
 * how far it comes out, from the knee. Within 1 to 20, to a tenth.
 */
export function ratioAt(shape: CompressorShape, x: number, y: number): number {
  const across = dbOfShare(x) - shape.threshold;
  const up = dbOfShare(1 - y) - shape.threshold;
  if (across <= 0.5) return shape.ratio;
  const ratio = up <= 0 ? 20 : across / up;
  return Math.round(Math.min(Math.max(ratio, 1), 20) * 10) / 10;
}
