/**
 * Projects that are folders on this computer, as people work with them: making one, opening one that
 * they chose, dropped or opened before, letting the editor at it again, finding it when it moved,
 * writing it somewhere else when it is gone, and keeping it in step while it is open, see
 * `FolderSession`. What is in a folder and what this browser keeps of it is `FolderProjects`; this
 * is the part that asks people and tells them.
 */
import { isNoneOfIt, type ProjectStore } from "@animaquill/core";
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
} from "@animaquill/host";
import type { TFunction } from "i18next";
import {
  FolderAssets,
  NO_PROGRESS,
  type AssetIssue,
  type AssetProgress,
} from "../folder/assets.ts";
import { isProjectFile } from "../folder/project-files.ts";
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
import type { Hasher } from "../media/hasher.ts";
import type { ProblemList } from "../problems/list.ts";
import type { ImportRefused, ImportReport } from "../transfer/import.ts";
import type { ConfirmOptions, Dialogs } from "./dialogs.ts";
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
  readonly timing?: Partial<FolderTiming>;
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
  /** The assets of the project, as the files were last compared with. */
  checkedAssets?: unknown;
  checkTimer?: ReturnType<typeof setTimeout>;
  checking?: Promise<void> | undefined;
  checkAgain?: boolean;
  /** Written to a new place from what the browser had, without the files of its assets. */
  readonly relocated: boolean;
}

type Listed = Parameters<ProblemList["setFolder"]>[0][number];

/** More than anybody reads: what of the folder did not come in, since the project opened. */
const MAX_LISTED = 200;
/** What of a value the folder had is shown, at most. */
const MAX_SHOWN = 4000;

const NOTHING: ProjectFoldersSnapshot = { open: undefined, waiting: undefined };

/** A value the way people can read it. */
function shown(value: unknown, t: TFunction): string {
  if (value === undefined) return t("folder.theirsRemoved");
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

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
  /** Files of assets that are not right, as problems. */
  #assetNotes: readonly Listed[] = [];
  /**
   * The files of the project folder that is open, or opening: from the moment its project opens,
   * whatever wants a file of it gets it from the folder, see `mediaFor`.
   */
  #assets: { readonly key: string; readonly assets: FolderAssets } | undefined;
  readonly #progressEmitter = new Emitter();
  #progress: AssetProgress = NO_PROGRESS;

  constructor(options: ProjectFoldersOptions) {
    this.#options = options;
    this.projects = new FolderProjects({
      folders: options.folders,
      projects: options.projects,
      t: options.t,
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
  mediaFor(key: string, since?: number): MediaStore | undefined {
    const opened = this.#assets;
    if (opened?.key !== key) return undefined;
    return opened.assets.media(
      () => this.#options.session.store?.getState().assets,
      since === undefined ? {} : { since },
    );
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
    current.checkedAssets = current.store.getState().assets;
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
          current.relocated && issues.some(({ kind }) => kind === "missing")
            ? [
                {
                  severity: "warning" as const,
                  text: t("folder.assetsLeftBehind"),
                  origin: t("folder.origin"),
                },
              ]
            : [];
        this.#assetNotes = [
          ...leftBehind,
          ...issues.map((issue) => this.#assetProblem(current, issue)),
        ];
        this.#changed();
      })
      .finally(() => {
        current.checking = undefined;
        if (current.checkAgain && this.#current === current) void this.#check(current);
      });
    return current.checking;
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
    if (issue.hidden !== undefined) {
      return { ...base, text: t("folder.asset.hidden", { name: issue.hidden }) };
    }
    const { found } = issue;
    if (found === undefined) return { ...base, text: t("folder.asset.missing") };
    return {
      ...base,
      text: t("folder.asset.moved", { found }),
      action: {
        label: t("folder.asset.usePlace"),
        run: () => after(assetFiles.usePlace(issue.asset, found)),
      },
    };
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

  /** Writes what is waiting, right away: for Ctrl+S, and for a page that goes to the background. */
  async flush(): Promise<void> {
    await this.#current?.session.flush();
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
    const folder = await this.#choose();
    if (folder) await this.#createIn(folder, name);
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
          place.clashes.length > 0
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
          message:
            place.clashes.length > 0
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
        if (answer === "here" && place.clashes.length === 0) return { inside: undefined };
        return undefined;
      }
    }
  }

  async #createIn(folder: LocalFolder, name: string): Promise<void> {
    const { notifications, t } = this.#options;
    const place = await this.#placeFor(folder, name, (project) => this.#openChosen(project));
    if (!place) return;
    let record: FolderRecord;
    try {
      record = await this.projects.create(name, folder, place.inside);
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
  async #open(record: FolderRecord, { relocated = false } = {}): Promise<boolean> {
    const { session, folders, timing, t } = this.#options;
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
    let folderSession: FolderSession | undefined;
    const assets: FolderAssets = new FolderAssets({
      folder: () => folderSession?.folder ?? record.folder,
      key: record.id,
      bases: folders.bases,
      // What the editor makes of the files stays in the browser.
      browser: this.#options.projects.media(record.id),
      ...(this.#options.hasher && { hasher: this.#options.hasher }),
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
    const isOpen = await session.open(record.id).catch((error: unknown) => {
      if (this.#assets?.assets === assets) this.#assets = undefined;
      throw error;
    });
    if (!isOpen) {
      if (this.#assets?.assets === assets) this.#assets = undefined;
      return false;
    }
    const store = session.store as ProjectStore;
    folderSession = new FolderSession({
      store,
      folder: record.folder,
      id: record.id,
      bases: folders.bases,
      writer: folders.writer(record.id),
      log: { saved: () => session.trySave(), caughtUp: () => session.readLog() },
      ...(timing && { timing }),
    });
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
      // What the project says about its assets changed, as after an import or a merge.
      store.subscribe(() => {
        if (store.getState().assets !== current.checkedAssets) this.#checkSoon(current);
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
    await this.projects.opened(record, store.getState().manifest.name).catch((error: unknown) => {
      console.warn("When the folder was opened could not be noted down", error);
    });
    if (report) this.#options.noteArrival(report);
    return true;
  }

  #merged(store: ProjectStore, merge: FolderMerge): void {
    const { notifications, t } = this.#options;
    const { files, conflicts, problems } = merge;
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
