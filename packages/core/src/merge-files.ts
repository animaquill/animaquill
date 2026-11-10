import {
  Id,
  LanguageId,
  MANIFEST_FILE,
  RelativePath,
  retiredFadesIn,
  type Libraries,
  type Overrides,
  type Problem,
} from "@animaquill/schema";
import type { z } from "zod";
import { CommandError, Draft } from "./draft.ts";
import { isSourceFile, isUser, readDocument } from "./import-file.ts";
import { linesOf, mergeText, type LineRange } from "./merge-text.ts";
import {
  entryOf,
  orderedSections,
  orderedTracks,
  stateToProject,
  type ProjectState,
  type TimelineState,
} from "./model.ts";
import { USER } from "./origin.ts";
import { deepEqual, getIn, settled, type Patch } from "./patch.ts";
import { isNoneOfIt } from "./read-folder.ts";
import { danglingAt } from "./references.ts";
import { isTooLargeSource } from "./source-size.ts";
import { assetsNamedIn, codeUsingAsset } from "./scene-plan.ts";
import { isContainer, isStanding, type Path } from "./structure.ts";

/** A file of the project folder that changed, as whoever looks after the folder sees it. */
export interface FileChange {
  /** From the top of the project, with forward slashes. */
  readonly path: string;
  /**
   * What the file held when the editor last wrote or read it: what was changed outside is the
   * difference from this. Undefined when it was not there.
   */
  readonly base: string | undefined;
  /** What it holds now. Undefined when it is gone. */
  readonly text: string | undefined;
}

/**
 * What a file of the folder outside of a batch holds: its base, since nothing changed it. Undefined
 * when the folder does not have it. A merge asks this only about what it has to know, such as
 * whether the folder still has a scene that the editor took away and has not written out yet.
 */
export type BaseOf = (path: string) => string | undefined;

/**
 * What texts of the documents of a project mean to it, by file, the last few of each: what a merge
 * read, and what the project was written as. The base of a file is mostly one of those, which then
 * needs no reading again. See `remember`.
 */
export type MergeMemory = Map<
  string,
  readonly { readonly text: string; readonly value: unknown }[]
>;

/** How many texts of one file a memory keeps: what was read, and what was written. */
const MOST_REMEMBERED = 2;

function remember(memory: MergeMemory | undefined, path: string, text: string, value: unknown) {
  if (!memory) return;
  const others = (memory.get(path) ?? []).filter((known) => known.text !== text);
  memory.set(path, [{ text, value }, ...others].slice(0, MOST_REMEMBERED));
}

/**
 * Remembers what the documents of a project were written as, so that a merge whose base is one of
 * these texts reads only what changed in the folder. `read` is what the written documents are to the
 * project, see `projectToState`, which is what reading them back gives, without reading them again.
 */
export function rememberWritten(
  memory: MergeMemory,
  read: ProjectState,
  files: ReadonlyMap<string, string>,
): void {
  for (const [path, text] of files) {
    const place = placeOf(path);
    if (!place || isProblem(place) || place.kind === "source") continue;
    const value = valueIn(read, place);
    if (value !== undefined) remember(memory, path, text, settled(place.at, value));
  }
}

export type MergedFileStatus =
  /** What changed in the file is in the project now, as far as it could come in. */
  | "merged"
  /** Nothing of the file came in, and it must not be written over: it waits for people. */
  | "blocked"
  /** A file the project does not keep. */
  | "ignored";

/** What became of a file, and what to remember about it from now on. */
export interface MergedFile {
  readonly path: string;
  readonly status: MergedFileStatus;
  /**
   * The base of the file from now on: what the file holds, apart from a blocked file, which keeps
   * its old base, so that what changed in it still counts as changed outside.
   */
  readonly base: string | undefined;
  /**
   * The project holds something else than the file now, so the file is to be written again: the
   * editor kept its own side of something, or had changes there that were not written yet.
   */
  readonly rewrite: boolean;
}

/** Something both sides changed, each in its own way. What the editor had stays. */
export interface MergeConflict {
  readonly file: string;
  /** Where in the project. */
  readonly path: Path;
  /** For code: the lines in the merged text that are the editor's, where the file had others. */
  readonly lines?: LineRange;
  /**
   * What the folder has there, which did not come in, so that it can be kept before the file is
   * written again: a value the way the project has it, the folder's lines of code, or its whole
   * file of code. Undefined where the folder took it away.
   */
  readonly theirs?: unknown;
}

export interface FileMerge {
  readonly files: readonly MergedFile[];
  /** What people should know: conflicts, what waits and why. */
  readonly problems: readonly Problem[];
  readonly conflicts: readonly MergeConflict[];
  /** What only a person can change, which stays as it is. */
  readonly kept: readonly Path[];
  /** What the folder took away that is still in use, which stays until people decide. */
  readonly held: readonly Path[];
  /** Why nothing of the batch comes in. */
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly problems: readonly Problem[];
  };
}

/** What a merge has to go by besides the batch. */
export interface MergeContext {
  /** See `BaseOf`. Without it, whatever could be in the folder counts as there. */
  readonly baseOf: BaseOf | undefined;
  readonly memory?: MergeMemory;
}

/** The kinds of files the project keeps, in the order they go into it. See `rankOf`. */
const RANKS = {
  manifest: 0,
  assets: 1,
  libraries: 2,
  lock: 3,
  notes: 4,
  locale: 5,
  scene: 6,
  sound: 7,
  source: 8,
  timeline: 9,
  overrides: 10,
} as const;

type Kind = keyof typeof RANKS;

/** Where the project keeps what a file holds. */
interface Place {
  readonly kind: Kind;
  readonly at: Path;
}

const FIXED: Readonly<Record<string, Place>> = {
  [MANIFEST_FILE]: { kind: "manifest", at: ["manifest"] },
  "assets.json": { kind: "assets", at: ["assets"] },
  "libraries.json": { kind: "libraries", at: ["libraries"] },
  "libraries.lock.json": { kind: "lock", at: ["lock"] },
  "notes.json": { kind: "notes", at: ["notes"] },
};

/** Means something to every object, so it is no name of anything, see store.ts. */
const UNSAFE_KEY = "__proto__";

/**
 * Where the project keeps what a file holds, undefined for a file that it does not keep, or the
 * problem with a name that cannot be one of its ids. Names in paths become ids, so they follow the
 * same rules as when a project is read.
 */
function placeOf(path: string): Place | Problem | undefined {
  if (
    !RelativePath.safeParse(path).success ||
    isNoneOfIt(path) ||
    path.split("/").includes(UNSAFE_KEY)
  ) {
    return undefined;
  }
  if (Object.hasOwn(FIXED, path)) return FIXED[path];
  const byName = (
    pattern: RegExp,
    rule: z.ZodType<string>,
    place: (name: string, rest: string) => Place,
  ): Place | Problem | undefined => {
    const [, name = "", rest = ""] = pattern.exec(path) ?? [];
    if (!name) return undefined;
    if (rule.safeParse(name).success && !rest.startsWith(".")) return place(name, rest);
    const message = `这个名字不能用：${name}。文件夹名就是 ID，只能用英文字母、数字、下划线和连字符`;
    return { severity: "error", code: "invalid-name", file: path, message };
  };
  return (
    byName(/^timelines\/([^/]+)\/timeline\.json$/, Id, (id) => ({
      kind: "timeline",
      at: ["timelines", id],
    })) ??
    byName(/^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/, Id, (id, name) => ({
      kind: "overrides",
      at: ["timelines", id, "overrides", name],
    })) ??
    byName(/^scenes\/([^/]+)\/scene\.json$/, Id, (id) => ({ kind: "scene", at: ["scenes", id] })) ??
    byName(/^sounds\/([^/]+)\/sound\.json$/, Id, (id) => ({ kind: "sound", at: ["sounds", id] })) ??
    byName(/^locales\/([^/]+)\.json$/, LanguageId, (id) => ({
      kind: "locale",
      at: ["locales", id],
    })) ??
    (isSourceFile(path) ? { kind: "source", at: ["files", path] } : undefined)
  );
}

const isProblem = (value: Place | Problem): value is Problem => "severity" in value;

