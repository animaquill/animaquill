import { isNoneOfIt, isProjectFile, isToolFolder } from "@animaquill/core";
import { lfsPointer, type LfsObjectId } from "@animaquill/schema";
import { blobShaOf, bytesOf, type TreeChange, type TreeEntry } from "./repo-host.ts";

/**
 * The pointers of Git LFS that an archive writes, as rules on their own: for each asset of the
 * project in Git LFS of this repository (as the files have it, see `here` in exporter.ts), its
 * pointer at its path, and a line for that path in the section of .gitattributes that is the
 * platform's. Never a pointer to an object the storage is not known to have (`lfs_objects`): such
 * an asset is named instead, and so is one whose path is a file of the format, belongs to Git or a
 * tool, or where a file of people's, or a folder, is.
 *
 * Which pointers are the platform's to write over and take away, once their asset went back to
 * another place, got another path, or is gone: those at the paths it noted (`lfs_paths`) or that
 * have their line in its section of the parent's .gitattributes, and only while the file there is
 * a pointer to an object the storage is known to have, as every pointer is that the platform wrote.
 * What the database says alone is not enough: it can be older than the repository, as after it came
 * back from a backup, and a file of people's can be where a pointer was then. Anything else at such
 * a path is people's: it stays, and is named. Nothing else is touched.
 *
 * A pointer is only what Git LFS takes it for with its line: where the section cannot be written
 * (`frozen`), no pointer comes or goes, and those that are there stay.
 */

/** An asset in Git LFS, with what its pointer is made of: oid (SHA-256, lower-case hex) and size. */
export interface LfsAsset {
  readonly path: string;
  readonly oid: string;
  readonly size: number;
}

/** The attributes a pointer's line gives its path: Git LFS's own. */
const LFS_ATTRIBUTES = "filter=lfs diff=lfs merge=lfs -text";
/** What stands for a space in a pattern, as a space parts the pattern from the attributes. */
const SPACE = "[[:space:]]";

/**
 * A path as a pattern of .gitattributes that matches it: from the top (a leading "/", or it would
 * match a file of that name in every folder too), each space as `[[:space:]]` (a space parts the
 * pattern from the attributes), `*?[\#!"` with a backslash, everything else as it is, Chinese
 * included. To Git, `[[:space:]]` is a space, a tab, a line feed or a carriage return, and nothing
 * else: a vertical tab and a form feed are written as they are, and a path with a tab or a line
 * break in it cannot have a line that is its own: undefined. The line of a path with a space also
 * matches the same name with one of those in its place, see `spaced`.
 */
