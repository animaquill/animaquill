import { orderedTracks, ProjectStore } from "@animaquill/core";
import {
  CloudSignedOut,
  LfsRefused,
  type DownloadedPiece,
  type LfsAccess,
  type LfsObjectState,
} from "@animaquill/host";
import { MemoryDownloads } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { createProject, lfsOidOf } from "@animaquill/schema";
import { describe, expect, test, vi } from "vitest";
import type { MissingFiles } from "../resources/missing-files.ts";
import { Emitter } from "../workbench/emitter.ts";
import {
  assembled,
  AssetDownloads,
  downloadTotals,
  PIECE_MOST,
  type DownloadsSnapshot,
  type DownloadTarget,
  type Playhead,
  type WriteResult,
} from "./downloads.ts";
import type { UploadEnvironment } from "./uploads.ts";

/**
 * The files of assets that come out of the large file storage (downloads.ts), against a platform
 * in memory that answers as the real one does (apps/api/src/lfs/downloads.ts of AnimaQuill Cloud):
 * a file goes where it belongs only once all of it is here and it is the asset's file, by its size
 * and hash; what came is kept, and a reload or another window goes on from there; the file nearest
 * the playhead comes first; what goes by itself goes by itself, and what people have to do
 * something about waits for them; only one window downloads.
 */

/** The platform's side: the storage by oid, and what it is asked. */
class FakeLfs implements LfsAccess {
  readonly stored = new Map<string, Uint8Array>();
  /** Of the next lookups, what the platform says of an oid in place of what it has. */
  readonly says = new Map<string, LfsObjectState>();
  /** Where each piece asked for begins, by oid. */
  readonly asked: [string, number][] = [];
  /** The next pieces fail with this. */
  failNext: Error[] = [];
  /** The next pieces stop after half of what they bring, as a connection that breaks. */
  cutNext = 0;
  /** Bytes a piece brings at most, as a platform that gives less at a time. */
  most = Infinity;
  /** Holds every piece until a test lets it go. */
  hold: Promise<void> | undefined;
  /** Pieces that go before `hold` holds the rest. */
  pass = 0;

  async begin(): Promise<never> {
    throw new Error("not here");
  }
  async send(): Promise<never> {
    throw new Error("not here");
  }
  async state(): Promise<never> {
    throw new Error("not here");
  }
  async cancel(): Promise<void> {}

  async lookup(
    _project: string,
    objects: readonly { readonly oid: string; readonly size: number }[],
  ): Promise<readonly LfsObjectState[]> {
    return objects.map(({ oid, size }) => {
      const said = this.says.get(oid);
      if (said) return said;
      const there = this.stored.get(oid);
      return !there
        ? { state: "missing" }
        : there.length === size
          ? { state: "ready" }
          : { state: "changed" };
    });
  }

  async piece(
    _project: string,
    { oid, size }: { readonly oid: string; readonly size: number },
    start: number,
    end: number,
    { signal, onBytes }: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
  ): Promise<DownloadedPiece> {
    this.asked.push([oid, start]);
    if (this.pass > 0) this.pass -= 1;
    else if (this.hold) await this.hold;
    signal?.throwIfAborted();
    const failure = this.failNext.shift();
    if (failure) throw failure;
    const there = this.stored.get(oid);
    if (!there) throw new LfsRefused("missing");
    if (there.length !== size) throw new LfsRefused("changed");
    let bytes = there.slice(start, Math.min(end + 1, start + this.most));
    if (this.cutNext > 0) {
      this.cutNext -= 1;
      bytes = bytes.slice(0, Math.floor(bytes.length / 2));
    }
    onBytes?.(bytes.length);
    return { start, bytes: new Blob([bytes]) };
  }
}

/** Time that goes on by itself, as fast as the tests can. */
const environment = (): UploadEnvironment & { tick(ms: number): void } => {
  let now = 1_000_000;
  return {
    now: () => now,
    tick: (ms) => {
      now += ms;
    },
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        setTimeout(resolve, 0);
        now += ms;
      }),
    onWake: () => () => {},
  };
};

const bytesOf = (size: number, seed = 1) => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at++) bytes[at] = (at * 31 + seed) % 251;
  return bytes;
};

interface File {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
  /** Where its clip begins on the main timeline, or undefined for an asset no clip uses. */
  readonly at?: number;
}

