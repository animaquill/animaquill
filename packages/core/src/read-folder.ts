import {
  MANIFEST_FILE,
  createTimeline,
  documentSchema,
  readProject,
  retiredFadesIn,
  stringifyDocument,
  writeProject,
  type Problem,
  type Project,
} from "@animaquill/schema";
import { isSourceFile } from "./import-file.ts";
import { MAX_SOURCE_BYTES } from "./source-size.ts";

declare const TextDecoder: new (
  label: "utf-8",
  options: { readonly fatal: boolean; readonly ignoreBOM: boolean },
) => { decode(input: ArrayBuffer): string };

/**
 * What a file holds, as it was when it was asked for. A `File` or a `Blob` is one. Like a `File`,
 * one that changed since can fail to be read: it is not the file that was asked about any more.
 */
export interface ReadableFile {
  /** In bytes. */
  readonly size: number;
  /** All of it. Rejects when it cannot be read. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The files of a folder, wherever it is: on a disk, chosen in a browser, in a repository. Nothing
 * here writes. Paths are from the top of the folder, with forward slashes. Turning bytes into text
 * is left to whoever reads, so that what is text is the same everywhere.
 */
export interface ReadOnlyFolder {
  /**
   * Every file in it. A link is no file of the folder: what it points at can be anywhere, and
   * browsers do not show links either.
   */
  list(): AsyncIterable<string>;
  /** A file that `list` gave. Rejects when it cannot be read, for example because it went away. */
  file(path: string): Promise<ReadableFile>;
}

/**
 * Lies in a folder for as long as an export is going on. Should it never get to the end, because
 * the disk is full or the page went away, this is what says so to people, and to whatever reads
 * the folder. It is a name in the folder, not words of the editor: every editor has to know it,
 * whatever language it speaks.
 */
export const INCOMPLETE_FILE = "导出未完成.txt";

/** Nobody keeps this many files in a project: this is a whole disk chosen by mistake. */
export const MAX_FOLDER_FILES = 100_000;

/** Folders that belong to tools, see the format. A project can be a Git repository. */
const TOOL_FOLDERS = new Set([".git", ".animaquill", "node_modules"]);

/** Whether a folder of this name belongs to tools, so that nothing in it is read. */
export const isToolFolder = (name: string): boolean => TOOL_FOLDERS.has(name);

/** What systems leave in folders, which is not worth a word to anybody. */
const CLUTTER = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*|[^/]*\.crswap)$/i;

/** What a folder holds besides a project, which nobody needs to hear about. */
export const isNoneOfIt = (path: string) =>
  CLUTTER.test(path) || path.split("/").slice(0, -1).some(isToolFolder);

export type FolderRefusal =
  /** No animaquill.json, at the top or in a folder right inside. */
  | "not-a-project"
  /** None at the top, and several folders right inside have one. */
  | "several-projects"
  /**
   * An export that did not get to the end, see `INCOMPLETE_FILE`, or a project with an empty
   * animaquill.json: that is what is left of it when a page stops while it is written.
   */
  | "incomplete"
  /** More than `MAX_FOLDER_FILES`. */
  | "too-many-files"
  /** A newer format than this editor knows. The problem says which. */
  | "too-new"
  /** animaquill.json cannot be used. The problems say why. */
  | "invalid";

/** The folder cannot be a project. Reading it changed nothing anywhere. */
export class FolderRefused extends Error {
  readonly reason: FolderRefusal;
  readonly problems: readonly Problem[];

  constructor(reason: FolderRefusal, problems: readonly Problem[] = []) {
    super(`Refused: ${reason}`);
    this.reason = reason;
    this.problems = problems;
  }
}

/** What reading a folder finds wrong with a file, apart from what the format says. */
export type FolderProblemCode =
  /** A document that is no UTF-8 text. It would come in damaged. */
  | "not-text"
  /** animaquill.json lists a timeline whose file is not in the folder. */
  | "timeline-not-in-folder"
  /** The entry file of a scene or sound is not there, which is all a link leaves in a browser. */
  | "entry-missing";

/** For tools and logs. The editor says it in words of its own, by the code. */
const FOLDER_PROBLEMS: Readonly<Record<FolderProblemCode, string>> = {
  "not-text": "This is no UTF-8 text",
  "timeline-not-in-folder": "animaquill.json lists this timeline, and the folder does not have it",
  "entry-missing": "This entry file is not in the folder, which is what a link looks like",
};

const folderProblem = (
  severity: Problem["severity"],
  code: FolderProblemCode,
  file: string,
): Problem => ({ severity, code, file, message: FOLDER_PROBLEMS[code] });