/** The file a place in the project is kept in. */
function fileOf(path: Path): string {
  const [root = "", id = "", level, name = ""] = path;
  switch (root) {
    case "manifest":
      return MANIFEST_FILE;
    case "assets":
      return "assets.json";
    case "libraries":
      return "libraries.json";
    case "lock":
      return "libraries.lock.json";
    case "notes":
      return "notes.json";
    case "scenes":
      return `scenes/${id}/scene.json`;
    case "sounds":
      return `sounds/${id}/sound.json`;
    case "locales":
      return `locales/${id}.json`;
    case "files":
      return id;
    default:
      return level === "overrides" && path.length > 3
        ? `timelines/${id}/overrides/${name}.json`
        : `timelines/${id}/timeline.json`;
  }
}

const OF_ANOTHER_KIND = " of another kind";

/** Says in words what a link from `danglingAt` comes to. */
function linkInWords(link: string): string {
  const [from = "", rest = ""] = link.split(" -> ");
  const isOfAnotherKind = rest.endsWith(OF_ANOTHER_KIND);
  const to = isOfAnotherKind ? rest.slice(0, -OF_ANOTHER_KIND.length) : rest;
  const nameOf = (path: string) => {
    const parts = path.split("/");
    const what = { clips: "片段", joins: "衔接转场", tracks: "轨道" }[parts.at(-2) ?? ""];
    return what ? `${what}“${parts.at(-1)}”` : `“${path}”`;
  };
  if (to === "its kind") return `${nameOf(from)}会带着它这一种轨道没有的设置`;
  if (to.includes("/tracks/")) {
    const where = isOfAnotherKind ? "放不下它的" : "已经没有的";
    return `${nameOf(from)}会留在${where}${nameOf(to)}上`;
  }
  return `${nameOf(from)}会指向已经没有的${nameOf(to)}`;
}

/** Where a link from `danglingAt` starts, and what it points at. */
const sidesOf = (link: string): readonly [Path, string] => {
  const [from = "", to = ""] = link.split(" -> ");
  return [from.split("/"), to];
};

type Timeline = Omit<TimelineState, "overrides">;

/** A timeline the way its own file has it: what its versions change is in files of their own. */
function withoutVersions(timeline: TimelineState | undefined): Timeline | undefined {
  if (!timeline) return undefined;
  const { overrides: _overrides, ...rest } = timeline;
  return rest;
}

/** What the project holds of a file. */
const valueIn = (state: ProjectState, { kind, at }: Place): unknown =>
  kind === "timeline"
    ? withoutVersions(entryOf(state.timelines, at[1] as string))
    : getIn(state, at);

/** Only so that a version can be read when its timeline is not there. */
const NO_TIMELINE: TimelineState = {
  name: "",
  sections: {},
  tracks: {},
  clips: {},
  markers: {},
  overrides: {},
};

const isTooLarge = isTooLargeSource;

/**
 * Editors on Windows like to put a byte order mark in front of a document, which JSON does not
 * allow, see readFolder. Code keeps it: it is what the file holds.
 */
const unmarked = ({ kind }: Place, text: string) =>
  kind === "source" ? text : text.replace(/^\uFEFF/, "");

interface Reading {
  readonly value?: unknown;
  readonly problems: readonly Problem[];
}

/**
 * What a text means to the project. It is read the way a file that comes in is, with the same
 * checks, and against what the project has, which lets a document keep what the project already has.
 */
function readText(state: ProjectState, path: string, place: Place, text: string): Reading {
  if (place.kind === "source") {
    if (!isTooLarge(text)) return { value: text, problems: [] };
    const message = "代码文件不能超过 8 MiB";
    return { problems: [{ severity: "error", code: "file-too-large", file: path, message }] };
  }
  const owner = place.at[1] as string;
  const context =
    place.kind === "overrides" && !entryOf(state.timelines, owner)
      ? { ...state, timelines: { ...state.timelines, [owner]: NO_TIMELINE } }
      : state;
  const { value, problems } = readDocument(context, USER, path, text);
  if (problems.length > 0) return { problems };
  // The way the project will hold it, see `settled`.
  const held = settled(place.at, value);
  return {
    value: place.kind === "timeline" ? withoutVersions(held as TimelineState) : held,
    problems,
  };
}

/** A text that cannot be read says nothing about what is in it: it counts as not there. */
function readQuietly(state: ProjectState, path: string, place: Place, text: string): Reading {
  try {
    return readText(state, path, place, text);
  } catch (error) {
    if (error instanceof CommandError) return { problems: [UNREADABLE] };
    throw error;
  }
}

/**
 * Only a text that names what was retired, or has an escape that could spell it, can still have it:
 * the others need not be read once more.
 */
const mayBeRetired = (text: string) => /fadeIn|fadeOut|transitions|\\u/.test(text);

/** What stands for a text that cannot be read, which counts as something that could be there. */
const UNREADABLE: Problem = { severity: "error", code: "unreadable", file: "", message: "" };

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keysOf = (value: unknown) => (isPlain(value) ? Object.keys(value) : []);
const fieldOf = (value: unknown, key: string) =>
  isPlain(value) && Object.hasOwn(value, key) ? value[key] : undefined;

const OBJECTS = new Set(["sections", "tracks", "clips", "joins", "markers"]);

/**
 * Something whose fields belong together: the manifest, a timeline, and what is on one. When one side
 * takes it away and the other changed it, or both bring one of the same id, it is merged as a whole,
 * as anything else would leave a piece of one. Everything else with levels of its own is a collection
 * of things that each stand on their own: assets, a version, the strings of a language.
 */
const isWhole = (path: Path) =>
  (path.length === 1 && path[0] === "manifest") ||
  (path[0] === "timelines" &&
    (path.length === 2 || (path.length === 4 && OBJECTS.has(path[2] as string))));

const FIELDED = new Set(["assets", "notes", "scenes", "sounds"]);

/**
 * One value in the document whose fields still merge one by one, like those of a whole: an asset,
 * a note, what a scene or a sound is. It is written as one value all the same.
 */
const isFielded = (path: Path) => path.length === 2 && FIELDED.has(path[0] as string);

/** A place where both sides changed one value differently, and what the folder has there. */
interface Found {
  readonly path: Path;
  readonly theirs: unknown;
}

/**
 * A three-way merge as fine-grained as the document is, see structure.ts: what only one side changed
 * comes from that side, and where both changed one value differently, `ours` stays and the place
 * goes into `conflicts`.
 */
function merge3(
  path: Path,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  conflicts: Found[],
): unknown {
  if (ours === theirs || deepEqual(base, theirs)) return ours;
  return mergeChanged(path, base, ours, theirs, conflicts);
}

/** See `merge3`, for what the folder changed. */
function mergeChanged(
  path: Path,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  conflicts: Found[],
): unknown {
  const values = [base, ours, theirs];
  const goesDeeper =
    isWhole(path) || isFielded(path)
      ? values.every(isPlain)
      : isContainer(path) && values.every((value) => value === undefined || isPlain(value));
  if (!goesDeeper) {
    if (deepEqual(ours, theirs)) return ours;
    if (deepEqual(base, ours)) return theirs;
    conflicts.push({ path, theirs });
    return ours;
  }
  return mergeEntries(path, base, ours, theirs, conflicts);
}

/**
 * What has levels goes down, also where only the folder changed it: what did not change then stays
 * what the editor has, the same objects, which is quick to tell apart from what did. The levels in
 * `right away` go down without looking at them as a whole first, which a timeline has thousands of
 * things in: each of those is looked at on its own anyway.
 */
function mergeEntries(
  path: Path,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  conflicts: Found[],
  rightAway: ReadonlySet<string> = NONE,
): Plain | undefined {
  const merged: Plain = {};
  const has = (value: unknown, key: string) => isPlain(value) && Object.hasOwn(value, key);
  const take = (key: string) => {
    const [was, mine, theirsNow] = [fieldOf(base, key), fieldOf(ours, key), fieldOf(theirs, key)];
    const isLevel = (value: unknown) => value === undefined || isPlain(value);
    let value: unknown;
    if (mine === theirsNow) value = mine;
    else if (rightAway.has(key) && [was, mine, theirsNow].every(isLevel)) {
      value = mergeEntries([...path, key], was, mine, theirsNow, conflicts);
    } else if (deepEqual(was, theirsNow)) value = mine;
    else value = mergeChanged([...path, key], was, mine, theirsNow, conflicts);
    if (value !== undefined) merged[key] = value;
  };
  for (const key of keysOf(base)) take(key);
  for (const key of keysOf(ours)) if (!has(base, key)) take(key);
  for (const key of keysOf(theirs)) if (!has(base, key) && !has(ours, key)) take(key);
  // A standing level can be there without anything in it, and that it is there is a change too.
  if (isStanding(path) && Object.keys(merged).length === 0) {
    const [inBase, inOurs, inTheirs] = [base, ours, theirs].map((value) => value !== undefined);
    const stays = inBase === inTheirs ? inOurs : inBase === inOurs ? inTheirs : inOurs;
    return stays ? merged : undefined;
  }
  return merged;
}

