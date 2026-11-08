import {
  readProject,
  writeProject,
  type Problem,
  type Project,
  type ProjectFiles,
} from "@animaquill/schema";
import * as Y from "yjs";
import { COMMANDS, type CommandDefinition } from "./commands.ts";
import { CommandError, Draft, factsTakenBack, type ClipFact, type Step } from "./draft.ts";
import { isSourceFile, planFileImport } from "./import-file.ts";
import {
  planMerge,
  rememberWritten,
  unmergedFiles,
  type BaseOf,
  type FileChange,
  type FileMerge,
  type MergeConflict,
  type MergedFile,
  type MergeMemory,
} from "./merge-files.ts";
import { projectToState, stateToProject, type ProjectState } from "./model.ts";
import { NOBODY, USER, aiTask, folderBatch, type Origin } from "./origin.ts";
import { Mutator, getIn, type Patch } from "./patch.ts";
import { danglingAt, touchesLockedTrack } from "./references.ts";
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
import { UNWRITTEN, WriteTree, type Written } from "./write-tree.ts";

export { USER, aiTask, folderBatch, type Origin };

const LOAD = "load";
const REMOTE = "remote";
const ROOT = "project";
const MAX_HISTORY = 1000;
const MAX_UNDO = 500;
/** How many batches of files from the folder can still be taken back, see mergeFiles(). */
export const MAX_BATCHES = 20;

export interface CommandCall {
  readonly type: string;
  readonly params?: unknown;
}

export interface ExecuteOptions {
  readonly origin?: Origin;
  /**
   * The revision the caller saw. A change somebody else made since then to the same property stops
   * the command. This is how a person's edit wins over an AI task that did not see it yet.
   */
  readonly baseRevision?: number;
  /** Runs every check and writes nothing. */
  readonly dryRun?: boolean;
}

/**
 * How a file comes in. There is no default for who wrote it: a file can come from anyone, and only
 * `USER`, the person at the editor, can do what only a person can, such as taking a lock off.
 */
export interface ImportOptions extends ExecuteOptions {
  readonly origin: Origin;
}

interface CommitOptions extends ExecuteOptions {
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
 * Why something stays when a change is taken back: somebody else changed it, it would leave
 * something pointing at nothing, or it is on a locked track.
 */
export type UndoObstacle = "changed" | "inUse" | "locked";

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  /** What changed in the meantime, for a conflict. */
  readonly conflicts?: readonly Path[];
  /** Why a change cannot be taken back. */
  readonly obstacle?: UndoObstacle;
  /** What is wrong with a file, for an import. */
  readonly problems?: readonly Problem[];
}

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
    }
  | { readonly ok: false; readonly error: CommandFailure };

/** What became of a file, see importFile(). */
export type ImportResult =
  | (Extract<CommandResult, { ok: true }> & {
      /** What the file would change on locked tracks, which stays as it is. */
      readonly kept: readonly Path[];
      /** The same for people and AI: a warning for each thing that stays, which says why. */
      readonly problems: readonly Problem[];
    })
  | { readonly ok: false; readonly error: CommandFailure };

/**
 * How a batch of files comes in. Like a file, it has to say who changed it, see `ImportOptions`.
 * Changes in the folder are nobody's in particular: each batch gets an origin of its own, see
 * `folderBatch`, so that it can be taken back as a whole with `undoOrigin`.
 */
export interface MergeOptions {
  readonly origin: Origin;
  /**
   * What each file of the folder outside the batch holds, which is its base: the merge has to know
   * what the folder still has, to tell what only the editor took away. See `BaseOf`.
   */
  readonly baseOf: BaseOf;
  /** Runs every check and writes nothing. */
  readonly dryRun?: boolean;
}