/** Whether reading the folder found this, rather than the format, see `FolderProblemCode`. */
export const isFolderProblem = (
  problem: Problem,
): problem is Problem & { readonly code: FolderProblemCode } =>
  Object.hasOwn(FOLDER_PROBLEMS, problem.code);

/** What people lose with a document, by what it is. */
export type LostPart =
  /** `listed`: animaquill.json lists it, so it stays in the project, empty. */
  | { readonly kind: "timeline"; readonly id: string; readonly listed: boolean }
  /** What changes for a language or a format, by the name of its file. */
  | { readonly kind: "override"; readonly timeline: string; readonly version: string }
  | { readonly kind: "scene" | "sound" | "locale"; readonly id: string }
  | { readonly kind: "assets" | "notes" | "libraries" | "lock" }
  /** A document of a kind not named here. */
  | { readonly kind: "other" };

/** A document that cannot be used, so the project can only be had without it. */
export interface LostDocument {
  readonly file: string;
  readonly part: LostPart;
  /** What is wrong with it. */
  readonly problems: readonly Problem[];
}

/** What a folder holds as a project, before any of it went anywhere. */
export interface FolderReading {
  /** What can be used. A timeline that animaquill.json lists is there, if only empty. */
  readonly project: Project;
  /** The text of scene, sound and shared code files. */
  readonly sources: Readonly<Record<string, string>>;
  /** Where the project is: "" for the folder itself, or a folder right inside, as "备份/". */
  readonly root: string;
  /** Every file of the project from its top, apart from what belongs to tools and systems. */
  readonly files: readonly string[];
  /** Files the project has no place for. */
  readonly skipped: readonly string[];
  /** Nothing else is missing: whoever brings the project in decides whether that is all right. */
  readonly lost: readonly LostDocument[];
  readonly warnings: readonly Problem[];
}

export interface ReadFolderOptions {
  readonly signal?: { throwIfAborted(): void };
  /**
   * Says which file it is at, for people to see it go on: the path in the folder while looking for
   * the project, and from the top of the project while reading.
   */
  readonly onFile?: (path: string) => void;
  /** What to call a timeline that comes in empty, for want of a usable one. Its id by default. */
  readonly emptyTimeline?: (id: string) => string;
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
  if (roots.size === 0) throw new FolderRefused("not-a-project");
  if (roots.has("")) return "";
  if (roots.size > 1) throw new FolderRefused("several-projects");
  return [...roots][0] as string;
}

