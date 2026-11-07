import { ProjectStore, aiTask } from "@animaquill/core";
import type { FolderAccess, Host } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTarget, memorySource } from "../transfer/memory-folder.ts";
import { MemoryLibrary, memoryAddress, memoryWindow } from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { workspaces } from "./workspaces.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
};

function setup(folders = noFolders) {
  const library = new MemoryLibrary();
  const values = new Map<string, unknown>();
  const host: Host = {
    projects: library,
    address: memoryAddress(),
    windowMemory: memoryWindow(),
    settings: {
      load: async (key) => values.get(key),
      save: async (key, value) => void values.set(key, value),
      listen: () => () => {},
    },
    folders,
  };
  const workbench = new Workbench({
    host,
    t: ((key: string) => key) as never,
    version: "test",
    platform: "other",
    panels: [],
    workspaces,
    compositorUrl: "",
  });
  return { workbench, library };
}

const nameOf = (workbench: Workbench) => workbench.session.store?.getState().manifest.name;
const notices = (workbench: Workbench) =>
  workbench.notifications.getSnapshot().map((item) => item.message);

/** Waits for the dialog that is about to open. */
const dialogOf = async (workbench: Workbench) => {
  await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()).toBeDefined());
  return workbench.dialogs.getSnapshot();
};

async function create(workbench: Workbench, name: string) {
  const creating = workbench.newProject();
  await dialogOf(workbench);
  workbench.dialogs.answer(name);
  await creating;
}

async function failToSave(workbench: Workbench, library: MemoryLibrary) {
  library.failing = true;
  workbench.session.store?.execute({ type: "project.rename", params: { name: "没保存上" } });
  await workbench.session.trySave();
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changing project", () => {
  it("opens a project once, however quickly people click", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    const id = workbench.session.store?.getState().manifest.id as string;
    await workbench.closeProject();
    const open = vi.spyOn(library, "open");
    await Promise.all([workbench.openProject(id), workbench.openProject(id)]);
    expect(open).toHaveBeenCalledOnce();
  });

  it("ends up on the start page, not in a half state, when a project cannot be created", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    vi.spyOn(library, "create").mockRejectedValue(new Error("quota"));
    await create(workbench, "二");
    expect(workbench.session.store).toBeUndefined();
    expect(notices(workbench)).toEqual(["notice.projectCreateFailed"]);
  });

  it("asks before leaving what could not be saved, and stays when told to", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    await failToSave(workbench, library);

    const closing = workbench.closeProject();
    expect((await dialogOf(workbench))?.title).toBe("project.unsavedTitle");
    workbench.dialogs.answer(false);
    await closing;
    expect(nameOf(workbench)).toBe("没保存上");
    expect(workbench.session.hasUnsavedChanges).toBe(true);

    library.failing = false;
    await workbench.session.trySave();
    await workbench.session.close();
  });

  it("leaves when told to", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    await failToSave(workbench, library);
    const closing = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer(true);
    await closing;
    expect(workbench.session.store).toBeUndefined();
  });

  it("also asks before opening another project", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    await failToSave(workbench, library);
    const creating = workbench.newProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("二");
    await vi.waitFor(() =>
      expect(workbench.dialogs.getSnapshot()?.title).toBe("project.unsavedTitle"),
    );
    workbench.dialogs.answer(false);
    await creating;
    expect(nameOf(workbench)).toBe("没保存上");

    library.failing = false;
    await workbench.session.trySave();
    await workbench.session.close();
  });

  it("does not ask when saving has recovered by then", async () => {
    const { workbench, library } = setup();
    await create(workbench, "一");
    await failToSave(workbench, library);
    library.failing = false;
    await workbench.closeProject();
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    expect(workbench.session.store).toBeUndefined();
  });
});

