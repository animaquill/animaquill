import { getHeapStatistics } from "node:v8";
import { parentPort } from "node:worker_threads";
import {
  MAX_SOURCE_BYTES,
  ProjectStore,
  checkUpdate,
  checkWhole,
  isDocument,
  isProjectFile,
  placedAssets,
  type Here,
} from "@animaquill/core";
import { CURRENT_FORMAT_VERSION, MANIFEST_FILE, lfsOidOf, readProject } from "@animaquill/schema";
import { SYNC_LIMITS } from "@animaquill/host/sync";
import { blobShaOf, bytesOf } from "./repo-host.ts";

/**
 * Makes a project into files for an archive, in a thread of its own with a heap of its own (see
 * exporter.ts): the snapshot and the updates after it, as the database has them, into a project, and
 * that into the files of the format with `exportFiles`, the same as the editor writes into a folder.
 * Nothing touches a disk. Where the files of assets are goes by `here`, the repository: an asset in
 * Git LFS of another repository is not in this one. It also reads the documents an archive would
 * leave in the repository as a project, `readProject`, which is the last check before a commit.
 */

export type ExportRequest = { readonly id: number } & (
  | { readonly op: "export"; readonly parts: readonly Uint8Array[]; readonly here?: Here }
  | { readonly op: "check"; readonly documents: readonly (readonly [string, string])[] }
  | {
      readonly op: "build";
      readonly files: readonly (readonly [string, Uint8Array])[];
      readonly here?: Here;
    }
);

/**
 * A project made from the files of a repository (archive/rebuild.ts), as one first version of Yjs
 * that has passed every check the platform makes of one (as sync/copy-worker.ts does for a window's):
 * with its id and name, and the assets whose files are in Git LFS, as `ExportedProject.lfs`. Or why
 * not: "notProject", no animaquill.json; "unreadable", files that do not read as the format says,
 * or are no text (`files`); "tooNew", a format newer than the platform knows; "tooLarge", more than
 * a project may be.
 */
export type BuiltProject =
  | {
      readonly ok: true;
      readonly state: Uint8Array;
      readonly projectId: string;
      readonly name: string;
      readonly lfs: readonly (readonly [string, string, number])[];
    }
  | {
      readonly ok: false;
      readonly code: "notProject" | "unreadable" | "tooNew" | "tooLarge";
      readonly files?: readonly string[];
      /** What is wrong, for the log: file and what. */
      readonly problems?: readonly string[];
    };

export interface ExportedProject {
  /** Path, text, and the SHA-1 Git names it by. Only files of the project. */
  readonly files: readonly (readonly [string, string, string])[];
  /** Documents that `exportFiles` could not write as they are, see `planArchive`. */
  readonly invalid: readonly string[];
  /** What is wrong with them, for people: file, where, and what. */
  readonly problems: readonly string[];
  /** The id in its animaquill.json. */
  readonly projectId: string;
  /**
   * Assets whose files are in Git LFS as the files have them, with what a pointer needs: path, oid
   * (the SHA-256 in lower-case hexadecimal) and size. Those without a hash or a size are not.
   */
  readonly lfs: readonly (readonly [string, string, number])[];
}

export interface CheckedProject {
  /** Errors, as `readProject` says them: file and what. */
  readonly errors: readonly string[];
}

export type ExportResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: ExportedProject | CheckedProject | BuiltProject;
      /** Bytes of the heap of the thread in use, afterwards, and at the most so far. */
      readonly heap: number;
      readonly peak: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

let peak = 0;
const measure = () => {
  const used = getHeapStatistics().used_heap_size;
  peak = Math.max(peak, used);
  return used;
};

function exportProject(parts: readonly Uint8Array[], here: Here | undefined): ExportedProject {
  const { store } = ProjectStore.fromUpdates(parts);
  if (!store) throw new Error("the updates do not make a project");
  try {
    if (store.isMissingUpdates) throw new Error("the updates need ones that are not there");
    const { files, problems } = store.exportFiles(here ? { here } : {});
    measure();
    const projectId = store.getState().manifest.id;
    const out: [string, string, string][] = [];
    for (const [path, text] of files) {
      if (isProjectFile(path)) out.push([path, text, blobShaOf(bytesOf(text))]);
    }
    const invalid = [
      ...new Set(
        problems.flatMap((problem) => (problem.code === "invalid-state" ? [problem.file] : [])),
      ),
    ];
    const lfs: [string, string, number][] = [];
    for (const asset of Object.values(placedAssets(store.getState(), here) ?? {})) {
      const oid = asset.hash === undefined ? undefined : lfsOidOf(asset.hash);
      if (asset.storage === "lfs" && oid !== undefined && asset.size !== undefined)
        lfs.push([asset.path, oid, asset.size]);
    }
    return {
      files: out,
      invalid,
      lfs,
      problems: problems
        .slice(0, 20)
        .map((problem) =>
          `${problem.file}${problem.path ? ` ${problem.path}` : ""}: ${problem.message}`.slice(
            0,
            300,
          ),
        ),
      projectId: typeof projectId === "string" ? projectId : "",
    };
  } finally {
    store.destroy();
  }
}