const NONE: ReadonlySet<string> = new Set();

/** Brings what the folder changed in code into what the editor has, by lines. */
function mergeCode(
  file: string,
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
  conflicts: MergeConflict[],
): string | undefined {
  if (base === theirs || ours === theirs) return ours;
  if (base === ours) return theirs;
  const path = ["files", file];
  // Taken away on one side and changed on the other, or new on both: there are no lines to go by.
  if (base === undefined || ours === undefined || theirs === undefined) {
    conflicts.push({ file, path, theirs });
    return ours;
  }
  const merged = mergeText(base, ours, theirs);
  const lines = merged.conflicts.length > 0 ? linesOf(theirs) : [];
  for (const { at, theirs: range } of merged.conflicts) {
    conflicts.push({ file, path, lines: at, theirs: lines.slice(range.from, range.to).join("") });
  }
  return merged.text;
}

type Ordered = { readonly id: string; readonly order: number };

const sequenceOf = (items: readonly Ordered[]) => items.map(({ id }) => id);
const among = (sequence: readonly string[], kept: ReadonlySet<string>) =>
  sequence.filter((id) => kept.has(id));
const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The order of tracks or sections. Numbers say it, but only which is next to which means anything,
 * so the sequences are merged: a side moved something when what it shares with the base is in
 * another order. When only the folder moved things, its order counts; otherwise the editor's does,
 * and when both moved things differently, that is a conflict. The editor's numbers stay where they
 * can. What only one side has goes after what comes before it on that side, and what came last there
 * stays last.
 */
function mergeOrder(
  base: readonly string[],
  ours: readonly Ordered[],
  theirs: readonly string[],
  present: ReadonlySet<string>,
): { readonly orders: ReadonlyMap<string, number>; readonly conflict: boolean } {
  const mine = sequenceOf(ours);
  const inBase = new Set(base);
  const inMine = new Set(mine);
  const inTheirs = new Set(theirs);
  const theyMoved = !sameSequence(among(base, inTheirs), among(theirs, inBase));
  const iMoved = !sameSequence(among(base, inMine), among(mine, inBase));
  const inAll = new Set(base.filter((id) => inMine.has(id) && inTheirs.has(id)));
  const conflict = theyMoved && iMoved && !sameSequence(among(mine, inAll), among(theirs, inAll));
  const isTheirs = theyMoved && !iMoved;
  const [first, second] = isTheirs ? [theirs, mine] : [mine, theirs];
  const sequence = first.filter((id) => present.has(id));
  const placed = new Set(sequence);
  const inFirst = new Set(sequence);
  second.forEach((id, index) => {
    if (!present.has(id) || placed.has(id)) return;
    placed.add(id);
    // What came last stays last, also when what was before it moved.
    if (!second.slice(index + 1).some((other) => inFirst.has(other))) {
      sequence.push(id);
      return;
    }
    let at = 0;
    for (let back = index - 1; back >= 0; back--) {
      const position = sequence.indexOf(second[back] as string);
      if (position >= 0) {
        at = position + 1;
        break;
      }
    }
    sequence.splice(at, 0, id);
  });
  for (const id of present) if (!placed.has(id)) sequence.push(id);

  const renumbered = () => new Map(sequence.map((id, index) => [id, index]));
  if (isTheirs) return { orders: renumbered(), conflict };
  const known = new Map(ours.map(({ id, order }) => [id, order]));
  const orders = new Map<string, number>();
  let fits = true;
  let index = 0;
  while (index < sequence.length) {
    const order = known.get(sequence[index] as string);
    if (order !== undefined) {
      orders.set(sequence[index] as string, order);
      index++;
      continue;
    }
    // New ones, between two that keep their numbers.
    let end = index;
    while (end < sequence.length && !known.has(sequence[end] as string)) end++;
    const low = index > 0 ? known.get(sequence[index - 1] as string) : undefined;
    const high = end < sequence.length ? known.get(sequence[end] as string) : undefined;
    const count = end - index;
    for (let step = 0; step < count; step++) {
      const value =
        low !== undefined && high !== undefined
          ? low + ((high - low) * (step + 1)) / (count + 1)
          : low !== undefined
            ? low + step + 1
            : high !== undefined
              ? high - (count - step)
              : step;
      if ((low !== undefined && !(value > low)) || (high !== undefined && !(value < high))) {
        fits = false;
      }
      orders.set(sequence[index + step] as string, value);
    }
    index = end;
  }
  return { orders: fits ? orders : renumbered(), conflict };
}

/** Tracks and sections without their numbers, which `mergeOrder` takes care of. */
function unnumbered(timeline: Timeline | undefined): unknown {
  if (!timeline) return undefined;
  const strip = (items: Readonly<Record<string, Ordered>>) =>
    Object.fromEntries(Object.entries(items).map(([id, { order: _order, ...rest }]) => [id, rest]));
  return { ...timeline, tracks: strip(timeline.tracks), sections: strip(timeline.sections) };
}

const LEVELS_IN_ORDER = {
  tracks: orderedTracks,
  sections: orderedSections,
} as const;

const sequenceIn = (level: keyof typeof LEVELS_IN_ORDER, timeline: Timeline | undefined) =>
  timeline ? sequenceOf(LEVELS_IN_ORDER[level](timeline as TimelineState)) : [];

function mergeTimeline(
  at: Path,
  base: Timeline | undefined,
  ours: Timeline | undefined,
  theirs: Timeline | undefined,
  conflicts: Found[],
): Timeline | undefined {
  const [was, mine, theirsNow] = [unnumbered(base), unnumbered(ours), unnumbered(theirs)];
  const merged = [was, mine, theirsNow].every(isPlain)
    ? mergeEntries(at, was, mine, theirsNow, conflicts, OBJECTS)
    : merge3(at, was, mine, theirsNow, conflicts);
  if (!isPlain(merged)) return undefined;
  const numbered = (level: keyof typeof LEVELS_IN_ORDER) => {
    const items = (merged[level] ?? {}) as Readonly<Record<string, Plain>>;
    const { orders, conflict } = mergeOrder(
      sequenceIn(level, base),
      ours ? LEVELS_IN_ORDER[level](ours as TimelineState) : [],
      sequenceIn(level, theirs),
      new Set(Object.keys(items)),
    );
    if (conflict) conflicts.push({ path: [...at, level], theirs: sequenceIn(level, theirs) });
    return Object.fromEntries(
      Object.entries(items).map(([id, item]) => [id, { ...item, order: orders.get(id) }]),
    );
  };
  return { ...merged, tracks: numbered("tracks"), sections: numbered("sections") } as Timeline;
}

/** Whether two values of a file mean the same, where only the order of tracks and sections counts. */
function isSame({ kind }: Place, a: unknown, b: unknown): boolean {
  if (kind !== "timeline" || a === undefined || b === undefined) return deepEqual(a, b);
  const [mine, theirs] = [a, b] as [Timeline, Timeline];
  return (
    deepEqual(unnumbered(mine), unnumbered(theirs)) &&
    sameSequence(sequenceIn("tracks", mine), sequenceIn("tracks", theirs)) &&
    sameSequence(sequenceIn("sections", mine), sequenceIn("sections", theirs))
  );
}

/** A file of the batch on its way into the project. */
interface Doc extends Place {
  readonly change: FileChange;
  /** What the base and the file mean to the project. Undefined where they are not there. */
  readonly base: unknown;
  readonly next: unknown;
  /** What the project is to hold of it. */
  readonly merged: unknown;
  /** Why nothing of it comes in, while the file waits for people. */
  blocked?: Problem[];
}

/**
 * Puts what a file is to be into a draft. A timeline keeps the versions the draft has, which are
 * files of their own. Returns false for a version whose timeline is not there.
 */
