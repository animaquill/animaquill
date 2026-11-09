/**
 * Hashes found out in a worker, through a worker of these tests that speaks the same: what comes
 * back, how pieces of a copy wait for it, and the page doing it itself where the worker goes away.
 */
import { createHash } from "@animaquill/media/hash";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HashAnswer, HashRequest } from "./hash-worker.ts";
import { workerHasher } from "./hasher.ts";

/** What the tests' workers were asked, by all of them. */
const asked: HashRequest[] = [];

/** A worker that answers as hash-worker.ts does, a moment later, or one that does not load. */
function fakeWorker({ loads = true, holdTook = false } = {}) {
  const held: (() => void)[] = [];
  class FakeWorker extends EventTarget {
    readonly #pieces = new Map<number, ReturnType<typeof createHash>>();

    constructor() {
      super();
      if (!loads) {
        setTimeout(() => this.dispatchEvent(Object.assign(new Event("error"), { message: "no" })));
      }
    }

    postMessage(request: HashRequest) {
      asked.push(request);
      if (!loads) return;
      setTimeout(() => void this.#take(request));
    }

    terminate() {}

    #answer(answer: HashAnswer) {
      this.dispatchEvent(new MessageEvent("message", { data: answer }));
    }

    async #take(request: HashRequest) {
      if (request.kind === "file") {
        this.#answer({ kind: "done", job: request.job, hash: await hashFile(request.file) });
      } else if (request.kind === "start") {
        this.#pieces.set(request.job, createHash());
      } else if (request.kind === "piece") {
        this.#pieces.get(request.job)?.update(request.piece);
        const took = () =>
          this.#answer({ kind: "took", job: request.job, bytes: request.piece.byteLength });
        if (holdTook) held.push(took);
        else took();
      } else if (request.kind === "end") {
        const hash = this.#pieces.get(request.job);
        if (hash) this.#answer({ kind: "done", job: request.job, hash: hash.digest() });
      }
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return { held };
}

afterEach(() => {
  vi.unstubAllGlobals();
  asked.length = 0;
});

const file = new Blob([new Uint8Array(300_000).map((_, index) => index % 253)]);

describe("hashes in a worker", () => {
  it("are what the page finds out itself, for a whole file and for a copy", async () => {
    fakeWorker();
    const hasher = workerHasher();
    expect(await hasher.file(file)).toBe(await hashFile(file));
    const copy = hasher.copy(file);
    const read = await new Response(copy.content.stream()).arrayBuffer();
    expect(read.byteLength).toBe(file.size);
    expect(await copy.hash()).toBe(await hashFile(file));
    expect(asked.map(({ kind }) => kind)).toContain("piece");
  });

  it("let a copy go no further than what can wait for the worker", async () => {
    const { held } = fakeWorker({ holdTook: true });
    // A file comes in pieces, as from a disk.
    const large = new (class extends Blob {
      override stream() {
        let left = 48;
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          pull(controller) {
            if (left-- === 0) controller.close();
            else controller.enqueue(new Uint8Array(1024 * 1024));
          },
        });
      }
    })([new Uint8Array(48 * 1024 * 1024)]);
    const copy = workerHasher().copy(large);
    const reader = copy.content.stream().getReader();
    let bytes = 0;
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        bytes += value.byteLength;
      }
    })();
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Not all of it, while the worker has not taken what came so far.
    expect(bytes).toBeLessThan(large.size);
    expect(bytes).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    for (;;) {
      const took = held.shift();
      if (took) took();
      else if (bytes === large.size) break;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await reading;
    expect(await copy.hash()).toBe(await hashFile(large));
  });

  it("are found out on the page where the worker does not load", async () => {
    fakeWorker({ loads: false });
    const hasher = workerHasher();
    expect(await hasher.file(file)).toBe(await hashFile(file));
    // So is a copy from then on.
    const later = hasher.copy(file);
    await new Response(later.content.stream()).arrayBuffer();
    expect(await later.hash()).toBe(await hashFile(file));
  });

  it("stop when people stop them", async () => {
    fakeWorker();
    const stopper = new AbortController();
    const hashing = workerHasher().file(file, { signal: stopper.signal });
    stopper.abort(new DOMException("stopped", "AbortError"));
    await expect(hashing).rejects.toMatchObject({ name: "AbortError" });
    expect(asked.map(({ kind }) => kind)).toContain("cancel");
  });
});