/** What became of a batch of files, see mergeFiles(). */
export type MergeResult =
  | (Extract<CommandResult, { ok: true }> & {
      /** For each file, what became of it and what its base is from now on. */
      readonly files: readonly MergedFile[];
      /** Conflicts, what locks kept, what waits for people and why. */
      readonly problems: readonly Problem[];
      /** What both sides changed, each in its own way, where the editor's stayed. */
      readonly conflicts: readonly MergeConflict[];
      /** What would change on locked tracks, or what only people can change, which stayed. */
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
}

/** What it takes to undo one change. */
interface UndoEntry {
  /** Counts up with every entry, so it says what came later whatever the log has forgotten. */
  readonly serial: number;
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

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Changes a text as little as possible, so that it merges with edits made at the same time. */
function editText(target: Y.Text, next: string): void {
  const current = target.toString();
  const shortest = Math.min(current.length, next.length);
  let start = 0;
  while (start < shortest && current[start] === next[start]) start++;
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < shortest - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  if (end > 0 && isHighSurrogate(next.charCodeAt(next.length - end - 1))) end--;
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

const COMMANDS_BY_TYPE = new Map(COMMANDS.map((command) => [command.type, command]));

const MISSING_UPDATES: CommandFailure = {
  code: "missing-updates",
  message: "别的窗口的改动还没有收全，等一下再试。一直这样的话，刷新页面",
};
const PROJECT_LOCKED: CommandFailure = {
  code: "project-locked",
  message: "项目有不可编辑的标签，要先移除标签",
};
const NOTHING_TO_UNDO: CommandFailure = { code: "nothing-to-undo", message: "没有可以撤销的步骤" };
const ONE_AT_A_TIME: CommandFailure = {
  code: "one-at-a-time",
  message: "自己的改动一步一步撤销",
};
const OBSTACLES: Readonly<Record<UndoObstacle, string>> = {
  changed: "这一步之后别人改过，已跳过",
  inUse: "这一步还被别的内容用着，或者用到的东西已经没了，已跳过",
  locked: "这一步在锁定的轨道上，已跳过",
};

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
  #history: HistoryEntry[] = [];
  /** Which write the document holds where. Only taking changes back needs this: see `Written`. */
  #written: Written = UNWRITTEN;
  /** The change being written here, which already knows what it wrote. */
  #writing: Y.Transaction | undefined;
  #change: LocalChange | undefined;
  /** The last number an undo entry got. */
  #serial = 0;
  /** Whoever brings updates has said that what is missing is not coming. See catchUp(). */
  #isSettled = true;

  /** Opens a document that already has content, such as one that came from the platform. */
  constructor(doc: Y.Doc) {
    this.doc = doc;
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

  /** Calls back with every change made here, for saving and for sending to others. */
  onLocalUpdate(listener: (update: Uint8Array) => void): () => void {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && origin !== LOAD) listener(update);
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

  /** What listeners are hearing about, if it was made here. */
  get change(): LocalChange | undefined {
    return this.#change;
  }

  /** The latest changes, newest last. For showing what happened and who did it. */
  get history(): readonly HistoryEntry[] {
    return this.#history;
  }

  execute(call: CommandCall, options: ExecuteOptions = {}): CommandResult {
    return this.executeBatch([call], options);
  }

  /** Runs commands as one change: all of them happen, or none. */
  executeBatch(calls: readonly CommandCall[], options: ExecuteOptions = {}): CommandResult {
    const origin = options.origin ?? USER;
    return this.#commit(
      calls.map((call) => call.type),
      origin,
      options,
      (draft) =>
        calls.map((call) => {
          const command = COMMANDS_BY_TYPE.get(call.type);
          if (!command) throw new CommandError("unknown-command", `没有这个命令：${call.type}`);
          return this.#runCommand(command, call, draft);
        }),
    );
  }

  /**
   * Takes in a file that changed outside of the editor. See planFileImport. What it would change on
   * a locked track stays as it is, and the result says what. Nothing of it comes in when that is all
   * it would change, or when the rest would break something without it: the result is a failure
   * that says why. Who wrote the file has to be said, see `ImportOptions`.
   */
  importFile(path: string, text: string, options: ImportOptions): ImportResult {
    // Code that does not say who wrote the file gets nothing that only a person can do.
    const origin = (options as ImportOptions | undefined)?.origin ?? NOBODY;
    const given = { ...options, origin };
    let kept: readonly Path[] = [];
    let told: readonly Problem[] = [];
    const result = this.#commit(["file.import"], origin, given, (draft) => {
      this.#assertUnlocked(draft);
      draft.knowsOnlyOutcome();
      const planned = planFileImport(draft, path, text);
      if (planned.problems.length > 0) {
        const message = "文件不符合项目格式，没有导入";
        throw new ImportRejected({ code: "invalid-file", message, problems: planned.problems });
      }
      ({ kept } = planned);
      const refused = (message: string, problems: readonly Problem[]) =>
        new ImportRejected({
          code: "track-locked",
          message,
          conflicts: kept,
          obstacle: "locked",
          problems,
        });
      if (planned.broken.length > 0) {
        const message =
          "文件里有些改动在锁定的轨道上，只导入其余的部分会让项目出错，整个文件没有导入";
        throw refused(message, [...planned.held, ...planned.broken]);
      }
      if (kept.length > 0 && draft.steps.length === 0) {
        throw refused("文件里的改动都在锁定的轨道上，没有生效", planned.held);
      }
      told = [...planned.held, ...planned.notices];
      return [];
    });
    return result.ok ? { ...result, kept, problems: told } : result;
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
      const message = "这一批文件的格式不对，没有并入";
      return { ok: false, error: { code: "invalid-batch", message }, files: [] };
    }
    // Code that does not say who changed the files gets nothing that only a person can do.
    const origin = (options as MergeOptions | undefined)?.origin ?? NOBODY;
    const given = { origin, ...(options?.dryRun === true && { dryRun: true }) };
    let merge: FileMerge = { files: [], problems: [], conflicts: [], kept: [], held: [] };
    const result = this.#commit(["file.merge"], origin, given, (draft) => {
      this.#assertUnlocked(draft);
      draft.knowsOnlyOutcome();
      // Code that does not say what the folder has gets the merge that assumes the most.
      const baseOf = typeof options?.baseOf === "function" ? options.baseOf : undefined;
      try {
        merge = planMerge(draft, changes, { baseOf, memory: this.#read });
      } catch (error) {
        if (error instanceof CommandError) throw error;
        // Nothing is written of a draft that did not get through, so the project stays as it is.
        const message = "合并时出了错，这一批没有并入";
        const detail = error instanceof Error ? error.message : String(error);
        throw new ImportRejected({
          code: "merge-failed",
          message,
          problems: [
            { severity: "error", code: "merge-failed", file: "", message: `${message}：${detail}` },
          ],
        });
      }
      if (merge.refusal) throw new ImportRejected(merge.refusal);
      return [];
    });
    if (!result.ok) return { ...result, files: unmergedFiles(changes) };
    if (result.patches.length > 0 && options?.dryRun !== true) this.#rememberBatch(origin);
    const { files, problems, conflicts, kept, held } = merge;
    return { ...result, files, problems, conflicts, kept, held };
  }

  /** Only the last few batches of files can be taken back: the oldest goes, with all of its log. */
  #rememberBatch(origin: Origin): void {
    if (!origin.startsWith(folderBatch(""))) return;
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
    if (origin === USER) return { ok: false, error: ONE_AT_A_TIME };
    const refusal = this.#whyNotNow;
    if (refusal) return { ok: false, error: refusal };
    const log = this.#undo.get(origin);
    const entries = log?.done.splice(0) ?? [];
    if (!log || entries.length === 0) return { ok: false, error: NOTHING_TO_UNDO };
    return this.#takeBack(entries, log.undone, origin, "undo");
  }

  /** Does again what undoOrigin() took back. */
  redoOrigin(origin: Origin): UndoResult {
    if (origin === USER) return { ok: false, error: ONE_AT_A_TIME };
    return this.#stepBack(origin, "undone", "done");
  }

  /** The project as files. Documents that became invalid stay out and are reported. */
  exportFiles(): { files: Map<string, string>; problems: readonly Problem[] } {
    const { project, problems } = stateToProject(this.#state);
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
      throw new CommandError(PROJECT_LOCKED.code, PROJECT_LOCKED.message);
    }
  }

  /** Why nothing can be taken back at the moment. The history stays as it is then. */
  get #whyNotNow(): CommandFailure | undefined {
    if (this.#isBehind) return MISSING_UPDATES;
    return this.#isLocked ? PROJECT_LOCKED : undefined;
  }

  #runCommand(command: CommandDefinition, call: CommandCall, draft: Draft): unknown {
    if (!command.whileLocked) this.#assertUnlocked(draft);
    if (command.userOnly && draft.origin !== USER) {
      throw new CommandError("user-only", `只有用户能运行这个命令：${command.type}`);
    }
    const params = command.params.safeParse(call.params ?? {});
    if (!params.success) {
      const issue = params.error.issues[0];
      throw new CommandError("invalid-params", `${issue?.path.join(".")}：${issue?.message}`);
    }
    if (draft.origin !== USER) {
      const given = params.data as Record<string, unknown>;
      const name = command.userOnlyParams?.find((param) => given[param] !== undefined);
      if (name) throw new CommandError("user-only", `只有用户能用这个参数：${name}`);
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
    if (this.#isBehind) return { ok: false, error: MISSING_UPDATES };
    const draft = new Draft(this.#state, origin, this.#written);
    let results: readonly unknown[];
    try {
      results = plan(draft);
    } catch (error) {
      if (error instanceof ImportRejected) return { ok: false, error: error.failure };
      if (error instanceof CommandError) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      throw error;
    }

    const patches = draft.steps.map((step) => step.patch);
    if (options.baseRevision !== undefined) {
      const conflict = this.#findConflicts(patches, origin, options.baseRevision);
      if (conflict) return { ok: false, error: conflict };
    }
    if (options.dryRun || patches.length === 0) {
      return { ok: true, revision: this.#revision, results, patches };
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
    const write = { revision: this.#revision, origin };
    for (const { path } of patches) this.#markWrite(path, write, false);

    if (takesBack) {
      takesBack.to.push(entry);
    } else {
      const log = this.#logOf(origin);
      log.done.push(entry);
      log.undone = [];
      // Everything an AI task does is undone at once, so its log has no limit.
      if (origin === USER && log.done.length > MAX_UNDO) log.done.shift();
    }

    this.#history.push({ revision: this.#revision, origin, commands, patches, time: Date.now() });
    if (this.#history.length > MAX_HISTORY) this.#history = this.#history.slice(-MAX_HISTORY);
    return { ok: true, revision: this.#revision, results, patches };
  }

  /** What it takes to undo a change that is about to be written. */
  #entryOf(draft: Draft, { takesBack }: CommitOptions): UndoEntry {
    const { steps } = draft;
    this.#serial += 1;
    const serial = this.#serial;
    if (takesBack) {
      return {
        serial,
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
   * Which steps of these changes can go back, last one first. The document holds their write, they
   * stay out of locked tracks, which protect their content from everyone, and nothing new ends up
   * pointing at nothing: an AI task cannot take back the asset a person started to use. What was
   * like that before this, or when the change was made, is not this step's doing. That can only be
   * told from where all of them end up, because what points at something can come back before the
   * thing it points at. When that keeps a step here, others can depend on it, so it takes another
   * look. Locks go step by step, because going back can also be what opens or closes one.
   */
  #planBack(entries: readonly UndoEntry[], origin: Origin) {
    const steps = entries.toReversed().flatMap((entry) => entry.steps.toReversed());
    const known = new Set(entries.flatMap((entry) => entry.danglingBefore));
    const stuck = new Set<Step>();
    for (;;) {
      const draft = new Draft(this.#state, origin, this.#written);
      let obstacle: UndoObstacle = stuck.size > 0 ? "inUse" : "changed";
      const back = steps.filter((step) => {
        if (stuck.has(step)) return false;
        if (step.pastLock || !touchesLockedTrack(draft.state, step.inverse)) {
          return draft.takeBack(step);
        }
        obstacle = "locked";
        return false;
      });
      const dangling = back.filter(({ patch }) => {
        const already = danglingAt(this.#state, patch.path);
        return danglingAt(draft.state, patch.path).some(
          (link) => !known.has(link) && !already.includes(link),
        );
      });
      if (dangling.length === 0) {
        // What stays can be what the rest needs to be a valid document: then nothing goes back.
        const isPartly = back.length < steps.length;
        if (isPartly && breaksDocuments(this.#state, draft.state)) {
          return { back: new Set<Step>(), obstacle };
        }
        return { back: new Set(back), obstacle };
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
    const { back, obstacle } = this.#planBack(entries, origin);
    const kept = new Map<string, Path>();
    for (const { steps } of entries) {
      for (const step of steps) {
        if (!back.has(step)) kept.set(keyOf(step.patch.path), step.patch.path);
      }
    }
    const paths = [...kept.values()];
    if (back.size === 0) {
      const message = OBSTACLES[obstacle];
      return { ok: false, error: { code: "undo-blocked", message, conflicts: paths, obstacle } };
    }
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

  /** Conflicts are about what a command touches: changes elsewhere do not get in its way. */
  #findConflicts(
    patches: readonly Patch[],
    origin: Origin,
    base: number,
  ): CommandFailure | undefined {
    if (base > this.#revision) {
      return { code: "stale-revision", message: "这个版本号不属于当前的项目，要重新读取" };
    }
    const isNewer = (write: Write | undefined) =>
      write !== undefined && write.revision > base && write.origin !== origin;
    const conflicts = patches
      .map((patch) => patch.path)
      .filter((path) => {
        if (isNewer(this.#writes.get(keyOf(path)))) return true;
        return path.some((_, index) =>
          isNewer(this.#removals.get(keyOf(path.slice(0, index + 1)))),
        );
      });
    if (conflicts.length === 0) return undefined;
    return { code: "conflict", message: "这些内容已经被别人改过，要重新读取", conflicts };
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
    const write = { revision: this.#revision, origin };
    const mutator = new Mutator(this.#latest);
    // What is written here comes with its steps, which know more: see #commit.
    const writes = new WriteTree(this.#written);
    const written = { by: Symbol("write") };
    const remember = (path: Path) => {
      if (transaction !== this.#writing) writes.put(path, written);
    };

    for (const event of events) {
      const base = event.path.map(String);
      if (event.target instanceof Y.Text) {
        mutator.set(base, event.target.toString());
        remember(base);
        if (!isLoad) this.#markWrite(base, write, false);
        continue;
      }
      const target = event.target as Y.Map<unknown>;
      event.changes.keys.forEach((change, key) => {
        const { path, value } = readChange(this.#root, target, base, key);
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
      });
    }

    this.#written = writes.root;
    this.#latest = mutator.root;
    this.#show();
  };
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

/** Why nothing of a file comes in. */
class ImportRejected extends Error {
  readonly failure: CommandFailure;

  constructor(failure: CommandFailure) {
    super(failure.message);
    this.failure = failure;
  }
}
