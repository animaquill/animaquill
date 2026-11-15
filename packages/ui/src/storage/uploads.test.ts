import { ProjectStore } from "@animaquill/core";
import {
  CloudSignedOut,
  LfsRefused,
  type LfsAccess,
  type LfsUpload,
  type UploadStore,
} from "@animaquill/host";
import { MemoryUploads } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { createProject, lfsOidOf } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AssetUploads,
  unfinishedByProject,
  type FileFound,
  type UploadBlock,
  type UploadEnvironment,
  type UploadsSnapshot,
} from "./uploads.ts";

/**
 * The files of assets on their way into the large file storage (uploads.ts), against a platform in
 * memory that answers as the real one does (apps/api/src/lfs of AnimaQuill Cloud): what an asset
 * says of where its file is changes only once the storage has it; what was on its way goes on from
 * where it got, also in another window and after the page went away; pieces get smaller where the
 * line is slow; what goes by itself goes by itself, and what people have to do something about waits
 * for them; only one window sends.
 */

const REPO = "4242";

/** The platform's side, in memory: pieces at their offset, then checked, then into the storage. */
class FakeLfs implements LfsAccess {
  readonly stored = new Map<string, number>();
  readonly uploads = new Map<
    string,
    { upload: LfsUpload; bytes: Uint8Array[]; asked: number; expected: string }
  >();
  /** Each piece sent, by its size. */
  readonly pieces: number[] = [];
  chunk = 4096;
  minChunk = 64;
  /** What the next requests say, in place of what they would. */
  faults: ("busy" | "slow" | "unavailable" | "signedOut" | "quota")[] = [];
  /** What the next pieces are answered with, in place of what they would. */
  pieceFaults: ("slow" | "unavailable")[] = [];
  /** How many times `state` says "pushing" before "done". */
  pushingFor = 2;
  /** What waits until a test lets it go, before it answers a piece. */
  hold: Promise<void> | undefined;
  #next = 0;

  #fault(): void {
    const fault = this.faults.shift();
    if (fault === undefined) return;
    if (fault === "signedOut") throw new CloudSignedOut("Nobody is signed in");
    if (fault === "quota") throw new LfsRefused("githubQuota");
    throw new LfsRefused(fault, fault === "busy" ? { retryAfter: 1 } : {});
  }

  async begin(_project: string, { oid, size }: { oid: string; size: number }): Promise<LfsUpload> {
    this.#fault();
    const base = { repo: REPO, oid, size, chunk: this.chunk, minChunk: this.minChunk };
    const stored = this.stored.get(oid);
    if (stored === size) return { ...base, state: "present", received: size };
    if (stored !== undefined)
      return { ...base, id: `x${this.#next++}`, state: "failed", received: 0, error: "changed" };
    for (const each of this.uploads.values())
      if (
        each.upload.oid === oid &&
        ["receiving", "received", "pushing"].includes(each.upload.state)
      )
        return each.upload;
    const id = `u${this.#next++}`;
    const upload: LfsUpload = { ...base, id, state: "receiving", received: 0 };
    this.uploads.set(id, { upload, bytes: [], asked: 0, expected: oid });
    return upload;
  }

  async send(
    id: string,
    offset: number,
    piece: Blob,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LfsUpload> {
    const { signal } = options;
    if (this.hold)
      await Promise.race([
        this.hold,
        new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    this.#fault();
    const pieceFault = this.pieceFaults.shift();
    if (pieceFault) throw new LfsRefused(pieceFault);
    const each = this.uploads.get(id);
    if (!each) throw new LfsRefused("notFound");
    const { upload } = each;
    if (upload.state !== "receiving") return upload;
    if (offset + piece.size <= upload.received) return upload;
    if (offset !== upload.received) throw new LfsRefused("offset", { received: upload.received });
    if (piece.size > upload.chunk) throw new LfsRefused("tooLarge");
    this.pieces.push(piece.size);
    each.bytes.push(new Uint8Array(await piece.arrayBuffer()));
    each.upload = { ...upload, received: upload.received + piece.size };
    return each.upload;
  }

  async state(id: string): Promise<LfsUpload> {
    this.#fault();
    const each = this.uploads.get(id);
    if (!each) throw new LfsRefused("notFound");
    const { upload } = each;
    if (upload.state === "receiving" && upload.received === upload.size) {
      const whole = new Blob(each.bytes.map((bytes) => bytes.slice()));
      const oid = lfsOidOf(await hashFile(whole));
      each.upload =
        oid === each.expected
          ? { ...upload, state: "received" }
          : { ...upload, state: "failed", error: "changed" };
    } else if (upload.state === "received") each.upload = { ...upload, state: "pushing" };
    else if (upload.state === "pushing" && (each.asked += 1) >= this.pushingFor) {
      each.upload = { ...upload, state: "done" };
      this.stored.set(upload.oid, upload.size);
    }
    return each.upload;
  }

  async cancel(id: string): Promise<void> {
    const each = this.uploads.get(id);
    if (each) each.upload = { ...each.upload, state: "failed", error: "cancelled" };
  }

  /** What the platform has of the file of an upload, put together. */
  received(id: string): Blob {
    return new Blob((this.uploads.get(id)?.bytes ?? []).map((bytes) => bytes.slice()));
  }
}

/** Time that goes as fast as the tests can: every wait is over at once, a moment later. */
const environment = (): UploadEnvironment & { readonly waits: number[] } => {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => (now += 1),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        waits.push(ms);
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
          now += ms;
          resolve();
        }, 0);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    onWake: () => () => {},
  };
};