/** A project of these files, which this computer does not have, and which the storage has. */
async function project(files: readonly { size: number; at?: number }[], lfs = new FakeLfs()) {
  const store = ProjectStore.create(createProject({ name: "片子" }));
  const made: File[] = [];
  const track = orderedTracks(store.getState().timelines["main"] as never).find(
    ({ kind }) => kind === "video",
  )?.id;
  for (const [index, { size, at }] of files.entries()) {
    const bytes = bytesOf(size, index + 1);
    const hash = await hashFile(new Blob([bytes]));
    const id = `asset_${index + 1}`;
    const added = store.execute({
      type: "asset.add",
      params: {
        id,
        asset: {
          kind: "video",
          storage: "local",
          path: `assets/${id}.mp4`,
          hash,
          size,
          name: `视频${index + 1}.mp4`,
        },
      },
    });
    if (!added.ok) throw new Error(JSON.stringify(added.error));
    if (at !== undefined) {
      const clip = store.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track,
          id: `clip_${index + 1}`,
          start: String(at),
          duration: "2",
          source: { kind: "video", media: { asset: id } },
        },
      });
      if (!clip.ok) throw new Error(JSON.stringify(clip.error));
    }
    lfs.stored.set(lfsOidOf(hash) as string, bytes);
    made.push({ id, bytes, hash, ...(at !== undefined && { at }) });
  }
  return { store, files: made, lfs, browser: new MemoryDownloads() };
}

type Project = Awaited<ReturnType<typeof project>>;

/** A window of the browser on the project, with a queue, and where its files go. */
function windowOf(
  { store, files, lfs, browser }: Project,
  {
    written = new Map<string, Uint8Array>(),
    answer = (): WriteResult => "written",
    playhead = { timeline: "main", seconds: 0, playing: false } as Playhead,
    room,
  }: {
    written?: Map<string, Uint8Array>;
    answer?: (asset: string) => WriteResult;
    playhead?: Playhead;
    room?: { quota: number; usage: number };
  } = {},
) {
  const env = environment();
  const page = { alive: true, asleep: false, isAlive: () => page.alive };
  const missing = new Emitter();
  const lacking: { value: MissingFiles } = {
    value: new Map(
      files
        .filter(({ id }) => !written.has(id))
        .map(({ id }) => [id, { asset: id, path: `assets/${id}.mp4`, elsewhere: "lfs" as const }]),
    ),
  };
  const head = { value: playhead };
  const moved = new Emitter();
  const writes = vi.fn<(asset: string) => void>();
  const target: DownloadTarget = {
    inBrowser: false,
    write: async ({ id }, file) => {
      writes(id);
      const result = answer(id);
      if (result !== "written") return result;
      written.set(id, new Uint8Array(await file.arrayBuffer()));
      // The file is here now: nothing lacks it.
      const next = new Map(lacking.value);
      next.delete(id);
      lacking.value = next;
      missing.emit();
      return "written";
    },
  };
  const queue = new AssetDownloads({
    store: browser.window(page),
    lfs: () => lfs,
    project: () => ({ key: "key-1", store, project: "platform-1" }),
    missing: () => lacking.value,
    subscribeMissing: missing.subscribe,
    target: () => target,
    hash: (file) => hashFile(file),
    playhead: () => head.value,
    subscribePlayhead: moved.subscribe,
    ...(room && { estimate: async () => room }),
    environment: env,
  });
  queue.follow();
  const until = (check: (snapshot: DownloadsSnapshot) => boolean, what = "the queue") =>
    vi.waitFor(
      () => {
        if (!check(queue.getSnapshot()))
          throw new Error(`${what}: ${JSON.stringify(queue.getSnapshot())}`);
      },
      { timeout: 4000, interval: 2 },
    );
  const phaseOf = (asset: string) => queue.getSnapshot().items.find((item) => item.asset === asset);
  return { queue, written, writes, env, page, until, phaseOf, lacking, missing, head, moved };
}

