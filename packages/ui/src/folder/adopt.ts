/**
 * Linking a copy of a project of the platform with a folder that has the same project in it
 * already, see the design of the start page of AnimaQuill Cloud, 4.2 ("对账"): as after the data of
 * the browser was cleared, which takes away what linked them, or with a folder that came from
 * another computer. Both may have changes that the other does not, and nothing says what they had
 * in common, so people choose file by file which side each file is to be, see `reconcile.ts`.
 *
 * Nothing changes on either side before people chose, and then only the files they chose for, and in
 * an order where whatever goes wrong leaves both sides as they were: the folder is read again and
 * compared with what people saw, and so is the project; every file of the folder that goes is kept
 * in `RECOVERED_FOLDER` first, and read back; the folder gets written, and read again and compared
 * with what it is to be; only then does the project of the platform take in what it gets from the
 * folder, as one batch that is in the log before anything else; and only then does this browser
 * keep the project by the folder, as a move into a folder does, see `FolderMove`. Whatever stops it
 * before that puts back what the folder had, takes back what the project took in, and leaves the
 * project in the browser as it was. What was kept stays. Whoever asks people, and has the platform
 * archive first, is `ProjectFolders`.
 */
import { ProjectStore, inRanks } from "@animaquill/core";
import {
  FolderError,
  type FileStat,
  type FolderFileRecord,
  type FolderRecord,
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
  readProject,
  writeProject,
  type Asset,
  type Problem,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import {
  differencesOf,
  isSettled,
  settle,
  type ReconcileChoices,
  type ReconcileDifference,
  type Settled,
} from "../cloud/reconcile.ts";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { elsewhereFile, type ElsewhereFile } from "../storage/places.ts";
import { ImportRefused, readProjectFolder, type ProjectFolder } from "../transfer/import.ts";
import { FolderAssets } from "./assets.ts";
import { IGNORE_FILE, RECOVERED_FOLDER, stampOf } from "./session.ts";

/** What the folder holds of a file of the project, as it was read. */
export interface FoundFile {
  readonly content: Uint8Array<ArrayBuffer>;
  readonly stat: FileStat;
}

/** A folder read as a project: what it reads as, and what its files hold. */
export interface FolderReading {
  readonly reading: ProjectFolder;
  /** Every document and file of code of the project in the folder as it is, by path. */
  readonly found: ReadonlyMap<string, FoundFile>;
  /** The project as files, the way the editor writes them, by path. */
  readonly files: ReadonlyMap<string, string>;
  /** Files of the project that cannot be read. */
  readonly lost: readonly string[];
}

/** What the two sides have, as they were compared, and how they differ. */
export interface AdoptPlan {
  /** What this browser keeps the copy of the project by, see `FolderRecord.id`. */
  readonly key: string;
  readonly folder: LocalFolder;
  /** What the project is called, as the platform has it. */
  readonly name: string;
  /** The project of the platform as files, by path. */
  readonly cloud: ReadonlyMap<string, string>;
  readonly here: FolderReading;
  readonly differences: readonly ReconcileDifference[];
}

export type AdoptLook =
  | { readonly kind: "plan"; readonly plan: AdoptPlan }
  /** Another project is in the folder. */
  | { readonly kind: "other"; readonly name: string }
  /** A newer editor made the project in the folder. */
  | { readonly kind: "too-new" }
  /** The folder cannot be read as a project, see `ImportRefused`. */
  | { readonly kind: "unreadable"; readonly reason: string; readonly problems: readonly Problem[] }
  /** The project of the platform cannot be written as files. */
  | { readonly kind: "invalid"; readonly problems: readonly Problem[] };

/** How far it got, for people to see it go. */
export interface AdoptStep {
  readonly phase: "checking" | "keeping" | "writing" | "linking";
  readonly file: string;
  readonly files: number;
  readonly totalFiles: number;
}

export type AdoptResult =
  /** The project is the folder now, and both sides are what people chose. */
  | {
      readonly kind: "adopted";
      readonly record: FolderRecord;
      /** Where what the folder had of the files that went is kept, if any did. */
      readonly kept: string | undefined;
      /** Files chosen as the folder has them that the project could take only in part. */
      readonly partly: readonly string[];
      /** Assets whose files neither the folder nor this browser has. */
      readonly missing: readonly string[];
      /** Of those, the ones that can come from where they are kept. */
      readonly elsewhere: readonly ElsewhereFile[];
      /** Assets whose files in the folder are other files than the project says: they stay. */
      readonly changedAssets: readonly string[];
    }
  /** Nothing happened, see `reason`. */
  | {
      readonly kind: "refused";
      /**
       * Another window writes the folder, or the project, or the copy is a folder already, or a
       * file has no choice, or the choices do not go together, see `problems`.
       */
      readonly reason: "busy" | "already" | "unsettled";
      readonly problems?: readonly Problem[];
    }
  /** Either side is not what people saw any more: nothing happened, and they look again. */
  | { readonly kind: "changed" }
  /**
   * It stopped, as people said or as something failed: the folder is as it was where `restored`,
   * and the project of the platform as it was where `cloudBack`. What was kept stays.
   */
  | {
      readonly kind: "stopped";
      readonly stage: "keeping" | "writing" | "checking" | "taking" | "linking";
      readonly cancelled: boolean;
      readonly error: unknown;
      readonly restored: boolean;
      readonly cloudBack: boolean;
      readonly kept: string | undefined;
    };

export interface AdoptRunOptions {
  /** Stops it while the folder is being written: what was written is taken back. */
  readonly signal?: AbortSignal;
  readonly onStep?: (step: AdoptStep) => void;
  /**
   * Resolves once every change of the project so far is in its log, to whether it is: what the
   * project takes in from the folder counts only then. See `FolderMove`.
   */
  readonly saved: () => Promise<boolean>;
  /**
   * The record of this very folder, which this browser knows as a project of this computer: it
   * goes once the folder is linked, with what was kept for it. Its window must not be open.
   */
  readonly replacing?: FolderRecord;
}

export interface FolderAdoptOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly t: TFunction;
  readonly hasher?: Hasher;
  readonly now?: () => number;
}

