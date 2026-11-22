import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserLeftOver,
  clearIfAsked,
  clearOnNextStart,
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
    await offline.settings.save("palette", { offline: true });
    expect((await offline.projects.list()).map(({ id }) => id)).toEqual(["p-offline"]);

    const ada = pageIn(onlineScope("app.example", "user-ada"), factory, storage);
    expect(await ada.projects.list()).toEqual([]);
    expect(await ada.settings.load("palette")).toBeUndefined();
    await ada.projects.create({ id: "p-ada", name: "ada 的" }, new Uint8Array([0]));

    // Another account on the same site sees neither.
    const bob = pageIn(onlineScope("app.example", "user-bob"), factory, storage);
    expect(await bob.projects.list()).toEqual([]);

    // And the offline mode never sees what an account keeps.
    const back = pageIn(OFFLINE_SCOPE, factory, storage);
    expect((await back.projects.list()).map(({ id }) => id)).toEqual(["p-offline"]);
    expect(await back.settings.load("palette")).toEqual({ offline: true });
  });

  it("keeps how the editor looks for the whole device, as the page shows it before any mode", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    await pageIn(OFFLINE_SCOPE, factory, storage).settings.save("appearance", { theme: "light" });
    const online = pageIn(onlineScope("app.example", "user-ada"), factory, storage);
    expect(await online.settings.load("appearance")).toEqual({ theme: "light" });
    expect(storage.getItem("animaquill.appearance")).not.toBeNull();
    // So are the layouts, the keys and how the pointer scrolls: the screen and the keyboard's.
    for (const key of ["layout", "keybindings", "input"]) {
      await pageIn(OFFLINE_SCOPE, factory, storage).settings.save(key, { of: key });
      const again = pageIn(onlineScope("app.example", "user-ada"), factory, storage);
      expect(await again.settings.load(key)).toEqual({ of: key });
    }
  });

  it("clears what a scope keeps once a page of it asked, before anything opens it", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    const ada = onlineScope("app.example", "user-ada");
    const bob = onlineScope("app.example", "user-bob");
    const page = pageIn(ada, factory, storage);
    await page.settings.save("palette", { ada: true });
    await page.organizer.mark("cloud:p", { starredAt: 1, at: 1 });
    await pageIn(bob, factory, storage).settings.save("palette", { bob: true });
    await page.settings.save("appearance", { theme: "light" });
    // Not asked: nothing goes.
    expect(
      await clearIfAsked(
        ada,
        () => factory,
        () => storage,
        () => memoryStorage(),
      ),
    ).toBe("none");
    resetStorageScope();
    setStorageScope(ada);
    clearOnNextStart(() => storage);
    // Another scope starting goes on as it is.
    expect(
      await clearIfAsked(
        bob,
        () => factory,
        () => storage,
        () => memoryStorage(),
      ),
    ).toBe("none");
    expect(
      await clearIfAsked(
        ada,
        () => factory,
        () => storage,
        () => memoryStorage(),
      ),
    ).toBe("cleared");
    const names = (await factory.databases()).map(({ name }) => name ?? "");
    expect(names.filter((name) => name.startsWith(ada))).toEqual([]);
    expect(await pageIn(ada, factory, storage).settings.load("palette")).toBeUndefined();
    expect(await pageIn(bob, factory, storage).settings.load("palette")).toEqual({ bob: true });
    expect(await pageIn(ada, factory, storage).settings.load("appearance")).toEqual({
      theme: "light",
    });
    // Once.
    expect(
      await clearIfAsked(
        ada,
        () => factory,
        () => storage,
        () => memoryStorage(),
      ),
    ).toBe("none");
  });

  it("does not clear what was asked long ago, and tries again while a window holds a database", async () => {
    const factory = new IDBFactory();
    const storage = memoryStorage();
    const ada = onlineScope("app.example", "user-ada");
    const page = pageIn(ada, factory, storage);
    await page.settings.save("palette", { ada: true });
    let time = 1_000_000;
    const clear = () =>
      clearIfAsked(
        ada,
        () => factory,
        () => storage,
        () => memoryStorage(),
        { now: () => time },
      );
    clearOnNextStart(
      () => storage,
      () => time,
    );
    // A page that did not load again then: an hour later it holds no more.
    time += 60 * 60_000;
    expect(await clear()).toBe("none");
    expect(await pageIn(ada, factory, storage).settings.load("palette")).toEqual({ ada: true });
    // Another window holds a database of the scope, and does not let go of it.
    const held = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open(`${ada}held`, 1);
      request.addEventListener("success", () => resolve(request.result));
    });
    clearOnNextStart(
      () => storage,
      () => time,
    );
    expect(await clear()).toBe("blocked");
    // Nothing else of it went, and it is asked again the next time.
    expect(await pageIn(ada, factory, storage).settings.load("palette")).toEqual({ ada: true });
    held.close();
    expect(await clear()).toBe("cleared");
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
    storage.setItem("animaquill.palette", "{}");
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
    expect(storage.getItem("animaquill.palette")).toBeNull();
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

  it("says what is left, how much it takes and what may not be on a backend, and lets it go", async () => {
    const factory = new IDBFactory();
    const left = browserLeftOver(
      () => factory,
      () => memoryStorage(),
      () => undefined,
    );
    expect(await left.databases()).toEqual([]);
    expect(await left.bytes()).toBe(0);
    await before(factory, "animaquill");
    await before(factory, "animaquill-cloud", [{ key: "b", creating: true }]);
    expect([...(await left.databases())].toSorted()).toEqual(["animaquill", "animaquill-cloud"]);
    expect(await left.bytes()).toBeGreaterThan(0);
    // What goes with it that is nowhere else: here a project that never got to the platform.
    expect(await left.contents()).toEqual({ changes: 1, projects: 0, keys: 0, chats: 0 });
    expect(await left.drop()).toEqual([]);
    expect(await left.databases()).toEqual([]);
  });

  it("takes one that cannot be read for one that may have anything in it", async () => {
    const factory = new IDBFactory();
    await before(factory, "animaquill");
    const left = browserLeftOver(
      () =>
        ({
          databases: () => factory.databases(),
          // Broken, or held by a page that never lets go.
          open: () => {
            throw new DOMException("broken", "UnknownError");
          },
        }) as unknown as IDBFactory,
      () => memoryStorage(),
      () => undefined,
    );
    await expect(left.contents()).rejects.toThrow();
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
