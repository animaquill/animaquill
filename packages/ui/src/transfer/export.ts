import {
  INCOMPLETE_FILE,
  MAX_SOURCE_BYTES,
  isSourceFile,
  placedAsset,
  type ProjectStore,
} from "@animaquill/core";
import type { MediaStore, TargetFolder } from "@animaquill/host";
import { hashFile, isSameHash } from "@animaquill/media";
import { MANIFEST_FILE, readProject, type Problem } from "@animaquill/schema";
import { elsewhereFile, type ElsewhereFile } from "../storage/places.ts";

/**
 * Lies in a folder for as long as an export is going on, and reading a folder knows it: should the
 * export never get to the end, the folder is not taken for a project.
 */
export { INCOMPLETE_FILE };

/** How far moving a project has got. */
export interface TransferStep {
  /** What it is working on, in words that mean something to people. */
  readonly file: string;
  /** In bytes. Without a total nobody knows how much there is to do yet. */
  readonly done: number;
  readonly total: number;
}

export interface ExportOptions {
  /** What the file that marks an unfinished export says. */
  readonly notice: string;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: TransferStep) => void;
}

/** What people have to know about a folder that is finished. */
export interface ExportReport {
  /** Assets whose files this host does not have, so they are not in the folder. */
  readonly missing: readonly string[];
  /** Of those, the ones that can come from where they are kept, see `elsewhereFile`. */
  readonly elsewhere: readonly ElsewhereFile[];
  /** Files left out because their path is the path of something else, at least on some disks. */
  readonly clashing: readonly string[];
  /** Files left out because a file cannot have that path here. */
  readonly refused: readonly string[];
  /** Files that are in the folder, but will not come back in. */
  readonly tooLarge: readonly string[];
  /** What keeps parts of the project from being written, or from being read again. */
  readonly problems: readonly Problem[];
}

/** A file on its way out. */
interface Copy {
  readonly path: string;
  readonly file: Blob;
  readonly label: string;
  /** The hash of an asset. It is known without reading the file. */
  readonly hash?: string;
}

/** Whether two paths are the same file on some disk, where case does not make a difference. */
const samePathKey = (path: string) => path.normalize("NFC").toLowerCase();

/**
 * Writes a project to a new folder. A folder only is a project when it has `animaquill.json`, so
 * that file comes last: stopped at any point, what is left cannot be taken for a backup.
 */
export async function exportProject(
  store: ProjectStore,
  media: MediaStore,
  target: TargetFolder,
  { notice, signal, onStep }: ExportOptions,
): Promise<ExportReport> {
  // One moment in time: what happens to the project from here on is not part of this export.
  const { files, problems } = store.exportFiles();
  const state = store.getState();
  const { assets = {} } = state;

  /** What goes where. On some disks a second file would quietly replace the first. */
  const places = new Map<string, Copy | undefined>(
    [MANIFEST_FILE, INCOMPLETE_FILE].map((path) => [samePathKey(path), undefined]),
  );
  const clashing: string[] = [];
  const documents: Copy[] = [];
  for (const [path, text] of files) {
    if (path === MANIFEST_FILE) continue;
    const place = samePathKey(path);
    if (places.has(place)) clashing.push(path);
    else {
      const copy = { path, file: new Blob([text]), label: path };
      places.set(place, copy);
      documents.push(copy);
    }
  }

  const missing: string[] = [];
  const elsewhere: ElsewhereFile[] = [];
  const copies: Copy[] = [];
  for (const [id, asset] of Object.entries(assets)) {
    const label = asset.name ?? asset.path ?? id;
    const place = samePathKey(asset.path ?? id);
    const other = places.get(place);
    // Two entries for one file are nothing to worry about. A text file can also be an asset.
    if (other && other.path === asset.path && (await isSameFile(other, asset.hash))) continue;
    const { hash } = asset;
    const file = hash === undefined ? undefined : await media.get(hash);
    if (!file || hash === undefined) {
      const placed = placedAsset(state, id);
      const kept = placed && elsewhereFile(placed, label);
      if (kept) elsewhere.push(kept);
      else missing.push(label);
    } else if (places.has(place)) clashing.push(label);
    else {
      const copy = { path: asset.path, file, label, hash };
      places.set(place, copy);
      copies.push(copy);
    }
  }

  const manifest = {
    path: MANIFEST_FILE,
    file: new Blob([files.get(MANIFEST_FILE) ?? ""]),
    label: MANIFEST_FILE,
  };
  const queue = [...copies, ...documents, manifest];
  const total = queue.reduce((sum, { file }) => sum + file.size, 0);

  await target.write(INCOMPLETE_FILE, new Blob([notice]), signal ? { signal } : {});
  const refused: Copy[] = [];
  let done = 0;
  for (const copy of queue) {
    const { path, file, label } = copy;
    onStep?.({ file: label, done, total });
    const written = done;
    const isThere = await target.write(path, file, {
      ...(signal ? { signal } : {}),
      onProgress: (bytes) => onStep?.({ file: label, done: written + bytes, total }),
    });
    if (!isThere) refused.push(copy);
    done += file.size;
  }
  await target.remove(INCOMPLETE_FILE);
  await target.finish();

  // Whether what is in the folder now can be read again, because that is what a backup is for.
  const inFolder = new Set([MANIFEST_FILE, ...documents.map(({ path }) => path)]);
  for (const { path } of refused) inFolder.delete(path);
  const readable = new Map([...files].filter(([path]) => inFolder.has(path)));
  const errors = readProject(readable).problems.filter(({ severity }) => severity === "error");
  return {
    missing,
    elsewhere,
    clashing,
    refused: refused.map(({ label }) => label),
    tooLarge: documents
      .filter(({ path, file }) => isSourceFile(path) && file.size > MAX_SOURCE_BYTES)
      .map(({ label }) => label),
    problems: [...problems, ...errors],
  };
}

async function isSameFile(copy: Copy, hash: string | undefined): Promise<boolean> {
  return hash !== undefined && isSameHash(hash, copy.hash ?? (await hashFile(copy.file)));
}
