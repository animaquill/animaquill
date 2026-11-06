import { ProjectStore, isSourceFile } from "@animaquill/core";
import type { FolderFile, ProjectLibrary, SourceFolder } from "@animaquill/host";
import { hashFile, isSameHash } from "@animaquill/media";
import {
  MANIFEST_FILE,
  documentSchema,
  newId,
  readProject,
  writeProject,
  type Problem,
  type Project,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import { INCOMPLETE_FILE, MAX_SOURCE_BYTES, type TransferStep } from "./export.ts";

/** Nobody keeps this many files in a project: this is a whole disk chosen by mistake. */
const MAX_FILES = 100_000;
/** What systems leave in folders, which is not worth a word to anybody. */
const CLUTTER = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*|[^/]*\.crswap)$/i;

export type RefusalReason =
  "not-a-project" | "several-projects" | "incomplete" | "too-many-files" | "too-new" | "invalid";

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

/** What was found in a folder, before any of it moved. */
export interface ProjectFolder {
  readonly project: Project;
  /** The text of scene, sound and shared code files. */
  readonly sources: Readonly<Record<string, string>>;
  readonly files: ReadonlyMap<string, FolderFile>;
  /** Files the project has no place for. */
  readonly skipped: readonly string[];
  readonly warnings: readonly Problem[];
}

export interface ReadOptions {
  readonly signal?: AbortSignal;
  readonly onStep?: (step: TransferStep) => void;
}

/** The project itself, or the one project right inside of what people chose. */
function rootOf(paths: Iterable<string>): string {
  const roots = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    const name = parts.at(-1);
    if (parts.length > 2 || (name !== MANIFEST_FILE && name !== INCOMPLETE_FILE)) continue;
    roots.add(parts.length === 2 ? `${parts[0]}/` : "");
  }
  if (roots.size === 0) throw new ImportRefused("not-a-project");
  if (roots.has("")) return "";
  if (roots.size > 1) throw new ImportRefused("several-projects");
  return [...roots][0] as string;
}

