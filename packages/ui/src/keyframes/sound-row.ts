import { PEAKS_PER_SECOND } from "@animaquill/audio";
import { buildAudioPlan, fadesGainAt, type ProjectState, type SoundLayer } from "@animaquill/core";
import type { Row, TimelineModel } from "../timeline/model.ts";

/** How tall the row of sound is, open and folded, before the size of words. */
export const SOUND_ROW_HEIGHT = 48;
export const SOUND_ROW_FOLDED = 24;

/** What the row of sound shows: the sounds it adds up, and the tracks people can pick instead. */
export interface SoundPicture {
  /** Audio tracks with sound on them, top to bottom. */
  readonly tracks: readonly Row[];
  /** The one track it shows by itself, or none for all that is heard. */
  readonly track: string | undefined;
  readonly sounds: readonly SoundLayer[];
}

/** What the row of sound remembers for a window. Neither is there when it is as it starts. */
export interface SoundMemory {
  readonly folded?: true;
  readonly track?: string;
}

export function soundMemoryIn(value: unknown): SoundMemory {
  if (typeof value !== "object" || value === null) return {};
  const { folded, track } = value as Record<string, unknown>;
  return {
    ...(folded === true && { folded: true as const }),
    ...(typeof track === "string" && { track }),
  };
}

/**
 * What there is to hear on a timeline: all that is heard, as muting and solo have it, or one track
 * by itself, heard or not. Nothing at all when no audio track has a clip, so that the row goes.
 * A track that was picked and is gone shows all again.
 */
export function soundPictureOf(
  state: ProjectState,
  model: TimelineModel,
  picked: string | undefined,
): SoundPicture | undefined {
  const tracks = model.rows.filter(
    ({ track, gone, clips }) =>
      track.kind === "audio" && !gone && clips.some(({ clip }) => clip.hidden !== true),
  );
  if (tracks.length === 0) return undefined;
  const track = tracks.some((row) => row.track.id === picked) ? picked : undefined;
  return { tracks, track, sounds: buildAudioPlan(state, model.id, undefined, track).sounds };
}

/**
 * The loudest of every stretch of a waveform, halved again and again: any stretch of it has its
 * loudest in a few steps, however long the file is.
 */
const pyramids = new WeakMap<Uint8Array, readonly Uint8Array[]>();

function pyramidOf(peaks: Uint8Array): readonly Uint8Array[] {
  let levels = pyramids.get(peaks);
  if (levels) return levels;
  const built: Uint8Array[] = [peaks];
  let below = peaks;
  while (below.length > 1) {
    const level = new Uint8Array(Math.ceil(below.length / 2));
    for (let index = 0; index < level.length; index += 1) {
      const a = below[index * 2] as number;
      const b = below[index * 2 + 1] ?? 0;
      level[index] = a > b ? a : b;
    }
    built.push(level);
    below = level;
  }
  levels = built;
  pyramids.set(peaks, levels);
  return levels;
}

/** The loudest from slot `from` up to `to`, from 0 to 255. */
export function loudestIn(peaks: Uint8Array, from: number, to: number): number {
  return loudestOf(pyramidOf(peaks), from, to);
}

function loudestOf(levels: readonly Uint8Array[], from: number, to: number): number {
  const bottom = levels[0] as Uint8Array;
  let left = from > 0 ? from : 0;
  let right = to < bottom.length ? to : bottom.length;
  if (right - left === 1) return bottom[left] as number;
  let best = 0;
  for (let depth = 0; left < right; depth += 1) {
    const level = levels[depth] as Uint8Array;
    if (left & 1) {
      const value = level[left++] as number;
      if (value > best) best = value;
    }
    if (right & 1) {
      const value = level[--right] as number;
      if (value > best) best = value;
    }
    left >>= 1;
    right >>= 1;
  }
  return best;
}

/** Where the row is on screen in time. */
export interface SoundView {
  readonly width: number;
  timeAt(x: number): number;
  xAt(seconds: number): number;
}

/**
 * How loud everything together is at each pixel, from 0 to 1, into `levels`. Sounds that play at
 * once add up as their power does, which is how unrelated sounds add up, each at its volume and
 * with its transitions. A waveform that is not there yet counts as silence.
 */
export function soundLevels(
  sounds: readonly SoundLayer[],
  peaksOf: (sound: SoundLayer) => Uint8Array | undefined,
  view: SoundView,
  levels: Float32Array,
): void {
  const width = Math.min(levels.length, Math.ceil(view.width));
  levels.fill(0, 0, width);
  const from = view.timeAt(0);
  const to = view.timeAt(width);
  // Time goes evenly across the row, so a slot of a waveform is a step per pixel from the first.
  const start = view.timeAt(0);
  const perPixel = view.timeAt(1) - start;
  const perSecond = PEAKS_PER_SECOND;
  // Each pixel reads a few blocks of the halvings where a block is no wider than it: at most one
  // block too many at each side, which is less than a pixel.
  const depth = Math.max(Math.floor(Math.log2(perPixel * perSecond)), 0);
  const block = 2 ** depth;
  for (const sound of sounds) {
    if (sound.end <= from || sound.start >= to || sound.gain <= 0) continue;
    const peaks = peaksOf(sound);
    if (!peaks || peaks.length === 0) continue;
    const pyramid = pyramidOf(peaks);
    const level = pyramid[Math.min(depth, pyramid.length - 1)] as Uint8Array;
    const size = depth < pyramid.length ? block : 2 ** (pyramid.length - 1);
    const first = Math.max(Math.floor(view.xAt(sound.start)), 0);
    const last = Math.min(Math.ceil(view.xAt(sound.end)), width);
    const { fades, gain, end: soundEnd } = sound;
    const soundStart = sound.start;
    const shift = sound.offset - soundStart;
    for (let x = first; x < last; x += 1) {
      const t0 = start + x * perPixel;
      const t1 = t0 + perPixel;
      const before = t0 > soundStart ? t0 : soundStart;
      const after = t1 < soundEnd ? t1 : soundEnd;
      const slot = Math.floor((shift + before) * perSecond);
      const stop = Math.max(Math.floor((shift + after) * perSecond), slot + 1);
      let index = slot > 0 ? Math.floor(slot / size) : 0;
      const past = Math.min(Math.ceil(stop / size), level.length);
      let loudest = 0;
      for (; index < past; index += 1) {
        const value = level[index] as number;
        if (value > loudest) loudest = value;
      }
      if (loudest === 0) continue;
      const scale = fades ? gain * fadesGainAt(fades, (before + after) / 2) : gain;
      const heard = (loudest / 255) * scale;
      levels[x] = (levels[x] as number) + heard * heard;
    }
  }
  for (let x = 0; x < width; x += 1) levels[x] = Math.min(Math.sqrt(levels[x] as number), 1);
}

/** Bars around the middle of the row, one per pixel, in one fill. */
export function paintSoundLevels(
  context: CanvasRenderingContext2D,
  levels: Float32Array,
  width: number,
  area: { readonly top: number; readonly height: number },
  color: string,
): void {
  const middle = area.top + area.height / 2;
  const room = area.height / 2 - 2;
  context.fillStyle = color;
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const level = levels[x] as number;
    if (level === 0) continue;
    const half = Math.max(level * room, 0.5);
    context.rect(x, middle - half, 1, half * 2);
  }
  context.fill();
}
