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
import { CommandError, type Draft } from "./draft.ts";
import {
  entryOf,
  orderedSections,
  orderedTracks,
  timelineToState,
  type TimelineState,
} from "./model.ts";
import { deepEqual } from "./patch.ts";

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

/**
 * A file that changed outside of the editor, for example written by an AI tool. It goes through
 * the same checks as anything else and becomes a change to the objects that really differ, so it
 * can be undone and merged like an edit. A file that is not valid changes nothing.
 */
export function planFileImport(draft: Draft, path: string, text: string): readonly Problem[] {
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
