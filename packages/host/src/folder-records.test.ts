import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createRecordStore, memoryRecordStore } from "./folder-records.ts";
import type { DirectoryHandleLike } from "./handles.ts";
import type { RecordStore, StoredRecord } from "./local-folders.ts";

/** A handle as IndexedDB keeps it: what it can be cloned to. */
const record = (id: string, project = "项目", openedAt = 1): StoredRecord => ({
  id,
  handle: { kind: "directory", name: `文件夹 ${id}` } as unknown as DirectoryHandleLike,
  project,
  name: `原子 ${id}`,
  openedAt,
});

describe.each([
  ["in a database of their own", () => createRecordStore(() => new IDBFactory())],
  ["in memory", memoryRecordStore],
] as const)("folders that were opened, %s", (_, create: () => RecordStore) => {
  it("are kept by their number", async () => {
    const store = create();
    await store.put(record("a"));
    await store.put(record("b"));
    expect(await store.get("a")).toEqual(record("a"));
    expect(await store.get("nothing")).toBeUndefined();
    expect((await store.list()).map(({ id }) => id).toSorted()).toEqual(["a", "b"]);
  });

  it("are replaced by one with the same number", async () => {
    const store = create();
    await store.put(record("a", "项目", 1));
    await store.put(record("a", "项目", 2));
    expect(await store.list()).toEqual([record("a", "项目", 2)]);
  });

  it("are found by the project in them", async () => {
    const store = create();
    await store.put(record("a", "x"));
    await store.put(record("b", "y"));
    await store.put(record("c", "x"));
    expect((await store.withProject("x")).map(({ id }) => id).toSorted()).toEqual(["a", "c"]);
    expect(await store.withProject("z")).toEqual([]);
  });

  it("go off the list", async () => {
    const store = create();
    await store.put(record("a"));
    await store.remove("a");
    await store.remove("nothing");
    expect(await store.list()).toEqual([]);
  });
});

describe("the database of folders", () => {
  it("is there for the next page", async () => {
    const factory = new IDBFactory();
    await createRecordStore(() => factory).put(record("a"));
    expect(await createRecordStore(() => factory).get("a")).toEqual(record("a"));
  });

  it("is a database of its own, so that the main one keeps its version", async () => {
    const factory = new IDBFactory();
    await createRecordStore(() => factory).list();
    expect((await factory.databases()).map(({ name }) => name)).toEqual(["animaquill-folders"]);
  });

  it("does not remember that it could not be opened", async () => {
    let fails = true;
    const factory = new IDBFactory();
    const store = createRecordStore(() => {
      if (fails) throw new DOMException("blocked", "SecurityError");
      return factory;
    });
    await expect(store.list()).rejects.toThrow("blocked");
    fails = false;
    expect(await store.list()).toEqual([]);
  });
});
