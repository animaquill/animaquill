import type { PropertySpec } from "@animaquill/schema";

/** How many digits people get to see. What is saved keeps what they typed. */
const SHOWN_DIGITS = 2;
/** Enough for anything a person means, and it keeps float noise out of project files. */
const KEPT_DIGITS = 6;
/** What one pixel of dragging is worth, by unit. */
const STEPS: Readonly<Record<string, number>> = { world: 1, deg: 1, ratio: 0.01 };
const DEFAULT_STEP = 0.01;

export interface ScrubKeys {
  readonly shift: boolean;
  readonly alt: boolean;
}

const fixed = (value: number, digits: number) => Number(value.toFixed(digits));

const limited = (value: number, low: number | undefined, high: number | undefined) =>
  Math.min(Math.max(value, low ?? -Infinity), high ?? Infinity);

/** A share reads better as a percentage, and it is what people expect of opacity. */
const isShare = ({ unit }: PropertySpec) => unit === "ratio";

export function formatNumber(value: number, spec: PropertySpec): string {
  if (isShare(spec)) return `${fixed(value * 100, SHOWN_DIGITS)}%`;
  if (spec.unit === "deg") return `${fixed(value, SHOWN_DIGITS)}°`;
  if (spec.unit === "s") return `${fixed(value, SHOWN_DIGITS)}s`;
  return String(fixed(value, SHOWN_DIGITS));
}

/** The value after dragging a number by some pixels. Shift goes faster and Alt goes finer. */
export function scrubbed(
  spec: PropertySpec,
  start: number,
  pixels: number,
  { shift, alt }: ScrubKeys,
): number {
  const speed = (shift ? 10 : 1) * (alt ? 0.1 : 1);
  const step = (STEPS[spec.unit ?? ""] ?? DEFAULT_STEP) * speed;
  // The suggested range is for the hand. A value typed outside of it does not jump back.
  const low = Math.max(spec.min ?? -Infinity, Math.min(spec.softMin ?? -Infinity, start));
  const high = Math.min(spec.max ?? Infinity, Math.max(spec.softMax ?? Infinity, start));
  return limited(fixed(start + pixels * step, KEPT_DIGITS), low, high);
}

/** What people typed, or undefined when it is not a number. Too much becomes the limit. */
export function parseNumber(text: string, spec: PropertySpec): number | undefined {
  const plain = text
    .normalize("NFKC")
    .replaceAll("−", "-")
    .replace(spec.unit === "s" ? /(?:s|秒)\s*$/u : /[%°]\s*$/u, "")
    .trim();
  const number = plain === "" ? Number.NaN : Number(plain);
  if (!Number.isFinite(number)) return undefined;
  const value = isShare(spec) ? number / 100 : number;
  return limited(fixed(value, KEPT_DIGITS), spec.min, spec.max);
}
