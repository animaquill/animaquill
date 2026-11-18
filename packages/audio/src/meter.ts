/**
 * What AI hears of a mix (`aq_audio_analyze`, mcp.md 8 of AnimaQuill Cloud): its loudness as
 * ITU-R BS.1770-4 and EBU R128 measure it (integrated, the loudest short-term, the true peak), where
 * it is silent, where it clips, and the envelope of one sound. It takes the samples piece by piece,
 * as the mix comes, so that an hour never has to be in memory at once; nothing here knows a browser,
 * and a worker runs it.
 */

/** Below this for `SILENCE_SECONDS` or longer is silence: −50 dBFS. */
export const SILENCE_DBFS = -50;
export const SILENCE_SECONDS = 0.3;
/**
 * A sample at or above this is at full scale: −0.009 dBFS, so that a file clipped before it came
 * here, whose samples decode to just under 1, counts too.
 */
export const FULL_SCALE = 0.999;
/** This many samples in a row at full scale are a clip; any one over 1 is (an export cuts it). */
const CLIP_RUN = 3;
/** Clips closer together than this are one place. */
const CLIP_GAP_SECONDS = 0.05;
/** How long one step of the level for silence and the envelope is. */
const STEP_SECONDS = 0.001;
/** Loudness: blocks of 400 ms every 100 ms (momentary), and 3 s every 100 ms (short-term). */
const SUB_SECONDS = 0.1;
const MOMENTARY_SUBS = 4;
const SHORT_TERM_SUBS = 30;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
/** At most this many places of clipping and stretches of silence are kept with their times. */
export const MOST_PLACES = 50;

/** One part of a mix with its times, as the meter says where something is. */
export interface Stretch {
  /** Seconds from the start of what was measured. */
  readonly from: number;
  readonly to: number;
}

export interface ClipPlace extends Stretch {
  /** Samples at full scale there, of all channels. */
  readonly samples: number;
}

/** The envelope of a sound: how fast it comes up and how long it takes to fade. */
export interface Envelope {
  /** Its loudest moment, in dBFS and seconds from the start. */
  readonly peak: number;
  readonly peakAt: number;
  /** When it first gets to 10 % of its peak, in seconds from the start. */
  readonly onset: number;
  /** From 10 % to 90 % of its peak, in seconds. */
  readonly attack: number;
  /** From its peak until it is 40 dB below it for good, in seconds. */
  readonly decay: number;
  /** Whether it is still above that when what was measured ends. */
  readonly cut: boolean;
}

/** What the meter found, see `SoundMeter.result`. */
export interface Measured {
  /** Seconds measured. */
  readonly seconds: number;
  /** LUFS; undefined where nothing is above the gates, or it is shorter than 400 ms. */
  readonly integrated: number | undefined;
  /** The loudest 3 s, in LUFS; undefined where it is shorter than 3 s, or silent. */
  readonly shortTermMax: number | undefined;
  /** The loudest 400 ms, in LUFS. */
  readonly momentaryMax: number | undefined;
  /** dBTP, as BS.1770-4 Annex 2 estimates it (4× oversampled); −Infinity for silence. */
  readonly truePeak: number;
  /** dBFS of the largest sample; −Infinity for silence. */
  readonly samplePeak: number;
  readonly clipping: { readonly places: number; readonly samples: number };
  readonly clips: readonly ClipPlace[];
  readonly silences: readonly Stretch[];
  /** All of it is below −50 dBFS. */
  readonly silent: boolean;
  readonly envelope: Envelope | undefined;
  /** The level over time for a small picture: the largest sample of each of `buckets` parts, 0–1. */
  readonly wave: readonly number[];
}

/** A biquad filter, one per channel, as BS.1770 has two in a row. */
interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * The K-weighting of BS.1770-4 at any sample rate: a high shelf (the head) and a high pass (RLB),
 * worked out from their analogue prototypes as libebur128 and pyloudnorm do. At 48 kHz these are
 * the coefficients of the recommendation's table 1 and 2.
 */
export function kWeighting(rate: number): readonly [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + k / q + k * k;
  const pass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  return [shelf, pass];
}

/**
 * The interpolation filter of BS.1770-4 Annex 2 for true peaks: 48 taps in four phases of 12, for
 * four times the sample rate.
 */
export const TRUE_PEAK_PHASES: readonly (readonly number[])[] = [
  [
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875,
    0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125,
    0.014892578125, -0.00830078125,
  ],
  [
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  ],
  [
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125,
    0.001708984375,
  ],
];
const TAPS = 12;

const toDb = (level: number) => (level > 0 ? 20 * Math.log10(level) : -Infinity);
export const loudnessOf = (power: number) =>
  power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;

/** One channel as it goes through: its two filters' memory and the samples the true peak needs. */
export class MeterChannel {
  readonly #filters: readonly [Biquad, Biquad];
  readonly #state = new Float64Array(4);
  /** The samples the interpolation needs, see `step`. */
  readonly #history = new Float64Array(TAPS * 2);
  #at = 0;
  truePeak = 0;
  /** Samples at full scale in a row now, and how many of them were counted as clipped. */
  run = 0;
  counted = 0;

