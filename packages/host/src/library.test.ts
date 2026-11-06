import { IDBFactory } from "fake-indexeddb";
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
  const factory = new IDBFactory();
  const window = () =>
    createBrowserHost(
      () => ({}) as Storage,
      () => factory,
      () => ({}) as Storage,
      () => locks as unknown as LockManager | undefined,
    ).projects;
  const raw = async <T>(work: (database: IDBDatabase) => Promise<T>) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open("animaquill");
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
  return { library: window(), window, locks, records, change };
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