function checkProject(documents: readonly (readonly [string, string])[]): CheckedProject {
  const { problems } = readProject(new Map(documents));
  return {
    errors: problems
      .filter((problem) => problem.severity === "error")
      .slice(0, 20)
      .map((problem) => `${problem.file}: ${problem.message}`.slice(0, 300)),
  };
}

/** Files of a project that are listed when it is turned away, at most. */
const LISTED_MOST = 50;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The files of a repository as a project, see `BuiltProject`: its documents, each of which has to
 * read, and its code where that is text no larger than code may be (as an archive counts what is
 * the editor's, see `isEditorsFile` of plan.ts: anything else there is not the project's). Opened
 * as the editor opens a folder (`ProjectStore.open`), and then checked as the platform checks the
 * first version a window sends.
 */
function buildProject(
  files: readonly (readonly [string, Uint8Array])[],
  here: Here | undefined,
): BuiltProject {
  const texts = new Map<string, string>();
  const unreadable: string[] = [];
  for (const [path, bytes] of files) {
    if (!isProjectFile(path)) continue;
    const document = isDocument(path);
    if (!document && bytes.length > MAX_SOURCE_BYTES) continue;
    try {
      texts.set(path, UTF8.decode(bytes));
    } catch {
      if (document) unreadable.push(path);
    }
  }
  if (!texts.has(MANIFEST_FILE)) return { ok: false, code: "notProject" };
  const { store, problems } = ProjectStore.open(texts);
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.some((problem) => problem.code === "format-too-new")) {
    store?.destroy();
    return { ok: false, code: "tooNew" };
  }
  const bad = [...new Set([...unreadable, ...errors.map((problem) => problem.file)])].toSorted();
  const said = errors
    .slice(0, 20)
    .map((problem) =>
      `${problem.file}${problem.path ? ` ${problem.path}` : ""}: ${problem.message}`.slice(0, 300),
    );
  if (!store || bad.length > 0) {
    store?.destroy();
    return {
      ok: false,
      code: "unreadable",
      files: (bad.length > 0 ? bad : [MANIFEST_FILE]).slice(0, LISTED_MOST),
      problems: said,
    };
  }
  let copy: ProjectStore | undefined;
  try {
    const state = store.encodeWhole();
    measure();
    if (state.length > SYNC_LIMITS.state) return { ok: false, code: "tooLarge" };
    const fault = checkUpdate(state, { most: SYNC_LIMITS.structs });
    if (fault === "too-large") return { ok: false, code: "tooLarge" };
    if (fault) return { ok: false, code: "unreadable", files: [MANIFEST_FILE], problems: [fault] };
    // What the platform will read it from, as it reads a window's first version.
    copy = ProjectStore.fromUpdates([state]).store;
    if (!copy || copy.isMissingUpdates)
      return { ok: false, code: "unreadable", files: [MANIFEST_FILE], problems: ["no project"] };
    const invalid = checkWhole(copy.doc);
    if (invalid)
      return {
        ok: false,
        code: "unreadable",
        files: [MANIFEST_FILE],
        problems: [`${invalid.path}: ${invalid.problem}`.slice(0, 300)],
      };
    const { id, name, formatVersion } = copy.getState().manifest;
    if (typeof formatVersion === "number" && formatVersion > CURRENT_FORMAT_VERSION)
      return { ok: false, code: "tooNew" };
    const lfs: [string, string, number][] = [];
    for (const asset of Object.values(placedAssets(copy.getState(), here) ?? {})) {
      const oid = asset.hash === undefined ? undefined : lfsOidOf(asset.hash);
      if (asset.storage === "lfs" && oid !== undefined && asset.size !== undefined)
        lfs.push([asset.path, oid, asset.size]);
    }
    return {
      ok: true,
      state,
      projectId: typeof id === "string" ? id : "",
      name: typeof name === "string" ? name.slice(0, 200) : "",
      lfs,
    };
  } finally {
    store.destroy();
    copy?.destroy();
  }
}

parentPort?.on("message", (request: ExportRequest) => {
  let response: ExportResponse;
  try {
    const result =
      request.op === "export"
        ? exportProject(request.parts, request.here)
        : request.op === "build"
          ? buildProject(request.files, request.here)
          : checkProject(request.documents);
    const heap = measure();
    response = { id: request.id, ok: true, result, heap, peak };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
  parentPort?.postMessage(response);
});
