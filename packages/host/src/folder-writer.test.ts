import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserFolderWriter } from "./folder-writer.ts";
import type { WriterClaim } from "./index.ts";
import { MemoryDisk, memoryFolders } from "./memory-disk.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Whether a promise settled by now. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

describe("the turn to write a folder, among the pages of a browser in memory", () => {
  it("goes to one page at a time, and to the next once it lets go", async () => {
    const disk = new MemoryDisk();
    const first = memoryFolders(disk).writer("本机1");
    const second = memoryFolders(disk).writer("本机1");
    const claim = await first.claim();
    const onWaiting = vi.fn();
    const next = second.claim({ onWaiting });
    expect(await isSettled(next)).toBe(false);
    expect(onWaiting).toHaveBeenCalledOnce();
    claim.release();
    expect(await isSettled(claim.lost)).toBe(true);
    expect(await isSettled(next)).toBe(true);
  });

  it("is one for each folder", async () => {
    const disk = new MemoryDisk();
    await memoryFolders(disk).writer("本机1").claim();
    expect(await isSettled(memoryFolders(disk).writer("本机2").claim())).toBe(true);
  });

  it("can be taken over from a page that sleeps, which no longer answers", async () => {
    const disk = new MemoryDisk();
    const sleeping = memoryFolders(disk);
    const claim = await sleeping.writer("本机1").claim();
    const other = memoryFolders(disk).writer("本机1");
    expect(await other.answers(1000)).toBe(true);
    disk.sleep(sleeping);
    const answer = other.answers(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toBe(false);
    const taken = await other.claim({ steal: true });
    expect(await isSettled(claim.lost)).toBe(true);
    // Letting go of what it no longer has changes nothing for the one that has it now.
    claim.release();
    expect(await isSettled(taken.lost)).toBe(false);
  });

  it("goes with the pages of a browser that went away", async () => {
    const disk = new MemoryDisk();
    const claim: WriterClaim = await memoryFolders(disk).writer("本机1").claim();
    disk.crash();
    expect(await isSettled(claim.lost)).toBe(true);
    expect(await isSettled(memoryFolders(disk).writer("本机1").claim())).toBe(true);
  });

  it("is not waited for any more when asked", async () => {
    const disk = new MemoryDisk();
    await memoryFolders(disk).writer("本机1").claim();
    const stop = new AbortController();
    const waiting = memoryFolders(disk).writer("本机1").claim({ signal: stop.signal });
    stop.abort(new Error("不等了"));
    await expect(waiting).rejects.toThrow("不等了");
  });
});

describe("the turn to write a folder, with the Web Locks of Node", () => {
  const locks = () => (globalThis.navigator as Navigator & { locks?: LockManager }).locks;

  it.skipIf(!locks())(
    "tells the one of two that ask at once and has to wait that it waits",
    async () => {
      vi.useRealTimers();
      for (let round = 0; round < 5; round++) {
        const name = `本机-${round}-${Math.random()}`;
        const pages = [browserFolderWriter(name, locks), browserFolderWriter(name, locks)];
        const told = pages.map(() => ({ waiting: false, granted: false }));
        const claims = pages.map((writer, index) =>
          writer
            .claim({ onWaiting: () => ((told[index] as { waiting: boolean }).waiting = true) })
            .then((claim) => {
              (told[index] as { granted: boolean }).granted = true;
              return claim;
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        // One writes, and the other one knows that it waits.
        expect(told.filter(({ granted }) => granted)).toHaveLength(1);
        expect(told.every(({ granted, waiting }) => granted || waiting)).toBe(true);
        const first = await Promise.race(claims);
        first.release();
        for (const claim of await Promise.all(claims)) claim.release();
      }
    },
  );
});
