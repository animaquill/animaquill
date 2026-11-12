import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MemoryLibrary, memoryAddress } from "./memory-library.ts";
import { ProjectSession, projectKeyOf, type SessionMessages } from "./session.ts";

/** One window. Passing on the address of another makes it that window after a reload. */
function setup(library = new MemoryLibrary(), address = memoryAddress()) {
  const messages: { [K in keyof SessionMessages]: Mock<() => void> } = {
    createFailed: vi.fn<() => void>(),
    notFound: vi.fn<() => void>(),
    openFailed: vi.fn<() => void>(),
    tooNew: vi.fn<() => void>(),
    damaged: vi.fn<() => void>(),
    saveFailed: vi.fn<() => void>(),
    saveRecovered: vi.fn<() => void>(),
  };
  const session = new ProjectSession(library, address, messages);
  return { session, library, messages, address };
}

const rename = (session: ProjectSession, name: string) =>
  session.store?.execute({ type: "project.rename", params: { name } });

const nameOf = (session: ProjectSession) => session.store?.getState().manifest.name;

const settled = (session: ProjectSession) => session.trySave();
const idOf = (session: ProjectSession) => session.store?.getState().manifest.id as string;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a window on a project that was replaced", () => {
  async function replaced() {
    const library = new MemoryLibrary();
    const old = setup(library);
    await old.session.create("原来的项目");
    const id = idOf(old.session);
    const backup = old.session.store?.encodeState() as Uint8Array;
    await library.remove(id);
    const incoming = await library.receive({ id, name: "备份" });
    await incoming?.finish(backup);
    return { ...old, id, backup };
  }

  it("says that a change is not saved, also after trying again", async () => {
    const { session, library, messages, id, backup } = await replaced();
    rename(session, "第一个窗口改的名字");
    expect(await settled(session)).toBe(false);
    expect(await settled(session)).toBe(false);

    expect(session.getSnapshot().save).toBe("failed");
    expect(messages.saveFailed).toHaveBeenCalledOnce();
    expect(messages.saveRecovered).not.toHaveBeenCalled();
    expect(library.updates.get(id)).toEqual([backup]);
    expect(library.summaries.get(id)?.name).toBe("备份");
  });

  it("leaves the new project to the windows that have it open", async () => {
    const { library, address, id } = await replaced();
    const other = setup(library, memoryAddress(address.read()));
    await other.session.open(id);
    rename(other.session, "新窗口改的名字");
    expect(await settled(other.session)).toBe(true);
    expect(library.summaries.get(id)?.name).toBe("新窗口改的名字");
  });
});

describe("what this browser keeps a project by", () => {
  it("is what it was opened by, which for a project folder is not its id", async () => {
    const library = new MemoryLibrary();
    const made = ProjectStore.create(createProject({ name: "文件夹里的" }));
    await library.create({ id: "本机7", name: "文件夹里的" }, made.encodeState());
    made.destroy();
    const { session } = setup(library);
    expect(await session.open("本机7")).toBe(true);
    const store = session.store as ProjectStore;
    expect(store.getState().manifest.id).not.toBe("本机7");
    expect(session.key).toBe("本机7");
    expect(projectKeyOf(store)).toBe("本机7");
    // It stays with that store, also once the window goes on to another project.
    await session.close();
    expect(session.key).toBeUndefined();
    expect(projectKeyOf(store)).toBe("本机7");
  });
});

describe("reading the log again", () => {
  it("rejects when the log cannot be read, so that nothing goes on as if it had been", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    library.duringLoad = () => {
      throw new Error("damaged");
    };
    await expect(session.readLog()).rejects.toThrow("damaged");
    library.duringLoad = undefined;
    await expect(session.readLog()).resolves.toBeUndefined();
  });

  it("rejects without a project", async () => {
    await expect(setup().session.readLog()).rejects.toThrow();
  });
});

