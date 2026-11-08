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
  stateToProject,
  timelineToState,
  type ProjectState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { USER } from "./origin.ts";
import { Mutator, deepEqual, getIn, type Patch } from "./patch.ts";
import {
  danglingAt,
  librariesChanged,
  touchesLockedTrack,
  usedOnLockedTracks,
} from "./references.ts";
import type { Path } from "./structure.ts";

/** Only the person at the editor is one: an AI task, a tool or anything else is not. */
const isUser = (origin: string) => origin === USER;

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
  /** What the file did that people should know about: the locks a person's file took off. */
  readonly notices: readonly Problem[];
  /**
   * What the rest of the file would break without what stays: a clip left on a track that is gone,
   * a document that cannot be written. Nothing of the file gets in then either.
   */
  readonly broken: readonly Problem[];
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
  const before = draft.state;
  const planned = new Draft(before, draft.origin);
  const problems = planDocument(planned, path, text);
  if (problems.length > 0) return { problems, kept: [], held: [], notices: [], broken: [] };
  const locks = locksOf(before, planned.state, draft.origin);
  const kept: Patch[] = [];
  const patches = inLockOrder(planned.steps.map((step) => step.patch));
  const joins = heldJoins(locks, patches, draft.origin);
  for (const each of patches) {
    const { patch, held } = withLockedLibraries(locks, each);
    kept.push(...held);
    if (patch === undefined) continue;
    if (isHeld(locks, patch, draft.origin) || joins.has(joinOf(patch))) kept.push(patch);
    else draft.repeat(patch);
  }
  const paths = planned.steps.map((step) => step.patch.path);
  return {
    problems,
    kept: kept.map((patch) => patch.path),
    held: heldIn(locks, path, kept),
    notices: unlockedIn(before, locks, path),
    broken: kept.length > 0 ? brokenWithout(before, planned.state, draft.state, path, paths) : [],
  };
}

/** The join a change is about, as `<timeline> <join>`, or nothing for anything else. */
const joinOf = ({ path }: Patch): string | undefined => {
  const [root, timeline, level, join] = path;
  return root === "timelines" && level === "joins" && join !== undefined
    ? `${timeline} ${join}`
    : undefined;
};

/**
 * The joins a file changes on locked tracks. A join comes as one field at a time, which one by one
 * would let some of a new one in next to a lock, or move one there partly: all of it stays instead.
 */
function heldJoins(
  locks: ProjectState,
  patches: readonly Patch[],
  origin: string,
): ReadonlySet<string | undefined> {
  const held = new Set<string | undefined>();
  for (const patch of patches) {
    const join = joinOf(patch);
    if (join !== undefined && isHeld(locks, patch, origin)) held.add(join);
  }
  held.delete(undefined);
  return held;
}

/**
 * A file of the libraries is one value, but each library in it is a thing of its own: what locked
 * tracks use of one stays as it is, and the others change. Returns what to write instead, nothing
 * when that is all of it, and what stays, each as a patch of its own to say so.
 */
function withLockedLibraries(
  locks: ProjectState,
  patch: Patch,
): { readonly patch: Patch | undefined; readonly held: readonly Patch[] } {
  const [root] = patch.path;
  if ((root !== "lock" && root !== "libraries") || patch.path.length !== 1 || patch.op !== "set") {
    return { patch, held: [] };
  }
  const { libraries: used } = usedOnLockedTracks(locks);
  const before = getIn(locks, patch.path);
  const staying = librariesChanged(root, before, patch.value).filter((id) => used.has(id));
  if (staying.length === 0) return { patch, held: [] };
  const held = staying.map((id): Patch => ({
    op: "set",
    path: [root, "libraries", id],
    value: id,
  }));
  const value =
    root === "lock"
      ? lockKeeping(before, patch.value, staying)
      : listKeeping(before, patch.value, staying);
  return { patch: deepEqual(value, before) ? undefined : { ...patch, value }, held };
}

type LockFile = { readonly libraries?: Readonly<Record<string, unknown>> };
type LibraryList = { readonly libraries?: readonly { readonly id: string }[] };

function lockKeeping(before: unknown, after: unknown, staying: readonly string[]): unknown {
  const was = (before as LockFile | undefined)?.libraries ?? {};
  const libraries: Record<string, unknown> = { ...(after as LockFile).libraries };
  for (const id of staying) {
    if (Object.hasOwn(was, id)) libraries[id] = was[id];
    else delete libraries[id];
  }
  return { ...(after as object), libraries };
}

