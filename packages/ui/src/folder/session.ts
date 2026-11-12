import {
  folderBatch,
  inRanks,
  isDocument,
  isProjectFile,
  type FileChange,
  type MergeConflict,
  type MergeResult,
  type Origin,
  type ProjectStore,
  type CommandFailure,
} from "@animaquill/core";
import {
  FolderError,
  sameNameKey,
  type FileStat,
  type FolderBases,
  type FolderBasesChange,
  type FolderChange,
  type FolderFailure,
  type FolderFileRecord,
  type FolderWatch,
  type FolderWriter,
  type LocalFolder,
  type WriterClaim,
} from "@animaquill/host";
import { hashText } from "@animaquill/media";
import { CURRENT_FORMAT_VERSION, MANIFEST_FILE, type Problem } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import {
  includes,
  isTooLarge,
  looksDamaged,
  formatVersionOf,
  projectIdOf,
  textOf,
} from "./project-files.ts";
import { failureMessage } from "../i18n/failures.ts";

/**
 * Keeps a project folder and the open project in step, see docs/design/local-projects.md section 2.
 * The project is the folder; the log of the project in the browser is where every change goes first,
 * and the document in memory is what people work on. From there changes go to the folder once people
 * stop for a moment, and what other programs change in the folder comes into the document as a
 * three-way merge, see `ProjectStore.mergeFiles`.
 *
 * What the editor last wrote or read in each file is its base, kept in the browser: a file that is
 * not its base changed outside, and a document that is not what the editor wrote of it has changes
 * that are not in the folder yet. The folder gets written once the log has what goes there, and only
 * then is that the base: a crash in between leaves the folder ahead of the log, which comes in again
 * the next time, rather than behind, which would take back what people did. When the log cannot be
 * written, the folder still is, since it is the project, but nothing is noted down of it, see
 * `FolderSnapshot.unrecorded`.
 *
 * One window of the browser writes the folder and takes in what changes there, the others leave it
 * to that one, see `FolderWriter`: two windows taking in the same change would put it in twice.
 *
 * Nothing here touches the page, so it runs the same with a disk in memory, see memory-disk.ts.
 */

/** How long things wait. */
export interface FolderTiming {
  /** Changes go to the folder once people stopped changing things for this long. */
  readonly quietMs: number;
  /** ...or once they have been changing things for this long. */
  readonly longestMs: number;
  /** What could not be written, read or kept is tried again after this long. */
  readonly retryMs: number;
  /**
   * Changes that came while the folder kept changing, as during a long checkout, wait this long for
   * the rest of them, see `FolderBatch.stillChanging`.
   */
  readonly settleMs: number;
  /** How long the window that writes the folder has to answer before another one takes over. */
  readonly answerMs: number;
}

export const FOLDER_TIMING: FolderTiming = {
  quietMs: 1000,
  longestMs: 5000,
  retryMs: 5000,
  settleMs: 2000,
  answerMs: 3000,
};

/** The log of the project, as far as the folder goes. See `ProjectSession`. */
export interface FolderLog {
  /** Resolves once every change made so far is in the log, to whether it is. */
  saved(): Promise<boolean>;
  /**
   * Takes in what the log has that the project does not have yet, such as what the window that wrote
   * the folder before did last. Whatever is in the folder of it would otherwise look like a change
   * from outside, and come in a second time. Rejects when the log cannot be read.
   */
  caughtUp(): Promise<void>;
}

export interface FolderSessionOptions {
  readonly store: ProjectStore;
  readonly folder: LocalFolder;
  /**
   * The number this browser knows the folder by, see `FolderRecord.id`, and what everything is kept
   * by: the log, the bases, the turn to write. Copies of a folder have the same project id.
   */
  readonly id: string;
  readonly bases: FolderBases;
  readonly writer: FolderWriter;
  readonly log: FolderLog;
  readonly timing?: Partial<FolderTiming>;
}

/** Whether this window writes the folder. */
export type FolderRole =
  | "starting"
  | "writing"
  /** Another window of this browser writes the folder, and takes in what changes there. */
  | "waiting"
  /**
   * This window does not write the folder for now, and no other one does for it: see `trouble`.
   * The folder is not where it was, or this page is too old for what the browser keeps.
   */
  | "stopped"
  | "closed";

/** What keeps changes from the folder. */
export type FolderTrouble =
  /** The folder is not where it was: moved, renamed or removed. See `FolderSession.reconnect`. */
  | { readonly reason: "gone" }
  /** Another project is where the folder was. See `FolderSession.reconnect`. */
  | { readonly reason: "replaced" }
  /**
   * animaquill.json went away outside, as during a checkout of a branch without the project:
   * nothing gets written or taken in until it is back, or people restore the folder, see
   * `FolderSession.useEditorContent`.
   */
  | { readonly reason: "manifest-gone" }
  /**
   * What the browser keeps about the folder is of a newer version of the editor, open in another
   * tab: this page has to be reloaded, and the newer one writes the folder meanwhile.
   */
  | { readonly reason: "outdated" }
  /**
   * animaquill.json is of a newer format than this editor knows: nothing gets written or taken in,
   * and the files stay as they are, until people update the editor.
   */
  | { readonly reason: "too-new" }
  /**
   * The project cannot be edited for now, see `FolderSession.hold`: nothing gets written or taken
   * in, and the files stay as they are, until it can be again.
   */
  | { readonly reason: "held" }
  /**
   * A file could not be written, or read, for the reason a `FolderError` gives. It gets tried
   * again. "busy" for one that another program keeps from being read.
   */
  | { readonly reason: Exclude<FolderFailure, "gone">; readonly path: string }
  /** Two files of the project are one file on some systems: only the first of them gets written. */
  | { readonly reason: "clash"; readonly path: string };

/** A file of the folder that waits for people, and is not written until then. */
export interface BlockedFile {
  readonly path: string;
  /** Why. */
  readonly problems: readonly Problem[];
  /** Whether there is a file: one that went away outside, and is still in use, is not. */
  readonly present: boolean;
}

export interface FolderSnapshot {
  readonly role: FolderRole;
  /**
   * "saved" when the folder has everything that can be written, "saving" while it is on its way,
   * "unsaved" when something keeps it from there, see `trouble`, and "elsewhere" while another
   * window writes the folder.
   */
  readonly status: "saved" | "saving" | "unsaved" | "elsewhere";
  readonly trouble: FolderTrouble | undefined;
  readonly blocked: readonly BlockedFile[];
  /** When this window last wrote the folder, in milliseconds since 1970. */
  readonly writtenAt: number | undefined;
  /**
   * The folder got written while the browser could not keep the log, so nothing is noted down of
   * it: should the browser go away now, people may have to look at the folder themselves.
   */
  readonly unrecorded: boolean;
  /**
   * This window writes the folder, and compared it with the project since it started to: the
   * project has what changed in the folder meanwhile, as far as it could take that in. Until then
   * what the project says may be what the browser kept from before.
   */
  readonly compared: boolean;
}

/** Changes from the folder that came in, as one change of the project. */
export interface FolderMerge {
  /** Takes back all of it, with `ProjectStore.undoOrigin`. */
  readonly origin: Origin;
  /** What came in, as far as it could. */
  readonly files: readonly string[];
  readonly conflicts: readonly MergeConflict[];
  readonly problems: readonly Problem[];
}

/** What came of finding the folder again, see `FolderSession.reconnect`. */
export type Reconnection =
  | "connected"
  | "gone"
  /** The browser has to ask people first, see `LocalFolder.requestAccess`. */
  | "ask"
  /** It has no animaquill.json. */
  | "not-a-project"
  /** It has another project in it. */
  | "other-project";

/** What the snapshot says while the folder is left as it is, see `FolderSession.hold`. */
const HELD: FolderTrouble = { reason: "held" };

/** Where what the folder had goes before the editor writes over it, and why. */
export const RECOVERED_FOLDER = ".animaquill/recovered";
/** Keeps what is in .animaquill out of Git, without changing the .gitignore of the project. */
const IGNORE_FILE = ".animaquill/.gitignore";
const ABSENT = "absent";
const LOOK_AT_ONCE = 16;
/** About what the host found best for many small files, see `WRITE_AT_ONCE` there. */
const WRITE_AT_ONCE = 8;
/** A file that keeps changing while it is read gets read this many times at the most. */
const READ_ATTEMPTS = 3;
/** Refusals of a batch that say which files they are about, which can wait while the rest comes. */
const SALVAGEABLE = new Set(["merge-would-break", "merge-unsettled"]);
/**
 * Refusals that a change of the project can lift, so that the files are tried again then: a tag
 * that locks the project, or what the editor did that the files run into.
 */
const RETRYABLE = new Set(["project-locked", ...SALVAGEABLE]);
/**
 * Why a file waits that has to do with another file, rather than with itself: it goes along with
 * the next batch, which may bring what it waits for.
 */
const WAITS_FOR_ANOTHER = new Set(["waits-with-timeline", "needs-file", "uses-removed"]);
/** What a file that cannot be read holds, for `baseOf`: something, that is no document. */
const UNREADABLE = "\u0000";

type Disk =
  | { readonly kind: "text"; readonly text: string; readonly stat: FileStat }
  | { readonly kind: "absent" }
  | {
      readonly kind: "unreadable";
      readonly stat: FileStat;
      readonly code: "not-text" | "file-too-large";
    };

/** The editor's own text of a file, while the file means the same. */
interface Synced {
  /** `hashText` of the text, or ABSENT when the project has no such file. */
  readonly hash: string;
  /** The text itself, once it is known here. */
  text: string | undefined;
}

