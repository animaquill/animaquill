import {
  Assets,
  CURRENT_FORMAT_VERSION,
  Libraries,
  LibrariesLock,
  Locale,
  Notes,
  Overrides,
  ProjectManifest,
  RelativePath,
  SceneManifest,
  SoundManifest,
  Timeline,
  cannotHaveKeys,
  documentSchema,
  parseDocument,
  retiredFadesIn,
  type Asset,
  type Problem,
  type PropertyValue,
} from "@animaquill/schema";
import { z } from "zod";
import { CommandError, Draft } from "./draft.ts";
import {
  entryOf,
  orderedSections,
  orderedTracks,
  placedAssets,
  timelineToState,
  type ProjectState,
  type TimelineState,
} from "./model.ts";
import { USER } from "./origin.ts";
import { anotherFileIsHere, writeAssets } from "./places.ts";
import { isTooLargeSource } from "./source-size.ts";
import { deepEqual } from "./patch.ts";
import type { Path } from "./structure.ts";

/** Only the person at the editor is one: an AI task, a tool or anything else is not. */
export const isUser = (origin: string) => origin === USER;

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
  /** What people should know about a file that came in, such as fades it still says the old way. */
  readonly notices: readonly Problem[];
}

/**
 * A file that changed outside of the editor, for example written by an AI tool. It goes through
 * the same checks as anything else and becomes a change to the objects that really differ, so it
 * can be undone and merged like an edit. A file that is not valid changes nothing. Locks on tracks
 * are only there for people at the editor, so a file changes what is on them like anything else.
 */
export function planFileImport(draft: Draft, path: string, text: string): FileImport {
  const problems = planDocument(draft, path, text);
  if (problems.length > 0) return { problems, notices: [] };
  return { problems, notices: [retiredFadesIn(path, text) ?? []].flat() };
}

/** What a document means to the project, where the project keeps it, and what is wrong with it. */
export interface DocumentReading {
  /** Where it goes. Undefined for a file that is no document of the project. */
  readonly at?: Path;
  readonly value?: unknown;
  /** What is wrong with it. Nothing of it can come in then. */
  readonly problems: readonly Problem[];
}

/**
 * Reads a document the way a file that comes in is read: with every check, against what the project
 * has, which lets a document keep what the project already has. See `planDocument`.
 */
export function readDocument(
  state: ProjectState,
  origin: string,
  path: string,
  text: string,
): DocumentReading {
  const problems: Problem[] = [];
  const read = (at: Path, value: unknown): DocumentReading => ({ at, value, problems });

  const timeline = /^timelines\/([^/]+)\/timeline\.json$/.exec(path)?.[1];
  const overrides = /^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/.exec(path);
  const scene = /^scenes\/([^/]+)\/scene\.json$/.exec(path)?.[1];
  const sound = /^sounds\/([^/]+)\/sound\.json$/.exec(path)?.[1];
  const locale = /^locales\/([^/]+)\.json$/.exec(path)?.[1];

  if (path === "animaquill.json") {
    const value = parsed(path, text, ProjectManifest, problems);
    if (!value) return { problems };
    if (value.formatVersion !== CURRENT_FORMAT_VERSION) {
      throw new CommandError({ code: "format-mismatch", params: {} });
    }
    if (!isUser(origin) && !deepEqual(value.tags, state.manifest.tags)) {
      throw new CommandError({ code: "user-only", params: {} });
    }
    return read(["manifest"], value);
  }
  if (path === "assets.json") {
    const value = parsed(path, text, Assets, problems);
    return value ? read(["assets"], value.assets) : { problems };
  }
  if (path === "libraries.json") {
    const value = parsed(path, text, Libraries, problems);
    return value ? read(["libraries"], value) : { problems };
  }
  if (path === "libraries.lock.json") {
    const value = parsed(path, text, LibrariesLock, problems);
    return value ? read(["lock"], value) : { problems };
  }
  if (path === "notes.json") {
    const value = parsed(path, text, Notes, problems);
    if (!value) return { problems };
    return read(["notes"], Object.fromEntries(value.notes.map((note) => [note.id, note])));
  }
  if (timeline) {
    const value = parsed(path, text, Timeline, problems);
    if (!value) return { problems };
    const current = entryOf(state.timelines, timeline);
    const next = timelineToState(value, new Map(Object.entries(current?.overrides ?? {})));
    checkTimelineKeys(path, next, current, problems);
    return read(["timelines", timeline], current ? keepOrder(current, next) : next);
  }
  if (overrides) {
    const [, owner = "", name = ""] = overrides;
    const value = parsed(path, text, Overrides, problems);
    if (!value) return { problems };
    const target = entryOf(state.timelines, owner);
    if (!target) {
      const message = `没有这条时间轴：${owner}`;
      problems.push({ severity: "error", code: "timeline-missing", file: path, path: "", message });
      return { problems };
    }
    checkOverrideKeys(path, value, entryOf(target.overrides, name), problems);
    return read(["timelines", owner, "overrides", name], value);
  }
  if (scene) {
    const value = parsed(path, text, SceneManifest, problems);
    return value ? read(["scenes", scene], value) : { problems };
  }
  if (sound) {
    const value = parsed(path, text, SoundManifest, problems);
    return value ? read(["sounds", sound], value) : { problems };
  }
  if (locale) {
    const value = parsed(path, text, Locale, problems);
    return value ? read(["locales", locale], value.strings) : { problems };
  }
  return { problems };
}

/** Plans what a valid file changes, and says what is wrong with one that is not. */
export function planDocument(draft: Draft, path: string, text: string): readonly Problem[] {
  if (isSourceFile(path)) {
    // What the format has, as everything that writes a file keeps to: a platform takes no other.
    if (!RelativePath.safeParse(path).success) {
      const message = `文件名不能这样写：${path}。要写成项目内的相对路径，不能用 ..、反斜杠或绝对路径`;
      return [{ severity: "error", code: "invalid-name", file: path, message }];
    }
    if (isTooLargeSource(text)) {
      return [
        {
          severity: "error",
          code: "file-too-large",
          file: path,
          message: "代码文件不能超过 8 MiB",
        },
      ];
    }
    if (draft.state.files[path] !== text) draft.setText(["files", path], text);
    return [];
  }
  const { at, value, problems } = readDocument(draft.state, draft.origin, path, text);
  if (problems.length > 0 || !at) return problems;
  if (at[0] !== "assets") {
    draft.replace(at, value);
    return problems;
  }
  // A file has where each file of an asset is kept in the asset, a project also next to it. Another
  // file of an asset is only here, unless the file says where it is, see `anotherFileIsHere`.
  const known = placedAssets(draft.state);
  const wanted = Object.fromEntries(
    Object.entries(value as Readonly<Record<string, Asset>>).map(([id, asset]) => [
      id,
      anotherFileIsHere(entryOf(known, id), asset),
    ]),
  );
  writeAssets(draft, wanted);
  return problems;
}