  constructor(rate: number) {
    this.#filters = kWeighting(rate);
  }

  /** The K-weighted square of a sample, and what it adds to the true peak. */
  step(sample: number): number {
    let x = sample;
    for (let index = 0; index < 2; index += 1) {
      const filter = this.#filters[index] as Biquad;
      const at = index * 2;
      // Transposed direct form II.
      const y = filter.b0 * x + (this.#state[at] as number);
      this.#state[at] = filter.b1 * x - filter.a1 * y + (this.#state[at + 1] as number);
      this.#state[at + 1] = filter.b2 * x - filter.a2 * y;
      x = y;
    }
    // The last `TAPS` samples twice over, so that they read in a row from `#at`, newest last.
    const history = this.#history;
    const at = this.#at;
    history[at] = sample;
    history[at + TAPS] = sample;
    this.#at = (at + 1) % TAPS;
    const newest = at + TAPS;
    for (const phase of TRUE_PEAK_PHASES) {
      let value = 0;
      for (let tap = 0; tap < TAPS; tap += 1)
        value += (phase[tap] as number) * (history[newest - tap] as number);
      const level = Math.abs(value);
      if (level > this.truePeak) this.truePeak = level;
    }
    return x * x;
  }
}

export interface MeterOptions {
  readonly rate: number;
  readonly channels: number;
  /** How long it is, in seconds, for the small picture of its level. */
  readonly seconds: number;
  /** How many parts that picture has. */
  readonly buckets?: number;
}

/**
 * Measures samples as they come: `push` each piece in order, `result` once at the end. The same
 * samples give the same numbers, whatever pieces they come in.
 */
export class SoundMeter {
  readonly #rate: number;
  readonly #channels: MeterChannel[];
  readonly #subLength: number;
  readonly #stepLength: number;
  readonly #buckets: Float32Array;
  readonly #bucketLength: number;
  /** Samples measured so far, of each channel. */
  #count = 0;
  /** The K-weighted energy of the 100 ms sub-block on its way, summed over channels. */
  #subEnergy = 0;
  #subCount = 0;
  /** The mean square of each 100 ms sub-block so far. */
  readonly #subs: number[] = [];
  #samplePeak = 0;
  /** The largest sample of the 1 ms step on its way, and of each step so far. */
  #stepPeak = 0;
  #stepCount = 0;
  readonly #steps: number[] = [];
  /** Clips: the place on its way, and those so far. */
  #clip: { from: number; to: number; samples: number } | undefined;
  readonly #clips: ClipPlace[] = [];
  #clipPlaces = 0;
  #clipSamples = 0;

  constructor(options: MeterOptions) {
    this.#rate = options.rate;
    this.#channels = Array.from({ length: options.channels }, () => new MeterChannel(options.rate));
    this.#subLength = Math.round(options.rate * SUB_SECONDS);
    this.#stepLength = Math.max(1, Math.round(options.rate * STEP_SECONDS));
    const buckets = Math.max(1, options.buckets ?? 240);
    this.#buckets = new Float32Array(buckets);
    this.#bucketLength = Math.max(1, (options.seconds * options.rate) / buckets);
  }

