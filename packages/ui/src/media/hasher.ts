/**
 * Finding out the hash of a file, which for a large video takes a while: in a worker where the
 * browser has one, so that the page goes on meanwhile, as while something plays. See the design of
 * local projects, section 5.
 */
import { hashFile, hashingCopy, type HashOptions } from "@animaquill/media";
import type { HashAnswer, HashRequest } from "./hash-worker.ts";

export interface Hasher {
  /**
   * The hash of a file of any size, see `hashFile`. Rejects with what reading the file threw, with
   * its name, such as "NotReadableError" for a file that changed since the browser gave it out.
   */
  file(file: Blob, options?: HashOptions): Promise<string>;
  /**
   * A file to write somewhere, which finds out its hash while it is read for that: one read for
   * both, see `hashingCopy`. `hash` resolves once all of it was read, and to undefined where it
   * could not be found out that way.
   */
  copy(file: Blob): HashingCopy;
}

export interface HashingCopy {
  readonly content: Blob;
  hash(): Promise<string | undefined>;
  /** The write stopped, and nothing more of it comes. */
  abandon(): void;
}

/** On the page itself, as in tests. */
export const hasherHere: Hasher = {
  file: (file, options) => hashFile(file, options),
  copy(file) {
    const copy = hashingCopy(file);
    return { content: copy.content, hash: async () => copy.hash(), abandon: () => {} };
  },
};

/** How much of a copy may wait for the worker, so that a quick disk does not fill the memory. */
const MAX_WAITING_BYTES = 32 * 1024 * 1024;

interface Job {
  readonly onProgress?: ((bytes: number) => void) | undefined;
  readonly onTook?: (bytes: number) => void;
  readonly resolve: (hash: string) => void;
  readonly reject: (error: unknown) => void;
  /** The worker went away, and what it had of this with it. */
  readonly lost: () => void;
}

/** What says that the worker went away, so that the page does it itself. */
const LOST = Symbol("lost");

/**
 * Hashes in a worker of its own. Where the browser does not let the page have one, as with a policy
 * that does not allow it, everything goes on on the page.
 */
export function workerHasher(): Hasher {
  let worker: Worker | undefined;
  let broken = typeof Worker === "undefined";
  let next = 0;
  const jobs = new Map<number, Job>();

  const lose = () => {
    broken = true;
    worker?.terminate();
    worker = undefined;
    const lost = [...jobs.values()];
    jobs.clear();
    for (const job of lost) job.lost();
  };

  const started = (): Worker | undefined => {
    if (broken) return undefined;
    if (worker) return worker;
    try {
      worker = new Worker(new URL("./hash-worker.ts", import.meta.url), {
        type: "module",
        name: "hashes",
      });
    } catch (error) {
      console.warn("Hashes are found out on the page itself", error);
      broken = true;
      return undefined;
    }
    worker.addEventListener("message", (event: MessageEvent<HashAnswer>) => {
      const answer = event.data;
      const job = jobs.get(answer.job);
      if (!job) return;
      if (answer.kind === "progress") job.onProgress?.(answer.bytes);
      else if (answer.kind === "took") job.onTook?.(answer.bytes);
      else {
        jobs.delete(answer.job);
        if (answer.kind === "done") job.resolve(answer.hash);
        else job.reject(new DOMException(answer.message, answer.name));
      }
    });
    worker.addEventListener("error", (event) => {
      // It did not load, or broke: the page does the rest.
      event.preventDefault();
      console.warn("The worker for hashes stopped", event.message);
      lose();
    });
    return worker;
  };

  /** A worker takes no target origin, and gets what it can have for good. */
  const send = (target: Worker, request: HashRequest, transfer: Transferable[] = []) =>
    target.postMessage(request, transfer);

  const hashThere = (target: Worker, file: Blob, { signal, onProgress }: HashOptions) =>
    new Promise<string>((resolve, reject) => {
      const job = next++;
      const onAbort = () => {
        jobs.delete(job);
        send(target, { kind: "cancel", job });
        reject(signal?.reason);
      };
      const done = () => signal?.removeEventListener("abort", onAbort);
      jobs.set(job, {
        onProgress,
        resolve: (hash) => (done(), resolve(hash)),
        reject: (error) => (done(), reject(error)),
        lost: () => (done(), reject(LOST)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      send(target, { kind: "file", job, file });
    });

  /** Pieces of a copy for the worker to hash, as many as can wait for it, see `MAX_WAITING_BYTES`. */
  const piecesFor = (target: Worker, job: number, settle: (hash: string | undefined) => void) => {
    let waiting = 0;
    let room: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
    const makeRoom = () => {
      room?.resolve();
      room = undefined;
    };
    jobs.set(job, {
      onTook(bytes) {
        waiting -= bytes;
        if (waiting < MAX_WAITING_BYTES) makeRoom();
      },
      resolve: (hash) => settle(hash),
      reject: () => settle(undefined),
      lost() {
        settle(undefined);
        makeRoom();
      },
    });
    send(target, { kind: "start", job });
    return {
      /** Resolves once the next piece may come. */
      async add(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        if (!jobs.has(job)) return;
        const piece = chunk.slice();
        waiting += piece.byteLength;
        send(target, { kind: "piece", job, piece }, [piece.buffer]);
        if (waiting < MAX_WAITING_BYTES) return;
        let resolve = () => {};
        const promise = new Promise<void>((done) => (resolve = done));
        room = { promise, resolve };
        await promise;
      },
      end(): void {
        if (jobs.has(job)) send(target, { kind: "end", job });
      },
      abandon(): void {
        if (!jobs.delete(job)) return;
        send(target, { kind: "cancel", job });
        settle(undefined);
        makeRoom();
      },
    };
  };

  return {
    async file(file, options = {}) {
      options.signal?.throwIfAborted();
      const target = started();
      if (!target) return hashFile(file, options);
      try {
        return await hashThere(target, file, options);
      } catch (error) {
        if (error === LOST) return hashFile(file, options);
        throw error;
      }
    },

    copy(file) {
      const target = started();
      if (!target) return hasherHere.copy(file);
      let found: Promise<string | undefined> = Promise.resolve(undefined);
      let current: ReturnType<typeof piecesFor> | undefined;
      const content = new (class extends Blob {
        override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
          // A write that starts again reads all of it again, and that is another hash.
          current?.abandon();
          let settle: (hash: string | undefined) => void = () => {};
          found = new Promise((resolve) => (settle = resolve));
          const pieces = piecesFor(target, next++, settle);
          current = pieces;
          return file.stream().pipeThrough(
            new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
              async transform(chunk, controller) {
                controller.enqueue(chunk);
                await pieces.add(chunk);
              },
              flush: () => pieces.end(),
            }),
          );
        }
      })([file], { type: file.type });
      return { content, hash: () => found, abandon: () => current?.abandon() };
    },
  };
}
