import { MANIFEST_FILE, documentSchema } from "@animaquill/schema";
import { isSourceFile } from "./import-file.ts";
import { isNoneOfIt, isToolFolder } from "./read-folder.ts";

/**
 * Which files of a folder, or of a repository, are the project's, as the format has them: its
 * documents, and the code of its scenes and sounds. The editor reads, writes and takes away only
 * these, and so does a platform that saves projects to Git; everything else stays as it is: notes,
 * a README, .git, what belongs to tools. Media files of assets are not among them.
 */
export const isDocument = (path: string): boolean => documentSchema(path) !== undefined;

export const isProjectFile = (path: string): boolean =>
  !isNoneOfIt(path) && (isDocument(path) || isSourceFile(path));

/** The folders at the top of a project that can have its files in them. */
export const PROJECT_FOLDERS: readonly string[] = [
  "timelines",
  "scenes",
  "sounds",
  "code",
  "locales",
];

const PROJECT_FOLDER = new RegExp(`^(?:${PROJECT_FOLDERS.join("|")})(?:/|$)`);

/** Whether a folder, by its path from the top of the project, can have files of the project in it. */
export const isProjectFolder = (path: string): boolean =>
  PROJECT_FOLDER.test(path) && !path.split("/").some(isToolFolder);

/**
 * In which turn a file gets written: what others refer to first, so that a program that reads the
 * folder in the middle sees at most a reference that is not there yet. Code, assets, libraries and
 * strings, then what scenes and sounds are, then timelines, then their versions and the notes on
 * them, and animaquill.json last. Taking files away goes the other way round.
 */
export function writeRank(path: string): number {
  if (path === MANIFEST_FILE) return 4;
  if (path === "notes.json" || /^timelines\/[^/]+\/overrides\//.test(path)) return 3;
  if (/^timelines\/[^/]+\/timeline\.json$/.test(path)) return 2;
  if (/^(?:scenes|sounds)\/[^/]+\/(?:scene|sound)\.json$/.test(path)) return 1;
  return 0;
}

/** Files in turns, see `writeRank`: each turn is a list of paths that can go at the same time. */
export function inRanks(paths: Iterable<string>, reverse = false): string[][] {
  const ranks = new Map<number, string[]>();
  for (const path of paths) {
    const rank = writeRank(path);
    ranks.set(rank, [...(ranks.get(rank) ?? []), path]);
  }
  const order = [...ranks.keys()].toSorted((a, b) => (reverse ? b - a : a - b));
  return order.map((rank) => (ranks.get(rank) ?? []).toSorted());
}