function put(draft: Draft, { kind, at }: Place, value: unknown): boolean {
  if (kind === "source") {
    const now = entryOf(draft.state.files, at[1] as string);
    if (value === undefined) {
      if (now !== undefined) draft.delete(at);
    } else if (now !== value) {
      draft.setText(at, value as string);
    }
    return true;
  }
  const owner = entryOf(draft.state.timelines, at[1] as string);
  if (kind === "overrides" && !owner) return value === undefined;
  if (kind === "timeline" && value !== undefined) {
    replaceChanged(draft, at, getIn(draft.state, at), {
      ...(value as Timeline),
      overrides: owner?.overrides ?? {},
    });
    return true;
  }
  replaceChanged(draft, at, getIn(draft.state, at), value);
  return true;
}

/**
 * Replaces what is not the same object any more, level by level: what a merge keeps of the editor's
 * is, so a change to one clip of thousands stays a change to that one.
 */
function replaceChanged(draft: Draft, path: Path, now: unknown, value: unknown): void {
  if (now === value) return;
  if (!isPlain(now) || !isPlain(value) || !isContainer(path) || isStanding(path)) {
    draft.replace(path, value);
    return;
  }
  for (const key of Object.keys(now)) {
    if (!Object.hasOwn(value, key)) draft.replace([...path, key], undefined);
  }
  for (const [key, inner] of Object.entries(value)) {
    replaceChanged(draft, [...path, key], fieldOf(now, key), inner);
  }
}

/** A timeline that goes away goes last, after the versions in it. */
const rankOf = (doc: Doc, value: unknown) =>
  doc.kind === "timeline" && value === undefined ? RANKS.overrides + 1 : RANKS[doc.kind];

const inRank = (docs: readonly Doc[], valueOf: (doc: Doc) => unknown) =>
  docs.toSorted(
    (a, b) =>
      rankOf(a, valueOf(a)) - rankOf(b, valueOf(b)) ||
      (a.change.path < b.change.path ? -1 : a.change.path > b.change.path ? 1 : 0),
  );

const FIELD_NAMES: Readonly<Record<string, string>> = {
  name: "名字",
  description: "简介",
  languages: "语言",
  formats: "画幅",
  timelines: "时间轴列表",
  fonts: "字体",
  tags: "标签",
  cover: "封面",
  credits: "署名",
  fps: "帧率",
};

const LEVEL_NAMES: Readonly<Record<string, string>> = {
  sections: "段落",
  tracks: "轨道",
  clips: "片段",
  joins: "衔接转场",
  markers: "标记",
};

/** Something in the project in words, by the names people see. */
function named(state: ProjectState, path: Path): string {
  const [root = "", id = "", level, item = "", field, ...rest] = path;
  const nameIn = (items: unknown, key: string) => {
    const name = fieldOf(fieldOf(items, key), "name");
    return typeof name === "string" ? name : key;
  };
  /** A value whose fields merge one by one, and one of them. */
  const ofField = (thing: string) => (level === undefined ? thing : `${thing}的 ${level}`);
  switch (root) {
    case "manifest":
      return id ? `项目的${FIELD_NAMES[id] ?? ` ${id}`}` : "项目信息";
    case "assets":
      return id ? ofField(`素材“${nameIn(state.assets, id)}”`) : "素材表";
    case "notes":
      return id ? ofField(`批注“${id}”`) : "批注";
    case "libraries":
      return path.length === 3 ? `库“${path[2]}”` : "库的列表";
    case "lock":
      return "库的锁定";
    case "scenes":
      return ofField(`场景“${nameIn(state.scenes, id)}”`);
    case "sounds":
      return ofField(`声音“${nameIn(state.sounds, id)}”`);
    case "locales":
      return level === undefined ? `语言 ${id} 的字符串表` : `字符串“${level}”（${id}）`;
    case "files":
      return `文件 ${id}`;
    default:
      break;
  }
  const timeline = entryOf(state.timelines, id);
  const whole = `时间轴“${timeline?.name ?? id}”`;
  if (level === undefined) return whole;
  if (level === "overrides") {
    const [kind, owner = "", what, ...more] = path.slice(5);
    const version = `${whole}的版本 ${item}`;
    if (kind === "clips" && owner) {
      const clip = `${version}里片段“${nameIn(timeline?.clips, owner)}”`;
      if (what === undefined) return clip;
      return what === "properties" ? `${clip}的属性 ${more.join("/")}` : `${clip}的 ${what}`;
    }
    if (kind === "sections" && owner) {
      return `${version}里段落“${nameIn(timeline?.sections, owner)}”`;
    }
    return kind === undefined ? version : `${version}的 ${kind}`;
  }
  const what = LEVEL_NAMES[level];
  if (what === undefined) return `${whole}的 ${level}`;
  if (!item) return `${whole}的${what}顺序`;
  const thing = `${what}“${nameIn(fieldOf(timeline, level), item)}”`;
  if (field === undefined) return thing;
  return field === "properties" ? `${thing}的属性 ${rest.join("/")}` : `${thing}的 ${field}`;
}

/** Where in its file, for the problems tab: by ids and keys. */
function whereIn(path: Path): string | undefined {
  const [root = ""] = path;
  const from = (start: number) => path.slice(start).join(".") || undefined;
  switch (root) {
    case "timelines":
      return from(path[2] === "overrides" ? 5 : 3);
    case "manifest":
      return from(1);
    case "locales":
      return from(2);
    case "assets":
    case "notes":
      return path.join(".");
    default:
      return undefined;
  }
}

const warningAt = (code: string, path: Path, message: string, file = fileOf(path)): Problem => {
  const where = whereIn(path);
  return {
    severity: "warning",
    code,
    file,
    ...(where === undefined ? {} : { path: where }),
    message,
  };
};

/** Lines of code in words. */
function linesInWords({ from, to }: LineRange): string {
  if (to <= from) return `第 ${from + 1} 行附近`;
  return to === from + 1 ? `第 ${from + 1} 行` : `第 ${from + 1} 到 ${to} 行`;
}

/** Words that run on after a name that ends in letters or digits, such as a path, keep a space. */
const spaced = (name: string) => (/[\x21-\x7e]$/.test(name) ? `${name} ` : name);

const KEPT_MINE = "在编辑器和文件里都改了，保留了编辑器里的";

function conflictInWords(state: ProjectState, { file, path, lines }: MergeConflict): Problem {
  const what = lines ? `${spaced(file)}${linesInWords(lines)}` : spaced(named(state, path));
  return warningAt("merge-conflict", path, `${what}${KEPT_MINE}`, file);
}

/** Every library that a project points at, however deep: media, sources, joins, versions. */
function librariesUsedIn(state: ProjectState): ReadonlySet<string> {
  const used = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const { library } = value as { readonly library?: unknown };
    if (typeof library === "string") used.add(library);
    for (const inner of Object.values(value)) visit(inner);
  };
  for (const timeline of Object.values(state.timelines)) {
    visit(timeline.clips);
    visit(timeline.joins);
    visit(timeline.overrides);
  }
  return used;
}

/** Whether something that goes away is still in use, so that it has to stay. */
function isStillUsed(state: ProjectState, path: Path): boolean {
  const [root, id = "", level] = path;
  const isLinked = () => danglingAt(state, path).length > 0;
  switch (root) {
    case "assets":
      return (
        path.length === 2 &&
        (isLinked() ||
          codeUsingAsset(state, id) !== undefined ||
          state.manifest.fonts?.some(({ asset }) => asset === id) === true)
      );
    case "scenes":
    case "sounds":
      return path.length === 2 && isLinked();
    case "timelines":
      if (path.length === 2) return isLinked() || state.manifest.timelines.includes(id);
      return path.length === 4 && (level === "tracks" || level === "clips") && isLinked();
    case "files": {
      // An entry is what its scene or sound runs.
      const [folder, owner = "", ...rest] = id.split("/");
      const manifests =
        folder === "scenes" ? state.scenes : folder === "sounds" ? state.sounds : undefined;
      return entryOf(manifests, owner)?.entry === rest.join("/");
    }
    default:
      return false;
  }
}

const keyOf = (path: Path) => path.join("\n");

const startsWith = (path: Path, prefix: Path) =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

const isTagChange = ({ path }: Patch) => path[0] === "manifest" && path[1] === "tags";

const TAKEN_AWAY = new Set(["assets", "scenes", "sounds", "timelines"]);

/**
 * What a link from `danglingAt` points at, when that is something that can be taken away on its own:
 * an asset, a scene, a sound, a timeline, or a track or a clip of one.
 */
