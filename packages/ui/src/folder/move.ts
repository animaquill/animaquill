/**
 * Moving a project of the browser into a folder on this computer, see the design of local projects,
 * section 8. All of it gets written there, as an export does: the files of its assets from what the
 * browser keeps, its documents and code after them, animaquill.json last, and all the while a file
 * that says this is not done yet. Then the folder is read again, the way a folder that people open
 * is, and compared with what was written: every document as it is, the project it reads as, and the
 * file of every asset by its hash. Only when all of that is right does this browser keep the project
 * by its folder: the same record goes on, under the same number, with its log, what is being tried,
 * the code that is not saved and what its exports did, and what was written is what the editor
 * knows the files by, see `FolderBases`. Whatever is not right stops it, and the project stays in
 * the browser as it was. The folder stays too, for people to look at.
 *
 * The files of the assets stay in the browser as well, until people let them go, see
 * `FolderMove.release`. Nothing here asks people anything or touches the page: that is
 * `ProjectFolders`.
 */
import { INCOMPLETE_FILE, ProjectStore } from "@animaquill/core";
import {
  FolderError,
  isRefusedByChrome,
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
import { ImportRefused, readProjectFolder, type ProjectFolder } from "../transfer/import.ts";
import { FolderAssets } from "./assets.ts";
import { inRanks } from "./project-files.ts";

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
   * For a project that is open: resolves once every change of it so far is in its log, to whether
   * it is, see `FolderLog.saved`. What the folder got becomes what the editor knows its files by
   * only then. A project read from its log has all of it there already.
   */
  readonly saved?: () => Promise<boolean>;
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
  /** Paths with names that a folder cannot have, at least on one system. */
  | { readonly kind: "refused"; readonly paths: readonly string[] }
  /** Paths that are one file on some systems, so that one would take the place of the other. */
  | { readonly kind: "clashing"; readonly paths: readonly string[] };

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
  /** The folder is not what was written. It stays as it is, for people to look at. */
  | {
      readonly kind: "unverified";
      readonly folder: string;
      readonly mismatches: readonly Mismatch[];
    }
  /**
   * All of it was in the folder, and right, but this browser could not keep the project by it: what
   * was written is taken back, as after a failure, and the project stays in the browser.
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
  readonly kept: readonly KeptFile[];
}

export interface FolderMoveOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly t: TFunction;
  readonly hasher?: Hasher;
  readonly now?: () => number;
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

/** What gets written, from one moment of the project. */
interface Plan {
  /** Documents and code, by path, animaquill.json too. */
  readonly files: ReadonlyMap<string, string>;
  /** How large each of those is, in bytes. */
  readonly sizes: ReadonlyMap<string, number>;
  readonly copies: readonly Copy[];
  readonly covered: readonly Covered[];
  readonly missing: readonly string[];
}

/** A file that this wrote, as it was once it was there. */
interface Written {
  readonly path: string;
  readonly file: File;
}

/** What writing did so far, for taking it back. */
interface Trail {
  /** The file that says it is not done yet, as it was written, once it is there. */
  notice: File | undefined;
  /** Every file that is there, as it was written. */
  readonly written: Written[];
  /** Every file that writing began: one that failed can leave the folders on its way behind. */
  readonly begun: Set<string>;
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
/**
 * A file that is there for a moment, to take away the empty folders on its way with it: a folder
 * itself can only go that way, see `LocalFolder.remove`.
 */
const TIDY_FILE = ".animaquill-tidy";

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

/**
 * Takes away the folders on the way to a file that are empty, as a failed write leaves them, by
 * putting a file there for a moment. Only empty folders can stay, which nobody takes for a project.
 */
async function tidy(folder: LocalFolder, path: string): Promise<void> {
  const parent = path.split("/").slice(0, -1).join("/");
  if (parent === "") return;
  const placeholder = `${parent}/${TIDY_FILE}`;
  try {
    const file = await folder.write(placeholder, "", { expected: "absent" });
    await folder.remove(placeholder, { expected: file });
  } catch {
    // Empty folders are all that stays.
  }
}

/** The project of a log, as it is now, or undefined when there is nothing of it. */
export async function loadProject(
  projects: ProjectLibrary,
  key: string,
): Promise<ProjectStore | undefined> {
  const log = await projects.open(key);
  try {
    const updates = await log.load();
    return updates.length === 0 ? undefined : ProjectStore.fromUpdates(updates).store;
  } finally {
    log.close();
  }
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
   * first. `store` is what the log has of it, see `run`.
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
   * project as the log has it: what the folder gets is the base of what the editor writes there
   * next, and a log that does not have it would take it back after a crash. What changes after
   * this was called goes into the folder once the project is open as a folder. While this runs,
   * this window is the one that writes the folder of the project, see `LocalFolders.writer`.
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
   * What the copies of the files of the assets take in the browser, of a project that is a folder
   * now, in bytes.
   */
  async copiesOf(key: string): Promise<number> {
    const copies = await this.#projects.copies(key);
    return copies.reduce((sum, { size }) => sum + size, 0);
  }

  /**
   * Lets go of the copies in the browser of the files of the assets of a project that is a folder
   * now, as people say. Only of what the folder has, as the project says it is, and of what no asset
   * of the project uses: the copy of a file that the folder does not have, or has as something
   * else, stays. `assets` are those of the project now, and `files` how the folder has them.
   */
  async release(
    key: string,
    assets: Readonly<Record<string, Asset>>,
    files: FolderAssets,
  ): Promise<Release> {
    const copies = await this.#projects.copies(key);
    if (copies.length === 0) return { released: 0, kept: [] };
    const going: KeptFile[] = [];
    const kept: KeptFile[] = [];
    for (const copy of copies) {
      const users = Object.values(assets).filter(
        ({ hash }) => hash !== undefined && isSameHash(hash, copy.name),
      );
      let isThere = users.length === 0;
      for (const { path } of users) {
        const found = await files.fileAt(path);
        if (found.kind === "there" && isSameHash(found.hash, copy.name)) {
          isThere = true;
          break;
        }
      }
      (isThere ? going : kept).push(copy);
    }
    if (going.length > 0) {
      // A move that stopped right at the end may not have got to this: the project is a folder.
      await this.#projects.toFolder(key);
      await this.#projects.dropCopies(
        key,
        going.map(({ name }) => name),
      );
    }
    return { released: going.reduce((sum, { size }) => sum + size, 0), kept };
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

  async #move(
    key: string,
    store: ProjectStore,
    plan: Plan,
    place: MovePlace,
    { notice, signal, onStep, saved }: MoveOptions,
  ): Promise<MoveResult> {
    const startedAt = this.#now();
    let target: LocalFolder;
    try {
      target =
        place.inside === undefined
          ? place.chosen
          : await place.chosen.inside(place.inside, { create: true });
    } catch (error) {
      const folder = place.inside ?? place.chosen.name;
      return { kind: "stopped", cancelled: false, file: folder, error, cleaned: true, folder };
    }
    const trail: Trail = {
      notice: undefined,
      written: [],
      begun: new Set(),
      file: INCOMPLETE_FILE,
    };
    const stopped = async (error: unknown, cancelled: boolean): Promise<MoveResult> => {
      const cleaned = await this.#takeBack(place, target, trail);
      return { kind: "stopped", cancelled, file: trail.file, error, cleaned, folder: target.name };
    };
    try {
      await this.#write(target, plan, notice, trail, { signal, onStep });
    } catch (error) {
      return stopped(error, signal?.aborted === true);
    }
    let compared: { readonly mismatches: readonly Mismatch[]; readonly seen: Seen };
    try {
      compared = await this.#compare(key, target, store, plan, startedAt, { signal, onStep });
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
      return { kind: "unverified", folder: target.name, mismatches: compared.mismatches };
    }

    // All of it is right. What the editor knows the files by comes first: without the record of
    // the folder nothing goes by it, and the record comes once the folder is a project. The log
    // has to have what the folder has before that, as always, see `FolderSession`.
    const { bases } = this.#folders;
    try {
      if (saved && !(await saved())) throw new Error("The log of the project cannot be written");
      const turn = await bases.claim(key);
      const put: FolderFileRecord[] = [...plan.files].map(([path, text]) => {
        const stat = compared.seen.get(path);
        return { path, base: text, ...(stat && { stat }), synced: hashText(text) };
      });
      if (!(await bases.save(key, turn, { put, replace: true }))) {
        throw new Error("Another window claimed the folder while the project moved");
      }
    } catch (error) {
      await this.#forgetHashes(key);
      const cleaned = await this.#takeBack(place, target, trail);
      return { kind: "unswitched", folder: target.name, error, cleaned };
    }
    trail.file = INCOMPLETE_FILE;
    try {
      // Only while it is what this wrote: anything else there is somebody else's.
      await target.remove(INCOMPLETE_FILE, trail.notice && { expected: trail.notice });
    } catch (error) {
      await this.#forgetHashes(key);
      return stopped(error, false);
    }
    const { id: project, name } = store.getState().manifest;
    const record: FolderRecord = { id: key, folder: target, project, name, openedAt: this.#now() };
    try {
      await this.#folders.records.put(record);
    } catch (error) {
      await this.#forgetHashes(key);
      const cleaned = await this.#takeBack(place, target, trail);
      return { kind: "unswitched", folder: target.name, error, cleaned };
    }
    // From here on the project is the folder: its record says so. What the list of projects says
    // follows, and gets another chance, see `release`.
    await this.#projects.toFolder(key).catch((error: unknown) => {
      console.warn("The project moved, and the list of projects does not say so yet", error);
    });
    const copies = await this.copiesOf(key).catch(() => 0);
    return { kind: "moved", record, missing: plan.missing, copies };
  }

  /** What gets written, and what keeps the project from moving, from one moment of it. */
  async #plan(
    key: string,
    store: ProjectStore,
    media: MediaStore,
  ): Promise<Plan | { readonly refusal: MoveRefusal }> {
    if (await this.isFolder(key)) return { refusal: { kind: "already" } };
    const state = store.getState();
    if (state.manifest.formatVersion > CURRENT_FORMAT_VERSION) {
      return { refusal: { kind: "too-new" } };
    }
    const { files, problems } = store.exportFiles();
    const errors = problems.filter(({ severity }) => severity === "error");
    if (errors.length > 0) return { refusal: { kind: "invalid", problems: errors } };

    const refused = new Set<string>();
    const clashing = new Set<string>();
    /** What is at each place of the folder, where some systems do not tell case apart. */
    const places = new Map<string, { readonly path: string; readonly hash?: string }>([
      [sameNameKey(INCOMPLETE_FILE), { path: INCOMPLETE_FILE }],
    ]);
    const sizes = new Map<string, number>();
    for (const [path, text] of files) {
      sizes.set(path, encoder.encode(text).byteLength);
      if (isRefused(path)) refused.add(path);
      const place = sameNameKey(path);
      if (places.has(place)) clashing.add(path);
      else places.set(place, { path });
    }
    const copies: Copy[] = [];
    const covered: Covered[] = [];
    const missing: string[] = [];
    for (const [id, asset] of Object.entries(state.assets ?? {})) {
      const { path, hash } = asset;
      const label = asset.name ?? path ?? id;
      if (isRefused(path)) {
        refused.add(path);
        continue;
      }
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
        missing.push(label);
        continue;
      }
      places.set(place, { path, hash });
      copies.push({ path, file, hash, label });
    }
    if (refused.size > 0) return { refusal: { kind: "refused", paths: [...refused].toSorted() } };
    if (clashing.size > 0) {
      return { refusal: { kind: "clashing", paths: [...clashing].toSorted() } };
    }
    return { files, sizes, copies, covered, missing };
  }

  /**
   * Writes all of it, a file that says it is not done yet first: the files of the assets, then
   * documents and code in turns, what others refer to first, animaquill.json last. `trail` gets
   * every file it begins and every file once it is there, for taking it back.
   */
  async #write(
    target: LocalFolder,
    plan: Plan,
    notice: string,
    trail: Trail,
    { signal, onStep }: Following,
  ): Promise<void> {
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
    };
    signal?.throwIfAborted();
    step(INCOMPLETE_FILE);
    trail.notice = await target.write(INCOMPLETE_FILE, notice, {
      expected: "absent",
      ...(signal && { signal }),
    });
    files += 1;
    for (const { path, file, label } of plan.copies) await put(path, file, file.size, label);
    const sizeOf = (path: string) => plan.sizes.get(path) ?? 0;
    for (const rank of inRanks(documents)) {
      await inTurns(rank, WRITE_AT_ONCE, (path) =>
        put(path, plan.files.get(path) as string, sizeOf(path)),
      );
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
    since: number,
    { signal, onStep }: Following,
  ): Promise<{ readonly mismatches: readonly Mismatch[]; readonly seen: Seen }> {
    const checks = [
      ...plan.copies.map(({ path, hash, label, file }) => ({ path, hash, label, size: file.size })),
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
      assets.stop();
    }
    const seen = new Map([...read].map(([path, { stat }]) => [path, stat]));
    return { mismatches, seen };
  }

  /**
   * Takes back what was written, newest first, each file only while it is what was written, and
   * the file that says it is not done yet last: a new folder goes with it then, once it is empty.
   * Resolves to whether all of it went, apart from empty folders.
   */
  async #takeBack(place: MovePlace, target: LocalFolder, trail: Trail): Promise<boolean> {
    let isClean = true;
    for (const { path, file } of trail.written.toReversed()) {
      if (!(await removing(() => target.remove(path, { expected: file })))) isClean = false;
    }
    if (!isClean) return false;
    // A write that failed made the folders on its way, with nothing in them.
    const done = new Set(trail.written.map(({ path }) => path));
    for (const path of trail.begun) if (!done.has(path)) await tidy(target, path);
    // Through the folder people chose, so that a folder made for this goes too.
    const top = place.inside === undefined ? target : place.chosen;
    const notice =
      place.inside === undefined ? INCOMPLETE_FILE : `${place.inside}/${INCOMPLETE_FILE}`;
    const isThere = await top.file(notice).then(
      () => true,
      () => false,
    );
    const expected = trail.notice && { expected: trail.notice };
    if (isThere) return removing(() => top.remove(notice, expected));
    if (place.inside !== undefined) await tidy(top, notice);
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
