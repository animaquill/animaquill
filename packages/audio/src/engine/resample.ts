/**
 * Sound of any sample rate at the rate of the mix, by band-limited interpolation: a sinc with a
 * Kaiser window (β = 8.6), through 16 of its zero crossings on each side, looked up in a table of
 * 4096 steps between two input samples, linear between them. The cutoff is 0.9 of the lower of the
 * two Nyquist frequencies, so that sound from a faster rate does not fold back.
 *
 * Every output sample is worked out from the input around it alone, by its own position: where a
 * piece of the mix starts does not change it. Sound at the rate of the mix, at a whole sample, goes
 * through as it is.
 */

/** The rate of the mix, of preview and export alike. */
export const MIX_RATE = 48_000;

const BETA = 8.6;
const ZERO_CROSSINGS = 16;
export const PHASES = 4096;
const CUTOFF = 0.9;
/** Closer than this to a whole sample is one: positions come from seconds, which are not exact. */
export const WHOLE = 1e-6;

export interface Kernel {
  /** Input samples on each side of a position, `width` before up to it and `width` after. */
  readonly width: number;
  /**
   * The kernel at distances `(phase + tap * PHASES) / PHASES` input samples, by phase from 0 to
   * `PHASES` and then by tap from 0 to `width`, as pairs: the value there, and how much it changes
   * up to the next phase. One output sample reads two rows of it, which lie together in memory.
   */
  readonly table: Float64Array;
}

/** The zeroth modified Bessel function of the first kind, as its series. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 100; k += 1) {
    term *= quarter / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

const kernels = new Map<number, Kernel>();

/** The kernel that brings sound of this rate to the rate of the mix. */
export function kernelFor(rate: number): Kernel {
  const known = kernels.get(rate);
  if (known) return known;
  // Relative to the input's Nyquist frequency.
  const scale = CUTOFF * Math.min(1, MIX_RATE / rate);
  const width = Math.ceil(ZERO_CROSSINGS / Math.min(1, MIX_RATE / rate));
  const values = new Float64Array(width * PHASES + 2);
  const norm = bessel0(BETA);
  for (let index = 0; index < values.length; index += 1) {
    const distance = index / PHASES;
    const x = distance / width;
    if (x >= 1) continue;
    const window = bessel0(BETA * Math.sqrt(1 - x * x)) / norm;
    const angle = Math.PI * scale * distance;
    const sinc = distance === 0 ? 1 : Math.sin(angle) / angle;
    values[index] = scale * sinc * window;
  }
  const columns = width + 1;
  const table = new Float64Array(2 * (PHASES + 1) * columns);
  for (let phase = 0; phase <= PHASES; phase += 1) {
    for (let tap = 0; tap < columns; tap += 1) {
      const index = phase + tap * PHASES;
      const value = values[index] ?? 0;
      const at = 2 * (phase * columns + tap);
      table[at] = value;
      table[at + 1] = (values[index + 1] ?? 0) - value;
    }
  }
  const kernel = { width, table };
  kernels.set(rate, kernel);
  return kernel;
}

/**
 * Output samples `offset` up to `offset + count` into `left` (and `right`, unless it is mono), the
 * output sample `index` from input position `anchor + index * step`. `inputLeft[0]` (and
 * `inputRight[0]`) is input sample `first`: they have to hold every sample from
 * `floor(position) - width + 1` up to `floor(position) + width` of every position.
 */
export function resample(
  kernel: Kernel,
  inputLeft: Float64Array,
  inputRight: Float64Array | undefined,
  first: number,
  anchor: number,
  step: number,
  offset: number,
  count: number,
  left: Float64Array,
  right: Float64Array,
): void {
  const { width, table } = kernel;
  const row = 2 * (width + 1);
  for (let index = offset; index < offset + count; index += 1) {
    const at = anchor + index * step;
    const whole = Math.floor(at);
    const fraction = at - whole;
    const base = whole - first;
    // The samples at and before the position, then those after it.
    const before = fraction * PHASES;
    const beforeIndex = Math.floor(before);
    const beforeShare = before - beforeIndex;
    const after = (1 - fraction) * PHASES;
    const afterIndex = Math.floor(after);
    const afterShare = after - afterIndex;
    let sumLeft = 0;
    let sumRight = 0;
    let at1 = beforeIndex * row;
    let at2 = afterIndex * row;
    if (inputRight) {
      for (let tap = 0; tap < width; tap += 1) {
        const weight = (table[at1] as number) + beforeShare * (table[at1 + 1] as number);
        sumLeft += (inputLeft[base - tap] as number) * weight;
        sumRight += (inputRight[base - tap] as number) * weight;
        at1 += 2;
      }
      for (let tap = 1; tap <= width; tap += 1) {
        const weight = (table[at2] as number) + afterShare * (table[at2 + 1] as number);
        sumLeft += (inputLeft[base + tap] as number) * weight;
        sumRight += (inputRight[base + tap] as number) * weight;
        at2 += 2;
      }
      right[index] = sumRight;
    } else {
      for (let tap = 0; tap < width; tap += 1) {
        const weight = (table[at1] as number) + beforeShare * (table[at1 + 1] as number);
        sumLeft += (inputLeft[base - tap] as number) * weight;
        at1 += 2;
      }
      for (let tap = 1; tap <= width; tap += 1) {
        const weight = (table[at2] as number) + afterShare * (table[at2 + 1] as number);
        sumLeft += (inputLeft[base + tap] as number) * weight;
        at2 += 2;
      }
    }
    left[index] = sumLeft;
  }
}

/** One output sample at position `at` of mono `input`, where `input[0]` is input sample `first`. */
export function interpolate(
  kernel: Kernel,
  input: Float64Array,
  first: number,
  at: number,
): number {
  const out = new Float64Array(1);
  resample(kernel, input, undefined, first, at, 0, 0, 1, out, out);
  return out[0] as number;
}
