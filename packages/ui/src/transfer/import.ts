import {
  FolderRefused,
  ProjectStore,
  isFolderProblem,
  readFolder,
  type FolderProblemCode,
  type FolderRefusal,
  type LostPart,
  type ReadOnlyFolder,
} from "@animaquill/core";
import type { FolderFile, MediaStore, ProjectLibrary, SourceFolder } from "@animaquill/host";
import { hashFile, isSameHash } from "@animaquill/media";
import { newId, type Problem, type Project } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { elsewhereFile, isPointerTo, type ElsewhereFile } from "../storage/places.ts";
import type { TransferStep } from "./export.ts";

/** What a project still points at when something it needs stayed out. */
const POINTS_AT_NOTHING = new Set([
  "asset-missing",
  "library-missing",
  "scene-missing",
  "sound-missing",
  "string-missing",
  "timeline-missing",
]);

export type RefusalReason = FolderRefusal;

/** The folder cannot become a project. Nothing has been written at this point. */
export class ImportRefused extends Error {
  readonly reason: RefusalReason;
  readonly problems: readonly Problem[];

  constructor(reason: RefusalReason, problems: readonly Problem[] = []) {
    super(`Refused: ${reason}`);
    this.reason = reason;
    this.problems = problems;
  }
}

/** A document that cannot be used, so the project can only come in without it. */
export interface LostDocument {
  readonly file: string;
  /** What that costs, in words that mean something to people. */
  readonly consequence: string;
  /** What is wrong with it. */
  readonly problems: readonly Problem[];
}

/** What was found in a folder, before any of it moved. */
export interface ProjectFolder {
  readonly project: Project;
  /** The text of scene, sound and shared code files. */
  readonly sources: Readonly<Record<string, string>>;
  readonly files: ReadonlyMap<string, FolderFile>;
  /** Files the project has no place for. */
  readonly skipped: readonly string[];
  /** Without people saying so, a project does not come in with any of this missing. */
  readonly lost: readonly LostDocument[];
  readonly warnings: readonly Problem[];
}

export interface ReadOptions {
  readonly signal?: AbortSignal;
  readonly onStep?: (step: TransferStep) => void;
}

/** A folder people chose, the way folders are read. It keeps what it listed, for later. */
function readable(source: SourceFolder) {
  const files = new Map<string, FolderFile>();
  const folder: ReadOnlyFolder = {
    async *list() {
      for await (const file of source.files()) {
        files.set(file.path, file);
        yield file.path;
      }
    },
    file(path) {
      const file = files.get(path);
      return file ? file.read() : Promise.reject(new Error(`Not listed: ${path}`));
    },
  };
  return { folder, files };
}

/** What the editor says about what reading a folder found, see `FolderProblemCode`. */
const PROBLEMS = {
  "not-text": "transfer.notText",
  "timeline-not-in-folder": "transfer.noTimeline",
  "entry-missing": "transfer.entryMissing",
} as const satisfies Record<FolderProblemCode, string>;

/** A problem in words of the editor. What the format says comes with words of its own. */
const said = (problem: Problem, t: TFunction): Problem =>
  isFolderProblem(problem) ? { ...problem, message: t(PROBLEMS[problem.code]) } : problem;

/** What people lose with a document. */
function consequenceOf(file: string, part: LostPart, t: TFunction): string {
  switch (part.kind) {
    case "timeline": {
      const key = part.listed ? "transfer.lost.timeline" : "transfer.lost.otherTimeline";
      return t(key, { id: part.id });
    }
    case "override":
      return t("transfer.lost.override", { id: part.timeline, version: part.version });
    case "scene":
      return t("transfer.lost.scene", { id: part.id });
    case "sound":
      return t("transfer.lost.sound", { id: part.id });
    case "locale":
      return t("transfer.lost.locale", { id: part.id });
    case "assets":
      return t("transfer.lost.assets");
    case "notes":
      return t("transfer.lost.notes");
    case "libraries":
      return t("transfer.lost.libraries");
    case "lock":
      return t("transfer.lost.lock");
    case "other":
      return file;
  }
}

/**
 * Finds out what a folder holds and whether it can become a project, without writing anything. What
 * makes the whole folder useless is refused here. A document that is broken only costs that
 * document, as when opening a project, but unlike there people get to hear about it first: a new
 * project with a part missing looks like what they had, and they may well trust it and throw the
 * folder away. That is why `lost` is not a detail, and has to be agreed to.
 */