export function attributesPattern(path: string): string | undefined {
  if (/[\t\r\n]/.test(path)) return undefined;
  let pattern = "/";
  for (const char of path) {
    if (char === " ") pattern += SPACE;
    else if ('*?[\\#!"'.includes(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  return pattern;
}

/**
 * Git reads no line of .gitattributes of this many bytes or more (`ATTR_MAX_LINE_LENGTH` of Git):
 * it warns, and the path is not a pointer to it.
 */
export const ATTRIBUTES_LINE_MOST = 2048;

/**
 * The line of the section of .gitattributes for the pointer at a path, or undefined where Git would
 * not read it, as for a path so long that the line has `ATTRIBUTES_LINE_MOST` bytes or more: such a
 * path has no pointer, as one with a tab in it.
 */
export const attributesLine = (path: string): string | undefined => {
  const pattern = attributesPattern(path);
  if (pattern === undefined) return undefined;
  const line = `${pattern} ${LFS_ATTRIBUTES}`;
  return Buffer.byteLength(line, "utf8") >= ATTRIBUTES_LINE_MOST ? undefined : line;
};

/**
 * The path a line of the section is for, or undefined for a line that the platform does not write:
 * what people put between our two lines is not ours to go by.
 */
export function pathOfAttributesLine(line: string): string | undefined {
  const end = ` ${LFS_ATTRIBUTES}`;
  if (!line.startsWith("/") || !line.endsWith(end)) return undefined;
  const pattern = line.slice(1, -end.length);
  let path = "";
  for (let at = 0; at < pattern.length;) {
    if (pattern.startsWith(SPACE, at)) {
      path += " ";
      at += SPACE.length;
    } else if (pattern[at] === "\\") {
      if (at + 1 >= pattern.length) return undefined;
      path += pattern[at + 1];
      at += 2;
    } else {
      path += pattern[at];
      at += 1;
    }
  }
  return path !== "" && attributesLine(path) === line ? path : undefined;
}

/**
 * A path as its line matches it: the line of "a b" also takes a file whose name has a tab, a line
 * feed or a carriage return where that one has its space. Two paths that are the same here cannot
 * have a line each.
 */
export const spaced = (path: string): string => path.replace(/[\t\r\n]/g, " ");

/** The pointer file of an object, as Git LFS writes it. */
export const pointerText = (oid: string, size: number): string | undefined =>
  lfsPointer(`sha256-${oid}`, size);

/**
 * Whether a pointer may be at a path: not a file of the format (the documents and the code are the
 * editor's), nor anything of Git (.git, .github, .gitattributes, .gitignore…), of Git LFS (its
 * settings, .lfsconfig at the top) or of tools, whatever the case of the letters, as some disks
 * take them for the same, nor what .gitattributes cannot name, or names in a line Git does not read.
 */
export function isPointerPath(path: string): boolean {
  if (attributesLine(path) === undefined || isProjectFile(path) || isNoneOfIt(path)) return false;
  if (path.toLowerCase() === ".lfsconfig") return false;
  return !path
    .split("/")
    .some((part) => part.toLowerCase().startsWith(".git") || isToolFolder(part));
}

/** The folders a path is in: "a", "a/b" for "a/b/c". */
const foldersOf = (path: string): string[] => {
  const folders: string[] = [];
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
    folders.push(path.slice(0, at));
  return folders;
};

/** The folders at the top that pointers at these paths are in, which a listing of the tree needs. */
export const topFoldersOf = (paths: Iterable<string>): Set<string> => {
  const tops = new Set<string>();
  for (const path of paths) {
    const at = path.indexOf("/");
    if (at > 0) tops.add(path.slice(0, at));
  }
  return tops;
};

export interface PointerInput {
  /**
   * The assets of the project in Git LFS of this repository. Undefined where assets.json could not
   * be written as it is: the pointers stay as they are, with the assets.json the parent has.
   */
  readonly assets: readonly LfsAsset[] | undefined;
  /** What the storage of the repository is known to have: size by oid, see `lfs_objects`. */
  readonly stored: ReadonlyMap<string, number>;
  /**
   * Objects the storage could not be asked about now, by oid: what points at one of them is left
   * as it is, neither the platform's to change nor people's for good.
   */
  readonly unknown?: ReadonlySet<string>;
  /**
   * The paths where a pointer could be the platform's: those it noted (`lfs_paths`), and those
   * with a line in its section of the parent's .gitattributes.
   */
  readonly ours: ReadonlySet<string>;
  /**
   * What the files at the paths of `ours` point at, for those that are pointers of Git LFS: a file
   * there that is none is people's.
   */
  readonly pointers: ReadonlyMap<string, LfsObjectId>;
  /** The files of the parent's tree where it was listed, by path, and its folders there. */
  readonly files: ReadonlyMap<string, TreeEntry>;
  readonly folders: ReadonlySet<string>;
  /** The files of the project that the parent has or the archive writes: no pointer goes there. */
  readonly projectFiles: ReadonlySet<string>;
  /**
   * The section of .gitattributes cannot be written, as where our two lines in it are not one pair:
   * a pointer without its line is the file itself to Git, so none is written, and those that are
   * there stay, as their lines cannot be taken away either.
   */
  readonly frozen?: boolean;
  /**
   * Paths of `ours` that people chose the project over (“以编辑器的内容接着存”, `replace`) on this
   * very parent: whatever file is there now is the platform's to write over or take away, as it
   * would be its own pointer.
   */
  readonly confirmed?: ReadonlySet<string>;
}

export interface PointerPlan {
  /** Pointers written, and pointers taken away. */
  readonly changes: readonly TreeChange[];
  readonly written: number;
  readonly removed: number;
  /**
   * Paths of assets in Git LFS whose pointer is not written, and paths the platform noted as its
   * pointers where a file of people's is now, see `planPointers`.
   */
  readonly kept: readonly string[];
  /** The pointers that are the platform's after the archive, for `lfs_paths`: sorted. */
  readonly paths: readonly string[];
  /** The lines of the section of .gitattributes, one for each of `paths`, in their order. */
  readonly section: readonly string[];
}

/** What an archive does with the pointers of Git LFS on top of its parent, see the top of this file. */
export function planPointers(input: PointerInput): PointerPlan {
  const { files, folders, ours, projectFiles, stored } = input;
  const unknown = input.unknown ?? new Set<string>();
  const frozen = input.frozen === true;
  const kept = new Set<string>();
  const paths = new Set<string>();
  const changes: TreeChange[] = [];
  let written = 0;
  let removed = 0;

  /**
   * What is at a path where a pointer could be the platform's: "ours", a pointer to an object the
   * storage is known to have; "undecided", one to an object it could not be asked about; "theirs",
   * any other file; "none", no file at all (nothing, a link, a submodule).
   */
  const standing = (path: string): "ours" | "undecided" | "theirs" | "none" => {
    const entry = files.get(path);
    if (!entry || entry.type !== "blob" || entry.mode === "120000") return "none";
    if (ours.has(path) && input.confirmed?.has(path)) return "ours";
    const pointer = ours.has(path) ? input.pointers.get(path) : undefined;
    if (!pointer) return "theirs";
    if (stored.get(pointer.oid) === pointer.size) return "ours";
    return unknown.has(pointer.oid) ? "undecided" : "theirs";
  };

  if (input.assets === undefined) {
    for (const path of ours) {
      const there = standing(path);
      if (there === "ours" || there === "undecided") paths.add(path);
    }
    return finish();
  }

  // The names in the parent that a line with a space in it would take along, see `spaced`.
  const alike = new Set<string>();
  for (const path of files.keys()) if (/[\t\r\n]/.test(path)) alike.add(spaced(path));

  // One pointer for a path: two assets there with different files leave it as it is.
  const byPath = new Map<string, LfsAsset[]>();
  for (const asset of input.assets)
    byPath.set(asset.path, [...(byPath.get(asset.path) ?? []), asset]);
  const wanted = new Map<string, string>();
  for (const [path, assets] of [...byPath].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const [first] = assets as [LfsAsset];
    const text = pointerText(first.oid, first.size);
    const same = assets.every(({ oid, size }) => oid === first.oid && size === first.size);
    // Never a pointer to an object the storage is not known to have.
    const isStored = stored.get(first.oid) === first.size && first.size > 0;
    if (
      !isPointerPath(path) ||
      projectFiles.has(path) ||
      alike.has(path) ||
      !same ||
      !isStored ||
      !text
    ) {
      kept.add(path);
      continue;
    }
    wanted.set(path, text);
  }

  // A pointer where a folder is, or in a folder that is a file, takes nobody's place.
  const projectFolders = new Set([...projectFiles].flatMap(foldersOf));
  const wantedFolders = new Set([...wanted.keys()].flatMap(foldersOf));
  const clashes = (path: string) =>
    folders.has(path) ||
    projectFolders.has(path) ||
    wantedFolders.has(path) ||
    foldersOf(path).some((folder) => files.has(folder) || projectFiles.has(folder));

  for (const [path, text] of wanted) {
    const entry = files.get(path);
    if (clashes(path) || (entry && (entry.type !== "blob" || entry.mode === "120000"))) {
      kept.add(path);
      continue;
    }
    if (entry?.sha === blobShaOf(bytesOf(text))) {
      // As it is to be. Without its line it is the platform's all the same, as after the database
      // came back from a backup and the section went with an archive of then: the very pointer it
      // would write, to an object the storage has. It gets its line again, where the section can
      // be written; where not, it is named.
      if (ours.has(path) || !frozen) paths.add(path);
      else kept.add(path);
      continue;
    }
    const there = standing(path);
    if (entry && there !== "ours") {
      // A file of people's, or one that cannot be told from one now: not the platform's to write
      // over.
      kept.add(path);
      if (there === "undecided") paths.add(path);
      continue;
    }
    if (frozen) {
      kept.add(path);
      if (entry) paths.add(path);
      continue;
    }
    changes.push({ path, text });
    paths.add(path);
    written += 1;
  }

  for (const path of ours) {
    if (paths.has(path)) continue;
    const there = standing(path);
    if (there === "none") continue;
    // Now a file of the project's, which the documents take care of.
    if (isProjectFile(path) || projectFiles.has(path)) continue;
    if (there === "theirs") {
      // A file of people's where a pointer of the platform's was: it stays, and is named.
      kept.add(path);
      continue;
    }
    // It stays where it cannot be told whose it is, where its line cannot go, or where its asset is
    // still in Git LFS but its pointer cannot be written now.
    if (there === "undecided" || frozen || (byPath.has(path) && kept.has(path))) {
      paths.add(path);
      continue;
    }
    changes.push({ path, remove: true });
    removed += 1;
  }
  return finish();

  function finish(): PointerPlan {
    const sorted = [...paths].toSorted((a, b) => (a < b ? -1 : 1));
    return {
      changes,
      written,
      removed,
      kept: [...kept].toSorted((a, b) => (a < b ? -1 : 1)),
      paths: sorted,
      section: sorted.flatMap((path) => attributesLine(path) ?? []),
    };
  }
}
