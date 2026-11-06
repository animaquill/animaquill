import type { ProjectStore } from "@animaquill/core";
import type { MediaStore, TargetFolder } from "@animaquill/host";
import { MANIFEST_FILE, readProject, type Problem } from "@animaquill/schema";

/**
 * Lies in a folder for as long as an export is going on. Should it never get to the end, because
 * the disk is full or the page went away, this is what says so to people, and to an import.
 */
export const INCOMPLETE_FILE = "导出未完成.txt";

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

/** What people have to know about a folder that is finished. Anything here is not in the folder. */
export interface ExportReport {
  /** Assets whose files this host does not have. */
  readonly missing: readonly string[];
  /** Files whose path is the path of something else, at least on some disks. */
  readonly clashing: readonly string[];
  /** What keeps parts of the project from being written, or from being read again. */
  readonly problems: readonly Problem[];
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
  const errors = readProject(files).problems.filter((problem) => problem.severity === "error");
  const { assets = {} } = store.getState();

  const taken = new Set([MANIFEST_FILE, INCOMPLETE_FILE].map(samePathKey));
  const clashing: string[] = [];
  /** Whether a path is still free. On some disks a second file would quietly replace the first. */
  const claim = (path: string, label: string) => {
    const isFree = !taken.has(samePathKey(path));
    if (isFree) taken.add(samePathKey(path));
    else clashing.push(label);
    return isFree;
  };

  const documents = [...files]
    .filter(([path]) => path !== MANIFEST_FILE && claim(path, path))
    .map(([path, text]) => ({ path, file: new Blob([text]), label: path }));
  const manifest = {
    path: MANIFEST_FILE,
    file: new Blob([files.get(MANIFEST_FILE) ?? ""]),
    label: MANIFEST_FILE,
  };

  const missing: string[] = [];
  const copies: { readonly path: string; readonly file: Blob; readonly label: string }[] = [];
  for (const [id, asset] of Object.entries(assets)) {
    const label = asset.name ?? asset.path ?? id;
    const file = asset.hash === undefined ? undefined : await media.get(asset.hash);
    if (!file) missing.push(label);
    else if (claim(asset.path, label)) copies.push({ path: asset.path, file, label });
  }

  const queue = [...copies, ...documents, manifest];
  const total = queue.reduce((sum, { file }) => sum + file.size, 0);

  await target.write(INCOMPLETE_FILE, new Blob([notice]), signal ? { signal } : {});
  let done = 0;
  for (const { path, file, label } of queue) {
    onStep?.({ file: label, done, total });
    const written = done;
    await target.write(path, file, {
      ...(signal ? { signal } : {}),
      onProgress: (bytes) => onStep?.({ file: label, done: written + bytes, total }),
    });
    done += file.size;
  }
  await target.remove(INCOMPLETE_FILE);
  await target.finish();
  return { missing, clashing, problems: [...problems, ...errors] };
}