export async function readProjectFolder(
  source: SourceFolder,
  t: TFunction,
  { signal, onStep }: ReadOptions = {},
): Promise<ProjectFolder> {
  const { folder, files } = readable(source);
  const reading = await readFolder(folder, {
    ...(signal ? { signal } : {}),
    onFile: (file) => onStep?.({ file, done: 0, total: 0 }),
    emptyTimeline: (id) => t("transfer.emptyTimeline", { id }),
  }).catch((error: unknown) => {
    if (!(error instanceof FolderRefused)) throw error;
    throw new ImportRefused(
      error.reason,
      error.problems.map((problem) => said(problem, t)),
    );
  });
  const { root, project, sources, skipped, lost, warnings } = reading;
  return {
    project,
    sources,
    files: new Map(
      reading.files.flatMap((path) => {
        const file = files.get(`${root}${path}`);
        return file ? [[path, file] as const] : [];
      }),
    ),
    skipped,
    lost: lost.map(({ file, part, problems }) => ({
      file,
      consequence: consequenceOf(file, part, t),
      problems: problems.map((problem) => said(problem, t)),
    })),
    warnings: warnings.map((problem) => said(problem, t)),
  };
}

/** The places where a project points at what stayed out, or was never there. */
export const pointingAtNothing = (warnings: readonly Problem[]): readonly Problem[] =>
  warnings.filter(({ code }) => POINTS_AT_NOTHING.has(code));

/** What people have to know about a project that came in. */
export interface ImportReport {
  /** What this browser keeps the project by, see `BringInOptions.key`. */
  readonly id: string;
  readonly name: string;
  /** There was a project with this id, which stayed as it is, so this one has an id of its own. */
  readonly copied: boolean;
  /** Assets whose file is not in the folder, nor anywhere else. */
  readonly missing: readonly string[];
  /** Assets whose file is not in the folder, but kept somewhere else, to download from there. */
  readonly elsewhere: readonly ElsewhereFile[];
  /** Assets whose file is not the one the project knows, and stayed out. */
  readonly damaged: readonly string[];
  /** Files the project has no place for. */
  readonly skipped: readonly string[];
  /** What is missing because people agreed to go on without it. */
  readonly lost: readonly string[];
  readonly warnings: readonly Problem[];
  /** It holds scenes or sounds, whose code runs as soon as the project is open. */
  readonly runsCode: boolean;
}

export interface BringInOptions extends ReadOptions {
  /** The name for a project that has to be a copy. */
  readonly copyName: (name: string) => string;
  /**
   * What this browser keeps the project by, for a project that stays in its folder: then it keeps its
   * own id and name, as copies of a folder have the same one, see `SessionSnapshot.key`. Without
   * this the project is kept by its id, or as a copy where that is taken.
   */
  readonly key?: string;
}

/**
 * A project read from a folder, with the files of its assets checked, before any of it is kept
 * anywhere: what `bringIn` keeps in this browser, and what a new project of the platform is made
 * of, see `CloudCreate`. The assets say the hash and size of the file that was read.
 */
export interface PreparedProject {
  readonly project: Project;
  readonly sources: Readonly<Record<string, string>>;
  /** The files to keep, by the hash the project finds them by. */
  readonly files: readonly { readonly hash: string; readonly file: File; readonly label: string }[];
  /** What people have to know, see `ImportReport`. */
  readonly report: Omit<ImportReport, "id" | "name" | "copied">;
}

/**
 * Reads the files of the assets of a project found in a folder, and checks them: one whose content
 * is not what the project says stays out, as damaged. Nothing is kept: see `keepFiles`, which says
 * how far it got on its own.
 */
