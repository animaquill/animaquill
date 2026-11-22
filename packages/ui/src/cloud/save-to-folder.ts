import { INCOMPLETE_FILE, isProjectFile } from "@animaquill/core";
import {
  FolderError,
  folderNameFor,
  type LocalFolder,
  type LocalFolders,
  type SavedFolders,
  type TargetFolder,
} from "@animaquill/host";
import { MANIFEST_FILE } from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { CopySource } from "../folder/copies.ts";
import { includes } from "../folder/project-files.ts";
import { exportProject, type ExportReport } from "../transfer/export.ts";
import type { Dialogs } from "../workbench/dialogs.ts";
import type { Notifications } from "../workbench/notifications.ts";

/**
 * "保存到文件夹…" of the online mode (docs/design/online-offline.md of AnimaQuill Cloud, 1.2): a copy
 * of a project in a folder on this computer, once. Nothing links the two afterwards: the copy is a
 * project of the offline mode like any folder, which opens there. The folder of the last save is
 * kept, by the project, and offered first the next time: saving again replaces the files of the
 * project that are there, and only those, see `isProjectFile`; whatever else is in the folder
 * stays as it is.
 */

export interface SaveToFolderOptions {
  readonly folders: Pick<LocalFolders, "choose">;
  /** The folder each project was saved to last. Without it every save asks where. */
  readonly saved?: SavedFolders;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
  /** Opens a folder in the offline mode, see `Host.openOffline`. */
  readonly openOffline?: (folder: LocalFolder) => Promise<void>;
}

/** Where a save goes, and whether something of the project is there already to replace. */
interface Place {
  readonly folder: LocalFolder;
  readonly replaces: boolean;
}

const plain = { interpolation: { escapeValue: false } } as const;

