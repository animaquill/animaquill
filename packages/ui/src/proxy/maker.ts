/**
 * Making proxies away from the page, in a worker: decoding a large video takes a while, and the page
 * goes on meanwhile. See `makeProxy`.
 */
import { ProxyFailed, type ProxyFailure, type ProxyResult } from "@animaquill/media/proxy";
import type { ProxyAnswer, ProxyOrder } from "./proxy-worker.ts";
import type { ProxySpec } from "./spec.ts";

export interface ProxyRequest {
  /** The video. */
  readonly file: Blob;
  readonly spec: ProxySpec;
  /** What to encode with, best first, see `proxyEncoders`. */
  readonly encoders: readonly VideoEncoderConfig[];
  /**
   * Where the bytes of the proxy go, in turn: also back to where some went before, as an MP4 does
   * at its end. Making waits for each write.
   */
  readonly write: (data: Uint8Array<ArrayBuffer>, position: number) => Promise<void>;
  /** How far it got, as a share of the length of the video. */
  readonly onProgress?: (share: number) => void;
}

/** A proxy on its way. */
export interface ProxyJob {
  /** Rejects with a `ProxyFailed`, or with an "AbortError" once cancelled. */
  readonly done: Promise<ProxyResult>;
  /** Something that plays needs the decoder: making waits, holding on to what it has. */
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface ProxyMaker {
  make(request: ProxyRequest): ProxyJob;
}

const cancelled = () => new DOMException("The proxy was not wanted any more", "AbortError");

/**
 * Makes proxies in a worker of its own, which starts with the first one. Where the browser does not
 * let the page have one, every proxy fails as "unsupported": decoding a long video on the page itself
 * would get in the way of everything.
 */
export function workerProxyMaker({
  frameMs,
}: {
  /** For tests: how long making waits after each frame, to see a proxy on its way. */
  readonly frameMs?: number | undefined;
} = {}): ProxyMaker {
  let worker: Worker | undefined;
  let broken = typeof Worker === "undefined";
  let next = 0;
  const jobs = new Map<
    number,
    {
      readonly request: ProxyRequest;
      readonly resolve: (result: ProxyResult) => void;
      readonly reject: (error: unknown) => void;
    }
  >();

  const send = (target: Worker, order: ProxyOrder, transfer: Transferable[] = []) =>
    target.postMessage(order, transfer);

  const lose = (reason: unknown) => {
    broken = true;
    worker?.terminate();
    worker = undefined;
    const lost = [...jobs.values()];
    jobs.clear();
    for (const job of lost) job.reject(reason);
  };

  const started = (): Worker | undefined => {
    if (broken) return undefined;
    if (worker) return worker;
    try {
      worker = new Worker(new URL("./proxy-worker.ts", import.meta.url), {
        type: "module",
        name: "proxies",
      });
    } catch (error) {
      console.warn("Proxies cannot be made in this browser", error);
      broken = true;
      return undefined;
    }
    const own = worker;
    own.addEventListener("message", (event: MessageEvent<ProxyAnswer>) => {
      const answer = event.data;
      const job = jobs.get(answer.job);
      if (!job) return;
      switch (answer.kind) {
        case "write":
          job.request.write(new Uint8Array(answer.data), answer.position).then(
            () => send(own, { kind: "written", job: answer.job, write: answer.write }),
            (error: unknown) => {
              // The file cannot take it: making stops.
              jobs.delete(answer.job);
              send(own, { kind: "cancel", job: answer.job });
              job.reject(error);
            },
          );
          break;
        case "progress":
          job.request.onProgress?.(answer.share);
          break;
        case "done":
          jobs.delete(answer.job);
          job.resolve(answer.result);
          break;
        case "failed":
          jobs.delete(answer.job);
          job.reject(
            answer.reason === "cancelled"
              ? cancelled()
              : new ProxyFailed(answer.reason, { cause: answer.message }),
          );
          break;
      }
    });
    own.addEventListener("error", (event) => {
      // It did not load, or broke: none of what it had comes.
      event.preventDefault();
      console.warn("The worker for proxies stopped", event.message);
      lose(new ProxyFailed("unsupported", { cause: event.message }));
    });
    return own;
  };

  return {
    make(request) {
      let resolve: (result: ProxyResult) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const done = new Promise<ProxyResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const target = started();
      const job = next++;
      if (!target) {
        reject(new ProxyFailed("unsupported"));
        return { done, pause() {}, resume() {}, cancel() {} };
      }
      jobs.set(job, { request, resolve, reject });
      const { file, spec, encoders } = request;
      send(target, {
        kind: "make",
        job,
        file,
        spec,
        encoders: [...encoders],
        ...(frameMs !== undefined && { frameMs }),
      });
      const tell = (kind: "pause" | "resume") => {
        if (jobs.has(job)) send(target, { kind, job });
      };
      return {
        done,
        pause: () => tell("pause"),
        resume: () => tell("resume"),
        cancel() {
          const known = jobs.get(job);
          if (!known) return;
          jobs.delete(job);
          send(target, { kind: "cancel", job });
          known.reject(cancelled());
        },
      };
    },
  };
}

export type { ProxyFailure };
