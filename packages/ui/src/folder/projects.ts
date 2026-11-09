/**
 * Projects that are folders on this computer, as far as this browser knows them: which folders were
 * opened here, what a folder people chose or dropped holds, and making a project of one. It does not
 * touch the page and asks nobody anything: that is for the workbench, see `ProjectFolders`.
 *
 * A folder is known by a number of this browser, see `FolderRecord.id`, and so is everything this
 * browser keeps of its project: the log, the bases, what is being tried. Copies of a folder have the
 * same project id, and must not share any of that. One folder has one record at most.
 */
import { INCOMPLETE_FILE, ProjectStore, isNoneOfIt } from "@animaquill/core";
import {
  newNameFor,
  type FolderRecord,
  type FolderStatus,
  type LocalFolder,
  type LocalFolders,
  type ProjectLibrary,
  type SourceFolder,
} from "@animaquill/host";
import { CURRENT_FORMAT_VERSION, MANIFEST_FILE, createProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { TransferStep } from "../transfer/export.ts";
import {
  ImportRefused,
  bringIn,
  readProjectFolder,
  type ImportReport,
  type ProjectFolder,
} from "../transfer/import.ts";
import { formatVersionOf, isProjectFile, projectIdOf } from "./project-files.ts";

/** What a folder that people chose or dropped holds, for opening it. */
export type FolderLook =
  /**
   * A folder this browser knows, with its project in it, or with nothing of a project any more:
   * then the project comes back from the log, see `FolderSession.useEditorContent`.
   */
  | { readonly kind: "known"; readonly record: FolderRecord }
  /**
   * A project that this browser has no record of for this folder, maybe one right inside what people
   * chose. `moved` are records of the same project whose folder is not where it was, or cannot be
   * looked at: this may be that folder, moved. `replacing` is the record of this very folder, whose
   * project is not in it any more.
   */
  | {
      readonly kind: "project";
      readonly folder: LocalFolder;
      readonly reading: ProjectFolder;
      readonly project: string;
      readonly name: string;
      readonly moved: readonly FolderRecord[];
      readonly replacing: FolderRecord | undefined;
    }
  /** Nothing in it, apart from what systems leave: a project can be made there. */
  | { readonly kind: "empty"; readonly folder: LocalFolder }
  | { readonly kind: "refused"; readonly error: ImportRefused };

/** Where a new project would go in a folder that people chose. */
export type NewPlace =
  | { readonly kind: "empty" }
  /** A project is there already: open that one instead. */
  | { readonly kind: "project" }
  /** This browser knows the folder as the folder of a project: open that one instead. */
  | { readonly kind: "known"; readonly record: FolderRecord }
  /** It is in the folder of a project this browser knows, which would take it for its own. */
  | { readonly kind: "inside"; readonly record: FolderRecord }
  /** What is left of an export that did not get to the end, which is no place for a project. */
  | { readonly kind: "incomplete" }
  /**
   * Other things are there: a folder of this name in it. `clashes` are files where a project has
   * its files, which a project right in this folder would take for its own: then it cannot go there.
   */
  | { readonly kind: "other"; readonly inside: string; readonly clashes: readonly string[] };

/** What came of finding a folder again that was not where it was. */
export type FoundAgain = "found" | "not-a-project" | "other-project" | "too-new" | "taken";

export interface FolderProjectsOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly t: TFunction;
  /** A new number for a folder, see `FolderRecord.id`. */
  readonly newKey?: () => string;
  readonly now?: () => number;
}

export interface ReadingOptions {
  readonly signal?: AbortSignal;
  readonly onStep?: (step: TransferStep) => void;
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

/** Where a project has files of its own, which a new project right there would take in. */
const isProjectPlace = (path: string): boolean => isProjectFile(path) || path.startsWith("assets/");

/** The files of a folder, apart from what systems and tools leave in folders. */
const filesIn = async (folder: LocalFolder): Promise<string[]> =>
  (await collect(folder.list())).filter((path) => !isNoneOfIt(path));

/** The text of animaquill.json at the top of a folder, or undefined. */
async function manifestIn(folder: LocalFolder): Promise<string | undefined> {
  try {
    return await folder.readText(MANIFEST_FILE);
  } catch {
    return undefined;
  }
}

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

  /** How a folder this browser knows is now. Looking at it can take a while, as on a network. */
  statusOf(record: FolderRecord): Promise<FolderStatus> {
    return record.folder.status().catch((): FolderStatus => "gone");
  }

