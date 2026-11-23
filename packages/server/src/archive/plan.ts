import {
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_START,
  MAX_SOURCE_BYTES,
  isDocument,
  isProjectFile,
} from "@animaquill/core";
import { MANIFEST_FILE } from "@animaquill/schema";
import type { TreeChange, TreeEntry } from "./repo-host.ts";

/**
 * What an archive writes into a repository, as rules on their own: only three kinds of paths are
 * the platform's, and everything else stays as it is.
 *
 * 1. The documents and code of the format, `isProjectFile`: as the project has them, written where
 *    they differ from the parent, taken away where the project does not have them any more.
 * 2. Pointers of large files the platform wrote (step 14.2), see pointers.ts.
 * 3. The section of .gitattributes between two lines of ours.
 *
 * A README, .github/, media people committed themselves, a submodule, and .animaquill/ are never
 * written or taken away. AGENTS.md is a file of the project, and people often keep one of their own
 * in a repository before it holds a project: it is never taken away, and the opening a new project
 * starts it with (`INSTRUCTIONS_START`) does not go over one that is there. What people wrote into
 * it in the project is written, as any file of the project. Neither is a file in a folder of the format that the editor could
 * never have had: one that is no UTF-8, or larger than code may be (`MAX_SOURCE_BYTES`), as the
 * editor leaves those out when it reads a folder. A document the project cannot write as it is
 * (`exportFiles` says `invalid-state`) keeps what the parent has, or stays out where the parent has
 * none, and is named in the archive (`kept`).
 */

/** The first and last line of the section of .gitattributes that is the platform's. */
export const ATTRIBUTES_START = "# AnimaQuill: begin (written by AnimaQuill, do not edit)";
export const ATTRIBUTES_END = "# AnimaQuill: end";
export const ATTRIBUTES_FILE = ".gitattributes";

/**
 * What a tree has at .gitattributes where that is not a file of text: a link, a submodule or a
 * folder. Not ours to read, nor to write over: as where our two lines in it are not one pair.
 */
export const NOT_TEXT: unique symbol = Symbol("not a file of text");
/** .gitattributes as a tree has it: its text, nothing at all, or `NOT_TEXT`. */
export type AttributesText = string | undefined | typeof NOT_TEXT;

/** What the pointers of large files of an archive change, see `planPointers`: nothing by default. */
export interface PointerChanges {
  readonly changes: readonly TreeChange[];
  readonly written: number;
  readonly removed: number;
  readonly kept: readonly string[];
}

const NO_POINTERS: PointerChanges = { changes: [], written: 0, removed: 0, kept: [] };

/** What a new repository starts with: its first commit, see 3.1.3 "空仓库". */
export const INITIAL_ATTRIBUTES = [
  "# 这个仓库由 AnimaQuill 存档：项目的文档和代码。素材放在哪由每个素材自己决定。",
  "# AnimaQuill only writes between the two lines below; the rest of this file is yours.",
  ATTRIBUTES_START,
  ATTRIBUTES_END,
  "",
].join("\n");

/** The lines of a text, each with its own end, "\n" or "\r\n": the last one can have none. */
const linesOf = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/));
const bare = (line: string) => line.replace(/\r?\n$/, "");

/**
 * Where our two lines are. Only one of each, the first before the last, is a section of ours:
 * anything else (one without the other, the other way round, two of either) is people's doing,
 * and where their lines and ours begin and end cannot be told.
 */
const markersOf = (
  lines: readonly string[],
): { kind: "none" } | { kind: "pair"; start: number; end: number } | { kind: "broken" } => {
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (bare(line) === ATTRIBUTES_START) starts.push(index);
    else if (bare(line) === ATTRIBUTES_END) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  const [start] = starts;
  const [end] = ends;
  if (starts.length === 1 && ends.length === 1 && (start as number) < (end as number))
    return { kind: "pair", start: start as number, end: end as number };
  return { kind: "broken" };
};

/**
 * The lines between the two of ours: none where there are neither, and undefined where they are not
 * one pair in order, see `markersOf`, or where .gitattributes is no file of text, see `NOT_TEXT`.
 */
