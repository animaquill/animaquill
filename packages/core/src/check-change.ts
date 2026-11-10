import {
  Asset,
  Clip,
  ClipSource,
  Duration,
  Id,
  LanguageId,
  Libraries,
  LibrariesLock,
  Locale,
  Marker,
  Notes,
  Overrides,
  ProjectManifest,
  PropertyPath,
  PropertyValue,
  RelativePath,
  SceneManifest,
  Section,
  SoundManifest,
  Time,
  Timeline,
  Track,
  TransitionShape,
  ExtensionName,
} from "@animaquill/schema";
import * as Y from "yjs";
import { z } from "zod";
import { isSourceFile } from "./import-file.ts";
import { isTooLargeSource } from "./source-size.ts";
import { flatParts, isRetired, type Path } from "./structure.ts";

/**
 * Whether what a change writes into a project is something the editor writes, key by key: each key
 * at a place the format has, of the kind that goes there (a map, a text or a value), a value of the
 * type of its field, and nothing too large. A copy that takes changes from elsewhere checks each one
 * with this, as the platform does.
 *
 * Only each key on its own is checked, never how keys go together, such as references from one
 * document to another, or that a timeline has a section: two changes that are fine on their own can
 * come together into a project that is not, and neither of them may be turned away for that, or the
 * editor that made the second one could never sync again. Whole documents are checked where they
 * are written out, see `stateToProject`.
 *
 * Nothing here may turn away what the editor writes: the editor keeps to the same rules where it
 * writes (a file is no larger than `MAX_SOURCE_BYTES`, its path is one of the format), and
 * `pnpm test:platform` checks every change that the tests make against this. Every table is looked
 * up by what is its own, never by what objects have anyway, such as `constructor`.
 */

/** Bytes of one value, as JSON: more than the editor writes into one. */
export const VALUE_LIMIT = 4 * 1024 * 1024;

/** Something a change writes that the editor never does. */
export interface ChangeFault {
  readonly path: string;
  readonly problem: string;
}

type Check = (value: unknown) => boolean;

type Rule =
  /** A level with a map of its own. */
  | { readonly kind: "map" }
  /** A level without a map of its own, see `flat` in structure.ts: only older documents have one. */
  | { readonly kind: "level" }
  /** That a standing level is there, see `standing` in structure.ts. */
  | { readonly kind: "marker" }
  /** The text of a file. */
  | { readonly kind: "text" }
  /** A plain value. */
  | { readonly kind: "value"; readonly check: Check };

const MAP: Rule = { kind: "map" };
const LEVEL: Rule = { kind: "level" };
const MARKER: Rule = { kind: "marker" };
const TEXT: Rule = { kind: "text" };

const by =
  (schema: z.ZodType): Check =>
  (value) =>
    schema.safeParse(value).success;

const valueRule = (check: Check): Rule => ({ kind: "value", check });

/** The schema of a field of an object schema, where it has one. */
const fieldOf = (schema: z.ZodType, field: string): z.ZodType | undefined => {
  const { shape } = schema as unknown as { shape?: Record<string, z.ZodType> };
  return shape && Object.hasOwn(shape, field) ? shape[field] : undefined;
};

const fieldRule = (schema: z.ZodType, field: string): Rule | undefined => {
  const of = fieldOf(schema, field);
  return of ? valueRule(by(of)) : undefined;
};

const isId = by(Id);
const isOrder = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isVersionName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);

/** What tracks of every kind have, as each kind checks it. */
const TRACK_KINDS = (Track as unknown as { options: readonly z.ZodType[] }).options;
const trackField = (field: string): Rule | undefined => {
  if (field === "clips" || field === "joins" || field === "properties") return undefined;
  const schemas = TRACK_KINDS.map((kind) => fieldOf(kind, field)).filter(
    (schema): schema is z.ZodType => schema !== undefined,
  );
  if (schemas.length === 0) return undefined;
  return valueRule((input) => schemas.some((schema) => schema.safeParse(input).success));
};

const EFFECT_FIELDS: ReadonlyMap<string, Check> = new Map<string, Check>([
  ["type", by(ExtensionName)],
  ["enabled", (input) => typeof input === "boolean"],
  ["order", isOrder],
  ["start", by(Time)],
  ["end", by(Time)],
]);

const JOIN_TRANSITION_FIELDS = new Set([
  ...Object.keys((TransitionShape as unknown as { shape: object }).shape),
  "align",
]);
const isJoinTransition: Check = (input) =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).every((key) => JOIN_TRANSITION_FIELDS.has(key));

const NOTE = (Notes as unknown as { shape: { notes: { element: z.ZodType } } }).shape.notes.element;
const LOCALE_STRING = (
  Locale as unknown as { shape: { strings: { def: { valueType: z.ZodType } } } }
).shape.strings.def.valueType;

