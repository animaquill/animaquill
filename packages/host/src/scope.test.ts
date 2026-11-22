import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserHost,
  dropUnscopedData,
  unscopedDatabases,
  unscopedUnsent,
} from "./browser.ts";
import { OFFLINE_SCOPE, onlineScope, resetStorageScope, scoped, setStorageScope } from "./scope.ts";

/**
 * What the browser keeps, by mode and by account (docs/design/online-offline.md of AnimaQuill
 * Cloud, 2.1): the offline mode never sees what the online one keeps, nor one account another's.
 */

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

afterEach(() => resetStorageScope());

/** A page in a scope, as a page of that mode and account is all its life. */
function pageIn(scope: string, factory: IDBFactory, storage: Storage) {
  resetStorageScope();
  setStorageScope(scope);
  return createBrowserHost(
    () => storage,
    () => factory,
  );
}

describe("what the browser keeps, by mode and account", () => {
  it("keeps the projects, logs and settings of each scope apart", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    const offline = pageIn(OFFLINE_SCOPE, factory, storage);
    await offline.projects.create({ id: "p-offline", name: "离线的" }, new Uint8Array([0]));
    await offline.settings.save("layout", { offline: true });
    expect((await offline.projects.list()).map(({ id }) => id)).toEqual(["p-offline"]);

    const ada = pageIn(onlineScope("app.example", "user-ada"), factory, storage);
    expect(await ada.projects.list()).toEqual([]);
    expect(await ada.settings.load("layout")).toBeUndefined();
    await ada.projects.create({ id: "p-ada", name: "ada 的" }, new Uint8Array([0]));

    // Another account on the same site sees neither.
    const bob = pageIn(onlineScope("app.example", "user-bob"), factory, storage);
    expect(await bob.projects.list()).toEqual([]);

    // And the offline mode never sees what an account keeps.
    const back = pageIn(OFFLINE_SCOPE, factory, storage);
    expect((await back.projects.list()).map(({ id }) => id)).toEqual(["p-offline"]);
    expect(await back.settings.load("layout")).toEqual({ offline: true });
  });

  it("keeps how the editor looks for the whole device, as the page shows it before any mode", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    await pageIn(OFFLINE_SCOPE, factory, storage).settings.save("appearance", { theme: "light" });
    const online = pageIn(onlineScope("app.example", "user-ada"), factory, storage);
    expect(await online.settings.load("appearance")).toEqual({ theme: "light" });
    expect(storage.getItem("animaquill.appearance")).not.toBeNull();
  });

  it("names everything of a scope with it, and takes one scope per page", () => {
    setStorageScope(onlineScope("app.example:8443", "user/ada"));
    expect(scoped("animaquill")).toBe("aq-online-app.example:8443-user_ada-animaquill");
    // The same again is nothing; another one is a mistake.
    setStorageScope(onlineScope("app.example:8443", "user/ada"));
    expect(() => setStorageScope(OFFLINE_SCOPE)).toThrow();
  });
});

describe("what the editor kept before there were scopes", () => {
  /** A database of before, with what its version had in it. */
  async function before(factory: IDBFactory, name: string, links: readonly object[] = []) {
    const request = factory.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      if (name === "animaquill-cloud")
        request.result.createObjectStore("links", { keyPath: "key" });
      else request.result.createObjectStore("projects", { keyPath: "id" });
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    if (links.length > 0) {
      const transaction = database.transaction("links", "readwrite");
      for (const link of links) transaction.objectStore("links").put(link);
      await new Promise((resolve) => transaction.addEventListener("complete", resolve));
    }
    database.close();
  }

  it("goes, databases and keys of the local storage, but what is the device's", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    await before(factory, "animaquill");
    await before(factory, "animaquill-cloud", [{ key: "a", pending: 0 }]);
    storage.setItem("animaquill.layout", "{}");
    storage.setItem("animaquill.appearance", "{}");
    storage.setItem("animaquill.projectsInBrowser", "yes");
    expect(await unscopedUnsent(() => factory)).toBe(0);
    expect([...(await unscopedDatabases(() => factory))].toSorted()).toEqual([
      "animaquill",
      "animaquill-cloud",
    ]);
    await dropUnscopedData(
      () => factory,
      () => storage,
    );
    expect(await unscopedDatabases(() => factory)).toEqual([]);
    expect(storage.getItem("animaquill.layout")).toBeNull();
    expect(storage.getItem("animaquill.appearance")).toBe("{}");
    expect(storage.getItem("animaquill.projectsInBrowser")).toBe("yes");
  });

  /** The log of before: its updates, by project, as the library of before kept them. */
  async function logOf(factory: IDBFactory, records: readonly object[]) {
    const request = factory.open("animaquill", 2);
    request.addEventListener("upgradeneeded", () => {
      request.result
        .createObjectStore("updates", { keyPath: "seq", autoIncrement: true })
        .createIndex("project", "project");
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const transaction = database.transaction("updates", "readwrite");
    for (const record of records) transaction.objectStore("updates").put(record);
    await new Promise((resolve) => transaction.addEventListener("complete", resolve));
    database.close();
  }

  it("counts the projects whose changes the platform may not have yet, by their logs", async () => {
    const factory = new IDBFactory();
    await before(factory, "animaquill-cloud", [
      // What the log has after what got there, while the hint of the link says nothing yet.
      { key: "a", pushed: 1, pending: 0 },
      { key: "b", creating: true },
      // After what got there only what came from there.
      { key: "c", pushed: 2, pending: 3 },
      { key: "d", pushed: 9 },
    ]);
    await logOf(factory, [
      { seq: 1, project: "a", update: new Uint8Array([1]), source: { kind: "window" } },
      { seq: 2, project: "a", update: new Uint8Array([1]), source: { kind: "window" } },
      { seq: 3, project: "c", update: new Uint8Array([1]), source: { kind: "cloud" } },
      { seq: 4, project: "c", update: new Uint8Array([1]), source: { kind: "merged" } },
      { seq: 5, project: "d", update: new Uint8Array([1]) },
    ]);
    expect(await unscopedUnsent(() => factory)).toBe(2);
    // A browser that never had it has nothing to keep.
    expect(await unscopedUnsent(() => new IDBFactory())).toBe(0);
  });

  it("takes nothing away while a page of before is open", async () => {
    const factory = new IDBFactory();
    await before(factory, "animaquill");
    const holding = {
      query: async () => ({ held: [{ name: "animaquill.open.p1", mode: "shared" }], pending: [] }),
    } as unknown as LockManager;
    expect(
      await dropUnscopedData(
        () => factory,
        () => memoryStorage(),
        () => holding,
      ),
    ).toEqual([]);
    expect(await unscopedDatabases(() => factory)).toEqual(["animaquill"]);
  });
});
