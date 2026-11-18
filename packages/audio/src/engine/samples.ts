/**
 * The decoded samples of one sound, by their place in its file, and how they come down to what the
 * mix takes: one channel for mono, two for anything else, by the "speakers" rules of Web Audio,
 * which the browser used before the engine did the mix (so the sound of old projects stays).
 */

/** A piece of a file, decoded: `channels` of equal length from frame `start` of the file on. */
export interface DecodedChunk {
  /** The frame of the file the first sample is, at the rate of the file. */
  readonly start: number;
  readonly rate: number;
  readonly channels: readonly Float32Array[];
}

const f32 = Math.fround;
/** √½ in 32 bits, as Web Audio has it, and each step rounded to 32 bits as there. */
const HALF_POWER = f32(Math.SQRT1_2);

/** Frames from `from` up to `to`. */
interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * Brings frames of a chunk down to one channel (mono) or two, into `left` (and `right`) from
 * `at` on: Web Audio's down-mix to stereo for 4 and 6 channels, the first two of any other number.
 */
function downmix(
  channels: readonly Float32Array[],
  from: number,
  count: number,
  left: Float64Array,
  right: Float64Array,
  at: number,
): void {
  const [l, r, c, lfe, sl, sr] = channels;
  if (!l) return;
  if (!r) {
    for (let index = 0; index < count; index += 1) left[at + index] = l[from + index] ?? 0;
    return;
  }
  if (channels.length === 4 && c && lfe) {
    // Quad: left, right, surround left, surround right.
    const [surroundLeft, surroundRight] = [c, lfe];
    for (let index = 0; index < count; index += 1) {
      const frame = from + index;
      left[at + index] = f32(0.5 * f32((l[frame] ?? 0) + (surroundLeft[frame] ?? 0)));
      right[at + index] = f32(0.5 * f32((r[frame] ?? 0) + (surroundRight[frame] ?? 0)));
    }
    return;
  }
  if (channels.length === 6 && c && sl && sr) {
    // 5.1: left, right, centre, low frequencies (left out), surround left, surround right.
    for (let index = 0; index < count; index += 1) {
      const frame = from + index;
      const centre = c[frame] ?? 0;
      const toLeft = f32(HALF_POWER * f32(centre + (sl[frame] ?? 0)));
      const toRight = f32(HALF_POWER * f32(centre + (sr[frame] ?? 0)));
      left[at + index] = f32((l[frame] ?? 0) + toLeft);
      right[at + index] = f32((r[frame] ?? 0) + toRight);
    }
    return;
  }
  for (let index = 0; index < count; index += 1) {
    left[at + index] = l[from + index] ?? 0;
    right[at + index] = r[from + index] ?? 0;
  }
}

/**
 * What has been decoded of a sound, for the mix to read. Frames before the file and after its end
 * are silence, and so are gaps between chunks where whoever reads the file says it has read it all
 * (`cover`). Frames that were not read (yet) are missing, which a read says.
 */
export class SampleStore {
  #chunks: DecodedChunk[] = [];
  #rate: number | undefined;
  #channels = 0;
  /** The frame after the last of the file, once that is known. */
  #end = Number.POSITIVE_INFINITY;
  /** The frames that were read, apart from each other: what no chunk has there is silence. */
  #known: Span[] = [];
  /** Where the last read found its chunk, as reads mostly go on from there. */
  #cursor = 0;

  /** The rate of the file, once a chunk of it is here. */
  get rate(): number | undefined {
    return this.#rate;
  }

  /** 1 for mono, 2 for all else, once a chunk is here. */
  get channels(): number {
    return this.#channels;
  }

  /** Whether where the file ends is known. */
  get ended(): boolean {
    return this.#end !== Number.POSITIVE_INFINITY;
  }

  /** Frames in the store, to keep an eye on memory. */
  get frames(): number {
    return this.#chunks.reduce((sum, chunk) => sum + (chunk.channels[0]?.length ?? 0), 0);
  }

  /** A chunk, which also covers its own frames. */
  add(chunk: DecodedChunk): void {
    const length = chunk.channels[0]?.length ?? 0;
    if (length === 0) return;
    // A file keeps its rate. A chunk at another one would not fit in with the others.
    if (this.#rate !== undefined && chunk.rate !== this.#rate) return;
    this.#rate = chunk.rate;
    this.#channels = chunk.channels.length > 1 ? 2 : 1;
    const chunks = this.#chunks;
    let index = chunks.length;
    while (index > 0 && (chunks[index - 1]?.start ?? 0) > chunk.start) index -= 1;
    chunks.splice(index, 0, chunk);
    this.cover(chunk.start, chunk.start + length);
  }

  /** All of the file from frame `from` up to `to` was read: what no chunk has there is silent. */
  cover(from: number, to: number): void {
    if (to <= from) return;
    let low = from;
    let high = to;
    const kept: Span[] = [];
    for (const span of this.#known) {
      if (span.to < low || span.from > high) kept.push(span);
      else {
        low = Math.min(low, span.from);
        high = Math.max(high, span.to);
      }
    }
    kept.push({ from: low, to: high });
    this.#known = kept.toSorted((a, b) => a.from - b.from);
  }

  /** The file ends before this frame: from there on it is silent. */
  endAt(frame: number): void {
    this.#end = frame;
  }

  /** Lets go of chunks that end before `from` or start at `to` or later. */
  keepOnly(from: number, to: number): void {
    const kept = this.#chunks.filter(
      (chunk) => chunk.start < to && chunk.start + (chunk.channels[0]?.length ?? 0) > from,
    );
    if (kept.length !== this.#chunks.length) {
      this.#chunks = kept;
      this.#cursor = 0;
    }
    this.#known = this.#known.flatMap((span) => {
      const left = { from: Math.max(span.from, from), to: Math.min(span.to, to) };
      return left.to > left.from ? [left] : [];
    });
  }

  /**
   * Frames `from` up to `from + count` of the file, down-mixed (see `channels`), into `left` and
   * `right` from `at` on. Silence where the file has nothing. Returns whether all of it was read.
   */
  read(from: number, count: number, left: Float64Array, right: Float64Array, at: number): boolean {
    left.fill(0, at, at + count);
    if (this.#channels === 2) right.fill(0, at, at + count);
    const to = Math.min(from + count, this.#end);
    // Before the file there is nothing to be missed.
    let frame = Math.max(from, 0);
    if (frame >= to) return true;
    const complete = this.#known.some((span) => span.from <= frame && span.to >= to);
    const chunks = this.#chunks;
    let index = this.#find(frame);
    while (frame < to) {
      const chunk = chunks[index];
      if (!chunk) break;
      if (chunk.start > frame) frame = Math.min(chunk.start, to);
      const length = chunk.channels[0]?.length ?? 0;
      const upTo = Math.min(chunk.start + length, to);
      if (upTo > frame) {
        downmix(chunk.channels, frame - chunk.start, upTo - frame, left, right, at + frame - from);
        frame = upTo;
        this.#cursor = index;
      }
      index += 1;
    }
    return complete;
  }

  /** The first chunk that ends after `frame`. */
  #find(frame: number): number {
    const chunks = this.#chunks;
    const endOf = (chunk: DecodedChunk) => chunk.start + (chunk.channels[0]?.length ?? 0);
    const cursor = this.#cursor;
    const at = chunks[cursor];
    if (at && at.start <= frame && endOf(at) > frame) return cursor;
    let low = 0;
    let high = chunks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const chunk = chunks[middle];
      if (chunk && endOf(chunk) <= frame) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