function targetOf(to: string): Path | undefined {
  // A track of another kind, a timeline without a section: nothing is missing there.
  if (to.includes(" ")) return undefined;
  const path = to.split("/");
  const [root = "", , level] = path;
  if (path.length === 2 && TAKEN_AWAY.has(root)) return path;
  const isOnTimeline = root === "timelines" && (level === "clips" || level === "tracks");
  return path.length === 4 && isOnTimeline ? path : undefined;
}

/** What the folder has of something: there, not there, or in a file that cannot be read. */
type Has = "there" | "gone" | "unreadable";

/**
 * What of a change of the folder the editor's side wins over: what the folder starts to point at,
 * which only the editor took away. All of it, or only some fields, such as the source of a clip.
 */
interface Hold {
  readonly prefix: Path;
  readonly fields?: readonly string[];
}

/** A value with some of its fields as another value has them. */
function withFieldsOf(value: unknown, from: unknown, fields: readonly string[]): unknown {
  if (!isPlain(value)) return value;
  const next: Plain = { ...value };
  for (const field of fields) {
    const kept = fieldOf(from, field);
    if (kept === undefined) delete next[field];
    else next[field] = kept;
  }
  return next;
}

/** A value with something inside of it changed, or taken out where `inner` is undefined. */
function withInner(value: unknown, path: Path, inner: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return inner;
  const next: Plain = isPlain(value) ? { ...value } : {};
  const changed = withInner(fieldOf(value, key), rest, inner);
  if (changed === undefined) delete next[key];
  else next[key] = changed;
  return next;
}

/**
 * A change without what holds keep out of it: the editor's side of that instead. A change inside of
 * something held goes, and one that brings more than that, such as a whole new timeline, brings the
 * editor's side of it along.
 */
function withoutHeld(
  patch: Patch,
  holds: readonly Hold[],
  before: ProjectState,
): Patch | undefined {
  let value = patch.op === "set" ? patch.value : undefined;
  let changed = false;
  for (const { prefix, fields } of holds) {
    if (startsWith(patch.path, prefix)) {
      if (fields === undefined) return undefined;
      if (patch.path.length > prefix.length) {
        if (fields.includes(patch.path[prefix.length] as string)) return undefined;
        continue;
      }
      if (patch.op !== "set") continue;
      value = withFieldsOf(value, getIn(before, prefix), fields);
      changed = true;
    } else if (patch.op === "set" && startsWith(prefix, patch.path)) {
      const inside = prefix.slice(patch.path.length);
      const mine = getIn(before, prefix);
      const theirs = getIn(value, inside);
      const kept =
        fields === undefined || mine === undefined || theirs === undefined
          ? mine
          : withFieldsOf(theirs, mine, fields);
      value = withInner(value, inside, kept);
      changed = true;
    }
  }
  if (!changed) return patch;
  return value === undefined
    ? { op: "delete", path: patch.path }
    : { op: "set", path: patch.path, value };
}

/**
 * Which fields of something point at what it points at, see `Hold`: all of it, when the editor does
 * not have it, as there is nothing to keep of it then, and all of a join and of the fonts.
 */
function pointingFields(
  before: ProjectState,
  from: Path,
  target: Path,
): readonly string[] | undefined {
  if (from[0] === "manifest" || from[2] === "joins") return undefined;
  if (from[2] === "overrides") return ["source"];
  if (getIn(before, from) === undefined) return undefined;
  return target[2] === "tracks" ? ["track"] : ["source"];
}

/** The parts of a project that a few files are in, so that only those get looked at. */
function partOf(state: ProjectState, places: readonly Place[]): ProjectState {
  const part: {
    -readonly [K in keyof ProjectState]: ProjectState[K];
  } = { manifest: state.manifest, scenes: {}, sounds: {}, locales: {}, timelines: {}, files: {} };
  const pick = <T>(items: Readonly<Record<string, T>>, id: string, into: Record<string, T>) => {
    const item = entryOf(items, id);
    if (item !== undefined) into[id] = item;
  };
  for (const { kind, at } of places) {
    const id = at[1] as string;
    if (kind === "assets" && state.assets) part.assets = state.assets;
    if (kind === "libraries" && state.libraries) part.libraries = state.libraries;
    if (kind === "lock" && state.lock) part.lock = state.lock;
    if (kind === "notes" && state.notes) part.notes = state.notes;
    if (kind === "scene") pick(state.scenes, id, part.scenes as Record<string, never>);
    if (kind === "sound") pick(state.sounds, id, part.sounds as Record<string, never>);
    if (kind === "locale") pick(state.locales, id, part.locales as Record<string, never>);
    if (kind === "timeline" || kind === "overrides") {
      pick(state.timelines, id, part.timelines as Record<string, never>);
    }
  }
  return part;
}

/** The scope a version stands for by its name, see `override-misnamed` in check.ts. */
const nameOfScope = ({ language, format }: Overrides["scope"]) =>
  language && format
    ? `version.${language}.${format}`
    : language
      ? `language.${language}`
      : `format.${format}`;

/** The timelines that the clips of a timeline put inside of it, see `nestedTimelines` in check.ts. */
function nestedIn(state: ProjectState, id: string): ReadonlySet<string> {
  const clips = entryOf(state.timelines, id)?.clips ?? {};
  const known = nestedBy.get(clips);
  if (known) return known;
  const nested = new Set<string>();
  for (const { source } of Object.values(clips)) {
    const timeline = (source as { readonly timeline?: unknown }).timeline;
    if (source.kind === "timeline" && typeof timeline === "string") nested.add(timeline);
  }
  nestedBy.set(clips, nested);
  return nested;
}

/** The clips of a timeline only change by being replaced, see `nestedIn`. */
const nestedBy = new WeakMap<object, ReadonlySet<string>>();