  /** The next samples, one array a channel, all of the same length. */
  push(channels: readonly Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    for (let index = 0; index < length; index += 1) {
      let energy = 0;
      let peak = 0;
      let clipped = 0;
      for (let channel = 0; channel < this.#channels.length; channel += 1) {
        const meter = this.#channels[channel] as MeterChannel;
        const sample = channels[channel]?.[index] ?? 0;
        energy += meter.step(sample);
        const level = Math.abs(sample);
        if (level > peak) peak = level;
        if (level >= FULL_SCALE) {
          meter.run += 1;
          // A run counts once it is long enough, with the samples before it; an over at once.
          if (meter.run >= CLIP_RUN || level > 1) {
            clipped += meter.run - meter.counted;
            meter.counted = meter.run;
          }
        } else {
          meter.run = 0;
          meter.counted = 0;
        }
      }
      const at = this.#count;
      if (clipped > 0) this.#clipAt(at, clipped);
      if (peak > this.#samplePeak) this.#samplePeak = peak;
      const bucket = Math.min(this.#buckets.length - 1, Math.floor(at / this.#bucketLength));
      if (peak > (this.#buckets[bucket] as number)) this.#buckets[bucket] = peak;
      if (peak > this.#stepPeak) this.#stepPeak = peak;
      this.#stepCount += 1;
      if (this.#stepCount === this.#stepLength) {
        this.#steps.push(this.#stepPeak);
        this.#stepPeak = 0;
        this.#stepCount = 0;
      }
      this.#subEnergy += energy;
      this.#subCount += 1;
      if (this.#subCount === this.#subLength) {
        this.#subs.push(this.#subEnergy / this.#subLength);
        this.#subEnergy = 0;
        this.#subCount = 0;
      }
      this.#count += 1;
    }
  }

  #clipAt(at: number, samples: number): void {
    const gap = Math.round(CLIP_GAP_SECONDS * this.#rate);
    const place = this.#clip;
    if (place && at - place.to <= gap) {
      place.to = at;
      place.samples += samples;
    } else {
      this.#endClip();
      this.#clip = { from: at, to: at, samples };
    }
    this.#clipSamples += samples;
  }

  #endClip(): void {
    const place = this.#clip;
    if (!place) return;
    this.#clipPlaces += 1;
    if (this.#clips.length < MOST_PLACES)
      this.#clips.push({
        from: place.from / this.#rate,
        to: (place.to + 1) / this.#rate,
        samples: place.samples,
      });
    this.#clip = undefined;
  }

  /** What was measured, all of it: no more pieces after this. */
  result(envelope = false): Measured {
    this.#endClip();
    if (this.#stepCount > 0) {
      this.#steps.push(this.#stepPeak);
      this.#stepCount = 0;
    }
    const subs = this.#subs;
    const windowed = (size: number) => {
      const powers: number[] = [];
      let sum = 0;
      for (let index = 0; index < subs.length; index += 1) {
        sum += subs[index] as number;
        if (index >= size) sum -= subs[index - size] as number;
        if (index >= size - 1) powers.push(Math.max(0, sum / size));
      }
      return powers;
    };
    const blocks = windowed(MOMENTARY_SUBS);
    const shortTerm = windowed(SHORT_TERM_SUBS);
    const loudest = (powers: readonly number[]) =>
      powers.length === 0 ? undefined : finite(loudnessOf(Math.max(...powers)));
    // Gated: above −70 LUFS, then above 10 LU under the loudness of those.
    const above = blocks.filter((power) => loudnessOf(power) > ABSOLUTE_GATE);
    let integrated: number | undefined;
    if (above.length > 0) {
      const gate = loudnessOf(mean(above)) + RELATIVE_GATE;
      const gated = above.filter((power) => loudnessOf(power) > gate);
      integrated = gated.length > 0 ? finite(loudnessOf(mean(gated))) : undefined;
    }
    const truePeak = Math.max(
      this.#samplePeak,
      ...this.#channels.map((channel) => channel.truePeak),
    );
    const silences = this.#silences();
    return {
      seconds: this.#count / this.#rate,
      integrated,
      shortTermMax: loudest(shortTerm),
      momentaryMax: loudest(blocks),
      truePeak: toDb(truePeak),
      samplePeak: toDb(this.#samplePeak),
      clipping: { places: this.#clipPlaces, samples: this.#clipSamples },
      clips: this.#clips,
      silences: silences.kept,
      silent: this.#samplePeak < 10 ** (SILENCE_DBFS / 20),
      envelope: envelope ? this.#envelope() : undefined,
      wave: [...this.#buckets].map((level) => Math.round(Math.min(1, level) * 1000) / 1000),
    };
  }

  #silences(): { kept: Stretch[] } {
    const quiet = 10 ** (SILENCE_DBFS / 20);
    const step = this.#stepLength / this.#rate;
    const least = Math.round(SILENCE_SECONDS / step);
    const kept: Stretch[] = [];
    let from: number | undefined;
    const end = (to: number) => {
      if (from !== undefined && to - from >= least && kept.length < MOST_PLACES)
        kept.push({ from: from * step, to: Math.min(to * step, this.#count / this.#rate) });
      from = undefined;
    };
    this.#steps.forEach((level, index) => {
      if (level < quiet) from ??= index;
      else end(index);
    });
    end(this.#steps.length);
    return { kept };
  }

  #envelope(): Envelope | undefined {
    const steps = this.#steps;
    const step = this.#stepLength / this.#rate;
    let peakAt = 0;
    for (let index = 1; index < steps.length; index += 1)
      if ((steps[index] as number) > (steps[peakAt] as number)) peakAt = index;
    const peak = steps[peakAt] ?? 0;
    if (peak < 10 ** (SILENCE_DBFS / 20)) return undefined;
    const onset = steps.findIndex((level) => level >= peak * 0.1);
    const risen = steps.findIndex((level, index) => index >= onset && level >= peak * 0.9);
    // From the peak to the last moment it is 40 dB below it or louder.
    const floor = peak * 0.01;
    let last = peakAt;
    for (let index = steps.length - 1; index > peakAt; index -= 1)
      if ((steps[index] as number) >= floor) {
        last = index;
        break;
      }
    return {
      peak: toDb(peak),
      peakAt: peakAt * step,
      onset: onset * step,
      attack: Math.max(0, risen - onset) * step,
      decay: (last + 1 - peakAt) * step,
      cut: last >= steps.length - 1,
    };
  }
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const finite = (value: number) => (Number.isFinite(value) ? value : undefined);