describe("projects", () => {
  it("starts with nothing open", () => {
    expect(setup().session.store).toBeUndefined();
  });

  it("creates a project and opens it", async () => {
    const { session } = setup();
    await session.create("新项目");
    expect(nameOf(session)).toBe("新项目");
    expect(await session.list()).toHaveLength(1);
  });

  it("brings a project back with everything that was changed", async () => {
    const first = setup();
    await first.session.create("新项目");
    rename(first.session, "改过的名字");
    await settled(first.session);

    const second = setup(first.library, first.address);
    await second.session.restore();
    expect(nameOf(second.session)).toBe("改过的名字");
  });

  it("does not bring back a project that was closed on purpose", async () => {
    const first = setup();
    await first.session.create("新项目");
    await first.session.close();
    const second = setup(first.library, first.address);
    await second.session.restore();
    expect(second.session.store).toBeUndefined();
    expect(second.messages.notFound).not.toHaveBeenCalled();
  });

  it("starts without a project when the address names none", async () => {
    const first = setup();
    await first.session.create("新项目");
    const newWindow = setup(first.library);
    await newWindow.session.restore();
    expect(newWindow.session.store).toBeUndefined();
  });

  it("keeps the address in step with the open project", async () => {
    const { session, address } = setup();
    expect(address.read()).toBeUndefined();
    await session.create("一");
    const first = idOf(session);
    expect(address.read()).toBe(first);
    await session.create("二");
    expect(address.read()).toBe(idOf(session));
    await session.open(first);
    expect(address.read()).toBe(first);
    await session.close();
    expect(address.read()).toBeUndefined();
  });

  it("says so when the project in the address is gone, and drops the address", async () => {
    const first = setup();
    await first.session.create("新项目");
    const id = idOf(first.session);
    await first.session.close();
    await first.session.remove(id);

    const second = setup(first.library, memoryAddress(id));
    await second.session.restore();
    expect(second.session.store).toBeUndefined();
    expect(second.messages.notFound).toHaveBeenCalledOnce();
    expect(second.messages.openFailed).not.toHaveBeenCalled();
    expect(second.address.read()).toBeUndefined();
  });

  it("keeps the address when opening fails, so that a reload tries again", async () => {
    const first = setup();
    await first.session.create("新项目");
    const id = idOf(first.session);
    const second = setup(first.library, memoryAddress(id));
    vi.spyOn(first.library, "open").mockRejectedValueOnce(new Error("blocked"));
    await second.session.restore();
    expect(second.session.store).toBeUndefined();
    expect(second.messages.openFailed).toHaveBeenCalledOnce();
    expect(second.address.read()).toBe(id);

    await second.session.restore();
    expect(nameOf(second.session)).toBe("新项目");
  });

  it("keeps the name in the list up to date", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    rename(session, "新名字");
    await settled(session);
    expect((await library.list())[0]?.name).toBe("新名字");
  });

  it("keeps the name up to date also when it was saved late", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    library.failing = true;
    rename(session, "新名字");
    await settled(session);
    library.failing = false;
    await settled(session);
    expect((await library.list())[0]?.name).toBe("新名字");
    await session.close();
  });

  it("switches between projects, and each keeps its own content", async () => {
    const { session } = setup();
    await session.create("一");
    const first = session.store?.getState().manifest.id as string;
    await session.create("二");
    expect(nameOf(session)).toBe("二");
    await session.open(first);
    expect(nameOf(session)).toBe("一");
  });

  it("removes a project", async () => {
    const { session } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    await session.close();
    await session.remove(id);
    expect(await session.list()).toEqual([]);
  });
});