/** What a timeline can have, by the path in it, from the key after the id of the timeline on. */
function timelineRule(rest: Path): Rule | undefined {
  const [level, id, field, ...more] = rest;
  if (level === undefined) return MAP;
  if (id === undefined) {
    if (["sections", "tracks", "clips", "markers", "overrides"].includes(level)) return MAP;
    if (level === "joins") return LEVEL;
    if (["name", "background", "beatGrid", "mix"].includes(level))
      return fieldRule(Timeline, level);
    return undefined;
  }
  if (level !== "overrides" && !isId(id)) return undefined;
  switch (level) {
    case "sections":
      if (field === undefined) return MAP;
      if (more.length > 0) return undefined;
      return field === "order" ? valueRule(isOrder) : fieldRule(Section, field);
    case "markers":
      if (field === undefined) return MAP;
      return more.length > 0 ? undefined : fieldRule(Marker, field);
    case "tracks":
      if (field === undefined) return MAP;
      if (field === "properties") return propertyRule(more);
      if (more.length > 0) return undefined;
      return field === "order" ? valueRule(isOrder) : trackField(field);
    case "clips":
      if (field === undefined) return MAP;
      if (field === "properties") return propertyRule(more);
      if (field === "effects") {
        const [effect, effectField, ...deeper] = more;
        if (effect === undefined) return LEVEL;
        if (!isId(effect) || deeper.length > 0) return undefined;
        if (effectField === undefined) return LEVEL;
        const check = EFFECT_FIELDS.get(effectField);
        return check ? valueRule(check) : undefined;
      }
      if (more.length > 0) return undefined;
      if (field === "track") return valueRule(isId);
      return fieldRule(Clip, field);
    case "joins":
      if (field === undefined) return LEVEL;
      if (more.length > 0) return undefined;
      if (field === "track" || field === "from" || field === "to") return valueRule(isId);
      return field === "transition" ? valueRule(isJoinTransition) : undefined;
    case "overrides":
      return isVersionName(id) ? versionRule([field, ...more]) : undefined;
    default:
      return undefined;
  }
}

function propertyRule(rest: Path): Rule | undefined {
  const [property, ...more] = rest;
  if (property === undefined) return LEVEL;
  if (more.length > 0 || !PropertyPath.safeParse(property).success) return undefined;
  return valueRule(by(PropertyValue));
}

/** A change of a version, see `Change` in the format: a value, and the one of the master it was made on. */
const change = (schema: z.ZodType): Rule =>
  valueRule(by(z.strictObject({ value: schema, base: schema.optional() })));

/** What a version can change of a section, and of a clip: of the type of what it changes. */
const SECTION_CHANGES: Rule = valueRule(
  by(z.strictObject({ duration: z.strictObject({ value: Duration, base: Duration.optional() }) })),
);
const CLIP_CHANGES: ReadonlyMap<string, Rule> = new Map([
  ["start", change(Time)],
  ["duration", change(Duration)],
  ["offset", change(Time)],
  ["hidden", change(z.boolean())],
  ["source", change(ClipSource)],
]);
const PROPERTY_CHANGE = change(PropertyValue);

/** What a version of a timeline changes, see `Overrides`: each change a value of its own. */
function versionRule(rest: readonly (string | undefined)[]): Rule | undefined {
  const [level, id, field, property, ...more] = rest;
  if (level === undefined) return LEVEL;
  if (level === "scope") return id === undefined ? fieldRule(Overrides, "scope") : undefined;
  if (level === "sections") {
    if (id === undefined) return LEVEL;
    return isId(id) && field === undefined ? SECTION_CHANGES : undefined;
  }
  if (level !== "clips") return undefined;
  if (id === undefined) return LEVEL;
  if (!isId(id)) return undefined;
  if (field === undefined) return LEVEL;
  if (field === "properties") {
    if (property === undefined) return LEVEL;
    return more.length === 0 && PropertyPath.safeParse(property).success
      ? PROPERTY_CHANGE
      : undefined;
  }
  return property === undefined ? CLIP_CHANGES.get(field) : undefined;
}