/** Where the project is, and its files. A whole disk is turned down long before the end of it. */
async function listProject(
  folder: ReadOnlyFolder,
  { signal, onFile }: ReadFolderOptions,
): Promise<{ readonly root: string; readonly files: readonly string[] }> {
  const paths = new Set<string>();
  for await (const path of folder.list()) {
    signal?.throwIfAborted();
    if (isNoneOfIt(path)) continue;
    paths.add(path);
    if (paths.size > MAX_FOLDER_FILES) throw new FolderRefused("too-many-files");
    onFile?.(path);
  }
  const root = rootOf(paths);
  const files = [...paths].filter((path) => path.startsWith(root));
  return { root, files: files.map((path) => path.slice(root.length)) };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of a file stays what it is. A file that is no text would come out damaged. */
function textOf(bytes: ArrayBuffer): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

const timelineFile = (id: string) => `timelines/${id}/timeline.json`;

function partOf(file: string, project: Project): LostPart {
  const named = (pattern: RegExp) => pattern.exec(file)?.slice(1) ?? [];
  const [timeline] = named(/^timelines\/([^/]+)\/timeline\.json$/);
  if (timeline !== undefined) {
    return {
      kind: "timeline",
      id: timeline,
      listed: project.manifest.timelines.includes(timeline),
    };
  }
  const [owner, version = ""] = named(/^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/);
  if (owner !== undefined) return { kind: "override", timeline: owner, version };
  const [scene] = named(/^scenes\/([^/]+)\/scene\.json$/);
  if (scene !== undefined) return { kind: "scene", id: scene };
  const [sound] = named(/^sounds\/([^/]+)\/sound\.json$/);
  if (sound !== undefined) return { kind: "sound", id: sound };
  const [language] = named(/^locales\/([^/]+)\.json$/);
  if (language !== undefined) return { kind: "locale", id: language };
  if (file === "assets.json") return { kind: "assets" };
  if (file === "notes.json") return { kind: "notes" };
  if (file === "libraries.json") return { kind: "libraries" };
  if (file === "libraries.lock.json") return { kind: "lock" };
  return { kind: "other" };
}

interface UsablePart {
  readonly project: Project;
  /** What is left to say about the project. */
  readonly warnings: readonly Problem[];
  readonly lost: readonly LostDocument[];
}

/**
 * Finds out what can be used. A document with an error goes, and the rest is read again: taking one
 * out can make the next error show, and what comes out of this has been through all the checks a
 * healthy project goes through. That is why it can be opened, and exported, and read again.
 *
 * A project needs its manifest, and the manifest stays as it is. So a timeline it lists comes in
 * empty, which also keeps whatever refers to it pointing at something.
 */
function readUsablePart(
  texts: Map<string, string>,
  unusable: readonly Problem[],
  emptyTimeline: (id: string) => string,
): UsablePart {
  const lost = new Map<string, Problem[]>();
  const lose = (problem: Problem) => {
    lost.set(problem.file, [...(lost.get(problem.file) ?? []), problem]);
    return texts.delete(problem.file);
  };
  unusable.forEach(lose);

  for (;;) {
    const { project, problems } = readProject(texts);
    const tooNew = problems.find((problem) => problem.code === "format-too-new");
    if (tooNew) throw new FolderRefused("too-new", [tooNew]);
    const errors = problems.filter((problem) => problem.severity === "error");
    if (!project) throw new FolderRefused("invalid", [...[...lost.values()].flat(), ...errors]);
    if (errors.length === 0) {
      const documents = [...lost].map(([file, reasons]) => ({
        file,
        part: partOf(file, project),
        problems: reasons,
      }));
      // An import says what reading drops without a word, which opening a project does not.
      const retired = [...texts].flatMap(([file, text]) => retiredFadesIn(file, text) ?? []);
      return { project, warnings: [...problems, ...retired], lost: documents };
    }

    let changed = false;
    // What the manifest says about a timeline is taken care of below, and it has nothing else.
    for (const error of errors) {
      if (error.file !== MANIFEST_FILE) changed = lose(error) || changed;
    }
    for (const id of project.manifest.timelines) {
      const file = timelineFile(id);
      if (texts.has(file)) continue;
      if (!lost.has(file)) lost.set(file, [folderProblem("error", "timeline-not-in-folder", file)]);
      texts.set(file, stringifyDocument(createTimeline(emptyTimeline(id))));
      changed = true;
    }
    // Reading again would only find the same.
    if (!changed) throw new FolderRefused("invalid", errors);
  }
}

/**
 * Finds out what a folder holds and whether it can be a project, without writing anything. What
 * makes the whole folder useless is refused. A document that is broken only costs that document,
 * and `lost` says which: whoever brings the project in has to decide whether that is all right,
 * because a project with a part missing looks like what people had.
 *
 * Documents are read whatever their size: they are what makes a project, and all of it is in memory
 * while it is open anyway. A code file larger than `MAX_SOURCE_BYTES` is not what it claims to be,
 * such as a video, and stays out unread.
 */
export async function readFolder(
  folder: ReadOnlyFolder,
  options: ReadFolderOptions = {},
): Promise<FolderReading> {
  const { signal, onFile, emptyTimeline = (id: string) => id } = options;
  const { root, files } = await listProject(folder, options);
  if (files.includes(INCOMPLETE_FILE)) throw new FolderRefused("incomplete");

  const texts = new Map<string, string>();
  const unusable: Problem[] = [];
  const skipped = new Set<string>();
  for (const path of files) {
    const isDocument = documentSchema(path) !== undefined;
    if (!isDocument && !isSourceFile(path)) {
      skipped.add(path);
      continue;
    }
    signal?.throwIfAborted();
    onFile?.(path);
    const file = await folder.file(`${root}${path}`);
    if (path === MANIFEST_FILE && file.size === 0) throw new FolderRefused("incomplete");
    if (!isDocument && file.size > MAX_SOURCE_BYTES) {
      skipped.add(path);
      continue;
    }
    const text = textOf(await file.arrayBuffer());
    if (text === undefined) {
      if (isDocument) unusable.push(folderProblem("error", "not-text", path));
      else skipped.add(path);
      continue;
    }
    // Editors on Windows like to put a byte order mark in front, which JSON does not allow.
    texts.set(path, isDocument ? text.replace(/^\uFEFF/, "") : text);
  }

  const { project, warnings, lost } = readUsablePart(texts, unusable, emptyTimeline);

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
    root,
    files,
    skipped: [...skipped].toSorted(),
    lost,
    warnings: [
      ...warnings,
      ...withoutEntry.map((file) => folderProblem("warning", "entry-missing", file)),
    ],
  };
}
