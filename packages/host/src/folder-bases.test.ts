import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  createBaseStore,
  createRecordStore,
  memoryBaseStore,
  memoryBases,
} from "./folder-records.ts";
import type { DirectoryHandleLike } from "./handles.ts";
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
    await bases.forget("本机1");
    expect(await bases.load("本机1")).toEqual([]);
    expect(await bases.claim("本机1")).toBe(1);
  });
});

describe("the database of folders", () => {
  it("keeps the folders that were opened when it gets what is kept about files", async () => {
    const factory = new IDBFactory();
    // As the first version left it.
    const request = factory.open("animaquill-folders", 1);
    request.addEventListener("upgradeneeded", () => {
      const folders = request.result.createObjectStore("folders", { keyPath: "id" });
      folders.createIndex("project", "project");
      folders.put({
        id: "本机1",
        handle: { kind: "directory", name: "原子" } as unknown as DirectoryHandleLike,
        project: "项目",
        name: "原子",
        openedAt: 1,
      });
    });
    await new Promise((resolve) => request.addEventListener("success", resolve));
    request.result.close();
    expect((await createRecordStore(() => factory).get("本机1"))?.name).toBe("原子");
    const bases = createBaseStore(() => factory);
    expect(await bases.save("本机1", await bases.claim("本机1"), { put: [{ path: "a" }] })).toBe(
      true,
    );
  });
});