/** Which project a folder holds, by the id in its animaquill.json; undefined for none. */
async function projectIn(folder: LocalFolder): Promise<string | null | undefined> {
  let text: string;
  try {
    text = await folder.readText(MANIFEST_FILE);
  } catch (error) {
    if (error instanceof FolderError && error.reason === "missing") return undefined;
    throw error;
  }
  try {
    const id = (JSON.parse(text.replace(/^﻿/, "")) as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Whether a folder has anything in it. */
async function hasAnything(folder: LocalFolder): Promise<boolean> {
  for await (const _ of folder.list()) return true;
  return false;
}

/** A name in `folder` that nothing has yet, from `wanted`: "宣传片", "宣传片 2", and so on. */
async function freeName(folder: LocalFolder, wanted: string): Promise<string> {
  for (let count = 1; ; count += 1) {
    const name = count === 1 ? wanted : `${wanted} ${count}`;
    try {
      await folder.inside(name);
    } catch (error) {
      if (error instanceof FolderError && error.reason === "missing") return name;
      throw error;
    }
  }
}

/**
 * What an export writes, into a folder people chose: the paths it wrote, so that what is left of
 * the project from a save before can go after.
 */
function folderTarget(folder: LocalFolder, written: Set<string>): TargetFolder {
  return {
    name: folder.name,
    kind: "folder",
    async write(path, content, options) {
      await folder.write(path, content, options?.signal ? { signal: options.signal } : {});
      written.add(path);
      return true;
    },
    remove: (path) => folder.remove(path),
    finish: async () => {},
    // What was written stays, with the file that says that it is not finished: a folder that had
    // the project from a save before is not taken away for this one.
    abandon: async () => {},
  };
}

export class SaveToFolder {
  readonly #options: SaveToFolderOptions;
  #busy = false;

  constructor(options: SaveToFolderOptions) {
    this.#options = options;
  }

  /** Whether a save is on its way, which leaving the page would stop halfway. */
  get busy(): boolean {
    return this.#busy;
  }

  /**
   * Saves a copy of the project `project` (its id on the backend), as `source` brings it once
   * people chose where. Has to run right in the click: the browser asks for a folder only then.
   * Resolves to the folder it went to, or undefined where it did not.
   */
  async save(
    project: string,
    name: string,
    source: (signal: AbortSignal) => Promise<CopySource | undefined>,
  ): Promise<LocalFolder | undefined> {
    if (this.#busy) return undefined;
    this.#busy = true;
    try {
      const place = await this.#placeFor(project, name);
      if (!place) return undefined;
      return await this.#write(project, name, place, source);
    } finally {
      this.#busy = false;
    }
  }

  /** Where it goes: the folder of the last save where people want that, or one they choose. */
  async #placeFor(project: string, name: string): Promise<Place | undefined> {
    const { saved, dialogs, t } = this.#options;
    const before = await saved?.get(project).catch(() => undefined);
    const status = await before?.status().catch(() => "gone" as const);
    if (before && status !== "gone" && status !== "blocked") {
      const answer = await dialogs.choose({
        title: t("saveToFolder.again.title", { name, ...plain }),
        message: t("saveToFolder.again.message", { folder: before.name, ...plain }),
        choices: [
          { id: "elsewhere", label: t("saveToFolder.again.elsewhere") },
          { id: "replace", label: t("saveToFolder.again.replace"), kind: "primary" },
        ],
      });
      if (answer === "replace") {
        // The press on the button is what lets the browser ask, where it has to.
        if ((await before.requestAccess()) !== "granted") {
          this.#options.notifications.push(
            t("saveToFolder.denied", { folder: before.name, ...plain }),
          );
          return undefined;
        }
        // People may have used the folder for something else since: what is there decides.
        return this.#placeIn(before, project, name, { asked: true });
      }
      if (answer !== "elsewhere") return undefined;
    }
    let chosen: LocalFolder | undefined;
    try {
      chosen = await this.#options.folders.choose();
    } catch (error) {
      console.warn("No folder to save to", error);
      this.#options.notifications.push(t("saveToFolder.failed", { name, ...plain }));
      return undefined;
    }
    if (!chosen) return undefined;
    return this.#placeIn(chosen, project, name);
  }

  /**
   * A folder people chose: the copy goes into it where it is empty, or has this project from a save
   * before, which people say yes to replacing; into a new folder in it where it has other things,
   * so that none of those is taken for a file of the project; and not where it holds another one.
   */
  async #placeIn(
    chosen: LocalFolder,
    project: string,
    name: string,
    { asked = false }: { readonly asked?: boolean } = {},
  ): Promise<Place | undefined> {
    const { dialogs, t } = this.#options;
    try {
      // A project, or what a save that stopped halfway left: which project it is, `#write` makes
      // sure of once the copy is there to say its id. Only that one is replaced.
      const there = await projectIn(chosen);
      if (there !== undefined || (await this.#unfinishedOf(chosen))) {
        // People said yes to replacing it already, where it is the folder of the last save.
        if (asked) return { folder: chosen, replaces: true };
        const go = await dialogs.confirm({
          title: t("saveToFolder.again.title", { name, ...plain }),
          message: t("saveToFolder.hasProject", { folder: chosen.name, ...plain }),
          confirm: t("saveToFolder.again.replace"),
        });
        return go ? { folder: chosen, replaces: true } : undefined;
      }
      if (!(await hasAnything(chosen))) return { folder: chosen, replaces: false };
      const inside = await freeName(chosen, folderNameFor(name));
      return { folder: await chosen.inside(inside, { create: true }), replaces: false };
    } catch (error) {
      console.warn("The folder to save to could not be read", error);
      this.#options.notifications.push(t("saveToFolder.failed", { name, ...plain }));
      return undefined;
    }
  }

  /** Whether a folder has only what a save of this editor that stopped halfway left. */
  async #unfinishedOf(folder: LocalFolder): Promise<boolean> {
    try {
      await folder.file(INCOMPLETE_FILE);
      return true;
    } catch {
      return false;
    }
  }

  async #write(
    project: string,
    name: string,
    { folder, replaces }: Place,
    source: (signal: AbortSignal) => Promise<CopySource | undefined>,
  ): Promise<LocalFolder | undefined> {
    const { dialogs, notifications, saved, t } = this.#options;
    const progress = dialogs.progress({
      title: t("saveToFolder.progress", { name, ...plain }),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    const written = new Set<string>();
    let report: ExportReport | undefined;
    let got: CopySource | undefined;
    try {
      got = await source(progress.signal);
      if (!got || progress.signal.aborted) return undefined;
      // What is to be replaced has to be this project: nothing of another one, or of anything
      // else people put there since, is written over or taken away.
      if (replaces) {
        const there = await projectIn(folder);
        if (there !== undefined && there !== got.store.getState().manifest.id) {
          progress.close();
          await dialogs.confirm({
            title: t("saveToFolder.otherProject.title", { folder: folder.name, ...plain }),
            message: t("saveToFolder.otherProject.message"),
            confirm: t("dialog.close"),
            noticeOnly: true,
          });
          return undefined;
        }
      }
      report = await exportProject(got.store, got.media, folderTarget(folder, written), {
        notice: t("transfer.incompleteNotice"),
        signal: progress.signal,
        onStep: ({ file }) => progress.update({ detail: file }),
      });
      // What a save before wrote that the project does not have any more: only files of the
      // format, never anything else of the folder.
      if (replaces) {
        const stale: string[] = [];
        for await (const path of folder.list({ includes })) {
          if (isProjectFile(path) && !written.has(path)) stale.push(path);
        }
        for (const path of stale) await folder.remove(path);
      }
    } catch (error) {
      if (!progress.signal.aborted) console.warn("A copy of a project could not be saved", error);
      notifications.push(
        t(progress.signal.aborted ? "saveToFolder.cancelled" : "saveToFolder.stopped", {
          folder: folder.name,
          file: INCOMPLETE_FILE,
          ...plain,
        }),
      );
      return undefined;
    } finally {
      progress.close();
      got?.close();
    }
    await saved?.put(project, folder).catch((error: unknown) => {
      console.warn("Where the project was saved to is not kept", error);
    });
    const lacking = [...report.missing, ...report.elsewhere.map(({ name: file }) => file)];
    const { openOffline } = this.#options;
    const answer = await dialogs.choose({
      title: t("saveToFolder.done.title", { folder: folder.name, ...plain }),
      message: [
        t("saveToFolder.done.message"),
        ...(lacking.length > 0
          ? [
              t("saveToFolder.done.missing", {
                count: lacking.length,
                files: lacking.slice(0, 5).join("、"),
                ...plain,
              }),
            ]
          : []),
      ].join(""),
      choices: [
        ...(openOffline ? [{ id: "offline", label: t("saveToFolder.done.openOffline") }] : []),
        { id: "ok", label: t("saveToFolder.done.ok"), kind: "primary" as const },
      ],
    });
    if (answer === "offline") await openOffline?.(folder);
    return folder;
  }
}
