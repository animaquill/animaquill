import { add, parseTime, toSeconds, type SoundManifest, type Value } from "@animaquill/schema";
import {
  clipOffset,
  entryOf,
  paramOf,
  statedSoundLength,
  type ClipState,
  type ProjectState,
} from "./model.ts";
import { hashOfText, revisionOfFiles, soundFilesOf } from "./scene-plan.ts";

/** All sounds made by code have this rate, so that nothing depends on the computer they ran on. */
export const SOUND_SAMPLE_RATE = 48_000;

/** A sound is in memory as a whole while it comes about, which at this length is 110 MiB in stereo. */
export const MAX_SOUND_SECONDS = 300;
export const MAX_SOUND_CHANNELS = 2;

/**
 * The first part of the name of a sound in the media store. It goes up when the same code would
 * come out differently, or what was kept would stay around as if nothing happened.
 */
const CACHE_VERSION = 1;

/** Everything that decides how a sound comes out. Two of these with one `file` sound the same. */
export interface MadeSound {
  /** What it is called in the media store once it is there. */
  readonly file: string;
  readonly sound: string;
  /** The file to start with, from the root of the project. */
  readonly entry: string;
  readonly runtime: number;
  readonly output: string | undefined;
  readonly params: Readonly<Record<string, Value>>;
  readonly seed: number;
  readonly sampleRate: number;
  /** Seconds. */
  readonly duration: number;
}

const PARAM = "param.";

/** In a fixed order, so that the same values written another way are not another sound. */
function paramsOf(clip: ClipState, manifest: SoundManifest): Readonly<Record<string, Value>> {
  const ids = new Set(manifest.params?.map(({ id }) => id));
  for (const path of Object.keys(clip.properties ?? {})) {
    if (path.startsWith(PARAM)) ids.add(path.slice(PARAM.length));
  }
  const params: [string, Value][] = [];
  for (const id of [...ids].toSorted()) {
    const value = paramOf(clip, manifest, id);
    if (value !== undefined) params.push([id, value]);
  }
  return Object.fromEntries(params);
}

/** Without one in the project each sound has its own, which stays what it is wherever it goes. */
const seedOf = (value: Value | undefined, sound: string) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value) | 0
    : Number.parseInt(hashOfText(sound).slice(0, 6), 36);

/**
 * How long it is when nothing says: as far as the clip can reach. Cutting such a clip makes the
 * first half another sound, which is why the editor writes the length down when it places one.
 */
const lengthOf = (state: ProjectState, clip: ClipState) =>
  statedSoundLength(state, clip) ?? toSeconds(add(clipOffset(clip), parseTime(clip.duration)));

/** What the files of a sound come to, once for each state of the files. */
const revisions = new WeakMap<ProjectState["files"], Map<string, string>>();

function revisionOf(state: ProjectState, sound: string): string {
  let known = revisions.get(state.files);
  if (!known) {
    known = new Map();
    revisions.set(state.files, known);
  }
  let revision = known.get(sound);
  if (revision === undefined) {
    revision = hashOfText(JSON.stringify(revisionOfFiles(state, soundFilesOf(state, sound))));
    known.set(sound, revision);
  }
  return revision;
}

interface Made {
  readonly manifest: SoundManifest;
  readonly revision: string;
  /** What decides the length apart from those two. */
  readonly length: number;
  readonly made: MadeSound;
}

const madeByClip = new WeakMap<ClipState, Made>();

/** What a clip plays when it plays a sound of the project. Undefined when there is no such sound. */
export function madeSoundOf(state: ProjectState, clip: ClipState): MadeSound | undefined {
  const { source } = clip;
  if (source.kind !== "sound" || source.sound === undefined) return undefined;
  const sound = source.sound as string;
  const manifest = entryOf(state.sounds, sound);
  if (!manifest) return undefined;
  const revision = revisionOf(state, sound);
  const duration = lengthOf(state, clip);
  const known = madeByClip.get(clip);
  if (known?.manifest === manifest && known.revision === revision && known.length === duration) {
    return known.made;
  }
  const entry = `sounds/${sound}/${manifest.entry}`;
  const { runtime } = manifest;
  const output = source.output as string | undefined;
  const params = paramsOf(clip, manifest);
  const seed = seedOf(paramOf(clip, manifest, "seed"), sound);
  const sampleRate = SOUND_SAMPLE_RATE;
  const key = [entry, runtime, revision, output ?? null, params, seed, sampleRate, duration];
  const file = `sound-${CACHE_VERSION}:${hashOfText(JSON.stringify(key))}`;
  const made = { file, sound, entry, runtime, output, params, seed, sampleRate, duration };
  madeByClip.set(clip, { manifest, revision, length: duration, made });
  return made;
}

/** All sounds that clips of a timeline need, once each, the first one on the timeline first. */
export function madeSoundsOf(state: ProjectState, timeline: string): readonly MadeSound[] {
  const clips = Object.values(entryOf(state.timelines, timeline)?.clips ?? {});
  const sounds = new Map<string, MadeSound>();
  for (const clip of clips.filter(({ source }) => source.kind === "sound").toSorted(byStart)) {
    const made = madeSoundOf(state, clip);
    if (made) sounds.set(made.file, made);
  }
  return [...sounds.values()];
}

const byStart = (a: ClipState, b: ClipState) =>
  toSeconds(parseTime(a.start)) - toSeconds(parseTime(b.start));
