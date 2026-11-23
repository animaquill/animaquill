import { gunzipSync, gzipSync } from "node:zlib";
import type { FileChange, PlatformBatch } from "@animaquill/core";

/**
 * How the platform keeps what goes with its merges from GitHub: the files to merge
 * (`repo_merges.input`, which the worker writes and the hub reads) and what a batch wrote
 * (`project_batches.writes`), both gzipped JSON.
 */

/** A file to merge, as `repo_merges.input` has it: what it was, and what GitHub has now. */
export interface MergeInput {
  readonly path: string;
  readonly base?: string | undefined;
  readonly theirs?: string | undefined;
  /**
   * The commit `base` is of, where it is not the merge's `from_sha`: a file that was blocked, and
   * is merged from where it was before then, see `BlockedFile.baseSha`.
   */
  readonly baseSha?: string | undefined;
}

export const writeMergeInput = (files: readonly MergeInput[]): Buffer =>
  gzipSync(Buffer.from(JSON.stringify(files)));

/** The files of a merge, or undefined where they cannot be read. */
export function readMergeInput(input: Uint8Array | null): FileChange[] | undefined {
  if (!input) return undefined;
  try {
    const files: unknown = JSON.parse(gunzipSync(input).toString("utf8"));
    if (!Array.isArray(files)) return undefined;
    const changes: FileChange[] = [];
    for (const file of files) {
      if (typeof file !== "object" || file === null) return undefined;
      const { path, base, theirs } = file as Record<string, unknown>;
      const isText = (value: unknown) => value === undefined || typeof value === "string";
      if (typeof path !== "string" || !isText(base) || !isText(theirs)) return undefined;
      changes.push({ path, base: base as string | undefined, text: theirs as string | undefined });
    }
    return changes;
  } catch {
    return undefined;
  }
}

/** The commits the bases of the files of a merge are of, where the input says, by path. */
export function readMergeBases(input: Uint8Array | null): Map<string, string> {
  const bases = new Map<string, string>();
  if (!input) return bases;
  try {
    const files: unknown = JSON.parse(gunzipSync(input).toString("utf8"));
    if (!Array.isArray(files)) return bases;
    for (const file of files) {
      const { path, baseSha } = (file ?? {}) as Record<string, unknown>;
      if (typeof path === "string" && typeof baseSha === "string") bases.set(path, baseSha);
    }
  } catch {
    // What does not read has no bases: the merge refuses it anyway.
  }
  return bases;
}

/** Bytes of the texts of a merge: what GitHub has, and what it had. */
export const mergeBytesOf = (changes: readonly FileChange[]): number =>
  changes.reduce(
    (sum, { base, text }) =>
      sum + Buffer.byteLength(base ?? "", "utf8") + Buffer.byteLength(text ?? "", "utf8"),
    0,
  );

export const batchRow = (batch: PlatformBatch): Buffer =>
  gzipSync(Buffer.from(JSON.stringify(batch)));

/** A batch as the database keeps it, with its update: undefined where it does not read. */
export function batchFromRow(row: {
  readonly id: string;
  readonly seq: number;
  readonly writes: Uint8Array;
}): PlatformBatch | undefined {
  try {
    const batch = JSON.parse(gunzipSync(row.writes).toString("utf8")) as PlatformBatch;
    const isList = (value: unknown) => Array.isArray(value);
    if (
      typeof batch !== "object" ||
      batch === null ||
      !Array.isArray(batch.clocks) ||
      !isList(batch.writes) ||
      !isList(batch.removed) ||
      !isList(batch.copied) ||
      !isList(batch.orders)
    ) {
      return undefined;
    }
    return { ...batch, batch: row.id, seq: row.seq };
  } catch {
    return undefined;
  }
}