export function attributesSection(text: AttributesText): string[] | undefined {
  if (text === NOT_TEXT) return undefined;
  if (text === undefined) return [];
  const lines = linesOf(text);
  const markers = markersOf(lines);
  if (markers.kind === "none") return [];
  if (markers.kind === "broken") return undefined;
  return lines
    .slice(markers.start + 1, markers.end)
    .map(bare)
    .filter((line) => line.trim() !== "");
}

/**
 * The file with these lines in our section, and the rest of it as it was, to the line endings: ours
 * at its end where it has none. Undefined where our lines are not one pair in order, which is not
 * ours to mend, see `markersOf`, or where a link or the like is in its place, see `NOT_TEXT`.
 */
export function withAttributesSection(
  text: AttributesText,
  section: readonly string[],
): string | undefined {
  if (text === NOT_TEXT) return undefined;
  const lines = linesOf(text ?? "");
  const markers = markersOf(lines);
  if (markers.kind === "broken") return undefined;
  if (markers.kind === "pair") {
    const eol = (lines[markers.start] as string).endsWith("\r\n") ? "\r\n" : "\n";
    return [
      ...lines.slice(0, markers.start + 1),
      ...section.map((line) => `${line}${eol}`),
      ...lines.slice(markers.end),
    ].join("");
  }
  const eol = lines.some((line) => line.endsWith("\r\n")) ? "\r\n" : "\n";
  const last = lines.at(-1);
  const before =
    last !== undefined && !last.endsWith("\n") ? [...lines.slice(0, -1), `${last}${eol}`] : lines;
  return [
    ...before,
    `${ATTRIBUTES_START}${eol}`,
    ...section.map((line) => `${line}${eol}`),
    `${ATTRIBUTES_END}${eol}`,
  ].join("");
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/** A file of the project as the archive has it: its text, and the SHA-1 Git names it by. */
export interface ExportedFile {
  readonly text: string;
  readonly sha: string;
}

export interface Exported {
  /** The files of the project, by path: documents and code. */
  readonly files: ReadonlyMap<string, ExportedFile>;
  /** Documents `exportFiles` could not write as the project has them now. */
  readonly invalid: ReadonlySet<string>;
}

/** The entries of a tree that could be the platform's: at paths of project files, and .gitattributes. */
export function managedEntries(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  const managed = new Map<string, TreeEntry>();
  for (const entry of entries) {
    if (entry.type === "tree") continue;
    if (entry.path === ATTRIBUTES_FILE || isProjectFile(entry.path)) managed.set(entry.path, entry);
  }
  return managed;
}

/**
 * Whether a file of a tree could be the editor's, so that the platform may write over it or take it
 * away: a document, or code the editor reads, which `text` says from its content. Undefined where
 * that needs a look at the content (`text` has nothing for its blob).
 */
export function isEditorsFile(
  path: string,
  entry: TreeEntry | undefined,
  text: ReadonlyMap<string, boolean>,
): boolean | undefined {
  if (!entry || entry.type !== "blob" || entry.mode === "120000") return false;
  if (isDocument(path)) return true;
  if (!isProjectFile(path)) return false;
  if (entry.size !== undefined && entry.size > MAX_SOURCE_BYTES) return false;
  return text.get(entry.sha);
}

/** Blobs whose content decides `isEditorsFile` for these paths. */
export function blobsToLookAt(
  paths: Iterable<string>,
  ...trees: readonly ReadonlyMap<string, TreeEntry>[]
): Set<string> {
  const wanted = new Set<string>();
  for (const path of paths) {
    for (const tree of trees) {
      const entry = tree.get(path);
      if (entry && isEditorsFile(path, entry, new Map()) === undefined) wanted.add(entry.sha);
    }
  }
  return wanted;
}

/** Whether these bytes are text the editor reads: UTF-8. */
export function isText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files that changed between two trees, of those that are the platform's: what the project has
 * on one side or the other, and our section of .gitattributes. Files of others, such as a README or
 * a picture in a scene's folder, may change as they like. `attributes` has the text of either
 * .gitattributes where it differs.
 */
export function differingFiles(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  text: ReadonlyMap<string, boolean>,
  attributes: { readonly before?: AttributesText; readonly after?: AttributesText } = {},
): string[] {
  const differ: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path);
    const now = after.get(path);
    if (was?.sha === now?.sha && was?.mode === now?.mode) continue;
    if (path === ATTRIBUTES_FILE) {
      const old = attributesSection(was ? attributes.before : undefined);
      const fresh = attributesSection(now ? attributes.after : undefined);
      // Our lines not one pair, or a link where the file was: nothing there is ours to read, so
      // nothing of ours changed. An archive leaves it as it is and says so, see `planArchive`.
      if (old !== undefined && fresh !== undefined && !sameLines(old, fresh)) differ.push(path);
      continue;
    }
    // Unknown counts as the editor's: where it cannot be told, the archive stops rather than writes.
    if (isEditorsFile(path, was, text) !== false || isEditorsFile(path, now, text) !== false)
      differ.push(path);
  }
  return differ.toSorted();
}