  /**
   * Whether a folder people dropped can be a project to open, before the editor asks to write it:
   * it has animaquill.json, at the top or in a folder right inside, or nothing at all.
   */
  async mayBeProject(folder: LocalFolder): Promise<boolean> {
    if ((await manifestIn(folder)) !== undefined) return true;
    const found = await collect(
      folder.list({
        includes: (path, kind) =>
          kind === "folder" ? !path.includes("/") : path.endsWith(MANIFEST_FILE),
      }),
    );
    if (found.length > 0) return true;
    return (await filesIn(folder)).length === 0;
  }

  /**
   * What a folder holds, for opening it. It reads all of it only where this browser does not know
   * the folder yet: a folder it knows is compared with what it knows once it is open.
   */
  async look(chosen: LocalFolder, options: ReadingOptions = {}): Promise<FolderLook> {
    let replacing = await this.#folders.records.find(chosen);
    if (replacing) {
      const text = await manifestIn(chosen);
      // The project is gone from it, or never left: either way it is the one this browser has.
      if (text === undefined || projectIdOf(text) === replacing.project) {
        return { kind: "known", record: replacing };
      }
    }
    const paths = await filesIn(chosen);
    if (paths.length === 0) return { kind: "empty", folder: chosen };
    let reading: ProjectFolder;
    try {
      reading = await readProjectFolder(sourceOf(chosen), this.#t, options);
    } catch (error) {
      if (error instanceof ImportRefused) return { kind: "refused", error };
      throw error;
    }
    const { id, name } = reading.project.manifest;
    // The project is right inside what people chose: that folder is the project.
    const root = paths.includes(MANIFEST_FILE) ? "" : this.#rootOf(paths);
    const folder = root === "" ? chosen : await chosen.inside(root);
    if (root !== "") {
      replacing = await this.#folders.records.find(folder);
      if (replacing?.project === id) return { kind: "known", record: replacing };
    }
    const moved = await this.#moved(folder, id);
    return { kind: "project", folder, reading, project: id, name, moved, replacing };
  }

  /** Where a new project would go in a folder people chose, see `NewPlace`. */
  async placeFor(folder: LocalFolder, name: string): Promise<NewPlace> {
    const known = await this.#folders.records.find(folder);
    if (known) return { kind: "known", record: known };
    const around = await this.#around(folder);
    if (around) return { kind: "inside", record: around };
    const paths = await filesIn(folder);
    if (paths.length === 0) return { kind: "empty" };
    if (paths.includes(INCOMPLETE_FILE)) return { kind: "incomplete" };
    if (paths.includes(MANIFEST_FILE)) return { kind: "project" };
    // A project in a folder inside is no reason not to have another one next to it.
    return {
      kind: "other",
      inside: newNameFor(name, topNames(paths)),
      clashes: paths.filter(isProjectPlace),
    };
  }

  /**
   * Makes a new project in a folder that people chose, as it says where: in it, or in a new folder
   * of that name in it. The editor writes its files once it is open.
   */
  async create(name: string, chosen: LocalFolder, inside?: string): Promise<FolderRecord> {
    const folder = inside === undefined ? chosen : await chosen.inside(inside, { create: true });
    if (await this.#folders.records.find(folder)) {
      throw new Error("This browser knows that folder as the folder of another project");
    }
    const store = ProjectStore.create(createProject({ name }));
    const { id: project } = store.getState().manifest;
    const state = store.encodeState();
    store.destroy();
    const id = this.#newKey();
    await this.#projects.create({ id, name, folder: true }, state);
    const record: FolderRecord = { id, folder, project, name, openedAt: this.#now() };
    await this.#folders.records.put(record);
    return record;
  }

  /**
   * What this browser needs to open the project of a folder it has no record of: a record, and a
   * log from what was read of it. With `moved` this is that folder, which was not where it was:
   * everything kept of it goes on. What was the record of this very folder goes, with its log.
   */
  async adopt(
    look: Extract<FolderLook, { kind: "project" }>,
    moved?: FolderRecord,
  ): Promise<{ readonly record: FolderRecord; readonly report: ImportReport | undefined }> {
    if (look.replacing && look.replacing.id !== moved?.id) await this.forget(look.replacing.id);
    const id = moved?.id ?? this.#newKey();
    let report: ImportReport | undefined;
    let { name } = look;
    if (!(await this.#hasLog(id))) {
      report = await bringIn(look.reading, this.#projects, {
        key: id,
        copyName: (wanted) => wanted,
      });
      ({ name } = report);
    }
    // A folder that moved has what it had: what was kept of it goes on, and so do the changes that
    // it did not get yet.
    const record: FolderRecord = {
      id,
      folder: look.folder,
      project: look.project,
      name,
      openedAt: this.#now(),
    };
    await this.#folders.records.put(record);
    return { record, report };
  }

  /**
   * What this browser needs of a folder it knows, to open its project: the log, which comes from the
   * folder where this browser lost it, as when its data was cleared. Resolves to what came in then.
   */
  async prepare(
    record: FolderRecord,
    options: ReadingOptions = {},
  ): Promise<ImportReport | undefined> {
    if (await this.#hasLog(record.id)) return undefined;
    const reading = await readProjectFolder(sourceOf(record.folder), this.#t, options);
    return bringIn(reading, this.#projects, {
      key: record.id,
      copyName: (wanted) => wanted,
      ...options,
    });
  }

  /** Whether the project in a folder is of a newer format than this editor, which may not open it. */
  async isTooNew(folder: LocalFolder): Promise<boolean> {
    const text = await manifestIn(folder);
    return text !== undefined && (formatVersionOf(text) ?? 0) > CURRENT_FORMAT_VERSION;
  }

  /**
   * Whether the log has changes that the folder does not have, as far as this browser knows: what
   * was written last there, see `FolderBases`. Where that cannot be told, it may have.
   */
  async hasUnwritten(record: FolderRecord): Promise<boolean> {
    try {
      const log = await this.#projects.open(record.id);
      let updates: readonly Uint8Array[];
      try {
        updates = await log.load();
      } finally {
        log.close();
      }
      if (updates.length === 0) return false;
      const { store } = ProjectStore.fromUpdates(updates);
      if (!store) return true;
      const { files } = store.exportFiles();
      store.destroy();
      const bases = new Map(
        (await this.#folders.bases.load(record.id)).map(({ path, base }) => [path, base]),
      );
      if (bases.size === 0) return true;
      for (const [path, text] of files) if (bases.get(path) !== text) return true;
      for (const [path, base] of bases) if (base !== undefined && !files.has(path)) return true;
      return false;
    } catch {
      return true;
    }
  }

  /** Notes that a folder was opened just now, with what its project is called now. */
  async opened(record: FolderRecord, name = record.name): Promise<void> {
    await this.#folders.records.put({ ...record, name, openedAt: this.#now() });
  }

  /**
   * Another place of a folder that is not where it was, which people found: it has to be this
   * project, as a folder knows only its place, and whatever is there could be anything. Nor can
   * another project of this browser have that folder.
   */
  async findAgain(record: FolderRecord, folder: LocalFolder): Promise<FoundAgain> {
    const other = await this.#folders.records.find(folder);
    if (other && other.id !== record.id) return "taken";
    const text = await manifestIn(folder);
    const id = text === undefined ? undefined : projectIdOf(text);
    if (id === undefined) return "not-a-project";
    if (id !== record.project) return "other-project";
    if ((formatVersionOf(text as string) ?? 0) > CURRENT_FORMAT_VERSION) return "too-new";
    await this.#folders.records.put({ ...record, folder, openedAt: this.#now() });
    return "found";
  }

  /**
   * A new place for a project whose folder is gone, to write all of it to, as a new project goes:
   * what was kept of the old one does not go for it.
   */
  async relocate(record: FolderRecord, folder: LocalFolder): Promise<FolderRecord> {
    const other = await this.#folders.records.find(folder);
    if (other && other.id !== record.id) {
      throw new Error("This browser knows that folder as the folder of another project");
    }
    await this.#folders.bases.forget(record.id);
    const moved = { ...record, folder, openedAt: this.#now() };
    await this.#folders.records.put(moved);
    return moved;
  }

  /**
   * Takes a folder off the list, with everything this browser kept of it: its log, the bases and
   * the turns to write. Nothing happens to the folder itself.
   */
  async forget(id: string): Promise<void> {
    await this.#folders.records.remove(id);
    await this.#folders.bases.forget(id);
    await this.#projects.remove(id, { folder: true });
  }

  /** The one folder right inside with a project in it, which reading found. */
  #rootOf(paths: readonly string[]): string {
    const roots = paths
      .filter((path) => path.endsWith(`/${MANIFEST_FILE}`) && path.split("/").length === 2)
      .map((path) => path.split("/")[0] as string);
    return roots[0] ?? "";
  }

  /** The project folder this browser knows that a folder is in, if any. */
  async #around(folder: LocalFolder): Promise<FolderRecord | undefined> {
    for (const record of await this.#folders.records.list()) {
      const path = await record.folder.pathOf({ kind: "folder", folder }).catch(() => undefined);
      if (path) return record;
    }
    return undefined;
  }

  /**
   * Records of this project whose folder this is not, and is not where it was, or cannot be looked
   * at now: one of them may be this folder, moved. One that is where it was is a copy.
   */
  async #moved(folder: LocalFolder, project: string): Promise<FolderRecord[]> {
    const others = await this.#folders.records.withProject(project);
    const moved: FolderRecord[] = [];
    for (const other of others) {
      if (await other.folder.isSame(folder).catch(() => false)) continue;
      if ((await this.statusOf(other)) !== "ready") moved.push(other);
    }
    return moved;
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
