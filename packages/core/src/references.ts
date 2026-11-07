import { canHold } from "@animaquill/schema";
import { entryOf, type ClipState, type ProjectState, type TimelineState } from "./model.ts";
import { getIn, type Patch } from "./patch.ts";
import type { Path } from "./structure.ts";

const NONE: readonly string[] = [];

/** One thing that points at another, which is not there. */
const link = (from: string, to: Path) => `${from} -> ${to.join("/")}`;

/** What a source needs. Plugin sources can hold anything, so only the known kinds are read. */
function targetsOf(source: unknown): readonly Path[] {
  const { kind, media, scene, sound, timeline } = (source ?? {}) as {
    readonly kind?: string;
    readonly media?: { readonly asset?: string };
    readonly scene?: string;
    readonly sound?: string;
    readonly timeline?: string;
  };
  switch (kind) {
    case "video":
    case "image":
    case "audio":
      return media?.asset === undefined ? [] : [["assets", media.asset]];
    case "scene":
      return scene === undefined ? [] : [["scenes", scene]];
    case "sound":
      return sound === undefined ? [] : [["sounds", sound]];
    case "timeline":
      return timeline === undefined ? [] : [["timelines", timeline]];
    default:
      return [];
  }
}

/** Every source in a project, and where it is: clips, and what versions change about them. */
function* sourcesIn(state: ProjectState): Generator<readonly [string, unknown]> {
  for (const [id, timeline] of Object.entries(state.timelines)) {
    for (const clip of Object.values(timeline.clips)) {
      yield [`timelines/${id}/clips/${clip.id}`, clip.source];
    }
    for (const [name, { clips }] of Object.entries(timeline.overrides)) {
      for (const [clip, changes] of Object.entries(clips ?? {})) {
        const from = `timelines/${id}/overrides/${name}/clips/${clip}`;
        if (changes.source) yield [from, changes.source.value];
      }
    }
  }
}

/** A state does not change, and a file can take away thousands of assets from a big project. */
const usersByState = new WeakMap<ProjectState, ReadonlyMap<string, readonly string[]>>();

function usersIn(state: ProjectState): ReadonlyMap<string, readonly string[]> {
  const cached = usersByState.get(state);
  if (cached) return cached;
  const users = new Map<string, string[]>();
  for (const [from, source] of sourcesIn(state)) {
    for (const target of targetsOf(source)) {
      const key = target.join("/");
      const known = users.get(key);
      if (known) known.push(from);
      else users.set(key, [from]);
    }
  }
  usersByState.set(state, users);
  return users;
}

const usersOf = (state: ProjectState, target: Path) =>
  (usersIn(state).get(target.join("/")) ?? NONE).map((from) => link(from, target));

/** Whether clips, or what versions change about them, use something. */
export const isInUse = (state: ProjectState, target: Path): boolean =>
  usersIn(state).has(target.join("/"));

const missing = (state: ProjectState, from: string, source: unknown) =>
  targetsOf(source)
    .filter((target) => getIn(state, target) === undefined)
    .map((target) => link(from, target));

function danglingFromClip(
  state: ProjectState,
  id: string,
  timeline: TimelineState,
  clip: ClipState,
): readonly string[] {
  const from = `timelines/${id}/clips/${clip.id}`;
  const home = ["timelines", id, "tracks", clip.track];
  const track = entryOf(timeline.tracks, clip.track);
  const kind = (clip.source as { readonly kind?: string } | undefined)?.kind;
  // A track that cannot hold a clip takes the whole timeline out of the files.
  const fits = !track || kind === undefined || canHold(track.kind, kind);
  return [
    ...(track ? [] : [link(from, home)]),
    ...(fits ? [] : [`${link(from, home)} of another kind`]),
    ...missing(state, from, clip.source),
  ];
}

function danglingFromTransition(
  id: string,
  timeline: TimelineState,
  transitionId: string,
): readonly string[] {
  const transition = entryOf(timeline.transitions, transitionId);
  if (!transition) return NONE;
  const from = `timelines/${id}/transitions/${transitionId}`;
  const clips = [transition.from, transition.to].flatMap((clip) =>
    clip === undefined || entryOf(timeline.clips, clip)
      ? []
      : [link(from, ["timelines", id, "clips", clip])],
  );
  return entryOf(timeline.tracks, transition.track)
    ? clips
    : [...clips, link(from, ["timelines", id, "tracks", transition.track])];
}

