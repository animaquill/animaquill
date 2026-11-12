/**
 * Projects that are folders on this computer, as people work with them: making one, opening one that
 * they chose, dropped or opened before, letting the editor at it again, finding it when it moved,
 * writing it somewhere else when it is gone, and keeping it in step while it is open, see
 * `FolderSession`. What is in a folder and what this browser keeps of it is `FolderProjects`; this
 * is the part that asks people and tells them.
 */
import {
  INCOMPLETE_FILE,
  isNoneOfIt,
  isProjectFile,
  placedAsset,
  type ProjectStore,
} from "@animaquill/core";
import {
  FolderError,
  type AccessAnswer,
  type FolderRecord,
  type FolderStatus,
  type LocalEntry,
  type LocalFolder,
  type LocalFolders,
  type MediaStore,
  type ProjectAddress,
  type ProjectLibrary,
  type ProjectPresence,
} from "@animaquill/host";
import type { Asset, Problem } from "@animaquill/schema";
import type { TFunction } from "i18next";
import {
  FolderAssets,
  NO_PROGRESS,
  type AssetIssue,
  type AssetProgress,
} from "../folder/assets.ts";
import {
  FolderMove,
  copyOfProject,
  loadProject,
  type CopyResult,
  type CopySource,
  type LoadedProject,
  type Mismatch,
  type MoveRefusal,
  type MoveResult,
  type MoveStep,
} from "../folder/move.ts";
import {
  FolderProjects,
  type FolderLook,
  type FoundAgain,
  type ReadingOptions,
} from "../folder/projects.ts";
import {
  FolderSession,
  RECOVERED_FOLDER,
  type FolderMerge,
  type FolderSnapshot,
  type FolderTiming,
} from "../folder/session.ts";
import type { FolderChoice, FolderRefusal, NewFormat } from "../cloud/create.ts";
import type { Hasher } from "../media/hasher.ts";
import type { ProblemList } from "../problems/list.ts";
import { downloadFrom, downloadableItems, type HereOf } from "../storage/places.ts";
import type { ImportRefused, ImportReport } from "../transfer/import.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { ConfirmOptions, DialogDetail, Dialogs, ProgressDialog } from "./dialogs.ts";
import { Emitter } from "./emitter.ts";
import type { Notifications } from "./notifications.ts";
import { projectKeyOf, type ProjectSession } from "./session.ts";

/** The project folder that is open in this window, and how it is. */
export interface OpenFolder {
  readonly record: FolderRecord;
  readonly snapshot: FolderSnapshot;
}

/**
 * The project folder that the address of this window asks for, which cannot open by itself: people
 * have to let the editor at it first, or find it where it is now.
 */
export interface WaitingFolder {
  readonly record: FolderRecord;
  readonly status: Exclude<FolderStatus, "ready">;
}

/** Files that people brought into a project folder, by where they are. */
export interface PlacedFiles {
  /** In the folder already, by their paths there: they are used where they are. */
  readonly inside: readonly string[];
  /** From somewhere else, to copy in. */
  readonly files: readonly File[];
  /** Names of what cannot come in: folders, and files that cannot be read. */
  readonly unreadable: readonly string[];
}

export interface ProjectFoldersSnapshot {
  readonly open: OpenFolder | undefined;
  readonly waiting: WaitingFolder | undefined;
  /** How many projects moved into folders in other windows: what lists them is out of date. */
  readonly moves: number;
}

export interface ProjectFoldersOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly session: ProjectSession;
  readonly address: ProjectAddress;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly problems: ProblemList;
  readonly t: TFunction;
  /** Leaves the open project, then does the next thing, see `Workbench`. */
  readonly changeProject: (next: () => Promise<unknown>) => Promise<void>;
  /** For a project that comes into this browser for the first time, before it opens. */
  readonly warnAboutCode: (report: ImportReport) => Promise<void>;
  /** The same once it is open, for what people should see in the list of problems. */
  readonly noteArrival: (report: ImportReport) => void;
  /** What an export of the project kept, which goes with what this browser keeps of it. */
  readonly letGo: (id: string) => Promise<void>;
  readonly showProblems: () => void;
  /** What happens to the files of assets, see `MediaLibrary`. */
  readonly assetFiles: AssetFileActions;
  readonly hasher?: Hasher;
  /** Where the project is, for what a file that is not here can be downloaded from. */
  readonly here?: HereOf;
  readonly timing?: Partial<FolderTiming>;
  /** Which windows have which projects open, which a move into a folder has to know. */
  readonly presence?: ProjectPresence;
}

/** What people can do about the file of an asset, and what has to know that one changed. */
export interface AssetFileActions {
  /** Takes the file that is at the path of an asset now, as it is. */
  useNewFile(asset: string): Promise<boolean>;
  /** The file of an asset is at this path now. */
  usePlace(asset: string, path: string): Promise<boolean>;
  /** Files at these paths changed on the disk. */
  filesChanged(paths: readonly string[]): void;
}

/** How long the files of assets are looked at again after what may have changed them settles. */
const CHECK_AFTER_MS = 300;

interface Current {
  readonly session: FolderSession;
  readonly store: ProjectStore;
  readonly assets: FolderAssets;
  record: FolderRecord;
  readonly stop: () => void;
  /** The watch of the files of the assets, of the folder that it watches. */
  assetWatch?: { readonly folder: LocalFolder; readonly stop: () => void };
  /**
   * The assets of the project and where their files are kept, as the files were last compared
   * with: a file that is not here is missing, or can be downloaded from where it is kept.
   */
  checkedAssets?: unknown;
  checkedPlaces?: unknown;
  checkTimer?: ReturnType<typeof setTimeout>;
  checking?: Promise<void> | undefined;
  checkAgain?: boolean;
  /** Written to a new place from what the browser had, without the files of its assets. */
  readonly relocated: boolean;
}

type Listed = Parameters<ProblemList["setFolder"]>[0][number];

/** The files of a project folder that opens, see `ProjectFolders.#filesOf`. */
interface OpeningFiles {
  readonly assets: FolderAssets;
  /** From now on the folder is the one of this session, which can find it somewhere else. */
  follow(session: FolderSession): void;
  /** The project did not open after all. */
  drop(): void;
}

/** More than anybody reads: what of the folder did not come in, since the project opened. */
const MAX_LISTED = 200;
/** Batches of files that can be taken back from elsewhere than their notice, see `undoBatch`. */
const MAX_KNOWN_BATCHES = 50;
/** What of a value the folder had is shown, at most. */
const MAX_SHOWN = 4000;
/** A dialog is no place for thousands of lines. */
const MAX_IN_DIALOG = 100;
/** Often enough to see a move go, and little enough for the files to be what takes the time. */
const STEP_INTERVAL_MS = 100;
/**
 * What writing a file costs whatever its size, as bytes of a large one: about a tenth of a second
 * on Windows, see the design, 2.2, at about 100 MB a second.
 */
const FILE_COST_BYTES = 10_000_000;
/** How fast a guess of how long it takes goes, before the time it took so far says better. */
const GUESSED_BYTES_PER_S = 100_000_000;
/** Until then the guess goes by the files and their size; from then on by how it went so far. */
const MEASURE_AFTER_S = 2;

const NOTHING: ProjectFoldersSnapshot = { open: undefined, waiting: undefined, moves: 0 };

