import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createWorkCache } from "./caches.ts";

describe("what the editor worked out", () => {
  it("is there the next time, also for another page", async () => {
    const factory = new IDBFactory();
    await createWorkCache(() => factory).write("a", { objects: [1, 2] });
    expect(await createWorkCache(() => factory).read("a")).toEqual({ objects: [1, 2] });
    expect(await createWorkCache(() => factory).read("b")).toBeUndefined();
  });

  it("keeps what was used last, and lets the rest go", async () => {
    const factory = new IDBFactory();
    let now = 0;
    const cache = createWorkCache(
      () => factory,
      2,
      () => (now += 1),
    );
    await cache.write("a", 1);
    await cache.write("b", 2);
    await cache.read("a");
    await cache.write("c", 3);
    expect(await cache.read("a")).toBe(1);
    expect(await cache.read("b")).toBeUndefined();
    expect(await cache.read("c")).toBe(3);
  });

  it("fails without anybody noticing, because it can all be worked out again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = createWorkCache(() => {
      throw new Error("no database here");
    });
    await expect(broken.write("a", 1)).resolves.toBeUndefined();
    await expect(broken.read("a")).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