function danglingFromOverride(
  state: ProjectState,
  id: string,
  timeline: TimelineState,
  name: string,
  only: string | undefined,
): readonly string[] {
  const clips = entryOf(timeline.overrides, name)?.clips ?? {};
  const ids = only === undefined ? Object.keys(clips) : [only];
  return ids.flatMap((clip) => {
    const source = entryOf(clips, clip)?.source;
    const from = `timelines/${id}/overrides/${name}/clips/${clip}`;
    return source ? missing(state, from, source.value) : [];
  });
}

/** What is on a track that is gone. */
function usersOfTrack(id: string, timeline: TimelineState, path: Path): readonly string[] {
  const track = path.at(-1);
  return [
    ...Object.values(timeline.clips)
      .filter((clip) => clip.track === track)
      .map((clip) => link(`timelines/${id}/clips/${clip.id}`, path)),
    ...Object.values(timeline.transitions)
      .filter((transition) => transition.track === track)
      .map((transition) => link(`timelines/${id}/transitions/${transition.id}`, path)),
  ];
}

/** What goes from or to a clip that is gone. */
function usersOfClip(id: string, timeline: TimelineState, path: Path): readonly string[] {
  const clip = path.at(-1);
  return Object.values(timeline.transitions)
    .filter((transition) => transition.from === clip || transition.to === clip)
    .map((transition) => link(`timelines/${id}/transitions/${transition.id}`, path));
}

/** What is wrong around a path inside of a timeline. */
function danglingInTimeline(state: ProjectState, path: Path): readonly string[] {
  const [, id = "", level, item = "", field] = path;
  const timeline = entryOf(state.timelines, id);
  if (!timeline) return NONE;
  switch (level) {
    case "tracks":
      return path.length === 4 && !entryOf(timeline.tracks, item)
        ? usersOfTrack(id, timeline, path)
        : NONE;
    case "sections":
      return Object.keys(timeline.sections).length === 0 ? [`timelines/${id} -> a section`] : NONE;
    case "clips": {
      const clip = entryOf(timeline.clips, item);
      if (!clip) return path.length === 4 ? usersOfClip(id, timeline, path) : NONE;
      return path.length === 4 || field === "track" || field === "source"
        ? danglingFromClip(state, id, timeline, clip)
        : NONE;
    }
    case "transitions":
      return danglingFromTransition(id, timeline, item);
    case "overrides":
      return path.length <= 6 || path[6] === "source"
        ? danglingFromOverride(state, id, timeline, item, path[5])
        : NONE;
    default:
      return NONE;
  }
}

/** A whole timeline can come back, which is everything in it at once. */
function danglingFromTimeline(
  state: ProjectState,
  id: string,
  timeline: TimelineState,
): readonly string[] {
  return [
    ...Object.values(timeline.clips).flatMap((clip) => danglingFromClip(state, id, timeline, clip)),
    ...Object.keys(timeline.transitions).flatMap((transition) =>
      danglingFromTransition(id, timeline, transition),
    ),
    ...Object.keys(timeline.overrides).flatMap((name) =>
      danglingFromOverride(state, id, timeline, name, undefined),
    ),
  ];
}

/**
 * A file that a scene or sound can miss. Writing a new file to one that was there all along knows
 * this from before, so that step is free to go back: this only keeps the files of something that
 * has to stay from going back with it. Either both go, or they stay together.
 */
function danglingFile(state: ProjectState, path: Path): readonly string[] {
  const [, file = ""] = path;
  const [folder = "", name = ""] = file.split("/");
  const owner = [folder, name];
  const isOwned = CODE_ROOTS.includes(folder) && getIn(state, owner) !== undefined;
  return isOwned && getIn(state, path) === undefined ? [link(owner.join("/"), path)] : NONE;
}

/**
 * What points at nothing because of what is at a path now, or is no longer there: a clip whose track
 * or asset is gone, a transition without its clips, a timeline without sections, or a scene without
 * a file of it. Commands do not do this, but a file and two people at once can. Taking a change back
 * has to look, because it puts back an older state while the rest of the project moved on.
 */