function listKeeping(before: unknown, after: unknown, staying: readonly string[]): unknown {
  const was = new Map(((before as LibraryList | undefined)?.libraries ?? []).map((l) => [l.id, l]));
  const now = (after as LibraryList).libraries ?? [];
  const libraries = now.flatMap((library) => {
    if (!staying.includes(library.id)) return [library];
    const kept = was.get(library.id);
    return kept ? [kept] : [];
  });
  for (const id of staying) {
    const kept = was.get(id);
    if (kept && !now.some((library) => library.id === id)) libraries.push(kept);
  }
  return { ...(after as object), libraries };
}

/** The locks a person's file took off, which nobody should miss. */
function unlockedIn(before: ProjectState, locks: ProjectState, file: string): readonly Problem[] {
  if (locks === before) return [];
  return Object.entries(before.timelines).flatMap(([id, timeline]) =>
    Object.values(timeline.tracks).flatMap((track): Problem[] => {
      const open = entryOf(entryOf(locks.timelines, id)?.tracks, track.id)?.locked !== true;
      if (track.locked !== true || !open) return [];
      const message = `这个文件解开了轨道“${track.name ?? track.id}”的锁`;
      return [{ severity: "warning", code: "track-unlocked", file, path: track.id, message }];
    }),
  );
}

const OF_ANOTHER_KIND = " of another kind";

/** Says in words what a link from `danglingAt` comes to. */
function linkInWords(link: string): string {
  const [from = "", rest = ""] = link.split(" -> ");
  const isOfAnotherKind = rest.endsWith(OF_ANOTHER_KIND);
  const to = isOfAnotherKind ? rest.slice(0, -OF_ANOTHER_KIND.length) : rest;
  const named = (path: string) => {
    const parts = path.split("/");
    const what = { clips: "片段", joins: "衔接转场", tracks: "轨道" }[parts.at(-2) ?? ""];
    return what ? `${what}“${parts.at(-1)}”` : `“${path}”`;
  };
  if (to === "its kind") return `${named(from)}会带着它这一种轨道没有的设置`;
  if (to.includes("/tracks/")) {
    const where = isOfAnotherKind ? "放不下它的" : "已经没有的";
    return `${named(from)}会留在${where}${named(to)}上`;
  }
  return `${named(from)}会指向已经没有的${named(to)}`;
}

/**
 * What the rest of a file would break without what stays on locked tracks, that neither the project
 * before it nor the whole file would: something left pointing at nothing, such as a clip on a track
 * that the file takes away while the clip stays, or a document that cannot be written any more,
 * such as a track that cannot hold what stays on it.
 */
function brokenWithout(
  before: ProjectState,
  whole: ProjectState,
  partly: ProjectState,
  file: string,
  paths: readonly Path[],
): readonly Problem[] {
  const broken: Problem[] = [];
  const linksIn = (state: ProjectState) =>
    new Set(paths.flatMap((path) => danglingAt(state, path)));
  const links = linksIn(partly);
  if (links.size > 0) {
    const known = new Set([...linksIn(before), ...linksIn(whole)]);
    for (const link of links) {
      if (known.has(link)) continue;
      broken.push({
        severity: "error",
        code: "needs-locked-part",
        file,
        message: linkInWords(link),
      });
    }
  }
  const invalid = stateToProject(partly).problems;
  if (invalid.length > 0) {
    const filesIn = (state: ProjectState) =>
      new Set(stateToProject(state).problems.map((problem) => problem.file));
    const known = new Set([...filesIn(before), ...filesIn(whole)]);
    for (const problem of invalid) {
      if (known.has(problem.file)) continue;
      const message = `这个文件会不再合格式：${problem.message}`;
      broken.push({ ...problem, code: "needs-locked-part", message });
    }
  }
  return broken;
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
  if (root === "assets") {
    const asset = entryOf(locks.assets, id);
    const message = `素材“${asset?.name ?? id}”在锁定的轨道上使用，文件里对它的改动没有生效`;
    return { about: `asset ${id}`, where: `assets.${id}`, message };
  }
  if (root === "lock" || root === "libraries") {
    const library = patch.path[2] ?? "";
    const message = `库“${library}”在锁定的轨道上使用，文件里对它的改动没有生效`;
    return { about: `library ${library}`, where: `libraries.${library}`, message };
  }
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
  // What would end up on a locked track: a new clip or join, or one that moves there.
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
    case "joins": {
      const join = entryOf(timeline?.joins, item);
      const message = `${locked(join?.track)}，文件里对衔接转场“${item}”的改动没有生效`;
      return { about: `join ${item}`, where: item, message };
    }
    case "tracks": {
      const message =
        field === "locked"
          ? `${locked(item)}，只有用户自己改的文件能解锁，要解锁请用命令，或者请用户解锁`
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