describe("saving", () => {
  it("shows saving, and then saved", async () => {
    const { session } = setup();
    await session.create("新项目");
    rename(session, "一");
    expect(session.getSnapshot().save).toBe("saving");
    await settled(session);
    expect(session.getSnapshot().save).toBe("saved");
    expect(session.hasUnsavedChanges).toBe(false);
  });

  it("saves every change right away", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    rename(session, "一");
    rename(session, "二");
    await settled(session);
    expect(library.updates.get(id)?.length).toBeGreaterThan(1);
  });

  it("writes changes that arrive in the meantime together", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    const before = library.updates.get(id)?.length ?? 0;
    library.duringAppend = () => {
      library.duringAppend = undefined;
      rename(session, "二");
      rename(session, "三");
      rename(session, "四");
    };
    rename(session, "一");
    await settled(session);
    expect(library.updates.get(id)?.length).toBe(before + 2);

    await session.close();
    const second = setup(library);
    await second.session.open(id);
    expect(nameOf(second.session)).toBe("四");
  });

  it("finishes saving before closing", async () => {
    const first = setup();
    await first.session.create("新项目");
    const id = first.session.store?.getState().manifest.id as string;
    rename(first.session, "最后一刻");
    await first.session.close();
    const second = setup(first.library);
    await second.session.open(id);
    expect(nameOf(second.session)).toBe("最后一刻");
  });

  it("says so when saving fails, and keeps the change to try again", async () => {
    const { session, library, messages } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    library.failing = true;
    rename(session, "没保存上");
    await settled(session);
    expect(session.getSnapshot().save).toBe("failed");
    expect(session.hasUnsavedChanges).toBe(true);
    expect(messages.saveFailed).toHaveBeenCalledOnce();

    rename(session, "还是没保存上");
    await settled(session);
    expect(messages.saveFailed).toHaveBeenCalledOnce();

    library.failing = false;
    rename(session, "这次好了");
    await settled(session);
    expect(session.getSnapshot().save).toBe("saved");
    expect(messages.saveRecovered).toHaveBeenCalledOnce();

    await session.close();
    const second = setup(library);
    await second.session.open(id);
    expect(nameOf(second.session)).toBe("这次好了");
  });

  it("loses nothing that failed, even without a later rename of the same thing", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    library.failing = true;
    session.store?.execute({
      type: "marker.add",
      params: { timeline: "main", id: "m1", time: "1" },
    });
    await settled(session);
    library.failing = false;
    rename(session, "后来的改动");
    await settled(session);
    await session.close();
    const second = setup(library);
    await second.session.open(id);
    expect(second.session.store?.getState().timelines["main"]?.markers["m1"]).toBeDefined();
  });

  it("tries again on its own, without waiting for another change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { session, library, messages } = setup();
    await session.create("新项目");
    library.failing = true;
    rename(session, "没保存上");
    await settled(session);
    await vi.advanceTimersByTimeAsync(20000);
    expect(session.getSnapshot().save).toBe("failed");
    expect(messages.saveFailed).toHaveBeenCalledOnce();

    library.failing = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.getSnapshot().save).toBe("saved");
    expect(messages.saveRecovered).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops trying when the project is closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { session, library } = setup();
    await session.create("新项目");
    library.failing = true;
    rename(session, "没保存上");
    await settled(session);
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers whether everything could be saved", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    expect(await session.trySave()).toBe(true);
    library.failing = true;
    rename(session, "没保存上");
    expect(await session.trySave()).toBe(false);
    library.failing = false;
    expect(await session.trySave()).toBe(true);
  });

  it("waits for changes made while closing", async () => {
    const first = setup();
    await first.session.create("新项目");
    const id = idOf(first.session);
    first.library.duringAppend = () => {
      // The second write takes a moment, as a real one does.
      first.library.duringAppend = () => new Promise((resolve) => setTimeout(resolve, 5));
      rename(first.session, "关闭途中改的");
    };
    rename(first.session, "一");
    await first.session.close();
    const second = setup(first.library);
    await second.session.open(id);
    expect(nameOf(second.session)).toBe("关闭途中改的");
  });

  it("says so when a project cannot be created, and opens nothing", async () => {
    const { session, library, messages } = setup();
    library.failing = true;
    expect(await session.create("新项目")).toBe(false);
    expect(session.store).toBeUndefined();
    expect(messages.createFailed).toHaveBeenCalledOnce();
    expect(messages.saveFailed).not.toHaveBeenCalled();
  });

  it("does not stop to merge the log while people work", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    for (let i = 0; i < 450; i++) {
      rename(session, `名字 ${i}`);
      await settled(session);
    }
    expect(library.compactions).toBe(0);
  });

  it("merges a log with damage in it, and the damage is gone afterwards", async () => {
    const { session, library, messages } = setup();
    await session.create("新项目");
    const id = idOf(session);
    await session.close();
    library.updates.get(id)?.push(new Uint8Array([255, 255, 255, 1]));
    await session.open(id);
    expect(messages.damaged).toHaveBeenCalledOnce();
    for (let i = 0; i < 210; i++) {
      rename(session, `名字 ${i}`);
      await settled(session);
    }
    await session.close();
    await session.open(id);
    await settled(session);
    expect(library.compactions).toBe(1);
    await session.close();

    const second = setup(library);
    await second.session.open(id);
    expect(nameOf(second.session)).toBe("名字 209");
    expect(second.messages.damaged).not.toHaveBeenCalled();
  });

  it("merges a log that is already long when it is opened", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    for (let i = 0; i < 199; i++) {
      rename(session, `名字 ${i}`);
      await settled(session);
    }
    await session.close();
    await session.open(id);
    await settled(session);
    expect(library.compactions).toBe(1);
    expect(library.updates.get(id)).toHaveLength(1);
    expect(nameOf(session)).toBe("名字 198");

    await session.close();
    await session.open(id);
    expect(nameOf(session)).toBe("名字 198");
  });

  it("merges only what the log had when the project opened, whatever comes meanwhile (link race)", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    for (let i = 0; i < 5; i++) {
      rename(session, `名字 ${i}`);
      await settled(session);
    }
    // A window opens, and asks what it may merge: nothing says yet, as before a link is made.
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const asked: number[] = [];
    const late = new ProjectSession(library, memoryAddress(), setup().messages, {
      compactAfter: 3,
      compactThrough: async () => {
        asked.push(asked.length);
        await gate;
        return undefined;
      },
    });
    await late.open(id);
    // Meanwhile the project got connected, and changes came after, which have to go as they are.
    rename(session, "连上之后");
    await settled(session);
    const after = (await (await library.open(id)).entries?.())?.at(-1);
    open();
    await settled(late);
    expect(asked).toHaveLength(1);
    expect(library.compactions).toBe(1);
    const entries = (await (await library.open(id)).entries?.()) ?? [];
    expect(entries.some((entry) => entry.mark === after?.mark)).toBe(true);
    await late.close();
  });

  it("leaves a short log alone", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    for (let i = 0; i < 100; i++) {
      rename(session, `名字 ${i}`);
      await settled(session);
    }
    await session.close();
    await session.open(id);
    await settled(session);
    expect(library.compactions).toBe(0);
  });
});

