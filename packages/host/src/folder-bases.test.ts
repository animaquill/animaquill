import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createBaseStore, memoryBaseStore, memoryBases } from "./folder-records.ts";
import type { FolderBases } from "./index.ts";

const stat = { size: 2, lastModified: 1 };

describe.each([
  ["in the database of folders", () => createBaseStore(() => new IDBFactory())],
  ["in memory", () => memoryBaseStore(memoryBases())],
] as const)("what is kept about the files of a folder, %s", (_, create: () => FolderBases) => {
  it("is kept by folder and path, in place of what was there", async () => {
    const bases = create();
    const turn = await bases.claim("本机1");
    expect(
      await bases.save("本机1", turn, {
        put: [
          { path: "a.json", base: "{}", stat, synced: "x" },
          { path: "b.json", base: "[]" },
        ],
      }),
    ).toBe(true);
    await bases.save("本机1", turn, { put: [{ path: "a.json", intent: "y" }], remove: ["b.json"] });
    expect(await bases.load("本机1")).toEqual([{ path: "a.json", intent: "y" }]);
    expect(await bases.load("本机2")).toEqual([]);
  });

  it("is kept by the window whose turn it is, and nothing of one that lost its turn", async () => {
    const bases = create();
    const before = await bases.claim("本机1");
    const now = await bases.claim("本机1");
    expect(now).toBeGreaterThan(before);
    expect(await bases.save("本机1", before, { put: [{ path: "a.json", base: "旧的" }] })).toBe(
      false,
    );
    expect(await bases.load("本机1")).toEqual([]);
    expect(await bases.save("本机1", now, { put: [{ path: "a.json", base: "新的" }] })).toBe(true);
    expect(await bases.load("本机1")).toEqual([{ path: "a.json", base: "新的" }]);
  });

  it("can be replaced as a whole", async () => {
    const bases = create();
    const turn = await bases.claim("本机1");
    await bases.save("本机1", turn, { put: [{ path: "a.json", base: "1" }] });
    await bases.save("本机1", turn, { put: [{ path: "b.json", base: "2" }], replace: true });
    expect(await bases.load("本机1")).toEqual([{ path: "b.json", base: "2" }]);
  });

  it("goes when the folder goes off the list", async () => {
    const bases = create();
    const turn = await bases.claim("本机1");
    await bases.save("本机1", turn, { put: [{ path: "a.json", base: "1" }] });
    await bases.keepHash("本机1", { path: "assets/a.webm", ...stat, hash: "sha256-a" });
    await bases.forget("本机1");
    expect(await bases.load("本机1")).toEqual([]);
    expect(await bases.claim("本机1")).toBe(1);
    expect(await bases.hashOf("本机1", "assets/a.webm")).toBeUndefined();
  });

  it("has the hashes of files, by folder and path, from any window", async () => {
    const bases = create();
    const hash = { path: "assets/a.webm", ...stat, hash: "sha256-a" };
    await bases.keepHash("本机1", hash);
    await bases.keepHash("本机1", { ...hash, size: 3, hash: "sha256-b" });
    expect(await bases.hashOf("本机1", "assets/a.webm")).toEqual({
      ...hash,
      size: 3,
      hash: "sha256-b",
    });
    expect(await bases.hashOf("本机2", "assets/a.webm")).toBeUndefined();
    // Nothing of what is kept about the files of the folder goes with it.
    expect(await bases.load("本机1")).toEqual([]);
  });
});