/** What the format has at a path of the project, or undefined where it has nothing. */
export function ruleAt(path: Path): Rule | undefined {
  const [top, key, ...rest] = path;
  switch (top) {
    case "manifest":
      if (key === undefined) return MAP;
      return rest.length === 0 ? fieldRule(ProjectManifest, key) : undefined;
    case "assets":
      if (key === undefined) return LEVEL;
      return rest.length === 0 && isId(key) ? valueRule(by(Asset)) : undefined;
    case "notes":
      if (key === undefined) return LEVEL;
      return rest.length === 0 && isId(key) ? valueRule(by(NOTE)) : undefined;
    case "libraries":
      return key === undefined ? valueRule(by(Libraries)) : undefined;
    case "lock":
      return key === undefined ? valueRule(by(LibrariesLock)) : undefined;
    case "scenes":
      if (key === undefined) return MAP;
      return rest.length === 0 && isId(key) ? valueRule(by(SceneManifest)) : undefined;
    case "sounds":
      if (key === undefined) return MAP;
      return rest.length === 0 && isId(key) ? valueRule(by(SoundManifest)) : undefined;
    case "files":
      if (key === undefined) return MAP;
      if (rest.length > 0) return undefined;
      return isProjectSource(key) ? TEXT : undefined;
    case "locales": {
      if (key === undefined) return MAP;
      if (!LanguageId.safeParse(key).success) return undefined;
      const [name, ...deeper] = rest;
      if (name === undefined) return MARKER;
      return deeper.length === 0 && name.length > 0 ? valueRule(by(LOCALE_STRING)) : undefined;
    }
    case "timelines":
      if (key === undefined) return MAP;
      return isId(key) ? timelineRule(rest) : undefined;
    default:
      return undefined;
  }
}

/** Whether a path is one of a file of code that the format has, as the editor writes it too. */
export const isProjectSource = (path: string): boolean =>
  RelativePath.safeParse(path).success && isSourceFile(path);

/**
 * Whether the key of a clip is its list of effects from before they sat flat (2026-11-09): what a
 * page that is still open from before writes, which nothing reads any more. See structure.ts.
 */
const isOldEffects = (path: Path): boolean =>
  path.length === 5 && path[0] === "timelines" && path[2] === "clips" && path[4] === "effects";

const isPlain = (raw: unknown) => !(raw instanceof Y.AbstractType);

/** How many bytes a value takes as JSON, up to a bit more than the limit. */
const sizeOf = (raw: unknown): number => {
  try {
    return JSON.stringify(raw)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** The path of a key of a map at `path` in the document, as the project has it. */
const childPath = (path: Path, key: string): Path => {
  const parts = flatParts(path, key);
  return parts ? [...path, ...parts] : [...path, key];
};

/**
 * Checks what a change wrote at `path` (a place of the project, as `ProjectState` has it), `raw`
 * as Yjs has it: a map with all that is in it, a text, or a value. Resolves to the first thing that
 * is not as the editor writes it, or undefined.
 */
export function checkWritten(path: Path, raw: unknown): ChangeFault | undefined {
  const at = path.join("/");
  if (path.includes("__proto__")) return { path: at, problem: "a key no object may have" };
  if (isRetired(path) || (isOldEffects(path) && isPlain(raw))) {
    // Gone from the format: a page that is still open from before can write it, the way it was,
    // and nothing reads it. Documents from then have it too. Whatever it is, it only is not large.
    const value = raw instanceof Y.AbstractType ? (raw.toJSON() as unknown) : raw;
    return sizeOf(value) > VALUE_LIMIT
      ? { path: at, problem: "a value that is too large" }
      : undefined;
  }
  const rule = ruleAt(path);
  if (!rule) return { path: at, problem: "no place of the format" };
  switch (rule.kind) {
    case "map":
    case "level":
    case "marker": {
      if (rule.kind === "marker" && isPlain(raw)) {
        const isEmpty =
          typeof raw === "object" &&
          raw !== null &&
          !Array.isArray(raw) &&
          Object.keys(raw).length === 0;
        return isEmpty ? undefined : { path: at, problem: "not what says that it is there" };
      }
      if (!(raw instanceof Y.Map)) return { path: at, problem: "not a map" };
      for (const [key, child] of (raw as Y.Map<unknown>).entries()) {
        const fault = checkWritten(childPath(path, key), child);
        if (fault) return fault;
      }
      return undefined;
    }
    case "text":
      if (!(raw instanceof Y.Text)) return { path: at, problem: "not a text" };
      return isTooLargeSource(raw.toString())
        ? { path: at, problem: "a text that is too long" }
        : undefined;
    case "value":
      if (!isPlain(raw)) return { path: at, problem: "not a plain value" };
      if (sizeOf(raw) > VALUE_LIMIT) return { path: at, problem: "a value that is too large" };
      return rule.check(raw) ? undefined : { path: at, problem: "not a value of its field" };
  }
}

/** Every key of a whole project, as `checkWritten` checks what a change writes. */
export function checkWhole(doc: Y.Doc): ChangeFault | undefined {
  for (const [key, raw] of doc.getMap<unknown>("project").entries()) {
    const fault = checkWritten(childPath([], key), raw);
    if (fault) return fault;
  }
  return undefined;
}