/** A value the way people can read it. */
function shown(value: unknown, t: TFunction): string {
  if (value === undefined) return t("folder.theirsRemoved");
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

/** A list in a dialog, of what is not too long to read. */
function listOf(t: TFunction, title: string, items: readonly string[]): DialogDetail {
  const listed = items.slice(0, MAX_IN_DIALOG);
  const more = items.length - listed.length;
  return {
    title: t("transfer.listTitle", { title, count: items.length }),
    items: more > 0 ? [...listed, t("transfer.andMore", { count: more })] : listed,
  };
}

/** What is wrong with a file, the way the import says it. */
const problemText = (t: TFunction, { file, path, message }: Problem): string =>
  t("transfer.problem", { place: path ? `${file} ${path}` : file, message });

/** How much of a move is done, where every file costs about as much as `FILE_COST_BYTES`. */
const doneOf = ({ files, totalFiles, bytes, totalBytes }: MoveStep): number => {
  const total = totalBytes + totalFiles * FILE_COST_BYTES;
  return total > 0 ? Math.min(1, (bytes + files * FILE_COST_BYTES) / total) : 1;
};

export class ProjectFolders {
  readonly projects: FolderProjects;
  readonly #options: ProjectFoldersOptions;
  readonly #emitter = new Emitter();
  #current: Current | undefined;
  #waiting: WaitingFolder | undefined;
  /** The folder the address asks for, once the page is there to ask people anything. */
  #pending: FolderRecord | undefined;
  #snapshot = NOTHING;
  /** What of the folder did not come in, and why, as problems. */
  #notes: readonly Listed[] = [];
  /** What came in from the folder, by origin, for taking it back later. */
  readonly #batches = new Map<string, { store: ProjectStore; merge: FolderMerge }>();
  /** Files of assets that are not right, as problems. */
  #assetNotes: readonly Listed[] = [];
  /** The same as they were found, for the explorer. */
  #assetIssues: readonly AssetIssue[] = [];
  /**
   * The files of the project folder that is open, or opening: from the moment its project opens,
   * whatever wants a file of it gets it from the folder, see `mediaFor`.
   */
  #assets: { readonly key: string; readonly assets: FolderAssets } | undefined;
  readonly #progressEmitter = new Emitter();
  #progress: AssetProgress = NO_PROGRESS;
  /** Moves projects of the browser into folders, see `moveToFolder`. */
  readonly #mover: FolderMove;
  #moving = false;
  /** See `ProjectFoldersSnapshot.moves`. */
  #moves = 0;
  /** The folder of the open project is left as it is, see `hold`. */
  #held = false;

  constructor(options: ProjectFoldersOptions) {
    this.#options = options;
    this.projects = new FolderProjects({
      folders: options.folders,
      projects: options.projects,
      t: options.t,
    });
    this.#mover = new FolderMove({
      folders: options.folders,
      projects: options.projects,
      t: options.t,
      ...(options.hasher && { hasher: options.hasher }),
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProjectFoldersSnapshot => this.#snapshot;

  /** The folder session of the open project, if it is a folder. */
  get session(): FolderSession | undefined {
    return this.#current?.session;
  }

  /** The files of the assets of the open project, if it is a folder: they are in the folder. */
  assets(): FolderAssets | undefined {
    const opened = this.#assets;
    const { store } = this.#options.session;
    return opened && store && projectKeyOf(store) === opened.key ? opened.assets : undefined;
  }

  /**
   * What files of the project this is kept by, where it is the open folder, see `FolderAssets`.
   * `since` is for an export: every file it reads is read all through again, once since then.
   */
  mediaFor(
    key: string,
    since?: number,
    assets: () => Readonly<Record<string, Asset>> | undefined = () =>
      this.#options.session.store?.getState().assets,
  ): MediaStore | undefined {
    const opened = this.#assets;
    if (opened?.key !== key) return undefined;
    return opened.assets.media(assets, since === undefined ? {} : { since });
  }

  /** Which files of the open project folder are read for their hashes now, see `AssetProgress`. */
  subscribeProgress = this.#progressEmitter.subscribe;
  getProgress = (): AssetProgress => this.#progress;

  #setProgress(progress: AssetProgress): void {
    this.#progress = progress;
    this.#progressEmitter.emit();
  }

  /**
   * Files that people dropped on the open project folder: those that are in it already, by their
   * path there, which are used where they are, and the others, which get copied in. It has to be
   * called in the `drop` event, see `LocalFolders.dropped`.
   */
  async droppedFiles(transfer: DataTransfer): Promise<PlacedFiles> {
    return this.#place(await this.#options.folders.dropped(transfer));
  }

  /**
   * Lets people choose files for the open project folder, starting in it, sorted as `droppedFiles`
   * does. Undefined where the browser cannot ask that way.
   */
  async pickFiles(): Promise<PlacedFiles | undefined> {
    const current = this.#current;
    if (!current) return undefined;
    const picked = await this.#options.folders.chooseFiles(current.session.folder);
    return picked && this.#place(picked);
  }

  async #place(entries: readonly LocalEntry[]): Promise<PlacedFiles> {
    const folder = this.#current?.session.folder;
    const inside: string[] = [];
    const files: File[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.kind === "folder") {
        folders.push(entry.folder.name);
        continue;
      }
      const path = await folder?.pathOf(entry).catch(() => undefined);
      // A file of a scene, a sound or code belongs to that: an asset gets a copy of its own.
      if (path && !isProjectFile(path) && !isNoneOfIt(path)) {
        inside.push(path);
        continue;
      }
      try {
        files.push(await entry.file.read());
      } catch (error) {
        console.warn("A file that people brought in cannot be read", error);
        folders.push(entry.file.name);
      }
    }
    return { inside, files, unreadable: folders };
  }

  /** The files of the assets may have changed, or what the project says about them. */
  #checkSoon(current: Current): void {
    clearTimeout(current.checkTimer);
    current.checkTimer = setTimeout(() => void this.#check(current), CHECK_AFTER_MS);
  }

  /**
   * Compares the files of the assets with the project, and lists what is not right: missing files,
   * which may be somewhere else in the folder, and files that are not what the project says any more,
   * which people can take as they are now. One comparison at a time.
   */
  async #check(current: Current): Promise<void> {
    if (current.checking) {
      current.checkAgain = true;
      return current.checking;
    }
    current.checkAgain = false;
    const { assets, places } = current.store.getState();
    current.checkedAssets = assets;
    current.checkedPlaces = places;
    current.checking = current.assets
      .check(current.store)
      .catch((error: unknown): readonly AssetIssue[] => {
        console.warn("The files of the assets could not be looked at", error);
        return [];
      })
      .then((issues) => {
        if (this.#current !== current) return;
        const { t } = this.#options;
        // Written somewhere new without its files: they are where the project was before.
        const leftBehind =
          current.relocated && issues.some(({ kind }) => kind === "missing" || kind === "elsewhere")
            ? [
                {
                  severity: "warning" as const,
                  text: t("folder.assetsLeftBehind"),
                  origin: t("folder.origin"),
                },
              ]
            : [];
        // Many files that can come from where they are kept are one line, not one each.
        const elsewhere = issues.filter(({ kind }) => kind === "elsewhere");
        const together =
          elsewhere.length > 1
            ? [
                {
                  severity: "warning" as const,
                  text: t("folder.asset.elsewhereMany", { count: elsewhere.length }),
                  origin: t("folder.origin"),
                },
              ]
            : [];
        this.#assetNotes = [
          ...leftBehind,
          ...together,
          ...issues
            .filter(({ kind }) => kind !== "elsewhere" || elsewhere.length === 1)
            .map((issue) => this.#assetProblem(current, issue)),
        ];
        this.#assetIssues = issues;
        this.#changed();
      })
      .finally(() => {
        current.checking = undefined;
        if (current.checkAgain && this.#current === current) void this.#check(current);
      });
    return current.checking;
  }

  /**
   * What is not right with the files of the assets of the open project folder, as last compared:
   * missing ones, which may be somewhere else in it, and ones that another file took the place of.
   */
  get assetIssues(): readonly AssetIssue[] {
    return this.#assetIssues;
  }

  /** Compares the files of the assets with the project again soon, after people changed them. */
  checkAssetsSoon(): void {
    if (this.#current) this.#checkSoon(this.#current);
  }

  /** Waits for what the files of the assets are like, as for a test. */
  async assetsChecked(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    clearTimeout(current.checkTimer);
    await this.#check(current);
  }

  #assetProblem(current: Current, issue: AssetIssue): Listed {
    const { t, assetFiles } = this.#options;
    const after = (done: Promise<boolean>) =>
      void done.then((changed) => changed && this.#checkSoon(current));
    // A problem of the project, as the format has it, and no damaged file: it opens all the same.
    const base = { file: issue.path, origin: t("folder.origin"), severity: "warning" } as const;
    if (issue.kind === "changed") {
      return {
        ...base,
        text: t("folder.asset.changed"),
        action: {
          label: t("folder.asset.useNew"),
          run: () => after(assetFiles.useNewFile(issue.asset)),
        },
      };
    }
    if (issue.kind === "elsewhere") {
      const here = this.#options.here?.();
      const url = placedAsset(current.store.getState(), issue.asset, here)?.url;
      const download = downloadFrom(t, issue.storage, url);
      return { ...base, text: t("folder.asset.elsewhere", { download }) };
    }
    if (issue.hidden !== undefined) {
      return { ...base, text: t("folder.asset.hidden", { name: issue.hidden }) };
    }
    const { found } = issue;
    if (found === undefined) {
      if (!issue.copy) return { ...base, text: t("folder.asset.missing") };
      // What the browser kept from before the project moved, as for an asset that undo brought back.
      return {
        ...base,
        text: t("folder.asset.missing"),
        action: {
          label: t("folder.move.restoreCopy"),
          run: () => void this.#restoreCopy(current, issue.asset, issue.path),
        },
      };
    }
    return {
      ...base,
      text: t("folder.asset.moved", { found }),
      action: {
        label: t("folder.asset.usePlace"),
        run: () => after(assetFiles.usePlace(issue.asset, found)),
      },
    };
  }

  /**
   * Puts the copy of the file of an asset that the browser kept from before the project moved into
   * the folder, at the path of the asset, where nothing is now.
   */
  async #restoreCopy(current: Current, asset: string, path: string): Promise<void> {
    const { notifications, projects, assetFiles, t } = this.#options;
    try {
      const hash = current.store.getState().assets?.[asset]?.hash;
      const copy =
        hash === undefined ? undefined : await projects.media(current.record.id).get(hash);
      if (!copy) throw new Error(`No copy of ${path} in the browser`);
      await current.session.folder.write(path, copy, { expected: "absent" });
      assetFiles.filesChanged([path]);
      this.#checkSoon(current);
    } catch (error) {
      console.warn("A copy could not go back into the project folder", error);
      notifications.push(t("folder.move.restoreFailed", { path, reason: this.#reasonOf(error) }));
    }
  }

  /** Watches the files of the assets in the folder the session has now, which can be another one. */
  #watchAssets(current: Current): void {
    const { folder } = current.session;
    if (current.assetWatch?.folder === folder) return;
    const again = current.assetWatch !== undefined;
    current.assetWatch?.stop();
    const stop = current.assets.watch(
      () => Object.values(current.store.getState().assets ?? {}).map(({ path }) => path),
      (paths) => {
        if (this.#current !== current) return;
        this.#options.assetFiles.filesChanged(paths);
        this.#checkSoon(current);
      },
    );
    current.assetWatch = { folder, stop };
    // Another folder has other files.
    if (again) {
      this.#options.assetFiles.filesChanged(
        Object.values(current.store.getState().assets ?? {}).map(({ path }) => path),
      );
      this.#checkSoon(current);
    }
  }

  /**
   * Notes the project folder that the address of this window asks for, to open once the page is
   * there, see `resume`: opening can ask people things. Resolves to whether the address asks for a
   * project folder, or for what may well be one, which then must not open as a project of the browser.
   */
  async restore(): Promise<boolean> {
    const id = this.#options.address.read();
    if (id === undefined) return false;
    let record: FolderRecord | undefined;
    try {
      record = await this.projects.records.get(id);
    } catch (error) {
      // What the browser knows of folders cannot be read now: whatever this is waits for that.
      console.warn("The folders this browser knows cannot be read", error);
      this.#options.notifications.push(this.#options.t("folder.recordsFailed"));
      return true;
    }
    if (record) {
      this.#pending = record;
      return true;
    }
    // A log of a folder whose record went: it is no project of the browser.
    const summaries = await this.#options.projects.list().catch(() => []);
    return summaries.some((summary) => summary.id === id && summary.folder === true);
  }

  /** Opens the folder that `restore` found, now that people can be asked things on the page. */
  async resume(): Promise<void> {
    const record = this.#pending;
    this.#pending = undefined;
    if (!record) return;
    const status = await this.projects.statusOf(record);
    if (status === "ready") await this.#options.changeProject(() => this.#open(record));
    else this.#setWaiting({ record, status });
  }

  /**
   * Writes what is waiting, right away: for Ctrl+S, and for a page that goes to the background.
   * Resolves to whether the folder has everything now, also when no project folder is open.
   */
  async flush(): Promise<boolean> {
    return (await this.#current?.session.flush()) ?? true;
  }

  /** Writes what is waiting, and lets go of the folder, for the next project or the start page. */
  async close(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    // What comes of the last write is still said: the folder is let go of after it.
    await current.session.flush().catch(() => false);
    if (this.#current !== current) return;
    this.#current = undefined;
    if (this.#assets?.assets === current.assets) this.#assets = undefined;
    current.stop();
    this.#setProgress(NO_PROGRESS);
    this.#notes = [];
    this.#assetNotes = [];
    this.#assetIssues = [];
    this.#changed();
    await current.session.close();
    // The list on the start page shows what the project is called now.
    const { name } = current.store.getState().manifest;
    if (name !== current.record.name) {
      await this.projects.opened(current.record, name).catch(() => {});
    }
  }

  /** Lets go of a folder whose project is not the open one any more, however that happened. */
  followSession(): void {
    const { store } = this.#options.session;
    const current = this.#current;
    if (current && store !== current.store) void this.close();
    // Another project opened: the address asks for that one now.
    if (store && this.#waiting) this.#setWaiting(undefined);
  }

  /** Makes a new project: what it is called, then where it goes, see the design, 3.2. */
  async create(): Promise<void> {
    const name = await this.#askName();
    if (!name) return;
    await this.createNamed(name);
  }

  /**
   * Makes a new project of this name in a folder people choose, see `create`. Has to be called
   * right after people did something: the browser only asks for a folder then.
   */
  async createNamed(name: string, format?: NewFormat): Promise<void> {
    const folder = await this.#choose();
    if (folder) await this.#createIn(folder, name, format);
  }

  /**
   * Asks for a folder for a new project of the platform, see `CloudCreate`, and where in it the
   * project goes, by the rules of a new project, see the design, 3.2: an empty folder takes it, one
   * with other things in it gets a folder of the project's name inside, and one that is a project,
   * is inside one, or has an export that stopped halfway takes none. Nothing is asked: the dialog
   * that makes the project says what it is. Has to be called right after people did something.
   * Undefined where they changed their mind.
   */
  async chooseForNew(name: string): Promise<FolderChoice | FolderRefusal | undefined> {
    let folder: LocalFolder | undefined;
    try {
      folder = await this.#options.folders.choose();
    } catch (error) {
      console.warn("A folder could not be chosen", error);
      return "failed";
    }
    if (!folder) return undefined;
    try {
      const place = await this.projects.placeFor(folder, name);
      switch (place.kind) {
        case "empty":
          return { folder, inside: undefined };
        case "other":
          return { folder, inside: place.inside };
        case "project":
        case "known":
          return "project";
        case "inside":
          return "inside";
        case "incomplete":
          return "incomplete";
      }
    } catch (error) {
      console.warn("What is in a folder could not be read", error);
      return "failed";
    }
  }

  /** Asks for a folder, and opens the project in it. */
  async open(): Promise<void> {
    const folder = await this.#choose();
    if (folder) await this.#openChosen(folder);
  }

  /**
   * Opens what people dropped, which has to be called in the `drop` event: the browser lets go of
   * what was dropped once it is over. Dropping counts as people doing something, so the editor asks
   * for writing right away, once it knows that this can be a project at all.
   */
  dropped(transfer: DataTransfer): void {
    const { folders, notifications, t } = this.#options;
    const entries = folders.dropped(transfer);
    void entries
      .then(async (all) => {
        const entry = all.find((each) => each.kind === "folder");
        if (entry?.kind !== "folder") {
          if (all.length > 0) notifications.push(t("folder.droppedNoFolder"));
          return;
        }
        const { folder } = entry;
        if (!(await this.projects.mayBeProject(folder))) {
          await this.#notice(
            t("folder.refusedTitle", { folder: folder.name }),
            t("folder.refused.not-a-project"),
          );
          return;
        }
        await this.#openChosen(folder, await folder.requestAccess());
      })
      .catch((error: unknown) => this.#failed(error));
  }

  /** The folders opened in this browser, the most recent first. How each is now comes after. */
  list(): Promise<readonly FolderRecord[]> {
    return this.projects.records.list();
  }

  /** A folder opened before, from the list on the start page. */
  async openRecent(record: FolderRecord): Promise<void> {
    const status = await this.projects.statusOf(record);
    if (status === "gone") {
      await this.#whenGone(record);
      return;
    }
    if (status === "blocked") {
      this.#options.notifications.push(this.#options.t("folder.blocked", { name: record.name }));
      return;
    }
    if (status === "ask" && (await record.folder.requestAccess()) !== "granted") return;
    this.#setWaiting(undefined);
    await this.#options.changeProject(() => this.#open(record));
  }

  /**
   * Another place of a folder that is not where it was any more. A folder knows only its place, so
   * whatever people choose has to be this project.
   */
  async findAgain(record: FolderRecord): Promise<void> {
    const { notifications, t } = this.#options;
    const folder = await this.#choose();
    if (!folder) return;
    const current = this.#current;
    if (current?.record.id === record.id) {
      const other = await this.projects.records.find(folder);
      if (other && other.id !== record.id) {
        notifications.push(t("folder.reconnect.taken", { name: record.name, other: other.name }));
        return;
      }
      const answer = await current.session.reconnect(folder);
      if (answer === "connected") {
        current.record = { ...current.record, folder };
        await this.projects.opened(current.record).catch(() => {});
        this.#changed();
      } else {
        notifications.push(t(`folder.reconnect.${answer}`, { name: record.name }));
      }
      return;
    }
    const found = await this.projects
      .findAgain(record, folder)
      .catch((): FoundAgain => "not-a-project");
    if (found !== "found") {
      const other = found === "taken" ? await this.projects.records.find(folder) : undefined;
      notifications.push(
        t(`folder.reconnect.${found}`, { name: record.name, other: other?.name ?? "" }),
      );
      return;
    }
    this.#setWaiting(undefined);
    await this.#options.changeProject(() => this.#open({ ...record, folder }));
  }

  /**
   * Writes the whole project of a folder that is gone to a new place, which people choose as for a
   * new project, from what this browser has of it. From then on that is its folder.
   */
  async saveElsewhere(record: FolderRecord, { asked = false } = {}): Promise<void> {
    const { dialogs, notifications, t } = this.#options;
    if (!asked) {
      // The files of the assets are not in the browser: a folder that only moved has them.
      const answer = await dialogs.choose({
        title: t("folder.elsewhereTitle", { name: record.name }),
        message: t("folder.elsewhereMessage"),
        choices: [
          { id: "find", label: t("folder.findAgain") },
          { id: "elsewhere", label: t("folder.chooseNewPlace"), kind: "primary" },
        ],
      });
      if (answer === "find") await this.findAgain(record);
      if (answer !== "elsewhere") return;
    }
    const chosen = await this.#choose();
    if (!chosen) return;
    const place = await this.#placeFor(chosen, record.name);
    if (!place) return;
    let folder: LocalFolder;
    let moved: FolderRecord;
    try {
      folder =
        place.inside === undefined ? chosen : await chosen.inside(place.inside, { create: true });
      moved = await this.projects.relocate(record, folder);
    } catch (error) {
      console.warn("A project could not be written to a new place", error);
      notifications.push(t("folder.createFailed"));
      return;
    }
    this.#setWaiting(undefined);
    await this.#options.changeProject(() => this.#open(moved, { relocated: true }));
  }

  /**
   * Saves a copy of a project as a project of this computer of its own, in a folder people choose,
   * see the design of the start page of AnimaQuill Cloud, 4.3 ("另存为本地项目"): people are told
   * that it is a copy that does not sync, and can change its name. Only an empty folder takes it,
   * or a new folder in one that has other things in it; one that is a project, or in one, is not
   * asked about, as nothing is to be compared here. `source` brings the project once people chose
   * where, as it is then, and says why where it cannot: the copy gets an id of its own, and all of
   * it is written, read again and compared, see `FolderMove.copy`. What it came from does not
   * change. Then people choose to open the copy or to stay. Resolves to its record, or undefined.
   */
  async saveAsLocal(
    name: string,
    source: (signal: AbortSignal) => Promise<CopySource | undefined>,
  ): Promise<FolderRecord | undefined> {
    const { dialogs, notifications, t } = this.#options;
    const wanted = await dialogs.prompt({
      title: t("folder.saveAs.title", { name }),
      value: name,
      hint: t("folder.saveAs.hint"),
      confirm: t("folder.chooseFolder"),
    });
    if (!wanted) return undefined;
    // The browser asks for a folder only right after people did something: this follows the click.
    const chosen = await this.#choose();
    if (!chosen) return undefined;
    const place = await this.#placeFor(chosen, wanted, undefined, { onlyInside: true });
    if (!place) return undefined;
    const progress = dialogs.progress({
      title: t("folder.saveAs.progress", { name: wanted }),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    let result: CopyResult | undefined;
    let refused: readonly Problem[] | undefined;
    let got: CopySource | undefined;
    try {
      got = await source(progress.signal);
      if (!got || progress.signal.aborted) return undefined;
      const { store, problems } = copyOfProject(got.store, wanted);
      if (!store) refused = problems;
      else {
        try {
          result = await this.#mover.copy(
            store,
            got.media,
            { chosen, inside: place.inside },
            {
              notice: t("folder.saveAs.incompleteNotice"),
              signal: progress.signal,
              onStep: this.#followMove(progress),
            },
          );
        } finally {
          store.destroy();
        }
      }
    } catch (error) {
      console.warn("A copy of a project could not be saved to a folder", error);
      notifications.push(t("folder.saveAs.failed", { name: wanted }));
      return undefined;
    } finally {
      progress.close();
      got?.close();
    }
    if (refused) {
      await this.#refusedMove(wanted, { kind: "invalid", problems: refused });
      return undefined;
    }
    if (!result) return undefined;
    if (result.kind !== "copied") {
      await this.#notMoved(wanted, result, "saveAs");
      return undefined;
    }
    const { record, missing, elsewhere, damaged, renamed } = result;
    const lacking = [...missing, ...elsewhere.map(({ name: file }) => file), ...damaged];
    const answer = await dialogs.choose({
      title: t("folder.saveAs.doneTitle"),
      message: [
        t("folder.saveAs.done", { name: wanted, folder: record.folder.name }),
        ...(lacking.length > 0
          ? [
              t("folder.saveAs.missing", {
                count: lacking.length,
                files: lacking.slice(0, 5).join("、"),
              }),
            ]
          : []),
        ...(renamed.length > 0 ? [t("folder.saveAs.renamed", { count: renamed.length })] : []),
      ].join(""),
      choices: [
        { id: "stay", label: t("folder.saveAs.stay") },
        { id: "open", label: t("folder.saveAs.open"), kind: "primary" },
      ],
    });
    if (answer === "open") await this.openRecent(record);
    return record;
  }

  /**
   * Leaves the folder of the open project as it is, while the project cannot be edited, or goes on
   * with it, see `FolderSession.hold`. It holds for a folder that opens meanwhile too.
   */
  hold(held: boolean): void {
    this.#held = held;
    this.#current?.session.hold(held);
  }

  /** Lets the editor at the open folder again, after the browser took that back. */
  async allowAgain(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    if ((await current.record.folder.requestAccess()) !== "granted") return;
    await current.session.reconnect();
  }

  /**
   * Writes what the editor has over files that wait for people, or puts back the whole project
   * where animaquill.json went away. What the folder had goes to .animaquill/recovered first.
   */
  async writeEditorContent(paths?: readonly string[]): Promise<void> {
    await this.#current?.session.useEditorContent(paths);
  }

  /**
   * Takes a folder off the list. Nothing happens to the folder, but where it is not there, or does
   * not have everything yet, what this browser has is the only copy, which people have to know.
   */
  async remove(record: FolderRecord): Promise<boolean> {
    const { dialogs, notifications, t } = this.#options;
    const status = await this.projects.statusOf(record);
    const isOnly = status !== "ready" || (await this.projects.hasUnwritten(record));
    const confirmed = await dialogs.confirm({
      title: t("folder.removeTitle", { name: record.name }),
      message: isOnly ? t("folder.removeOnlyCopy") : t("folder.removeMessage"),
      confirm: t("folder.remove"),
      ...(isOnly && { danger: true }),
    });
    if (!confirmed) return false;
    try {
      await this.#options.letGo(record.id);
      await this.projects.forget(record.id);
      if (this.#waiting?.record.id === record.id) this.#setWaiting(undefined);
      return true;
    } catch (error) {
      console.warn("A folder could not be taken off the list", error);
      notifications.push(t("folder.removeFailed"));
      return false;
    }
  }

  /** Whether a project is moving into a folder, which leaving the page now would stop halfway. */
  get moving(): boolean {
    return this.#moving;
  }

  /**
   * Whether this window has the project that this browser keeps by `key` open as a folder, or is
   * opening it as one: then it is no project of the browser, to move into a folder.
   */
  holds(key: string | undefined): boolean {
    return key !== undefined && (this.#assets?.key === key || this.#current?.record.id === key);
  }

  /**
   * Moves a project of this browser into a folder on this computer, see the design, section 8:
   * people choose where it goes, as for a new project, all of it gets written there and compared
   * with what the project has, and only then does this browser keep the project by its folder, see
   * `FolderMove`. Whatever is not right stops it, and the project stays as it was. One that is open
   * stays open: its log, what is being tried, the code that is not saved and what its exports did
   * go on. This asks for a folder, so it has to run right after people did something. Resolves to
   * whether it moved.
   */
  async moveToFolder(key: string, chosen?: FolderChoice): Promise<boolean> {
    if (this.#moving) return false;
    this.#moving = true;
    try {
      return await this.#moveToFolder(key, chosen);
    } finally {
      this.#moving = false;
    }
  }

  /** `given`: the folder people chose already, and where in it, as for a new project of the platform. */
  async #moveToFolder(key: string, given?: FolderChoice): Promise<boolean> {
    const { session, projects, presence, dialogs, notifications, t } = this.#options;
    const open = session.key === key ? session.store : undefined;
    // Other windows that have it open go on with the folder once it moved, see `followMove`.
    const others = (await presence?.others(key).catch(() => 0)) ?? 0;
    if (others > 0) {
      const name = open?.getState().manifest.name ?? (await this.#nameOf(key));
      const go = await dialogs.confirm({
        title: t("folder.move.othersTitle", { name, count: others }),
        message: t("folder.move.othersMessage", { count: others }),
        confirm: t("folder.move.othersConfirm"),
      });
      if (!go) return false;
    }
    // The browser asks only right after people did something, so that comes next.
    const chosen = given?.folder ?? (await this.#choose());
    if (!chosen) return false;
    let loaded: LoadedProject | undefined;
    try {
      if (!open) loaded = await loadProject(projects, key);
      const store = open ?? loaded?.store;
      if (!store) {
        notifications.push(t("notice.projectNotFound"));
        return false;
      }
      const saved = open ? () => session.trySave() : (loaded as LoadedProject).saved;
      const { name } = store.getState().manifest;
      // What the folder gets has to be in the log first, see `FolderMove.run`.
      if (!(await saved())) {
        await this.#notice(t("folder.move.refusedTitle", { name }), t("folder.move.unsaved"));
        return false;
      }
      const media = projects.media(key);
      const refusal = await this.#mover.check(key, store, media);
      if (refusal) {
        await this.#refusedMove(name, refusal);
        return false;
      }
      const place = given ?? (await this.#placeFor(chosen, name));
      if (!place) return false;
      const progress = dialogs.progress({
        title: t("folder.move.title", { name }),
        cancel: t("dialog.cancel"),
        stopping: t("transfer.stopping"),
      });
      let result: MoveResult;
      try {
        result = await this.#mover.run(
          key,
          store,
          media,
          { chosen, inside: place.inside },
          {
            notice: t("folder.move.incompleteNotice"),
            signal: progress.signal,
            onStep: this.#followMove(progress),
            saved,
          },
        );
      } finally {
        progress.close();
      }
      if (result.kind !== "moved") {
        await this.#notMoved(name, result);
        return false;
      }
      // The project stays open, and from now on its folder is kept in step with it. The other
      // windows that have it open do the same.
      if (open && session.store === open) await this.#follow(result.record, open);
      presence?.moved(key);
      await this.#moved(name, result);
      return true;
    } catch (error) {
      console.warn("A project could not be moved into a folder", error);
      notifications.push(t("folder.move.failed"));
      return false;
    } finally {
      loaded?.close();
    }
  }

  /**
   * Another window moved a project into a folder. Where it is open here as a project of the
   * browser, it goes on as that folder, without opening again: what is being tried and typed here
   * stays. Whatever lists projects is out of date in any case.
   */
  async followMove(key: string): Promise<void> {
    this.#moves += 1;
    this.#changed();
    const { session, notifications, t } = this.#options;
    const store = session.store;
    if (!store || session.key !== key || this.holds(key)) return;
    const record = await this.projects.records.get(key).catch(() => undefined);
    if (!record || session.store !== store || this.holds(key)) return;
    await this.#follow(record, store);
    notifications.push(
      t("folder.move.movedElsewhere", {
        name: store.getState().manifest.name,
        folder: record.folder.name,
      }),
    );
  }

  /** Keeps the folder of an open project that just moved in step with it. */
  async #follow(record: FolderRecord, store: ProjectStore): Promise<void> {
    await this.#attach(record, store, this.#filesOf(record), false);
    // What the page has of the files came from the browser: from now on it comes from the folder.
    this.#options.assetFiles.filesChanged(
      Object.values(store.getState().assets ?? {}).map(({ path }) => path),
    );
  }

  /** What a project of this browser is called, for people. */
  async #nameOf(key: string): Promise<string> {
    const summaries = await this.#options.projects.list().catch(() => []);
    return summaries.find(({ id }) => id === key)?.name ?? "";
  }

  /** What the copies of the files of the assets of a project that moved take in the browser. */
  copiesOf(record: FolderRecord): Promise<number> {
    return this.#mover.copiesOf(record.id).catch(() => 0);
  }

  /**
   * Lets go of what this browser still keeps of the files of the assets of a project that moved
   * into its folder, as far as the folder has them as the project says, see `FolderMove.release`.
   * It reads the folder, which the browser may ask about: it has to run right after people did
   * something. `asked` is for people who said so already. Resolves to whether anything went.
   */
  async releaseCopies(record: FolderRecord, { asked = false } = {}): Promise<boolean> {
    const { dialogs, notifications, projects, folders, hasher, presence, session, t } =
      this.#options;
    if (!asked) {
      const size = formatSize(await this.copiesOf(record));
      const go = await dialogs.confirm({
        title: t("folder.move.releaseTitle", { name: record.name }),
        message: t("folder.move.releaseMessage", { size }),
        confirm: t("folder.move.release", { size }),
      });
      if (!go) return false;
    }
    let status = await this.projects.statusOf(record);
    if (status === "ask" && (await record.folder.requestAccess()) === "granted") status = "ready";
    if (status !== "ready") {
      notifications.push(t("folder.move.releaseUnreachable", { name: record.name }));
      return false;
    }
    const current = this.#current?.record.id === record.id ? this.#current : undefined;
    const files =
      current?.assets ??
      new FolderAssets({
        folder: () => record.folder,
        key: record.id,
        bases: folders.bases,
        browser: projects.media(record.id),
        ...(hasher && { hasher }),
        ...(this.#options.here && { here: this.#options.here }),
      });
    let loaded: LoadedProject | undefined;
    try {
      if (!current) loaded = await loadProject(projects, record.id);
      const store = current?.store ?? loaded?.store;
      // Without the project nothing says which files it needs, and so none of them go.
      if (!store) throw new Error(`Nothing of project ${record.id} to compare its files with`);
      // Undo can bring back an asset where the project is open: here, or in another window.
      const open =
        session.key === record.id || ((await presence?.others(record.id).catch(() => 0)) ?? 0) > 0;
      const { released, missing, unused } = await this.#mover.release(
        record.id,
        store.getState().assets ?? {},
        files,
        { open },
      );
      const said = [t("folder.move.released", { size: formatSize(released) })];
      if (missing.length > 0)
        said.push(t("folder.move.releasedMissing", { count: missing.length }));
      if (unused.length > 0) said.push(t("folder.move.releasedUnused", { count: unused.length }));
      notifications.push(said.join(""));
      return released > 0;
    } catch (error) {
      console.warn("The copies in the browser could not be let go of", error);
      notifications.push(t("folder.move.releaseFailed"));
      return false;
    } finally {
      loaded?.close();
      if (files !== current?.assets) files.stop();
    }
  }

  /** Keeps the dialog of a move up with what is happening, and how long it may take. */
  #followMove(progress: ProgressDialog): (step: MoveStep) => void {
    const { t } = this.#options;
    let last = Number.NEGATIVE_INFINITY;
    let phase: MoveStep["phase"] | undefined;
    let since = 0;
    return (step) => {
      const now = performance.now();
      if (step.phase !== phase) {
        phase = step.phase;
        since = now;
        last = Number.NEGATIVE_INFINITY;
      }
      if (now - last < STEP_INTERVAL_MS) return;
      last = now;
      const ratio = doneOf(step);
      const elapsed = (now - since) / 1000;
      // At first by what there is to do, then by how it went so far.
      const seconds =
        elapsed < MEASURE_AFTER_S || ratio <= 0
          ? ((step.totalFiles - step.files) * FILE_COST_BYTES + step.totalBytes - step.bytes) /
            GUESSED_BYTES_PER_S
          : (elapsed * (1 - ratio)) / ratio;
      const left = Math.ceil(seconds);
      const counted = t(`folder.move.${step.phase}`, { done: step.files, total: step.totalFiles });
      progress.update({
        detail: step.file,
        ratio,
        amount: left > 1 ? `${counted}${t("folder.move.left", { seconds: left })}` : counted,
      });
    };
  }

  /** Says that the project is the folder now, and what the browser still keeps of its files. */
  async #moved(
    name: string,
    {
      record,
      missing,
      elsewhere,
      damaged,
      renamed,
      copies,
    }: Extract<MoveResult, { kind: "moved" }>,
  ) {
    const { dialogs, t } = this.#options;
    const title = t("folder.move.movedTitle");
    const message = t("folder.move.moved", { name, folder: record.folder.name });
    const details = [
      listOf(t, t("folder.move.missing"), missing),
      listOf(t, t("folder.move.elsewhere"), downloadableItems(t, elsewhere)),
      listOf(t, t("folder.move.damaged"), damaged),
      listOf(
        t,
        t("folder.move.renamed"),
        renamed.map(({ from, to }) => t("folder.move.renamedItem", { from, to })),
      ),
    ].filter(({ items }) => items.length > 0);
    if (copies === 0) {
      await this.#notice(title, message, details);
      return;
    }
    const size = formatSize(copies);
    const release = await dialogs.confirm({
      title,
      message: `${message}${t("folder.move.copies", { size })}`,
      confirm: t("folder.move.release", { size }),
      cancel: t("folder.move.keep"),
      ...(details.length > 0 && { details }),
    });
    if (release) await this.releaseCopies(record, { asked: true });
  }

  /** Says why a project did not move, and that it stays as it was in the browser. */
  async #notMoved(
    name: string,
    result: Exclude<MoveResult, { kind: "moved" }>,
    what: "move" | "saveAs" = "move",
  ): Promise<void> {
    const { dialogs, notifications, t } = this.#options;
    const title = t(what === "move" ? "folder.move.failedTitle" : "folder.saveAs.failedTitle", {
      name,
    });
    const left = (cleaned: boolean, folder: string) =>
      cleaned
        ? t("folder.move.nothingLeft")
        : t("folder.move.leftBehind", { folder, file: INCOMPLETE_FILE });
    switch (result.kind) {
      case "refused":
        await this.#refusedMove(name, result.refusal);
        return;
      case "stopped": {
        const cancelled = t(what === "move" ? "folder.move.cancelled" : "folder.saveAs.cancelled", {
          name,
        });
        if (result.cancelled && result.cleaned) {
          notifications.push(cancelled);
          return;
        }
        const reason = result.cancelled
          ? cancelled
          : t(what === "move" ? "folder.move.writeFailed" : "folder.saveAs.writeFailed", {
              file: result.file,
              reason: this.#reasonOf(result.error),
            });
        await this.#notice(title, `${reason}${left(result.cleaned, result.folder)}`);
        return;
      }
      case "unverified": {
        // The folder stays for people to look at, unless they want what was written gone.
        const discard = await dialogs.confirm({
          title,
          message: t(what === "move" ? "folder.move.unverified" : "folder.saveAs.unverified", {
            folder: result.folder,
            file: INCOMPLETE_FILE,
          }),
          confirm: t("folder.move.discard"),
          cancel: t("folder.move.keepFolder"),
          danger: true,
          details: [
            listOf(
              t,
              t("folder.move.mismatchList"),
              result.mismatches.flatMap((mismatch) => this.#describe(mismatch)),
            ),
          ],
        });
        if (!discard) return;
        const cleaned = await result.takeBack().catch(() => false);
        notifications.push(
          cleaned
            ? t("folder.move.discarded", { folder: result.folder })
            : t("folder.move.discardedPartly", { folder: result.folder, file: INCOMPLETE_FILE }),
        );
        return;
      }
      case "unswitched":
        console.warn("A project in a folder could not be kept by it", result.error);
        await this.#notice(
          title,
          `${t(what === "move" ? "folder.move.unswitched" : "folder.saveAs.unswitched", { folder: result.folder })}${left(result.cleaned, result.folder)}`,
        );
        return;
    }
  }

  /** Why a project cannot move: what people have to put right first, or why it does not matter. */
  async #refusedMove(name: string, refusal: MoveRefusal): Promise<void> {
    const { notifications, t } = this.#options;
    if (refusal.kind === "already" || refusal.kind === "busy") {
      notifications.push(t(`folder.move.${refusal.kind}`, { name }));
      return;
    }
    const items =
      refusal.kind === "invalid"
        ? refusal.problems.map((problem) => problemText(t, problem))
        : refusal.kind === "too-new"
          ? []
          : refusal.paths;
    await this.#notice(
      t("folder.move.refusedTitle", { name }),
      t(`folder.move.refused.${refusal.kind}`),
      items.length > 0 ? [listOf(t, t("folder.move.listTitle"), items)] : undefined,
    );
  }

  /** What is not right with the folder, in a line or a few. */
  #describe(mismatch: Mismatch): string[] {
    const { t } = this.#options;
    switch (mismatch.kind) {
      case "unreadable":
        return [
          t("folder.move.mismatch.unreadable", { reason: mismatch.reason }),
          ...mismatch.problems.map((problem) => problemText(t, problem)),
        ];
      case "lost":
        return [
          t("folder.move.mismatch.lost", {
            file: mismatch.file,
            message: mismatch.problems
              .map(({ message }) => message)
              .join(t("folder.listSeparator")),
          }),
        ];
      default:
        return [t(`folder.move.mismatch.${mismatch.kind}`, { file: mismatch.file })];
    }
  }

  async #askName(): Promise<string | undefined> {
    const { dialogs, t } = this.#options;
    return dialogs.prompt({
      title: t("project.nameLabel"),
      value: t("project.defaultName"),
      hint: t("folder.chooseHint"),
      confirm: t("folder.chooseFolder"),
    });
  }

  async #choose(): Promise<LocalFolder | undefined> {
    try {
      return await this.#options.folders.choose();
    } catch (error) {
      this.#failed(error);
      return undefined;
    }
  }

  #failed(error: unknown): void {
    console.warn("A project folder could not be opened", error);
    this.#options.notifications.push(this.#options.t("folder.failed"));
  }

  /**
   * Where a project goes in a folder people chose, as people say, see the design, 3.2: undefined when
   * it does not go there. `open` is for a folder that is a project already, which people may want.
   */
  async #placeFor(
    folder: LocalFolder,
    name: string,
    open?: (folder: LocalFolder) => Promise<void>,
    { onlyInside = false }: { readonly onlyInside?: boolean } = {},
  ): Promise<{ readonly inside: string | undefined } | undefined> {
    const { dialogs, t } = this.#options;
    let place: Awaited<ReturnType<FolderProjects["placeFor"]>>;
    try {
      place = await this.projects.placeFor(folder, name);
    } catch (error) {
      this.#failed(error);
      return undefined;
    }
    switch (place.kind) {
      case "empty":
        return { inside: undefined };
      case "project":
      case "known": {
        const go = await dialogs.confirm({
          title: t("folder.isProjectTitle", { folder: folder.name }),
          message: open ? t("folder.isProjectMessage") : t("folder.isProjectElsewhere"),
          confirm: open ? t("folder.openIt") : t("dialog.close"),
          ...(!open && { noticeOnly: true }),
        });
        if (go && open) {
          if (place.kind === "known") await this.openRecent(place.record);
          else await open(folder);
        }
        return undefined;
      }
      case "inside":
        await this.#notice(
          t("folder.insideTitle", { folder: folder.name }),
          t("folder.insideMessage", { name: place.record.name }),
        );
        return undefined;
      case "incomplete":
        await this.#notice(t("folder.incompleteTitle"), t("folder.incompleteForNew"));
        return undefined;
      case "other": {
        // Files where a project has its own would be taken for its own: then only a folder of its own.
        const choices =
          place.clashes.length > 0 || onlyInside
            ? [
                {
                  id: "inside",
                  label: t("folder.putInside", { inside: place.inside }),
                  kind: "primary" as const,
                },
              ]
            : [
                { id: "here", label: t("folder.putHere") },
                {
                  id: "inside",
                  label: t("folder.putInside", { inside: place.inside }),
                  kind: "primary" as const,
                },
              ];
        const answer = await dialogs.choose({
          title: t("folder.notEmptyTitle", { folder: folder.name }),
          message: onlyInside
            ? t("folder.saveAs.notEmpty", { inside: place.inside })
            : place.clashes.length > 0
              ? t("folder.notEmptyClashes", {
                  inside: place.inside,
                  files: place.clashes.slice(0, 5).join("、"),
                  count: place.clashes.length,
                })
              : t("folder.notEmptyMessage", { inside: place.inside }),
          choices,
        });
        // Only what was offered: a folder with files where a project has its own gets no "here".
        if (answer === "inside") return { inside: place.inside };
        if (answer === "here" && place.clashes.length === 0 && !onlyInside)
          return { inside: undefined };
        return undefined;
      }
    }
  }

  async #createIn(folder: LocalFolder, name: string, format?: NewFormat): Promise<void> {
    const { notifications, t } = this.#options;
    const place = await this.#placeFor(folder, name, (project) => this.#openChosen(project));
    if (!place) return;
    let record: FolderRecord;
    try {
      record = await this.projects.create(name, folder, place.inside, format);
    } catch (error) {
      console.warn("A project could not be made in a folder", error);
      notifications.push(t("folder.createFailed"));
      return;
    }
    await this.#options.changeProject(() => this.#open(record));
  }

  /** What people chose or dropped, once the editor may read and write it, or may not. */
  async #openChosen(folder: LocalFolder, given: AccessAnswer = "granted"): Promise<void> {
    const { dialogs, t } = this.#options;
    let answer = given;
    if (answer === "needs-activation") {
      // The browser only asks right after people did something: this button is that.
      const go = await dialogs.confirm({
        title: t("folder.openTitle", { name: folder.name }),
        message: t("folder.openMessage"),
        confirm: t("folder.openButton", { name: folder.name }),
      });
      if (!go) return;
      answer = await folder.requestAccess();
    }
    // People said no: nothing changes, and they can try again.
    if (answer !== "granted") return;
    const look = await this.#reading(folder.name, (options) => this.projects.look(folder, options));
    if (!look) return;
    if (look.kind === "known") {
      if (look.record.id !== this.#current?.record.id) await this.openRecent(look.record);
      return;
    }
    if (look.kind === "empty") {
      const create = await dialogs.confirm({
        title: t("folder.emptyTitle", { folder: folder.name }),
        message: t("folder.emptyMessage"),
        confirm: t("folder.createHere"),
      });
      if (!create) return;
      const name = await dialogs.prompt({
        title: t("project.nameLabel"),
        value: t("project.defaultName"),
        confirm: t("project.create"),
      });
      if (name) await this.#createIn(folder, name);
      return;
    }
    if (look.kind === "refused") {
      await this.#refused(folder, look.error);
      return;
    }
    await this.#adoptAndOpen(look);
  }

  async #adoptAndOpen(look: Extract<FolderLook, { kind: "project" }>): Promise<void> {
    const { dialogs, t } = this.#options;
    if (look.replacing) {
      // This folder was the folder of another project: that one goes, as one folder has one record.
      const only = await this.projects.hasUnwritten(look.replacing);
      const go = await dialogs.confirm({
        title: t("folder.replacedTitle", { folder: look.folder.name }),
        message: t(only ? "folder.replacedOnlyCopy" : "folder.replacedMessage", {
          old: look.replacing.name,
          name: look.name,
        }),
        confirm: t("folder.openOther", { name: look.name }),
        ...(only && { danger: true }),
      });
      if (!go) return;
    }
    let moved: FolderRecord | undefined;
    for (const candidate of look.moved) {
      // A folder that moved is a new one to the browser: only its project says it may be that one.
      const said = await dialogs.choose({
        title: t("folder.movedTitle", { name: candidate.name }),
        message: t("folder.movedMessage"),
        choices: [
          { id: "new", label: t("folder.movedNo") },
          { id: "moved", label: t("folder.movedYes"), kind: "primary" },
        ],
      });
      if (said === undefined) return;
      if (said === "moved") {
        moved = candidate;
        break;
      }
    }
    let adopted: Awaited<ReturnType<FolderProjects["adopt"]>>;
    try {
      adopted = await this.projects.adopt(look, moved);
    } catch (error) {
      this.#failed(error);
      return;
    }
    const { record, report } = adopted;
    if (report) await this.#options.warnAboutCode(report);
    this.#setWaiting(undefined);
    await this.#options.changeProject(async () => {
      if ((await this.#open(record)) && report) this.#options.noteArrival(report);
    });
  }

  async #refused(folder: LocalFolder, error: ImportRefused): Promise<void> {
    const { t } = this.#options;
    const { reason, problems } = error;
    const details =
      problems.length > 0
        ? [
            {
              title: t("transfer.refusedList"),
              items: problems.map(({ file, path, message }) =>
                t("transfer.problem", { place: path ? `${file} ${path}` : file, message }),
              ),
            },
          ]
        : undefined;
    await this.#notice(
      t("folder.refusedTitle", { folder: folder.name }),
      t(`folder.refused.${reason}`),
      details,
    );
  }

  /** Reading a folder can take a while, as for a large project: people see it go, and can stop it. */
  async #reading<T>(
    folder: string,
    read: (options: ReadingOptions) => Promise<T>,
  ): Promise<T | undefined> {
    const { dialogs, t } = this.#options;
    const progress = dialogs.progress({
      title: t("folder.reading", { folder }),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    try {
      return await read({
        signal: progress.signal,
        onStep: ({ file }) => progress.update({ detail: file }),
      });
    } catch (error) {
      if (!progress.signal.aborted) this.#failed(error);
      return undefined;
    } finally {
      progress.close();
    }
  }

  async #whenGone(record: FolderRecord): Promise<void> {
    const { dialogs, t } = this.#options;
    const answer = await dialogs.choose({
      title: t("folder.goneTitle", { name: record.name }),
      message: t("folder.goneMessage"),
      choices: [
        { id: "elsewhere", label: t("folder.saveElsewhere") },
        { id: "find", label: t("folder.findAgain"), kind: "primary" },
      ],
    });
    if (answer === "find") await this.findAgain(record);
    if (answer === "elsewhere") await this.saveElsewhere(record, { asked: true });
  }

  /** Opens the project of a folder this browser knows, and keeps the folder in step. */
  async #open(given: FolderRecord, { relocated = false } = {}): Promise<boolean> {
    const { session, t } = this.#options;
    // What a move that stopped right at the end left of the file that says it is not done.
    const record = await this.#mover.settle(given);
    // A newer editor wrote it: this one does not open it, and leaves the files as they are.
    if (await this.projects.isTooNew(record.folder).catch(() => false)) {
      await this.#notice(
        t("folder.refusedTitle", { folder: record.folder.name }),
        t("folder.refused.too-new"),
      );
      return false;
    }
    // A folder this browser knows, whose log it lost, comes from the folder again.
    let report: ImportReport | undefined;
    const prepared = await this.#reading(record.folder.name, async (options) => ({
      report: await this.projects.prepare(record, options),
    }));
    if (!prepared) return false;
    ({ report } = prepared);
    if (report) await this.#options.warnAboutCode(report);
    const files = this.#filesOf(record);
    const isOpen = await session.open(record.id).catch((error: unknown) => {
      files.drop();
      throw error;
    });
    if (!isOpen) {
      files.drop();
      return false;
    }
    const store = session.store as ProjectStore;
    await this.#attach(record, store, files, relocated);
    await this.projects.opened(record, store.getState().manifest.name).catch((error: unknown) => {
      console.warn("When the folder was opened could not be noted down", error);
    });
    if (report) this.#options.noteArrival(report);
    return true;
  }

  /**
   * The files of the assets of a project folder, which whatever wants a file of its project gets
   * from now on, also while the project opens, see `mediaFor`. They are in the folder of its
   * session once it has one, which can be another one after people found it again.
   */
  #filesOf(record: FolderRecord): OpeningFiles {
    let folderSession: FolderSession | undefined;
    const assets: FolderAssets = new FolderAssets({
      folder: () => folderSession?.folder ?? record.folder,
      key: record.id,
      bases: this.#options.folders.bases,
      // What the editor makes of the files stays in the browser.
      browser: this.#options.projects.media(record.id),
      ...(this.#options.hasher && { hasher: this.#options.hasher }),
      ...(this.#options.here && { here: this.#options.here }),
      onChanged: (paths) => {
        const current = this.#current;
        if (current?.assets !== assets) return;
        this.#options.assetFiles.filesChanged(paths);
        this.#checkSoon(current);
      },
      onProgress: (progress) => {
        if (this.#assets?.assets === assets) this.#setProgress(progress);
      },
    });
    this.#assets = { key: record.id, assets };
    return {
      assets,
      follow: (session) => {
        folderSession = session;
      },
      drop: () => {
        if (this.#assets?.assets === assets) this.#assets = undefined;
      },
    };
  }

  /** Keeps the folder of a project that is open in this window in step with it. */
  async #attach(
    record: FolderRecord,
    store: ProjectStore,
    files: OpeningFiles,
    relocated: boolean,
  ): Promise<void> {
    const { session, folders, timing } = this.#options;
    const { assets } = files;
    const folderSession = new FolderSession({
      store,
      folder: record.folder,
      id: record.id,
      bases: folders.bases,
      writer: folders.writer(record.id),
      log: { saved: () => session.trySave(), caughtUp: () => session.readLog() },
      ...(timing && { timing }),
    });
    files.follow(folderSession);
    // A project that cannot be edited leaves its folder as it is from the start, see `hold`.
    if (this.#held) folderSession.hold(true);
    const stops: (() => void)[] = [];
    const current: Current = {
      session: folderSession,
      store,
      assets,
      record,
      relocated,
      stop: () => {
        for (const stop of stops) stop();
        clearTimeout(current.checkTimer);
        current.assetWatch?.stop();
        assets.stop();
      },
    };
    stops.push(
      folderSession.subscribe(() => {
        // The folder can be another one now, after people found it again.
        if (this.#current === current && current.assetWatch) this.#watchAssets(current);
        this.#changed();
      }),
      folderSession.onMerge((merge) => this.#merged(store, merge)),
      // What the project says about its assets changed, as after an import or a merge, or where
      // their files are kept, as after an upload.
      store.subscribe(() => {
        const state = store.getState();
        if (state.assets !== current.checkedAssets || state.places !== current.checkedPlaces) {
          this.#checkSoon(current);
        }
      }),
    );
    this.#current = current;
    this.#changed();
    await folderSession.start();
    if (this.#current === current) {
      this.#watchAssets(current);
      void this.#check(current);
      // What a copy that stopped with the page left behind.
      void assets.removeEmpty(store);
    }
  }

  /**
   * Takes back a batch of files that came in, from elsewhere than its notice, as the notice does:
   * what the folder has now is kept first. False when this window does not know the batch.
   */
  undoBatch(origin: string): boolean {
    const known = this.#batches.get(origin);
    if (!known) return false;
    void this.#undo(known.store, known.merge);
    return true;
  }

  #merged(store: ProjectStore, merge: FolderMerge): void {
    const { notifications, t } = this.#options;
    const { files, conflicts, problems } = merge;
    if (files.length > 0) {
      this.#batches.delete(merge.origin);
      this.#batches.set(merge.origin, { store, merge });
      // The store forgets all but the last few batches, and so does this.
      for (const old of this.#batches.keys()) {
        if (this.#batches.size <= MAX_KNOWN_BATCHES) break;
        this.#batches.delete(old);
      }
    }
    if (files.length === 0 && conflicts.length === 0 && problems.length === 0) return;
    const partly = conflicts.length > 0 || problems.length > 0;
    const message =
      files.length === 0
        ? t("folder.notMerged")
        : partly
          ? t("folder.mergedPartly", { count: files.length })
          : t("folder.merged", { count: files.length });
    notifications.push(message, {
      actions: [
        ...(partly
          ? [{ label: t("folder.showMerged"), run: () => this.#options.showProblems() }]
          : []),
        ...(files.length > 0
          ? [{ label: t("folder.undoMerge"), run: () => void this.#undo(store, merge) }]
          : []),
      ],
    });
    if (!partly) return;
    const kept = t("folder.keptIn", { folder: RECOVERED_FOLDER });
    const listed: Listed[] = [
      ...conflicts.map((conflict) => ({
        severity: "warning" as const,
        text: `${t("folder.conflict")}${kept}`,
        file: conflict.file,
        place: conflict.path.join("."),
        origin: t("folder.origin"),
        action: {
          label: t("folder.showTheirs"),
          run: () =>
            void this.#notice(
              t("folder.theirsTitle", { file: conflict.file }),
              shown(conflict.theirs, t),
            ),
        },
      })),
      ...problems.map((problem) => ({
        severity: problem.severity === "error" ? ("error" as const) : ("warning" as const),
        text: `${problem.message}${kept}`,
        file: problem.file,
        ...(problem.path !== undefined && { place: problem.path }),
        origin: t("folder.origin"),
      })),
    ];
    this.#notes = [...this.#notes, ...listed].slice(-MAX_LISTED);
    this.#changed();
  }

  /**
   * Takes back what came in, as a whole. The folder gets the editor's side then, so what it has now
   * is kept first, and it can come back.
   */
  async #undo(store: ProjectStore, merge: FolderMerge): Promise<void> {
    const { notifications, t } = this.#options;
    const current = this.#current;
    if (current?.store !== store) return;
    // What the folder has now goes, so it is kept first, or nothing is taken back.
    let kept: readonly string[] | undefined;
    try {
      kept = await current.session.keep(merge.files);
    } catch (error) {
      console.warn("What the folder had could not be kept before taking it back", error);
      notifications.push(t("folder.undoNotKept", { reason: this.#reasonOf(error) }));
      return;
    }
    if (kept === undefined) {
      notifications.push(t("folder.undoElsewhere"));
      return;
    }
    const result = store.undoOrigin(merge.origin);
    if (!result.ok) {
      notifications.push(t("folder.undoFailed", { message: result.error.message }));
      return;
    }
    // Where it went, as it was written: the folder of this time in RECOVERED_FOLDER.
    const [first] = kept;
    const place = first?.split("/").slice(0, 3).join("/");
    notifications.push(
      place === undefined ? t("folder.undoneNothingKept") : t("folder.undone", { folder: place }),
      {
        actions: [
          {
            label: t("folder.redoMerge"),
            run: () => {
              const again = store.redoOrigin(merge.origin);
              if (!again.ok)
                notifications.push(t("folder.undoFailed", { message: again.error.message }));
            },
          },
        ],
      },
    );
  }

  /** Why something could not be written into the folder, for people. */
  #reasonOf(error: unknown): string {
    const { t } = this.#options;
    const known = ["full", "denied", "busy", "too-long", "gone"] as const;
    const reason =
      error instanceof FolderError ? known.find((each) => each === error.reason) : undefined;
    return t(`folder.notKept.${reason ?? "other"}`);
  }

  async #notice(
    title: string,
    message: string,
    details?: ConfirmOptions["details"],
  ): Promise<void> {
    await this.#options.dialogs.confirm({
      title,
      message,
      confirm: this.#options.t("dialog.close"),
      noticeOnly: true,
      ...(details && { details }),
    });
  }

  #setWaiting(waiting: WaitingFolder | undefined): void {
    this.#waiting = waiting;
    this.#changed();
  }

  #changed(): void {
    const current = this.#current;
    const snapshot = current?.session.getSnapshot();
    this.#options.problems.setFolder([
      ...this.#blockedProblems(current, snapshot),
      ...this.#notes,
      ...this.#assetNotes,
    ]);
    this.#snapshot = {
      open: current && snapshot ? { record: current.record, snapshot } : undefined,
      waiting: this.#waiting,
      moves: this.#moves,
    };
    this.#emitter.emit();
  }

  #blockedProblems(current: Current | undefined, snapshot: FolderSnapshot | undefined): Listed[] {
    const { t } = this.#options;
    if (!current || !snapshot || snapshot.blocked.length === 0) return [];
    const { files } = current.store.exportFiles();
    return snapshot.blocked.map(({ path, problems }) => ({
      severity: "error" as const,
      text:
        problems.length > 0
          ? problems.map(({ message }) => message).join(t("folder.listSeparator"))
          : t("folder.waits"),
      file: path,
      origin: t("folder.origin"),
      action: {
        // Where the editor has no such file, its content is that there is none.
        label: files.has(path) ? t("folder.useEditorContent") : t("folder.removeLikeEditor"),
        run: () => void this.writeEditorContent([path]),
      },
    }));
  }
}