export interface ArchivePlan {
  /** What goes into the tree: files written, and files taken away. */
  readonly changes: readonly TreeChange[];
  readonly changed: number;
  readonly removed: number;
  /**
   * What the archive could not write as the project has it: documents the project cannot write now,
   * files of the project that would take the place of a file or folder the tree keeps, and
   * .gitattributes where our lines in it are not one pair, or where it is no file of text. The
   * parent's version stays, if any.
   */
  readonly kept: readonly string[];
  /** animaquill.json is not what the format says: nothing may be archived. */
  readonly manifestInvalid: boolean;
}

/**
 * What an archive changes on top of its parent. `parent` is what `managedEntries` found in the
 * parent's tree, and `text` what `isEditorsFile` needs to know about its blobs (see
 * `blobsToLookAt`); `attributes` the parent's .gitattributes, and the lines our section is to have.
 */
export function planArchive(
  exported: Exported,
  parent: ReadonlyMap<string, TreeEntry>,
  text: ReadonlyMap<string, boolean>,
  attributes: { readonly text?: AttributesText; readonly section: readonly string[] } = {
    section: [],
  },
  /**
   * Every other file of the parts of the parent's tree that were listed, and "<name>/" for a folder
   * that was not: they stay as they are.
   */
  others: ReadonlySet<string> = new Set(),
  /** The pointers of large files, which go into the tree with the rest, see pointers.ts. */
  pointers: PointerChanges = NO_POINTERS,
): ArchivePlan {
  const kept = new Set([...exported.invalid].filter(isProjectFile));
  const writes: { path: string; text: string }[] = [];
  for (const [path, file] of [...exported.files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isProjectFile(path) || exported.invalid.has(path)) continue;
    const before = parent.get(path);
    // Something the editor never makes, a submodule or a link, is not written over.
    if (before && (before.type !== "blob" || before.mode === "120000")) {
      kept.add(path);
      continue;
    }
    if (before?.sha === file.sha) continue;
    // The opening alone says nothing that people's own instructions for AI do not have.
    if (path === INSTRUCTIONS_FILE && before && file.text === INSTRUCTIONS_START) continue;
    writes.push({ path, text: file.text });
  }
  const removes: string[] = [];
  for (const [path, entry] of [...parent].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (path === ATTRIBUTES_FILE || path === MANIFEST_FILE || path === INSTRUCTIONS_FILE) continue;
    if (exported.files.has(path) || exported.invalid.has(path)) continue;
    if (isEditorsFile(path, entry, text) !== true) continue;
    removes.push(path);
  }

  // A file where the tree keeps a folder, or under a file it keeps, would take the place of what is
  // there: not ours to take. Such a file of the project is not written, and is named.
  const gone = new Set([
    ...removes,
    ...pointers.changes.flatMap((change) => ("remove" in change ? [change.path] : [])),
  ]);
  const files = new Set(
    [
      ...parent.keys(),
      ...others,
      ...writes.map(({ path }) => path),
      ...pointers.changes.flatMap((change) => ("remove" in change ? [] : [change.path])),
    ].filter((path) => !gone.has(path)),
  );
  const folders = new Set<string>();
  for (const path of files) {
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
      folders.add(path.slice(0, at));
  }
  const clashes = (path: string) => {
    if (folders.has(path)) return true;
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
      if (files.has(path.slice(0, at))) return true;
    return false;
  };
  const changes: TreeChange[] = [];
  for (const write of writes) {
    if (clashes(write.path)) kept.add(write.path);
    else changes.push(write);
  }
  let changed = changes.length + pointers.written;
  for (const path of removes) changes.push({ path, remove: true });
  changes.push(...pointers.changes);
  for (const path of pointers.kept) kept.add(path);

  const attributesNow = attributesSection(attributes.text);
  if (attributesNow === undefined) {
    // Our two lines are not one pair in it: where people's lines end cannot be told, so the file
    // stays as people have it, and is named. The same for a link, a submodule or a folder there.
    // No pointer comes or goes with it, see `frozen` of `planPointers`.
    kept.add(ATTRIBUTES_FILE);
  } else if (
    !sameLines(attributesNow, attributes.section) &&
    (parent.has(ATTRIBUTES_FILE) || attributes.section.length > 0)
  ) {
    const next = withAttributesSection(attributes.text, attributes.section);
    if (next !== undefined) {
      changes.push({ path: ATTRIBUTES_FILE, text: next });
      changed += 1;
    }
  }
  return {
    changes,
    changed,
    removed: removes.length + pointers.removed,
    kept: [...kept].toSorted(),
    manifestInvalid: exported.invalid.has(MANIFEST_FILE) || !exported.files.has(MANIFEST_FILE),
  };
}

