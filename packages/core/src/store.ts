import {
  readProject,
  writeProject,
  type Problem,
  type Project,
  type ProjectFiles,
} from "@animaquill/schema";
import * as Y from "yjs";
import { COMMANDS, type CommandDefinition } from "./commands.ts";
import { CommandError, Draft, type Step } from "./draft.ts";
import { isSourceFile, planFileImport } from "./import-file.ts";
import { projectToState, stateToProject, type ProjectState } from "./model.ts";
import { Mutator, deepEqual, getIn, type Patch } from "./patch.ts";
import { flatEntry, flatKey, isContainer, isFlat, type Path } from "./structure.ts";

/** Who a change comes from. Every change in the document carries this. */
export type Origin = string;

export const USER: Origin = "user";
export const aiTask = (task: string): Origin => `ai:${task}`;

const LOAD = "load";
const REMOTE = "remote";
const ROOT = "project";
const MAX_HISTORY = 1000;
const MAX_UNDO = 500;

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

interface CommitOptions extends ExecuteOptions {
  /** Undoing is not something to undo in turn: the caller keeps track of it. */
  readonly isUndo?: boolean;
}

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  /** What changed in the meantime, for a conflict. */
  readonly conflicts?: readonly Path[];
  /** What is wrong with a file, for an import. */
  readonly problems?: readonly Problem[];
}

export type CommandResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly results: readonly unknown[];
      readonly patches: readonly Patch[];
    }
  | { readonly ok: false; readonly error: CommandFailure };

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
  readonly steps: readonly Step[];
}

/** What was done and what was taken back, for the person or for one AI task. */
interface UndoLog {
  done: UndoEntry[];
  undone: UndoEntry[];
}

const keyOf = (path: Path) => path.join("\n");

/** Means something to every object, so it stays out, whatever a document holds. */
const UNSAFE_KEY = "__proto__";

/** Puts the fields of something in its map. See `flat` in structure.ts for the levels without one. */
function fill(map: Y.Map<unknown>, path: Path, value: object): void {
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const child = [...path, key];
    if (isFlat(child)) {
      for (const [entry, inner] of Object.entries(item as object)) {
        if (inner !== undefined) map.set(flatKey(key, entry), inner);
      }
    } else {
      map.set(key, toYjs(child, item));
    }
  }
}

function toYjs(path: Path, value: unknown): unknown {
  if (path[0] === "files" && path.length === 2) return new Y.Text(value as string);
  if (!isContainer(path) || typeof value !== "object" || value === null) return value;
  const map = new Y.Map<unknown>();
  fill(map, path, value);
  return map;
}

/** The map a document from before flat levels has for this level. */
function oldMap(map: Y.Map<unknown>, level: string): Y.Map<unknown> | undefined {
  const old = map.get(level);
  return old instanceof Y.Map ? (old as Y.Map<unknown>) : undefined;
}

/** An entry of a flat level. An old map only counts where nothing has been written since. */
function readEntry(map: Y.Map<unknown>, level: string, entry: string): unknown {
  const key = flatKey(level, entry);
  return map.has(key) ? map.get(key) : oldMap(map, level)?.get(entry);
}

/** All entries of the flat levels of a map, by level. */
function readEntries(map: Y.Map<unknown>, path: Path): ReadonlyMap<string, Map<string, unknown>> {
  const levels = new Map<string, Map<string, unknown>>();
  const entriesOf = (level: string) => {
    const entries = levels.get(level) ?? new Map<string, unknown>();
    levels.set(level, entries);
    return entries;
  };
  map.forEach((item, key) => {
    if (isFlat([...path, key]) && item instanceof Y.Map) {
      const entries = entriesOf(key);
      (item as Y.Map<unknown>).forEach((inner, entry) => {
        if (entry !== UNSAFE_KEY && !entries.has(entry)) entries.set(entry, inner);
      });
    }
  });
  map.forEach((item, key) => {
    const found = flatEntry(path, key);
    if (found && found[1] !== UNSAFE_KEY) entriesOf(found[0]).set(found[1], item);
  });
  return levels;
}

/** Something in the document the way the rest of the code sees it. */
function toState(path: Path, value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString();
  if (!(value instanceof Y.Map)) return value;
  const entries: (readonly [string, unknown])[] = [];
  (value as Y.Map<unknown>).forEach((item, key) => {
    const child = [...path, key];
    if (key !== UNSAFE_KEY && !isFlat(child) && !flatEntry(path, key)) {
      entries.push([key, toState(child, item)]);
    }
  });
  for (const [level, items] of readEntries(value as Y.Map<unknown>, path)) {
    if (items.size > 0) entries.push([level, Object.fromEntries(items)]);
  }
  return Object.fromEntries(entries);
}