describe("changes that do not go through", () => {
  const lock = (workbench: Workbench) =>
    workbench.session.store?.execute({
      type: "project.setTags",
      params: { tags: [{ name: "完成", locked: true }] },
    });

  it("says so when a project cannot be renamed", async () => {
    const { workbench } = setup();
    await create(workbench, "一");
    lock(workbench);
    const renaming = workbench.renameProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("二");
    await renaming;
    expect(nameOf(workbench)).toBe("一");
    expect(notices(workbench)).toEqual(["notice.commandFailed"]);
  });

  it("says why undo cannot do anything", async () => {
    const { workbench } = setup();
    await create(workbench, "一");
    workbench.session.store?.execute({ type: "project.rename", params: { name: "二" } });
    lock(workbench);
    workbench.actions.get("edit.undo")?.run();
    expect(notices(workbench)).toEqual(["notice.commandFailed"]);
  });

  describe("when somebody else changed what undo is about", () => {
    const AI = { origin: aiTask("task") };
    const rename = (store: ProjectStore | undefined, name: string, options = {}) =>
      store?.execute({ type: "project.rename", params: { name } }, options);
    const firstTrack = (store: ProjectStore | undefined) =>
      Object.values(store?.getState().timelines["main"]?.tracks ?? {})[0];
    const setTrack = (store: ProjectStore | undefined, name: string, options = {}) => {
      const params = { timeline: "main", track: firstTrack(store)?.id, changes: { name } };
      return store?.execute({ type: "track.update", params }, options);
    };

    it("says the step was skipped, and leaves the one before it for the next press", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      setTrack(store, "我的轨道");
      rename(store, "二");
      rename(store, "三", AI);
      const undo = workbench.actions.get("edit.undo");
      undo?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked"]);
      expect(nameOf(workbench)).toBe("三");
      expect(firstTrack(store)?.name).toBe("我的轨道");
      undo?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked"]);
      expect(firstTrack(store)?.name).not.toBe("我的轨道");
    });

    it("says so on the way forward as well", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      rename(store, "二");
      store?.undo();
      rename(store, "三", AI);
      workbench.actions.get("edit.redo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked"]);
      expect(nameOf(workbench)).toBe("三");
    });

    it("says so when part of a step stayed", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      const track = firstTrack(store)?.id;
      store?.executeBatch([
        { type: "project.rename", params: { name: "二" } },
        { type: "track.update", params: { timeline: "main", track, changes: { name: "轨道" } } },
      ]);
      rename(store, "三", AI);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoPartly"]);
      expect(nameOf(workbench)).toBe("三");
    });

    it("says nothing when all of it went back", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      rename(workbench.session.store, "二");
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual([]);
      expect(nameOf(workbench)).toBe("一");
    });

    it("goes through the same message as any other change while updates are missing", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      rename(store, "二");
      const other = ProjectStore.fromUpdates([(store as ProjectStore).encodeState()]).store;
      const updates: Uint8Array[] = [];
      other?.onLocalUpdate((update) => updates.push(update));
      rename(other, "三");
      rename(other, "四");
      store?.applyUpdates([updates[1] as Uint8Array]);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.commandFailed"]);
      store?.applyUpdates(updates);
      expect(store?.canUndo).toBe(true);
    });
  });
});

describe("moving projects", () => {
  const projectFolder = (name = "文件夹里的项目") => {
    const store = ProjectStore.create(createProject({ name }));
    return memorySource("文件夹", store.exportFiles().files);
  };

  it("can export with a project open, and import at any time", async () => {
    const { workbench } = setup();
    const canRun = (id: string) => workbench.actions.get(id)?.enabled?.() !== false;
    expect(canRun("project.exportFolder")).toBe(false);
    expect(canRun("project.importFolder")).toBe(true);
    await create(workbench, "我的项目");
    expect(canRun("project.exportFolder")).toBe(true);
    expect(canRun("project.importFolder")).toBe(true);
  });

  it("offers both in the file menu", () => {
    const { workbench } = setup();
    const ids = workbench.actions
      .menu("file")
      .flat()
      .map((action) => action.id);
    expect(ids).toEqual(expect.arrayContaining(["project.exportFolder", "project.importFolder"]));
  });

  it("exports the open project from the menu", async () => {
    const target = new MemoryTarget();
    const { workbench } = setup({ ...noFolders, chooseTarget: async () => target });
    await create(workbench, "我的项目");
    workbench.actions.get("project.exportFolder")?.run();
    await dialogOf(workbench);
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("confirm"));
    expect(await target.text("animaquill.json")).toContain("我的项目");
  });

  it("leaves the open project for the new one once that is there", async () => {
    const source = projectFolder();
    const { workbench, library } = setup({ ...noFolders, chooseSource: async () => source });
    await create(workbench, "我的项目");
    await workbench.importProject();
    expect(nameOf(workbench)).toBe("文件夹里的项目");
    expect(library.summaries.size).toBe(2);
  });

  it("stays with the open project when a folder cannot come in", async () => {
    const source = memorySource("假期照片", [["a.jpg", "x"]]);
    const { workbench, library } = setup({ ...noFolders, chooseSource: async () => source });
    await create(workbench, "我的项目");
    const importing = workbench.importProject();
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("confirm"));
    workbench.dialogs.answer(true);
    await importing;
    expect(nameOf(workbench)).toBe("我的项目");
    expect(library.summaries.size).toBe(1);
  });

  it("keeps what came in when people stay with changes that could not be saved", async () => {
    const source = projectFolder();
    const { workbench, library } = setup({ ...noFolders, chooseSource: async () => source });
    await create(workbench, "我的项目");
    await failToSave(workbench, library);
    library.failing = false;
    const taken = vi.spyOn(workbench.session, "trySave").mockResolvedValue(false);
    const importing = workbench.importProject();
    await vi.waitFor(() => {
      const current = workbench.dialogs.getSnapshot();
      expect(current?.kind === "confirm" && current.danger).toBe(true);
    });
    workbench.dialogs.answer(false);
    await importing;
    taken.mockRestore();
    expect(nameOf(workbench)).toBe("没保存上");
    expect(library.summaries.size).toBe(2);
    expect(notices(workbench)).toContain("transfer.imported");
  });
});
