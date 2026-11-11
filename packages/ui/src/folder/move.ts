/**
 * Moving a project of the browser into a folder on this computer, see the design of local projects,
 * section 8. All of it gets written there, as an export does: the files of its assets from what the
 * browser keeps, each checked by its hash as it goes, its documents and code after them,
 * animaquill.json last, and all the while a file that says this is not done yet. Then the folder is
 * read again, the way a folder that people open is, and compared with what was written: every
 * document as it is, the project it reads as, and the file of every asset by its hash. Only when all
 * of that is right does this browser keep the project by its folder: the same record goes on, under
 * the same number, with its log, what is being tried, the code that is not saved and what its
 * exports did, and what was written is what the editor knows the files by, see `FolderBases`. The
 * file that says the move is not done goes last, and a folder that opens takes away what a move
 * that stopped right there left of it. Whatever is not right before that stops it, and the project
 * stays in the browser as it was. The folder stays too, for people to look at, and what was written
 * can go with it once they say so.
 *
 * The file of an asset whose path no folder can have goes to a path of its own, which the project
 * takes in one step once the folder is right. Only folders that the move made itself are ever taken
 * away again. The files of the assets stay in the browser as well, until people let them go, see
 * `FolderMove.release`. Nothing here asks people anything or touches the page: that is
 * `ProjectFolders`.
 */
import {
  INCOMPLETE_FILE,
  ProjectStore,
  inRanks,
  placedAsset,
  type CommandCall,
} from "@animaquill/core";
import {
  FolderError,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  isRefusedByChrome,
  newNameFor,
  sameNameKey,
  type FileStat,
  type FolderFileRecord,
  type FolderRecord,
  type KeptFile,
  type LocalFolder,
  type LocalFolders,
  type MediaStore,
  type ProjectLibrary,
  type SourceFolder,
  type WriterClaim,
} from "@animaquill/host";
import { hashText, isSameHash } from "@animaquill/media";
import {
  CURRENT_FORMAT_VERSION,
  MANIFEST_FILE,
  writeProject,
  type Asset,
  type Problem,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { elsewhereFile, type ElsewhereFile } from "../storage/places.ts";
import { ImportRefused, readProjectFolder, type ProjectFolder } from "../transfer/import.ts";
import { FolderAssets } from "./assets.ts";

/** Where a project goes, as people chose it, see `FolderProjects.placeFor`. */
export interface MovePlace {
  /** The folder people chose. */
  readonly chosen: LocalFolder;
  /** A new folder of this name in it, or none for the chosen folder itself. */
  readonly inside: string | undefined;
}

/** How far a move got, for people to see it go. */
export interface MoveStep {
  /** Writing everything, or reading it again to compare. */
  readonly phase: "writing" | "checking";
  /** What it is at, in words that mean something to people. */
  readonly file: string;
  /** Files done so far, of how many. */
  readonly files: number;
  readonly totalFiles: number;
  /** Bytes done so far, of how many. */
  readonly bytes: number;
  readonly totalBytes: number;
}

export interface MoveOptions {
  /** What the file says that lies in the folder until all of it is right, see `INCOMPLETE_FILE`. */
  readonly notice: string;
  /** Stops it while it writes or compares: what was written is taken back then. */
  readonly signal?: AbortSignal;
  readonly onStep?: (step: MoveStep) => void;
  /**
   * Resolves once every change of the project so far is in its log, to whether it is, see
   * `FolderLog.saved`. What the folder got becomes what the editor knows its files by only then,
   * and new paths of assets are a change of the project.
   */
  readonly saved: () => Promise<boolean>;
}

/** What keeps a project from moving, found before anything gets written. */
export type MoveRefusal =
  /** It is a folder already, maybe since another window moved it. */
  | { readonly kind: "already" }
  /** Another window of this browser is moving it right now. */
  | { readonly kind: "busy" }
  /** A newer editor made it, and this one would leave out what it does not know. */
  | { readonly kind: "too-new" }
  /** Parts that the format does not take, which the folder would not have. */
  | { readonly kind: "invalid"; readonly problems: readonly Problem[] }
  /** Documents and code with names that a folder cannot have, at least on one system. */
  | { readonly kind: "refused"; readonly paths: readonly string[] }
  /**
   * Documents and code with names or paths longer than what the editor makes, see
   * `MAX_NAME_LENGTH`: Windows may not take them, wherever the folder is.
   */
  | { readonly kind: "too-long"; readonly paths: readonly string[] }
  /** Paths that are one file on some systems, so that one would take the place of the other. */
  | { readonly kind: "clashing"; readonly paths: readonly string[] }
  /** Files of assets need paths of their own in the folder, which a locked project cannot take. */
  | { readonly kind: "locked"; readonly paths: readonly string[] };

/** An asset whose file goes to another path, as no folder can have the one it had. */
export interface Rename {
  readonly asset: string;
  readonly from: string;
  readonly to: string;
}

/** What the folder has that is not what was written, see `MoveResult`. */
export type Mismatch =
  /** The folder cannot be read as a project, see `ImportRefused`, or not at all. */
  | {
      readonly kind: "unreadable";
      readonly reason: string;
      readonly problems: readonly Problem[];
    }
  /** A document that reading the folder could not use. */
  | { readonly kind: "lost"; readonly file: string; readonly problems: readonly Problem[] }
  /** A file of the project that the folder does not have. */
  | { readonly kind: "missing"; readonly file: string }
  /** A file that holds something else than what was written. */
  | { readonly kind: "different"; readonly file: string }
  /** A file of a project in the folder, which the project does not have. */
  | { readonly kind: "extra"; readonly file: string }
  /** A document that holds what was written, and still reads as something else. */
  | { readonly kind: "other"; readonly file: string }
  /** The file of an asset is not in the folder. */
  | { readonly kind: "asset-missing"; readonly file: string }
  /** The file of an asset is another one than the project says. */
  | { readonly kind: "asset-different"; readonly file: string }
  /** The file of an asset cannot be read now. */
  | { readonly kind: "asset-unreadable"; readonly file: string };

export type MoveResult =
  /** The project is the folder now. */
  | {
      readonly kind: "moved";
      readonly record: FolderRecord;
      /** Assets whose files were not in the browser before, so that the folder does not have them. */
      readonly missing: readonly string[];
      /** Of those, the ones that can come from where they are kept, see `elsewhereFile`. */
      readonly elsewhere: readonly ElsewhereFile[];
      /** Assets whose files the browser had as something else: the folder does not have them. */
      readonly damaged: readonly string[];
      /** Assets whose files went to paths of their own, which the project took in one step. */
      readonly renamed: readonly Rename[];
      /** What the copies of the files of its assets take in the browser, in bytes, see `release`. */
      readonly copies: number;
    }
  | { readonly kind: "refused"; readonly refusal: MoveRefusal }
  /**
   * Writing failed, or people stopped it. What was written is taken back: `cleaned` says whether
   * all of it went. Nothing else changed.
   */
  | {
      readonly kind: "stopped";
      readonly cancelled: boolean;
      /** What it was at, for people. */
      readonly file: string;
      readonly error: unknown;
      readonly cleaned: boolean;
      readonly folder: string;
    }
  /**
   * The folder is not what was written. It stays as it is, for people to look at, until they say
   * that what this wrote goes: `takeBack` resolves to whether all of it went.
   */
  | {
      readonly kind: "unverified";
      readonly folder: string;
      readonly mismatches: readonly Mismatch[];
      readonly takeBack: () => Promise<boolean>;
    }
  /**
   * All of it was in the folder, and right, but this browser could not keep the project by it: what
   * was written is taken back, as after a failure, and the project stays in the browser as it was.
   */
  | {
      readonly kind: "unswitched";
      readonly folder: string;
      readonly error: unknown;
      readonly cleaned: boolean;
    };

/** What letting go of the copies in the browser came to, see `FolderMove.release`. */
export interface Release {
  /** Bytes that are free now. */
  readonly released: number;
  /** Copies that stay, because the folder does not have their files as the project says. */
  readonly missing: readonly KeptFile[];
  /**
   * Copies of files that no asset uses now, which stay while the project is open somewhere: undo
   * can bring back an asset that uses one, and then it can go back to the folder.
   */
  readonly unused: readonly KeptFile[];
}

export interface FolderMoveOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly t: TFunction;
  readonly hasher?: Hasher;
  readonly now?: () => number;
}