/** What a key of a map in the document comes to in the state. */
function readChange(map: Y.Map<unknown>, path: Path, key: string) {
  const entry = flatEntry(path, key);
  if (entry) {
    const [level, name] = entry;
    return { path: [...path, level, name], value: readEntry(map, level, name) };
  }
  const owner = map.parent;
  if (isFlat(path) && owner instanceof Y.Map) {
    const value = readEntry(owner as Y.Map<unknown>, path.at(-1) as string, key);
    return { path: [...path, key], value };
  }
  const child = [...path, key];
  if (isFlat(child)) {
    const items = readEntries(map, path).get(key);
    return { path: child, value: items?.size ? Object.fromEntries(items) : undefined };
  }
  return { path: child, value: toState(child, map.get(key)) };
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

/** Combines updates into one, without opening the project. All of them have to be intact. */
export const mergeUpdates = (updates: readonly Uint8Array[]): Uint8Array =>
  Y.mergeUpdates([...updates]);

const COMMANDS_BY_TYPE = new Map(COMMANDS.map((command) => [command.type, command]));

/**
 * A project while it is open. Yjs holds the truth, so that changes from other people and devices
 * arrive the same way as local ones. All changes come in through execute() and importFile().
 */
export class ProjectStore {
  readonly doc: Y.Doc;
  readonly #root: Y.Map<unknown>;
  readonly #listeners = new Set<() => void>();
  readonly #undo = new Map<Origin, UndoLog>();
  readonly #writes = new Map<string, Write>();
  readonly #removals = new Map<string, Write>();
  #state: ProjectState;
  #revision = 0;
  #history: HistoryEntry[] = [];
  #lastEntry: UndoEntry | undefined;

  /** Opens a document that already has content, such as one that came from the platform. */
  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.#root = doc.getMap<unknown>(ROOT);
    this.#state = toState([], this.#root) as ProjectState;
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

  /** Takes in changes that were made somewhere else. */
  applyUpdates(updates: readonly Uint8Array[]): void {
    applyAll(this.doc, updates, REMOTE);
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
    this.applyUpdates(updates);
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

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The project now. It never changes in place, and what did not change keeps its identity. */
  getState = (): ProjectState => this.#state;

  get revision(): number {
    return this.#revision;
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

  /** Takes in a file that changed outside of the editor. See planFileImport. */
  importFile(path: string, text: string, options: ExecuteOptions = {}): CommandResult {
    const origin = options.origin ?? USER;
    return this.#commit(["file.import"], origin, options, (draft) => {
      this.#assertUnlocked(draft);
      const problems = planFileImport(draft, path, text);
      if (problems.length > 0) throw new ImportRejected(problems);
      return [];
    });
  }

  get canUndo(): boolean {
    return (this.#undo.get(USER)?.done.length ?? 0) > 0;
  }

  get canRedo(): boolean {
    return (this.#undo.get(USER)?.undone.length ?? 0) > 0;
  }

  /** Takes back the last change of the person. What others changed since then stays. */
  undo(): boolean {
    const log = this.#undo.get(USER);
    return log !== undefined && this.#stepBack(log.done, log.undone, USER);
  }

  redo(): boolean {
    const log = this.#undo.get(USER);
    return log !== undefined && this.#stepBack(log.undone, log.done, USER);
  }

  /** Takes back everything an AI task did in one step. What others changed since then stays. */
  undoTask(task: string): boolean {
    const origin = aiTask(task);
    const log = this.#undo.get(origin);
    if (!log || this.#isLocked) return false;
    const entries = log.done.splice(0);
    const taken = this.#takeBack(entries, origin);
    if (taken) log.undone.push(taken);
    return taken !== undefined;
  }

  redoTask(task: string): boolean {
    const origin = aiTask(task);
    const log = this.#undo.get(origin);
    return log !== undefined && this.#stepBack(log.undone, log.done, origin);
  }

  /** The project as files. Documents that became invalid stay out and are reported. */
  exportFiles(): { files: Map<string, string>; problems: readonly Problem[] } {
    const { project, problems } = stateToProject(this.#state);
    const files = writeProject(project);
    for (const [path, text] of Object.entries(this.#state.files)) files.set(path, text);
    return { files, problems };
  }

  destroy(): void {
    this.#root.unobserveDeep(this.#onChange);
    this.#listeners.clear();
  }

  get #isLocked(): boolean {
    return this.#state.manifest.tags?.some((tag) => tag.locked) === true;
  }

  #assertUnlocked(draft: Draft): void {
    if (draft.state.manifest.tags?.some((tag) => tag.locked)) {
      throw new CommandError("project-locked", "项目有不可编辑的标签，要先移除标签");
    }
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
    return command.run(draft, params.data);
  }

  #commit(
    commands: readonly string[],
    origin: Origin,
    options: CommitOptions,
    plan: (draft: Draft) => readonly unknown[],
  ): CommandResult {
    const draft = new Draft(this.#state, origin);
    let results: readonly unknown[];
    try {
      results = plan(draft);
    } catch (error) {
      if (error instanceof ImportRejected) {
        const { message, problems } = error;
        return { ok: false, error: { code: "invalid-file", message, problems } };
      }
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

    const entry: UndoEntry = { steps: draft.steps };
    this.doc.transact(() => {
      for (const patch of patches) this.#apply(patch);
    }, origin);
    // Yjs reports nothing about a field of something that went away in the same change.
    const write = { revision: this.#revision, origin };
    for (const { path } of patches) this.#markWrite(path, write, false);

    if (!options.isUndo) {
      const log = this.#logOf(origin);
      log.done.push(entry);
      log.undone = [];
      // Everything an AI task does is undone at once, so its log has no limit.
      if (origin === USER && log.done.length > MAX_UNDO) log.done.shift();
    }
    this.#lastEntry = entry;

    this.#history.push({ revision: this.#revision, origin, commands, patches, time: Date.now() });
    if (this.#history.length > MAX_HISTORY) this.#history = this.#history.slice(-MAX_HISTORY);
    return { ok: true, revision: this.#revision, results, patches };
  }

  #logOf(origin: Origin): UndoLog {
    let log = this.#undo.get(origin);
    if (!log) {
      log = { done: [], undone: [] };
      this.#undo.set(origin, log);
    }
    return log;
  }

  /** Moves one change from one stack to the other. A change that left nothing to do is skipped. */
  #stepBack(from: UndoEntry[], to: UndoEntry[], origin: Origin): boolean {
    if (this.#isLocked) return false;
    for (let entry = from.pop(); entry; entry = from.pop()) {
      const taken = this.#takeBack([entry], origin);
      if (taken) {
        to.push(taken);
        return true;
      }
    }
    return false;
  }

  /**
   * Writes back what these changes replaced, as a change like any other. Yjs has an undo of its
   * own, but it works on single fields and can leave a field with no value at all when two people
   * changed it at once. Here a field always gets a value back, or stays as it is.
   *
   * A path is only touched while it still holds what the change left there. Who wrote it last says
   * nothing, because taking something back is a write too: after that the path would look like ours
   * again, also where it holds what somebody else did. Returns how to redo this, or undefined when
   * there was nothing left to take back.
   */
  #takeBack(entries: readonly UndoEntry[], origin: Origin): UndoEntry | undefined {
    this.#lastEntry = undefined;
    const result = this.#commit(["undo"], origin, { isUndo: true }, (draft) => {
      for (const entry of entries.toReversed()) {
        for (const { patch, inverse, after } of entry.steps.toReversed()) {
          const isIntact = deepEqual(getIn(draft.state, patch.path), after);
          if (isIntact && draft.hasParent(patch.path)) draft.apply(inverse);
        }
      }
      return [];
    });
    return result.ok ? this.#lastEntry : undefined;
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

  /** Makes a flat level hold exactly this. */
  #writeLevel(path: Path, entries: Readonly<Record<string, unknown>>): void {
    const owner = path.slice(0, -1);
    const level = path.at(-1) as string;
    const map = this.#mapAt(owner);
    for (const key of map.keys()) {
      const found = flatEntry(owner, key);
      if (found?.[0] === level && !Object.hasOwn(entries, found[1])) map.delete(key);
    }
    map.delete(level);
    for (const [entry, value] of Object.entries(entries)) map.set(flatKey(level, entry), value);
  }

  #apply(patch: Patch): void {
    const { path } = patch;
    if (isFlat(path)) {
      const entries = patch.op === "set" ? (patch.value as Record<string, unknown>) : {};
      this.#writeLevel(path, entries);
      return;
    }
    const parent = path.slice(0, -1);
    const name = path.at(-1) as string;
    const isEntry = isFlat(parent);
    const level = parent.at(-1) as string;
    const map = this.#mapAt(isEntry ? parent.slice(0, -1) : parent);
    const key = isEntry ? flatKey(level, name) : name;
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
    // From now on this entry lives in its own key.
    if (isEntry) oldMap(map, level)?.delete(name);
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
    const mutator = new Mutator(this.#state);

    for (const event of events) {
      const base = event.path.map(String);
      if (event.target instanceof Y.Text) {
        mutator.set(base, event.target.toString());
        if (!isLoad) this.#markWrite(base, write, false);
        continue;
      }
      const target = event.target as Y.Map<unknown>;
      event.changes.keys.forEach((_, key) => {
        const { path, value } = readChange(target, base, key);
        if (path.includes(UNSAFE_KEY)) return;
        const removed = value === undefined;
        if (removed) mutator.delete(path);
        else mutator.set(path, value);
        if (!isLoad) this.#markWrite(path, write, removed || isContainer(path));
      });
    }

    this.#state = mutator.root;
    for (const listener of this.#listeners) listener();
  };
}

class ImportRejected extends Error {
  readonly problems: readonly Problem[];

  constructor(problems: readonly Problem[]) {
    super("文件不符合项目格式，没有导入");
    this.problems = problems;
  }
}