export function danglingAt(state: ProjectState, path: Path): readonly string[] {
  const [root, id = ""] = path;
  if (root === "files") return danglingFile(state, path);
  if (root === "timelines") {
    if (path.length > 2) return danglingInTimeline(state, path);
    const timeline = entryOf(state.timelines, id);
    return timeline ? danglingFromTimeline(state, id, timeline) : usersOf(state, path);
  }
  const isTarget = root === "assets" || root === "scenes" || root === "sounds";
  return isTarget && path.length === 2 && getIn(state, path) === undefined
    ? usersOf(state, path)
    : NONE;
}

const CODE_ROOTS = ["scenes", "sounds"];

/** A timeline only changes by being replaced, and a file can take away thousands of things. */
const lockedByTimelines = new WeakMap<ProjectState["timelines"], ReadonlySet<string>>();

/** The scenes and sounds that are on a locked track, also where a version puts them there. */
function runningOnLockedTracks(state: ProjectState): ReadonlySet<string> {
  const known = lockedByTimelines.get(state.timelines);
  if (known) return known;
  const running = new Set<string>();
  for (const timeline of Object.values(state.timelines)) {
    const isLocked = ({ track }: ClipState) => entryOf(timeline.tracks, track)?.locked === true;
    if (!Object.values(timeline.tracks).some(({ locked }) => locked)) continue;
    const add = (source: unknown) => {
      for (const target of targetsOf(source)) {
        if (CODE_ROOTS.includes(target[0] as string)) running.add(target.join("/"));
      }
    };
    for (const clip of Object.values(timeline.clips)) {
      if (!isLocked(clip)) continue;
      add(clip.source);
      for (const { clips } of Object.values(timeline.overrides)) {
        add(entryOf(clips, clip.id)?.source?.value);
      }
    }
  }
  lockedByTimelines.set(state.timelines, running);
  return running;
}

/** Whether a locked track shows this scene or plays this sound. */
export const isOnLockedTrack = (state: ProjectState, target: Path): boolean =>
  runningOnLockedTracks(state).has(target.join("/"));

/** Whether a locked track runs any code at all. Shared code can be behind each of them. */
export const runsOnLockedTrack = (state: ProjectState): boolean =>
  runningOnLockedTracks(state).size > 0;

/** Whether writing here changes what a locked track runs. */
function reachesLockedCode(state: ProjectState, path: Path): boolean {
  const [root, id = ""] = path;
  if (root !== "files")
    return CODE_ROOTS.includes(root ?? "") && isOnLockedTrack(state, path.slice(0, 2));
  const [folder, name = ""] = id.split("/");
  if (folder === "code") return runsOnLockedTrack(state);
  return CODE_ROOTS.includes(folder ?? "") && isOnLockedTrack(state, [folder as string, name]);
}

/**
 * Whether a change reaches what is on a locked track: what is there now, or what would end up there.
 * The track itself stays open, or nobody could take the lock off. It only cannot go away.
 */
export function touchesLockedTrack(state: ProjectState, patch: Patch): boolean {
  const { path } = patch;
  if (reachesLockedCode(state, path)) return true;
  const [root, id = "", level, item = "", field] = path;
  const timeline = root === "timelines" ? entryOf(state.timelines, id) : undefined;
  if (!timeline) return false;
  const isLocked = (track: string | undefined) =>
    track !== undefined && entryOf(timeline.tracks, track)?.locked === true;
  const value = patch.op === "set" ? patch.value : undefined;
  const coming = () => {
    if (path.length === 4) return (value as { readonly track?: string } | undefined)?.track;
    return field === "track" ? (value as string | undefined) : undefined;
  };
  switch (level) {
    case undefined:
      return Object.values(timeline.tracks).some(({ locked }) => locked);
    case "tracks":
      return path.length === 4 && isLocked(item);
    case "clips":
      return isLocked(entryOf(timeline.clips, item)?.track) || isLocked(coming());
    case "transitions":
      return isLocked(entryOf(timeline.transitions, item)?.track) || isLocked(coming());
    case "overrides":
      return field === "clips" && isLocked(entryOf(timeline.clips, path[5] ?? "")?.track);
    default:
      return false;
  }
}
