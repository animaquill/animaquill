import { Worker } from "node:worker_threads";
import type {
  BuiltProject,
  CheckedProject,
  ExportedProject,
  ExportRequest,
  ExportResponse,
} from "./export-worker.ts";
import type { Here } from "@animaquill/core";
import type { Exported, ExportedFile } from "./plan.ts";
import type { LfsAsset } from "./pointers.ts";

/**
 * The thread that makes a project into files for an archive, export-worker.ts: one for each
 * archive, ended with it, so that what a large project took is given back at once. Its heap has a
 * limit: a project that would take more ends the thread, not the worker (`ExportFailed`), and the
 * archive is tried again later. The worker archives one project at a time, see worker.ts.
 */

/**
 * The heap of the thread, in MB, in the worker. Long strings are not held to it (V8 keeps them
 * apart): the worker's mem_limit comes from what the largest project measured, see
 * test/measure-archive.ts.
 */
export const EXPORT_HEAP_MB = 512;

/** The thread could not make the project into files: it ran out of memory, or the updates are bad. */
export class ExportFailed extends Error {
  override name = "ExportFailed";
}

export interface ExportResult extends Exported {
  readonly problems: readonly string[];
  readonly projectId: string;
  /** Assets whose files are in Git LFS, as the files have them, see `ExportedProject.lfs`. */
  readonly lfs: readonly LfsAsset[];
  /** The most of its heap the thread used, in bytes. */
  readonly peakHeap: number;
}

export interface ExportSession {
  /**
   * The files of the project from its last snapshot and the updates after it, in order, with where
   * the files of its assets are as it counts `here`, see `Here`.
   */
  export(parts: readonly Uint8Array[], here?: Here): Promise<ExportResult>;
  /** Errors of `readProject` for these documents: what a repository would have. */
  check(documents: ReadonlyMap<string, string>): Promise<readonly string[]>;
  /**
   * A project from the files of a repository, as the platform takes a first version, see
   * `BuiltProject`; `here` as for `export`.
   */
  build(files: ReadonlyMap<string, Uint8Array>, here?: Here): Promise<BuiltProject>;
  close(): Promise<void>;
}

export interface ExporterOptions {
  /** The heap of the thread, in MB. See the measurements of the largest project in worker.ts. */
  readonly heapMb: number;
}

export class ProjectExporter {
  readonly #heapMb: number;

  constructor(options: ExporterOptions) {
    this.#heapMb = options.heapMb;
  }

  open(): ExportSession {
    const worker = new Worker(new URL("./export-worker.ts", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: this.#heapMb },
    });
    worker.unref();
    let next = 1;
    let gone: Error | undefined;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (e: Error) => void }
    >();
    const fail = (error: Error) => {
      gone ??= error;
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    };
    worker.on("message", (response: ExportResponse) => {
      const waiting = pending.get(response.id);
      if (!waiting) return;
      pending.delete(response.id);
      if (response.ok) waiting.resolve({ result: response.result, peak: response.peak });
      else waiting.reject(new ExportFailed(response.error));
    });
    worker.on("error", (error: unknown) =>
      fail(
        new ExportFailed(
          `the export thread failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
    worker.on("exit", (code) => fail(new ExportFailed(`the export thread ended (${code})`)));
    type Ask = ExportRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;
    const ask = (request: Ask) => {
      if (gone) return Promise.reject(gone);
      const id = next++;
      return new Promise<{ result: unknown; peak: number }>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
        worker.postMessage({ ...request, id } as ExportRequest);
      });
    };
    return {
      async export(parts, here) {
        const { result, peak } = await ask({ op: "export", parts, ...(here && { here }) });
        const exported = result as ExportedProject;
        const files = new Map<string, ExportedFile>();
        for (const [path, text, sha] of exported.files) files.set(path, { text, sha });
        return {
          files,
          invalid: new Set(exported.invalid),
          problems: exported.problems,
          projectId: exported.projectId,
          lfs: exported.lfs.map(([path, oid, size]) => ({ path, oid, size })),
          peakHeap: peak,
        };
      },
      async check(documents) {
        const { result } = await ask({ op: "check", documents: [...documents] });
        return (result as CheckedProject).errors;
      },
      async build(files, here) {
        const { result } = await ask({ op: "build", files: [...files], ...(here && { here }) });
        return result as BuiltProject;
      },
      async close() {
        gone ??= new ExportFailed("closed");
        await worker.terminate();
      },
    };
  }
}