/** What was done to a file of the folder, for putting it back. */
type Done =
  | { readonly kind: "made"; readonly path: string; readonly written: File }
  | {
      readonly kind: "replaced";
      readonly path: string;
      readonly written: File;
      readonly before: Uint8Array<ArrayBuffer>;
    }
  | { readonly kind: "removed"; readonly path: string; readonly before: Uint8Array<ArrayBuffer> };

/** What became of the files of the assets, see `AdoptResult`. */
interface AssetOutcome {
  readonly missing: readonly string[];
  readonly elsewhere: readonly ElsewhereFile[];
  readonly changedAssets: readonly string[];
}

/** A file of the folder that is to become something else. */
interface Change {
  readonly path: string;
  /** What it is to hold, or undefined where it goes. */
  readonly text: string | undefined;
  /** What it holds now, where there is a file. */
  readonly before: FoundFile | undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const textOf = (content: Uint8Array): string | undefined => {
  try {
    return decoder.decode(content);
  } catch {
    return undefined;
  }
};

const statOf = ({ size, lastModified }: FileStat): FileStat => ({ size, lastModified });

const isFolderError = (error: unknown, ...reasons: string[]): boolean =>
  error instanceof FolderError && reasons.includes(error.reason);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/** The folders on the way to a file, deepest first: "a/b" and "a" of "a/b/c.txt". */
const foldersOf = (path: string): string[] => {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/")).toReversed();
};

/** Whether two readings of a folder hold the same, file by file and byte by byte. */
function isSameReading(a: FolderReading, b: FolderReading): boolean {
  if (a.found.size !== b.found.size) return false;
  for (const [path, file] of a.found) {
    const other = b.found.get(path);
    if (!other || !sameBytes(file.content, other.content)) return false;
  }
  return true;
}

function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, text] of a) if (b.get(path) !== text) return false;
  return true;
}

