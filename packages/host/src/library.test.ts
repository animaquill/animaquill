import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost } from "./browser.ts";
import type { ProjectLog } from "./index.ts";

const PROJECT = { id: "project_a", name: "我的项目" };
const STATE = new Uint8Array([1, 2, 3]);

/** Locks as the browser has them, for one browser. A page that goes away is `dropAll`. */
class Locks {
  readonly held = new Map<string, () => void>();
  /** Runs right before a lock is given out, as if something else happened at that moment. */
  beforeGranting: ((name: string) => Promise<void>) | undefined;

  async request(
    name: string,
    _options: unknown,
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<void> {
    await this.beforeGranting?.(name);
    if (this.held.has(name)) {
      await callback(null);
      return;
    }
    const dropped = new Promise<void>((resolve) => this.held.set(name, resolve));
    await Promise.race([callback({ name }), dropped]);
    this.held.delete(name);
  }

  dropAll() {
    for (const drop of this.held.values()) drop();
    this.held.clear();
  }
}

/** A browser with its database. Every window gets a library of its own on the same data. */
function browser(locks: Locks | undefined = new Locks()) {
  const real = new IDBFactory();
  /** The database for what is being tried can fail on its own. */
  const state = { trialsBroken: false };
  const factory = new Proxy(real, {
    get(target, name) {
      if (name !== "open") return Reflect.get(target, name) as unknown;
      return (database: string, version?: number) => {
        if (state.trialsBroken && database === "animaquill-trials") throw new Error("broken");
        return target.open(database, version);
      };
    },
  });
  /** What a tab remembers: a reload keeps it, and a new window starts without. */
  const tab = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    } as Storage;
  };
  const host = (memory = tab()) =>
    createBrowserHost(
      () => ({}) as Storage,
      () => factory,
      () => memory,
      () => locks as unknown as LockManager | undefined,
    );
  const window = () => host().projects;
  const raw = async <T>(work: (database: IDBDatabase) => Promise<T>, name = "animaquill") => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = real.open(name);
      open.addEventListener("success", () => resolve(open.result));
      open.addEventListener("error", () => reject(open.error));
    });
    try {
      return await work(database);
    } finally {
      database.close();
    }
  };
  const records = () =>
    raw(
      (database) =>
        new Promise<Record<string, unknown>[]>((resolve) => {
          const request = database.transaction("projects").objectStore("projects").getAll();
          request.addEventListener("success", () => resolve(request.result));
        }),
    );
  const change = (id: string, update: (record: Record<string, unknown>) => unknown) =>
    raw(
      (database) =>
        new Promise<void>((resolve) => {
          const transaction = database.transaction("projects", "readwrite");
          const store = transaction.objectStore("projects");
          const request = store.get(id);
          request.addEventListener("success", () => {
            store.put(update(request.result as Record<string, unknown>));
          });
          transaction.addEventListener("complete", () => resolve());
        }),
    );
  const trialRecords = () =>
    raw(
      (database) =>
        new Promise<Record<string, unknown>[]>((resolve) => {
          const request = database.transaction("trials").objectStore("trials").getAll();
          request.addEventListener("success", () => resolve(request.result));
        }),
      "animaquill-trials",
    );
  const addTrialRecord = (record: object) =>
    raw(
      (database) =>
        new Promise<void>((resolve) => {
          const transaction = database.transaction("trials", "readwrite");
          transaction.objectStore("trials").put(record);
          transaction.addEventListener("complete", () => resolve());
        }),
      "animaquill-trials",
    );
  return {
    library: window(),
    window,
    trials: () => host().trials,
    host,
    tab,
    state,
    locks,
    records,
    change,
    factory: real,
    trialRecords,
    addTrialRecord,
  };
}

const open: ProjectLog[] = [];
const logOf = async (library: ReturnType<typeof browser>["library"], id = PROJECT.id) => {
  const log = await library.open(id);
  open.push(log);
  return log;
};

const ids = async (library: ReturnType<typeof browser>["library"]) =>
  (await library.list()).map(({ id }) => id);

