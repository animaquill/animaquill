import {
  CURRENT_FORMAT_VERSION,
  newId,
  readProject,
  writeProject,
  type Problem,
  type Project,
  type ProjectFiles,
} from "@animaquill/schema";
import * as Y from "yjs";
import { operationOf, type Operation } from "./commands.ts";
import { beforeAfter, type BeforeAfter } from "./before-after.ts";
import { Draft, factsTakenBack, type ClipFact, type Step } from "./draft.ts";
import {
  CommandError,
  failureOf,
  paramIssues,
  type CommandFailure,
  type FailureCode,
} from "./failures.ts";
import { isSourceFile, planFileImport } from "./import-file.ts";
import {
  planMerge,
  rememberWritten,
  takeTheirs,
  unmergedFiles,
  type BaseOf,
  type FileChange,
  type FileMerge,
  type MergeConflict,
  type MergedFile,
  type MergeMemory,
} from "./merge-files.ts";
import { brokenDocument } from "./document-check.ts";
import { editSpan } from "./doubled-text.ts";
import { objectKey, objectOfPath } from "./object-of-path.ts";
import { projectToState, stateToProject, type Here, type ProjectState } from "./model.ts";
import {
  NOBODY,
  STORAGE,
  USER,
  aiTask,
  folderBatch,
  isFileBatch,
  repoBatch,
  type Origin,
} from "./origin.ts";
import { PLATFORM_CLIENT, cloudOrigin } from "./sync.ts";
import { Mutator, getIn, type Patch } from "./patch.ts";
import { danglingAt } from "./references.ts";
import {
  flatKey,
  flatParts,
  isContainer,
  isFlat,
  isRetired,
  isStanding,
  writePathOf,
  type Path,
} from "./structure.ts";
import { UNWRITTEN, WriteTree, type WriteId, type Written } from "./write-tree.ts";
import { documentMark, marksAround, placePathOf, type Mark, type Marks } from "./undo-marks.ts";
import {
  UNDO_FORMAT,
  isUndoRecord,
  type SavedEntry,
  type SavedWritten,
  type UndoRecord,
} from "./undo-record.ts";

export { STORAGE, USER, aiTask, folderBatch, isFileBatch, repoBatch, type Origin };

const LOAD = "load";
const REMOTE = "remote";
const ROOT = "project";
const MAX_HISTORY = 1000;
const MAX_UNDO = 500;
/**
 * How many batches of files from the folder or the repository can still be taken back, see
 * mergeFiles(): as many as are kept of every kind after a reload, see `UNDO_KEPT`.
 */
export const MAX_BATCHES = 50;

/** Something an update wrote, at its place in the project, as Yjs has it, see `checkWritten`. */
export interface WrittenKey {
  readonly path: Path;
  readonly raw: unknown;
}

/** What `applyChecked` took in. */
export interface CheckedChange {
  /** What it changed, as an update, or undefined when the project had all of it. */
  readonly delta: Uint8Array | undefined;
  /** Every key it wrote that shows, for `checkWritten`. */
  readonly written: readonly WrittenKey[];
}

export interface CommandCall {
  readonly type: string;
  readonly params?: unknown;
}

/**
 * A revision as whoever is outside of the editor holds it: `"<epoch>:<count>"`. The epoch is new for
 * every `ProjectStore`, so a revision from before a reload, or of another window, is no revision of
 * this one, whatever its count. See `ProjectStore.revisionId`.
 */
export type RevisionId = string;

/** A revision: a count of this store, or a `RevisionId`. */
export type Revision = number | RevisionId;

export interface ExecuteOptions {
  readonly origin?: Origin;
  /**
   * The revision the caller saw. A change somebody else made since then to the same property stops
   * the command. This is how a person's edit wins over an AI task that did not see it yet. It can
   * be one for each path the change writes, for a caller that keeps track of what it saw of each
   * object, see `objectOfPath`: undefined for a path does not check that path.
   */
  readonly baseRevision?: Revision | ((path: Path) => Revision | undefined);
  /**
   * Origins whose changes count as the caller's own, besides its origin: an AI conversation whose
   * messages each are a task of their own. What people took back of them is not.
   */
  readonly isOwn?: (origin: Origin) => boolean;
  /** Runs every check and writes nothing. */
  readonly dryRun?: boolean;
  /**
   * A last check of what the change writes, after every other check and before anything is written:
   * a failure stops it. For a change people allowed after they saw a dry run of it, which has to
   * write exactly what they saw (S-D4).
   */
  readonly expect?: (patches: readonly Patch[]) => CommandFailure | undefined;
}

/**
 * How a file comes in. There is no default for who wrote it: a file can come from anyone, and only
 * `USER`, the person at the editor, can do what only a person can, such as changing the tags.
 */
export interface ImportOptions extends ExecuteOptions {
  readonly origin: Origin;
}

interface CommitOptions extends ExecuteOptions {
  /** No document that was valid may become invalid, see `brokenDocument`. */
  readonly checksDocuments?: boolean;
  /** For taking changes back, which is not something to undo in turn. */
  readonly takesBack?: {
    readonly entries: readonly UndoEntry[];
    /** Where the way to do it again goes. */
    readonly to: UndoEntry[];
    /** What it comes to. Undefined when only a part of it goes back, which nobody can tell. */
    readonly facts: readonly ClipFact[] | undefined;
    readonly direction: "undo" | "redo";
  };
}

/**
 * Why something stays when a change is taken back: somebody else changed it, or it would leave
 * something pointing at nothing.
 */
export type UndoObstacle = "changed" | "inUse";

export type { CommandFailure };

/** What became of a command, by name only, for whoever keeps track of how the editor runs. */
export interface CommandOutcome {
  readonly commands: readonly string[];
  /** A person, an AI task, or the editor itself. */
  readonly by: "user" | "ai" | "other";
  readonly ok: boolean;
  /** It only checked, and wrote nothing. */
  readonly dryRun?: boolean;
  /** Why it said no. `threw` when it went wrong instead, with what it threw as `error`. */
  readonly code?: string;
  readonly error?: unknown;
}

export type CommandResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly results: readonly unknown[];
      readonly patches: readonly Patch[];
      /** The project after the change; for a dry run, what it would be. */
      readonly state: ProjectState;
    }
  | { readonly ok: false; readonly error: CommandFailure };

/** What became of a file, see importFile(). */
export type ImportResult =
  | (Extract<CommandResult, { ok: true }> & {
      /** What people should know about the file, such as fades it still says the old way. */
      readonly problems: readonly Problem[];
    })
  | { readonly ok: false; readonly error: CommandFailure };

/**
 * How a batch of files comes in. Like a file, it has to say who changed it, see `ImportOptions`.
 * Changes in the folder are nobody's in particular: each batch gets an origin of its own, see
 * `folderBatch`, so that it can be taken back as a whole with `undoOrigin`. The same goes for a
 * batch from the repository on GitHub, see `repoBatch`.
 */
export interface MergeOptions {
  readonly origin: Origin;
  /**
   * What each file of the folder outside the batch holds, which is its base: the merge has to know
   * what the folder still has, to tell what only the editor took away. See `BaseOf`. Whoever does
   * not know what those files hold, as the platform for a repository, leaves it out: then whatever
   * could be there counts as there, which keeps more of the editor's side.
   */
  readonly baseOf: BaseOf | undefined;
  /**
   * Where the files of assets are kept as counts for the copy the batch is from, see `Here`: the
   * same as it was written out with, as `{ repo }` for the repository on GitHub, so that assets.json
   * reads the same on both sides. Undefined counts every place, as a folder is written.
   */
  readonly here?: Here;
  /** Runs every check and writes nothing. */
  readonly dryRun?: boolean;
}

/** What became of a batch of files, see mergeFiles(). */
export type MergeResult =
  | (Extract<CommandResult, { ok: true }> & {
      /** For each file, what became of it and what its base is from now on. */
      readonly files: readonly MergedFile[];
      /** Conflicts, what waits for people and why. */
      readonly problems: readonly Problem[];
      /** What both sides changed, each in its own way, where the editor's stayed. */
      readonly conflicts: readonly MergeConflict[];
      /** What only people can change, which stayed. */
      readonly kept: readonly Path[];
      /** What the folder took away that is still in use, which stays until people decide. */
      readonly held: readonly Path[];
    })
  | {
      readonly ok: false;
      readonly error: CommandFailure;
      /** Nothing came in: each file keeps its base. */
      readonly files: readonly MergedFile[];
    };

/** What came of taking something back or doing it again. */
export type UndoResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly patches: readonly Patch[];
      /** What stayed as it is, because it can no longer go back. */
      readonly kept: readonly Path[];
      /** Why, when something did. */
      readonly obstacle?: UndoObstacle;
    }
  | { readonly ok: false; readonly error: CommandFailure };

/**
 * What came of taking back, or doing again, several AI tasks or batches at once, see `undoOrigins`:
 * what each of them came to, in the order they went, as `undoOrigin` or `redoOrigin` would have
 * said one after the other. For a dry run, what each would come to, and nothing is written.
 */
export type ManyUndoResult =
  | {
      readonly ok: true;
      readonly each: readonly { readonly origin: Origin; readonly result: UndoResult }[];
    }
  | { readonly ok: false; readonly error: CommandFailure };

/** A change that is being made here, which knows more about itself than the document does. */
export interface LocalChange {
  readonly origin: Origin;
  /** It takes something back or does it again, so it is no new step. */
  readonly takesBack: "undo" | "redo" | undefined;
  /**
   * What it does to clips. Undefined when nobody can say: only a part of something goes back, or a
   * file has nothing but its outcome.
   */
  readonly facts: readonly ClipFact[] | undefined;
  /** Stands for this change in the history. */
  readonly step: number;
  /** What it takes back, when that is one step. */
  readonly back: number | undefined;
}