describe("opening what cannot be opened", () => {
  it("says so when a project has no usable data", async () => {
    const { session, library, messages } = setup();
    library.summaries.set("broken", { id: "broken", name: "坏的", updatedAt: 1 });
    library.updates.set("broken", [new Uint8Array([9, 9, 9])]);
    expect(await session.open("broken")).toBe(false);
    expect(session.store).toBeUndefined();
    expect(messages.openFailed).toHaveBeenCalledOnce();
  });

  it("opens what it can and says so when part of the data is damaged", async () => {
    const { session, library, messages } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    await session.close();
    library.updates.get(id)?.push(new Uint8Array([255, 255, 255, 1]));
    expect(await session.open(id)).toBe(true);
    expect(nameOf(session)).toBe("新项目");
    expect(messages.damaged).toHaveBeenCalledOnce();
  });

  it("refuses a project from a newer version rather than damaging it", async () => {
    const { session, library, messages } = setup();
    await session.create("新项目");
    const id = idOf(session);
    await session.close();
    const project = createProject({ name: "新格式" });
    const newer = { ...project, manifest: { ...project.manifest, formatVersion: 99 } };
    library.updates.set(id, [ProjectStore.create(newer).encodeState()]);
    expect(await session.open(id)).toBe(false);
    expect(messages.tooNew).toHaveBeenCalledOnce();
    expect(session.store).toBeUndefined();
  });

  it("says so when a project turns out to be unusable, rather than failing to start", async () => {
    const { session, library, messages } = setup();
    await session.create("新项目");
    const id = idOf(session);
    await session.close();
    vi.spyOn(ProjectStore, "fromUpdates").mockImplementationOnce(() => {
      throw new Error("broken structure");
    });
    expect(await session.open(id)).toBe(false);
    expect(session.store).toBeUndefined();
    expect(messages.openFailed).toHaveBeenCalledOnce();
    expect(library.updates.get(id)).toHaveLength(1);
  });

  it("says so when the host cannot read", async () => {
    const { session, library, messages } = setup();
    vi.spyOn(library, "open").mockRejectedValue(new Error("blocked"));
    expect(await session.open("any")).toBe(false);
    expect(messages.openFailed).toHaveBeenCalledOnce();
  });
});

