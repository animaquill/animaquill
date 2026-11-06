import type { Host } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress, memoryWindow } from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { workspaces } from "./workspaces.ts";

function setup() {
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

  it("says so when undo cannot do anything", async () => {
    const { workbench } = setup();
    await create(workbench, "一");
    workbench.session.store?.execute({ type: "project.rename", params: { name: "二" } });
    lock(workbench);
    workbench.actions.get("edit.undo")?.run();
    expect(notices(workbench)).toEqual(["notice.undoFailed"]);
  });
});