/** Where one change wrote, and who made it, see `ProjectStore.changesSince`. */
export interface ChangeRecord {
  readonly revision: number;
  readonly origin: Origin;
  /**
   * Where it wrote. A change of very many paths, such as the first one from a platform, keeps one
   * of each object instead, see `objectOfPath`.
   */
  readonly paths: readonly Path[];
  /** It took changes of `origin` back, or did them again: that is people's doing. */
  readonly takesBack?: "undo" | "redo";
}

/** How many origins `beforeAfterOf` keeps what it worked out of. */
const MOST_BEFORE_AFTERS = 20;

/** How many paths one record keeps before it keeps one of each object. */
const MAX_RECORDED_PATHS = 500;

export interface HistoryEntry {
  readonly revision: number;
  readonly origin: Origin;
  /** The commands that made up this change. */
  readonly commands: readonly string[];
  readonly patches: readonly Patch[];
  readonly time: number;
}

interface Write {
  readonly revision: number;
  readonly origin: Origin;
  /** It took a change back or did it again, which only people ask for, whatever its origin. */
  readonly takesBack?: true;
}

/** What it takes to undo one change. */
interface UndoEntry {
  /** Counts up with every entry, so it says what came later whatever the log has forgotten. */
  readonly serial: number;
  /**
   * When it was made, in milliseconds since 1970, later than every entry this store knew then. It
   * lasts across a reload and comes along from other windows, which serials do not: see
   * `undoOrigins`, which goes by it to take back the newest first.
   */
  readonly made: number;
  readonly steps: readonly Step[];
  /** What the change did to clips, if that is known. */
  readonly facts: readonly ClipFact[] | undefined;
  /**
   * What pointed at nothing around these steps before and after the change, see `danglingAt`. A
   * file can do that, and going back to how things were is not what makes it worse.
   */
  readonly danglingBefore: readonly string[];
  readonly danglingAfter: readonly string[];
}

/**
 * Whether undoOrigin() or redoOrigin() can do something for an origin now, see `undoOutlook`.
 * `blocked` says why nothing of it would go back, where that is so.
 */
export interface UndoOutlook {
  readonly direction: "undo" | "redo" | undefined;
  readonly blocked?: UndoObstacle;
}

/** What was done and what was taken back, for the person or for one AI task. */
interface UndoLog {
  done: UndoEntry[];
  undone: UndoEntry[];
}

/** What taking these changes back does to clips, if all of them are known. */
function factsOf(entries: readonly UndoEntry[]): readonly ClipFact[] | undefined {
  const facts: ClipFact[] = [];
  for (const entry of entries) {
    if (!entry.facts) return undefined;
    facts.push(...entry.facts);
  }
  return factsTakenBack(facts);
}

const keyOf = (path: Path) => path.join("\n");

/**
 * The steps going back that would hand back what another step of the same changes wrote, at or
 * above their place, while that one stays. What they hand back is something those changes did on
 * the way and then wrote over, which nobody ever saw: a part that a cut made starts as a copy of the
 * whole clip, and loses the effects that do not work in it. When people changed that part since,
 * it stays as they saw it, and so do the steps that made it so; giving it back the blur it was
 * copied with would change the picture of a clip that is theirs now. Something written by anyone
 * else in between is not this: that goes back to them. Nor is what these changes wrote about such a
 * part in the versions of its timeline at the same time.
 */
function onKept(steps: readonly Step[], back: ReadonlySet<Step>): readonly Step[] {
  const kept = new Map<WriteId, Set<string>>();
  for (const step of steps) {
    const { by } = step.left;
    if (back.has(step) || by === undefined) continue;
    let places = kept.get(by);
    if (!places) kept.set(by, (places = new Set()));
    places.add(keyOf(writePathOf(step.patch.path)));
  }
  if (kept.size === 0) return [];
  const keptBy = (by: WriteId | undefined, path: Path) =>
    by !== undefined && kept.get(by)?.has(keyOf(path)) === true;
  return steps.filter((step) => {
    if (!back.has(step)) return false;
    const where = writePathOf(step.patch.path);
    if (where.some((_, index) => keptBy(step.replaced.by, where.slice(0, index + 1)))) return true;
    // What versions change about a clip that stays, made with it: the part a cut made has what
    // the versions changed about the whole clip, such as another fit when it is vertical.
    const [timelines, timeline, overrides, , clips, clip] = step.patch.path;
    return (
      timelines === "timelines" &&
      overrides === "overrides" &&
      clips === "clips" &&
      timeline !== undefined &&
      clip !== undefined &&
      keptBy(step.left.by, ["timelines", timeline, "clips", clip])
    );
  });
}

/** Means something to every object, so it stays out, whatever a document holds. */
const UNSAFE_KEY = "__proto__";

/** Puts the fields of something in its map. See `flat` in structure.ts for the levels without one. */
function fill(map: Y.Map<unknown>, path: Path, value: object): void {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const child = [...path, key];
    if (isFlat(child)) fillFlat(map, [key], child, item);
    else map.set(key, toYjs(child, item));
  }
}

/** Puts what flat levels hold in the map above them, one value at a time. */
function fillFlat(map: Y.Map<unknown>, parts: Path, path: Path, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (isStanding(path)) map.set(flatKey(parts), {});
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const child = [...path, key];
    if (isFlat(child)) fillFlat(map, [...parts, key], child, item);
    else map.set(flatKey([...parts, key]), toYjs(child, item));
  }
}

function toYjs(path: Path, value: unknown): unknown {
  if (path[0] === "files" && path.length === 2) return new Y.Text(value as string);
  if (!isContainer(path) || typeof value !== "object" || value === null) return value;
  const map = new Y.Map<unknown>();
  fill(map, path, value);
  return map;
}

/** How far down a path the maps of their own go: what is below sits flat in the last of them. */
function mapDepth(path: Path): number {
  let depth = path.length - 1;
  while (depth > 0 && isFlat(path.slice(0, depth))) depth -= 1;
  return depth;
}

/**
 * A value of flat levels, by its path from the map they sit in. An older document keeps it in maps
 * of those levels instead, one inside the other, which only count where nothing has been written
 * since: the key of its own is always the newer one.
 */
function readFlat(map: Y.Map<unknown>, parts: Path): unknown {
  const key = flatKey(parts);
  if (map.has(key)) return map.get(key);
  const [level = "", ...rest] = parts;
  const old = rest.length > 0 ? map.get(level) : undefined;
  return old instanceof Y.Map ? readFlat(old as Y.Map<unknown>, rest) : undefined;
}

/** Takes a value of flat levels out of the maps an older document keeps for them. */
function forgetOld(map: Y.Map<unknown>, parts: Path): void {
  const [level = "", ...rest] = parts;
  const old = rest.length > 0 ? map.get(level) : undefined;
  if (!(old instanceof Y.Map)) return;
  // Such a map can itself have values that sit flat, from the time when only the lower levels did.
  (old as Y.Map<unknown>).delete(flatKey(rest));
  forgetOld(old as Y.Map<unknown>, rest);
}

type Tree = Record<string, unknown>;

function putIn(tree: Tree, parts: Path, value: unknown): void {
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    node = typeof next === "object" && next !== null ? (next as Tree) : (node[part] = {});
  }
  node[parts.at(-1) as string] = value;
}

/**
 * Everything flat levels hold in a map, as levels inside of levels, the way the state has them.
 * The map is one of its own at a path, or one that an older document has for a flat level there.
 * Levels without a value are not there at all.
 */
function readFlatAll(map: Y.Map<unknown>, path: Path): Tree {
  const tree: Tree = {};
  // Maps of an older document first: what has a key of its own is newer.
  map.forEach((item, key) => {
    const level = [...path, key];
    if (key === UNSAFE_KEY || !isFlat(level) || flatParts(path, key)) return;
    const inner = item instanceof Y.Map ? readFlatAll(item as Y.Map<unknown>, level) : {};
    // A standing level is there with its key, whatever is in it. See `standing` in structure.ts.
    if (Object.keys(inner).length > 0 || isStanding(level)) tree[key] = inner;
  });
  map.forEach((item, key) => {
    const parts = flatParts(path, key);
    if (parts && !parts.includes(UNSAFE_KEY)) {
      putIn(tree, parts, toState([...path, ...parts], item));
    }
  });
  return tree;
}

/** Something in the document the way the rest of the code sees it. */
function toState(path: Path, value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString();
  if (!(value instanceof Y.Map)) return value;
  const map = value as Y.Map<unknown>;
  const state: Tree = {};
  map.forEach((item, key) => {
    const child = [...path, key];
    if (key !== UNSAFE_KEY && !isFlat(child) && !flatParts(path, key) && !isRetired(child)) {
      state[key] = toState(child, item);
    }
  });
  return Object.assign(state, readFlatAll(map, path));
}

/** What the state has at a path, read from the document. */
function readAt(root: Y.Map<unknown>, path: Path): unknown {
  const depth = mapDepth(path);
  let map = root;
  for (const key of path.slice(0, depth)) {
    const next = map.get(key);
    if (!(next instanceof Y.Map)) return undefined;
    map = next as Y.Map<unknown>;
  }
  const parts = path.slice(depth);
  if (parts.length === 1 && !isFlat(path)) return toState(path, map.get(parts[0] as string));
  if (!isFlat(path)) return readFlat(map, parts);
  // A whole level, which only an older document changes like that. It is somewhere in all of this.
  return getIn(readFlatAll(map, path.slice(0, depth)), parts);
}

/** Where a key of a map in the document is in the state, and what is there now. */
function readChange(root: Y.Map<unknown>, map: Y.Map<unknown>, path: Path, key: string) {
  const parts = flatParts(path, key);
  const where = parts ? [...path, ...parts] : [...path, key];
  // What sits flat can be in more than one place, so it has to be looked for from the top.
  if (parts || isFlat(where)) return { path: where, value: readAt(root, where) };
  return { path: where, value: toState(where, map.get(key)) };
}

/** Changes a text as little as possible, so that it merges with edits made at the same time. */
function editText(target: Y.Text, next: string): void {
  const current = target.toString();
  const { start, end } = editSpan(current, next);
  target.delete(start, current.length - start - end);
  target.insert(start, next.slice(start, next.length - end));
}