/** A project read from its log, which takes what changes in it there too. */
export interface LoadedProject {
  readonly store: ProjectStore;
  /** Resolves once what changed is in the log, to whether it is. */
  saved(): Promise<boolean>;
  close(): void;
}

/** A file of an asset on its way into the folder. */
interface Copy {
  readonly path: string;
  readonly file: Blob;
  readonly hash: string;
  /** For people. */
  readonly label: string;
}

/** An asset whose file is a document of the project as well: it gets compared all the same. */
interface Covered {
  readonly path: string;
  readonly hash: string;
}

/** What gets written, from one moment of the project, as it is with its new paths of assets. */
interface Plan {
  /** Documents and code, by path, animaquill.json too. */
  readonly files: ReadonlyMap<string, string>;
  /** How large each of those is, in bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly copies: readonly Copy[];
  readonly covered: readonly Covered[];
  readonly missing: readonly string[];
  readonly elsewhere: readonly ElsewhereFile[];
  readonly renames: readonly Rename[];
}

/** A file that this wrote, as it was once it was there. */
interface Written {
  readonly path: string;
  readonly file: File;
}

/** Where a move writes, and what of it was there before, which stays whatever happens. */
interface Spot {
  /** The folder of the project. */
  readonly target: LocalFolder;
  /** Whether this move made it, in the folder people chose: then it goes again with the rest. */
  readonly made: boolean;
  readonly place: MovePlace;
  /** Folders of the project that were there before, by path from it, "" for itself. */
  readonly kept: ReadonlyMap<string, LocalFolder>;
}

/** What writing did so far, for taking it back. */
interface Trail {
  /** The file that says it is not done yet, as it was written, once it is there. */
  notice: File | undefined;
  /** Every file that is there, as it was written. */
  readonly written: Written[];
  /** Every file that writing began: one that failed can leave the folders on its way behind. */
  readonly begun: Set<string>;
  /** Assets whose files the browser has as something else, by path: they stay out. */
  readonly damaged: Map<string, string>;
  /** What it is at, for people. */
  file: string;
}

/** How reading the folder found each document, for the bases. */
type Seen = ReadonlyMap<string, FileStat>;

/** What people see of a move, and how they stop it, see `MoveOptions`. */
interface Following {
  readonly signal: AbortSignal | undefined;
  readonly onStep: ((step: MoveStep) => void) | undefined;
}

/** Writes this many documents at the same time, see `WRITE_AT_ONCE` of the host. */
const WRITE_AT_ONCE = 8;
/** A file that cannot go right away, as one that another program holds on to, gets this many tries. */
const CLEANUP_ATTEMPTS = 3;
/** Where the file of an asset goes whose folder no folder can have either. */
const ASSETS_FOLDER = "assets";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const statOf = ({ size, lastModified }: FileStat): FileStat => ({ size, lastModified });

const isFolderError = (error: unknown, reason: string): boolean =>
  error instanceof FolderError && error.reason === reason;

/** Tells failures apart when people pass on what they got to read. */
export const errorName = (error: unknown): string =>
  error instanceof FolderError ? error.reason : error instanceof Error ? error.name : "Error";

function textOf(content: Uint8Array): string | undefined {
  try {
    return decoder.decode(content);
  } catch {
    return undefined;
  }
}

/** The folders on the way to a file, from the top: "a" and "a/b" of "a/b/c.txt". */
function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

const depthOf = (path: string): number => (path === "" ? 0 : path.split("/").length);

/** Runs `work` on every item, `limit` at a time. The first failure comes once all are done. */
async function inTurns<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && !failure) {
      try {
        await work(items[next++] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/** Waits for `work`, unless people stop first: then it goes on by itself, and nobody waits. */
function unlessStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Whether a folder on some system cannot have a file at this path, as Chrome has it. */
const isRefused = (path: string): boolean => path.split("/").some(isRefusedByChrome);

/** Whether a path is as long as what the editor makes at most, see `MAX_PATH_LENGTH`. */
const fits = (path: string): boolean =>
  path.length <= MAX_PATH_LENGTH && path.split("/").every((part) => part.length <= MAX_NAME_LENGTH);

/** Takes a file away, a few times where it is in use. Resolves to whether it is gone. */
async function removing(remove: () => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
    try {
      await remove();
      return true;
    } catch (error) {
      // Gone already, which is all that was to happen to it.
      if (isFolderError(error, "missing")) return true;
      // Somebody else wrote it since: it is theirs now.
      if (isFolderError(error, "changed") || attempt === CLEANUP_ATTEMPTS) return false;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  return false;
}

/** What gives assets new paths, as one change. */
const renameCalls = (renames: readonly Rename[], back = false): CommandCall[] =>
  renames.map(
    ({ asset, from, to }) =>
      ({
        type: "asset.update",
        params: { asset, changes: { path: back ? from : to } },
      }) as CommandCall,
  );

/**
 * The project of a log, as it is now, or undefined when there is nothing of it. What changes in it
 * goes into the log, as for an open project, see `ProjectSession`.
 */
export async function loadProject(
  projects: ProjectLibrary,
  key: string,
): Promise<LoadedProject | undefined> {
  const log = await projects.open(key);
  let store: ProjectStore | undefined;
  try {
    const updates = await log.load();
    store = updates.length === 0 ? undefined : ProjectStore.fromUpdates(updates).store;
  } catch (error) {
    log.close();
    throw error;
  }
  if (!store) {
    log.close();
    return undefined;
  }
  const loaded = store;
  let pending: Promise<boolean> = Promise.resolve(true);
  const stop = loaded.onLocalUpdate((update) => {
    pending = pending.then((isSaved) =>
      log.append(update, loaded.getState().manifest.name).then(
        () => isSaved,
        () => false,
      ),
    );
  });
  return {
    store: loaded,
    saved: () => pending,
    close() {
      stop();
      loaded.destroy();
      log.close();
    },
  };
}

/**
 * New paths for the files of assets whose paths no folder can have, or that are longer than what the
 * editor makes, see `MAX_PATH_LENGTH`: in the folder they were in where that one is fine, otherwise
 * in the assets folder, under the names they had as far as they can. Two assets of one file go to
 * one place.
 */
function renamesOf(state: ReturnType<ProjectStore["getState"]>): Rename[] {
  const assets = Object.entries(state.assets ?? {});
  /** The names in each folder, which a new one must not be, also in another case. */
  const taken = new Map<string, Set<string>>();
  const take = (path: string) => {
    const folder = path.split("/").slice(0, -1).join("/");
    const names = taken.get(folder) ?? new Set<string>();
    names.add(path.split("/").at(-1) as string);
    taken.set(folder, names);
  };
  for (const [, { path }] of assets) take(path);
  for (const path of Object.keys(state.files)) take(path);
  const moved = new Map<string, string>();
  const renames: Rename[] = [];
  for (const [asset, { path }] of assets) {
    if (!isRefused(path) && fits(path)) continue;
    let to = moved.get(path);
    if (to === undefined) {
      const name = path.split("/").at(-1) as string;
      const near = path.split("/").slice(0, -1).join("/");
      for (const folder of [near, ASSETS_FOLDER]) {
        if (folder === "" || isRefused(folder) || !fits(folder)) continue;
        let candidate: string;
        try {
          candidate = `${folder}/${newNameFor(name, taken.get(folder) ?? [], folder)}`;
        } catch {
          continue;
        }
        if (isRefused(candidate) || !fits(candidate)) continue;
        to = candidate;
        break;
      }
      if (to === undefined) continue;
      moved.set(path, to);
      take(to);
    }
    renames.push({ asset, from: path, to });
  }
  return renames;
}

export class FolderMove {
  readonly #folders: LocalFolders;
  readonly #projects: ProjectLibrary;
  readonly #t: TFunction;
  readonly #hasher: Hasher;
  readonly #now: () => number;

  constructor({ folders, projects, t, hasher = hasherHere, now = Date.now }: FolderMoveOptions) {
    this.#folders = folders;
    this.#projects = projects;
    this.#t = t;
    this.#hasher = hasher;
    this.#now = now;
  }

  /** Whether this browser keeps the project by a folder already. */
  async isFolder(key: string): Promise<boolean> {
    if (await this.#folders.records.get(key)) return true;
    const summaries = await this.#projects.list();
    return summaries.some(({ id, folder }) => id === key && folder === true);
  }

  /**
   * What keeps the project from moving, before anything gets written: then people can put it right
   * first. Nothing of the project changes.
   */
  async check(
    key: string,
    store: ProjectStore,
    media: MediaStore,
  ): Promise<MoveRefusal | undefined> {
    const planned = await this.#plan(key, store, media);
    return "refusal" in planned ? planned.refusal : undefined;
  }

  /**
   * Moves the project of the browser that this browser keeps by `key`: writes it into the folder,
   * reads that again and compares it, and only then keeps the project by the folder. `store` is the
   * project as the log has it, or will once `saved` resolves. What changes after this was called
   * goes into the folder once the project is open as a folder. While this runs, this window is the
   * one that writes the folder of the project, see `LocalFolders.writer`.
   */
  async run(
    key: string,
    store: ProjectStore,
    media: MediaStore,
    place: MovePlace,
    options: MoveOptions,
  ): Promise<MoveResult> {
    const planned = await this.#plan(key, store, media);
    if ("refusal" in planned) return { kind: "refused", refusal: planned.refusal };
    const claim = await this.#claim(key);
    if (!claim) {
      const refusal = (await this.isFolder(key)) ? "already" : "busy";
      return { kind: "refused", refusal: { kind: refusal } };
    }
    try {
      // Another window may have moved it in the meantime.
      if (await this.isFolder(key)) return { kind: "refused", refusal: { kind: "already" } };
      return await this.#move(key, store, planned, place, options);
    } finally {
      claim.release();
    }
  }

  /**
   * Takes away what a move that stopped right at the end left of the file that says it is not done,
   * once the folder opens: only while it is the very file the move wrote, see
   * `FolderRecord.unfinished`. Resolves to the record as it is after that.
   */
  async settle(record: FolderRecord): Promise<FolderRecord> {
    const { unfinished } = record;
    if (!unfinished) return record;
    try {
      await record.folder.remove(INCOMPLETE_FILE, { expected: unfinished });
    } catch (error) {
      // Not the file of the move any more: somebody else's. Anything else is tried again next time.
      if (!isFolderError(error, "changed")) return record;
    }
    const { unfinished: _, ...settled } = record;
    await this.#folders.records.put(settled).catch(() => {});
    return settled;
  }

  /**
   * What the copies of the files of the assets take in the browser, of a project that is a folder
   * now, in bytes.
   */
  async copiesOf(key: string): Promise<number> {
    const copies = await this.#projects.copies(key);
    return copies.reduce((sum, { size }) => sum + size, 0);
  }

  /**
   * Lets go of the copies in the browser of the files of the assets of a project that is a folder
   * now, as people say: of the files that the folder has as the project says. A copy of a file
   * that no asset uses now stays while the project is open somewhere, `open`, as undo can bring
   * back an asset that uses it: once it is open nowhere, nothing can. `assets` are those of the
   * project now, and `files` how the folder has them.
   */
  async release(
    key: string,
    assets: Readonly<Record<string, Asset>>,
    files: FolderAssets,
    { open }: { readonly open: boolean },
  ): Promise<Release> {
    const copies = await this.#projects.copies(key);
    const going: KeptFile[] = [];
    const missing: KeptFile[] = [];
    const unused: KeptFile[] = [];
    for (const copy of copies) {
      const users = Object.values(assets).filter(
        ({ hash }) => hash !== undefined && isSameHash(hash, copy.name),
      );
      if (users.length === 0) {
        (open ? unused : going).push(copy);
        continue;
      }
      let isThere = false;
      for (const { path } of users) {
        const found = await files.fileAt(path);
        if (found.kind === "there" && isSameHash(found.hash, copy.name)) {
          isThere = true;
          break;
        }
      }
      (isThere ? going : missing).push(copy);
    }
    if (going.length > 0) {
      // A move that stopped right at the end may not have got to this: the project is a folder.
      await this.#projects.toFolder(key);
      await this.#projects.dropCopies(
        key,
        going.map(({ name }) => name),
      );
    }
    return { released: going.reduce((sum, { size }) => sum + size, 0), missing, unused };
  }

  /**
   * The turn to write the folder of the project, which only a window that has the project open as
   * a folder has otherwise, or one that moves it. Undefined when another window has it.
   */
  async #claim(key: string): Promise<WriterClaim | undefined> {
    const waiting = new AbortController();
    try {
      return await this.#folders.writer(key).claim({
        signal: waiting.signal,
        // Not right away: waiting has to have begun for it to stop.
        onWaiting: () => queueMicrotask(() => waiting.abort()),
      });
    } catch (error) {
      if (waiting.signal.aborted) return undefined;
      throw error;
    }
  }

  /** Where the project goes, and what of it was there before, which stays whatever happens. */
  async #spotFor(place: MovePlace, plan: Plan): Promise<Spot> {
    const { chosen, inside } = place;
    let target = chosen;
    let made = false;
    if (inside !== undefined) {
      const there = await chosen.inside(inside).catch((error: unknown) => {
        if (isFolderError(error, "missing")) return undefined;
        throw error;
      });
      made = there === undefined;
      target = there ?? (await chosen.inside(inside, { create: true }));
    }
    const kept = new Map<string, LocalFolder>();
    if (made) return { target, made, place, kept };
    kept.set("", target);
    const paths = [INCOMPLETE_FILE, ...plan.files.keys(), ...plan.copies.map(({ path }) => path)];
    const folders = [...new Set(paths.flatMap(foldersOf))].toSorted(
      (a, b) => depthOf(a) - depthOf(b),
    );
    for (const folder of folders) {
      const parent = folder.split("/").slice(0, -1).join("/");
      const above = kept.get(parent);
      // A folder in one that is not there is not there either.
      if (!above) continue;
      const name = folder.split("/").at(-1) as string;
      const there = await above.inside(name).catch(() => undefined);
      if (there) kept.set(folder, there);
    }
    return { target, made, place, kept };
  }

  async #move(
    key: string,
    store: ProjectStore,
    plan: Plan,
    place: MovePlace,
    { notice, signal, onStep, saved }: MoveOptions,
  ): Promise<MoveResult> {
    const startedAt = this.#now();
    let spot: Spot;
    try {
      spot = await this.#spotFor(place, plan);
    } catch (error) {
      const folder = place.inside ?? place.chosen.name;
      return { kind: "stopped", cancelled: false, file: folder, error, cleaned: true, folder };
    }
    const { target } = spot;
    const trail: Trail = {
      notice: undefined,
      written: [],
      begun: new Set(),
      damaged: new Map(),
      file: INCOMPLETE_FILE,
    };
    const stopped = async (error: unknown, cancelled: boolean): Promise<MoveResult> => {
      const cleaned = await this.#takeBack(spot, trail);
      return { kind: "stopped", cancelled, file: trail.file, error, cleaned, folder: target.name };
    };
    try {
      await this.#write(spot, plan, notice, trail, { signal, onStep });
    } catch (error) {
      return stopped(error, signal?.aborted === true);
    }
    let compared: { readonly mismatches: readonly Mismatch[]; readonly seen: Seen };
    try {
      compared = await this.#compare(key, target, store, plan, trail, startedAt, {
        signal,
        onStep,
      });
    } catch (error) {
      // Stopped while it was being compared: as if it never got there.
      if (signal?.aborted) {
        await this.#forgetHashes(key);
        return stopped(error, true);
      }
      compared = {
        mismatches: [{ kind: "unreadable", reason: errorName(error), problems: [] }],
        seen: new Map(),
      };
    }
    if (compared.mismatches.length > 0) {
      await this.#forgetHashes(key);
      return {
        kind: "unverified",
        folder: target.name,
        mismatches: compared.mismatches,
        takeBack: () => this.#takeBack(spot, trail),
      };
    }

    // All of it is right. The project takes the new paths of its assets, in one step, and the log
    // has to have all of it before the folder counts: see `FolderSession`. What the editor knows the
    // files by comes next, then the record, which makes the folder the project, and the file that
    // says it is not done goes last: a folder that opens takes it away where the move stopped
    // right before, see `settle`.
    const renamed = plan.renames.length > 0;
    const unswitched = async (error: unknown): Promise<MoveResult> => {
      await this.#forgetHashes(key);
      if (renamed) store.executeBatch(renameCalls(plan.renames, true));
      const cleaned = await this.#takeBack(spot, trail);
      return { kind: "unswitched", folder: target.name, error, cleaned };
    };
    if (renamed) {
      const result = store.executeBatch(renameCalls(plan.renames));
      if (!result.ok) {
        await this.#forgetHashes(key);
        const cleaned = await this.#takeBack(spot, trail);
        return { kind: "unswitched", folder: target.name, error: result.error, cleaned };
      }
    }
    const { bases, records } = this.#folders;
    try {
      if (!(await saved())) throw new Error("The log of the project cannot be written");
      const turn = await bases.claim(key);
      const put: FolderFileRecord[] = [...plan.files].map(([path, text]) => {
        const stat = compared.seen.get(path);
        return { path, base: text, ...(stat && { stat }), synced: hashText(text) };
      });
      if (!(await bases.save(key, turn, { put, replace: true }))) {
        throw new Error("Another window claimed the folder while the project moved");
      }
    } catch (error) {
      return unswitched(error);
    }
    const { id: project, name } = store.getState().manifest;
    const record: FolderRecord = {
      id: key,
      folder: target,
      project,
      name,
      openedAt: this.#now(),
      ...(trail.notice && { unfinished: statOf(trail.notice) }),
    };
    try {
      await records.put(record);
    } catch (error) {
      return unswitched(error);
    }
    // From here on the project is the folder: its record says so. What the list of projects says
    // follows, and gets another chance, see `release`.
    await this.#projects.toFolder(key).catch((error: unknown) => {
      console.warn("The project moved, and the list of projects does not say so yet", error);
    });
    let settled = record;
    if (trail.notice) {
      // Only while it is what this wrote: anything else there is somebody else's.
      const isGone = await removing(() =>
        target.remove(INCOMPLETE_FILE, { expected: trail.notice as File }),
      );
      if (isGone) {
        const { unfinished: _, ...without } = record;
        settled = without;
        await records.put(settled).catch(() => {});
      }
    }
    const copies = await this.copiesOf(key).catch(() => 0);
    return {
      kind: "moved",
      record: settled,
      missing: plan.missing,
      elsewhere: plan.elsewhere,
      damaged: [...trail.damaged.values()],
      renamed: plan.renames,
      copies,
    };
  }

  /**
   * What gets written, and what keeps the project from moving, from one moment of it: as it is with
   * new paths for the files of assets that need them, which the project itself only takes once it
   * moved, see `#move`.
   */
  async #plan(
    key: string,
    store: ProjectStore,
    media: MediaStore,
  ): Promise<Plan | { readonly refusal: MoveRefusal }> {
    if (await this.isFolder(key)) return { refusal: { kind: "already" } };
    if (store.getState().manifest.formatVersion > CURRENT_FORMAT_VERSION) {
      return { refusal: { kind: "too-new" } };
    }
    const renames = renamesOf(store.getState());
    if (renames.length === 0) return this.#planOf(store, media, []);
    // What the project is with the new paths, without changing it.
    const fork = ProjectStore.fromUpdates([store.encodeState()]).store;
    if (!fork) throw new Error("The project cannot be read as it is");
    try {
      const result = fork.executeBatch(renameCalls(renames));
      if (!result.ok) {
        const paths = [...new Set(renames.map(({ from }) => from))].toSorted();
        return { refusal: { kind: "locked", paths } };
      }
      return await this.#planOf(fork, media, renames);
    } finally {
      fork.destroy();
    }
  }

  async #planOf(
    store: ProjectStore,
    media: MediaStore,
    renames: readonly Rename[],
  ): Promise<Plan | { readonly refusal: MoveRefusal }> {
    const state = store.getState();
    const { files, problems } = store.exportFiles();
    const errors = problems.filter(({ severity }) => severity === "error");
    if (errors.length > 0) return { refusal: { kind: "invalid", problems: errors } };

    const refused = new Set<string>();
    const long = new Set<string>();
    const clashing = new Set<string>();
    /** What is at each place of the folder, where some systems do not tell case apart. */
    const places = new Map<string, { readonly path: string; readonly hash?: string }>([
      [sameNameKey(INCOMPLETE_FILE), { path: INCOMPLETE_FILE }],
    ]);
    const sizes = new Map<string, number>();
    for (const [path, text] of files) {
      sizes.set(path, encoder.encode(text).byteLength);
      if (isRefused(path)) refused.add(path);
      else if (!fits(path)) long.add(path);
      const place = sameNameKey(path);
      if (places.has(place)) clashing.add(path);
      else places.set(place, { path });
    }
    const copies: Copy[] = [];
    const covered: Covered[] = [];
    const missing: string[] = [];
    const elsewhere: ElsewhereFile[] = [];
    for (const [id, asset] of Object.entries(state.assets ?? {})) {
      const { path, hash } = asset;
      const label = asset.name ?? path ?? id;
      // Only where no new path was found for it.
      if (isRefused(path)) refused.add(path);
      else if (!fits(path)) long.add(path);
      const place = sameNameKey(path);
      const there = places.get(place);
      if (there) {
        // Two assets of one file, or a text file that is an asset too, are nothing to worry about.
        const text = files.get(there.path);
        const thereHash = there.hash ?? (text === undefined ? undefined : hashText(text));
        const isSame =
          there.path === path &&
          hash !== undefined &&
          thereHash !== undefined &&
          isSameHash(hash, thereHash);
        if (!isSame) clashing.add(path);
        else if (there.hash === undefined) covered.push({ path, hash });
        continue;
      }
      const file = hash === undefined ? undefined : await media.get(hash);
      if (!file || hash === undefined) {
        const placed = placedAsset(state, id);
        const kept = placed && elsewhereFile(placed, label);
        if (kept) elsewhere.push(kept);
        else missing.push(label);
        continue;
      }
      places.set(place, { path, hash });
      copies.push({ path, file, hash, label });
    }
    if (refused.size > 0) return { refusal: { kind: "refused", paths: [...refused].toSorted() } };
    if (long.size > 0) return { refusal: { kind: "too-long", paths: [...long].toSorted() } };
    if (clashing.size > 0) {
      return { refusal: { kind: "clashing", paths: [...clashing].toSorted() } };
    }
    return { files, sizes, copies, covered, missing, elsewhere, renames };
  }

  /**
   * Writes all of it, a file that says it is not done yet first: the files of the assets, each
   * checked by its hash as it is read, then documents and code in turns, what others refer to
   * first, animaquill.json last. `trail` gets every file it begins and every file once it is there,
   * for taking it back. The file of an asset that the browser has as something else does not stay.
   */
  async #write(
    spot: Spot,
    plan: Plan,
    notice: string,
    trail: Trail,
    { signal, onStep }: Following,
  ): Promise<void> {
    const { target } = spot;
    const documents = [...plan.files.keys()].filter((path) => path !== MANIFEST_FILE);
    const totalFiles = 1 + plan.copies.length + plan.files.size;
    let totalBytes = 0;
    for (const { file } of plan.copies) totalBytes += file.size;
    for (const size of plan.sizes.values()) totalBytes += size;
    let files = 0;
    let bytes = 0;
    const step = (file: string, extra = 0) =>
      onStep?.({ phase: "writing", file, files, totalFiles, bytes: bytes + extra, totalBytes });
    // A file of the project is never in the folder before: that is how the place was chosen.
    const put = async (path: string, content: Blob | string, size: number, label = path) => {
      trail.file = label;
      trail.begun.add(path);
      step(label);
      const file = await target.write(path, content, {
        expected: "absent",
        ...(signal && { signal }),
        onProgress: (done) => step(label, done),
      });
      trail.written.push({ path, file });
      files += 1;
      bytes += size;
      step(label);
      return file;
    };
    signal?.throwIfAborted();
    step(INCOMPLETE_FILE);
    trail.notice = await target.write(INCOMPLETE_FILE, notice, {
      expected: "absent",
      ...(signal && { signal }),
    });
    files += 1;
    for (const { path, file, hash, label } of plan.copies) {
      const copy = this.#hasher.copy(file);
      let written: File;
      try {
        written = await put(path, copy.content, file.size, label);
      } catch (error) {
        copy.abandon();
        throw error;
      }
      const read = (await copy.hash()) ?? (await this.#hasher.file(file));
      if (isSameHash(read, hash)) continue;
      // What the browser has of it is not the file the project means: it stays out, and is said.
      const index = trail.written.findIndex((each) => each.file === written);
      if (!(await this.#unwrite(spot, path, written))) {
        throw new FolderError("changed", path);
      }
      trail.written.splice(index, 1);
      trail.damaged.set(path, label);
    }
    const sizeOf = (path: string) => plan.sizes.get(path) ?? 0;
    for (const rank of inRanks(documents)) {
      await inTurns(rank, WRITE_AT_ONCE, async (path) => {
        await put(path, plan.files.get(path) as string, sizeOf(path));
      });
    }
    await put(MANIFEST_FILE, plan.files.get(MANIFEST_FILE) ?? "", sizeOf(MANIFEST_FILE));
  }

  /**
   * Reads the folder again as a project, the way a folder that people open is read, and compares it
   * with what was written: every document as it is in the folder and as it reads, nothing more and
   * nothing less, and every file of an asset by its hash. The file that says it is not done yet is
   * the only thing left out. Resolves to what is not right, and how each document was found.
   */
  async #compare(
    key: string,
    target: LocalFolder,
    store: ProjectStore,
    plan: Plan,
    trail: Trail,
    since: number,
    { signal, onStep }: Following,
  ): Promise<{ readonly mismatches: readonly Mismatch[]; readonly seen: Seen }> {
    const checks = [
      ...plan.copies
        .filter(({ path }) => !trail.damaged.has(path))
        .map(({ path, hash, label, file }) => ({ path, hash, label, size: file.size })),
      ...plan.covered.map(({ path, hash }) => ({ path, hash, label: path, size: 0 })),
    ];
    const totalFiles = plan.files.size + checks.length;
    const totalBytes = checks.reduce((sum, { size }) => sum + size, 0);
    let files = 0;
    let bytes = 0;
    const step = (file: string, extra = 0) =>
      onStep?.({ phase: "checking", file, files, totalFiles, bytes: bytes + extra, totalBytes });
    step(target.name);

    const read = new Map<string, { readonly content: Uint8Array; readonly stat: FileStat }>();
    const source: SourceFolder = {
      name: target.name,
      async *files() {
        for await (const path of target.list()) {
          // It is there until all of it is right, and is nothing of the project.
          if (path === INCOMPLETE_FILE) continue;
          yield {
            path,
            async read() {
              const file = await target.file(path);
              const content = new Uint8Array(await file.arrayBuffer());
              read.set(path, { content, stat: statOf(file) });
              files += 1;
              step(path);
              return new File([content], file.name, { lastModified: file.lastModified });
            },
          };
        }
      },
    };
    let reading: ProjectFolder;
    try {
      reading = await readProjectFolder(source, this.#t, signal ? { signal } : {});
    } catch (error) {
      if (!(error instanceof ImportRefused)) throw error;
      return {
        mismatches: [{ kind: "unreadable", reason: error.reason, problems: error.problems }],
        seen: new Map(),
      };
    }
    const mismatches: Mismatch[] = [];
    const told = new Set<string>();
    const tell = (mismatch: Mismatch & { readonly file: string }) => {
      if (told.has(mismatch.file)) return;
      told.add(mismatch.file);
      mismatches.push(mismatch);
    };
    for (const { file, problems } of reading.lost) tell({ kind: "lost", file, problems });
    for (const [path, text] of plan.files) {
      const found = read.get(path);
      if (!found) tell({ kind: "missing", file: path });
      else if (textOf(found.content) !== text) tell({ kind: "different", file: path });
    }
    for (const path of read.keys()) {
      if (!plan.files.has(path)) tell({ kind: "extra", file: path });
    }
    // What the folder reads as is this project, document by document, also where each file holds
    // what was written: without the browser the folder is all there is of it.
    const reread = writeProject(reading.project);
    for (const [path, text] of Object.entries(reading.sources)) reread.set(path, text);
    for (const path of new Set([...plan.files.keys(), ...reread.keys()])) {
      if (reread.get(path) !== plan.files.get(path)) tell({ kind: "other", file: path });
    }
    if (reading.project.manifest.id !== store.getState().manifest.id) {
      tell({ kind: "other", file: MANIFEST_FILE });
    }

    // Every file of an asset is read all through again for its hash, which is noted down: the
    // project folder does not have to read them all again when it opens.
    let current: { readonly label: string; readonly size: number } | undefined;
    const assets = new FolderAssets({
      folder: () => target,
      key,
      bases: this.#folders.bases,
      browser: this.#projects.media(key),
      hasher: this.#hasher,
      now: this.#now,
      onProgress: ({ reading: going }) => {
        const percent = going[0]?.percent;
        if (current && percent !== undefined) step(current.label, (current.size * percent) / 100);
      },
    });
    try {
      for (const check of checks) {
        signal?.throwIfAborted();
        current = check;
        step(check.label);
        const found = await unlessStopped(assets.fileAt(check.path, { since }), signal);
        if (found.kind === "missing") tell({ kind: "asset-missing", file: check.path });
        else if (found.kind === "unknown") tell({ kind: "asset-unreadable", file: check.path });
        else if (!isSameHash(found.hash, check.hash)) {
          tell({ kind: "asset-different", file: check.path });
        }
        files += 1;
        bytes += check.size;
        current = undefined;
        step(check.label);
      }
    } finally {
      // What is still on its way when people stop is not kept, see `FolderAssets.stop`.
      assets.stop();
    }
    const seen = new Map([...read].map(([path, { stat }]) => [path, stat]));
    return { mismatches, seen };
  }

  /**
   * Takes away a file that this wrote, while it is what was written, through the deepest folder on
   * its way that was there before: only folders that this made go with it.
   */
  async #unwrite(spot: Spot, path: string, file: FileStat): Promise<boolean> {
    for (const folder of ["", ...foldersOf(path)].toReversed()) {
      const kept = spot.kept.get(folder);
      if (!kept) continue;
      const rest = folder === "" ? path : path.slice(folder.length + 1);
      return removing(() => kept.remove(rest, { expected: file }));
    }
    // In a folder that this made for the project, which goes too once it is empty.
    const { chosen, inside } = spot.place;
    return removing(() => chosen.remove(`${inside}/${path}`, { expected: file }));
  }

  /**
   * Takes back what was written, newest first, each file only while it is what was written, then
   * the folders that this made and nothing is in, and the file that says it is not done yet, where
   * this wrote it and nothing else of this stays: a folder made for the project goes with it then,
   * once it is empty. Resolves to whether all of it went, apart from folders that something else
   * is in now.
   */
  async #takeBack(spot: Spot, trail: Trail): Promise<boolean> {
    let isClean = true;
    for (const { path, file } of trail.written.toReversed()) {
      if (!(await this.#unwrite(spot, path, file))) isClean = false;
    }
    // What stays of this move says so: the file that says it is not done stays with it.
    if (!isClean) return false;
    // A write that failed made the folders on its way, with nothing in them.
    const done = new Set(trail.written.map(({ path }) => path));
    const made = new Set<string>();
    for (const path of trail.begun) {
      if (done.has(path)) continue;
      for (const folder of foldersOf(path)) if (!spot.kept.has(folder)) made.add(folder);
    }
    const { chosen, inside } = spot.place;
    for (const folder of [...made].toSorted((a, b) => depthOf(b) - depthOf(a))) {
      const path = spot.made ? `${inside}/${folder}` : folder;
      await (spot.made ? chosen : spot.target).removeFolder(path).catch(() => false);
    }
    if (trail.notice) {
      if (!(await this.#unwrite(spot, INCOMPLETE_FILE, trail.notice))) return false;
      trail.notice = undefined;
    }
    if (spot.made && inside !== undefined) await chosen.removeFolder(inside).catch(() => false);
    return true;
  }

  /**
   * What reading the files of the assets noted down for this number, of a folder that does not
   * become the project. Not where a folder is kept by it after all.
   */
  async #forgetHashes(key: string): Promise<void> {
    try {
      if (!(await this.#folders.records.get(key))) await this.#folders.bases.forget(key);
    } catch {
      // What stays only takes a little room, and a hash holds only for the very same file.
    }
  }
}