const file = (text: string) => new Blob([text]);
const textIn = async (blob: Blob | undefined) => blob?.text();

afterEach(() => {
  for (const log of open.splice(0)) log.close();
  vi.restoreAllMocks();
});

describe("a project on its way in", () => {
  it("stays out of the list until it is finished, and then is all there", async () => {
    const { library } = browser();
    const incoming = await library.receive(PROJECT);
    await incoming?.media.put("hash", file("内容"));
    expect(await library.list()).toEqual([]);

    await incoming?.finish(STATE);
    expect(await ids(library)).toEqual([PROJECT.id]);
    expect((await library.list())[0]?.name).toBe("我的项目");
    expect(await (await logOf(library)).load()).toEqual([STATE]);
    expect(await textIn(await library.media(PROJECT.id).get("hash"))).toBe("内容");
  });

  it("has nothing to load before that", async () => {
    const { library } = browser();
    await library.receive(PROJECT);
    expect(await (await logOf(library)).load()).toEqual([]);
  });

  it("does not get the id of a project", async () => {
    const { library } = browser();
    await library.create(PROJECT, STATE);
    expect(await library.receive(PROJECT)).toBeUndefined();
    expect(await (await logOf(library)).load()).toEqual([STATE]);
  });

  it("does not get the id of a project that is coming in", async () => {
    const { window } = browser();
    expect(await window().receive(PROJECT)).toBeDefined();
    expect(await window().receive(PROJECT)).toBeUndefined();
  });

  it("does not get the id of a project without locks either", async () => {
    const { library } = browser(undefined);
    expect(await library.receive(PROJECT)).toBeDefined();
    expect(await library.receive(PROJECT)).toBeUndefined();
  });

  it("is never taken for a project by creating one with its id", async () => {
    const { library } = browser();
    await library.receive(PROJECT);
    await expect(library.create(PROJECT, STATE)).rejects.toThrow();
  });

  it("leaves nothing behind when given up, and the id is free again", async () => {
    const { library, records } = browser();
    const incoming = await library.receive(PROJECT);
    await incoming?.media.put("hash", file("内容"));
    await incoming?.abandon();
    expect(await records()).toEqual([]);
    expect(await library.media(PROJECT.id).get("hash")).toBeUndefined();
    expect(await library.receive(PROJECT)).toBeDefined();
  });

  it("does not take a finished project with it when given up by mistake", async () => {
    const { library } = browser();
    const incoming = await library.receive(PROJECT);
    await incoming?.finish(STATE);
    await incoming?.abandon();
    expect(await ids(library)).toEqual([PROJECT.id]);
  });

  it("lets go of its lock when finished and when given up", async () => {
    const { library, locks } = browser();
    const first = await library.receive(PROJECT);
    expect(locks?.held.size).toBe(1);
    await first?.finish(STATE);
    await vi.waitFor(() => expect(locks?.held.size).toBe(0));
    const second = await library.receive({ id: "project_b", name: "别的" });
    await second?.abandon();
    await vi.waitFor(() => expect(locks?.held.size).toBe(0));
  });

  it("lets go of its lock when the id turns out to be taken", async () => {
    const { library, locks } = browser();
    await library.create(PROJECT, STATE);
    await library.receive(PROJECT);
    await vi.waitFor(() => expect(locks?.held.size).toBe(0));
  });
});

