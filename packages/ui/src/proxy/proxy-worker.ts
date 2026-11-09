/**
 * Makes proxies away from the page, see `workerProxyMaker`: decodes, makes smaller, encodes and puts
 * the frames in a file, whose bytes go to the page, which writes them where they belong.
 */
import { makeProxy, ProxyFailed, type ProxyResult } from "@animaquill/media/proxy";
import type { ProxySpec } from "./spec.ts";

export type ProxyOrder =
  | {
      readonly kind: "make";
      readonly job: number;
      readonly file: Blob;
      readonly spec: ProxySpec;
      readonly encoders: VideoEncoderConfig[];
      /** For tests: how long to wait after each frame, to see a proxy on its way. */
      readonly frameMs?: number;
    }
  /** A write is done with, so that the next one can come. */
  | { readonly kind: "written"; readonly job: number; readonly write: number }
  | { readonly kind: "pause"; readonly job: number }
  | { readonly kind: "resume"; readonly job: number }
  | { readonly kind: "cancel"; readonly job: number };

export type ProxyAnswer =
  | {
      readonly kind: "write";
      readonly job: number;
      readonly write: number;
      readonly data: ArrayBuffer;
      readonly position: number;
    }
  | { readonly kind: "progress"; readonly job: number; readonly share: number }
  | { readonly kind: "done"; readonly job: number; readonly result: ProxyResult }
  | {
      readonly kind: "failed";
      readonly job: number;
      readonly reason: ProxyFailed["reason"] | "cancelled";
      readonly message: string;
      /** Where the encoder ran, for a failure of it, see `ProxyFailed.acceleration`. */
      readonly acceleration?: "hardware" | "software";
    };

/** Progress is worth telling this often, about. */
const PROGRESS_EVERY_MS = 250;

interface Job {
  readonly stopper: AbortController;
  /** While something plays: resolves once it does not any more. */
  paused: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  /** Writes waiting for the page, by number. */
  readonly writes: Map<number, () => void>;
}

const jobs = new Map<number, Job>();
let nextWrite = 0;

const answer = (message: ProxyAnswer, transfer: Transferable[] = []) =>
  postMessage(message, { transfer });

/**
 * Bytes of their own, which go to the page without another copy. What the file writer gives may be
 * part of what it goes on using, which must not go.
 */
const ownBytes = (data: Uint8Array): ArrayBuffer => data.slice().buffer;

async function make(order: Extract<ProxyOrder, { kind: "make" }>): Promise<void> {
  const { job: id, file, spec, encoders, frameMs = 0 } = order;
  const job: Job = { stopper: new AbortController(), paused: undefined, writes: new Map() };
  jobs.set(id, job);
  const { signal } = job.stopper;
  let told = 0;
  try {
    const result = await makeProxy(
      file,
      spec,
      encoders,
      {
        write: (data, position) =>
          new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const write = nextWrite++;
            job.writes.set(write, resolve);
            const bytes = ownBytes(data);
            answer({ kind: "write", job: id, write, data: bytes, position }, [bytes]);
          }),
      },
      {
        signal,
        whenFree: async () => {
          if (frameMs > 0) await new Promise((resolve) => setTimeout(resolve, frameMs));
          await job.paused?.promise;
        },
        onProgress(share) {
          const now = performance.now();
          if (now - told < PROGRESS_EVERY_MS && share < 1) return;
          told = now;
          answer({ kind: "progress", job: id, share });
        },
      },
    );
    answer({ kind: "done", job: id, result });
  } catch (error) {
    const reason = signal.aborted
      ? "cancelled"
      : error instanceof ProxyFailed
        ? error.reason
        : "encoder";
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const acceleration = error instanceof ProxyFailed ? error.acceleration : undefined;
    answer({ kind: "failed", job: id, reason, message, ...(acceleration && { acceleration }) });
  } finally {
    jobs.delete(id);
  }
}

addEventListener("message", (event: MessageEvent<ProxyOrder>) => {
  const order = event.data;
  if (order.kind === "make") {
    void make(order);
    return;
  }
  const job = jobs.get(order.job);
  if (!job) return;
  switch (order.kind) {
    case "written": {
      const resolve = job.writes.get(order.write);
      job.writes.delete(order.write);
      resolve?.();
      break;
    }
    case "pause":
      if (!job.paused) {
        let resolve = () => {};
        const promise = new Promise<void>((done) => (resolve = done));
        job.paused = { promise, resolve };
      }
      break;
    case "resume":
      job.paused?.resolve();
      job.paused = undefined;
      break;
    case "cancel":
      job.stopper.abort(new DOMException("The proxy was not wanted any more", "AbortError"));
      // Whatever waits goes on, to find out that it is over.
      job.paused?.resolve();
      job.paused = undefined;
      for (const resolve of job.writes.values()) resolve();
      job.writes.clear();
      break;
  }
});
