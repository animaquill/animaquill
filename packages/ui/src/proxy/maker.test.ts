/**
 * Making proxies in a worker, through a worker of these tests that speaks the same: what it writes
 * comes to the page in turn, it waits while something plays, it stops when asked, and a worker that
 * does not load makes none.
 */
import { ProxyFailed } from "@animaquill/media/proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerProxyMaker } from "./maker.ts";
import type { ProxyAnswer, ProxyOrder } from "./proxy-worker.ts";

const SPEC = { width: 960, height: 540, fps: { num: 30, den: 1 } };

/** What the tests' workers were asked. */
const asked: ProxyOrder[] = [];

/**
 * A worker that answers as proxy-worker.ts does: two writes, the second only once the first is
 * written, then done, or what `fails` says. Or one that does not load.
 */
function fakeWorker({ loads = true, fails }: { loads?: boolean; fails?: string } = {}) {
  const workers: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    constructor() {
      super();
      workers.push(this);
      if (!loads) {
        setTimeout(() => this.dispatchEvent(Object.assign(new Event("error"), { message: "no" })));
      }
    }

    postMessage(order: ProxyOrder) {
      asked.push(order);
      if (!loads) return;
      if (order.kind === "make") setTimeout(() => this.#write(order.job, 0));
      if (order.kind === "written") setTimeout(() => this.#next(order.job, order.write));
    }

    terminate() {}

    answer(answer: ProxyAnswer) {
      this.dispatchEvent(new MessageEvent("message", { data: answer }));
    }

    #write(job: number, write: number) {
      const bytes = new TextEncoder().encode(write === 0 ? "尾巴" : "头");
      this.answer({ kind: "write", job, write, data: bytes.buffer, position: write === 0 ? 3 : 0 });
    }

    #next(job: number, written: number) {
      if (written === 0) {
        this.answer({ kind: "progress", job, share: 0.5 });
        this.#write(job, 1);
        return;
      }
      this.answer(
        fails
          ? { kind: "failed", job, reason: fails as never, message: "它说的" }
          : {
              kind: "done",
              job,
              result: { frames: 90, keys: 6, duration: 3, sourceDuration: 3 },
            },
      );
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return { workers };
}

afterEach(() => {
  vi.unstubAllGlobals();
  asked.length = 0;
});

/** Where the bytes go, as a file that grows would take them. */
function sink() {
  const writes: { text: string; position: number }[] = [];
  let release: (() => void) | undefined;
  return {
    writes,
    hold() {
      let resolve = () => {};
      const held = new Promise<void>((done) => (resolve = done));
      release = resolve;
      return held;
    },
    release: () => release?.(),
    write: async (data: Uint8Array, position: number) => {
      writes.push({ text: new TextDecoder().decode(data), position });
    },
  };
}

describe("making a proxy in a worker", () => {
  it("writes what it makes in turn, and is done once all of it is written", async () => {
    fakeWorker();
    const into = sink();
    let holding: Promise<void> | undefined = into.hold();
    const progress: number[] = [];
    const job = workerProxyMaker().make({
      file: new Blob(["视频"]),
      spec: SPEC,
      encoders: [{ codec: "avc1.64001F", width: 960, height: 540 }],
      write: async (data, position) => {
        await into.write(data, position);
        // The first write takes a while: the next one waits for it.
        const waiting = holding;
        holding = undefined;
        await waiting;
      },
      onProgress: (share) => void progress.push(share),
    });
    await vi.waitFor(() => expect(into.writes).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(into.writes).toEqual([{ text: "尾巴", position: 3 }]);
    into.release();
    expect(await job.done).toMatchObject({ frames: 90, duration: 3 });
    expect(into.writes).toEqual([
      { text: "尾巴", position: 3 },
      { text: "头", position: 0 },
    ]);
    expect(progress).toEqual([0.5]);
    expect(asked[0]).toMatchObject({ kind: "make", spec: SPEC });
  });

  it("tells the worker to wait and go on, and to stop, which rejects as stopped", async () => {
    fakeWorker();
    const into = sink();
    const held = into.hold();
    const job = workerProxyMaker().make({
      file: new Blob(["视频"]),
      spec: SPEC,
      encoders: [],
      write: async (data, position) => {
        await into.write(data, position);
        await held;
      },
    });
    job.pause();
    job.resume();
    await vi.waitFor(() => expect(into.writes).toHaveLength(1));
    job.cancel();
    await expect(job.done).rejects.toMatchObject({ name: "AbortError" });
    expect(asked.map(({ kind }) => kind)).toEqual(["make", "pause", "resume", "cancel"]);
    // What comes from the worker after that is nobody's any more.
    into.release();
  });

  it("says why the worker made none", async () => {
    fakeWorker({ fails: "unreadable" });
    const job = workerProxyMaker().make({
      file: new Blob(["视频"]),
      spec: SPEC,
      encoders: [],
      write: async () => {},
    });
    await expect(job.done).rejects.toEqual(new ProxyFailed("unreadable"));
  });

  it("stops when the file does not take what it makes", async () => {
    fakeWorker();
    const job = workerProxyMaker().make({
      file: new Blob(["视频"]),
      spec: SPEC,
      encoders: [],
      write: () => Promise.reject(new Error("磁盘满了")),
    });
    await expect(job.done).rejects.toThrow("磁盘满了");
    await vi.waitFor(() => expect(asked.at(-1)).toMatchObject({ kind: "cancel" }));
  });

  it("makes none where the worker does not load, which takes nothing else down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeWorker({ loads: false });
    const maker = workerProxyMaker();
    const job = maker.make({ file: new Blob([]), spec: SPEC, encoders: [], write: async () => {} });
    await expect(job.done).rejects.toEqual(new ProxyFailed("unsupported"));
    // The next one does not try again.
    const next = maker.make({
      file: new Blob([]),
      spec: SPEC,
      encoders: [],
      write: async () => {},
    });
    await expect(next.done).rejects.toEqual(new ProxyFailed("unsupported"));
  });
});
