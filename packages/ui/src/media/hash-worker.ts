/**
 * Finds out hashes of files away from the page, see `workerHasher`: of a whole file, or of one
 * that comes in pieces while it is copied somewhere.
 */
import { createHash } from "@animaquill/media/hash";

export type HashRequest =
  | { readonly kind: "file"; readonly job: number; readonly file: Blob }
  | { readonly kind: "start"; readonly job: number }
  | { readonly kind: "piece"; readonly job: number; readonly piece: Uint8Array }
  | { readonly kind: "end"; readonly job: number }
  | { readonly kind: "cancel"; readonly job: number };

export type HashAnswer =
  /** How much of a whole file was read so far, now and then. */
  | { readonly kind: "progress"; readonly job: number; readonly bytes: number }
  /** A piece is done with, so that the next ones can come. */
  | { readonly kind: "took"; readonly job: number; readonly bytes: number }
  | { readonly kind: "done"; readonly job: number; readonly hash: string }
  | {
      readonly kind: "failed";
      readonly job: number;
      readonly name: string;
      readonly message: string;
    };

/** How often a whole file tells how far it got. */
const PROGRESS_EVERY_BYTES = 8 * 1024 * 1024;

const answer = (message: HashAnswer) => postMessage(message);
/** Whole files on their way, and whether they are still wanted. */
const reading = new Map<number, { cancelled: boolean }>();
const pieces = new Map<number, ReturnType<typeof createHash>>();

async function hashWhole(job: number, file: Blob): Promise<void> {
  const state = { cancelled: false };
  reading.set(job, state);
  const hash = createHash();
  const reader = file.stream().getReader();
  let bytes = 0;
  let told = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (state.cancelled) return;
      if (done) {
        answer({ kind: "done", job, hash: hash.digest() });
        return;
      }
      hash.update(value);
      bytes += value.byteLength;
      if (bytes - told >= PROGRESS_EVERY_BYTES) {
        told = bytes;
        answer({ kind: "progress", job, bytes });
      }
    }
  } catch (error) {
    const { name, message } = error instanceof Error ? error : new Error(String(error));
    answer({ kind: "failed", job, name, message });
  } finally {
    reading.delete(job);
    await reader.cancel().catch(() => {});
  }
}

addEventListener("message", (event: MessageEvent<HashRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "file":
      void hashWhole(request.job, request.file);
      break;
    case "start":
      pieces.set(request.job, createHash());
      break;
    case "piece":
      pieces.get(request.job)?.update(request.piece);
      answer({ kind: "took", job: request.job, bytes: request.piece.byteLength });
      break;
    case "end": {
      const hash = pieces.get(request.job);
      pieces.delete(request.job);
      if (hash) answer({ kind: "done", job: request.job, hash: hash.digest() });
      break;
    }
    case "cancel": {
      const state = reading.get(request.job);
      if (state) state.cancelled = true;
      pieces.delete(request.job);
      break;
    }
  }
});