const bytesOf = (size: number, seed = 1) => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at++) bytes[at] = (at * 31 + seed) % 251;
  return bytes;
};

/** A project with assets of these files, in a window with a queue. */
async function world(
  sizes: readonly number[] = [10_000],
  { browser = new MemoryUploads(), lfs = new FakeLfs() } = {},
) {
  const store = ProjectStore.create(createProject({ name: "片子" }));
  const files = new Map<string, Blob>();
  for (const [index, size] of sizes.entries()) {
    const file = new Blob([bytesOf(size, index + 1)]);
    const id = `asset_${index + 1}`;
    files.set(id, file);
    const done = store.execute({
      type: "asset.add",
      params: {
        id,
        asset: {
          kind: "video",
          storage: "local",
          path: `assets/${id}.mp4`,
          hash: await hashFile(file),
          size,
          name: `视频${index + 1}.mp4`,
        },
      },
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const reads = vi.fn<(asset: string) => void>();
  return windowOf({ store, files, reads, browser, lfs });
}

/** Another window of the same browser, on the same project. */
function windowOf({
  store,
  files,
  reads,
  browser,
  lfs,
  blocked,
}: {
  store: ProjectStore;
  files: Map<string, Blob>;
  reads: ReturnType<typeof vi.fn<(asset: string) => void>>;
  browser: MemoryUploads;
  lfs: FakeLfs;
  blocked?: { value: UploadBlock | undefined };
}) {
  const env = environment();
  const page = { alive: true, asleep: false, isAlive: () => page.alive };
  const uploads: UploadStore = browser.window(page);
  const block = blocked ?? { value: undefined as UploadBlock | undefined };
  const found: { override?: ((asset: string) => FileFound | undefined) | undefined } = {};
  const allDone = vi.fn<(count: number) => void>();
  const failed = vi.fn();
  const queue = new AssetUploads({
    store: uploads,
    lfs: () => lfs,
    project: () => ({
      key: "key-1",
      store,
      project: "platform-1",
      ...(block.value !== undefined && { blocked: block.value }),
    }),
    files: () => ({
      read: async (asset) => {
        reads(asset);
        const override = found.override?.(asset);
        if (override) return override;
        const file = files.get(asset);
        return file ? { kind: "there", file } : { kind: "missing" };
      },
    }),
    environment: env,
    onAllDone: allDone,
    onFailed: failed,
  });
  queue.follow();
  const until = (check: (snapshot: UploadsSnapshot) => boolean, what = "the queue") =>
    vi.waitFor(
      () => {
        if (!check(queue.getSnapshot())) throw new Error(`waiting for ${what}`);
      },
      { timeout: 4000, interval: 2 },
    );
  const placeOf = (asset: string) => store.getState().places?.[asset];
  return {
    store,
    files,
    reads,
    browser,
    lfs,
    uploads,
    queue,
    env,
    page,
    found,
    allDone,
    failed,
    block,
    until,
    placeOf,
    another: () => windowOf({ store, files, reads, browser, lfs, blocked: block }),
  };
}

const phaseOf = (snapshot: UploadsSnapshot, asset: string) =>
  snapshot.items.find((item) => item.asset === asset)?.phase;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("files of assets into the large file storage", () => {
  test("goes there piece by piece, and only then does the asset say so: never before", async () => {
    const w = await world([10_000]);
    w.lfs.pushingFor = 3;
    // Once the platform said it puts the file into the storage, the next question waits.
    let pushing = false;
    let asked: () => void = () => {};
    const askedAgain = new Promise<void>((resolve) => (asked = resolve));
    let go: () => void = () => {};
    const gate = new Promise<void>((resolve) => (go = resolve));
    const state = w.lfs.state.bind(w.lfs);
    w.lfs.state = async (id) => {
      if (pushing) {
        asked();
        await gate;
      }
      const answer = await state(id);
      if (answer.state === "pushing") pushing = true;
      return answer;
    };
    expect(await w.queue.add(["asset_1"])).toBe(1);
    // All of it sent, checked, and on its way into the storage: the asset says nothing yet.
    // Whichever comes first: the next question, or the asset saying so already.
    await Promise.race([askedAgain, w.until(() => w.placeOf("asset_1") !== undefined)]);
    expect(phaseOf(w.queue.getSnapshot(), "asset_1")).toBe("pushing");
    expect(w.placeOf("asset_1")).toBeUndefined();
    go();
    await w.until((s) => phaseOf(s, "asset_1") === "done", "done");
    expect(w.placeOf("asset_1")).toMatchObject({ storage: "lfs", repo: REPO, size: 10_000 });
    // What the platform got is the file, whole.
    const [id] = [...w.lfs.uploads.keys()];
    expect(await hashFile(w.lfs.received(id!))).toBe(await hashFile(w.files.get("asset_1")!));
    expect(w.allDone).toHaveBeenCalledWith(1);
    // Asked again for a file that is there: nothing to do.
    expect(await w.queue.add(["asset_1"])).toBe(0);
  });

  test("a file the storage has already is there at once", async () => {
    const w = await world([3000]);
    const hash = w.store.getState().assets?.["asset_1"]?.hash as string;
    w.lfs.stored.set(lfsOidOf(hash) as string, 3000);
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    expect(w.lfs.pieces).toEqual([]);
    expect(w.placeOf("asset_1")).toMatchObject({ storage: "lfs", repo: REPO });
  });

  test("another file of the asset meanwhile: this one is there all the same, and the asset says nothing of it", async () => {
    const w = await world([5000]);
    let go: () => void = () => {};
    w.lfs.hold = new Promise((resolve) => (go = resolve));
    await w.queue.add(["asset_1"]);
    await vi.waitFor(() => expect(w.reads).toHaveBeenCalled());
    const other = new Blob([bytesOf(5000, 9)]);
    w.store.execute({
      type: "asset.update",
      params: { asset: "asset_1", changes: { hash: await hashFile(other), size: 5000 } },
    });
    go();
    w.lfs.hold = undefined;
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    expect(w.placeOf("asset_1")).toBeUndefined();
  });

  test("goes on from where it got after the page went away, in the next window, without sending again what the platform has", async () => {
    const w = await world([20_000]);
    w.lfs.chunk = 1024;
    w.lfs.minChunk = 1024;
    let pieces = 0;
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const send = w.lfs.send.bind(w.lfs);
    w.lfs.send = async (...args) => {
      const answer = await send(...args);
      if ((pieces += 1) === 5) {
        stop();
        await new Promise(() => {});
      }
      return answer;
    };
    await w.queue.add(["asset_1"]);
    await stopped;
    // The page goes away, with what it had on its way: as a reload.
    w.page.alive = false;
    w.browser.writers.sweep();
    // What the next window sends, from where.
    const offsets: number[] = [];
    w.lfs.send = (id, offset, piece, options) => {
      offsets.push(offset);
      return send(id, offset, piece, options);
    };
    const next = w.another();
    await next.until((s) => phaseOf(s, "asset_1") === "done", "done in the next window");
    // From where the platform got: never from the start again.
    expect(Math.min(...offsets)).toBe(5 * 1024);
    // Five pieces before, fifteen after: none twice.
    expect(w.lfs.pieces.reduce((all, size) => all + size, 0)).toBe(20_000);
    expect(next.placeOf("asset_1")).toMatchObject({ storage: "lfs" });
  });

  test("pieces get smaller where the platform says they come too slowly, and larger where the line is fast", async () => {
    const w = await world([200_000]);
    w.lfs.chunk = 65_536;
    w.lfs.minChunk = 1024;
    w.lfs.pieceFaults = ["slow", "slow"];
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    const sizes = w.lfs.pieces;
    // The first piece that got through was a quarter of the first one tried.
    expect(sizes[0]).toBeLessThanOrEqual(65_536 / 4);
    // On a fast line they grow again, to as large as the platform takes.
    expect(Math.max(...sizes)).toBe(65_536);
    expect(sizes.reduce((all, size) => all + size, 0)).toBe(200_000);
  });

  test("no network, a busy platform, and a piece that went elsewhere go on by themselves", async () => {
    const w = await world([10_000]);
    w.lfs.faults = ["unavailable", "busy", "unavailable", "unavailable"];
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    expect(w.queue.getSnapshot().items[0]?.problem).toBeUndefined();
    expect(w.failed).not.toHaveBeenCalled();
    // Waited before trying again, longer each time.
    expect(w.env.waits.filter((ms) => ms >= 2000).length).toBeGreaterThan(1);
  });

  test("an upload the platform gave up begins again by itself", async () => {
    const w = await world([4000]);
    w.lfs.chunk = 1024;
    let first = true;
    const send = w.lfs.send.bind(w.lfs);
    w.lfs.send = async (id, offset, piece, options) => {
      if (first && offset === 2048) {
        first = false;
        const each = w.lfs.uploads.get(id)!;
        each.upload = { ...each.upload, state: "expired" };
        return each.upload;
      }
      return send(id, offset, piece, options);
    };
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    expect(w.lfs.uploads.size).toBe(2);
    expect(w.placeOf("asset_1")).toMatchObject({ storage: "lfs" });
  });

  test("a file that changed while it was sent fails as changed, and the asset says nothing", async () => {
    const w = await world([4000]);
    w.lfs.chunk = 1024;
    // What is read is no longer the file of the hash: the platform finds out.
    w.files.set("asset_1", new Blob([bytesOf(4000, 7)]));
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "failed");
    expect(w.queue.getSnapshot().items[0]?.problem).toBe("changed");
    expect(w.placeOf("asset_1")).toBeUndefined();
    expect(w.failed).toHaveBeenCalledWith(expect.objectContaining({ problem: "changed" }));
    // As the queue reads it itself.
    const v = await world([4000]);
    v.found.override = () => ({ kind: "changed" });
    await v.queue.add(["asset_1"]);
    await v.until((s) => phaseOf(s, "asset_1") === "failed");
    expect(v.queue.getSnapshot().items[0]?.problem).toBe("changed");
    expect(v.lfs.uploads.size).toBe(0);
  });

  test("what people have to do something about waits for them: no room at GitHub, no file, no access to the folder, signed out", async () => {
    const quota = await world([1000]);
    quota.lfs.faults = ["quota"];
    await quota.queue.add(["asset_1"]);
    await quota.until((s) => phaseOf(s, "asset_1") === "failed");
    expect(quota.queue.getSnapshot().items[0]?.problem).toBe("githubQuota");
    // Tried again once people did something about it.
    await quota.queue.retry("asset_1");
    await quota.until((s) => phaseOf(s, "asset_1") === "done");

    for (const kind of ["missing", "access"] as const) {
      const w = await world([1000]);
      w.found.override = () => ({ kind });
      await w.queue.add(["asset_1"]);
      await w.until((s) => phaseOf(s, "asset_1") === "failed");
      expect(w.queue.getSnapshot().items[0]?.problem).toBe(kind);
      // Allowed again: it goes on.
      w.found.override = undefined;
      await w.queue.retryAll([kind]);
      await w.until((s) => phaseOf(s, "asset_1") === "done");
    }

    const out = await world([1000]);
    out.lfs.faults = ["signedOut"];
    await out.queue.add(["asset_1"]);
    await out.until((s) => phaseOf(s, "asset_1") === "failed");
    expect(out.queue.getSnapshot().items[0]?.problem).toBe("signedOut");
  });

  test("the project's repository unusable, or nobody signed in: nothing goes, nothing fails, and it goes once it can", async () => {
    const w = await world([1000]);
    w.block.value = "repository";
    w.queue.follow();
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "blocked");
    expect(w.lfs.uploads.size).toBe(0);
    w.block.value = undefined;
    w.queue.follow();
    await w.until((s) => phaseOf(s, "asset_1") === "done");
  });

  test("paused, it stays paused, also in the next window; cancelled, the platform lets go of it too", async () => {
    const w = await world([50_000, 50_000]);
    w.lfs.chunk = 1024;
    w.lfs.minChunk = 1024;
    await w.queue.add(["asset_1", "asset_2"]);
    await w.until((s) => (s.items[0]?.received ?? 0) > 0);
    await w.queue.pause("asset_1");
    await w.until((s) => phaseOf(s, "asset_1") === "paused");
    const at = w.queue.getSnapshot().items[0]?.received ?? 0;
    await w.queue.cancel("asset_2");
    await w.until((s) => s.items.length === 1);
    const cancelled = [...w.lfs.uploads.values()].find(
      (each) => each.upload.oid !== undefined && each.upload.state === "failed",
    );
    expect(cancelled?.upload.error).toBe("cancelled");
    // The page goes; in the next window it is still paused, where it was.
    w.page.alive = false;
    w.browser.writers.sweep();
    const next = w.another();
    await next.until((s) => s.sender === "here");
    expect(phaseOf(next.queue.getSnapshot(), "asset_1")).toBe("paused");
    await next.queue.resume("asset_1");
    await next.until((s) => phaseOf(s, "asset_1") === "done");
    expect(next.queue.getSnapshot().items[0]?.received).toBe(50_000);
    expect(at).toBeGreaterThan(0);
    expect(next.placeOf("asset_2")).toBeUndefined();
  });

  test("only one window sends: the other shows how it goes, and what it asks for the one that sends does", async () => {
    const w = await world([30_000]);
    w.lfs.chunk = 1024;
    w.lfs.minChunk = 1024;
    const other = w.another();
    await w.until((s) => s.sender === "here", "here");
    await other.until((s) => s.sender === "elsewhere", "elsewhere");
    // Three pieces, and then the line holds the next one until the test lets it go.
    let go: () => void = () => {};
    const send = w.lfs.send.bind(w.lfs);
    w.lfs.send = async (id, offset, piece, options) => {
      if (offset === 3072) w.lfs.hold ??= new Promise((resolve) => (go = resolve));
      return send(id, offset, piece, options);
    };
    // Asked for in the other window: the one that sends sends it.
    await other.queue.add(["asset_1"]);
    await w.until((s) => (s.items[0]?.received ?? 0) === 3072, "sent here");
    await other.until(
      (s) => s.items[0]?.received === 3072 && phaseOf(s, "asset_1") === "sending",
      "heard there",
    );
    // Only the one that sends read the file.
    expect(w.reads).toHaveBeenCalled();
    expect(other.reads).toHaveBeenCalledTimes(w.reads.mock.calls.length);
    // Paused there: it stops here.
    await other.queue.pause("asset_1");
    await w.until((s) => phaseOf(s, "asset_1") === "paused", "paused here");
    w.lfs.hold = undefined;
    w.lfs.send = send;
    go();
    // The one that sends goes away: the other takes over, from where it got.
    w.page.alive = false;
    await w.queue.close();
    await other.until((s) => s.sender === "here", "taken over");
    await other.queue.resume("asset_1");
    await other.until((s) => phaseOf(s, "asset_1") === "done", "done there");
    const sent = w.lfs.pieces.reduce((all, size) => all + size, 0);
    expect(sent).toBe(30_000);
  });

  test("closing the project stops it where it is, and nothing is written for it", async () => {
    const w = await world([30_000]);
    w.lfs.chunk = 1024;
    w.lfs.minChunk = 1024;
    await w.queue.add(["asset_1"]);
    await w.until((s) => (s.items[0]?.received ?? 0) > 0);
    await w.queue.close();
    const sent = w.lfs.pieces.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.lfs.pieces.length).toBe(sent);
    expect(w.placeOf("asset_1")).toBeUndefined();
    // Still on its way, for the start page and the next time.
    const kept = await w.uploads.list();
    expect(kept).toMatchObject([{ asset: "asset_1", state: "waiting" }]);
    expect(unfinishedByProject(kept)).toEqual(new Map([["key-1", 1]]));
  });

  test("three files at a time, the rest wait their turn and say how many are before them", async () => {
    const w = await world([2000, 2000, 2000, 2000, 2000]);
    let go: () => void = () => {};
    w.lfs.hold = new Promise((resolve) => (go = resolve));
    await w.queue.add(["asset_1", "asset_2", "asset_3", "asset_4", "asset_5"]);
    await w.until(
      (s) => s.items.filter((item) => item.phase === "queued").length === 2,
      "two waiting",
    );
    expect(w.queue.getSnapshot().items.map((item) => item.ahead ?? null)).toEqual([
      null,
      null,
      null,
      0,
      1,
    ]);
    go();
    w.lfs.hold = undefined;
    await w.until((s) => s.items.every((item) => item.phase === "done"));
    expect(w.allDone).toHaveBeenCalledWith(5);
    await w.queue.clearDone();
    await w.until((s) => s.items.length === 0);
  });
});

describe("another file of an asset that is in the storage", () => {
  test("goes where the one before went, by itself, and says it is the new file", async () => {
    const w = await world([3000]);
    await w.queue.add(["asset_1"]);
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    const before = w.placeOf("asset_1");
    const other = new Blob([bytesOf(3000, 5)]);
    w.files.set("asset_1", other);
    w.store.execute({
      type: "asset.update",
      params: { asset: "asset_1", changes: { hash: await hashFile(other), size: 3000 } },
    });
    await w.until((s) => s.items[0]?.replaced === true, "asked for by itself");
    await w.until((s) => phaseOf(s, "asset_1") === "done");
    const after = w.placeOf("asset_1");
    expect(after?.hash).toBe(await hashFile(other));
    expect(after?.hash).not.toBe(before?.hash);
    // A file that was only here stays here.
    const v = await world([3000]);
    const another = new Blob([bytesOf(3000, 6)]);
    v.store.execute({
      type: "asset.update",
      params: { asset: "asset_1", changes: { hash: await hashFile(another), size: 3000 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(v.queue.getSnapshot().items).toEqual([]);
  });
});
