import {
  Color,
  Id,
  ProjectManifest,
  Time,
  ZERO,
  compare,
  formatTime,
  parseTime,
} from "@animaquill/schema";
import { z } from "zod";
import { timelineOf, timelinePath } from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import { formatFailure } from "./failures.ts";
import { entryOf, timelineLength, type ProjectState } from "./model.ts";

/**
 * What the project properties change of animaquill.json and of the timelines as a whole
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5): what the project says about
 * itself, its formats and languages, its cover, and the background and order of timelines. Each
 * writes its field as a whole, and checks the manifest it makes before anything is written.
 */

const manifestPath = (field: string) => ["manifest", field];

/** The manifest with these fields, as the format takes it, or the first thing it says is wrong. */
function checkManifest(state: ProjectState, fields: Partial<ProjectManifest>): void {
  const result = ProjectManifest.safeParse({ ...state.manifest, ...fields });
  if (!result.success) formatFailure(result.error);
}

/** A field of the manifest written, or taken away where it would say nothing. */
function setField(draft: Draft, field: string, value: unknown): void {
  if (value === undefined) {
    if ((draft.state.manifest as Record<string, unknown>)[field] !== undefined)
      draft.delete(manifestPath(field));
  } else draft.set(manifestPath(field), value);
}

export const DescriptionSet = z.strictObject({ description: z.string() });

export function setDescription(draft: Draft, { description }: z.output<typeof DescriptionSet>) {
  setField(draft, "description", description.trim() === "" ? undefined : description);
}

const Credit = z.strictObject({ role: z.string(), name: z.string().trim().min(1) });
export const CreditsSet = z.strictObject({ credits: z.array(Credit) });

export function setCredits(draft: Draft, { credits }: z.output<typeof CreditsSet>) {
  setField(draft, "credits", credits.length === 0 ? undefined : credits);
}

/** Where a version is about, as its scope says, or its name where two people left it without. */
function scopeOf(
  name: string,
  scope: { language?: string | undefined; format?: string | undefined } | undefined,
): { language?: string | undefined; format?: string | undefined } {
  if (scope && (scope.language !== undefined || scope.format !== undefined)) return scope;
  const [kind, first, second] = name.split(".");
  if (kind === "language") return { language: first };
  if (kind === "format") return { format: first };
  if (kind === "version") return { language: first, format: second };
  return {};
}

/** A version of a timeline, as the file it is written to. */
const versionFile = (timeline: string, version: string) =>
  `timelines/${timeline}/overrides/${version}.json`;

/**
 * The versions that are about a language or a format, as the files they are in: what goes along
 * when the language or the format goes, see `project.setLanguages` and `project.setFormats`.
 */
export function versionsAbout(
  state: ProjectState,
  about: { readonly language?: string; readonly format?: string },
): readonly { readonly timeline: string; readonly version: string; readonly file: string }[] {
  const found: { timeline: string; version: string; file: string }[] = [];
  for (const [timeline, { overrides }] of Object.entries(state.timelines)) {
    for (const [version, override] of Object.entries(overrides)) {
      const scope = scopeOf(version, override.scope);
      if (
        (about.language !== undefined && scope.language === about.language) ||
        (about.format !== undefined && scope.format === about.format)
      )
        found.push({ timeline, version, file: versionFile(timeline, version) });
    }
  }
  return found.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function removeVersions(
  draft: Draft,
  about: { readonly language?: string; readonly format?: string },
): string[] {
  const removed: string[] = [];
  for (const { timeline, version, file } of versionsAbout(draft.state, about)) {
    draft.delete([...timelinePath(timeline), "overrides", version]);
    removed.push(file);
  }
  return removed;
}

/** What went along, as files: nothing where nothing did. */
const filesRemoved = (files: readonly string[]) =>
  files.length > 0 ? { filesRemoved: files } : undefined;

export const FilesRemoved = z.strictObject({ filesRemoved: z.array(z.string()).readonly() });

export const FormatsSet = z.strictObject({ formats: ProjectManifest.shape.formats });

/**
 * The formats, the first the master. A format that is no longer there takes the versions about it
 * along, in the same step.
 */
export function setFormats(draft: Draft, { formats }: z.output<typeof FormatsSet>) {
  checkManifest(draft.state, { formats });
  const kept = new Set(formats.map((format) => format.id));
  const removed = draft.state.manifest.formats
    .filter((format) => !kept.has(format.id))
    .flatMap((format) => removeVersions(draft, { format: format.id }));
  draft.set(manifestPath("formats"), formats);
  return filesRemoved(removed);
}

export const LanguagesSet = z.strictObject({ languages: ProjectManifest.shape.languages });

/**
 * The languages, the first the master. A language that is no longer there takes its strings and
 * the versions about it along, in the same step.
 */
export function setLanguages(draft: Draft, { languages }: z.output<typeof LanguagesSet>) {
  checkManifest(draft.state, { languages });
  const kept = new Set(languages.map((language) => language.id));
  const removed: string[] = [];
  for (const { id } of draft.state.manifest.languages) {
    if (kept.has(id)) continue;
    removed.push(...removeVersions(draft, { language: id }));
    if (entryOf(draft.state.locales, id) !== undefined) {
      draft.delete(["locales", id]);
      removed.push(`locales/${id}.json`);
    }
  }
  draft.set(manifestPath("languages"), languages);
  return filesRemoved(removed.toSorted());
}

export const CoverSet = z.strictObject({
  cover: z.strictObject({ timeline: Id, time: Time }).nullable(),
});

/** Which frame stands for the project: a moment of one of its timelines, or none chosen. */
export function setCover(draft: Draft, { cover }: z.output<typeof CoverSet>) {
  if (cover === null) return setField(draft, "cover", undefined);
  const timeline = timelineOf(draft, cover.timeline);
  if (!draft.state.manifest.timelines.includes(cover.timeline))
    fail("not-found", { kind: "timeline", id: cover.timeline });
  const length = timelineLength(timeline);
  const time = parseTime(cover.time);
  // The moment has to show something: before the end, or the start of an empty timeline.
  if (compare(time, length) >= 0 && compare(time, ZERO) !== 0)
    fail("invalid-value", {
      rule: "time-outside",
      path: "cover.time",
      time: cover.time,
      length: formatTime(length),
    });
  draft.set(manifestPath("cover"), cover);
}

export const BackgroundSet = z.strictObject({ timeline: Id, background: Color.nullable() });

/** What shows where nothing covers the picture: black where none is written. */
export function setBackground(draft: Draft, params: z.output<typeof BackgroundSet>) {
  const { timeline, background } = params;
  const target = timelineOf(draft, timeline);
  const path = [...timelinePath(timeline), "background"];
  if (background === null) {
    if (target.background !== undefined) draft.delete(path);
  } else draft.set(path, background);
}

export const DefaultSet = z.strictObject({ timeline: Id });

/** The timeline that opens first: the first of the manifest's list, the others keep their order. */
export function setDefault(draft: Draft, { timeline }: z.output<typeof DefaultSet>) {
  const { timelines } = draft.state.manifest;
  if (!timelines.includes(timeline) || !entryOf(draft.state.timelines, timeline))
    fail("not-found", { kind: "timeline", id: timeline });
  if (timelines[0] === timeline) return;
  draft.set(manifestPath("timelines"), [timeline, ...timelines.filter((id) => id !== timeline)]);
}
