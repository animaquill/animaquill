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
import { projectToState, stateToProject, type ProjectState } from "./model.ts";
import { Mutator, type Patch } from "./patch.ts";
import { danglingAt, touchesLockedTrack } from "./references.ts";
import { flatEntry, flatKey, isContainer, isFlat, type Path } from "./structure.ts";
import { UNWRITTEN, WriteTree, type Written } from "./write-tree.ts";

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

export type CommandResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly results: readonly unknown[];
      readonly patches: readonly Patch[];
    }
  | { readonly ok: false; readonly error: CommandFailure };

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

const MISSING_UPDATES: CommandFailure = {
  code: "missing-updates",
  message: "别的窗口的改动还没有收全，等一下再试。一直这样的话，刷新页面",
};
const PROJECT_LOCKED: CommandFailure = {
  code: "project-locked",
  message: "项目有不可编辑的标签，要先移除标签",
};
const NOTHING_TO_UNDO: CommandFailure = { code: "nothing-to-undo", message: "没有可以撤销的步骤" };
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
  readonly #undo = new Map<Origin, UndoLog>();
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

  /** Takes in a file that changed outside of the editor. See planFileImport. */
  importFile(path: string, text: string, options: ExecuteOptions = {}): CommandResult {
    const origin = options.origin ?? USER;
    return this.#commit(["file.import"], origin, options, (draft) => {
      this.#assertUnlocked(draft);
      draft.knowsOnlyOutcome();
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
    const origin = aiTask(task);
    const refusal = this.#whyNotNow;
    if (refusal) return { ok: false, error: refusal };
    const log = this.#undo.get(origin);
    const entries = log?.done.splice(0) ?? [];
    if (!log || entries.length === 0) return { ok: false, error: NOTHING_TO_UNDO };
    return this.#takeBack(entries, log.undone, origin, "undo");
  }

  redoTask(task: string): UndoResult {
    return this.#stepBack(aiTask(task), "undone", "done");
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
    if (this.#isBehind) return { ok: false, error: MISSING_UPDATES };
    const draft = new Draft(this.#state, origin, this.#written);
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
      if (dangling.length === 0) return { back: new Set(back), obstacle };
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
      event.changes.keys.forEach((_, key) => {
        const { path, value } = readChange(target, base, key);
        if (path.includes(UNSAFE_KEY)) return;
        const removed = value === undefined;
        if (removed) mutator.delete(path);
        else mutator.set(path, value);
        remember(path);
        if (!isLoad) this.#markWrite(path, write, removed || isContainer(path));
      });
    }

    this.#written = writes.root;
    this.#latest = mutator.root;
    this.#show();
  };
}

class ImportRejected extends Error {
  readonly problems: readonly Problem[];

  constructor(problems: readonly Problem[]) {
    super("文件不符合项目格式，没有导入");
    this.problems = problems;
  }
}
