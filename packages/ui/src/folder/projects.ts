/**
 * Projects that are folders on this computer, as far as this browser knows them: which folders were
 * opened here, what a folder people chose or dropped holds, and making a project of one. It does not
 * touch the page and asks nobody anything: that is for the workbench, see `Workbench`.
 *
 * A folder is known by a number of this browser, see `FolderRecord.id`, and so is everything this
 * browser keeps of its project: the log, the bases, what is being tried. Copies of a folder have the
 * same project id, and must not share any of that.
 */
import { INCOMPLETE_FILE, ProjectStore } from "@animaquill/core";
import {
  newNameFor,
  type FolderRecord,
  type FolderStatus,
  type LocalFolder,
  type LocalFolders,
  type ProjectLibrary,
  type SourceFolder,
} from "@animaquill/host";
import { MANIFEST_FILE, createProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import {
  ImportRefused,
  bringIn,
  readProjectFolder,
  type ImportReport,
  type ProjectFolder,
} from "../transfer/import.ts";
import { projectIdOf } from "./project-files.ts";

/** A folder opened in this browser before, and how it is now. */
export interface RecentFolder {
  readonly record: FolderRecord;
  readonly status: FolderStatus;
}

/** What a folder that people chose or dropped holds, for opening it. */
export type FolderLook =
  /**
   * A project, maybe one right inside what people chose. `record` is how this browser knows this
   * very folder; `moved` are folders with the same project that are not where they were, one of
   * which this may be, moved.
   */
  | {
      readonly kind: "project";
      readonly folder: LocalFolder;
      readonly project: string;
      readonly name: string;
      readonly record: FolderRecord | undefined;
      readonly moved: readonly FolderRecord[];
    }
  /** Nothing in it: a project can be made there. */
  | { readonly kind: "empty"; readonly folder: LocalFolder }
  | { readonly kind: "refused"; readonly error: ImportRefused };

/** Where a new project would go in a folder that people chose. */
export type NewPlace =
  | { readonly kind: "empty" }
  /** A project is there already: open that one instead. */
  | { readonly kind: "project" }
  /** What is left of an export that did not get to the end, which is no place for a project. */
  | { readonly kind: "incomplete" }
  /** Other things are there: a folder of this name in it, or the folder itself if people say so. */
  | { readonly kind: "other"; readonly inside: string };

export interface FolderProjectsOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly t: TFunction;
  /** A new number for a folder, see `FolderRecord.id`. */
  readonly newKey?: () => string;
  readonly now?: () => number;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

/** A folder on this computer, the way a folder is read to bring a project in. */
const sourceOf = (folder: LocalFolder): SourceFolder => ({
  name: folder.name,
  async *files() {
    for await (const path of folder.list()) yield { path, read: () => folder.file(path) };
  },
});

/** What is at the top of a folder: the names of its files and folders. */
const topNames = (paths: readonly string[]): Set<string> =>
  new Set(paths.map((path) => path.split("/")[0] as string));

export class FolderProjects {
  readonly #folders: LocalFolders;
  readonly #projects: ProjectLibrary;
  readonly #t: TFunction;
  readonly #newKey: () => string;
  readonly #now: () => number;

  constructor({
    folders,
    projects,
    t,
    newKey = () => crypto.randomUUID(),
    now = Date.now,
  }: FolderProjectsOptions) {
    this.#folders = folders;
    this.#projects = projects;
    this.#t = t;
    this.#newKey = newKey;
    this.#now = now;
  }

  get records() {
    return this.#folders.records;
  }

  /** The folders opened in this browser, the most recent first, and how each is now. */
  async recent(): Promise<readonly RecentFolder[]> {
    const records = await this.#folders.records.list();
    return Promise.all(
      records.map(async (record) => ({
        record,
        status: await record.folder.status().catch((): FolderStatus => "gone"),
      })),
    );
  }

  /**
   * What a folder holds, for opening it. It reads all of it only where this browser does not know
   * the folder yet: a folder it knows is compared with what it knows once it is open.
   */
  async look(chosen: LocalFolder): Promise<FolderLook> {
    const known = await this.#folders.records.find(chosen);
    if (known && (await this.#isProject(chosen))) return this.#found(chosen, known, known.project);
    const paths = await collect(chosen.list());
    if (paths.length === 0) return { kind: "empty", folder: chosen };
    let reading: ProjectFolder;
    try {
      reading = await readProjectFolder(sourceOf(chosen), this.#t);
    } catch (error) {
      if (error instanceof ImportRefused) return { kind: "refused", error };
      throw error;
    }
    const { id } = reading.project.manifest;
    // The project is right inside what people chose: that folder is the project.
    const root = paths.includes(MANIFEST_FILE) ? "" : this.#rootOf(paths);
    const folder = root === "" ? chosen : await chosen.inside(root);
    const record = root === "" ? known : await this.#folders.records.find(folder);
    return this.#found(folder, record, id);
  }

  /** Where a new project would go in a folder people chose, see `NewPlace`. */
  async placeFor(folder: LocalFolder, name: string): Promise<NewPlace> {
    const paths = await collect(folder.list());
    if (paths.length === 0) return { kind: "empty" };
    if (paths.includes(INCOMPLETE_FILE)) return { kind: "incomplete" };
    if (paths.includes(MANIFEST_FILE) || paths.some((path) => path.endsWith(`/${MANIFEST_FILE}`))) {
      const look = await this.look(folder);
      if (look.kind === "project") return { kind: "project" };
    }
    return { kind: "other", inside: newNameFor(name, topNames(paths)) };
  }

  /**
   * Makes a new project in a folder that people chose, as it says where: in it, or in a new folder
   * of that name in it. The editor writes its files once it is open.
   */
  async create(name: string, chosen: LocalFolder, inside?: string): Promise<FolderRecord> {
    const folder = inside === undefined ? chosen : await chosen.inside(inside, { create: true });
    const store = ProjectStore.create(createProject({ name }));
    const { id: project } = store.getState().manifest;
    const state = store.encodeState();
    store.destroy();
    const id = this.#newKey();
    await this.#projects.create({ id, name }, state);
    const record: FolderRecord = { id, folder, project, name, openedAt: this.#now() };
    await this.#folders.records.put(record);
    return record;
  }

  /**
   * What this browser needs to open the project of a folder: its record, and its log. What it
   * reads of a folder it does not know yet goes into the log, with the assets. With `moved` this is
   * that folder, which was not where it was any more: everything kept of it goes on.
   */
  async adopt(
    look: Extract<FolderLook, { kind: "project" }>,
    moved?: FolderRecord,
  ): Promise<{ readonly record: FolderRecord; readonly report: ImportReport | undefined }> {
    const id = moved?.id ?? look.record?.id ?? this.#newKey();
    const record: FolderRecord = {
      id,
      folder: look.folder,
      project: look.project,
      name: look.name,
      openedAt: this.#now(),
    };
    const report = await this.prepare(record);
    const kept = report ? { ...record, name: report.name } : record;
    await this.#folders.records.put(kept);
    return { record: kept, report };
  }

  /**
   * What this browser needs of a folder it knows, to open its project: the log, which comes from the
   * folder where this browser lost it, as when its data was cleared. Resolves to what came in then.
   */
  async prepare(record: FolderRecord): Promise<ImportReport | undefined> {
    if (await this.#hasLog(record.id)) return undefined;
    const reading = await readProjectFolder(sourceOf(record.folder), this.#t);
    return bringIn(reading, this.#projects, { key: record.id, copyName: (wanted) => wanted });
  }

  /** Notes that a folder was opened just now, with what its project is called now. */
  async opened(record: FolderRecord, name = record.name): Promise<void> {
    await this.#folders.records.put({ ...record, name, openedAt: this.#now() });
  }

  /**
   * Another place of a folder that is not where it was, which people found: it has to be this
   * project, as a folder knows only its place, and whatever is there could be anything.
   */
  async findAgain(
    record: FolderRecord,
    folder: LocalFolder,
  ): Promise<"found" | "not-a-project" | "other-project"> {
    let text: string;
    try {
      text = await folder.readText(MANIFEST_FILE);
    } catch {
      return "not-a-project";
    }
    const id = projectIdOf(text);
    if (id === undefined) return "not-a-project";
    if (id !== record.project) return "other-project";
    await this.#folders.records.put({ ...record, folder, openedAt: this.#now() });
    return "found";
  }

  /**
   * Takes a folder off the list, with everything this browser kept of it: its log, the bases and
   * the turns to write. Nothing happens to the folder itself.
   */
  async forget(id: string): Promise<void> {
    await this.#folders.records.remove(id);
    await this.#folders.bases.forget(id);
    await this.#projects.remove(id);
  }

  async #isProject(folder: LocalFolder): Promise<boolean> {
    try {
      await folder.file(MANIFEST_FILE);
      return true;
    } catch {
      return false;
    }
  }

  /** The one folder right inside with a project in it, which reading found. */
  #rootOf(paths: readonly string[]): string {
    const roots = paths
      .filter((path) => path.endsWith(`/${MANIFEST_FILE}`) && path.split("/").length === 2)
      .map((path) => path.split("/")[0] as string);
    return roots[0] ?? "";
  }

  async #found(
    folder: LocalFolder,
    record: FolderRecord | undefined,
    project: string,
  ): Promise<FolderLook> {
    const name = record?.name ?? (await this.#nameIn(folder)) ?? folder.name;
    if (record) return { kind: "project", folder, project, name, record, moved: [] };
    const others = await this.#folders.records.withProject(project);
    const moved = (
      await Promise.all(
        others.map(async (other) => ((await other.folder.status()) === "gone" ? other : undefined)),
      )
    ).filter((other) => other !== undefined);
    return { kind: "project", folder, project, name, record, moved };
  }

  async #nameIn(folder: LocalFolder): Promise<string | undefined> {
    try {
      const manifest = JSON.parse((await folder.readText(MANIFEST_FILE)).replace(/^﻿/, ""));
      return typeof manifest?.name === "string" ? manifest.name : undefined;
    } catch {
      return undefined;
    }
  }

  async #hasLog(id: string): Promise<boolean> {
    const log = await this.#projects.open(id);
    try {
      return (await log.load()).length > 0;
    } finally {
      log.close();
    }
  }
}