/** What the editor knows of a file. */
interface Known {
  /** What it last wrote or read there: what a merge goes from. Undefined when there was none. */
  readonly base: string | undefined;
  /** How the file was then. */
  readonly stat: FileStat | typeof ABSENT;
  /**
   * Undefined when the project may hold something else than the file: then it gets written. A file
   * that somebody wrote in another way than the editor does stays as it is while it means the same.
   */
  readonly synced: Synced | undefined;
  /** What the file held before the editor last replaced it or took it away, see `replacedOf`. */
  readonly replaced?: string | undefined;
}

/** A version of a file that the editor writes over, and no other one. */
interface Overwrite {
  readonly disk: Disk;
  /** Whether it is kept in RECOVERED_FOLDER already, or needs no keeping. */
  readonly isKept: boolean;
}

interface Blocked {
  readonly problems: readonly Problem[];
  /** What is there now: a change of that is the next try. */
  readonly disk: Disk;
  /** Whether a change of the project can let it in, such as taking off a tag that locks it. */
  readonly retry: boolean;
}

interface Plan {
  readonly writes: ReadonlyMap<string, string>;
  readonly removes: readonly string[];
  /** Files that only change the case of their names, which is no other file on Windows. */
  readonly moves: readonly (readonly [string, string])[];
  readonly clash: string | undefined;
}

/** Why a turn to write the folder ended. */
type TurnEnd =
  /** Another window took over, or this one let go. */
  | "lost"
  /** Something failed before the folder could be looked at: another turn goes again later. */
  | "again"
  /** The folder is gone, or another project took its place: nothing more until it is found. */
  | "park"
  /** What the browser keeps is of a newer editor: this page has to be reloaded. */
  | "outdated";

const statOf = ({ size, lastModified }: FileStat): FileStat => ({ size, lastModified });

const isSameStat = (a: FileStat | typeof ABSENT, b: FileStat | typeof ABSENT): boolean =>
  a === ABSENT || b === ABSENT ? a === b : a.size === b.size && a.lastModified === b.lastModified;

const statIn = (disk: Disk): FileStat | typeof ABSENT =>
  disk.kind === "absent" ? ABSENT : disk.stat;

const textIn = (disk: Disk): string | undefined => (disk.kind === "text" ? disk.text : undefined);

/** Whether a file is what it was the last time the editor wrote or read it. */
const isAsBase = (disk: Disk, base: string | undefined): boolean =>
  disk.kind === "text" ? disk.text === base : disk.kind === "absent" && base === undefined;

/** Whether the project has a file just as the folder has it, or neither has one. */
const isAsDisk = (text: string | undefined, disk: Disk): boolean =>
  disk.kind === "text" ? disk.text === text : disk.kind === "absent" && text === undefined;

const isSameDisk = (a: Disk, b: Disk): boolean => {
  if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
  if (a.kind !== b.kind || !isSameStat(a.stat, b.stat)) return false;
  return a.kind !== "text" || a.text === (b as Extract<Disk, { kind: "text" }>).text;
};

/** Whether a file holds the same as before, whatever its time says. */
function holdsTheSame(a: Disk, b: Disk): boolean {
  if (a.kind === "text" || b.kind === "text") {
    return a.kind === "text" && b.kind === "text" && a.text === b.text;
  }
  return isSameDisk(a, b);
}

const encoder = new TextEncoder();

/**
 * What the editor notes down before it writes a file: what is to be in it, and how many bytes that
 * is, see `isDamagedWrite`. ABSENT before it takes a file away.
 */
const intentOf = (text: string, hash: string): string => `${hash} ${encoder.encode(text).length}`;

const hashOfIntent = (intent: string): string => intent.split(" ")[0] ?? "";

/** Whether what the editor was writing when it stopped got there. */
const hasLanded = (intent: string, disk: Disk): boolean =>
  intent === ABSENT
    ? disk.kind === "absent"
    : disk.kind === "text" && hashText(disk.text) === hashOfIntent(intent);

/**
 * Whether a file that cannot be read is what a write of the editor left when the power went: empty,
 * or as long as what was written, with something else in it. Anything else that another program
 * wrote meanwhile is that program's, and waits for people.
 */
function isDamagedWrite(intent: string, disk: Disk): boolean {
  if (intent === ABSENT || disk.kind === "absent") return false;
  const size = Number(intent.split(" ")[1]);
  return disk.stat.size === 0 || disk.stat.size === size;
}

/** What a file was before the editor replaced it, to know it again: by what it has and its time. */
function replacedOf(disk: Disk): string | undefined {
  if (disk.kind === "absent") return ABSENT;
  if (disk.kind !== "text") return undefined;
  return `${hashText(disk.text)} ${disk.stat.size} ${disk.stat.lastModified}`;
}

/** Whether a file is what the editor replaced, time and all: what a crash takes the folder back to. */
function isReplacedBack(replaced: string, disk: Disk): boolean {
  if (replaced === ABSENT) return disk.kind === "absent";
  if (disk.kind !== "text") return false;
  const [hash = "", size = "", time = ""] = replaced.split(" ");
  return (
    disk.stat.size === Number(size) &&
    disk.stat.lastModified === Number(time) &&
    hashText(disk.text) === hash
  );
}

function isSynced(known: Known | undefined, text: string | undefined): boolean {
  if (!known) return text === undefined;
  const { synced } = known;
  if (!synced) return false;
  if (text === undefined || synced.hash === ABSENT) {
    return text === undefined && synced.hash === ABSENT;
  }
  if (synced.text !== undefined) return synced.text === text;
  if (synced.hash !== hashText(text)) return false;
  synced.text = text;
  return true;
}

const syncedOf = (text: string | undefined): Synced =>
  text === undefined ? { hash: ABSENT, text: undefined } : { hash: hashText(text), text };

const isFolderError = (
  error: unknown,
  ...reasons: readonly FolderFailure[]
): error is FolderError => error instanceof FolderError && reasons.includes(error.reason);

/** Whether what the browser keeps is of a newer version of the editor, open in another tab. */
function isOutdated(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause.name === "VersionError") return true;
  }
  return false;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