async function list(
  source: SourceFolder,
  { signal, onStep }: ReadOptions,
): Promise<Map<string, FolderFile>> {
  const files = new Map<string, FolderFile>();
  for await (const file of source.files()) {
    signal?.throwIfAborted();
    if (CLUTTER.test(file.path)) continue;
    files.set(file.path, file);
    if (files.size > MAX_FILES) throw new ImportRefused("too-many-files");
    onStep?.({ file: file.path, done: 0, total: 0 });
  }
  const root = rootOf(files.keys());
  const inside = [...files].filter(([path]) => path.startsWith(root));
  return new Map(inside.map(([path, file]) => [path.slice(root.length), file]));
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Resolves to undefined and leaves a reason for what is no text. */
async function readText(
  file: File,
  t: TFunction,
  refuse: (message: string) => void,
): Promise<string | undefined> {
  const bytes = await file.arrayBuffer();
  try {
    // The text of a file stays what it is. A file that is no text would come out damaged.
    return decoder.decode(bytes);
  } catch {
    refuse(t("transfer.notText"));
    return undefined;
  }
}

const unreadable = (file: string, message: string): Problem => ({
  severity: "error",
  code: "unreadable",
  file,
  message,
});

/**
 * Finds out what a folder holds and whether it can become a project, without writing anything. A
 * file that is broken costs the whole folder here, unlike when opening a project: a new project
 * with a part missing would look like what people had, and they may well trust it and throw the
 * folder away. They get the list, and can put the files right.
 */
export async function readProjectFolder(
  source: SourceFolder,
  t: TFunction,
  options: ReadOptions = {},
): Promise<ProjectFolder> {
  const { signal, onStep } = options;
  const files = await list(source, options);
  if (files.has(INCOMPLETE_FILE)) throw new ImportRefused("incomplete");

  const texts = new Map<string, string>();
  const problems: Problem[] = [];
  const skipped = new Set<string>();
  for (const [path, entry] of files) {
    const isDocument = documentSchema(path) !== undefined;
    if (!isDocument && !isSourceFile(path)) {
      skipped.add(path);
      continue;
    }
    signal?.throwIfAborted();
    onStep?.({ file: path, done: 0, total: 0 });
    const file = await entry.read();
    if (!isDocument && file.size > MAX_SOURCE_BYTES) {
      skipped.add(path);
      continue;
    }
    const text = await readText(file, t, (message) => {
      if (isDocument) problems.push(unreadable(path, message));
      else skipped.add(path);
    });
    // Editors on Windows like to put a byte order mark in front, which JSON does not allow.
    if (text !== undefined) texts.set(path, isDocument ? text.replace(/^\uFEFF/, "") : text);
  }

  const { project, problems: found } = readProject(texts);
  const tooNew = found.find((problem) => problem.code === "format-too-new");
  if (tooNew) throw new ImportRefused("too-new", [tooNew]);
  const errors = [...problems, ...found.filter((problem) => problem.severity === "error")];
  if (!project || errors.length > 0) throw new ImportRefused("invalid", errors);

  // A document can be fine and still have no place, such as what belongs to no timeline.
  const kept = writeProject(project);
  for (const path of texts.keys()) {
    if (!kept.has(path) && !isSourceFile(path)) skipped.add(path);
  }
  for (const { path } of Object.values(project.assets?.assets ?? {})) skipped.delete(path);

  // Browsers do not show links in a folder, so what a project needs can be gone without a trace.
  const entries = [
    ...[...project.scenes].map(([id, { entry }]) => `scenes/${id}/${entry}`),
    ...[...project.sounds].map(([id, { entry }]) => `sounds/${id}/${entry}`),
  ];
  const withoutEntry = entries.filter((path) => !texts.has(path));
  return {
    project,
    sources: Object.fromEntries([...texts].filter(([path]) => isSourceFile(path))),
    files,
    skipped: [...skipped].toSorted(),
    warnings: [
      ...found.filter((problem) => problem.severity !== "error"),
      ...withoutEntry.map((file): Problem => ({
        severity: "warning",
        code: "entry-missing",
        file,
        message: t("transfer.entryMissing"),
      })),
    ],
  };
}

/** What people have to know about a project that came in. */
export interface ImportReport {
  readonly id: string;
  readonly name: string;
  /** There was a project with this id, which stayed as it is, so this one has an id of its own. */
  readonly copied: boolean;
  /** Assets whose file is not in the folder. */
  readonly missing: readonly string[];
  /** Assets whose file is not the one the project knows, and stayed out. */
  readonly damaged: readonly string[];
  /** Files the project has no place for. */
  readonly skipped: readonly string[];
  readonly warnings: readonly Problem[];
}

export interface BringInOptions extends ReadOptions {
  /** The name for a project that has to be a copy. */
  readonly copyName: (name: string) => string;
}

/**
 * Makes a new project of a folder. It only ever appears as a whole: until the last step nobody sees
 * it, and however this ends, projects that were there before stay as they are.
 */
export async function bringIn(
  folder: ProjectFolder,
  projects: ProjectLibrary,
  { copyName, signal, onStep }: BringInOptions,
): Promise<ImportReport> {
  const { project, sources, files, skipped, warnings } = folder;
  let { id, name } = project.manifest;
  let incoming = await projects.receive({ id, name });
  const copied = incoming === undefined;
  if (!incoming) {
    id = newId("project");
    name = copyName(name);
    incoming = await projects.receive({ id, name });
  }
  if (!incoming) throw new Error(`The new id ${id} is taken`);

  try {
    const assets = { ...project.assets?.assets };
    const found = [];
    for (const [assetId, asset] of Object.entries(assets)) {
      const file = await files.get(asset.path)?.read();
      if (file) found.push({ id: assetId, asset, file });
    }
    // Every file is read twice: to check it, and to store it.
    const total = found.reduce((sum, { file }) => sum + file.size * 2, 0);

    let done = 0;
    const stored = new Set<string>();
    const damaged = new Map<string, string>();
    for (const { id: assetId, asset, file } of found) {
      const before = done;
      const label = asset.name ?? asset.path;
      const step = (bytes: number) => onStep?.({ file: label, done: before + bytes, total });
      step(0);
      const hash = await hashFile(file, { ...(signal ? { signal } : {}), onProgress: step });
      if (asset.hash !== undefined && !isSameHash(asset.hash, hash)) {
        damaged.set(assetId, label);
      } else {
        // A project finds a file by the hash it has written down, however a tool wrote that.
        const key = asset.hash ?? hash;
        if (!stored.has(key)) await incoming.media.put(key, file);
        stored.add(key);
        assets[assetId] = { ...asset, hash: key, size: file.size };
      }
      done += file.size * 2;
      step(0);
      signal?.throwIfAborted();
    }

    // Another asset can have brought in the same content from a place of its own.
    const isCovered = (assetId: string, hash: string | undefined) =>
      damaged.has(assetId) || (hash !== undefined && stored.has(hash));
    const missing = Object.entries(assets)
      .filter(([assetId, asset]) => !isCovered(assetId, asset.hash))
      .map(([, asset]) => asset.name ?? asset.path);

    const store = ProjectStore.create(
      {
        ...project,
        manifest: { ...project.manifest, id, name },
        ...(project.assets ? { assets: { assets } } : {}),
      },
      sources,
    );
    const state = store.encodeState();
    store.destroy();
    await incoming.finish(state);
    return {
      id,
      name,
      copied,
      missing,
      damaged: [...damaged.values()],
      skipped,
      warnings,
    };
  } catch (error) {
    await incoming.abandon().catch((failure: unknown) => {
      // The host cleans up the next time, and the project does not exist either way.
      console.warn("A project that did not make it stays behind for now", failure);
    });
    throw error;
  }
}