describe("two windows", () => {
  it("each keep their own project through a reload, whatever the other does", async () => {
    const a = setup();
    await a.session.create("旧项目");
    const b = setup(a.library, memoryAddress(idOf(a.session)));
    await b.session.restore();
    await b.session.close();
    await b.session.create("新项目");

    const reloadedA = setup(a.library, a.address);
    await reloadedA.session.restore();
    expect(nameOf(reloadedA.session)).toBe("旧项目");
    const reloadedB = setup(a.library, b.address);
    await reloadedB.session.restore();
    expect(nameOf(reloadedB.session)).toBe("新项目");
  });

  it("stay on the start page through a reload, whatever the other does", async () => {
    const a = setup();
    await a.session.create("项目");
    const id = idOf(a.session);
    await a.session.close();
    const b = setup(a.library);
    await b.session.open(id);

    const reloaded = setup(a.library, a.address);
    await reloaded.session.restore();
    expect(reloaded.session.store).toBeUndefined();
  });
});

describe("two windows on one project", () => {
  it("see each other's changes", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    const other = setup(library);
    await other.session.open(id);

    rename(session, "第一个窗口改的");
    await vi.waitFor(() => expect(nameOf(other.session)).toBe("第一个窗口改的"));
    rename(other.session, "第二个窗口改的");
    await vi.waitFor(() => expect(nameOf(session)).toBe("第二个窗口改的"));
  });

  it("miss nothing that another window writes while one is opening", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    const other = setup(library);
    library.duringLoad = () => {
      library.duringLoad = undefined;
      rename(session, "打开途中改的");
    };
    await other.session.open(id);
    await settled(session);
    expect(nameOf(other.session)).toBe("打开途中改的");
    expect(other.session.store?.isMissingUpdates).toBe(false);

    rename(session, "之后改的");
    await settled(session);
    expect(nameOf(other.session)).toBe("之后改的");
  });

  it("catch up when a change went missing on the way", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    const other = setup(library);
    await other.session.open(id);

    const listeners = new Set(library.listeners.get(id));
    library.listeners.get(id)?.clear();
    rename(session, "这一条丢了");
    await settled(session);
    for (const listener of listeners) library.listeners.get(id)?.add(listener);

    rename(session, "下一条");
    await settled(session);
    await settled(other.session);
    expect(nameOf(other.session)).toBe("下一条");
    expect(other.session.store?.isMissingUpdates).toBe(false);
  });

  describe("while one went missing", () => {
    /** Two windows, the other one with a hole: the first rename never reached it. */
    async function missing() {
      const { session, library } = setup();
      await session.create("新项目");
      const id = idOf(session);
      const other = setup(library);
      await other.session.open(id);
      const listeners = new Set(library.listeners.get(id));
      library.listeners.get(id)?.clear();
      rename(session, "这一条丢了");
      await settled(session);
      for (const listener of listeners) library.listeners.get(id)?.add(listener);
      return { session, other, library, id };
    }

    it("take no changes until the log was read", async () => {
      const { session, other, library } = await missing();
      const refused: unknown[] = [];
      library.duringLoad = () => {
        library.duringLoad = undefined;
        refused.push(rename(other.session, "不会改"));
      };
      rename(session, "下一条");
      await settled(session);
      await settled(other.session);
      expect(refused).toEqual([
        { ok: false, error: expect.objectContaining({ code: "missing-updates" }) },
      ]);
      expect(rename(other.session, "现在可以了")).toMatchObject({ ok: true });
    });

    it("go on with what there is when the log does not have it either", async () => {
      const { session, other, library, id } = await missing();
      library.updates.get(id)?.splice(1, 1);
      rename(session, "下一条");
      await settled(session);
      await settled(other.session);
      expect(other.session.store?.isMissingUpdates).toBe(true);
      expect(rename(other.session, "还能用")).toMatchObject({ ok: true });
    });

    it("keep reading when something else came in while reading", async () => {
      const { session, other, library, id } = await missing();
      const log = library.updates.get(id) as Uint8Array[];
      const lost = log.splice(1, 1);
      rename(session, "下一条");
      const refused: unknown[] = [];
      library.duringLoad = () => {
        library.duringLoad = () => {
          library.duringLoad = undefined;
          refused.push(rename(other.session, "不会改"));
        };
        log.splice(1, 0, ...lost);
        for (const listener of library.listeners.get(id) ?? []) listener(log.at(-1) as Uint8Array);
      };
      await settled(session);
      await settled(other.session);
      expect(refused).toEqual([
        { ok: false, error: expect.objectContaining({ code: "missing-updates" }) },
      ]);
      expect(other.session.store?.isMissingUpdates).toBe(false);
      expect(nameOf(other.session)).toBe("下一条");
    });

    it("keep taking no changes when the log cannot be read", async () => {
      const { session, other, library } = await missing();
      library.duringLoad = () => {
        library.duringLoad = undefined;
        throw new Error("blocked");
      };
      rename(session, "下一条");
      await settled(session);
      await settled(other.session);
      expect(rename(other.session, "不会改")).toMatchObject({ ok: false });
      rename(session, "再下一条");
      await settled(session);
      await settled(other.session);
      expect(nameOf(other.session)).toBe("再下一条");
      expect(rename(other.session, "现在可以了")).toMatchObject({ ok: true });
    });
  });

  it("do not stand in the way of a project with a hole in its log", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    rename(session, "一");
    await settled(session);
    rename(session, "二");
    await settled(session);
    await session.close();
    library.updates.get(id)?.splice(1, 1);
    expect(await session.open(id)).toBe(true);
    expect(session.store?.isMissingUpdates).toBe(true);
    expect(rename(session, "三")).toMatchObject({ ok: true });
  });

  it("are read again when one that came in while opening needs something else", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = idOf(session);
    rename(session, "一");
    await settled(session);
    rename(session, "二");
    await settled(session);
    const log = library.updates.get(id) as Uint8Array[];
    const later = log.splice(1);
    library.duringLoad = () => {
      library.duringLoad = undefined;
      log.push(...later);
      for (const listener of library.listeners.get(id) ?? []) listener(later[1] as Uint8Array);
    };
    const other = setup(library);
    await other.session.open(id);
    await settled(other.session);
    expect(other.session.store?.isMissingUpdates).toBe(false);
    expect(nameOf(other.session)).toBe("二");
  });

  it("do not save each other's changes a second time", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    const other = setup(library);
    await other.session.open(id);
    const before = library.updates.get(id)?.length ?? 0;
    rename(session, "改了");
    await settled(session);
    await vi.waitFor(() => expect(nameOf(other.session)).toBe("改了"));
    expect(library.updates.get(id)?.length).toBe(before + 1);
  });

  it("do not put each other's changes on the undo list", async () => {
    const { session, library } = setup();
    await session.create("新项目");
    const id = session.store?.getState().manifest.id as string;
    const other = setup(library);
    await other.session.open(id);
    rename(session, "改了");
    await vi.waitFor(() => expect(nameOf(other.session)).toBe("改了"));
    expect(other.session.store?.canUndo).toBe(false);
  });
});