/** The timelines that end up inside of themselves, by way of their clips. */
function cyclesIn(state: ProjectState): ReadonlySet<string> {
  const inside = new Map(Object.keys(state.timelines).map((id) => [id, nestedIn(state, id)]));
  const looped = new Set<string>();
  for (const id of inside.keys()) {
    const seen = new Set<string>();
    const queue = [...(inside.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (next === id) {
        looped.add(id);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(inside.get(next) ?? []));
    }
  }
  return looped;
}

/**
 * The errors that reading the project finds in it as a whole, which the files on their own do not
 * show, see `checkProject`: a timeline the manifest lists and does not have, one inside itself, a
 * version under the name of another. By what each is about, so that the same can be found elsewhere.
 */
function projectErrors(
  state: ProjectState,
  versions: readonly Place[],
): ReadonlyMap<string, Problem> {
  const errors = new Map<string, Problem>();
  state.manifest.timelines.forEach((id, index) => {
    if (Object.hasOwn(state.timelines, id)) return;
    const message = `清单里列着时间轴“${id}”，项目里却没有它`;
    const problem: Problem = {
      severity: "error",
      code: "timeline-missing",
      file: MANIFEST_FILE,
      path: `timelines.${index}`,
      message,
    };
    errors.set(`missing ${id}`, problem);
  });
  for (const id of cyclesIn(state)) {
    const message = `时间轴“${id}”会嵌套它自己`;
    errors.set(`cycle ${id}`, {
      severity: "error",
      code: "timeline-cycle",
      file: `timelines/${id}/timeline.json`,
      message,
    });
  }
  for (const { at } of versions) {
    const [, id = "", , name = ""] = at;
    const scope = entryOf(entryOf(state.timelines, id)?.overrides, name)?.scope;
    if (!scope || nameOfScope(scope) === name) continue;
    const file = `timelines/${id}/overrides/${name}.json`;
    const message = `这个范围的文件名应该是 ${nameOfScope(scope)}.json`;
    errors.set(`misnamed ${file}`, {
      severity: "error",
      code: "override-misnamed",
      file,
      path: "scope",
      message,
    });
  }
  return errors;
}

/** What becomes of files when nothing of a batch comes in: they keep their bases and wait. */
export function unmergedFiles(changes: readonly FileChange[]): readonly MergedFile[] {
  return changes.map(({ path, base, text }) =>
    placeOf(path) === undefined
      ? { path, status: "ignored", base: text, rewrite: false }
      : { path, status: "blocked", base, rewrite: false },
  );
}

/** What gets through: what only people can change and what has to stay do not. */
interface Admitted {
  readonly draft: Draft;
  readonly patches: readonly Patch[];
  /** Kept because only a person can change it. */
  readonly personal: readonly Patch[];
  /** What would be a piece of a timeline that is not there. */
  readonly orphans: readonly Patch[];
}

/**
 * Brings a batch of files that changed outside of the editor into the project, as one change. The
 * base of each file is what the editor last wrote or read: what changed from there is what was done
 * outside, and only that is added to what the project holds now, so changes the editor has not
 * written yet stay. Where both sides changed the same value, or the same lines of code, the editor's
 * stays and `conflicts` says where. Documents merge by the levels the project has, see structure.ts,
 * and code by lines.
 *
 * It goes by the rules of a file that comes in, see `planFileImport`: a file that is not valid
 * changes nothing and is blocked, with the versions of a timeline that is, and the manifest when it
 * lists one. What the folder took away and is still in use
 * stays too: a whole document then waits for people, blocked, and an entry of a document that
 * changed, such as an asset, simply stays.
 *
 * What the folder starts to point at, that the editor took away and has not written out yet, would be
 * missing once the editor writes. That is a conflict about that one link, which the editor's side
 * wins: the link stays out, and the rest of the file comes in. To know what the folder still has
 * outside of the batch, the merge asks `baseOf`. A file whose part would leave the project broken in
 * a way that neither it nor the folder was waits, and so does one that would bring the project an
 * error as a whole that it did not have, such as a timeline inside itself. When that does not help,
 * nothing of the batch comes in: `refusal` says why. Otherwise what comes in is planned into the
 * draft. It never throws for what a batch holds: see `mergeFiles`, which refuses what goes wrong.
 */
export function planMerge(
  draft: Draft,
  changes: readonly FileChange[],
  { baseOf, memory }: MergeContext,
): FileMerge {
  const before = draft.state;
  const { origin } = draft;
  const seen = new Set<string>();
  for (const { path } of changes) {
    if (seen.has(path)) {
      throw new CommandError("invalid-batch", `同一批里有两个一样的路径：${path}`);
    }
    seen.add(path);
  }
  const refused = (code: string, message: string, problems: readonly Problem[]): FileMerge => ({
    files: unmergedFiles(changes),
    problems: [],
    conflicts: [],
    kept: [],
    held: [],
    refusal: { code, message, problems },
  });
  const isManifestGone = changes.some(
    ({ path, base, text }) => path === MANIFEST_FILE && base !== undefined && text === undefined,
  );
  if (isManifestGone) {
    const message = "项目文件夹里的 animaquill.json 不见了，这一批改动没有并入";
    const file = MANIFEST_FILE;
    return refused("manifest-deleted", message, [
      { severity: "error", code: "manifest-deleted", file, message },
    ]);
  }

  // What each file means, and what the project is to hold of it.
  const docs: Doc[] = [];
  const invalid = new Map<string, readonly Problem[]>();
  const conflicts: MergeConflict[] = [];
  for (const change of changes) {
    const { path } = change;
    const place = placeOf(path);
    if (place === undefined) continue;
    if (isProblem(place)) {
      invalid.set(path, [place]);
      continue;
    }
    const text = change.text === undefined ? undefined : unmarked(place, change.text);
    const next: Reading =
      text === undefined ? { problems: [] } : readText(before, path, place, text);
    if (next.problems.length > 0) {
      invalid.set(path, next.problems);
      continue;
    }
    const baseText = change.base === undefined ? undefined : unmarked(place, change.base);
    const known = memory?.get(path)?.find((each) => each.text === baseText);
    const base =
      baseText === undefined
        ? undefined
        : baseText === text
          ? next.value
          : known
            ? known.value
            : readQuietly(before, path, place, baseText).value;
    if (text !== undefined && place.kind !== "source") remember(memory, path, text, next.value);
    const ours = valueIn(before, place);
    const found: Found[] = [];
    let merged: unknown;
    if (place.kind === "source") {
      const asText = (value: unknown) => value as string | undefined;
      merged = mergeCode(path, asText(base), asText(ours), asText(next.value), conflicts);
    } else if (place.kind === "timeline") {
      const asTimeline = (value: unknown) => value as Timeline | undefined;
      merged = mergeTimeline(
        place.at,
        asTimeline(base),
        asTimeline(ours),
        asTimeline(next.value),
        found,
      );
    } else {
      merged = merge3(place.at, base, ours, next.value, found);
    }
    for (const { path: where, theirs } of found)
      conflicts.push({ file: path, path: where, theirs });
    docs.push({ ...place, change, base, next: next.value, merged });
  }
  const byFile = new Map(docs.map((doc) => [doc.change.path, doc]));
  const isWaiting = (file: string) => invalid.has(file) || byFile.get(file)?.blocked !== undefined;
  /** What waits takes along what cannot come in without it: versions, the files of a scene. */
  const block = (doc: Doc, problem: Problem) => {
    doc.blocked = [...(doc.blocked ?? []), problem];
    const [, id = ""] = doc.at;
    if (doc.kind === "timeline") blockVersionsOf(id);
    if (doc.change.text !== undefined) return;
    const folder =
      doc.kind === "scene" ? `scenes/${id}/` : doc.kind === "sound" ? `sounds/${id}/` : undefined;
    if (folder === undefined) return;
    for (const other of docs) {
      const { path, text } = other.change;
      if (other.blocked || text !== undefined || !path.startsWith(folder)) continue;
      const message = `外面删掉了这个文件，但${named(before, doc.at)}要留着，它也先留着`;
      block(other, warningAt("still-in-use", other.at, message, path));
    }
  };
  /** A version cannot be there without its timeline. */
  const blockVersionsOf = (id: string) => {
    for (const other of docs) {
      if (other.blocked || other.kind !== "overrides" || other.at[1] !== id) continue;
      const message = `时间轴“${id}”的文件先不并入，它的版本差异也先不并入`;
      block(other, warningAt("waits-with-timeline", other.at, message, other.change.path));
    }
  };
  for (const path of invalid.keys()) {
    const timeline = /^timelines\/([^/]+)\/timeline\.json$/.exec(path)?.[1];
    if (timeline !== undefined) blockVersionsOf(timeline);
  }

  // The project with all of it.
  const planned = new Draft(before, origin);
  for (const doc of inRank(docs, ({ merged }) => merged)) {
    if (doc.blocked) continue;
    if (doc.kind === "timeline" && doc.merged === undefined) {
      // A timeline goes with its versions: one that the folder still has, or that the editor changed,
      // has to stay.
      const versions = entryOf(planned.state.timelines, doc.at[1] as string)?.overrides ?? {};
      if (Object.keys(versions).length > 0) {
        const message = `外面删掉了${named(before, doc.at)}，但它还有版本差异，先不删`;
        block(doc, warningAt("still-in-use", doc.at, message, doc.change.path));
        continue;
      }
    }
    if (!put(planned, doc, doc.merged)) {
      const message = `没有这条时间轴：${doc.at[1]}`;
      block(doc, { severity: "error", code: "timeline-missing", file: doc.change.path, message });
    }
  }
  /** The project with what the folder has on its own, only when it is asked for. */
  let folderState: ProjectState | undefined;
  const theirsOf = () => {
    if (folderState) return folderState;
    const theirs = new Draft(before, USER);
    for (const doc of inRank(docs, ({ next }) => next)) put(theirs, doc, doc.next);
    folderState = theirs.state;
    return folderState;
  };

  // What the folder has of a file outside the batch: its base, read once.
  const outside = new Map<string, Reading>();
  const folderHas = (target: Path): Has => {
    const file = fileOf(target);
    if (invalid.has(file)) return "unreadable";
    const doc = byFile.get(file);
    const place = doc ?? placeOf(file);
    if (!place || isProblem(place)) return "gone";
    let reading: Reading;
    if (doc) {
      reading = { value: doc.next, problems: [] };
    } else {
      const known = outside.get(file);
      if (known) reading = known;
      else {
        if (!baseOf) return "there";
        const text = baseOf(file);
        reading =
          text === undefined
            ? { problems: [] }
            : readQuietly(before, file, place, unmarked(place, text));
        outside.set(file, reading);
      }
    }
    if (reading.problems.length > 0) return "unreadable";
    return getIn(reading.value, target.slice(place.at.length)) === undefined ? "gone" : "there";
  };

  // What gets through. Each round can leave out more, until nothing new turns up.
  const patches = planned.steps.map(({ patch }) => patch);
  const waiting = new Map<string, Path>();
  const holds: Hold[] = [];
  /** How often what holds keep out grew, which is how far the merge got, see `waits`. */
  let heldMore = 0;
  const holdConflicts: MergeConflict[] = [];
  const holdProblems: Problem[] = [];
  const keepLibraries = new Set<string>();
  const relist = new Set<string>();

  /** What the folder took out of the list of libraries that is still in use goes back in. */
  const withUsedLibraries = (patch: Patch): Patch => {
    if (keepLibraries.size === 0 || patch.path.length !== 1 || patch.path[0] !== "libraries") {
      return patch;
    }
    const now = patch.op === "set" ? ((patch.value as Libraries).libraries ?? []) : [];
    const back = (before.libraries?.libraries ?? []).filter(
      ({ id }) => keepLibraries.has(id) && !now.some((each) => each.id === id),
    );
    if (back.length === 0) return patch;
    const value = {
      ...(patch.op === "set" ? (patch.value as Libraries) : before.libraries),
      libraries: [...now, ...back],
    };
    return { op: "set", path: patch.path, value };
  };
  /** A timeline that stays stays in the list of the manifest, where it was. */
  const withListed = (patch: Patch): Patch => {
    if (relist.size === 0 || patch.op !== "set" || patch.path.join("/") !== "manifest/timelines") {
      return patch;
    }
    const list = [...(patch.value as readonly string[])];
    const was = before.manifest.timelines;
    was.forEach((id, index) => {
      if (!relist.has(id) || list.includes(id)) return;
      let at = 0;
      for (let back = index - 1; back >= 0; back--) {
        const position = list.indexOf(was[back] as string);
        if (position >= 0) {
          at = position + 1;
          break;
        }
      }
      list.splice(at, 0, id);
    });
    return { ...patch, value: list };
  };

  const admit = (): Admitted => {
    const admitted = new Draft(before, origin);
    const through: Patch[] = [];
    const personal: Patch[] = [];
    const orphans: Patch[] = [];
    for (const each of patches) {
      if (byFile.get(fileOf(each.path))?.blocked || waiting.has(keyOf(each.path))) continue;
      const free = holds.length > 0 ? withoutHeld(each, holds, before) : each;
      if (free === undefined) continue;
      // A change inside of a timeline that is not there would make a piece of one.
      const [root, timeline = ""] = free.path;
      if (
        root === "timelines" &&
        free.path.length > 2 &&
        !entryOf(admitted.state.timelines, timeline)
      ) {
        orphans.push(free);
        continue;
      }
      const patch = withListed(withUsedLibraries(free));
      if (!isUser(origin) && isTagChange(patch)) {
        personal.push(patch);
      } else {
        admitted.repeat(patch);
        through.push(patch);
      }
    }
    return { draft: admitted, patches: through, personal, orphans };
  };

  /** Whether the project holds what a file has, which is asked more than once. See `isSame`. */
  const sameAsFile = new Map<Doc, { readonly held: unknown; readonly same: boolean }>();
  const holdsFile = (state: ProjectState, doc: Doc) => {
    const held = getIn(state, doc.at);
    const was = sameAsFile.get(doc);
    if (was && was.held === held && typeof held === "object") return was.same;
    const same = isSame(doc, valueIn(state, doc), doc.next);
    sameAsFile.set(doc, { held, same });
    return same;
  };

  const paths = planned.steps.map(({ patch }) => patch.path);
  const pointedBefore = new Set(paths.flatMap((path) => danglingAt(before, path)));
  const errorsBefore = projectErrors(
    before,
    docs.filter(({ kind }) => kind === "overrides"),
  );
  const waits = () =>
    waiting.size +
    heldMore +
    keepLibraries.size +
    relist.size +
    docs.filter(({ blocked }) => blocked).length;
  let admitted = admit();
  let previous = -1;
  for (;;) {
    const known = waits();
    const { state } = admitted.draft;
    const unsettled = (path: Path) => {
      const message = "合并时有些改动定不下来，这一批没有并入";
      return refused("merge-unsettled", message, [
        { severity: "error", code: "merge-unsettled", file: fileOf(path), message },
      ]);
    };
    // Each round leaves out more than the one before, or it is the last: anything else would go on
    // without end.
    if (known === previous) return unsettled(["manifest"]);
    previous = known;

    // A piece of a timeline that does not come in waits with its file.
    if (admitted.orphans.length > 0) {
      for (const { path } of admitted.orphans) {
        const doc = byFile.get(fileOf(path));
        if (!doc || doc.blocked) continue;
        const message = `没有这条时间轴：${path[1]}`;
        block(doc, { severity: "error", code: "timeline-missing", file: doc.change.path, message });
      }
      if (waits() === known) return unsettled(admitted.orphans[0]?.path ?? []);
      admitted = admit();
      continue;
    }

    // What the folder took away that is still in use stays.
    const used = admitted.patches.filter(
      ({ op, path }) => op === "delete" && isStillUsed(state, path),
    );
    if (used.length > 0) {
      for (const { path } of used) {
        const doc = byFile.get(fileOf(path));
        if (doc && doc.change.text === undefined) {
          const message = `外面删掉了${named(before, doc.at)}，但项目还在用它，先不删`;
          block(doc, warningAt("still-in-use", doc.at, message, doc.change.path));
        } else {
          waiting.set(keyOf(path), path);
        }
      }
      if (waits() === known) return unsettled(used[0]?.path ?? []);
      admitted = admit();
      continue;
    }
    const listOf = (libraries: Libraries | undefined) =>
      new Set((libraries?.libraries ?? []).map(({ id }) => id));
    const nowListed = listOf(state.libraries);
    const unlisted = [...listOf(before.libraries)].filter((id) => !nowListed.has(id));
    if (unlisted.length > 0) {
      const inUse = librariesUsedIn(state);
      const stillUsed = unlisted.filter((id) => inUse.has(id) && !keepLibraries.has(id));
      if (stillUsed.length > 0) {
        const doc = byFile.get("libraries.json");
        if (doc && doc.change.text === undefined) {
          const message = "外面删掉了库的列表，但项目还在用里面的库，先不删";
          block(doc, warningAt("still-in-use", doc.at, message, doc.change.path));
        } else {
          for (const id of stillUsed) keepLibraries.add(id);
        }
        if (waits() === known) return unsettled(["libraries"]);
        admitted = admit();
        continue;
      }
    }

    // What the folder starts to point at, that only the editor took away.
    const uses = [...new Set(paths.flatMap((path) => danglingAt(state, path)))].flatMap((link) => {
      if (pointedBefore.has(link)) return [];
      const [from, to] = sidesOf(link);
      const target = targetOf(to);
      if (!target) return [];
      const has = folderHas(target);
      return has === "gone" ? [] : [{ from, target, has }];
    });
    // The same for fonts, which point at assets too.
    const fontsBefore = new Set(
      (before.manifest.fonts ?? []).flatMap(({ asset }) =>
        entryOf(before.assets, asset) ? [] : [asset],
      ),
    );
    for (const { asset } of state.manifest.fonts ?? []) {
      if (entryOf(state.assets, asset) || fontsBefore.has(asset)) continue;
      const target = ["assets", asset];
      const has = folderHas(target);
      if (has !== "gone") uses.push({ from: ["manifest", "fonts"], target, has });
    }
    // And for code of the batch, which asks for assets by name.
    for (const doc of docs) {
      if (doc.blocked || doc.kind !== "source" || doc.change.text === undefined) continue;
      const path = doc.at[1] as string;
      const namedBefore = new Set(assetsNamedIn(entryOf(before.files, path) ?? ""));
      for (const asset of assetsNamedIn(entryOf(state.files, path) ?? "")) {
        if (namedBefore.has(asset) || entryOf(state.assets, asset)) continue;
        const has = folderHas(["assets", asset]);
        if (has === "gone") continue;
        const message =
          has === "there"
            ? `代码里新用到了${named(before, ["assets", asset])}，编辑器里刚把它删掉，还没写进文件夹，这个文件先不并入`
            : `代码里新用到了素材“${asset}”，它的文件 assets.json 读不懂，这个文件先不并入`;
        block(
          doc,
          warningAt(has === "there" ? "uses-removed" : "needs-file", doc.at, message, path),
        );
        break;
      }
    }
    if (uses.length > 0) {
      for (const { from, target, has } of uses) {
        const file = fileOf(from);
        const doc = byFile.get(file);
        if (!doc || doc.blocked) continue;
        const what = named(theirsOf(), from);
        if (has === "unreadable") {
          const message = `${what}用到了${named(before, target)}，它的文件 ${fileOf(target)} 读不懂，这个文件先不并入`;
          block(doc, warningAt("needs-file", from, message, file));
          continue;
        }
        // One thing can point at more than one of those: what is held of it adds up.
        const fields = pointingFields(before, from, target);
        const at = holds.findIndex((each) => keyOf(each.prefix) === keyOf(from));
        const was = at < 0 ? undefined : (holds[at] as Hold);
        if (was && (!was.fields || fields?.every((field) => was.fields?.includes(field)))) {
          continue;
        }
        const all = was?.fields && fields ? [...new Set([...was.fields, ...fields])] : undefined;
        const hold: Hold = {
          prefix: from,
          ...(was ? all && { fields: all } : fields && { fields }),
        };
        if (was) holds[at] = hold;
        else holds.push(hold);
        heldMore += 1;
        if (!was) {
          holdConflicts.push({
            file,
            path: from,
            theirs: getIn(doc.next, from.slice(doc.at.length)),
          });
        }
        const message = `${what}用到了${named(before, target)}，编辑器里刚把它删掉，还没写进文件夹，保留了编辑器里的`;
        holdProblems.push(warningAt("uses-removed", from, message, file));
      }
      if (waits() === known) {
        const message = "外面新用到的东西编辑器里刚删掉了，这一批没有并入";
        const problems = uses.map(({ from, target }) => ({
          severity: "error" as const,
          code: "merge-would-break",
          file: fileOf(from),
          message: `${named(theirsOf(), from)}用到了${named(before, target)}，编辑器里刚把它删掉`,
        }));
        return refused("merge-would-break", message, problems);
      }
      admitted = admit();
      continue;
    }
    if (waits() !== known) {
      admitted = admit();
      continue;
    }

    // A timeline that stays is listed where it was. One the manifest lists and the project does
    // not have keeps the manifest waiting, see `brokenBy`.
    const unlistedTimelines = Object.keys(state.timelines).filter(
      (id) =>
        !state.manifest.timelines.includes(id) &&
        before.manifest.timelines.includes(id) &&
        !relist.has(id),
    );
    if (unlistedTimelines.length > 0) {
      for (const id of unlistedTimelines) relist.add(id);
      admitted = admit();
      continue;
    }

    // What would be broken where neither the project before nor the folder was waits, file by file.
    const broken = brokenBy(before, theirsOf, state, paths, docs, errorsBefore, holdsFile);
    if (broken.length > 0) {
      const waited = new Set(docs.filter(({ blocked }) => blocked));
      for (const problem of broken) {
        const doc = byFile.get(problem.file);
        if (!doc || waited.has(doc)) continue;
        block(doc, {
          ...problem,
          severity: "warning",
          message: `${problem.message}，这个文件先不并入`,
        });
      }
      if (waits() === known) {
        const message = "外面的改动和编辑器里还没写出去的改动合在一起会让项目出错，这一批没有并入";
        return refused("merge-would-break", message, broken);
      }
      admitted = admit();
      continue;
    }
    break;
  }

  for (const patch of admitted.patches) draft.repeat(patch);

  const problems: Problem[] = [...invalid.values()].flat();
  for (const doc of docs) problems.push(...(doc.blocked ?? []));
  // Nothing of a file that waits came in, so neither did a conflict in it.
  const found = [...conflicts, ...holdConflicts].filter(({ file }) => !isWaiting(file));
  for (const conflict of conflicts) {
    if (!isWaiting(conflict.file)) problems.push(conflictInWords(before, conflict));
  }
  problems.push(...holdProblems.filter(({ file }) => !isWaiting(file)));
  // What a file still says the way it was said before transitions, which reading it leaves out.
  for (const doc of docs) {
    const { blocked, change } = doc;
    const text = change.text === undefined ? undefined : unmarked(doc, change.text);
    const retired =
      blocked || text === undefined || !mayBeRetired(text)
        ? undefined
        : retiredFadesIn(change.path, text);
    if (retired) problems.push(retired);
  }
  for (const { path } of admitted.personal.slice(0, 1)) {
    const message = "只有用户自己能改项目的标签，文件里对标签的改动没有生效";
    problems.push(warningAt("user-only", path, message));
  }
  for (const path of waiting.values()) {
    const message = `外面删掉了${named(before, path)}，但项目还在用它，先不删`;
    problems.push(warningAt("still-in-use", path, message));
  }
  const libraryPaths = [...keepLibraries].map((id) => ["libraries", "libraries", id]);
  for (const path of libraryPaths) {
    const message = `外面删掉了${named(before, path)}，但项目还在用它，先不删`;
    problems.push(warningAt("still-in-use", path, message, "libraries.json"));
  }
  for (const id of relist) {
    const message = `时间轴“${id}”留着，清单里也留着它`;
    problems.push(warningAt("kept-listed", ["manifest", "timelines"], message, MANIFEST_FILE));
  }

  const held = [
    ...waiting.values(),
    ...libraryPaths,
    ...docs.flatMap((doc) => (doc.blocked?.some(isInUse) ? [doc.at] : [])),
  ];
  const files = changes.map(({ path, base, text }): MergedFile => {
    const doc = byFile.get(path);
    if (isWaiting(path)) return { path, status: "blocked", base, rewrite: false };
    if (!doc) return { path, status: "ignored", base: text, rewrite: false };
    return {
      path,
      status: "merged",
      base: text,
      rewrite: !holdsFile(admitted.draft.state, doc),
    };
  });
  return {
    files,
    problems,
    conflicts: found,
    kept: admitted.personal.map(({ path }) => path),
    held,
  };
}

const isInUse = ({ code }: Problem) => code === "still-in-use";

/**
 * What new the merged project would point at that is not there, and which of the files that came in
 * it could no longer write, where neither the project before nor the folder on its own is like that,
 * and the errors of the project as a whole that it did not have before, see `projectErrors`. Only
 * what the batch touched is looked at: everything else is as it was.
 */
function brokenBy(
  before: ProjectState,
  theirsOf: () => ProjectState,
  merged: ProjectState,
  paths: readonly Path[],
  docs: readonly Doc[],
  errorsBefore: ReadonlyMap<string, Problem>,
  holdsFile: (state: ProjectState, doc: Doc) => boolean,
): readonly Problem[] {
  const broken: Problem[] = [];
  const linksIn = (state: ProjectState) =>
    new Set(paths.flatMap((path) => danglingAt(state, path)));
  const links = linksIn(merged);
  if (links.size > 0) {
    const known = new Set([...linksIn(before), ...linksIn(theirsOf())]);
    for (const link of links) {
      if (known.has(link)) continue;
      const [from] = sidesOf(link);
      broken.push({
        severity: "error",
        code: "merge-would-break",
        file: fileOf(from),
        message: linkInWords(link),
      });
    }
  }
  // A file that came in as the folder has it, or as the editor had it, was fine before.
  const mixed = docs.filter(
    (doc) =>
      !doc.blocked &&
      doc.kind !== "source" &&
      !holdsFile(merged, doc) &&
      !isSame(doc, valueIn(merged, doc), valueIn(before, doc)),
  );
  const invalid = mixed.length > 0 ? stateToProject(partOf(merged, mixed)).problems : [];
  if (invalid.length > 0) {
    const filesIn = (state: ProjectState) =>
      new Set(stateToProject(partOf(state, mixed)).problems.map(({ file }) => file));
    const known = new Set([...filesIn(before), ...filesIn(theirsOf())]);
    for (const problem of invalid) {
      if (known.has(problem.file)) continue;
      const message = `合并以后这个文件会不再合格式：${problem.message}`;
      broken.push({ ...problem, code: "merge-would-break", message });
    }
  }
  // These are errors of the project, which no merge brings in, also not where the folder has them.
  const versions = docs.filter(({ kind }) => kind === "overrides");
  const errors = projectErrors(merged, versions);
  if (errors.size > 0) {
    const looped = cyclesIn(merged);
    for (const [key, problem] of errors) {
      if (errorsBefore.has(key)) continue;
      // A timeline inside itself is the doing of the one that put another one of them inside of it.
      const [kind, id = ""] = key.split(" ");
      if (kind === "cycle") {
        const was = nestedIn(before, id);
        if (![...nestedIn(merged, id)].some((nested) => looped.has(nested) && !was.has(nested))) {
          continue;
        }
      }
      broken.push({ ...problem, code: "merge-would-break" });
    }
  }
  return broken;
}