/** Applies what it can. Returns how many updates were damaged. */
function applyAll(doc: Y.Doc, updates: readonly Uint8Array[], origin: string): number {
  let damaged = 0;
  for (const update of updates) {
    try {
      Y.applyUpdate(doc, update, origin);
    } catch {
      damaged += 1;
    }
  }
  return damaged;
}

/**
 * Whether a document of the project could no longer be written after a change, that could before.
 * It reads the whole project, so it is only for what can come apart: part of a change going back,
 * where what stays can be what the rest needs, such as the kind of a track for its other fields.
 */
function breaksDocuments(before: ProjectState, after: ProjectState): boolean {
  const invalid = stateToProject(after).problems;
  if (invalid.length === 0) return false;
  const known = new Set(stateToProject(before).problems.map(({ file }) => file));
  return invalid.some(({ file }) => !known.has(file));
}

/** Combines updates into one, without opening the project. All of them have to be intact. */
export const mergeUpdates = (updates: readonly Uint8Array[]): Uint8Array =>
  Y.mergeUpdates([...updates]);

const plain = (code: FailureCode): CommandFailure => ({ code, params: {} });

const MISSING_UPDATES = plain("missing-updates");
const PROJECT_LOCKED = plain("project-locked");
/** Nothing may change the project for now, see `ProjectStore.readOnly`. */
const READ_ONLY = plain("read-only");
const NOTHING_TO_UNDO = plain("nothing-to-undo");
/** What keeps no undo log only writes down where files are, see `STORAGE`. */
const STORAGE_ONLY = plain("storage-only");
const ONE_BY_ONE = plain("undo-one-by-one");
const NOTHING_DONE: UndoResult = { ok: false, error: NOTHING_TO_UNDO };

/** Nothing of it can go back, and why. */
const blockedBy = ({
  kept,
  obstacle,
}: {
  readonly kept: readonly Path[];
  readonly obstacle: UndoObstacle;
}): UndoResult => ({
  ok: false,
  error: { code: "undo-blocked", params: {}, conflicts: [...kept], obstacle },
});

/** How many characters the epoch of a revision has, see `RevisionId`. */
const EPOCH_LENGTH = 4;

/** A new epoch, different for every store that opens, see `RevisionId`. */
const newEpoch = (): string => newId("epoch").slice(-EPOCH_LENGTH);

