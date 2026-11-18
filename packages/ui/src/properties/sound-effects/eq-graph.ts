import { cookbook, responseDb, type BandKind } from "@animaquill/audio";

/**
 * The picture of an equalizer (audio-mixing.md 1.6): its frequency response from 20 Hz to 20 kHz on
 * a log scale across, ±24 dB up and down, with a point for each band, and what dragging, the wheel
 * and a double click on them change. Nothing here touches the DOM or the project.
 */

export const LOWEST = 20;
export const HIGHEST = 20_000;
export const RANGE_DB = 24;
const Q_RANGE = [0.1, 18] as const;
/** How much a notch of the wheel changes Q: by this much, more or less. */
const Q_STEP = 1.12;

/** A band of the equalizer, as its point shows it. */
export interface EqBand {
  readonly name: "hp" | "low" | "mid1" | "mid2" | "mid3" | "high" | "lp";
  readonly kind: BandKind;
  /** What its number on the graph is. */
  readonly number: number;
}

export const EQ_BANDS: readonly EqBand[] = [
  { name: "hp", kind: "highpass", number: 1 },
  { name: "low", kind: "lowshelf", number: 2 },
  { name: "mid1", kind: "peak", number: 3 },
  { name: "mid2", kind: "peak", number: 4 },
  { name: "mid3", kind: "peak", number: 5 },
  { name: "high", kind: "highshelf", number: 6 },
  { name: "lp", kind: "lowpass", number: 7 },
];

export const isPass = (band: EqBand): boolean =>
  band.kind === "highpass" || band.kind === "lowpass";

/** What the graph reads of an equalizer: its parameters by name, as `hp.freq`. */
export type EqValues = Readonly<Record<string, unknown>>;

const numberOf = (values: EqValues, name: string, fallback: number): number => {
  const value = values[name];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
};

/** Whether a band changes anything: a pass that is on, or a band with a gain. */
export function bandOn(values: EqValues, band: EqBand): boolean {
  if (isPass(band)) return values[`${band.name}.on`] === true;
  return numberOf(values, `${band.name}.gain`, 0) !== 0;
}

/** Where a frequency is across, from 0 to 1. */
export const xOfFrequency = (frequency: number): number =>
  Math.log(frequency / LOWEST) / Math.log(HIGHEST / LOWEST);

export const frequencyOfX = (x: number): number =>
  Math.min(Math.max(LOWEST * (HIGHEST / LOWEST) ** x, LOWEST), HIGHEST);

/** Where a gain is up and down, from 0 at the top (+24 dB) to 1 at the bottom (−24 dB). */
export const yOfGain = (gain: number): number => 0.5 - gain / (2 * RANGE_DB);

export const gainOfY = (y: number): number =>
  Math.min(Math.max((0.5 - y) * 2 * RANGE_DB, -RANGE_DB), RANGE_DB);

/** The defaults of the bands where an equalizer has no value: those of the format. */
const DEFAULT_FREQUENCY: Readonly<Record<EqBand["name"], number>> = {
  hp: 80,
  low: 100,
  mid1: 250,
  mid2: 1000,
  mid3: 4000,
  high: 8000,
  lp: 18_000,
};

export const frequencyOf = (values: EqValues, band: EqBand): number =>
  numberOf(values, `${band.name}.freq`, DEFAULT_FREQUENCY[band.name]);

export const gainOf = (values: EqValues, band: EqBand): number =>
  isPass(band) ? 0 : numberOf(values, `${band.name}.gain`, 0);

export const qOf = (values: EqValues, band: EqBand): number =>
  numberOf(values, `${band.name}.q`, 1);

/** Where the point of a band is, from 0 to 1 each way: the passes sit on the 0 dB line. */
export function pointOf(values: EqValues, band: EqBand): { x: number; y: number } {
  return { x: xOfFrequency(frequencyOf(values, band)), y: yOfGain(gainOf(values, band)) };
}

/** What the equalizer does to a frequency, in dB: every band that is on, as the engine has it. */
export function responseAt(values: EqValues, frequency: number): number {
  let total = 0;
  for (const band of EQ_BANDS) {
    if (!bandOn(values, band)) continue;
    const q = band.kind === "peak" ? qOf(values, band) : isPass(band) ? Math.SQRT1_2 : 1;
    const filter = cookbook(band.kind, frequencyOf(values, band), gainOf(values, band), q);
    const stages = isPass(band) && numberOf(values, `${band.name}.slope`, 12) >= 24 ? 2 : 1;
    total += stages * responseDb(filter, frequency);
  }
  return total;
}

/** The curve of the response as points across `width` and down `height`, for an SVG path. */
export function responsePath(values: EqValues, width: number, height: number, steps = 160): string {
  const parts: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const x = step / steps;
    const gain = Math.min(
      Math.max(responseAt(values, frequencyOfX(x)), -RANGE_DB * 1.5),
      RANGE_DB * 1.5,
    );
    parts.push(
      `${step === 0 ? "M" : "L"}${(x * width).toFixed(1)} ${(yOfGain(gain) * height).toFixed(1)}`,
    );
  }
  return parts.join(" ");
}

/**
 * What dragging the point of a band to (x, y), from 0 to 1, writes: its frequency, and its gain
 * unless it is a pass. Frequencies go to the whole hertz, gains to a tenth of a dB.
 */
export function dragTo(band: EqBand, x: number, y: number): Record<string, number> {
  const frequency = Math.round(frequencyOfX(x));
  if (isPass(band)) return { [`${band.name}.freq`]: frequency };
  return {
    [`${band.name}.freq`]: frequency,
    [`${band.name}.gain`]: Math.round(gainOfY(y) * 10) / 10,
  };
}

/** The Q of a peak after `notches` of the wheel, up for narrower: within its range, two places. */
export function qAfterWheel(q: number, notches: number): number {
  const next = q * Q_STEP ** notches;
  return Math.round(Math.min(Math.max(next, Q_RANGE[0]), Q_RANGE[1]) * 100) / 100;
}

/** Which bands take the wheel: those with a Q. */
export const hasQ = (band: EqBand): boolean => band.kind === "peak";