describe("downloads out of the large file storage", () => {
  test("what clips use comes, checked, nearest the playhead first, and goes where it belongs", async () => {
    const p = await project([
      { size: 3000, at: 20 },
      { size: 5000, at: 0 },
      { size: 4000, at: 9 },
      // No clip uses it: it stays until people ask for it.
      { size: 100 },
    ]);
    const w = windowOf(p);
    await w.until(({ items }) => items.filter(({ phase }) => phase === "done").length === 3);
    for (const file of p.files.slice(0, 3)) expect(w.written.get(file.id)).toEqual(file.bytes);
    expect(w.written.has("asset_4")).toBe(false);
    // Under the playhead, then 9 seconds on, then 20.
    expect(w.writes.mock.calls.map(([asset]) => asset)).toEqual(["asset_2", "asset_3", "asset_1"]);
    expect(w.queue.getSnapshot().unused).toEqual({ count: 1, bytes: 100 });
    // What came goes from this browser once it is where it belongs.
    for (const file of p.files) expect(p.browser.keptOf(lfsOidOf(file.hash) as string)).toEqual([]);

    w.queue.downloadUnused();
    await w.until(() => w.written.has("asset_4"));
    expect(w.queue.getSnapshot().unused).toEqual({ count: 0, bytes: 0 });
  });

  test("a large file comes a piece at a time, each kept, and after a reload it goes on from there", async () => {
    const size = 300_005;
    const p = await project([{ size, at: 0 }]);
    const oid = lfsOidOf(p.files[0]!.hash) as string;
    // A platform that gives less at a time than asked for; after its first piece, the line stops.
    p.lfs.most = 100_000;
    p.lfs.pass = 1;
    p.lfs.hold = new Promise(() => {});
    const first = windowOf(p);
    await vi.waitFor(() => expect(p.browser.keptOf(oid).length).toBe(1));
    p.lfs.hold = undefined;
    // The page goes away after the first piece.
    await first.queue.close();
    first.page.alive = false;
    const kept = p.browser.keptOf(oid).reduce((all, { bytes }) => all + bytes.size, 0);
    expect(kept).toBeGreaterThan(0);
    const asked = p.lfs.asked.length;

    const written = new Map<string, Uint8Array>();
    const second = windowOf(p, { written });
    await second.until(({ items }) => items[0]?.phase === "done");
    expect(written.get("asset_1")).toEqual(p.files[0]!.bytes);
    // From where it got, not from the start.
    const after = p.lfs.asked.slice(asked).map(([, start]) => start);
    expect(after[0]).toBe(kept);
    expect(after).not.toContain(0);
  }, 20_000);

  test("a piece that breaks off is kept as far as it came, and the next goes on from there", async () => {
    const p = await project([{ size: 6000, at: 0 }]);
    p.lfs.cutNext = 1;
    const w = windowOf(p);
    await w.until(({ items }) => items[0]?.phase === "done");
    expect(w.written.get("asset_1")).toEqual(p.files[0]!.bytes);
    expect(p.lfs.asked.map(([, start]) => start)).toEqual([0, 3000]);
  });

  test("what is not the file never goes where it belongs: it comes again once, and then fails", async () => {
    const p = await project([{ size: 2000, at: 0 }]);
    const oid = lfsOidOf(p.files[0]!.hash) as string;
    // The storage has other bytes of the same size under the oid.
    p.lfs.stored.set(oid, bytesOf(2000, 99));
    const w = windowOf(p);
    await w.until(({ items }) => items[0]?.phase === "failed");
    expect(w.phaseOf("asset_1")).toMatchObject({ problem: "changed" });
    expect(w.writes).not.toHaveBeenCalled();
    expect(p.lfs.asked.length).toBe(2);
    expect(p.browser.keptOf(oid)).toEqual([]);
    // Right again, and tried again: it comes.
    p.lfs.stored.set(oid, p.files[0]!.bytes);
    w.queue.retry();
    await w.until(({ items }) => items[0]?.phase === "done");
    expect(w.written.get("asset_1")).toEqual(p.files[0]!.bytes);
  });

  test("another file where it goes is not written over", async () => {
    const p = await project([{ size: 1000, at: 0 }]);
    const w = windowOf(p, { answer: () => "occupied" });
    await w.until(({ items }) => items[0]?.phase === "failed");
    expect(w.phaseOf("asset_1")).toMatchObject({ problem: "occupied" });
    expect(w.written.size).toBe(0);
  });

  test("checked and waiting for the folder, it goes there once people allow it", async () => {
    const p = await project([{ size: 1000, at: 0 }]);
    let allowed = false;
    const w = windowOf(p, { answer: () => (allowed ? "written" : "access") });
    await w.until(({ items }) => items[0]?.phase === "access");
    const asked = p.lfs.asked.length;
    allowed = true;
    w.queue.retryAll(["access"]);
    await w.until(({ items }) => items[0]?.phase === "done");
    // Nothing came again for it.
    expect(p.lfs.asked.length).toBe(asked);
  });

  test("what goes by itself, and what waits for people", async () => {
    const p = await project([
      { size: 500, at: 0 },
      { size: 600, at: 3 },
      { size: 700, at: 6 },
      { size: 800, at: 9 },
    ]);
    const [one, two, three, four] = p.files.map(({ hash }) => lfsOidOf(hash) as string);
    // Another computer still uploads one; the storage lacks another.
    p.lfs.says.set(two!, { state: "uploading", received: 300, size: 600 });
    p.lfs.stored.delete(three!);
    // The first piece finds nobody signed in, the next one the network gone.
    p.lfs.failNext = [new CloudSignedOut("signed out"), new LfsRefused("unavailable")];
    const w = windowOf(p);
    await w.until(
      ({ items }) =>
        items.find(({ asset }) => asset === "asset_3")?.phase === "failed" &&
        items.find(({ asset }) => asset === "asset_2")?.phase === "uploading" &&
        items.find(({ asset }) => asset === "asset_1")?.phase === "failed",
    );
    expect(w.phaseOf("asset_1")).toMatchObject({ problem: "signedOut" });
    expect(w.phaseOf("asset_2")).toMatchObject({ uploading: { received: 300, size: 600 } });
    expect(w.phaseOf("asset_3")).toMatchObject({ problem: "missing" });
    // No answer is no failure: it came after all.
    await w.until(() => w.written.has("asset_4"));
    expect(downloadTotals(w.queue.getSnapshot())).toMatchObject({ failed: 2, needsPeople: true });

    // Uploaded meanwhile: asked again a while later, it comes.
    p.lfs.says.delete(two!);
    w.env.tick(31_000);
    w.queue.retry("asset_1");
    await w.until(() => w.written.has("asset_2") && w.written.has("asset_1"));
    void one;
    void four;
  }, 20_000);

  test("no room in this browser: nothing comes, and it says how much more it needs", async () => {
    const p = await project([{ size: 5000, at: 0 }]);
    const w = windowOf(p, { room: { quota: 10_000, usage: 8000 } });
    await w.until(({ items }) => items[0]?.phase === "failed");
    expect(w.phaseOf("asset_1")).toMatchObject({ problem: "space", need: 3000 });
    expect(p.lfs.asked).toEqual([]);
  });

  test("the playhead moved and stood still: the file under it comes next", async () => {
    const p = await project([
      { size: PIECE_MOST + 10, at: 0 },
      { size: PIECE_MOST + 10, at: 2 },
      { size: 100, at: 50 },
      { size: 100, at: 100 },
    ]);
    p.lfs.most = PIECE_MOST;
    let release!: () => void;
    p.lfs.hold = new Promise((resolve) => {
      release = resolve;
    });
    const w = windowOf(p);
    // The two at the start take both places.
    await vi.waitFor(() => expect(p.lfs.asked.length).toBe(2));
    // People went to 100 seconds and stopped there.
    w.head.value = { timeline: "main", seconds: 100, playing: false };
    w.moved.emit();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(w.queue.getSnapshot().items[0]?.asset).toBe("asset_4");
    release();
    p.lfs.hold = undefined;
    await w.until(({ items }) => items.filter(({ phase }) => phase === "done").length === 4);
    const order = w.writes.mock.calls.map(([asset]) => asset);
    // At the next piece, the one under the playhead went ahead of the rest.
    expect(order[0]).toBe("asset_4");
    expect(order.indexOf("asset_3")).toBeLessThan(order.indexOf("asset_1"));
  }, 20_000);

  test("only one window downloads; another one sees how it goes, and pauses it", async () => {
    const p = await project([{ size: 200_000, at: 0 }]);
    p.lfs.most = 10_000;
    p.lfs.pass = 3;
    let release!: () => void;
    p.lfs.hold = new Promise((resolve) => {
      release = resolve;
    });
    const one = windowOf(p);
    const two = windowOf(p);
    await one.until(({ sender }) => sender === "here");
    await two.until(({ sender }) => sender === "elsewhere");
    await two.until(({ items }) => (items[0]?.received ?? 0) > 0, "the other window");
    await two.queue.setPaused(true);
    await one.until(({ paused, items }) => paused && items[0]?.phase === "paused");
    const asked = p.lfs.asked.length;
    release();
    p.lfs.hold = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Paused, nothing more is asked for.
    expect(p.lfs.asked.length).toBe(asked);
    expect(one.written.size).toBe(0);
    await two.queue.setPaused(false);
    // The window that downloads goes away: the other one takes over, from where it got.
    await one.queue.close();
    await two.until(({ sender }) => sender === "here");
    await two.until(({ items }) => items[0]?.phase === "done");
    expect(two.written.get("asset_1")).toEqual(p.files[0]!.bytes);
    expect(one.written.size).toBe(0);
  }, 20_000);

  test("pieces of other sizes put together without a gap", async () => {
    const all = bytesOf(100);
    const piece = (start: number, end: number) => ({
      start,
      bytes: new Blob([all.slice(start, end)]),
    });
    const { file, bytes } = assembled(
      [piece(0, 40), piece(30, 70), piece(20, 50), piece(80, 100)],
      100,
    );
    expect(bytes).toBe(70);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(all.slice(0, 70));
  });
});