/** What a hidden parameter, by its path such as `changes.path`, was given in parameters. */
function givenAt(params: unknown, name: string): unknown {
  let value = params;
  for (const key of name.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * A project while it is open. Yjs holds the truth, so that changes from other people and devices
 * arrive the same way as local ones. All changes come in through execute() and importFile().
 */
export class ProjectStore {
  readonly doc: Y.Doc;
  readonly #root: Y.Map<unknown>;
  readonly #listeners = new Set<() => void>();
  readonly #watchers = new Set<(outcome: CommandOutcome) => void>();
  readonly #undo = new Map<Origin, UndoLog>();
  /** The batches of files from the folder that can be taken back, the oldest first. */
  readonly #batches: Origin[] = [];
  /** What the texts of files were read as, see `MergeMemory`. */
  readonly #read: MergeMemory = new Map();
  readonly #writes = new Map<string, Write>();
  readonly #removals = new Map<string, Write>();
  /** What everyone sees. */
  #state: ProjectState;
  /** What the document holds, which can have holes while an update is missing. */
  #latest: ProjectState;
  #revision = 0;
  /** See `RevisionId`. */
  readonly #epoch = newEpoch();
  #history: HistoryEntry[] = [];
  /** What every change wrote, whoever made it, also other windows and the platform: see `changesSince`. */
  #changes: ChangeRecord[] = [];
  /** The first revision after which `#changes` has every change. */
  #changesFrom = 0;
  /** Which write the document holds where. Only taking changes back needs this: see `Written`. */
  #written: Written = UNWRITTEN;
  /** The change being written here, which already knows what it wrote. */
  #writing: Y.Transaction | undefined;
  /** What an update from elsewhere writes, while `applyChecked` takes it in. */
  #watching: { readonly origin: Origin; readonly written: WrittenKey[] } | undefined;
  #change: LocalChange | undefined;
  /** The last number an undo entry got. */
  #serial = 0;
  /** When the last undo entry this store knows was made, see `UndoEntry.made`. */
  #made = 0;
  /** Whoever brings updates has said that what is missing is not coming. See catchUp(). */
  #isSettled = true;
  /** See `readOnly`. */
  #readOnly = false;
  /** See `refuse`. */
  #refusal: ((commands: readonly string[]) => CommandFailure | undefined) | undefined;
  /** The names of writes in saved undo logs, both ways, see `saveUndo`. */
  readonly #names = new Map<WriteId, string>();
  readonly #named = new Map<string, WriteId>();
  /** Different for every store, so that names of writes from two of them never meet. */
  readonly #namePrefix = newId("writes");
  /** When the last undo record this store knows was saved, see `UndoRecord.at`. */
  #savedAt = 0;
  /** See `undoOutlook`. */
  readonly #outlooks = new Map<Origin, { readonly at: string; readonly outlook: UndoOutlook }>();
  /** See `beforeAfterOf`. */
  readonly #beforeAfters = new Map<Origin, { readonly at: string; readonly value: BeforeAfter }>();

  /** Opens a document that already has content, such as one that came from the platform. */
  constructor(doc: Y.Doc) {
    this.doc = doc;
    // Only the platform writes as the platform, see `writeAsPlatform`. Yjs draws ids by chance.
    while (doc.clientID === PLATFORM_CLIENT)
      doc.clientID = 1 + Math.floor(Math.random() * 0xffff_fffe);
    this.#root = doc.getMap<unknown>(ROOT);
    this.#state = toState([], this.#root) as ProjectState;
    this.#latest = this.#state;
    this.#root.observeDeep(this.#onChange);
  }

  /** Reads a folder. Unreadable documents stay out and are reported, the rest opens. */
  static open(files: ProjectFiles): { store?: ProjectStore; problems: readonly Problem[] } {
    const { project, problems } = readProject(files);
    if (!project) return { problems };
    const sources = [...files].filter(([path]) => isSourceFile(path));
    return { store: ProjectStore.create(project, Object.fromEntries(sources)), problems };
  }

  /**
   * Opens a project from saved updates. A damaged update is skipped, because the others are still
   * worth having. Without a manifest there is nothing to open.
   */
  static fromUpdates(updates: readonly Uint8Array[]): { store?: ProjectStore; damaged: number } {
    const doc = new Y.Doc();
    const damaged = applyAll(doc, updates, LOAD);
    if (!doc.getMap<unknown>(ROOT).has("manifest")) return { damaged };
    return { store: new ProjectStore(doc), damaged };
  }

  static create(project: Project, files: Readonly<Record<string, string>> = {}): ProjectStore {
    const doc = new Y.Doc();
    const root = doc.getMap<unknown>(ROOT);
    doc.transact(() => fill(root, [], projectToState(project, files)), LOAD);
    return new ProjectStore(doc);
  }

  /** The whole project as one update, to save it. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Takes in changes that were made somewhere else. When one of them needs an earlier one, the
   * document can have holes: a field that was overwritten is gone, but the new value is still
   * waiting. Until that is over or catchUp() says it never will be, the project shows the last
   * whole state and takes no changes. A hole would stop whatever draws the project, and from the
   * undo history it would end up in the document, for good.
   */
  applyUpdates(updates: readonly Uint8Array[]): void {
    if (updates.length === 0) return;
    this.#isSettled = false;
    applyAll(this.doc, updates, REMOTE);
    this.#show();
  }

  /**
   * Takes in changes from the platform, as its update with this number there. They count as changes
   * of somebody else, as from another window, and still reach `onLocalUpdate`: this browser has to
   * keep them, while whoever sends changes to the platform must not send them back. Resolves to
   * false when one of them could not be read: then nothing says the project has what came up to
   * `seq`.
   */
  applyCloud(updates: readonly Uint8Array[], seq: number): boolean {
    if (updates.length === 0) return true;
    const before = this.missingKey;
    const origin = cloudOrigin(seq);
    // One change of the project, however many updates: as one entry of the log, and drawn once.
    let damaged = 0;
    this.doc.transact(() => {
      damaged = applyAll(this.doc, updates, origin);
    }, origin);
    // Only what these leave waiting holds the project back: a gap it had before and went on
    // without, as of a damaged log, stays one it goes on without.
    if (this.missingKey !== before) this.#isSettled = false;
    this.#show();
    return damaged === 0;
  }

  /**
   * Takes in an update from elsewhere as `origin`, for a copy that checks what it takes, such as the
   * working copy on a platform. Resolves to what it changed, as an update of its own, or undefined
   * when the project had all of it. Throws what Yjs throws for a damaged update: check updates with
   * `checkUpdate` first, as a damaged one can leave a part of itself behind.
   */
  applyChecked(update: Uint8Array, origin: Origin): CheckedChange {
    let delta: Uint8Array | undefined;
    const onUpdate = (made: Uint8Array, from: unknown) => {
      if (from === origin) delta = made;
    };
    const watching = { origin, written: [] as WrittenKey[] };
    this.#watching = watching;
    this.doc.on("update", onUpdate);
    try {
      this.#isSettled = false;
      Y.applyUpdate(this.doc, update, origin);
    } finally {
      this.doc.off("update", onUpdate);
      this.#watching = undefined;
      this.#show();
    }
    return { delta, written: watching.written };
  }

  /**
   * Writes what `write` does as the platform, with `PLATFORM_CLIENT` as the client id of Yjs, and
   * goes back to the document's own id after it: a merge from GitHub, and whatever else the platform
   * changes itself. That is what makes a person's change of the same key, made where the change of
   * the platform had not arrived yet, win over it when the two meet, see `PLATFORM_CLIENT`.
   *
   * Only for the working copy on the platform, of which there is one at a time, and only once it
   * has every update: Yjs numbers what a client writes one after the other from what the document
   * has of it, so a second copy writing as the platform at the same time, or a copy without some of
   * what the platform wrote before, would give two different changes the same number, and one of
   * them would never arrive anywhere. It throws then, without writing anything. The id is set only
   * while `write` runs, which is all at once: an update from elsewhere that numbered something as
   * the document's own would make Yjs draw another id, see `Transaction.js`.
   */
  writeAsPlatform<T>(write: () => T): T {
    const own = this.doc.clientID;
    if (own === PLATFORM_CLIENT) throw new Error("This copy writes as the platform already");
    if (this.isMissingUpdates) {
      throw new Error("A copy that waits for updates cannot write as the platform");
    }
    this.doc.clientID = PLATFORM_CLIENT;
    try {
      return write();
    } finally {
      this.doc.clientID = own;
    }
  }

  /** What this project has, as Yjs counts it, see `isAhead`. */
  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * What this project has that a copy with this state vector does not, as one update: only what is
   * whole, never a change that waits for one that is not here. It always has everything that was
   * taken away, which a state vector does not show.
   */
  diffSince(stateVector: Uint8Array): Uint8Array {
    return this.#withoutWaiting(() => Y.encodeStateAsUpdate(this.doc, stateVector));
  }

  /** Whether this project has every piece of an update in it, not waiting for anything. */
  hasAllOf(update: Uint8Array): boolean {
    try {
      // Up to where each client goes: also one whose first piece in it is not its first one.
      const { to } = Y.parseUpdateMeta(update);
      const mine = Y.decodeStateVector(Y.encodeStateVector(this.doc));
      for (const [client, clock] of to) if (clock > (mine.get(client) ?? 0)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** The whole project as one update, without what waits for a change that is not here. */
  encodeWhole(): Uint8Array {
    return this.#withoutWaiting(() => Y.encodeStateAsUpdate(this.doc));
  }

  /** Everything that was taken away in this project, as an update that has nothing else. */
  deletions(): Uint8Array {
    return this.#withoutWaiting(() =>
      Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.doc)),
    );
  }

  /**
   * What waits for a change that has not come, as a key that stays the same while that does, or
   * undefined when nothing waits.
   */
  get missingKey(): string | undefined {
    const { pendingStructs, pendingDs } = this.doc.store;
    if (pendingStructs === null && pendingDs === null) return undefined;
    const missing = pendingStructs ? [...pendingStructs.missing].toSorted(([a], [b]) => a - b) : [];
    return JSON.stringify([missing, pendingDs === null ? 0 : pendingDs.length]);
  }

  /**
   * Yjs adds what waits for a missing change to everything it encodes. A copy elsewhere would wait
   * for it as well, forever, where the change is gone for good, as from a damaged log.
   */
  #withoutWaiting<T>(run: () => T): T {
    const { store } = this.doc;
    const { pendingStructs, pendingDs } = store;
    store.pendingStructs = null;
    store.pendingDs = null;
    try {
      return run();
    } finally {
      store.pendingStructs = pendingStructs;
      store.pendingDs = pendingDs;
    }
  }

  /**
   * Takes in all there is of a project. What is still missing now is not coming, and the project
   * goes on with what it has: a damaged log must not lock people out of their work.
   */
  catchUp(updates: readonly Uint8Array[]): void {
    applyAll(this.doc, updates, REMOTE);
    this.#isSettled = true;
    this.#show();
  }

  /** Whether a change is waiting for an earlier one that has not arrived. */
  get isMissingUpdates(): boolean {
    const { pendingStructs, pendingDs } = this.doc.store;
    return pendingStructs !== null || pendingDs !== null;
  }

  /**
   * This project and the given updates as one update, to shorten a log. It goes through the open
   * document rather than `mergeUpdates`, which does not notice damaged updates: they would end up
   * inside the result and take the rest of the project with them.
   */
  mergeWith(updates: readonly Uint8Array[]): Uint8Array {
    this.catchUp(updates);
    return this.encodeState();
  }

  /**
   * Calls back with every change made here, for saving and for sending to others, with who made it.
   * Changes from the platform come here too, see `applyCloud`, but not those of other windows.
   */
  onLocalUpdate(listener: (update: Uint8Array, origin: Origin) => void): () => void {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && origin !== LOAD) {
        listener(update, typeof origin === "string" ? origin : NOBODY);
      }
    };
    this.doc.on("update", onUpdate);
    return () => this.doc.off("update", onUpdate);
  }

  /**
   * Hears what became of every command that runs here, also of those that only check. Returns how to
   * stop. A listener that fails changes nothing about the command.
   */
  watchCommands(listener: (outcome: CommandOutcome) => void): () => void {
    this.#watchers.add(listener);
    return () => this.#watchers.delete(listener);
  }

  #tell(outcome: CommandOutcome): void {
    for (const watcher of this.#watchers) {
      try {
        watcher(outcome);
      } catch {
        // Watchers only keep track, and have to look after their own failures: the command stands.
      }
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * The project now, or the last time it was whole. It never changes in place, and what did not
   * change keeps its identity.
   */
  getState = (): ProjectState => this.#state;

  get revision(): number {
    return this.#revision;
  }

  /** The revision as whoever is outside of the editor holds it, see `RevisionId`. */
  get revisionId(): RevisionId {
    return `${this.#epoch}:${this.#revision}`;
  }

  /**
   * The count of a revision of this store, or undefined for one of another epoch, or one it never
   * had: a reload, another window, a count it has not come to.
   */
  revisionOf(revision: Revision): number | undefined {
    if (typeof revision === "number") return revision <= this.#revision ? revision : undefined;
    const at = revision.lastIndexOf(":");
    const count = Number(revision.slice(at + 1));
    if (at < 0 || revision.slice(0, at) !== this.#epoch) return undefined;
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#revision) return undefined;
    return count;
  }

  /**
   * Whether nothing may change the project for now: commands, files that are taken in, undo and
   * redo all fail with "read-only", whoever asks, and the history stays as it is. What other
   * windows and the platform already did still comes in, see `applyUpdates`. For a project that
   * cannot be edited while it is so, as one of a platform whose repository cannot be used.
   */
  get readOnly(): boolean {
    return this.#readOnly;
  }

  set readOnly(value: boolean) {
    this.#readOnly = value;
  }

  /**
   * Has every change from here on asked first: a failure refuses it, with the names of what it runs
   * (commands, or "file.import", "file.merge", "undo"). For what a project may not do here, such as
   * a temporary copy that takes no new assets, see `ProjectCopy`. What other windows and the platform
   * did still comes in, as with `readOnly`.
   */
  refuse(refusal: (commands: readonly string[]) => CommandFailure | undefined): void {
    this.#refusal = refusal;
  }

  /** What listeners are hearing about, if it was made here. */
  get change(): LocalChange | undefined {
    return this.#change;
  }

  /** The latest changes, newest last. For showing what happened and who did it. */
  get history(): readonly HistoryEntry[] {
    return this.#history;
  }

  /**
   * Every change after a revision of this store, oldest first, with who made it and where it wrote:
   * also those of other windows and the platform, which the history does not have. Undefined when
   * the record no longer goes back that far, so that nobody takes "nothing changed" from it.
   */
  changesSince(revision: Revision): readonly ChangeRecord[] | undefined {
    const since = this.revisionOf(revision);
    if (since === undefined || since < this.#changesFrom) return undefined;
    return this.#changes.filter((change) => change.revision > since);
  }

  execute(call: CommandCall, options: ExecuteOptions = {}): CommandResult {
    return this.executeBatch([call], options);
  }

  /**
   * Runs commands as one change: all of them happen, or none. A failure says which one it was,
   * as `index`. No document that was valid may become invalid, see `brokenDocument`.
   */
  executeBatch(calls: readonly CommandCall[], options: ExecuteOptions = {}): CommandResult {
    const origin = options.origin ?? USER;
    const checked = { ...options, checksDocuments: true };
    return this.#commit(
      calls.map((call) => call.type),
      origin,
      checked,
      (draft) =>
        calls.map((call, index) => {
          try {
            const command = operationOf(call.type);
            if (!command) {
              throw new CommandError({ code: "unknown-command", params: { command: call.type } });
            }
            return this.#runCommand(command, call, draft);
          } catch (error) {
            if (error instanceof CommandError) throw new BatchFailure(failureOf(error, index));
            throw error;
          }
        }),
    );
  }

  /**
   * Takes in a file that changed outside of the editor, as a whole or not at all. See
   * planFileImport. Who wrote the file has to be said, see `ImportOptions`.
   */
  importFile(path: string, text: string, options: ImportOptions): ImportResult {
    // Code that does not say who wrote the file gets nothing that only a person can do.
    const origin = (options as ImportOptions | undefined)?.origin ?? NOBODY;
    if (origin === STORAGE) return { ok: false, error: STORAGE_ONLY };
    const given = { ...options, origin };
    let told: readonly Problem[] = [];
    const result = this.#commit(["file.import"], origin, given, (draft) => {
      this.#assertUnlocked(draft);
      draft.knowsOnlyOutcome();
      const planned = planFileImport(draft, path, text);
      if (planned.problems.length > 0) {
        const failure = {
          code: "invalid-file" as const,
          params: { path },
          problems: planned.problems,
        };
        throw new BatchFailure(failure);
      }
      told = planned.notices;
      return [];
    });
    return result.ok ? { ...result, problems: told } : result;
  }

  /**
   * Takes in a batch of files that changed outside of the editor as one change, see planMerge: what
   * Git, another editor or an AI tool did to the project folder. Each file says what it held when
   * the editor last wrote or read it, and only what changed from there comes in, on top of what the
   * project has now, so what the editor has not written yet stays. Where both changed the same thing,
   * the editor's stays. The result says for each file what its base is from now on. Nothing comes in
   * when the project is locked, or the batch would break it, and nothing when the merge itself goes
   * wrong: it never throws. Who changed the files has to be said, see `MergeOptions`. The last
   * `MAX_BATCHES` batches can be taken back, each as a whole, with undoOrigin().
   */
  mergeFiles(changes: readonly FileChange[], options: MergeOptions): MergeResult {
    if (!isBatch(changes)) {
      return { ok: false, error: { code: "invalid-batch", params: {} }, files: [] };
    }
    // Code that does not say who changed the files gets nothing that only a person can do.
    const origin = (options as MergeOptions | undefined)?.origin ?? NOBODY;
    if (origin === STORAGE)
      return { ok: false, error: STORAGE_ONLY, files: unmergedFiles(changes) };
    const given = { origin, ...(options?.dryRun === true && { dryRun: true }) };
    let merge: FileMerge = { files: [], problems: [], conflicts: [], kept: [], held: [] };
    const result = this.#commit(["file.merge"], origin, given, (draft) => {
      this.#assertUnlocked(draft);
      draft.knowsOnlyOutcome();
      // Code that does not say what the folder has gets the merge that assumes the most.
      const baseOf = typeof options?.baseOf === "function" ? options.baseOf : undefined;
      const here = options?.here;
      try {
        merge = planMerge(draft, changes, { baseOf, memory: this.#read, here });
      } catch (error) {
        if (error instanceof CommandError) throw error;
        // Nothing is written of a draft that did not get through, so the project stays as it is.
        const detail = error instanceof Error ? error.message : String(error);
        const message = `合并时出了错，这一批没有并入：${detail}`;
        throw new BatchFailure({
          code: "merge-failed",
          params: { detail },
          problems: [{ severity: "error", code: "merge-failed", file: "", message }],
        });
      }
      if (merge.refusal) throw new BatchFailure(merge.refusal);
      return [];
    });
    if (!result.ok) return { ...result, files: unmergedFiles(changes) };
    if (result.patches.length > 0 && options?.dryRun !== true) this.#rememberBatch(origin);
    const { files, problems, conflicts, kept, held } = merge;
    return { ...result, files, problems, conflicts, kept, held };
  }

  /**
   * Takes the other side of conflicts of a merge, as `conflict.take` does, for whoever is no person:
   * the platform, right after it merged a batch from GitHub into a project whose people want what
   * came from GitHub kept where both sides changed the same thing, as the same origin (see
   * `project_repos.prefer` on the platform). Each conflict goes on its own, with the checks of the
   * command: one that cannot be taken stays as it is. Only for batches of files. Resolves to those
   * that it took.
   */
  takeConflicts(conflicts: readonly MergeConflict[], origin: Origin): readonly MergeConflict[] {
    if (!isFileBatch(origin)) return [];
    const taken: MergeConflict[] = [];
    for (const conflict of conflicts) {
      const result = this.#commit(
        ["conflict.take"],
        origin,
        { origin, checksDocuments: true },
        (draft) => {
          this.#assertUnlocked(draft);
          takeTheirs(draft, conflict);
          return [];
        },
      );
      if (result.ok) taken.push(conflict);
    }
    return taken;
  }

  /** Only the last few batches of files can be taken back: the oldest goes, with all of its log. */
  #rememberBatch(origin: Origin): void {
    if (!isFileBatch(origin)) return;
    const known = this.#batches.indexOf(origin);
    if (known >= 0) this.#batches.splice(known, 1);
    this.#batches.push(origin);
    while (this.#batches.length > MAX_BATCHES) {
      const oldest = this.#batches.shift();
      if (oldest !== undefined) this.#undo.delete(oldest);
    }
  }

  get canUndo(): boolean {
    return (this.#undo.get(USER)?.done.length ?? 0) > 0;
  }

  get canRedo(): boolean {
    return (this.#undo.get(USER)?.undone.length ?? 0) > 0;
  }

  /**
   * The change of the person that undo would take back, to tell what came before what. Zero when
   * there is none. It stands for a place in the history, which keeps working when old changes go.
   */
  get lastStep(): number {
    return this.#undo.get(USER)?.done.at(-1)?.serial ?? 0;
  }

  /**
   * Takes back the last change of the person. What others changed since then stays. When that is
   * all of it, nothing happens, the step is gone and the result says so: the next one is for the
   * person to ask for, because it would change something they are not looking at.
   */
  undo(): UndoResult {
    return this.#stepBack(USER, "done", "undone");
  }

  redo(): UndoResult {
    return this.#stepBack(USER, "undone", "done");
  }

  /** Takes back everything an AI task did in one step. What others changed since then stays. */
  undoTask(task: string): UndoResult {
    return this.undoOrigin(aiTask(task));
  }

  redoTask(task: string): UndoResult {
    return this.redoOrigin(aiTask(task));
  }

  /**
   * Takes back everything that came from somewhere other than the person in one step: an AI task,
   * a batch of files from the folder. What others changed since then stays. The person's own
   * changes go back one at a time, with undo().
   */
  undoOrigin(origin: Origin): UndoResult {
    if (origin === USER) return { ok: false, error: ONE_BY_ONE };
    const refusal = this.#whyNotNow;
    if (refusal) return { ok: false, error: refusal };
    const log = this.#undo.get(origin);
    const entries = log?.done.splice(0) ?? [];
    if (!log || entries.length === 0) return { ok: false, error: NOTHING_TO_UNDO };
    return this.#takeBack(entries, log.undone, origin, "undo");
  }

  /** Does again what undoOrigin() took back. */
  redoOrigin(origin: Origin): UndoResult {
    if (origin === USER) return { ok: false, error: ONE_BY_ONE };
    return this.#stepBack(origin, "undone", "done");
  }

  /** Whether undoOrigin() has anything to take back. The log lives as long as this store. */
  canUndoOrigin(origin: Origin): boolean {
    return origin !== USER && (this.#undo.get(origin)?.done.length ?? 0) > 0;
  }

  /** Whether redoOrigin() has anything to do again. */
  canRedoOrigin(origin: Origin): boolean {
    return origin !== USER && (this.#undo.get(origin)?.undone.length ?? 0) > 0;
  }

  /**
   * Takes back everything several AI tasks or batches did, each in one step as undoOrigin() does,
   * the newest first, whatever order they come in: what one of them took back can hand a place back
   * to the one before it, which can then take it back too. It comes to the same as undoOrigin() for
   * each of them, one after the other, the newest first, and each is a change of its own. With
   * `dryRun`, it works out what each of them would come to, on top of what the ones before it would
   * have done, and writes nothing: the same steps go back as without it.
   */
  undoOrigins(
    origins: readonly Origin[],
    options: { readonly dryRun?: boolean } = {},
  ): ManyUndoResult {
    return this.#many(origins, "undo", options.dryRun === true);
  }

  /**
   * Does again what undoOrigins() took back, the one taken back last first, which is the oldest:
   * the same as redoOrigin() for each, one after the other.
   */
  redoOrigins(
    origins: readonly Origin[],
    options: { readonly dryRun?: boolean } = {},
  ): ManyUndoResult {
    return this.#many(origins, "redo", options.dryRun === true);
  }

  #many(origins: readonly Origin[], direction: "undo" | "redo", dryRun: boolean): ManyUndoResult {
    if (origins.includes(USER)) return { ok: false, error: ONE_BY_ONE };
    const refusal = this.#whyNotNow;
    if (refusal) return { ok: false, error: refusal };
    const order = this.#newestFirst(origins, direction);
    if (!dryRun) {
      const go = (origin: Origin) =>
        direction === "undo" ? this.undoOrigin(origin) : this.redoOrigin(origin);
      return { ok: true, each: order.map((origin) => ({ origin, result: go(origin) })) };
    }
    // As the store would be after each of them, without writing it: see #takeBack.
    let state = this.#state;
    let written = this.#written;
    const each = order.map((origin) => {
      const log = this.#undo.get(origin);
      const entries = (direction === "undo" ? log?.done : log?.undone.slice(-1)) ?? [];
      if (entries.length === 0) return { origin, result: NOTHING_DONE };
      const plan = this.#planBack(entries, origin, state, written);
      if (plan.back.size === 0) return { origin, result: blockedBy(plan) };
      const draft = new Draft(state, origin, written);
      for (const step of plan.back) draft.takeBack(step);
      state = draft.state;
      written = draft.written;
      const result: UndoResult = {
        ok: true,
        revision: this.#revision,
        patches: draft.steps.map((step) => step.patch),
        kept: plan.kept,
        ...(plan.kept.length > 0 ? { obstacle: plan.obstacle } : {}),
      };
      return { origin, result };
    });
    return { ok: true, each };
  }

  /**
   * The origins with something to take back, or do again, the one whose last change of that came
   * last first. Each one only once, and those with nothing at the end.
   */
  #newestFirst(origins: readonly Origin[], direction: "undo" | "redo"): readonly Origin[] {
    const lastOf = (origin: Origin) => {
      const log = this.#undo.get(origin);
      return (direction === "undo" ? log?.done : log?.undone)?.at(-1);
    };
    const unique = [...new Set(origins)];
    const some = unique.filter((origin) => lastOf(origin) !== undefined);
    some.sort((a, b) => {
      const one = lastOf(a) as UndoEntry;
      const other = lastOf(b) as UndoEntry;
      return other.made - one.made || other.serial - one.serial;
    });
    return [...some, ...unique.filter((origin) => lastOf(origin) === undefined)];
  }

  /**
   * Whether an AI task or a batch can be taken back now, or done again, and whether all of it would
   * stay where it is, because everything it wrote was changed since or is in use. It works that out
   * as undoOrigin() would, so it is only for one that people look at.
   */
  undoOutlook(origin: Origin): UndoOutlook {
    const log = origin === USER ? undefined : this.#undo.get(origin);
    const direction: UndoOutlook["direction"] =
      (log?.done.length ?? 0) > 0 ? "undo" : (log?.undone.length ?? 0) > 0 ? "redo" : undefined;
    if (!log || !direction) return { direction };
    const entries = direction === "undo" ? log.done : log.undone.slice(-1);
    const at = `${this.#revision}:${entries.map(({ serial }) => serial).join(",")}`;
    const known = this.#outlooks.get(origin);
    if (known?.at === at) return known.outlook;
    const { back, obstacle } = this.#planBack(entries, origin);
    const outlook: UndoOutlook = back.size === 0 ? { direction, blocked: obstacle } : { direction };
    this.#outlooks.set(origin, { at, outlook });
    return outlook;
  }

  /**
   * What the changes of an AI task or a batch were, from its undo log, see `beforeAfter`: the project
   * as it is now, with the places it wrote holding what was there before it, and what it wrote
   * there. What somebody changed since at one of those places shows what this one wrote, done or
   * taken back. Only reads: nothing new is kept for it. Undefined where this store has no log of it,
   * as on another device or once the log went.
   */
  beforeAfterOf(origin: Origin): BeforeAfter | undefined {
    const log = origin === USER ? undefined : this.#undo.get(origin);
    if (!log || log.done.length + log.undone.length === 0) return undefined;
    const serials = (entries: readonly UndoEntry[]) =>
      entries.map(({ serial }) => serial).join(",");
    const at = `${this.#revision}:${serials(log.done)}:${serials(log.undone)}`;
    const known = this.#beforeAfters.get(origin);
    if (known?.at === at) return known.value;
    const value = beforeAfter(this.#state, log.done, log.undone);
    // The ones looked at last: a conversation has a card for each task, and few are open at once.
    this.#beforeAfters.delete(origin);
    this.#beforeAfters.set(origin, { at, value });
    if (this.#beforeAfters.size > MOST_BEFORE_AFTERS) {
      const [oldest] = this.#beforeAfters.keys();
      if (oldest !== undefined) this.#beforeAfters.delete(oldest);
    }
    return value;
  }

  /** The AI tasks and batches whose changes can be taken back or done again as a whole. */
  get loggedOrigins(): readonly Origin[] {
    return [...this.#undo.keys()].filter((origin) => origin !== USER);
  }

  /** Forgets what it takes to take back the changes of an origin, as if it never had any. */
  forgetUndo(origin: Origin): void {
    if (origin === USER) return;
    this.#undo.delete(origin);
    this.#outlooks.delete(origin);
    this.#beforeAfters.delete(origin);
    const known = this.#batches.indexOf(origin);
    if (known >= 0) this.#batches.splice(known, 1);
  }

  /**
   * What it takes to take back the changes of an origin, or do them again, after this project was
   * closed and opened again, see `UndoRecord`. Undefined where there is nothing of it to keep.
   */
  saveUndo(origin: Origin): UndoRecord | undefined {
    const log = origin === USER ? undefined : this.#undo.get(origin);
    if (!log || log.done.length + log.undone.length === 0) return undefined;
    const writes = new WriteTree(this.#written);
    const marks: Marks = new Map();
    const saveEntry = (entry: UndoEntry): SavedEntry => ({
      steps: entry.steps.map((step) => {
        const where = writePathOf(step.patch.path);
        marksAround(this.#root, where, marks);
        return {
          patch: step.patch,
          inverse: step.inverse,
          replaced: this.#saveWritten(step.replaced),
          left: this.#saveWritten(step.left),
          now: this.#saveWritten(writes.at(where)),
        };
      }),
      facts: entry.facts ?? null,
      made: entry.made,
      danglingBefore: entry.danglingBefore,
      danglingAfter: entry.danglingAfter,
    });
    this.#savedAt = Math.max(Date.now(), this.#savedAt + 1);
    return {
      format: UNDO_FORMAT,
      origin,
      at: this.#savedAt,
      done: log.done.map(saveEntry),
      undone: log.undone.map(saveEntry),
      marks: [...marks.values()].map(({ path, mark }) => [path, mark] as const),
      doc: { manifest: documentMark(this.#root), formatVersion: CURRENT_FORMAT_VERSION },
    };
  }

  /**
   * Takes up what `saveUndo` saved, so that those changes can be taken back or done again here as in
   * the store that saved them: where the document still has what it had then, the steps can go back;
   * what was written since, here or anywhere else, stays, as it would there. For each place the
   * steps are about, what a record knew counts where its marks are still those of the document: a
   * record saved earlier than another one, whatever the order they come in, takes nothing from it.
   * Only where no record has the marks the document has now was something written by somebody else.
   * A record of an origin that this store has a log of already counts only with `replace`, for one
   * that another window saved after it took back or did again some of it. Records that are not of
   * this document, or of another format of the project, or that this editor cannot read, are left
   * out, each on its own. Resolves to the origins that it took up.
   */
  restoreUndo(
    records: readonly unknown[],
    { replace = false }: { readonly replace?: boolean } = {},
  ): readonly Origin[] {
    interface Taken {
      readonly origin: Origin;
      readonly at: number;
      readonly log: UndoLog;
      readonly marks: ReadonlyMap<string, Mark>;
      readonly places: ReadonlyMap<string, { readonly where: Path; readonly now: SavedWritten }>;
    }
    const taken: Taken[] = [];
    // The marks the document has now around each place, which every record is compared with.
    const around = new Map<string, Marks>();
    const marksNow = (where: Path): Marks => {
      const key = keyOf(where);
      let marks = around.get(key);
      if (!marks) {
        marks = new Map();
        marksAround(this.#root, where, marks);
        around.set(key, marks);
      }
      return marks;
    };
    for (const record of records) {
      try {
        if (!isUndoRecord(record) || !this.#isOfThisDocument(record)) continue;
        const { origin } = record;
        if (origin === USER || origin === STORAGE) continue;
        if (this.#undo.has(origin) && !replace) continue;
        const places = new Map<string, { readonly where: Path; readonly now: SavedWritten }>();
        for (const { steps } of [...record.done, ...record.undone]) {
          for (const step of steps) {
            const where = writePathOf(step.patch.path);
            places.set(keyOf(where), { where, now: step.now });
            marksNow(where);
          }
        }
        const serial = this.#serial;
        const toEntry = (saved: SavedEntry, index: number): UndoEntry => ({
          serial: serial + index + 1,
          // A record from before entries said when they were made: when it was saved.
          made: saved.made ?? record.at,
          steps: saved.steps.map((step) => ({
            patch: step.patch,
            inverse: step.inverse,
            replaced: this.#readWritten(step.replaced),
            left: this.#readWritten(step.left),
          })),
          facts: saved.facts ?? undefined,
          danglingBefore: saved.danglingBefore,
          danglingAfter: saved.danglingAfter,
        });
        const all = [...record.done, ...record.undone].map(toEntry);
        this.#serial += all.length;
        for (const { made } of all) this.#made = Math.max(this.#made, made);
        const log: UndoLog = {
          done: all.slice(0, record.done.length),
          undone: all.slice(record.done.length),
        };
        const marks = new Map(record.marks.map(([path, mark]) => [keyOf(path), mark]));
        taken.push({ origin, at: record.at, log, marks, places });
        this.#savedAt = Math.max(this.#savedAt, record.at);
      } catch {
        // One that cannot be taken up stays out; the rest still count.
      }
    }
    if (taken.length === 0) return [];
    // The one saved last counts the most, whatever order they came in.
    taken.sort((a, b) => a.at - b.at);

    // Whether a record knew a place as the document has it now: around it, nothing was written since.
    const isUnder = (path: Path, where: Path) => where.every((key, index) => path[index] === key);
    const knows = ({ marks }: Taken, where: Path): boolean => {
      for (const [key, { mark }] of marksNow(where)) if (marks.get(key) !== mark) return false;
      const now = marksNow(where);
      for (const key of marks.keys()) {
        if (!now.has(key) && isUnder(key.split("\n"), placePathOf(where))) return false;
      }
      return true;
    };
    const writes = new WriteTree(this.#written);
    const wheres = new Map<string, Path>();
    for (const { places } of taken) for (const [key, { where }] of places) wheres.set(key, where);
    const changed = new Map<string, Path>();
    const sure: Path[] = [];
    for (const where of [...wheres.values()].toSorted(byDepth((each) => each))) {
      const key = keyOf(where);
      const holding = taken.filter(({ places }) => places.has(key));
      const known = holding.findLast((each) => knows(each, where));
      // A place in one that a record knew as it is now is as that record had it, all of it.
      const isCovered = [...sure].some((above) => isUnder(where, above));
      if (isCovered && !known) continue;
      const from = known ?? (holding.at(-1) as Taken);
      writes.put(where, this.#readWritten((from.places.get(key) as { now: SavedWritten }).now));
      if (known) {
        sure.push(placePathOf(where));
        continue;
      }
      // Nobody knew it like this: what has a mark no record has was written by somebody else.
      for (const [inner, { path, mark }] of marksNow(where)) {
        if (!taken.some(({ marks }) => marks.get(inner) === mark)) changed.set(inner, path);
      }
      for (const [inner] of from.marks) {
        const path = inner.split("\n");
        if (!marksNow(where).has(inner) && isUnder(path, placePathOf(where))) {
          changed.set(inner, path);
        }
      }
    }
    for (const path of [...changed.values()].toSorted(byDepth((each) => each))) {
      writes.put(path, { by: Symbol("write") });
    }
    for (const { origin, log } of taken) {
      this.#undo.set(origin, log);
      if (isFileBatch(origin)) this.#rememberBatch(origin);
    }
    this.#written = writes.root;
    // What was written where is different now, for every origin.
    this.#outlooks.clear();
    return taken.map(({ origin }) => origin);
  }

  /**
   * Whether a record is of this document, and not of one made again from the same files: that has a
   * manifest of its own. A document that has less than the record knew of, as one whose last changes
   * were not saved, is still the same: the marks of the places it lacks are different.
   */
  #isOfThisDocument(record: UndoRecord): boolean {
    return (
      record.doc.manifest === documentMark(this.#root) &&
      record.doc.formatVersion === CURRENT_FORMAT_VERSION
    );
  }

  #saveWritten(written: Written): SavedWritten {
    const { by, below } = written;
    let name: string | null = null;
    if (by !== undefined) {
      name = this.#names.get(by) ?? `${this.#namePrefix}.${this.#names.size}`;
      this.#names.set(by, name);
      this.#named.set(name, by);
    }
    if (!below || below.size === 0) return { by: name };
    return {
      by: name,
      below: [...below].map(([key, inner]) => [key, this.#saveWritten(inner)] as const),
    };
  }

  #readWritten(saved: SavedWritten): Written {
    let by: WriteId | undefined;
    if (saved.by !== null) {
      by = this.#named.get(saved.by);
      if (by === undefined) {
        by = Symbol("write");
        this.#named.set(saved.by, by);
        this.#names.set(by, saved.by);
      }
    }
    if (!saved.below || saved.below.length === 0) return { by };
    const below = new Map(saved.below.map(([key, inner]) => [key, this.#readWritten(inner)]));
    return { by, below };
  }

  /**
   * The project as files. Documents that became invalid stay out and are reported. Where the files
   * of assets are kept goes by what counts `here`, see `Here`: everything that is written down,
   * where that is not said.
   */
  exportFiles(options: { readonly here?: Here } = {}): {
    files: Map<string, string>;
    problems: readonly Problem[];
  } {
    const { project, problems } = stateToProject(this.#state, options.here);
    const files = writeProject(project);
    for (const [path, text] of Object.entries(this.#state.files)) files.set(path, text);
    // What is written is often the base of the next merge, see `rememberWritten`.
    if (problems.length === 0) rememberWritten(this.#read, projectToState(project), files);
    return { files, problems };
  }

  destroy(): void {
    this.#root.unobserveDeep(this.#onChange);
    this.#listeners.clear();
  }

  get #isLocked(): boolean {
    return this.#state.manifest.tags?.some((tag) => tag.locked) === true;
  }

  /** Waiting for an update that should be on its way. */
  get #isBehind(): boolean {
    return !this.#isSettled && this.isMissingUpdates;
  }

  /** Shows what the document holds, unless the holes in it are about to be filled. */
  #show(): void {
    if (this.#isBehind || this.#state === this.#latest) return;
    this.#state = this.#latest;
    for (const listener of this.#listeners) listener();
  }

  #assertUnlocked(draft: Draft): void {
    if (draft.state.manifest.tags?.some((tag) => tag.locked)) {
      throw new CommandError({ code: "project-locked", params: {} });
    }
  }

  /** Why nothing can be taken back at the moment. The history stays as it is then. */
  get #whyNotNow(): CommandFailure | undefined {
    const refused = this.#refusal?.(["undo"]);
    if (refused) return refused;
    if (this.#readOnly) return READ_ONLY;
    if (this.#isBehind) return MISSING_UPDATES;
    return this.#isLocked ? PROJECT_LOCKED : undefined;
  }

  #runCommand(command: Operation, call: CommandCall, draft: Draft): unknown {
    if (!command.whileLocked) this.#assertUnlocked(draft);
    const isAlsoBy = (command.alsoBy ?? []).includes(draft.origin);
    const { name } = command;
    if (command.level === "human" && draft.origin !== USER && !isAlsoBy) {
      throw new CommandError({ code: "user-only", params: { command: name } });
    }
    // What keeps no undo log only does what it is there for.
    if (draft.origin === STORAGE && !isAlsoBy) {
      throw new CommandError({ code: "storage-only", params: { command: name } });
    }
    const params = command.params.safeParse(call.params ?? {});
    if (!params.success) {
      throw new CommandError({
        code: "invalid-params",
        params: { issues: paramIssues(params.error) },
      });
    }
    if (draft.origin !== USER) {
      const hidden = command.hiddenParams?.find(
        (param) => param.why === "human" && givenAt(params.data, param.name) !== undefined,
      );
      if (hidden) {
        throw new CommandError({
          code: "user-only",
          params: { command: name, param: hidden.name },
        });
      }
    }
    return command.run(draft, params.data);
  }

  #commit(
    commands: readonly string[],
    origin: Origin,
    options: CommitOptions,
    plan: (draft: Draft) => readonly unknown[],
  ): CommandResult {
    if (this.#watchers.size === 0) return this.#write(commands, origin, options, plan);
    const by = origin === USER ? "user" : origin.startsWith("ai:") ? "ai" : "other";
    const told = { commands, by, ...(options.dryRun && { dryRun: true }) } as const;
    let result: CommandResult;
    try {
      result = this.#write(commands, origin, options, plan);
    } catch (error) {
      this.#tell({ ...told, ok: false, code: "threw", error });
      throw error;
    }
    this.#tell({ ...told, ok: result.ok, ...(!result.ok && { code: result.error.code }) });
    return result;
  }

  #write(
    commands: readonly string[],
    origin: Origin,
    options: CommitOptions,
    plan: (draft: Draft) => readonly unknown[],
  ): CommandResult {
    const refused = this.#refusal?.(commands);
    if (refused) return { ok: false, error: refused };
    if (this.#readOnly) return { ok: false, error: READ_ONLY };
    if (this.#isBehind) return { ok: false, error: MISSING_UPDATES };
    const draft = new Draft(this.#state, origin, this.#written);
    let results: readonly unknown[];
    try {
      results = plan(draft);
    } catch (error) {
      if (error instanceof BatchFailure) return { ok: false, error: error.failure };
      if (error instanceof CommandError) return { ok: false, error: failureOf(error) };
      throw error;
    }

    const patches = draft.steps.map((step) => step.patch);
    if (options.checksDocuments) {
      const broken = brokenDocument(this.#state, draft.state, patches);
      if (broken) return { ok: false, error: broken };
    }
    if (options.baseRevision !== undefined) {
      const conflict = this.#findConflicts(patches, origin, options.baseRevision, options.isOwn);
      if (conflict) return { ok: false, error: conflict };
    }
    const unexpected = options.expect?.(patches);
    if (unexpected) return { ok: false, error: unexpected };
    if (options.dryRun || patches.length === 0) {
      return { ok: true, revision: this.#revision, results, patches, state: draft.state };
    }

    const entry = this.#entryOf(draft, options);
    const { takesBack } = options;
    this.#change = {
      origin,
      takesBack: takesBack?.direction,
      facts: entry.facts,
      step: entry.serial,
      back: takesBack?.entries.length === 1 ? takesBack.entries[0]?.serial : undefined,
    };
    try {
      this.doc.transact((transaction) => {
        this.#writing = transaction;
        for (const patch of patches) this.#apply(patch);
      }, origin);
    } finally {
      // A listener can fail, and the next change should not look like this one.
      this.#writing = undefined;
      this.#change = undefined;
    }
    this.#written = draft.written;
    // Yjs reports nothing about a field of something that went away in the same change.
    const write: Write = {
      revision: this.#revision,
      origin,
      ...(takesBack && { takesBack: true }),
    };
    for (const { path } of patches) this.#markWrite(path, write, false);

    // Where uploads put files is nothing to undo, see `STORAGE`: that keeps no log.
    if (takesBack) {
      takesBack.to.push(entry);
    } else if (origin !== STORAGE) {
      const log = this.#logOf(origin);
      log.done.push(entry);
      log.undone = [];
      // Everything an AI task does is undone at once, so its log has no limit.
      if (origin === USER && log.done.length > MAX_UNDO) log.done.shift();
    }

    this.#history.push({ revision: this.#revision, origin, commands, patches, time: Date.now() });
    if (this.#history.length > MAX_HISTORY) this.#history = this.#history.slice(-MAX_HISTORY);
    return { ok: true, revision: this.#revision, results, patches, state: this.#state };
  }

  /** What it takes to undo a change that is about to be written. */
  #entryOf(draft: Draft, { takesBack }: CommitOptions): UndoEntry {
    const { steps } = draft;
    this.#serial += 1;
    const serial = this.#serial;
    this.#made = Math.max(Date.now(), this.#made + 1);
    const made = this.#made;
    if (takesBack) {
      return {
        serial,
        made,
        steps,
        facts: takesBack.facts,
        danglingBefore: takesBack.entries.flatMap((entry) => entry.danglingAfter),
        danglingAfter: takesBack.entries.flatMap((entry) => entry.danglingBefore),
      };
    }
    const danglingIn = (state: ProjectState) =>
      steps.flatMap((step) => danglingAt(state, step.patch.path));
    return {
      serial,
      made,
      steps,
      facts: draft.facts,
      danglingBefore: danglingIn(this.#state),
      danglingAfter: danglingIn(draft.state),
    };
  }

  #logOf(origin: Origin): UndoLog {
    let log = this.#undo.get(origin);
    if (!log) {
      log = { done: [], undone: [] };
      this.#undo.set(origin, log);
    }
    return log;
  }

  /** Takes one change from a stack. It is gone from there, also if it can no longer go back. */
  #stepBack(origin: Origin, from: keyof UndoLog, to: keyof UndoLog): UndoResult {
    const refusal = this.#whyNotNow;
    if (refusal) return { ok: false, error: refusal };
    const log = this.#undo.get(origin);
    const entry = log?.[from].pop();
    if (!log || !entry) return { ok: false, error: NOTHING_TO_UNDO };
    return this.#takeBack([entry], log[to], origin, from === "done" ? "undo" : "redo");
  }

  /**
   * Which steps of these changes can go back, last one first. The document holds their write, and
   * nothing new ends up pointing at nothing: an AI task cannot take back the asset a person started
   * to use. What was like that before this, or when the change was made, is not this step's doing.
   * That can only be told from where all of them end up, because what points at something can come
   * back before the thing it points at. When that keeps a step here, others can depend on it, so it
   * takes another look.
   */
  #planBack(
    entries: readonly UndoEntry[],
    origin: Origin,
    state: ProjectState = this.#state,
    written: Written = this.#written,
  ) {
    const steps = entries.toReversed().flatMap((entry) => entry.steps.toReversed());
    const known = new Set(entries.flatMap((entry) => entry.danglingBefore));
    const stuck = new Set<Step>();
    // What stays, in the order it was written.
    const keptOf = (back: ReadonlySet<Step>): readonly Path[] => {
      const kept = new Map<string, Path>();
      for (const entry of entries) {
        for (const step of entry.steps) {
          if (!back.has(step)) kept.set(keyOf(step.patch.path), step.patch.path);
        }
      }
      return [...kept.values()];
    };
    // Steps that would hand back what a step of these changes wrote, which stays: see `onKept`.
    const held = new Set<Step>();
    for (;;) {
      const draft = new Draft(state, origin, written);
      const obstacle: UndoObstacle = stuck.size > 0 ? "inUse" : "changed";
      const back = steps.filter(
        (step) => !stuck.has(step) && !held.has(step) && draft.takeBack(step),
      );
      const onTop = onKept(steps, new Set(back));
      if (onTop.length > 0) {
        for (const step of onTop) held.add(step);
        continue;
      }
      const dangling = back.filter(({ patch }) => {
        const already = danglingAt(state, patch.path);
        return danglingAt(draft.state, patch.path).some(
          (link) => !known.has(link) && !already.includes(link),
        );
      });
      if (dangling.length === 0) {
        // What stays can be what the rest needs to be a valid document: then nothing goes back.
        const isPartly = back.length < steps.length;
        if (isPartly && breaksDocuments(state, draft.state)) {
          const none = new Set<Step>();
          return { back: none, obstacle, kept: keptOf(none) };
        }
        const all = new Set(back);
        return { back: all, obstacle, kept: keptOf(all) };
      }
      for (const step of dangling) stuck.add(step);
    }
  }

  /**
   * Writes back what these changes replaced, as a change like any other. Yjs has an undo of its
   * own, but it works on single fields and can leave a field with no value at all when two people
   * changed it at once. Here a field always gets a value back, or stays as it is.
   */
  #takeBack(
    entries: readonly UndoEntry[],
    to: UndoEntry[],
    origin: Origin,
    direction: "undo" | "redo",
  ): UndoResult {
    const plan = this.#planBack(entries, origin);
    const { back, obstacle, kept: paths } = plan;
    if (back.size === 0) return blockedBy(plan);
    const facts = paths.length === 0 ? factsOf(entries) : undefined;
    const takesBack = { entries, to, facts, direction };
    const result = this.#commit(["undo"], origin, { takesBack }, (draft) => {
      for (const step of back) draft.takeBack(step);
      return [];
    });
    if (!result.ok) return result;
    const { revision, patches } = result;
    return { ok: true, revision, patches, kept: paths, ...(paths.length ? { obstacle } : {}) };
  }

  /**
   * Conflicts are about what a command touches: changes elsewhere do not get in its way. The base
   * can be one for each path, see `ExecuteOptions.baseRevision`.
   */
  #findConflicts(
    patches: readonly Patch[],
    origin: Origin,
    given: NonNullable<ExecuteOptions["baseRevision"]>,
    isOwn: (origin: Origin) => boolean = () => false,
  ): CommandFailure | undefined {
    const stale = (revision: Revision): CommandFailure => ({
      code: "stale-revision",
      params: { given: String(revision), current: this.revisionId },
    });
    // One revision for everything has to be one of this store, also when nothing gets written.
    if (typeof given !== "function" && this.revisionOf(given) === undefined) return stale(given);
    const baseOf = typeof given === "function" ? given : () => given;
    const conflicts: Path[] = [];
    for (const { path } of patches) {
      const revision = baseOf(path);
      if (revision === undefined) continue;
      const base = this.revisionOf(revision);
      if (base === undefined) return stale(revision);
      const isNewer = (write: Write | undefined) =>
        write !== undefined &&
        write.revision > base &&
        write.origin !== origin &&
        (write.takesBack === true || !isOwn(write.origin));
      const isConflict =
        isNewer(this.#writes.get(keyOf(path))) ||
        path.some((_, index) => isNewer(this.#removals.get(keyOf(path.slice(0, index + 1)))));
      if (isConflict) conflicts.push(path);
    }
    if (conflicts.length === 0) return undefined;
    return { code: "conflict", params: {}, conflicts };
  }

  /** The map at a path. Only what every document has should have to be made here. */
  #mapAt(path: Path): Y.Map<unknown> {
    let map = this.#root;
    for (const key of path) {
      let next = map.get(key);
      if (!(next instanceof Y.Map)) {
        next = new Y.Map<unknown>();
        map.set(key, next);
      }
      map = next as Y.Map<unknown>;
    }
    return map;
  }

  #apply(patch: Patch): void {
    const { path } = patch;
    const depth = mapDepth(path);
    const map = this.#mapAt(path.slice(0, depth));
    const parts = path.slice(depth);
    const key = flatKey(parts);
    if (isStanding(path)) {
      // Only that it is there. The map of an older document says the same, together with what is in it.
      const old = map.get(key);
      const isOld = old instanceof Y.Map;
      if (patch.op !== "delete") {
        if (!isOld) map.set(key, {});
      } else if (!isOld || (old as Y.Map<unknown>).size === 0) {
        map.delete(key);
      }
      return;
    }
    switch (patch.op) {
      case "delete":
        map.delete(key);
        break;
      case "set":
        map.set(key, toYjs(path, patch.value));
        break;
      case "text": {
        const text = map.get(key);
        if (text instanceof Y.Text) editText(text, patch.value);
        else map.set(key, new Y.Text(patch.value));
        break;
      }
    }
    // From now on this value lives under a key of its own.
    forgetOld(map, parts);
  }

  /**
   * A standing level stays without its last entry while the document says it is there, and goes
   * when it does not. See `standing` in structure.ts.
   */
  #leaveStanding(mutator: Mutator<ProjectState>, path: Path): void {
    for (let length = path.length - 1; length > 0; length--) {
      const level = path.slice(0, length);
      if (!isFlat(level)) return;
      if (!isStanding(level)) continue;
      const left = getIn(mutator.root, level);
      if (typeof left !== "object" || left === null || Object.keys(left).length > 0) return;
      const depth = mapDepth(level);
      let map: unknown = this.#root;
      for (const key of level.slice(0, depth)) map = (map as Y.Map<unknown> | undefined)?.get(key);
      const isThere = map instanceof Y.Map && map.has(flatKey(level.slice(depth)));
      if (!isThere) mutator.delete(level);
      return;
    }
  }

  #markWrite(path: Path, write: Write, removed: boolean): void {
    for (let length = 1; length <= path.length; length++) {
      this.#writes.set(keyOf(path.slice(0, length)), write);
    }
    if (removed) this.#removals.set(keyOf(path), write);
  }

  /** Every change arrives here, whoever made it, so the state cannot drift from the document. */
  #onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void => {
    const isLoad = transaction.origin === LOAD;
    if (!isLoad) this.#revision += 1;
    const origin = typeof transaction.origin === "string" ? transaction.origin : "other";
    const local = transaction === this.#writing;
    const write: Write = {
      revision: this.#revision,
      origin,
      ...(local && this.#change?.takesBack !== undefined && { takesBack: true }),
    };
    const mutator = new Mutator(this.#latest);
    // What is written here comes with its steps, which know more: see #commit.
    const writes = new WriteTree(this.#written);
    const written = { by: Symbol("write") };
    const remember = (path: Path) => {
      if (transaction !== this.#writing) writes.put(path, written);
    };

    const watching = this.#watching?.origin === transaction.origin ? this.#watching : undefined;
    const paths: Path[] = [];
    for (const event of events) {
      const base = event.path.map(String);
      if (event.target instanceof Y.Text) {
        watching?.written.push({ path: base, raw: event.target });
        mutator.set(base, event.target.toString());
        remember(base);
        if (!isLoad) this.#markWrite(base, write, false);
        paths.push(base);
        continue;
      }
      const target = event.target as Y.Map<unknown>;
      event.changes.keys.forEach((change, key) => {
        const { path, value } = readChange(this.#root, target, base, key);
        if (watching && change.action !== "delete")
          watching.written.push({ path, raw: target.get(key) });
        if (path.includes(UNSAFE_KEY) || isRetired(path)) return;
        const removed = value === undefined;
        if (removed) mutator.delete(path);
        else mutator.set(path, value);
        if (removed) this.#leaveStanding(mutator, path);
        // That a standing level is there is written down apart from what is in it.
        const isOld = change.oldValue instanceof Y.Map || target.get(key) instanceof Y.Map;
        const where = isStanding(path) && !isOld ? writePathOf(path) : path;
        remember(where);
        if (!isLoad) this.#markWrite(where, write, removed || isContainer(where));
        paths.push(where);
      });
    }
    if (!isLoad) {
      const kept = paths.length > MAX_RECORDED_PATHS ? onePathEach(paths) : paths;
      const takesBack = local ? this.#change?.takesBack : undefined;
      this.#changes.push({
        revision: this.#revision,
        origin,
        paths: kept,
        ...(takesBack && { takesBack }),
      });
      if (this.#changes.length > MAX_HISTORY) {
        const gone = this.#changes.splice(0, this.#changes.length - MAX_HISTORY);
        this.#changesFrom = gone.at(-1)?.revision ?? this.#changesFrom;
      }
    }

    this.#written = writes.root;
    this.#latest = mutator.root;
    this.#show();
  };
}

/** Shorter paths first, for writing what is above before what is below. */
const byDepth =
  <T>(pathOf: (item: T) => Path) =>
  (a: T, b: T): number =>
    pathOf(a).length - pathOf(b).length;

/** One path of each object that paths are of, for a record of a change of very many. */
function onePathEach(paths: readonly Path[]): readonly Path[] {
  const seen = new Map<string, Path>();
  for (const path of paths) {
    const key = objectKey(objectOfPath(path));
    if (!seen.has(key)) seen.set(key, path);
  }
  return [...seen.values()];
}

/** Whether what came as a batch of files is one, from code that does not check its types. */
const isBatch = (changes: unknown): changes is readonly FileChange[] =>
  Array.isArray(changes) &&
  changes.every(
    (change: unknown) =>
      typeof change === "object" &&
      change !== null &&
      typeof (change as FileChange).path === "string" &&
      ["string", "undefined"].includes(typeof (change as FileChange).base) &&
      ["string", "undefined"].includes(typeof (change as FileChange).text),
  );

/** Why nothing of a change comes in, with all there is to say about it. */
class BatchFailure extends Error {
  readonly failure: CommandFailure;

  constructor(failure: CommandFailure) {
    super(failure.code);
    this.failure = failure;
  }
}
