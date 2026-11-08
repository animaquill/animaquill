import {
  Assets,
  CURRENT_FORMAT_VERSION,
  Libraries,
  LibrariesLock,
  Locale,
  Notes,
  Overrides,
  ProjectManifest,
  SceneManifest,
  SoundManifest,
  Timeline,
  cannotHaveKeys,
  documentSchema,
  parseDocument,
  type Problem,
  type PropertyValue,
} from "@animaquill/schema";
import { z } from "zod";
import { CommandError, Draft } from "./draft.ts";
import {
  entryOf,
  orderedSections,
  orderedTracks,
  timelineToState,
  type ProjectState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { Mutator, deepEqual, type Patch } from "./patch.ts";
import { touchesLockedTrack } from "./references.ts";
import type { Path } from "./structure.ts";

const isUser = (origin: string) => !origin.startsWith("ai:");

/** Whether a file holds code that belongs to the project, kept as text. */
export const isSourceFile = (path: string): boolean =>
  /^(scenes|sounds|code)\//.test(path) && documentSchema(path) === undefined;

/** Keeps the positions of tracks and sections when their order did not change. */
function keepOrder(current: TimelineState, next: TimelineState): TimelineState {
  const same = (a: readonly { id: string }[], b: readonly { id: string }[]) =>
    deepEqual(
      a.map((item) => item.id),
      b.map((item) => item.id),
    );
  const carry = <T extends { readonly order: number }>(
    items: Readonly<Record<string, T>>,
    from: Readonly<Record<string, T>>,
  ) =>
    Object.fromEntries(
      Object.entries(items).map(([id, item]) => [
        id,
        { ...item, order: from[id]?.order ?? item.order },
      ]),
    );
  return {
    ...next,
    tracks: same(orderedTracks(current), orderedTracks(next))
      ? carry(next.tracks, current.tracks)
      : next.tracks,
    sections: same(orderedSections(current), orderedSections(next))
      ? carry(next.sections, current.sections)
      : next.sections,
  };
}

const parsed = <T>(path: string, text: string, schema: z.ZodType<T>, problems: Problem[]) => {
  const result = parseDocument(path, text, schema);
  problems.push(...result.problems);
  return result.value;
};

/**
 * Keys that a kind of property cannot have stay out. The ones a project already has stay in: an old
 * project has to go on working, and a file that only changes something else has to get through.
 */
function checkKeys(
  file: string,
  where: string,
  value: PropertyValue | undefined,
  known: PropertyValue | undefined,
  path: string,
  problems: Problem[],
): void {
  if (value === undefined || !cannotHaveKeys(path, value) || deepEqual(value, known)) return;
  const message = `${path} 不能打关键帧`;
  problems.push({ severity: "error", code: "not-animatable", file, path: where, message });
}

function checkTimelineKeys(
  file: string,
  next: TimelineState,
  current: TimelineState | undefined,
  problems: Problem[],
): void {
  for (const clip of Object.values(next.clips)) {
    const known = entryOf(current?.clips, clip.id)?.properties;
    for (const [path, value] of Object.entries(clip.properties ?? {})) {
      checkKeys(file, `${clip.id}.${path}`, value, entryOf(known, path), path, problems);
    }
  }
}

function checkOverrideKeys(
  file: string,
  next: Overrides,
  current: Overrides | undefined,
  problems: Problem[],
): void {
  for (const [id, changes] of Object.entries(next.clips ?? {})) {
    const known = entryOf(current?.clips, id)?.properties;
    for (const [path, change] of Object.entries(changes.properties ?? {})) {
      const before = entryOf(known, path);
      const where = `clips.${id}.properties.${path}`;
      checkKeys(file, where, change.value, before?.value, path, problems);
      checkKeys(file, where, change.base, before?.base, path, problems);
    }
  }
}

/** What became of a file. */
export interface FileImport {
  /** What is wrong with the file. Nothing of it gets in then. */
  readonly problems: readonly Problem[];
  /** What it would change on locked tracks, which stays as it is. */
  readonly kept: readonly Path[];
  /** The same for people and AI: a warning for each thing that stays, which says why. */
  readonly held: readonly Problem[];
}

/**
 * A file that changed outside of the editor, for example written by an AI tool. It goes through
 * the same checks as anything else and becomes a change to the objects that really differ, so it
 * can be undone and merged like an edit. A file that is not valid changes nothing.
 *
 * A lock protects what is on a track from everyone, and a file is no exception: what it would change
 * there stays as it is, and the rest comes in. This goes by `touchesLockedTrack`, like taking
 * changes back does. Which tracks are locked is what the project says when the file comes, apart
 * from what the file itself does to locks, see `locksOf`.
 */
export function planFileImport(draft: Draft, path: string, text: string): FileImport {
  const planned = new Draft(draft.state, draft.origin);
  const problems = planDocument(planned, path, text);
  if (problems.length > 0) return { problems, kept: [], held: [] };
  const locks = locksOf(draft.state, planned.state, draft.origin);
  const kept: Patch[] = [];
  for (const patch of inLockOrder(planned.steps.map((step) => step.patch))) {
    if (isHeld(locks, patch, draft.origin)) kept.push(patch);
    else draft.apply(patch);
  }
  return { problems, kept: kept.map((patch) => patch.path), held: heldIn(locks, path, kept) };
}

const isLockPatch = ({ path }: Patch) =>
  path.length === 5 && path[0] === "timelines" && path[2] === "tracks" && path[4] === "locked";

const lockOf = (path: Path): Patch => ({ op: "set", path: [...path, "locked"], value: true });

/**
 * A file has no order, but what it changes is taken back last first. So it goes like a batch that
 * takes locks off first, then changes what it changes, and puts locks on last: what comes with a
 * lock is there before the lock is, and taking the file back takes the lock off before anything it
 * protects, or leaves that as it is when the lock has to stay. A new track, also of a new timeline,
 * gets its lock after what is on it in the same way.
 */
function inLockOrder(patches: readonly Patch[]): readonly Patch[] {
  const opening: Patch[] = [];
  const changes: Patch[] = [];
  const closing: Patch[] = [];
  const unlocked = (path: Path, track: TrackState) => {
    if (track.locked !== true) return track;
    closing.push(lockOf(path));
    const { locked: _locked, ...rest } = track;
    return rest;
  };
  for (const patch of patches) {
    const [root, , level] = patch.path;
    if (isLockPatch(patch)) {
      (patch.op === "set" && patch.value === true ? closing : opening).push(patch);
    } else if (patch.op === "set" && root === "timelines" && patch.path.length === 2) {
      const timeline = patch.value as TimelineState;
      const tracks = Object.fromEntries(
        Object.entries(timeline.tracks).map(([id, track]) => [
          id,
          unlocked([...patch.path, "tracks", id], track),
        ]),
      );
      changes.push({ ...patch, value: { ...timeline, tracks } });
    } else if (patch.op === "set" && level === "tracks" && patch.path.length === 4) {
      changes.push({ ...patch, value: unlocked(patch.path, patch.value as TrackState) });
    } else {
      changes.push(patch);
    }
  }
  return [...opening, ...changes, ...closing];
}

/**
 * The project as far as locks go while a file comes in. A person's file can take a lock off, like
 * a person can, and then what it changes on that track is theirs to change: a file has no order, so
 * that is the same as taking the lock off first. An AI task cannot tell a file that leaves a lock out
 * from one that means it, so its files leave locks as they are. A file that puts a lock on changes
 * that track like any other, and the lock is there from then on.
 */
function locksOf(before: ProjectState, planned: ProjectState, origin: string): ProjectState {
  if (!isUser(origin)) return before;
  let opened: Mutator<ProjectState> | undefined;
  for (const [id, timeline] of Object.entries(before.timelines)) {
    for (const track of Object.values(timeline.tracks)) {
      if (track.locked !== true) continue;
      const after = entryOf(entryOf(planned.timelines, id)?.tracks, track.id);
      // A track that a file leaves out is no lock taken off: it cannot go away while it is locked.
      if (!after || after.locked === true) continue;
      opened ??= new Mutator(before);
      opened.delete(["timelines", id, "tracks", track.id, "locked"]);
    }
  }
  return opened?.root ?? before;
}

const isLockOf = (state: ProjectState, { path }: Patch) => {
  const [root, timeline = "", level, track = "", field] = path;
  if (root !== "timelines" || level !== "tracks" || field !== "locked" || path.length !== 5) {
    return false;
  }
  return entryOf(entryOf(state.timelines, timeline)?.tracks, track)?.locked === true;
};

/** Whether a file leaves this as it is, because of a lock. */
const isHeld = (locks: ProjectState, patch: Patch, origin: string) =>
  touchesLockedTrack(locks, patch) || (!isUser(origin) && isLockOf(locks, patch));

/** Why a file leaves something on a locked track as it is: what that is, where, and the message. */
function whyHeld(
  locks: ProjectState,
  patch: Patch,
): { readonly about: string; readonly where?: string; readonly message: string } {
  const [root, id = "", level, item = "", field] = patch.path;
  const [folder = "", name = ""] = id.split("/");
  if (root === "files" && folder === "code") {
    const message = "锁定的轨道上有场景或声音，共用代码不能改，文件里的改动没有生效";
    return { about: "code", message };
  }
  if (root !== "timelines") {
    const [kind, owner] = root === "files" ? [folder, name] : [root ?? "", id];
    const known = kind === "scenes" ? entryOf(locks.scenes, owner) : entryOf(locks.sounds, owner);
    const message = `“${known?.name ?? owner}”在锁定的轨道上使用，文件里的改动没有生效`;
    return { about: `${kind} ${owner}`, message };
  }
  const timeline = entryOf(locks.timelines, id);
  const lockedOf = (track: string | undefined) =>
    track !== undefined && entryOf(timeline?.tracks, track)?.locked === true ? track : undefined;
  const nameOf = (track: string | undefined) =>
    (track === undefined ? undefined : entryOf(timeline?.tracks, track)?.name) ?? track;
  // What would end up on a locked track: a new clip or transition, or one that moves there.
  const whole = patch.op === "set" && patch.path.length === 4 ? patch.value : undefined;
  const coming = (whole as { readonly track?: string } | undefined)?.track;
  const onto = field === "track" && patch.op === "set" ? (patch.value as string) : undefined;
  const locked = (here: string | undefined) =>
    `轨道“${nameOf(lockedOf(here) ?? lockedOf(coming) ?? onto)}”已锁定`;
  switch (level) {
    case "clips": {
      const clip = entryOf(timeline?.clips, item);
      const message = `${locked(clip?.track)}，文件里对片段“${clip?.name ?? item}”的改动没有生效`;
      return { about: `clip ${item}`, where: item, message };
    }
    case "transitions": {
      const transition = entryOf(timeline?.transitions, item);
      const message = `${locked(transition?.track)}，文件里对转场“${item}”的改动没有生效`;
      return { about: `transition ${item}`, where: item, message };
    }
    case "tracks": {
      const message =
        field === "locked"
          ? `${locked(item)}，AI 不能用文件解锁，要解锁请用命令，或者请用户解锁`
          : `${locked(item)}，文件里对这条轨道的改动没有生效`;
      return { about: `track ${item}`, where: item, message };
    }
    case "overrides": {
      const owner = patch.path[5] ?? "";
      const clip = entryOf(timeline?.clips, owner);
      const message = `${locked(clip?.track)}，文件里对片段“${clip?.name ?? owner}”的差异没有生效`;
      return { about: `clip ${owner}`, where: `clips.${owner}`, message };
    }
    default:
      return { about: "", message: "轨道已锁定，文件里的这部分改动没有生效" };
  }
}

/** What a file leaves as it is because of locks, for the problems of the file: once for each thing. */
function heldIn(locks: ProjectState, file: string, kept: readonly Patch[]): readonly Problem[] {
  const said = new Map<string, Problem>();
  for (const patch of kept) {
    const { about, where, message } = whyHeld(locks, patch);
    if (said.has(about)) continue;
    const path = where === undefined ? {} : { path: where };
    said.set(about, { severity: "warning", code: "track-locked", file, ...path, message });
  }
  return [...said.values()];
}

/** Plans what a valid file changes, and says what is wrong with one that is not. */
function planDocument(draft: Draft, path: string, text: string): readonly Problem[] {
  const problems: Problem[] = [];

  if (isSourceFile(path)) {
    if (draft.state.files[path] !== text) draft.setText(["files", path], text);
    return problems;
  }

  const timeline = /^timelines\/([^/]+)\/timeline\.json$/.exec(path)?.[1];
  const overrides = /^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/.exec(path);
  const scene = /^scenes\/([^/]+)\/scene\.json$/.exec(path)?.[1];
  const sound = /^sounds\/([^/]+)\/sound\.json$/.exec(path)?.[1];
  const locale = /^locales\/([^/]+)\.json$/.exec(path)?.[1];

  if (path === "animaquill.json") {
    const value = parsed(path, text, ProjectManifest, problems);
    if (!value) return problems;
    if (value.formatVersion !== CURRENT_FORMAT_VERSION) {
      throw new CommandError("format-mismatch", "不能在这里改项目的格式版本");
    }
    if (!isUser(draft.origin) && !deepEqual(value.tags, draft.state.manifest.tags)) {
      throw new CommandError("user-only", "AI 不能改项目的标签");
    }
    draft.replace(["manifest"], value);
  } else if (path === "assets.json") {
    const value = parsed(path, text, Assets, problems);
    if (value) draft.replace(["assets"], value.assets);
  } else if (path === "libraries.json") {
    const value = parsed(path, text, Libraries, problems);
    if (value) draft.replace(["libraries"], value);
  } else if (path === "libraries.lock.json") {
    const value = parsed(path, text, LibrariesLock, problems);
    if (value) draft.replace(["lock"], value);
  } else if (path === "notes.json") {
    const value = parsed(path, text, Notes, problems);
    if (value) {
      draft.replace(["notes"], Object.fromEntries(value.notes.map((note) => [note.id, note])));
    }
  } else if (timeline) {
    const value = parsed(path, text, Timeline, problems);
    if (!value) return problems;
    const current = entryOf(draft.state.timelines, timeline);
    const next = timelineToState(value, new Map(Object.entries(current?.overrides ?? {})));
    checkTimelineKeys(path, next, current, problems);
    draft.replace(["timelines", timeline], current ? keepOrder(current, next) : next);
  } else if (overrides) {
    const [, owner = "", name = ""] = overrides;
    const value = parsed(path, text, Overrides, problems);
    if (!value) return problems;
    const target = entryOf(draft.state.timelines, owner);
    if (!target) {
      const message = `没有这条时间轴：${owner}`;
      problems.push({ severity: "error", code: "timeline-missing", file: path, path: "", message });
      return problems;
    }
    checkOverrideKeys(path, value, entryOf(target.overrides, name), problems);
    draft.replace(["timelines", owner, "overrides", name], value);
  } else if (scene) {
    const value = parsed(path, text, SceneManifest, problems);
    if (value) draft.replace(["scenes", scene], value);
  } else if (sound) {
    const value = parsed(path, text, SoundManifest, problems);
    if (value) draft.replace(["sounds", sound], value);
  } else if (locale) {
    const value = parsed(path, text, Locale, problems);
    if (value) draft.replace(["locales", locale], value.strings);
  }
  return problems;
}