/** Takes a file away, a few times where it is in use. Resolves to whether it is gone. */
async function removing(remove: () => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await remove();
      return true;
    } catch (error) {
      if (isFolderError(error, "missing")) return true;
      if (isFolderError(error, "changed") || attempt === 3) return false;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  return false;
}

export class FolderAdopt {
  readonly #folders: LocalFolders;
  readonly #projects: ProjectLibrary;
  readonly #t: TFunction;
  readonly #hasher: Hasher;
  readonly #now: () => number;

  constructor({ folders, projects, t, hasher = hasherHere, now = Date.now }: FolderAdoptOptions) {
    this.#folders = folders;
    this.#projects = projects;
    this.#t = t;
    this.#hasher = hasher;
    this.#now = now;
  }

  /**
   * Compares the project in a folder with a copy of the project of the platform, `store`, which
   * this browser keeps by `key`: whether it is that project, and which of its files the two have
   * differently. `updatedAt` is when the project of the platform last changed, which only hints at
   * which side of a file is newer. Nothing changes.
   */
  async look(
    key: string,
    store: ProjectStore,
    folder: LocalFolder,
    { updatedAt, signal }: { readonly updatedAt?: number; readonly signal?: AbortSignal } = {},
  ): Promise<AdoptLook> {
    let here: FolderReading;
    try {
      here = await this.read(folder, signal);
    } catch (error) {
      if (!(error instanceof ImportRefused)) throw error;
      if (error.reason === "too-new") return { kind: "too-new" };
      return { kind: "unreadable", reason: error.reason, problems: error.problems };
    }
    const { manifest } = here.reading.project;
    if (manifest.formatVersion > CURRENT_FORMAT_VERSION) return { kind: "too-new" };
    const mine = store.getState().manifest;
    if (manifest.id !== mine.id) return { kind: "other", name: manifest.name };
    const { files: cloud, problems } = store.exportFiles();
    const errors = problems.filter(({ severity }) => severity === "error");
    if (errors.length > 0) return { kind: "invalid", problems: errors };
    const differences = differencesOf(here.files, cloud, {
      lost: here.lost,
      changedAt: (path) => here.found.get(path)?.stat.lastModified,
      updatedAt,
    });
    return {
      kind: "plan",
      plan: { key, folder, name: mine.name, cloud, here, differences },
    };
  }

  /**
   * What both sides are to be with these choices, or why they cannot be carried out, see `settle`.
   * Nothing changes.
   */
  settle(plan: AdoptPlan, store: ProjectStore, choices: ReconcileChoices) {
    return settle(
      store,
      plan.here.files,
      plan.cloud,
      plan.differences,
      choices,
      `adopt-${plan.key}-${this.#now()}`,
    );
  }