/** How many names of files a commit message lists at most. */
const MOST_NAMED = 20;

/**
 * The message of an archive's commit: what it is, what it changed and what it could not, and two
 * lines at the end that tell the platform its own commits apart, see `trailersOf`.
 */
export function commitMessage(archive: {
  readonly kind: string;
  readonly changed: number;
  readonly removed: number;
  readonly kept: readonly string[];
  readonly project: string;
  readonly seq: number;
}): string {
  const title =
    archive.kind === "auto"
      ? "自动存档"
      : archive.kind === "merge"
        ? "存档（合并了 GitHub 上的改动）"
        : archive.kind === "before-merge"
          ? "合并前的存档"
          : "存档";
  const said: string[] = [];
  if (archive.changed > 0 && archive.removed > 0)
    said.push(`改了 ${archive.changed} 个文件，删了 ${archive.removed} 个文件。`);
  else if (archive.changed > 0) said.push(`改了 ${archive.changed} 个文件。`);
  else if (archive.removed > 0) said.push(`删了 ${archive.removed} 个文件。`);
  if (archive.kept.length > 0) {
    const named = archive.kept.slice(0, MOST_NAMED).join("、");
    const more = archive.kept.length > MOST_NAMED ? ` 等 ${archive.kept.length} 个` : "";
    said.push(`这些文件这次没存进去，仓库里还是上一版：${named}${more}。`);
  }
  return [
    title,
    "",
    ...(said.length > 0 ? [said.join("\n"), ""] : []),
    `AnimaQuill-Project: ${archive.project}`,
    `AnimaQuill-Seq: ${archive.seq}`,
    "",
  ].join("\n");
}

/**
 * Which project and update a commit says it archived, in its last two lines. A known limit: anyone
 * who can push to the repository can write these lines too, and a commit made to look like a newer
 * archive of the project is then taken for the platform's own (see `isOurs` in archiver.ts), so what
 * it changed in the project's files is written over without asking. It takes write access to the
 * repository, which is its owner's, so it is left at that.
 */
export function trailersOf(message: string): { project: string; seq: number } | undefined {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  const project = /^AnimaQuill-Project: (\S+)$/m.exec(last)?.[1];
  const seq = /^AnimaQuill-Seq: (\d+)$/m.exec(last)?.[1];
  if (project === undefined || seq === undefined) return undefined;
  return { project, seq: Number(seq) };
}
