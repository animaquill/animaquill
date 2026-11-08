/**
 * Exact time in seconds. Frame rates such as 30000/1001 have no finite decimal form, and adding up
 * floating point seconds drifts, so every time in a project is a rational number.
 *
 * In files a time is a string with exactly one spelling: a decimal when that is exact within
 * nine places ("12.5"), otherwise a fraction ("1001/30000").
 */
export interface Rational {
  /** Numerator. */
  readonly n: bigint;
  /** Denominator, always positive. The fraction is always reduced. */
  readonly d: bigint;
}

export const TIME_PATTERN = /^-?(?:\d+(?:\.\d+)?|\d+\/0*[1-9]\d*)$/;

const DECIMAL_PLACES = 9;
const DECIMAL_SCALE = 10n ** BigInt(DECIMAL_PLACES);

const abs = (value: bigint) => (value < 0n ? -value : value);

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new RangeError("Denominator is zero");
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d) || 1n;
  return { n: (sign * n) / divisor, d: (sign * d) / divisor };
}

export const ZERO = rational(0n);

/**
 * The same times come up again and again in a project, such as the start of every clip in a column,
 * and reading one takes a while: what the last few thousand were read as is kept.
 */
const MOST_KNOWN_TIMES = 4096;
const knownTimes = new Map<string, Rational>();

/** Reads a time. Throws when the text is not one. */
export function parseTime(text: string): Rational {
  const known = knownTimes.get(text);
  if (known) return known;
  const value = readTime(text);
  if (knownTimes.size >= MOST_KNOWN_TIMES) knownTimes.clear();
  knownTimes.set(text, value);
  return value;
}

function readTime(text: string): Rational {
  if (!TIME_PATTERN.test(text)) throw new RangeError(`Not a time: ${text}`);
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const [numerator = "0", denominator] = digits.split("/");
  let value: Rational;
  if (denominator !== undefined) {
    value = rational(BigInt(numerator), BigInt(denominator));
  } else {
    const [whole = "0", fraction = ""] = numerator.split(".");
    value = rational(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  }
  return negative ? rational(-value.n, value.d) : value;
}

/** Writes a time in its one canonical spelling. */
export function formatTime({ n, d }: Rational): string {
  if (DECIMAL_SCALE % d !== 0n) return `${n}/${d}`;
  const scaled = abs(n) * (DECIMAL_SCALE / d);
  const whole = scaled / DECIMAL_SCALE;
  const fraction = (scaled % DECIMAL_SCALE)
    .toString()
    .padStart(DECIMAL_PLACES, "0")
    .replace(/0+$/, "");
  const sign = n < 0n ? "-" : "";
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

const knownSpellings = new Map<string, string>();

/** The canonical spelling of a time. Text that is no time comes back unchanged. */
export function normalizeTime(text: string): string {
  const known = knownSpellings.get(text);
  if (known !== undefined) return known;
  const spelling = TIME_PATTERN.test(text) ? formatTime(parseTime(text)) : text;
  if (knownSpellings.size >= MOST_KNOWN_TIMES) knownSpellings.clear();
  knownSpellings.set(text, spelling);
  return spelling;
}

export const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a: Rational, b: Rational) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
export const divide = (a: Rational, b: Rational) => rational(a.n * b.d, a.d * b.n);

/** Negative when a comes first, zero when equal, positive when b comes first. */
export function compare(a: Rational, b: Rational): number {
  const difference = a.n * b.d - b.n * a.d;
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

/** Seconds as a float, for drawing and rendering. Not for arithmetic that gets saved. */
export const toSeconds = ({ n, d }: Rational): number => Number(n) / Number(d);

/** The exact value of the shortest decimal that stands for these seconds. */
export function fromSeconds(seconds: number): Rational {
  if (!Number.isFinite(seconds)) throw new RangeError(`Not a time: ${seconds}`);
  const text = seconds.toFixed(DECIMAL_PLACES);
  return parseTime(text);
}