  /**
   * Reads a folder as a project, the way a folder that people open is read, with every file of the
   * project as it is in the folder. Rejects with `ImportRefused` where it is no project.
   */
  async read(folder: LocalFolder, signal?: AbortSignal): Promise<FolderReading> {
    const found = new Map<string, FoundFile>();
    const source: SourceFolder = {
      name: folder.name,
      async *files() {
        for await (const path of folder.list()) {
          yield {
            path,
            async read() {
              const file = await folder.file(path);
              const content = new Uint8Array(await file.arrayBuffer());
              found.set(path, { content, stat: statOf(file) });
              return new File([content], file.name, { lastModified: file.lastModified });
            },
          };
        }
      },
    };
    const reading = await readProjectFolder(source, this.#t, signal ? { signal } : {});
    const files = writeProject(reading.project);
    for (const [path, text] of Object.entries(reading.sources)) files.set(path, text);
    const lost = reading.lost.map(({ file }) => file);
    // What reading looked at that is not part of the project, such as the files of assets.
    for (const path of found.keys()) {
      if (!files.has(path) && !lost.includes(path)) found.delete(path);
    }
    return { reading, found, files, lost };
  }

  /**
   * Carries out what people chose, see the top of this file. `store` is the copy of the project
   * of the platform that was compared, as it is in this window, and `media` the files of its
   * assets that this browser has. While this runs, this window is the one that writes the folder.
   */
  async run(
    plan: AdoptPlan,
    choices: ReconcileChoices,
    store: ProjectStore,
    media: Pick<MediaStore, "get">,
    options: AdoptRunOptions,
  ): Promise<AdoptResult> {
    const claims: WriterClaim[] = [];
    try {
      for (const key of [plan.key, ...(options.replacing ? [options.replacing.id] : [])]) {
        const claim = await this.#claim(key);
        if (!claim) return { kind: "refused", reason: "busy" };
        claims.push(claim);
      }
      if (await this.#isFolder(plan.key)) return { kind: "refused", reason: "already" };
      return await this.#run(plan, choices, store, media, options);
    } finally {
      for (const claim of claims) claim.release();
    }
  }

  async #run(
    plan: AdoptPlan,
    choices: ReconcileChoices,
    store: ProjectStore,
    media: Pick<MediaStore, "get">,
    { signal, onStep, saved, replacing }: AdoptRunOptions,
  ): Promise<AdoptResult> {
    const { folder, key } = plan;
    // What people chose for is what they saw: either side that changed since is looked at again.
    onStep?.({ phase: "checking", file: folder.name, files: 0, totalFiles: 0 });
    let now: FolderReading;
    try {
      now = await this.read(folder, signal);
    } catch {
      return { kind: "changed" };
    }
    if (!isSameReading(now, plan.here) || !sameFiles(store.exportFiles().files, plan.cloud)) {
      return { kind: "changed" };
    }
    const settled = this.settle(plan, store, choices);
    if (!isSettled(settled)) {
      return { kind: "refused", reason: "unsettled", problems: settled.problems };
    }
    const changes = this.#changesOf(plan, settled, choices);
    if (!changes) {
      return {
        kind: "refused",
        reason: "unsettled",
        problems: [{ severity: "error", code: "reconcile", file: "", message: "unasked" }],
      };
    }

    // What the folder has of every file that goes, kept and read back before anything changes.
    let kept: string | undefined;
    const going = changes.filter(({ before }) => before !== undefined);
    if (going.length > 0) {
      try {
        kept = await this.#keep(folder, going, onStep);
      } catch (error) {
        return {
          kind: "stopped",
          stage: "keeping",
          cancelled: false,
          error,
          restored: true,
          cloudBack: true,
          kept: undefined,
        };
      }
    }
    const done: Done[] = [];
    const stop = async (
      stage: "writing" | "checking" | "taking" | "linking",
      error: unknown,
      cloudBack = true,
    ): Promise<AdoptResult> => {
      await this.#forgetHashes(key);
      const restored = await this.#restore(folder, done);
      return {
        kind: "stopped",
        stage,
        cancelled: signal?.aborted === true,
        error,
        restored,
        cloudBack,
        kept,
      };
    };

    // The folder becomes what people chose: the files of assets it lacks come from the browser.
    let assets: AssetOutcome;
    try {
      assets = await this.#assets(plan, settled, media, done, signal, onStep);
      await this.#write(folder, changes, done, signal, onStep);
    } catch (error) {
      return stop("writing", error);
    }
    let written: FolderReading;
    try {
      signal?.throwIfAborted();
      onStep?.({ phase: "checking", file: folder.name, files: 0, totalFiles: 0 });
      written = await this.read(folder, signal);
    } catch (error) {
      return stop("checking", error);
    }
    if (written.lost.length > 0 || !sameFiles(written.files, settled.after)) {
      return stop("checking", new Error("The folder is not what it was to become"));
    }

    // The project of the platform takes in what it gets from the folder, as one batch: once that is
    // in its log, it is a change like any other. Whatever stops it from here takes that back.
    onStep?.({ phase: "linking", file: plan.name, files: 0, totalFiles: 0 });
    let took = false;
    const takeBack = async (): Promise<boolean> => {
      if (!took) return true;
      const undone = store.undoOrigin(settled.origin);
      return undone.ok && undone.kept.length === 0 && (await saved());
    };
    if (settled.changes.length > 0) {
      const merged = store.mergeFiles(settled.changes, {
        origin: settled.origin,
        baseOf: (path) => settled.after.get(path),
      });
      took = merged.ok && merged.patches.length > 0;
      const isAll = merged.ok && merged.files.every(({ status }) => status === "merged");
      if (!isAll) {
        const back = await takeBack();
        return stop(
          "taking",
          new Error(merged.ok ? "Not all of it came in" : merged.error.message),
          back,
        );
      }
      if (!(await saved())) {
        const back = await takeBack();
        return stop("taking", new Error("The log of the project cannot be written"), back);
      }
    }

    // What the editor knows the files of the folder by, then the record, which makes the folder the
    // project, as for a move.
    const { bases, records } = this.#folders;
    const { id: project, name } = store.getState().manifest;
    const record: FolderRecord = { id: key, folder, project, name, openedAt: this.#now() };
    try {
      const turn = await bases.claim(key);
      const put: FolderFileRecord[] = [...written.found].map(([path, { content, stat }]) => {
        const base = textOf(content);
        const text = settled.after.get(path) ?? base;
        return {
          path,
          ...(base !== undefined && { base }),
          stat,
          ...(text !== undefined && { synced: hashText(text) }),
        };
      });
      if (!(await bases.save(key, turn, { put, replace: true }))) {
        throw new Error("Another window claimed the folder meanwhile");
      }
      await records.put(record);
    } catch (error) {
      const back = await takeBack();
      return stop("linking", error, back);
    }
    // From here on the project is the folder. What else lists it follows, and what this browser
    // kept of the folder as a project of this computer goes.
    await this.#projects.toFolder(key).catch((error: unknown) => {
      console.warn(
        "The project is linked with its folder, and the list does not say so yet",
        error,
      );
    });
    if (replacing) {
      await this.#forget(replacing.id).catch((error: unknown) => {
        console.warn("What this browser kept of the folder before stays until later", error);
      });
    }
    return {
      kind: "adopted",
      record,
      kept,
      partly: settled.partly,
      ...assets,
    };
  }

  /**
   * The files of the folder that change: every file that people chose as the platform has it, and
   * every one chosen as the folder has it that the project takes in only in part. Undefined where
   * anything else would change, which nobody chose.
   */
  #changesOf(
    plan: AdoptPlan,
    settled: Settled,
    choices: ReconcileChoices,
  ): readonly Change[] | undefined {
    const { files, found, lost } = plan.here;
    const changes: Change[] = [];
    const paths = new Set([...settled.after.keys(), ...files.keys(), ...lost]);
    for (const path of paths) {
      const text = settled.after.get(path);
      if (!lost.includes(path) && files.get(path) === text) continue;
      const chosen = choices.get(path);
      if (chosen !== "cloud" && !settled.partly.includes(path)) return undefined;
      const before = found.get(path);
      // Nothing there, and nothing to be there: a file the project would have, which it does not.
      if (text === undefined && !before) continue;
      changes.push({ path, text, before });
    }
    return changes;
  }

  /**
   * Keeps what the folder has of these files in a folder of its own in RECOVERED_FOLDER, and reads
   * each back. Resolves to where they are, and rejects where any could not be kept as it was.
   */
  async #keep(
    folder: LocalFolder,
    going: readonly Change[],
    onStep: AdoptRunOptions["onStep"],
  ): Promise<string> {
    try {
      await folder.write(IGNORE_FILE, "*\n", { expected: "absent" });
    } catch (error) {
      if (!isFolderError(error, "changed", "exists")) throw error;
    }
    const stamp = stampOf(this.#now());
    let place: string | undefined;
    for (let number = 1; number <= 100 && place === undefined; number++) {
      const candidate = `${RECOVERED_FOLDER}/${stamp}${number === 1 ? "" : `-${number}`}`;
      let isFree = true;
      for (const { path } of going) {
        const there = await folder.file(`${candidate}/${path}`).then(
          () => true,
          () => false,
        );
        if (there) {
          isFree = false;
          break;
        }
      }
      if (isFree) place = candidate;
    }
    if (place === undefined) throw new FolderError("failed", RECOVERED_FOLDER);
    let files = 0;
    for (const { path, before } of going) {
      if (!before) continue;
      onStep?.({ phase: "keeping", file: path, files, totalFiles: going.length });
      const target = `${place}/${path}`;
      await folder.write(target, before.content, { expected: "absent" });
      const back = await folder.read(target);
      if (!sameBytes(back, before.content)) throw new FolderError("failed", target);
      files += 1;
    }
    return place;
  }

  /**
   * Writes the files that change, each only while it is what was read: the ones that go first,
   * then the others in the order that a move writes them, animaquill.json last.
   */
  async #write(
    folder: LocalFolder,
    changes: readonly Change[],
    done: Done[],
    signal: AbortSignal | undefined,
    onStep: AdoptRunOptions["onStep"],
  ): Promise<void> {
    let files = 0;
    const totalFiles = changes.length;
    for (const { path, before } of changes.filter(({ text }) => text === undefined)) {
      signal?.throwIfAborted();
      onStep?.({ phase: "writing", file: path, files, totalFiles });
      if (!before) continue;
      await folder.remove(path, { expected: before.stat });
      done.push({ kind: "removed", path, before: before.content });
      files += 1;
    }
    const writing = changes.filter(({ text }) => text !== undefined);
    const byPath = new Map(writing.map((change) => [change.path, change]));
    const order = inRanks(writing.map(({ path }) => path).filter((path) => path !== MANIFEST_FILE));
    if (byPath.has(MANIFEST_FILE)) order.push([MANIFEST_FILE]);
    for (const rank of order) {
      for (const path of rank) {
        signal?.throwIfAborted();
        const { text, before } = byPath.get(path) as Change;
        onStep?.({ phase: "writing", file: path, files, totalFiles });
        const written = await folder.write(path, text as string, {
          expected: before ? before.stat : "absent",
          ...(signal && { signal }),
        });
        done.push(
          before
            ? { kind: "replaced", path, written, before: before.content }
            : { kind: "made", path, written },
        );
        files += 1;
      }
    }
  }

  /**
   * The files of the assets of the project as it is to be: where the folder does not have one, the
   * copy that this browser has goes there, checked by its hash as it goes. Nothing that the folder
   * has is written over: a file that is not what the project says stays, and is said.
   */
  async #assets(
    plan: AdoptPlan,
    settled: Settled,
    media: Pick<MediaStore, "get">,
    done: Done[],
    signal: AbortSignal | undefined,
    onStep: AdoptRunOptions["onStep"],
  ): Promise<AssetOutcome> {
    const missing: string[] = [];
    const elsewhere: ElsewhereFile[] = [];
    const changedAssets: string[] = [];
    const { project } = readProject(settled.after);
    if (!project) return { missing, elsewhere, changedAssets };
    const before: Readonly<Record<string, Asset>> = plan.here.reading.project.assets?.assets ?? {};
    const folder = plan.folder;
    const files = new FolderAssets({
      folder: () => folder,
      key: plan.key,
      bases: this.#folders.bases,
      browser: this.#projects.media(plan.key),
      hasher: this.#hasher,
      now: this.#now,
    });
    const seen = new Set<string>();
    try {
      const assets = Object.entries(project.assets?.assets ?? {});
      for (const [id, asset] of assets) {
        signal?.throwIfAborted();
        const { path, hash } = asset;
        const label = asset.name ?? path ?? id;
        if (hash === undefined || seen.has(path)) continue;
        seen.add(path);
        // What the folder had as the project there says the same: its file is the folder's matter.
        const known = before[id];
        if (
          known &&
          known.path === path &&
          known.hash !== undefined &&
          isSameHash(known.hash, hash)
        ) {
          continue;
        }
        const found = await files.fileAt(path);
        if (found.kind === "there") {
          if (!isSameHash(found.hash, hash)) changedAssets.push(path);
          continue;
        }
        if (found.kind === "unknown") {
          changedAssets.push(path);
          continue;
        }
        const file = await media.get(hash);
        if (!file) {
          const kept = elsewhereFile(asset, label);
          if (kept) elsewhere.push(kept);
          else missing.push(label);
          continue;
        }
        onStep?.({ phase: "writing", file: label, files: 0, totalFiles: 0 });
        const copy = this.#hasher.copy(file);
        let written: File;
        try {
          written = await folder.write(path, copy.content, {
            expected: "absent",
            ...(signal && { signal }),
          });
        } catch (error) {
          copy.abandon();
          throw error;
        }
        done.push({ kind: "made", path, written });
        const read = (await copy.hash()) ?? (await this.#hasher.file(file));
        if (isSameHash(read, hash)) continue;
        // What the browser has of it is not the file the project means: it stays out, and is said.
        if (!(await removing(() => folder.remove(path, { expected: written })))) {
          throw new FolderError("changed", path);
        }
        done.pop();
        missing.push(label);
      }
    } finally {
      files.stop();
    }
    return { missing, elsewhere, changedAssets };
  }

  /**
   * Puts back what the folder had, newest first, each file only while it is what was written there:
   * what somebody else wrote since stays. Folders that writing made go again where nothing is in
   * them. Resolves to whether all of it is back.
   */
  async #restore(folder: LocalFolder, done: Done[]): Promise<boolean> {
    let isBack = true;
    const made = new Set<string>();
    for (const step of done.toReversed()) {
      try {
        if (step.kind === "made") {
          if (!(await removing(() => folder.remove(step.path, { expected: step.written })))) {
            isBack = false;
          }
          for (const above of foldersOf(step.path)) made.add(above);
        } else if (step.kind === "replaced") {
          await folder.write(step.path, step.before, { expected: step.written });
        } else {
          await folder.write(step.path, step.before, { expected: "absent" });
        }
      } catch {
        isBack = false;
      }
    }
    done.length = 0;
    const deepest = [...made].toSorted((a, b) => b.split("/").length - a.split("/").length);
    for (const path of deepest) await folder.removeFolder(path).catch(() => false);
    return isBack;
  }

  /** Whether this browser keeps the project by a folder already. */
  async #isFolder(key: string): Promise<boolean> {
    if (await this.#folders.records.get(key)) return true;
    const summaries = await this.#projects.list();
    return summaries.some(({ id, folder }) => id === key && folder === true);
  }

  /** The turn to write the folder of a project, which no other window may have. */
  async #claim(key: string): Promise<WriterClaim | undefined> {
    const waiting = new AbortController();
    try {
      return await this.#folders.writer(key).claim({
        signal: waiting.signal,
        onWaiting: () => queueMicrotask(() => waiting.abort()),
      });
    } catch (error) {
      if (waiting.signal.aborted) return undefined;
      throw error;
    }
  }

  /** What reading the files of the assets noted down, where the folder is not linked after all. */
  async #forgetHashes(key: string): Promise<void> {
    try {
      if (!(await this.#folders.records.get(key))) await this.#folders.bases.forget(key);
    } catch {
      // What stays only takes a little room, and a hash holds only for the very same file.
    }
  }

  /** What this browser kept of a folder as a project of this computer, see `FolderProjects.forget`. */
  async #forget(id: string): Promise<void> {
    await this.#folders.records.remove(id);
    await this.#folders.bases.forget(id);
    await this.#projects.remove(id, { folder: true });
  }
}