describe("what a page that went away left behind", () => {
  async function leftBehind() {
    const setup = browser();
    const { library, locks } = setup;
    const incoming = await library.receive(PROJECT);
    await incoming?.media.put("hash", file("内容"));
    locks?.dropAll();
    return setup;
  }

  it("is gone after the next project came in", async () => {
    const { library, records } = await leftBehind();
    const next = await library.receive({ id: "project_b", name: "下一个" });
    await next?.finish(STATE);
    expect((await records()).map(({ id }) => id)).toEqual(["project_b"]);
    expect(await library.media(PROJECT.id).get("hash")).toBeUndefined();
  });

  it("does not stand in the way of bringing in the same project again", async () => {
    const { library } = await leftBehind();
    const again = await library.receive(PROJECT);
    expect(again).toBeDefined();
    await again?.finish(STATE);
    expect(await library.media(PROJECT.id).get("hash")).toBeUndefined();
  });

  it("is not taken for what a page still working on it has", async () => {
    const { window, records } = browser();
    const incoming = await window().receive(PROJECT);
    await incoming?.media.put("hash", file("内容"));
    const other = window();
    await other.receive({ id: "project_b", name: "别的" });
    expect((await records()).map(({ id }) => id).toSorted()).toEqual([PROJECT.id, "project_b"]);
    expect(await textIn(await other.media(PROJECT.id).get("hash"))).toBe("内容");
    await incoming?.finish(STATE);
    expect(await ids(other)).toEqual([PROJECT.id]);
  });

  it("is not taken for a project that got finished in the meantime", async () => {
    const { window, locks, records } = browser();
    const incoming = await window().receive(PROJECT);
    await incoming?.media.put("hash", file("内容"));
    const other = window();

    // Cleaning up has seen it coming in. Before it gets to deleting, the project arrives.
    const finish = vi.fn(async () => {
      if (locks) locks.beforeGranting = undefined;
      await incoming?.finish(STATE);
      await vi.waitFor(() => expect(locks?.held.size).toBe(0));
    });
    if (locks) locks.beforeGranting = finish;
    await other.receive({ id: "project_b", name: "别的" });

    expect(finish).toHaveBeenCalledOnce();
    expect((await records()).map(({ id }) => id)).toContain(PROJECT.id);
    expect(await ids(other)).toEqual([PROJECT.id]);
    expect(await textIn(await other.media(PROJECT.id).get("hash"))).toBe("内容");
  });

  it("is no reason for a project not to come in when cleaning up fails", async () => {
    const { library, locks } = await leftBehind();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (locks) {
      locks.beforeGranting = async (name) => {
        if (locks) locks.beforeGranting = undefined;
        throw new Error(`No lock for ${name}`);
      };
    }
    expect(await library.receive({ id: "project_b", name: "下一个" })).toBeDefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("a window on a project that is gone", () => {
  const UPDATE = new Uint8Array([9]);

  async function replaced() {
    const setup = browser();
    const { library } = setup;
    await library.create(PROJECT, STATE);
    const log = await logOf(library);
    await log.append(UPDATE, "第一个窗口改的名字");
    await library.remove(PROJECT.id);
    return { ...setup, log };
  }

  it("cannot save while it is gone", async () => {
    const { log } = await replaced();
    await expect(log.append(UPDATE, "名字")).rejects.toThrow();
  });

  it("cannot save into a project that came in with the same id", async () => {
    const { library, log } = await replaced();
    const incoming = await library.receive(PROJECT);
    await incoming?.finish(new Uint8Array([7]));

    await expect(log.append(UPDATE, "第一个窗口改的名字")).rejects.toThrow();
    expect(await (await logOf(library)).load()).toEqual([new Uint8Array([7])]);
    expect((await library.list())[0]?.name).toBe("我的项目");
  });

  it("cannot save into a project that is on its way in", async () => {
    const { library, log } = await replaced();
    const incoming = await library.receive(PROJECT);
    await expect(log.append(UPDATE, "名字")).rejects.toThrow();
    await incoming?.finish(new Uint8Array([7]));
    expect(await (await logOf(library)).load()).toEqual([new Uint8Array([7])]);
  });

  it("cannot save into a project created with the same id", async () => {
    const { library, log } = await replaced();
    await library.create(PROJECT, new Uint8Array([7]));
    await expect(log.append(UPDATE, "名字")).rejects.toThrow();
  });

  it("does not shorten the log of what took its place", async () => {
    const { library, log } = await replaced();
    await library.create(PROJECT, new Uint8Array([7]));
    const other = await logOf(library);
    await other.append(new Uint8Array([8]), "名字");
    await log.compact(() => new Uint8Array([0]));
    expect(await other.load()).toEqual([new Uint8Array([7]), new Uint8Array([8])]);
  });

  it("does not hear what happens in the project that took its place", async () => {
    const { library, log } = await replaced();
    const heard = vi.fn<(update: Uint8Array) => void>();
    log.listen(heard);
    await library.create(PROJECT, new Uint8Array([7]));
    const other = await logOf(library);
    const sameProject = vi.fn<(update: Uint8Array) => void>();
    const second = await logOf(library);
    second.listen(sameProject);
    await other.append(new Uint8Array([8]), "名字");
    await vi.waitFor(() => expect(sameProject).toHaveBeenCalled());
    expect(heard).not.toHaveBeenCalled();
  });

  it("goes on working for all windows of the new project", async () => {
    const { library } = await replaced();
    const incoming = await library.receive(PROJECT);
    await incoming?.finish(STATE);
    const log = await logOf(library);
    await log.append(UPDATE, "新的名字");
    expect(await log.load()).toEqual([STATE, UPDATE]);
    expect((await library.list())[0]?.name).toBe("新的名字");
  });
});

describe("a project saved before projects told each other apart", () => {
  const UPDATE = new Uint8Array([9]);

  async function older() {
    const setup = browser();
    await setup.library.create(PROJECT, STATE);
    await setup.change(PROJECT.id, ({ instance: _instance, ...record }) => record);
    return setup;
  }

  it("is the same as before", async () => {
    const { library, records } = await older();
    expect((await records())[0]).not.toHaveProperty("instance");
    const log = await logOf(library);
    await log.append(UPDATE, "新的名字");
    expect(await log.load()).toEqual([STATE, UPDATE]);
    expect((await library.list())[0]?.name).toBe("新的名字");
    await log.compact(() => new Uint8Array([0]));
    expect(await log.load()).toEqual([new Uint8Array([0])]);
  });

  it("stays without a mark, so that older pages go on working", async () => {
    const { library, records } = await older();
    await (await logOf(library)).append(UPDATE, "新的名字");
    expect((await records())[0]).not.toHaveProperty("instance");
  });

  it("is told apart from what comes in with its id", async () => {
    const { library } = await older();
    const log = await logOf(library);
    await library.remove(PROJECT.id);
    const incoming = await library.receive(PROJECT);
    await incoming?.finish(new Uint8Array([7]));
    await expect(log.append(UPDATE, "名字")).rejects.toThrow();
  });

  it("is told apart from what is on its way in with its id", async () => {
    const { library } = await older();
    const log = await logOf(library);
    await library.remove(PROJECT.id);
    const incoming = await library.receive(PROJECT);
    await expect(log.append(UPDATE, "名字")).rejects.toThrow();
    await incoming?.finish(new Uint8Array([7]));
    expect(await (await logOf(library)).load()).toEqual([new Uint8Array([7])]);
  });

  it("is heard by all its windows", async () => {
    const { library } = await older();
    const first = await logOf(library);
    const second = await logOf(library);
    const heard = vi.fn<(update: Uint8Array) => void>();
    second.listen(heard);
    await first.append(UPDATE, "名字");
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  });
});

describe("what is being tried out", () => {
  async function setup(locks?: Locks | null) {
    const opened = browser(locks === null ? (null as unknown as undefined) : locks);
    await opened.library.create(PROJECT, STATE);
    return opened;
  }

  it("has nothing to give in a place nobody used", async () => {
    const { trials } = await setup();
    const place = await trials().open(PROJECT.id);
    expect(await place.load()).toBeUndefined();
  });

  it("reads back what it kept, as it was", async () => {
    const { trials } = await setup();
    const place = await trials().open(PROJECT.id);
    await place.save({ changes: [{ value: 1 }] });
    expect(await place.load()).toEqual({ changes: [{ value: 1 }] });
  });

  it("gives every window a place of its own", async () => {
    const { trials } = await setup();
    const first = await trials().open(PROJECT.id);
    await first.save("一");
    const second = await trials().open(PROJECT.id);
    expect(await second.load()).toBeUndefined();
    await second.save("二");
    expect(await first.load()).toBe("一");
  });

  it("gives a place back to the window that comes after a reload", async () => {
    const { trials, locks } = await setup();
    await (await trials().open(PROJECT.id)).save("试改");
    locks.dropAll();
    expect(await (await trials().open(PROJECT.id)).load()).toBe("试改");
  });

  it("gives a place to the next window after closing", async () => {
    const { trials } = await setup();
    const first = await trials().open(PROJECT.id);
    await first.save("试改");
    first.close();
    await vi.waitFor(async () => {
      const place = await trials().open(PROJECT.id);
      expect(await place.load()).toBe("试改");
    });
  });

  it("waits a moment for a page that is going away", async () => {
    const { trials } = await setup();
    const first = await trials().open(PROJECT.id);
    await first.save("试改");
    const coming = trials().open(PROJECT.id);
    setTimeout(() => first.close(), 50);
    expect(await (await coming).load()).toBe("试改");
  });

  it("gives a window that comes back what it left, not what another window left later", async () => {
    const { host, tab } = await setup();
    const mine = tab();
    const window = await host(mine).trials.open(PROJECT.id);
    await window.save("这个窗口的");
    const other = await host().trials.open(PROJECT.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await other.save("别的窗口的，时间更新");
    other.close();
    window.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reloaded = await host(mine).trials.open(PROJECT.id);
    expect(await reloaded.load()).toBe("这个窗口的");
  });

  it("waits for its own place for as long as the page before it can take", async () => {
    const { host, tab } = await setup();
    const mine = tab();
    const before = await host(mine).trials.open(PROJECT.id);
    await before.save("试改");
    const coming = host(mine).trials.open(PROJECT.id);
    setTimeout(() => before.close(), 800);
    const started = Date.now();
    expect(await (await coming).load()).toBe("试改");
    expect(Date.now() - started).toBeGreaterThan(500);
  });

  it("gets a place of its own in a tab that got duplicated, after that wait", async () => {
    const { host, tab } = await setup();
    const mine = tab();
    const original = await host(mine).trials.open(PROJECT.id);
    await original.save("原来的");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    const copy = await host(mine).trials.open(PROJECT.id);
    vi.restoreAllMocks();
    expect(await copy.load()).toBeUndefined();
    await copy.save("副本的");
    expect(await original.load()).toBe("原来的");
  });

  it("remembers a place it took over", async () => {
    const { host, tab, locks } = await setup();
    await (await host().trials.open(PROJECT.id)).save("别的窗口留下的");
    locks.dropAll();
    const mine = tab();
    const taken = await host(mine).trials.open(PROJECT.id);
    expect(await taken.load()).toBe("别的窗口留下的");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await (await host().trials.open(PROJECT.id)).save("更新的");
    locks.dropAll();
    expect(await (await host(mine).trials.open(PROJECT.id)).load()).toBe("别的窗口留下的");
  });

  it("does not take what another window is working on", async () => {
    const { trials } = await setup();
    const first = await trials().open(PROJECT.id);
    await first.save("一");
    const second = await trials().open(PROJECT.id);
    expect(await second.load()).toBeUndefined();
    await second.save("二");
    await expect(first.load()).resolves.toBe("一");
  });

  it("goes for the most recent of what windows left behind", async () => {
    const { trials, locks } = await setup();
    const older = await trials().open(PROJECT.id);
    const newer = await trials().open(PROJECT.id);
    await older.save("旧");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await newer.save("新");
    locks.dropAll();
    expect(await (await trials().open(PROJECT.id)).load()).toBe("新");
    expect(await (await trials().open(PROJECT.id)).load()).toBe("旧");
  });

  it("leaves nothing behind when there is nothing left to keep", async () => {
    const { trials, locks, trialRecords } = await setup();
    const place = await trials().open(PROJECT.id);
    await place.save("试改");
    await place.save(undefined);
    locks.dropAll();
    expect(await (await trials().open(PROJECT.id)).load()).toBeUndefined();
    expect(await trialRecords()).toEqual([]);
  });

  it("keeps projects apart", async () => {
    const { trials, library } = await setup();
    await library.create({ id: "project_b", name: "别的" }, STATE);
    await (await trials().open(PROJECT.id)).save("试改");
    expect(await (await trials().open("project_b")).load()).toBeUndefined();
  });

  it("goes away with the project", async () => {
    const { trials, library, locks, trialRecords } = await setup();
    await (await trials().open(PROJECT.id)).save("试改");
    await library.remove(PROJECT.id);
    expect(await trialRecords()).toEqual([]);
    locks.dropAll();
    await library.create(PROJECT, STATE);
    expect(await (await trials().open(PROJECT.id)).load()).toBeUndefined();
  });

  it("does not take what a project with the same id left behind", async () => {
    const { trials, addTrialRecord } = await setup();
    (await trials().open(PROJECT.id)).close();
    await addTrialRecord({
      project: PROJECT.id,
      place: "old",
      instance: "another",
      savedAt: 1,
      trial: "旧",
    });
    expect(await (await trials().open(PROJECT.id)).load()).toBeUndefined();
  });

  it("goes for what this project left, also when one with the same id wrote later", async () => {
    const { host, library, addTrialRecord } = await setup();
    await library.create({ id: "project_b", name: "别的" }, STATE);
    const first = await host().trials.open(PROJECT.id);
    await first.save("这个项目的");
    first.close();
    const { trials } = host();
    await trials.open("project_b");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addTrialRecord({
      project: PROJECT.id,
      place: "old",
      instance: "another",
      savedAt: Date.now() + 1000,
      trial: "旧",
    });
    expect(await (await trials.open(PROJECT.id)).load()).toBe("这个项目的");
  });

  it("does not take what one with the same id left in the place of this window", async () => {
    const { host, tab, library, state } = await setup();
    await library.create({ id: "project_b", name: "别的" }, STATE);
    const { trials } = host(tab());
    const first = await trials.open(PROJECT.id);
    await first.save("删掉的项目的");
    first.close();
    state.trialsBroken = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await library.remove(PROJECT.id);
    vi.restoreAllMocks();
    state.trialsBroken = false;
    await library.create(PROJECT, STATE);
    expect(await (await trials.open(PROJECT.id)).load()).toBeUndefined();
  });

  it("leaves nothing behind for a project that is gone, whatever a window went on writing", async () => {
    const { trials, library, trialRecords } = await setup();
    await library.create({ id: "project_b", name: "别的" }, STATE);
    const place = await trials().open(PROJECT.id);
    await library.remove(PROJECT.id);
    await place.save("试改");
    expect(await trialRecords()).toHaveLength(1);
    await trials().open("project_b");
    await vi.waitFor(async () => expect(await trialRecords()).toEqual([]));
  });

  it("does not take a project with the same id for the one it was opened for", async () => {
    const { trials, library } = await setup();
    const place = await trials().open(PROJECT.id);
    await library.remove(PROJECT.id);
    await library.create(PROJECT, STATE);
    await place.save("试改");
    expect(await (await trials().open(PROJECT.id)).load()).toBeUndefined();
  });

  it("starts writing at once, because the page may be on its way out", async () => {
    const { trials } = await setup();
    const place = await trials().open(PROJECT.id);
    await place.save("先连上数据库");
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    const saving = place.save("试改");
    // Only what is already done can get through here: nothing that has to wait for a database.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const stores = transaction.mock.calls.map(([names]) => names);
    vi.restoreAllMocks();
    expect(stores).toEqual(["trials"]);
    await saving;
    expect(await place.load()).toBe("试改");
  });

  it("makes do with one place for all windows where there are no locks", async () => {
    const { trials } = await setup(null);
    await (await trials().open(PROJECT.id)).save("试改");
    expect(await (await trials().open(PROJECT.id)).load()).toBe("试改");
  });

  it("stays out of the database of the projects, so that pages still open there go on", async () => {
    const { factory, library, trials, records } = await setup();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("animaquill");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const told = vi.fn();
    old.addEventListener("versionchange", told);
    const place = await trials().open(PROJECT.id);
    await place.save("试改");
    expect(await place.load()).toBe("试改");
    expect(told).not.toHaveBeenCalled();
    expect(old.version).toBe(2);
    expect([...old.objectStoreNames]).toEqual(["media", "projects", "updates"]);
    old.close();
    expect((await library.list()).map(({ id }) => id)).toEqual([PROJECT.id]);
    expect(await records()).toHaveLength(1);
  });

  it("does not get in the way of removing a project when it cannot be reached", async () => {
    const { library, trials, state, trialRecords } = await setup();
    await (await trials().open(PROJECT.id)).save("试改");
    state.trialsBroken = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await library.remove(PROJECT.id);
    vi.restoreAllMocks();
    state.trialsBroken = false;
    expect((await library.list()).map(({ id }) => id)).toEqual([]);
    expect(await trialRecords()).toHaveLength(1);
  });

  it("gets swept up later when that happened, and what is in use stays", async () => {
    const { library, trials, state, trialRecords } = await setup();
    await library.create({ id: "project_b", name: "别的" }, STATE);
    await (await trials().open(PROJECT.id)).save("试改");
    await (await trials().open("project_b")).save("还在用");
    state.trialsBroken = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await library.remove(PROJECT.id);
    vi.restoreAllMocks();
    state.trialsBroken = false;
    await trials().open("project_b");
    await vi.waitFor(async () => expect(await trialRecords()).toHaveLength(1));
    expect((await trialRecords())[0]).toMatchObject({ project: "project_b" });
  });

  it("sweeps up what a project with the same id left behind as well", async () => {
    const { trials, addTrialRecord, trialRecords } = await setup();
    (await trials().open(PROJECT.id)).close();
    await addTrialRecord({
      project: PROJECT.id,
      place: "old",
      instance: "another",
      savedAt: 1,
      trial: "旧",
    });
    await trials().open(PROJECT.id);
    await vi.waitFor(async () => expect(await trialRecords()).toEqual([]));
  });
});

describe("files the editor made", () => {
  const SOUND = "sound-1:abc";
  const PEAKS = "peaks-1:sound-1:abc";
  const ASSET = "sha256-n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg=";

  async function withFiles() {
    const { library } = browser();
    await library.create(PROJECT, STATE);
    const media = library.media(PROJECT.id);
    await media.put(ASSET, file("用户的视频"));
    await media.put("peaks-1:sha256-other", file("视频的波形"));
    await media.put(SOUND, file("声音"));
    await media.put(PEAKS, file("声音的波形"));
    return { library, media };
  }

  it("are all that a listing has, with their size and when they were used", async () => {
    const { media } = await withFiles();
    const listed = await media.listMade();
    expect(listed.map(({ name }) => name).toSorted()).toEqual([PEAKS, SOUND]);
    for (const { size, usedAt } of listed) {
      expect(size).toBeGreaterThan(0);
      expect(usedAt).toBeGreaterThan(0);
    }
  });

  it("are all that can be removed: what people brought in can never go this way", async () => {
    const { media } = await withFiles();
    await expect(media.removeMade(ASSET)).rejects.toThrow();
    await expect(media.removeMade("peaks-1:sha256-other")).rejects.toThrow();
    await expect(media.removeMade("sha256-sound-1:abc")).rejects.toThrow();
    expect(await textIn(await media.get(ASSET))).toBe("用户的视频");
    expect(await textIn(await media.get("peaks-1:sha256-other"))).toBe("视频的波形");
    await media.removeMade(SOUND);
    expect(await media.get(SOUND)).toBeUndefined();
    expect(await textIn(await media.get(PEAKS))).toBe("声音的波形");
  });

  it("are only those of the project", async () => {
    const { library, media } = await withFiles();
    const other = { id: "project_b", name: "别的" };
    await library.create(other, STATE);
    await library.media(other.id).put("sound-1:zzz", file("别的声音"));
    expect((await media.listMade()).map(({ name }) => name)).not.toContain("sound-1:zzz");
    await media.removeMade("sound-1:zzz");
    expect(await textIn(await library.media(other.id).get("sound-1:zzz"))).toBe("别的声音");
  });

  it("count as used when somebody says so, and nothing else does", async () => {
    const { media } = await withFiles();
    vi.spyOn(Date, "now").mockReturnValue(10);
    await media.put("sound-1:old", file("旧的"));
    vi.spyOn(Date, "now").mockReturnValue(99);
    await media.touchMade("sound-1:old");
    await media.touchMade(ASSET);
    const old = (await media.listMade()).find(({ name }) => name === "sound-1:old");
    expect(old?.usedAt).toBe(99);
    expect(await textIn(await media.get(ASSET))).toBe("用户的视频");
    vi.restoreAllMocks();
  });
});

describe("a project of the browser that moved into a folder", () => {
  const ASSET = "sha256-n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg=";
  const OTHER = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=";
  const SOUND = "sound-1:abc";

  async function moved() {
    const opened = browser();
    const { library } = opened;
    await library.create(PROJECT, STATE);
    const media = library.media(PROJECT.id);
    await media.put(ASSET, file("用户的视频"));
    await media.put(OTHER, file("用户的图"));
    await media.put(SOUND, file("代码做的声音"));
    return { ...opened, media };
  }

  it("is kept by its folder from then on, and its log goes on", async () => {
    const { library } = await moved();
    const log = await logOf(library);
    await library.toFolder(PROJECT.id);
    expect(await library.list()).toEqual([expect.objectContaining({ ...PROJECT, folder: true })]);
    // A window that had it open goes on writing its log, and so does the next one.
    await log.append(new Uint8Array([4]), PROJECT.name);
    expect(await (await logOf(library)).load()).toEqual([STATE, new Uint8Array([4])]);
    // Saying so again changes nothing.
    await library.toFolder(PROJECT.id);
    expect(await library.list()).toEqual([expect.objectContaining({ folder: true })]);
  });

  it("keeps what windows were trying out on it", async () => {
    const { library, host, tab } = await moved();
    const memory = tab();
    const place = await host(memory).trials.open(PROJECT.id);
    await place.save("试改");
    place.close();
    await library.toFolder(PROJECT.id);
    const again = await host(memory).trials.open(PROJECT.id);
    expect(await again.load()).toBe("试改");
    again.close();
  });

  it("cannot be one that is not there", async () => {
    const { library } = browser();
    await expect(library.toFolder("project_none")).rejects.toThrow();
    expect(await library.list()).toEqual([]);
  });

  it("has copies of the files people brought in, which are all that can be let go of", async () => {
    const { library, media } = await moved();
    await library.toFolder(PROJECT.id);
    const copies = await library.copies(PROJECT.id);
    expect(copies.map(({ name }) => name).toSorted()).toEqual([ASSET, OTHER].toSorted());
    expect(copies.find(({ name }) => name === ASSET)?.size).toBe(file("用户的视频").size);
    await library.dropCopies(PROJECT.id, [ASSET, SOUND]);
    expect(await media.get(ASSET)).toBeUndefined();
    expect(await textIn(await media.get(OTHER))).toBe("用户的图");
    // What the editor made stays, whatever is asked.
    expect(await textIn(await media.get(SOUND))).toBe("代码做的声音");
    expect((await library.copies(PROJECT.id)).map(({ name }) => name)).toEqual([OTHER]);
  });

  it("is the only one whose files can go that way: a project of the browser keeps them", async () => {
    const { library, media } = await moved();
    await expect(library.dropCopies(PROJECT.id, [ASSET])).rejects.toThrow();
    await expect(library.dropCopies("project_none", [ASSET])).rejects.toThrow();
    expect(await textIn(await media.get(ASSET))).toBe("用户的视频");
  });

  it("are only its own copies", async () => {
    const { library } = await moved();
    const other = { id: "project_b", name: "别的" };
    await library.create(other, STATE);
    await library.media(other.id).put(ASSET, file("别的项目的视频"));
    await library.toFolder(PROJECT.id);
    await library.dropCopies(PROJECT.id, [ASSET]);
    expect(await textIn(await library.media(other.id).get(ASSET))).toBe("别的项目的视频");
    expect((await library.copies(other.id)).map(({ name }) => name)).toEqual([ASSET]);
  });
});