export async function prepareProject(
  folder: ProjectFolder,
  {
    signal,
    onStep,
    withFiles = true,
    media,
  }: ReadOptions & {
    readonly withFiles?: boolean;
    /** Keeps each file right as it is checked, as `keepFiles` does, where it is to be kept now. */
    readonly media?: MediaStore;
  } = {},
): Promise<PreparedProject> {
  const { project, sources, files, skipped, lost, warnings } = folder;
  const assets = { ...project.assets?.assets };
  const found = [];
  for (const [assetId, asset] of withFiles ? Object.entries(assets) : []) {
    const file = await files.get(asset.path)?.read();
    if (file) found.push({ id: assetId, asset, file });
  }
  const total = found.reduce((sum, { file }) => sum + file.size, 0);
  let done = 0;
  const kept: { hash: string; file: File; label: string }[] = [];
  const stored = new Set<string>();
  const damaged = new Map<string, string>();
  for (const { id: assetId, asset, file } of found) {
    const before = done;
    const label = asset.name ?? asset.path;
    const step = (bytes: number) => onStep?.({ file: label, done: before + bytes, total });
    step(0);
    // A folder cloned without Git LFS has the pointer to the file in its place: the file is not
    // here, as for one that is missing, and can come from where it is kept, see below.
    const { hash: known, size } = asset;
    if (known !== undefined && (await isPointerTo(file, { hash: known, size }))) {
      done += file.size;
      continue;
    }
    const hash = await hashFile(file, { ...(signal ? { signal } : {}), onProgress: step });
    if (asset.hash !== undefined && !isSameHash(asset.hash, hash)) {
      damaged.set(assetId, label);
    } else {
      // A project finds a file by the hash it has written down, however a tool wrote that.
      const stamp = asset.hash ?? hash;
      if (!stored.has(stamp)) {
        kept.push({ hash: stamp, file, label });
        if (media) await keepFile(media, stamp, file, { ...(signal && { signal }) });
      }
      stored.add(stamp);
      assets[assetId] = { ...asset, hash: stamp, size: file.size };
    }
    done += file.size;
    step(0);
    signal?.throwIfAborted();
  }
  // Another asset can have brought in the same content from a place of its own.
  const isCovered = (assetId: string, hash: string | undefined) =>
    damaged.has(assetId) || (hash !== undefined && stored.has(hash));
  const notHere = withFiles
    ? Object.entries(assets).filter(([assetId, asset]) => !isCovered(assetId, asset.hash))
    : [];
  // What can come from where it is kept is not missing, see `elsewhereFile`.
  const missing: string[] = [];
  const elsewhere: ElsewhereFile[] = [];
  for (const [, asset] of notHere) {
    const label = asset.name ?? asset.path;
    const there = elsewhereFile(asset, label);
    if (there) elsewhere.push(there);
    else missing.push(label);
  }
  return {
    project: project.assets ? { ...project, assets: { assets } } : project,
    sources,
    files: kept,
    report: {
      missing,
      elsewhere,
      damaged: [...damaged.values()],
      skipped,
      lost: lost.map(({ consequence }) => consequence),
      warnings,
      runsCode: project.scenes.size + project.sounds.size > 0,
    },
  };
}

/**
 * Keeps the files of a prepared project, see `prepareProject`, and reads each back: people may throw
 * the folder away once this is over, so what is kept has to be all of it. Rejects where it is not.
 */
export async function keepFiles(
  prepared: PreparedProject,
  media: MediaStore,
  { signal, onStep }: ReadOptions = {},
): Promise<void> {
  // Every file is written and read back.
  const total = prepared.files.reduce((sum, { file }) => sum + file.size, 0);
  let done = 0;
  for (const { hash, file, label } of prepared.files) {
    const before = done;
    await keepFile(media, hash, file, {
      ...(signal && { signal }),
      onProgress: (bytes) => onStep?.({ file: label, done: before + bytes, total }),
    });
    done += file.size;
  }
}

/** Keeps one file by its hash, and reads it back: what was kept has to be the file. */
async function keepFile(
  media: MediaStore,
  hash: string,
  file: File,
  {
    signal,
    onProgress,
  }: { readonly signal?: AbortSignal; readonly onProgress?: (bytes: number) => void },
): Promise<void> {
  await media.put(hash, file);
  const kept = await media.get(hash);
  const keptHash =
    kept &&
    (await hashFile(kept, { ...(signal && { signal }), ...(onProgress && { onProgress }) }));
  if (keptHash === undefined || !isSameHash(keptHash, hash)) {
    throw new Error(`What this browser kept of ${file.name} is not the file`);
  }
  signal?.throwIfAborted();
}

/**
 * Makes a new project of a folder. It only ever appears as a whole: until the last step nobody sees
 * it, and however this ends, projects that were there before stay as they are.
 */
export async function bringIn(
  folder: ProjectFolder,
  projects: ProjectLibrary,
  { copyName, key, signal, onStep }: BringInOptions,
): Promise<ImportReport> {
  const { project } = folder;
  let { id, name } = project.manifest;
  let incoming = await projects.receive({ id: key ?? id, name, ...(key && { folder: true }) });
  const copied = incoming === undefined && key === undefined;
  if (!incoming && key === undefined) {
    id = newId("project");
    name = copyName(name);
    incoming = await projects.receive({ id, name });
  }
  if (!incoming) throw new Error(`The new id ${key ?? id} is taken`);

  try {
    // A project that stays in its folder reads its files from there: nothing comes into the browser.
    const options = { ...(signal && { signal }), ...(onStep && { onStep }) };
    // Each file is kept as soon as it is checked: what stopped halfway has what it got to.
    const prepared = await prepareProject(folder, {
      ...options,
      withFiles: key === undefined,
      media: incoming.media,
    });
    const store = ProjectStore.create(
      { ...prepared.project, manifest: { ...prepared.project.manifest, id, name } },
      prepared.sources,
    );
    const state = store.encodeState();
    store.destroy();
    await incoming.finish(state);
    return { id: key ?? id, name, copied, ...prepared.report };
  } catch (error) {
    await incoming.abandon().catch((failure: unknown) => {
      // The host cleans up the next time, and the project does not exist either way.
      console.warn("A project that did not make it stays behind for now", failure);
    });
    throw error;
  }
}