/** Runs `work` on every item, `limit` at a time. */
async function inTurns<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A name for a moment, in the time of this computer, that every system takes. */
function stampOf(time: number): string {
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

function unreadable(path: string, disk: Extract<Disk, { kind: "unreadable" }>): Problem {
  const message =
    disk.code === "not-text"
      ? "这个文件不是 UTF-8 文本，编辑器读不懂，没有并入，也不会写回"
      : "代码文件不能超过 8 MiB，没有并入，也不会写回";
  return { severity: "error", code: disk.code, file: path, message };
}

/** What a refusal of a batch says about one of its files. */
function problemsAbout(error: CommandFailure | Problem, path: string): readonly Problem[] {
  if (!("params" in error)) return [{ ...error, file: path }];
  const own = error.problems?.filter(({ file }) => file === path) ?? [];
  if (own.length > 0) return own;
  return [{ severity: "error", code: error.code, file: path, message: failureMessage(error) }];
}

let batches = 0;
const nextBatch = () => `${Date.now().toString(36)}-${(batches += 1).toString(36)}`;

/** What a turn needs from the session. */
interface TurnContext {
  readonly store: ProjectStore;
  readonly id: string;
  readonly bases: FolderBases;
  readonly log: FolderLog;
  readonly timing: FolderTiming;
  readonly folder: () => LocalFolder;
  /** What the session shows changed. */
  readonly changed: () => void;
  readonly merged: (merge: FolderMerge) => void;
}

/**
 * The time this window writes the folder, from looking at it to letting go. Everything it knows is
 * its own, and once it is over, nothing it still has on its way changes anything.
 */
class Turn {
  readonly #context: TurnContext;
  /** What the bases count this window as, see `FolderBases.claim`. */
  #turn = 0;
  readonly #known = new Map<string, Known>();
  readonly #blocked = new Map<string, Blocked>();
  /** Files that changed outside, or may have, to take in before anything gets written. */
  readonly #external = new Set<string>();
  /** Files that could not be looked at: they get looked at again after a while. */
  readonly #unlookable = new Set<string>();
  #lookTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Files the editor writes over although they are not their base: where not all of what the
   * folder has came in, as people asked, as a crash left them. Just that version, once it is kept.
   */
  readonly #overwrites = new Map<string, Overwrite>();
  /**
   * What the editor is about to write, as noted down before it does, see `intentOf`, until it is
   * known what came of it. What a window before this one noted down stays until the file was
   * looked at.
   */
  readonly #intents = new Map<string, string>();
  /** Paths whose record changed since it was kept. */
  readonly #dirty = new Set<string>();
  /**
   * Nothing was kept about the folder, by any window: what the project has of a file counts as its
   * base. Whatever another window kept counts, also for a window that just made the project from
   * the folder, as it may have let go before keeping anything, and another one wrote since.
   */
  #baseline = false;
  /**
   * The folder was compared with what is kept about it, file by file, since this turn began. Until
   * then what a crash can have left counts, see `replaced`.
   */
  #compared = false;
  /** The watch runs. */
  #connected = false;
  #watch: FolderWatch | undefined;
  #work: Promise<void> = Promise.resolve();
  #queued = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #due = 0;
  /** When the changes that wait to be written began. */
  #since: number | undefined;
  #settle: ReturnType<typeof setTimeout> | undefined;
  /** Changes came while the folder kept changing, and wait for the rest. */
  #holding = false;
  /** How many batches the watch told, to know whether asking it for more brought one. */
  #batches = 0;
  /** The project changed since what it has was last compared with the folder. */
  #isBehind = true;
  #dead = false;
  #end = () => {};
  /** Settles once this turn is over, also when it found out by itself that it has to end. */
  readonly ended: Promise<void>;
  endReason: TurnEnd = "lost";
  trouble: FolderTrouble | undefined;
  writtenAt: number | undefined;
  /** See `FolderSnapshot.unrecorded`. */
  unrecorded = false;

  constructor(context: TurnContext) {
    this.#context = context;
    this.ended = new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  /** Whether this turn is over, see `ended`. */
  get isOver(): boolean {
    return this.#dead;
  }

  get #folder(): LocalFolder {
    return this.#context.folder();
  }

  /** What is on its way, in order. */
  get work(): Promise<void> {
    return this.#work;
  }

  get #isStopped(): boolean {
    const reason = this.trouble?.reason;
    return reason === "gone" || reason === "replaced" || reason === "too-new";
  }

  /** What keeps changes from the folder, also a file that cannot be read. */
  get troubleNow(): FolderTrouble | undefined {
    if (this.trouble) return this.trouble;
    const [path] = this.#unlookable;
    return path === undefined ? undefined : { reason: "busy", path };
  }

  get status(): FolderSnapshot["status"] {
    // What keeps changes from the folder says more than that it is tried again.
    if (this.troubleNow) return "unsaved";
    if (this.#queued > 0 || this.#timer !== undefined || this.#holding) return "saving";
    if (!this.#connected) return "unsaved";
    return this.#isBehind || this.#external.size > 0 ? "saving" : "saved";
  }

  get blocked(): readonly BlockedFile[] {
    return [...this.#blocked].map(([path, { problems, disk }]) => ({
      path,
      problems,
      present: disk.kind !== "absent",
    }));
  }

  start(): Promise<void> {
    return this.#enqueue(() => this.#begin());
  }

  stop(): void {
    this.#dead = true;
    this.#end();
    clearTimeout(this.#timer);
    clearTimeout(this.#settle);
    clearTimeout(this.#lookTimer);
    this.#timer = undefined;
    this.#watch?.stop();
    this.#watch = undefined;
  }

  /** Ends this turn by itself, for the session to go on from there. */
  #stopFor(reason: TurnEnd): void {
    if (this.#dead) return;
    this.endReason = reason;
    this.stop();
    this.#context.changed();
  }

  /** The project changed: here, in another window, or by a merge. */
  changed(): void {
    if (this.#dead) return;
    for (const [path, { retry }] of this.#blocked) if (retry) this.#external.add(path);
    this.#isBehind = true;
    this.#since ??= Date.now();
    this.#arm();
  }

  async flush(): Promise<boolean> {
    if (this.#dead) return false;
    this.#holding = false;
    clearTimeout(this.#settle);
    // What a write runs into gets taken in, and then written, which is what people asked for.
    for (let round = 0; round < 3 && !this.#dead; round++) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      await this.#enqueue(() => this.#pass());
      if (this.status !== "saving") break;
    }
    return this.status === "saved";
  }

  useEditorContent(paths?: readonly string[]): Promise<void> {
    return this.#enqueue(() => this.#useEditorContent(paths));
  }

  /**
   * Keeps what the folder has of these files in RECOVERED_FOLDER, as they are now. Resolves to
   * where each went, none for a file that is not there, and rejects with why one could not be
   * kept, or when this window does not write the folder any more.
   */
  async keep(paths: readonly string[]): Promise<readonly string[]> {
    let outcome: { readonly kept: readonly string[] } | { readonly error: unknown } | undefined;
    await this.#enqueue(async () => {
      try {
        const kept: string[] = [];
        for (const path of paths) {
          const place = await this.#backUp(path);
          if (place !== undefined) kept.push(place);
        }
        outcome = { kept };
      } catch (error) {
        outcome = { error };
      }
    });
    if (outcome === undefined) throw new FolderError("failed", paths[0] ?? "");
    if ("error" in outcome) throw outcome.error;
    return outcome.kept;
  }

  /** Another handle of the folder came, which has to be looked at again from the start. */
  reconnected(): Promise<void> {
    return this.#enqueue(async () => {
      this.#setTrouble(undefined);
      this.#connected = false;
      await this.#connect();
    });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#queued += 1;
    this.#context.changed();
    this.#work = this.#work
      .then(async () => {
        if (this.#dead) return;
        try {
          await task();
        } catch (error) {
          this.#failed(error);
        }
      })
      .finally(() => {
        this.#queued -= 1;
        this.#context.changed();
      });
    return this.#work;
  }

  /** Has the folder written soon: right away, after `delay`, or once people stop. */
  #arm(delay?: number): void {
    if (this.#dead || this.#isStopped) return;
    const { quietMs, longestMs } = this.#context.timing;
    const now = Date.now();
    const at =
      delay === undefined ? Math.min(now + quietMs, (this.#since ?? now) + longestMs) : now + delay;
    // What was due sooner, such as writing after a merge, stays as soon.
    if (delay !== undefined && this.#timer !== undefined && this.#due <= at) return;
    clearTimeout(this.#timer);
    this.#due = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.#enqueue(() => this.#pass());
      },
      Math.max(0, at - now),
    );
    this.#context.changed();
  }

  /** A file could not be looked at: once in a while it gets looked at again, and nothing waits. */
  #cannotLook(path: string): void {
    this.#unlookable.add(path);
    this.#context.changed();
    if (this.#lookTimer !== undefined || this.#dead) return;
    this.#lookTimer = setTimeout(() => {
      this.#lookTimer = undefined;
      for (const again of this.#unlookable) this.#external.add(again);
      this.#arm(0);
    }, this.#context.timing.retryMs);
  }

  #setTrouble(trouble: FolderTrouble | undefined): void {
    this.trouble = trouble;
    this.#context.changed();
    // Whatever is there now is not this project: nothing more until people find it.
    if (this.#isStopped) this.#stopFor("park");
  }

  #failed(error: unknown): void {
    if (this.#dead) return;
    if (isOutdated(error)) {
      this.#stopFor("outdated");
      return;
    }
    if (error instanceof FolderError) {
      if (error.reason === "gone") {
        this.#setTrouble({ reason: "gone" });
        return;
      }
      this.#setTrouble({ reason: error.reason, path: error.path });
    } else if (error instanceof DOMException && error.name === "AbortError") {
      // The page goes away with its browser: nothing more happens here.
      return;
    } else {
      console.warn("The project folder could not be written", error);
    }
    this.#arm(this.#context.timing.retryMs);
  }

  async #begin(): Promise<void> {
    const { bases, id, log } = this.#context;
    let records: readonly FolderFileRecord[];
    try {
      this.#turn = await bases.claim(id);
      if (this.#dead) return;
      await log.caughtUp();
      records = await bases.load(id);
    } catch (error) {
      // Without all of that, what the editor did itself would look like changes from outside.
      if (!isOutdated(error)) console.warn("The project folder cannot be compared now", error);
      this.#stopFor(isOutdated(error) ? "outdated" : "again");
      return;
    }
    if (this.#dead) return;
    this.#baseline = records.length === 0;
    for (const { path, base, stat, synced, intent, replaced } of records) {
      if (intent !== undefined) this.#intents.set(path, intent);
      if (base === undefined && replaced === undefined) continue;
      this.#known.set(path, {
        base,
        stat: stat ?? ABSENT,
        synced: synced === undefined ? undefined : { hash: synced, text: undefined },
        replaced,
      });
    }
    await this.#connect();
  }

  /** Watches the folder, and compares what it has with what the editor knows. */
  async #connect(): Promise<void> {
    this.#watch?.stop();
    const watch = this.#folder.watch({
      includes,
      files: () => this.#known.keys(),
      onChange: (changes, batch) => this.#told(changes, batch.stillChanging),
      onProblem: (error) => this.#watchFailed(error),
    });
    this.#watch = watch;
    await watch.ready;
    if (this.#dead) return;
    await this.#reconcile();
    // From now on what the watch tells gets taken in. What it told meanwhile waits for this.
    if (!this.#dead) this.#connected = true;
  }

  /**
   * Compares the whole folder with what the editor knows, see the design, 2.3: what changed outside
   * comes in, what the editor wrote and could not note down any more is its own, what a crash
   * damaged or took back gets written again, and what the folder does not have yet gets written.
   */
  async #reconcile(): Promise<void> {
    const folder = this.#folder;
    // What waited is looked at again with everything else.
    this.#blocked.clear();
    const listed = await collect(folder.list({ includes }));
    const exported = this.#context.store.exportFiles().files;
    const paths = [
      ...new Set([
        MANIFEST_FILE,
        ...listed,
        ...this.#known.keys(),
        ...this.#intents.keys(),
        ...this.#overwrites.keys(),
      ]),
    ].filter(isProjectFile);
    const own = new Set([...paths, ...[...exported.keys()].filter(isProjectFile)]);
    await folder.removeLeftovers(own).catch(() => []);
    const isComplete = await this.#compare(paths, exported);
    if (this.#dead) return;
    if (isComplete) {
      this.#compared = true;
      this.#baseline = false;
    }
    await this.#keep();
    this.#isBehind = true;
    this.#arm(0);
  }

  /** The file is as its base, and maybe has a new time. */
  #refresh(path: string, now: Disk): void {
    const known = this.#known.get(path);
    if (!known) return;
    const stat = statIn(now);
    if (!isSameStat(known.stat, stat)) {
      this.#known.set(path, { ...known, stat });
      this.#dirty.add(path);
    }
  }

  /** Whether the project has this code file. Documents are the project's anyway. */
  #isInProject(path: string): boolean {
    return Object.hasOwn(this.#context.store.getState().files, path);
  }

  /** Whether what is in the folder is this project, and not another one at its place. */
  #isOurs(manifest: Disk | undefined): boolean {
    if (manifest?.kind !== "text") return true;
    // A newer editor wrote it: this one would write what it does not know over what it does not
    // know, and drop it from the files.
    if ((formatVersionOf(manifest.text) ?? 0) > CURRENT_FORMAT_VERSION) {
      this.#setTrouble({ reason: "too-new" });
      return false;
    }
    const id = projectIdOf(manifest.text);
    if (id === undefined || id === this.#context.store.getState().manifest.id) return true;
    this.#setTrouble({ reason: "replaced" });
    return false;
  }

  async #lookAll(paths: readonly string[]): Promise<Map<string, Disk | undefined>> {
    const found = new Map<string, Disk | undefined>();
    await inTurns(paths, LOOK_AT_ONCE, async (path) => {
      found.set(path, await this.#look(path));
    });
    return found;
  }

  /** What a file is now. Undefined when that cannot be told now, to look again later. */
  async #look(path: string): Promise<Disk | undefined> {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      let file: File;
      try {
        file = await this.#folder.file(path);
      } catch (error) {
        if (isFolderError(error, "missing", "refused")) return { kind: "absent" };
        if (isFolderError(error, "gone", "denied")) throw error;
        return undefined;
      }
      const stat = statOf(file);
      if (isTooLarge(path, file.size)) return { kind: "unreadable", stat, code: "file-too-large" };
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        // It changed while it was read, or something holds on to it.
        continue;
      }
      const text = textOf(bytes);
      return text === undefined
        ? { kind: "unreadable", stat, code: "not-text" }
        : { kind: "text", text, stat };
    }
    return undefined;
  }

  async #told(changes: readonly FolderChange[], stillChanging: boolean): Promise<void> {
    if (this.#dead) return;
    this.#batches += 1;
    for (const { path } of changes) if (isProjectFile(path)) this.#external.add(path);
    clearTimeout(this.#settle);
    this.#settle = undefined;
    if (stillChanging) {
      // More is likely to come: a checkout half done is no state to merge, or to write over.
      this.#holding = true;
      this.#settle = setTimeout(() => void this.#settled(), this.#context.timing.settleMs);
      this.#context.changed();
      return;
    }
    this.#holding = false;
    await this.#enqueue(() => this.#takeIn());
  }

  /**
   * A while after changes that came while the folder kept changing: what the watch has by now says
   * whether it still does. When it has nothing, the rest came with that batch, and it is quiet.
   * Never from within the work of this turn, which the watch would wait for while it tells.
   */
  async #settled(): Promise<void> {
    this.#settle = undefined;
    if (this.#dead) return;
    const told = this.#batches;
    await this.#watch?.flush().catch(() => {});
    if (this.#dead || this.#batches !== told) return;
    this.#holding = false;
    void this.#enqueue(() => this.#takeIn());
  }

  #watchFailed(error: FolderError): void {
    if (this.#dead) return;
    if (error.reason === "gone") {
      this.#setTrouble({ reason: "gone" });
      return;
    }
    if (error.reason === "denied") {
      this.#setTrouble({ reason: "denied", path: error.path });
      this.#arm(this.#context.timing.retryMs);
      return;
    }
    console.warn("The project folder could not be looked at", error);
  }

  /** Takes in what changed outside. */
  async #takeIn(): Promise<void> {
    if (!this.#connected || this.#external.size === 0 || this.#isStopped) return;
    const paths = [...this.#external];
    this.#external.clear();
    try {
      await this.#compare(paths);
    } catch (error) {
      // Nothing of it was taken in: it goes again.
      for (const path of paths) this.#external.add(path);
      throw error;
    }
    await this.#keep();
  }

  /**
   * Compares files of the folder with what the editor knows of them, and takes in what changed
   * outside. `exported`, what the project has of each file, comes with the comparison of the whole
   * folder. Resolves to whether all of them could be looked at, and were.
   */
  async #compare(
    paths: readonly string[],
    exported?: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    const disk = await this.#lookAll(paths);
    if (this.#dead) return false;
    const manifest = disk.get(MANIFEST_FILE);
    // Not a project any more, for now: what changed waits for it to come back. Unless the editor
    // never saw it there, as in the folder of a new project, which gets it last.
    if (manifest?.kind === "absent" && this.#known.get(MANIFEST_FILE)?.base !== undefined) {
      this.#setTrouble({ reason: "manifest-gone" });
      return false;
    }
    if (manifest && !this.#isOurs(manifest)) return false;
    if (this.trouble?.reason === "manifest-gone") {
      if (manifest?.kind !== "text") return false;
      this.#setTrouble(undefined);
      // The project is back: everything gets compared again.
      if (!exported) {
        await this.#reconcile();
        return false;
      }
    }
    // Before the folder was compared as a whole once, what a crash can have left still counts.
    const isAfterCrash = !this.#compared;
    const baseline = this.#baseline
      ? (exported ?? this.#context.store.exportFiles().files)
      : undefined;
    const changes: FileChange[] = [];
    const damaged: [string, Disk][] = [];
    let isComplete = true;
    for (const path of paths) {
      const now = disk.get(path);
      if (!now) {
        isComplete = false;
        this.#cannotLook(path);
        continue;
      }
      this.#unlookable.delete(path);
      const overwrite = this.#overwrites.get(path);
      // Still the version the editor is about to write over, maybe with a new time.
      if (overwrite) {
        if (holdsTheSame(overwrite.disk, now)) {
          this.#overwrites.set(path, { ...overwrite, disk: now });
          continue;
        }
        // Not all of the version before came in, and it is not kept yet: it is, from what was read
        // of it, and then the file compares with it. What came of it is in the project already.
        if (!overwrite.isKept) await this.#keepVersion(path, overwrite.disk);
        this.#overwrites.delete(path);
        if (this.#dead) return false;
      }
      const known = this.#known.get(path);
      const intent = this.#intents.get(path);
      const blocked = this.#blocked.get(path);
      const base = known
        ? known.base
        : baseline && now.kind !== "absent"
          ? baseline.get(path)
          : undefined;
      // What the editor was writing is settled: the file says what came of it.
      const settled = () => {
        if (this.#intents.delete(path)) this.#dirty.add(path);
        if (isAfterCrash && known?.replaced !== undefined) {
          this.#known.set(path, { ...(this.#known.get(path) ?? known), replaced: undefined });
          this.#dirty.add(path);
        }
      };
      // A crash took back what the editor wrote last: the file is the one it replaced, time and
      // all, not something that another program wrote. It gets written again.
      if (isAfterCrash && known?.replaced !== undefined && isReplacedBack(known.replaced, now)) {
        this.#overwrites.set(path, { disk: now, isKept: true });
        this.#known.set(path, {
          ...known,
          stat: statIn(now),
          synced: undefined,
          replaced: undefined,
        });
        this.#dirty.add(path);
        if (this.#intents.delete(path)) this.#dirty.add(path);
        continue;
      }
      if (blocked) {
        if (!blocked.retry && isSameDisk(blocked.disk, now)) continue;
      } else if (isAsBase(now, base)) {
        if (known) this.#refresh(path, now);
        else if (base !== undefined && now.kind === "text") {
          this.#known.set(path, { base, stat: now.stat, synced: syncedOf(base) });
          this.#dirty.add(path);
        }
        settled();
        continue;
      }
      if (intent !== undefined && hasLanded(intent, now)) {
        const text = textIn(now);
        this.#known.set(path, {
          base: text,
          stat: statIn(now),
          synced: { hash: hashOfIntent(intent), text },
        });
        this.#dirty.add(path);
        settled();
        continue;
      }
      // A file the editor was writing, or one just as it wrote it, that a crash left damaged: it is
      // kept, and written again. Its note stays until then.
      const isOwn =
        (intent !== undefined && isDamagedWrite(intent, now)) ||
        (known !== undefined && now.kind !== "absent" && isSameStat(known.stat, now.stat));
      if (isOwn && now.kind !== "absent" && looksDamaged(path, textIn(now))) {
        damaged.push([path, now]);
        continue;
      }
      settled();
      if (now.kind === "unreadable") {
        if (base !== undefined || isDocument(path) || this.#isInProject(path)) {
          this.#block(path, now, [unreadable(path, now)], false, base);
        }
        continue;
      }
      changes.push({ path, base, text: textIn(now) });
    }
    for (const [path, now] of damaged) await this.#recover(path, now);
    if (changes.length > 0 && !this.#dead) {
      const all = new Map(disk);
      for (const [path, { problems, disk: there }] of this.#blocked) {
        const isAlong = problems.every(({ code }) => WAITS_FOR_ANOTHER.has(code));
        if (!isAlong || there.kind !== "text" || all.has(path)) continue;
        changes.push({ path, base: this.#known.get(path)?.base, text: there.text });
        all.set(path, there);
      }
      await this.#merge(changes, all);
    }
    return isComplete && !this.#dead;
  }

  /** What the folder holds of a file outside of a batch, from what is known here, at once. */
  readonly #baseOf = (path: string): string | undefined => {
    const there = this.#blocked.get(path)?.disk ?? this.#overwrites.get(path)?.disk;
    if (!there) return this.#known.get(path)?.base;
    return there.kind === "text" ? there.text : there.kind === "absent" ? undefined : UNREADABLE;
  };

  #block(
    path: string,
    now: Disk | undefined,
    problems: readonly Problem[],
    retry: boolean,
    base: string | undefined,
  ): void {
    const disk = now ?? { kind: "absent" };
    this.#blocked.set(path, { problems, disk, retry });
    this.#overwrites.delete(path);
    // What it waits with: a merge that lets it in later goes from here.
    if (!this.#known.has(path) && base !== undefined) {
      this.#known.set(path, { base, stat: statIn(disk), synced: undefined });
      this.#dirty.add(path);
    }
    this.#context.changed();
  }

  /** Whether this window still has its turn: one that slept may not have heard that it lost it. */
  async #hasTurn(): Promise<boolean> {
    const latest = await this.#context.bases.turnOf(this.#context.id);
    if (latest === this.#turn) return true;
    this.#stopFor("lost");
    return false;
  }

  async #merge(
    changes: readonly FileChange[],
    disk: ReadonlyMap<string, Disk | undefined>,
  ): Promise<void> {
    // Another window may take in the same changes: what comes in twice is there twice.
    let hasTurn: boolean;
    try {
      hasTurn = await this.#hasTurn();
    } catch (error) {
      for (const { path } of changes) this.#external.add(path);
      throw error;
    }
    if (!hasTurn) return;
    const { store } = this.#context;
    const origin = folderBatch(nextBatch());
    const mergeOf = (files: readonly FileChange[]) =>
      store.mergeFiles(files, { origin, baseOf: this.#baseOf });
    let batch = changes;
    let result = mergeOf(batch);
    // What would break the project, and says about which files, keeps out only those.
    for (
      let round = 0;
      round < 3 && !result.ok && SALVAGEABLE.has(result.error.code) && batch.length > 1;
      round++
    ) {
      const { error } = result;
      const named = new Set((error.problems ?? []).map(({ file }) => file));
      const out = batch.filter(({ path }) => named.has(path));
      if (out.length === 0 || out.length === batch.length) break;
      for (const { path, base } of out) {
        this.#block(path, disk.get(path), problemsAbout(error, path), true, base);
      }
      batch = batch.filter(({ path }) => !named.has(path));
      result = mergeOf(batch);
    }
    if (!result.ok && SALVAGEABLE.has(result.error.code) && batch.length > 1) {
      // It does not say which: each file goes on its own then, what others refer to first, and
      // what still would break the project waits, to be tried again once the project changes.
      for (const rank of inRanks(batch.map(({ path }) => path))) {
        for (const path of rank) {
          const one = batch.filter((change) => change.path === path);
          const alone = mergeOf(one);
          if (alone.ok) this.#took(alone, one, disk, origin);
          else this.#refused(alone.error, one, disk);
        }
      }
      await this.#keepPartly();
      return;
    }
    if (!result.ok) {
      this.#refused(result.error, batch, disk);
      return;
    }
    this.#took(result, batch, disk, origin);
    await this.#keepPartly();
  }

  /**
   * Keeps at once what did not all come in of files, see `#keepVersion`, so that the base of each
   * moves on with what came in. What cannot be kept now is tried again before it gets written over.
   */
  async #keepPartly(): Promise<void> {
    for (const [path, overwrite] of this.#overwrites) {
      if (overwrite.isKept || this.#dead) continue;
      if (!(await this.#keepVersion(path, overwrite.disk))) continue;
      if (this.#overwrites.get(path) === overwrite) {
        this.#overwrites.set(path, { ...overwrite, isKept: true });
      }
    }
  }

  /**
   * Puts a version of a file that did not all come in in RECOVERED_FOLDER, from what was read of it,
   * and makes it the base of the file: what came of it is in the project, and the rest is kept. Until
   * then the file keeps its old base, so that the next merge finds the same conflict again. Resolves
   * to whether it is kept.
   */
  async #keepVersion(path: string, disk: Disk): Promise<boolean> {
    if (disk.kind !== "text") return false;
    try {
      await this.#backUp(path, undefined, encoder.encode(disk.text));
    } catch (error) {
      if (isFolderError(error, "gone", "denied") || !(error instanceof FolderError)) throw error;
      console.warn("What the folder had of a file could not be kept yet", error);
      return false;
    }
    if (this.#dead) return false;
    const known = this.#known.get(path);
    this.#known.set(path, {
      base: disk.text,
      stat: disk.stat,
      synced: undefined,
      ...(known?.replaced !== undefined && { replaced: known.replaced }),
    });
    this.#dirty.add(path);
    return true;
  }

  #refused(
    error: Extract<MergeResult, { ok: false }>["error"],
    batch: readonly FileChange[],
    disk: ReadonlyMap<string, Disk | undefined>,
  ): void {
    if (error.code === "missing-updates" || error.code === "read-only") {
      // Another window's changes are on their way, or the project cannot be edited for now, see
      // `FolderSession.hold`: the files stay as they are, and come in once it can be again.
      for (const { path } of batch) this.#external.add(path);
      this.#arm(this.#context.timing.retryMs);
      return;
    }
    if (error.code === "manifest-deleted") this.#setTrouble({ reason: "manifest-gone" });
    const retry = RETRYABLE.has(error.code);
    for (const { path, base } of batch) {
      this.#block(path, disk.get(path), problemsAbout(error, path), retry, base);
    }
  }

  /** What came of a merge, file by file, and what to tell people. */
  #took(
    result: Extract<MergeResult, { ok: true }>,
    batch: readonly FileChange[],
    disk: ReadonlyMap<string, Disk | undefined>,
    origin: Origin,
  ): void {
    const after = this.#context.store.exportFiles().files;
    const bases = new Map(batch.map(({ path, base }) => [path, base]));
    const came: string[] = [];
    for (const file of result.files) {
      const now = disk.get(file.path);
      if (file.status === "blocked") {
        const problems = result.problems.filter(({ file: about }) => about === file.path);
        const why =
          problems.length > 0
            ? problems
            : problemsAbout(
                {
                  severity: "error",
                  code: "blocked",
                  file: file.path,
                  message: "这个文件没有并入，等你处理",
                },
                file.path,
              );
        this.#block(file.path, now, why, false, bases.get(file.path));
        continue;
      }
      this.#blocked.delete(file.path);
      this.#overwrites.delete(file.path);
      if (file.status === "ignored") {
        if (this.#known.delete(file.path)) this.#dirty.add(file.path);
        continue;
      }
      came.push(file.path);
      const isPartly =
        result.conflicts.some(({ file: about }) => about === file.path) ||
        result.problems.some(({ file: about }) => about === file.path);
      if (file.rewrite && isPartly && now && now.kind !== "absent") {
        // The editor writes over what the folder has here, and not all of that came in. Until that
        // is kept, the file keeps its old base, so that a crash before brings the same merge again,
        // and the same conflict.
        this.#overwrites.set(file.path, { disk: now, isKept: false });
        const known = this.#known.get(file.path);
        if (known) this.#known.set(file.path, { ...known, synced: undefined });
        continue;
      }
      const text = after.get(file.path);
      this.#known.set(file.path, {
        base: file.base,
        stat: now ? statIn(now) : ABSENT,
        synced: file.rewrite ? undefined : syncedOf(text),
      });
      this.#dirty.add(file.path);
    }
    if (result.patches.length > 0 || result.problems.length > 0) {
      this.#context.merged({
        origin,
        files: came,
        conflicts: result.conflicts,
        problems: result.problems,
      });
    }
    if (result.files.some(({ rewrite }) => rewrite)) this.#arm(0);
  }

  /** The record of a file, as it is to be kept now. */
  #recordOf(path: string): FolderFileRecord | undefined {
    const known = this.#known.get(path);
    const intent = this.#intents.get(path);
    if (known?.base === undefined && known?.replaced === undefined && intent === undefined) {
      return undefined;
    }
    return {
      path,
      ...(known?.base !== undefined && { base: known.base }),
      ...(known && known.stat !== ABSENT && { stat: known.stat }),
      ...(known?.synced && { synced: known.synced.hash }),
      ...(known?.replaced !== undefined && { replaced: known.replaced }),
      ...(intent !== undefined && { intent }),
    };
  }

  /**
   * Keeps what changed of the records, once the log has what the folder has: should the page go away
   * between the two, the folder is ahead of the log, and comes in as a change from outside.
   */
  async #keep(logged?: boolean): Promise<void> {
    if (this.#dirty.size === 0) return;
    const isLogged = logged ?? (await this.#context.log.saved());
    if (this.#dead) return;
    if (!isLogged) {
      this.#arm(this.#context.timing.retryMs);
      return;
    }
    const dirty = [...this.#dirty];
    const put: FolderFileRecord[] = [];
    const remove: string[] = [];
    for (const path of dirty) {
      const record = this.#recordOf(path);
      if (record) put.push(record);
      else remove.push(path);
    }
    this.#dirty.clear();
    try {
      if (!(await this.#save({ put, remove }))) return;
      if (this.unrecorded) {
        this.unrecorded = false;
        this.#context.changed();
      }
    } catch (error) {
      for (const path of dirty) this.#dirty.add(path);
      throw error;
    }
  }

  async #save(change: FolderBasesChange): Promise<boolean> {
    const kept = await this.#context.bases.save(this.#context.id, this.#turn, change);
    // Another window writes the folder now. What this one has is from before.
    if (!kept) this.#stopFor("lost");
    return kept;
  }

  /** Whether animaquill.json is as the editor knows it, or else has it taken in first. */
  async #checkManifest(): Promise<void> {
    const known = this.#known.get(MANIFEST_FILE);
    const there =
      this.#blocked.get(MANIFEST_FILE)?.disk ?? this.#overwrites.get(MANIFEST_FILE)?.disk;
    let file: File;
    try {
      file = await this.#folder.file(MANIFEST_FILE);
    } catch (error) {
      if (!isFolderError(error, "missing")) throw error;
      if ((there ? statIn(there) : known?.stat) !== ABSENT) this.#external.add(MANIFEST_FILE);
      return;
    }
    const stat = statOf(file);
    const seen = there ? statIn(there) : known?.stat;
    if (seen !== undefined && seen !== ABSENT && isSameStat(seen, stat)) return;
    this.#external.add(MANIFEST_FILE);
  }

  /**
   * Writes what the folder does not have of the project yet: only what changed, each file once,
   * what others refer to first and animaquill.json last, see `writeRank`.
   */
  async #pass(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#since = undefined;
    if (this.#dead || this.#isStopped) return;
    if (!this.#connected) {
      await this.#connect();
      if (!this.#connected) return;
    }
    if (this.#holding) return;
    await this.#checkManifest();
    if (this.#external.size > 0) await this.#takeIn();
    if (this.#dead || this.#isStopped) return;
    if (this.trouble?.reason === "manifest-gone") {
      await this.#keep();
      return;
    }
    this.#isBehind = false;
    const { files, problems } = this.#context.store.exportFiles();
    const plan = this.#plan(files, new Set(problems.map(({ file }) => file)));
    if (plan.writes.size + plan.removes.length + plan.moves.length === 0) {
      await this.#keep();
      if (!this.#dead) this.#settleTrouble(plan, undefined);
      return;
    }
    // The log has to have it before the folder does, see the top of this file. Without the log the
    // folder still gets written, as it is the project, but nothing gets noted down.
    const logged = await this.#context.log.saved();
    if (this.#dead) return;
    const hashes = new Map([...plan.writes].map(([path, text]) => [path, hashText(text)]));
    if (logged) {
      for (const [path, hash] of hashes) {
        this.#intents.set(path, intentOf(plan.writes.get(path) as string, hash));
        this.#dirty.add(path);
      }
      for (const path of plan.removes) {
        this.#intents.set(path, ABSENT);
        this.#dirty.add(path);
      }
      await this.#keep(true);
      if (this.#dead) return;
    }
    let failure: unknown;
    let isHalted = false;
    const each = async (paths: readonly string[], work: (path: string) => Promise<boolean>) => {
      await inTurns(paths, WRITE_AT_ONCE, async (path) => {
        if (this.#dead) return;
        // A file that is not there yet and does not get there would be missing for what comes
        // after: then that waits. A file that stays as it was only stays a little older.
        const isNew = this.#isNew(path);
        try {
          if (!(await work(path)) && isNew) isHalted = true;
        } catch (error) {
          failure ??= error;
          if (isNew) isHalted = true;
        }
      });
    };
    await each(
      plan.moves.map(([from]) => from),
      (from) => this.#moveOne(from, plan.moves.find(([path]) => path === from)?.[1] as string),
    );
    for (const rank of inRanks(plan.writes.keys())) {
      if (isHalted || this.#dead) break;
      await each(rank, (path) =>
        this.#writeOne(path, plan.writes.get(path) as string, hashes.get(path) as string),
      );
    }
    for (const rank of inRanks(plan.removes, true)) {
      if (isHalted || this.#dead) break;
      await each(rank, (path) => this.#removeOne(path));
    }
    if (this.#dead) return;
    // What came of it is known now, whatever it was.
    for (const path of [...plan.writes.keys(), ...plan.removes]) {
      if (this.#intents.delete(path)) this.#dirty.add(path);
    }
    if (!logged) {
      this.unrecorded = true;
      this.#context.changed();
    }
    await this.#keep(logged || undefined);
    if (this.#dead) return;
    this.writtenAt = Date.now();
    this.#settleTrouble(plan, failure);
    if (this.#external.size > 0) this.#arm(0);
  }

  #settleTrouble(plan: Plan, failure: unknown): void {
    if (failure !== undefined) this.#failed(failure);
    else this.#setTrouble(plan.clash ? { reason: "clash", path: plan.clash } : undefined);
  }

  /** Whether the folder does not have a file yet, as far as the editor knows. */
  #isNew(path: string): boolean {
    const there = this.#overwrites.get(path)?.disk;
    if (there) return there.kind === "absent";
    const known = this.#known.get(path);
    return !known || known.stat === ABSENT;
  }

  #plan(files: ReadonlyMap<string, string>, unwritable: ReadonlySet<string>): Plan {
    const writes = new Map<string, string>();
    const removes: string[] = [];
    const moves: [string, string][] = [];
    /** Files the project has under a name that only differs in case, see below. */
    const renamed: [string, string][] = [];
    let clash: string | undefined;
    const paths = [...new Set([...files.keys(), ...this.#known.keys(), ...this.#overwrites.keys()])]
      .filter(isProjectFile)
      .toSorted();
    /** The files of the project by `sameNameKey`, which on Windows is one file. */
    const named = new Map<string, string>();
    for (const path of paths) {
      if (!files.has(path)) continue;
      const key = sameNameKey(path);
      if (named.has(key)) clash ??= path;
      else named.set(key, path);
    }
    for (const path of paths) {
      // A document that the project cannot write as it is stays as the folder has it, and so does
      // a file that cannot be looked at now.
      if (unwritable.has(path) || this.#unlookable.has(path)) continue;
      const text = files.get(path);
      const blocked = this.#blocked.get(path);
      if (blocked) {
        // People did what the file waited for, in the editor: it is what the folder has now.
        if (isAsDisk(text, blocked.disk)) this.#unblock(path, text, blocked.disk);
        continue;
      }
      if (text !== undefined && named.get(sameNameKey(path)) !== path) continue;
      const known = this.#known.get(path);
      const isOverwritten = this.#overwrites.has(path);
      if (!isOverwritten && isSynced(known, text)) continue;
      if (text !== undefined) {
        writes.set(path, text);
        continue;
      }
      // The project is never taken away from its folder by the editor.
      if (path === MANIFEST_FILE) continue;
      if (!isOverwritten && (!known || known.stat === ABSENT)) {
        if (known && known.replaced === undefined) this.#forget(path);
        continue;
      }
      const other = named.get(sameNameKey(path));
      if (other !== undefined) {
        renamed.push([path, other]);
        continue;
      }
      removes.push(path);
    }
    // The same file on Windows, under a name that only differs in case: it moves, and is never
    // taken away, which on Windows would take the other one with it.
    for (const [from, to] of renamed) {
      if (writes.has(to) && !this.#known.has(to)) moves.push([from, to]);
    }
    return { writes, removes, moves, clash };
  }

  #forget(path: string): void {
    this.#known.delete(path);
    this.#dirty.add(path);
  }

  #unblock(path: string, text: string | undefined, disk: Disk): void {
    this.#blocked.delete(path);
    this.#known.set(path, { base: textIn(disk), stat: statIn(disk), synced: syncedOf(text) });
    this.#dirty.add(path);
    this.#context.changed();
  }

  /**
   * Looks at a file right before the editor replaces it, and resolves to what is there when that is
   * what the editor knows: what changed there comes in first. Its size and time say so too, but a
   * program can put back the time, and a browser does not always tell.
   */
  async #isAsKnown(path: string): Promise<Disk | undefined> {
    const now = await this.#look(path);
    if (!now) {
      this.#cannotLook(path);
      return undefined;
    }
    this.#unlookable.delete(path);
    const overwrite = this.#overwrites.get(path);
    if (overwrite) {
      // What is to be written over is what is there, also when something wrote it again since.
      if (holdsTheSame(overwrite.disk, now)) {
        this.#overwrites.set(path, { ...overwrite, disk: now });
        return now;
      }
      // Something else is there now. What to write over goes once that comes in, see `#compare`,
      // which keeps first what is not kept yet of it.
    } else if (isAsBase(now, this.#known.get(path)?.base)) {
      this.#refresh(path, now);
      return now;
    }
    // It changed outside since: that comes in, and the next try goes from there.
    this.#external.add(path);
    return undefined;
  }

  /**
   * Keeps what the folder has of a file before the editor writes over it, where not all of that
   * came in. From then on that is the base of the file. Resolves to false when the file changed in
   * the meantime, which then gets taken in first.
   */
  async #keepFirst(path: string, now: Disk): Promise<boolean> {
    const overwrite = this.#overwrites.get(path);
    if (!overwrite || overwrite.isKept || now.kind === "absent") return true;
    try {
      // What was read of it is what is there, see `#isAsKnown`: a file that cannot be read now
      // can still be kept.
      await this.#backUp(
        path,
        now.stat,
        now.kind === "text" ? encoder.encode(now.text) : undefined,
      );
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
      this.#overwrites.delete(path);
      this.#external.add(path);
      return false;
    }
    this.#overwrites.set(path, { disk: now, isKept: true });
    const known = this.#known.get(path);
    this.#known.set(path, {
      base: textIn(now),
      stat: now.stat,
      synced: undefined,
      ...(known?.replaced !== undefined && { replaced: known.replaced }),
    });
    this.#dirty.add(path);
    // The new base is noted down before the write: should the page go away right after it, and the
    // file change again, the change compares with what came in, not with what was before.
    await this.#keep();
    return !this.#dead;
  }

  async #writeOne(path: string, text: string, hash: string): Promise<boolean> {
    const now = await this.#isAsKnown(path);
    if (!now || this.#dead || !(await this.#keepFirst(path, now))) return false;
    try {
      const file = await this.#folder.write(path, text, { expected: statIn(now) });
      if (this.#dead) return true;
      this.#known.set(path, {
        base: text,
        stat: statOf(file),
        synced: { hash, text },
        replaced: replacedOf(now),
      });
      this.#overwrites.delete(path);
      this.#dirty.add(path);
      return true;
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
      // Another program got there first: what it wrote comes in before this goes again.
      this.#external.add(path);
      return false;
    }
  }

  async #removeOne(path: string): Promise<boolean> {
    const now = await this.#isAsKnown(path);
    if (!now || this.#dead) return false;
    if (now.kind === "absent") {
      this.#overwrites.delete(path);
      if (this.#known.get(path)?.replaced === undefined) this.#forget(path);
      return true;
    }
    if (!(await this.#keepFirst(path, now))) return false;
    try {
      await this.#folder.remove(path, { expected: now.stat });
      if (this.#dead) return true;
      // Nothing is there any more, and what was there is known again after a crash.
      this.#known.set(path, {
        base: undefined,
        stat: ABSENT,
        synced: syncedOf(undefined),
        replaced: replacedOf(now),
      });
      this.#overwrites.delete(path);
      this.#dirty.add(path);
      return true;
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
      this.#external.add(path);
      return false;
    }
  }

  async #moveOne(from: string, to: string): Promise<boolean> {
    const known = this.#known.get(from);
    if (!known || known.stat === ABSENT) return true;
    try {
      await this.#folder.move(from, to, { expected: known.stat });
    } catch (error) {
      if (!isFolderError(error, "changed", "exists")) throw error;
      this.#external.add(from);
      this.#external.add(to);
      return false;
    }
    if (this.#dead) return true;
    const now = await this.#look(to);
    this.#forget(from);
    if (now?.kind === "text") {
      this.#known.set(to, { base: known.base, stat: now.stat, synced: undefined });
      this.#dirty.add(to);
    }
    return true;
  }

  /**
   * Puts a copy of a file in RECOVERED_FOLDER, byte for byte, before the editor writes over it:
   * what was read of it, `given`, or else what is there. With `expected` only while it is still that
   * file, and rejects with "changed" otherwise. Resolves to where it went, or to undefined when
   * there is no file.
   */
  async #backUp(
    path: string,
    expected?: FileStat,
    given?: Uint8Array<ArrayBuffer>,
  ): Promise<string | undefined> {
    const folder = this.#folder;
    let bytes: Uint8Array<ArrayBuffer>;
    if (given) bytes = given;
    else {
      try {
        const file = await folder.file(path);
        if (expected && !isSameStat(statOf(file), expected)) {
          throw new FolderError("changed", path);
        }
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (isFolderError(error, "missing")) return undefined;
        if (error instanceof FolderError) throw error;
        // It changed while it was read.
        throw new FolderError("changed", path, { cause: error });
      }
    }
    try {
      await folder.write(IGNORE_FILE, "*\n", { expected: "absent" });
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
    }
    const stamp = stampOf(Date.now());
    const name = path.split("/").at(-1) as string;
    for (let number = 1; number <= 100; number++) {
      const place = `${RECOVERED_FOLDER}/${stamp}${number === 1 ? "" : `-${number}`}`;
      // The whole path says best where it came from, and a path too long for the system gets less.
      for (const target of [`${place}/${path}`, `${place}/${name}`]) {
        try {
          await folder.write(target, bytes, { expected: "absent" });
          return target;
        } catch (error) {
          if (isFolderError(error, "changed", "exists")) break;
          if (isFolderError(error, "too-long", "refused") && target !== `${place}/${name}`) {
            continue;
          }
          throw error;
        }
      }
    }
    throw new FolderError("failed", path);
  }

  /** A file the editor wrote that a crash damaged: kept, then written again from the log. */
  async #recover(path: string, now: Disk): Promise<void> {
    try {
      await this.#backUp(path, now.kind === "absent" ? undefined : now.stat);
    } catch (error) {
      if (!(error instanceof FolderError)) throw error;
      const message = "这个文件坏了，没能先备份到 .animaquill/recovered，所以没有重写";
      const problem: Problem = { severity: "error", code: "not-kept", file: path, message };
      if (this.#intents.delete(path)) this.#dirty.add(path);
      this.#block(path, now, [problem], false, this.#known.get(path)?.base);
      return;
    }
    this.#overwrites.set(path, { disk: now, isKept: true });
    // Until it is written again, this is what the editor replaces: should the page go away before,
    // the next one knows it again by that, also when the editor wrote something else meanwhile.
    const replaced = replacedOf(now);
    const known = this.#known.get(path) ?? { base: undefined, stat: ABSENT, synced: undefined };
    this.#known.set(path, {
      ...known,
      synced: undefined,
      ...(replaced !== undefined && { replaced }),
    });
    this.#dirty.add(path);
  }

  async #useEditorContent(paths: readonly string[] | undefined): Promise<void> {
    const isRestoring = this.trouble?.reason === "manifest-gone";
    const { files } = this.#context.store.exportFiles();
    const wanted =
      paths ??
      (isRestoring
        ? [...new Set([...files.keys(), ...this.#known.keys(), ...this.#blocked.keys()])].filter(
            isProjectFile,
          )
        : [...this.#blocked.keys()]);
    for (const path of wanted) {
      if (!isRestoring && !this.#blocked.has(path)) continue;
      const now = await this.#look(path);
      if (!now) {
        this.#cannotLook(path);
        continue;
      }
      const text = files.get(path);
      this.#blocked.delete(path);
      const known = this.#known.get(path);
      if (isAsDisk(text, now)) {
        this.#overwrites.delete(path);
        this.#known.set(path, { base: textIn(now), stat: statIn(now), synced: syncedOf(text) });
        this.#dirty.add(path);
      } else {
        // What the folder has goes first where it can be found again, and only then is it replaced.
        await this.#backUp(path, now.kind === "absent" ? undefined : now.stat);
        this.#overwrites.set(path, { disk: now, isKept: true });
        if (known) this.#known.set(path, { ...known, synced: undefined });
      }
    }
    if (isRestoring) this.#setTrouble(undefined);
    this.#isBehind = true;
    this.#context.changed();
    await this.#pass();
  }
}

/**
 * Keeps one project folder and the open project in step, for this window: see the top of this file.
 * It does not touch the page; whoever shows the project tells people what the snapshot says.
 */
export class FolderSession {
  readonly #store: ProjectStore;
  readonly #id: string;
  readonly #bases: FolderBases;
  readonly #writer: FolderWriter;
  readonly #log: FolderLog;
  readonly #timing: FolderTiming;
  #folder: LocalFolder;
  #role: FolderRole = "starting";
  #turn: Turn | undefined;
  #claim: WriterClaim | undefined;
  #waiting: AbortController | undefined;
  #isTakingOver = false;
  #isAsking = false;
  #isClosed = false;
  #close = () => {};
  readonly #closed: Promise<void>;
  #ready: Promise<void> | undefined;
  /** Why this window does not write the folder for now, see the role "stopped". */
  #stopped: FolderTrouble | undefined;
  #unpark = () => {};
  /** The last turn left the folder written, but not noted down, see `FolderSnapshot.unrecorded`. */
  #unrecorded = false;
  /** The folder is left as it is for now, see `hold`. */
  #held = false;
  /** The turn that compared the folder with the project, see `FolderSnapshot.compared`. */
  #compared: Turn | undefined;
  readonly #emitter = new Emitter();
  readonly #mergeListeners = new Set<(merge: FolderMerge) => void>();
  #snapshot: FolderSnapshot = {
    role: "starting",
    status: "saving",
    trouble: undefined,
    blocked: [],
    writtenAt: undefined,
    unrecorded: false,
    compared: false,
  };
  readonly #stop: readonly (() => void)[];

  constructor({ store, folder, id, bases, writer, log, timing }: FolderSessionOptions) {
    this.#store = store;
    this.#folder = folder;
    this.#id = id;
    this.#bases = bases;
    this.#writer = writer;
    this.#log = log;
    this.#timing = { ...FOLDER_TIMING, ...timing };
    this.#closed = new Promise((resolve) => {
      this.#close = resolve;
    });
    this.#stop = [
      store.subscribe(() => this.#turn?.changed()),
      store.onLocalUpdate(() => this.#maybeTakeOver()),
    ];
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): FolderSnapshot => this.#snapshot;

  get folder(): LocalFolder {
    return this.#folder;
  }

  /** Hears about changes from the folder that came in, to tell people and let them take it back. */
  onMerge(listener: (merge: FolderMerge) => void): () => void {
    this.#mergeListeners.add(listener);
    return () => this.#mergeListeners.delete(listener);
  }

  /**
   * Starts keeping the folder. Resolves once this window writes it and has compared it with the
   * project, or once it knows that another window writes it, or why nobody can.
   */
  start(): Promise<void> {
    if (!this.#ready) {
      let ready = () => {};
      this.#ready = new Promise((resolve) => {
        ready = resolve;
      });
      void this.#run(ready)
        .catch((error: unknown) => console.warn("The project folder is not kept any more", error))
        .finally(ready);
    }
    return this.#ready;
  }

  /**
   * Writes what is waiting right away, as for Ctrl+S, before the project closes and when the page
   * goes out of sight. Resolves to whether the folder has everything that can be written. Where
   * another window writes the folder, all this one can do is have everything in the log.
   */
  async flush(): Promise<boolean> {
    const turn = this.#turn;
    if (turn) return turn.flush();
    if (this.#stopped) return false;
    return this.#log.saved();
  }

  /** Resolves once nothing this window started for the folder is on its way any more. */
  async idle(): Promise<void> {
    for (;;) {
      const turn = this.#turn;
      if (!turn) return;
      const work = turn.work;
      await work;
      if (this.#turn === turn && turn.work === work) return;
    }
  }

  /** Writes what is waiting, and lets go of the folder for the next window. */
  async close(): Promise<void> {
    if (this.#isClosed) return;
    await this.#turn?.flush().catch(() => false);
    this.#isClosed = true;
    this.#close();
    this.#unpark();
    this.#waiting?.abort();
    for (const stop of this.#stop) stop();
    this.#turn?.stop();
    this.#turn = undefined;
    this.#claim?.release();
    this.#claim = undefined;
    this.#setRole("closed");
  }

  /**
   * Writes what the editor has over files that wait for people, see `FolderSnapshot.blocked`: all of
   * them, or these. What the folder has of them is kept in RECOVERED_FOLDER first. When animaquill.json
   * went away outside, this restores the whole project in the folder. Resolves to false where another
   * window writes the folder.
   */
  async useEditorContent(paths?: readonly string[]): Promise<boolean> {
    const turn = this.#turn;
    if (!turn) return false;
    await turn.useEditorContent(paths);
    return true;
  }

  /**
   * Keeps what the folder has of these files in RECOVERED_FOLDER, before the editor writes over it
   * on purpose, as when people take back what came in. Resolves to where each went, see
   * `Turn.keep`, or to undefined where another window writes the folder. Rejects with why one
   * could not be kept: then nothing should be written over them.
   */
  async keep(paths: readonly string[]): Promise<readonly string[] | undefined> {
    const turn = this.#turn;
    if (!turn) return undefined;
    return turn.keep(paths);
  }

  /**
   * Leaves the folder as it is for now, or goes on with it: while the project cannot be edited, as
   * one of a platform whose repository cannot be used (the design of the start page of AnimaQuill
   * Cloud, 5.1), nothing is written to it, and nothing that changes in it comes in. Neither is
   * lost: what the project has and the folder does not stays in the log, what changed in the
   * folder stays in its files, and once it goes on, the two are compared as when a window takes
   * over writing the folder. Another window does not write it meanwhile either: this one keeps
   * nobody from it, and the others are held as well, as their project cannot be edited either.
   */
  hold(held: boolean): void {
    if (held === this.#held || this.#isClosed) return;
    this.#held = held;
    if (held) {
      // Whatever it was writing gets there; nothing after that does, and its watch stops.
      this.#turn?.stop();
      this.#waiting?.abort();
    } else this.#unpark();
    this.#refresh();
  }

  /** Whether the folder is left as it is for now, see `hold`. */
  get held(): boolean {
    return this.#held;
  }

  /**
   * Goes on with the folder once it is back, or with another folder people found for it, see
   * `FolderTrouble`. A folder knows only its place, so whatever is there has to be this project. A
   * window that stopped because the folder was gone writes it again, or waits for the one that does.
   * Another window that writes it goes on with the folder it has.
   */
  async reconnect(folder: LocalFolder = this.#folder): Promise<Reconnection> {
    const status = await folder.status().catch(() => "gone" as const);
    if (status === "gone") return "gone";
    if (status !== "ready") return "ask";
    let text: string;
    try {
      text = await folder.readText(MANIFEST_FILE);
    } catch (error) {
      return isFolderError(error, "gone") ? "gone" : "not-a-project";
    }
    if (projectIdOf(text) !== this.#store.getState().manifest.id) return "other-project";
    this.#folder = folder;
    if (this.#stopped && this.#stopped.reason !== "outdated") {
      this.#stopped = undefined;
      this.#unpark();
      this.#refresh();
    } else await this.#turn?.reconnected();
    return "connected";
  }

  async #run(ready: () => void): Promise<void> {
    while (!this.#isClosed) {
      if (this.#held) {
        // Until it is let go, see `hold`.
        this.#setRole("stopped");
        ready();
        await new Promise<void>((resolve) => {
          this.#unpark = resolve;
          if (!this.#held || this.#isClosed) resolve();
        });
        continue;
      }
      if (this.#stopped) {
        // Until people find the folder again, see `reconnect`: no window can write it meanwhile.
        this.#setRole("stopped");
        ready();
        if (this.#stopped.reason === "outdated") return;
        await new Promise<void>((resolve) => {
          this.#unpark = resolve;
        });
        continue;
      }
      const claim = await this.#claimTurn(ready);
      if (!claim) {
        // Held while it waited for its turn: it waits to be let go instead.
        if (this.#held && !this.#isClosed) continue;
        return;
      }
      if (this.#isClosed) {
        claim.release();
        return;
      }
      if (this.#held) {
        claim.release();
        continue;
      }
      this.#claim = claim;
      const turn = new Turn({
        store: this.#store,
        id: this.#id,
        bases: this.#bases,
        log: this.#log,
        timing: this.#timing,
        folder: () => this.#folder,
        changed: () => this.#refresh(),
        merged: (merge) => {
          for (const listener of this.#mergeListeners) listener(merge);
        },
      });
      this.#turn = turn;
      this.#setRole("writing");
      await turn.start();
      // Only where it got to compare them: one that failed before is over already.
      if (!turn.isOver) {
        this.#compared = turn;
        this.#refresh();
      }
      ready();
      await Promise.race([claim.lost, turn.ended, this.#closed]);
      turn.stop();
      claim.release();
      this.#unrecorded = turn.unrecorded;
      if (this.#turn === turn) this.#turn = undefined;
      this.#claim = undefined;
      if (this.#isClosed) return;
      if (turn.endReason === "outdated") this.#stopped = { reason: "outdated" };
      else if (turn.endReason === "park") this.#stopped = turn.trouble ?? { reason: "gone" };
      else {
        this.#setRole("waiting");
        // Something failed before the folder could be compared: another window may do better.
        if (turn.endReason === "again") {
          await Promise.race([
            new Promise((resolve) => setTimeout(resolve, this.#timing.retryMs)),
            this.#closed,
          ]);
        }
      }
    }
  }

  /** Waits for the turn to write the folder, or takes it over from a window that sleeps. */
  async #claimTurn(ready: () => void): Promise<WriterClaim | undefined> {
    for (;;) {
      if (this.#isClosed || this.#held) return undefined;
      if (this.#isTakingOver) {
        this.#isTakingOver = false;
        try {
          return await this.#writer.claim({ steal: true });
        } catch (error) {
          console.warn("Could not take over writing the project folder", error);
        }
      }
      const waiting = new AbortController();
      this.#waiting = waiting;
      let isGranted = false;
      try {
        const claim = await this.#writer.claim({
          signal: waiting.signal,
          // A browser can say so late, when this one has the turn already.
          onWaiting: () => {
            if (isGranted || this.#isClosed || this.#waiting !== waiting) return;
            this.#setRole("waiting");
            ready();
          },
        });
        isGranted = true;
        return claim;
      } catch (error) {
        if (!waiting.signal.aborted) {
          // The page goes away with its browser: nothing more happens here.
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          console.warn("Could not find out which window writes the project folder", error);
          await new Promise((resolve) => setTimeout(resolve, this.#timing.retryMs));
        }
      } finally {
        if (this.#waiting === waiting) this.#waiting = undefined;
      }
    }
  }

  /**
   * People changed something here while another window writes the folder. A browser can put that
   * window to sleep with its turn, and then nothing gets written: once it does not answer, this one
   * takes over, see the design, 3.6.
   */
  #maybeTakeOver(): void {
    if (this.#role !== "waiting" || this.#isAsking || this.#isClosed) return;
    this.#isAsking = true;
    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, this.#timing.quietMs));
        if (this.#role !== "waiting" || this.#isClosed) return;
        if (await this.#writer.answers(this.#timing.answerMs)) return;
        if (this.#role !== "waiting" || this.#isClosed) return;
        this.#isTakingOver = true;
        this.#waiting?.abort();
      } finally {
        this.#isAsking = false;
      }
    })();
  }

  #setRole(role: FolderRole): void {
    this.#role = role;
    this.#refresh();
  }

  #refresh(): void {
    const turn = this.#role === "writing" ? this.#turn : undefined;
    const status: FolderSnapshot["status"] = turn
      ? turn.status
      : this.#role === "waiting"
        ? "elsewhere"
        : this.#role === "closed"
          ? "saved"
          : this.#role === "stopped"
            ? "unsaved"
            : "saving";
    const trouble = turn
      ? turn.troubleNow
      : this.#role === "stopped"
        ? this.#held
          ? HELD
          : this.#stopped
        : undefined;
    const blocked = turn?.blocked ?? [];
    const writtenAt = turn?.writtenAt ?? this.#snapshot.writtenAt;
    const unrecorded = turn ? turn.unrecorded : this.#unrecorded;
    const compared = turn !== undefined && this.#compared === turn;
    const before = this.#snapshot;
    const isSameTrouble =
      before.trouble === trouble ||
      (before.trouble?.reason === trouble?.reason &&
        (before.trouble as { path?: string } | undefined)?.path ===
          (trouble as { path?: string } | undefined)?.path);
    const isSame =
      before.role === this.#role &&
      before.status === status &&
      isSameTrouble &&
      before.writtenAt === writtenAt &&
      before.unrecorded === unrecorded &&
      before.compared === compared &&
      before.blocked.length === blocked.length &&
      before.blocked.every(
        (file, index) =>
          file.path === blocked[index]?.path && file.problems === blocked[index]?.problems,
      );
    if (isSame) return;
    this.#snapshot = {
      role: this.#role,
      status,
      trouble,
      blocked,
      writtenAt,
      unrecorded,
      compared,
    };
    this.#emitter.emit();
  }
}
