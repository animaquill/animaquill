import { ProjectStore, aiTask, orderedTracks } from "@animaquill/core";
import type { FolderAccess, Host } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTarget, memorySource } from "../transfer/memory-folder.ts";
import { MemoryLibrary, MemoryTrials, memoryAddress, memoryWindow } from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { workspaces } from "./workspaces.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
};

function setup(folders = noFolders) {
  const library = new MemoryLibrary();
  const trials = new MemoryTrials();
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
    trials,
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
  return { workbench, library, trials };
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

/** A project with one clip, and a window that is trying something out on it. */
async function trying(folders = noFolders) {
  const context = setup(folders);
  const { workbench } = context;
  await create(workbench, "试改");
  const store = workbench.session.store as ProjectStore;
  const main = () => store.getState().timelines["main"];
  const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
  const clip = { id: "c", start: "0", duration: "5", source: { kind: "color", color: "#ff0000" } };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  const saved = () => main()?.clips["c"]?.properties?.["transform.x"];
  const edit = (value: number) => ({
    owner: { clip: "c" },
    path: "transform.x",
    op: "write" as const,
    time: "1",
    value,
  });
  const id = store.getState().manifest.id;
  workbench.properties.commit([edit(10)]);
  return { ...context, store, saved, edit, id, main };
}

const run = (workbench: Workbench, action: string) => workbench.actions.get(action)?.run();
const countOf = (workbench: Workbench) => workbench.trials.getSnapshot().count;

describe("saving what is being tried", () => {
  it("is what the key for saving does", async () => {
    const { workbench, saved } = await trying();
    run(workbench, "project.save");
    await vi.waitFor(() => expect(saved()).toBe(10));
    expect(countOf(workbench)).toBe(0);
  });

  it("does nothing else without anything being tried", async () => {
    const { workbench, store } = await trying();
    workbench.trials.discard();
    const { revision } = store;
    const trySave = vi.spyOn(workbench.session, "trySave");
    run(workbench, "project.save");
    await vi.waitFor(() => expect(trySave).toHaveBeenCalledOnce());
    expect(store.revision).toBe(revision);
  });

  it("is one step for undo", async () => {
    const { workbench, saved, edit } = await trying();
    workbench.properties.commit([edit(20)]);
    await workbench.save();
    expect(saved()).toBe(20);
    run(workbench, "edit.undo");
    expect(saved()).toBeUndefined();
    expect(countOf(workbench)).toBe(0);
  });

  it("says so when it went over what somebody else wrote", async () => {
    const { workbench, store } = await trying();
    const edits = [{ owner: { clip: "c" }, path: "transform.x", op: "set", value: 3 }];
    store.execute(
      { type: "property.edit", params: { timeline: "main", edits } },
      { origin: aiTask("t") },
    );
    await workbench.save();
    expect(notices(workbench)).toContain("notice.trialOverwrote");
  });

  it("keeps it all and says why when it cannot be saved", async () => {
    const { workbench, store, main } = await trying();
    const track = main()?.clips["c"]?.track;
    const changes = { locked: true };
    store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
    await workbench.save();
    expect(countOf(workbench)).toBe(1);
    expect(notices(workbench)).toContain("notice.commandFailed");
  });
});

describe("undo while trying things out", () => {
  it("goes through what was tried, and leaves the history of the project alone", async () => {
    const { workbench, store, edit } = await trying();
    workbench.properties.commit([edit(20)]);
    const depth = store.lastStep;
    run(workbench, "edit.undo");
    expect(workbench.trials.getValues().get("c")?.get("transform.x")).toBe(10);
    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(0);
    expect(store.lastStep).toBe(depth);
    run(workbench, "edit.redo");
    run(workbench, "edit.redo");
    expect(workbench.trials.getValues().get("c")?.get("transform.x")).toBe(20);
    expect(store.lastStep).toBe(depth);
  });

  it("goes back in the order people worked in", async () => {
    const { workbench, store, main } = await trying();
    const move = { timeline: "main", clips: [{ clip: "c", start: "9" }] };
    store.execute({ type: "clip.move", params: move });
    run(workbench, "edit.undo");
    expect(main()?.clips["c"]?.start).toBe("0");
    expect(countOf(workbench)).toBe(1);
    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(0);
    run(workbench, "edit.redo");
    expect(countOf(workbench)).toBe(1);
    expect(main()?.clips["c"]?.start).toBe("0");
    run(workbench, "edit.redo");
    expect(main()?.clips["c"]?.start).toBe("9");
  });

  it("goes forward in that order too, whichever came first", async () => {
    const { workbench, store, main, edit } = await trying();
    const x = () => workbench.trials.getValues().get("c")?.get("transform.x");
    const move = { timeline: "main", clips: [{ clip: "c", start: "9" }] };
    store.execute({ type: "clip.move", params: move });
    workbench.properties.commit([edit(20)]);
    run(workbench, "edit.undo");
    expect(x()).toBe(10);
    run(workbench, "edit.undo");
    expect(main()?.clips["c"]?.start).toBe("0");
    run(workbench, "edit.redo");
    expect(main()?.clips["c"]?.start).toBe("9");
    expect(x()).toBe(10);
    run(workbench, "edit.redo");
    expect(x()).toBe(20);
  });

  it.each([
    ["a lock", "locked"],
    ["what somebody else wrote", "changed"],
  ])("gets to what was tried after %s kept a step from going back", async (_, obstacle) => {
    const { workbench, store, main } = await trying();
    const move = { timeline: "main", clips: [{ clip: "c", start: "2" }] };
    store.execute({ type: "clip.move", params: move });
    const origin = { origin: aiTask("t") };
    if (obstacle === "locked") {
      const track = main()?.clips["c"]?.track;
      const changes = { locked: true };
      store.execute({ type: "track.update", params: { timeline: "main", track, changes } }, origin);
    } else {
      const moved = { timeline: "main", clips: [{ clip: "c", start: "3" }] };
      store.execute({ type: "clip.move", params: moved }, origin);
    }
    const start = main()?.clips["c"]?.start;

    run(workbench, "edit.undo");
    expect(notices(workbench)).toContain(`notice.undoBlocked.${obstacle}`);
    expect(main()?.clips["c"]?.start).toBe(start);
    expect(countOf(workbench)).toBe(1);

    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(0);
    expect(main()?.clips["c"]?.start).toBe(start);
    run(workbench, "edit.redo");
    expect(countOf(workbench)).toBe(1);
  });

  it("says what stayed when only a part of a step goes back, and goes on after that", async () => {
    const { workbench, store, main } = await trying();
    const batch = [
      { type: "project.rename", params: { name: "改名" } },
      { type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", start: "9" }] } },
    ];
    store.executeBatch(batch);
    const track = main()?.clips["c"]?.track;
    const changes = { locked: true };
    store.execute(
      { type: "track.update", params: { timeline: "main", track, changes } },
      { origin: aiTask("t") },
    );
    run(workbench, "edit.undo");
    expect(notices(workbench)).toContain("notice.undoPartly.locked");
    expect(store.getState().manifest.name).toBe("试改");
    expect(main()?.clips["c"]?.start).toBe("9");
    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(0);
  });

  it("takes back what was tried on a track that got locked, because it is not in the project", async () => {
    const { workbench, store, main } = await trying();
    const track = main()?.clips["c"]?.track;
    const changes = { locked: true };
    store.execute(
      { type: "track.update", params: { timeline: "main", track, changes } },
      { origin: aiTask("t") },
    );
    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(0);
  });

  it("goes on with the project when nothing is left to go through", async () => {
    const { workbench, main } = await trying();
    run(workbench, "edit.undo");
    run(workbench, "edit.undo");
    expect(main()?.clips["c"]).toBeUndefined();
  });

  it("is on offer going forward as well, also with nothing ahead in the project", async () => {
    const { workbench, edit } = await trying();
    workbench.properties.commit([edit(20)]);
    expect(workbench.session.store?.canRedo).toBe(false);
    expect(workbench.actions.get("edit.redo")?.enabled?.()).toBe(false);
    run(workbench, "edit.undo");
    expect(workbench.actions.get("edit.redo")?.enabled?.()).toBe(true);
  });

  it("is on offer as soon as something is tried, also with no history in the project", async () => {
    const { workbench, id, edit } = await trying();
    workbench.trials.discard();
    await workbench.closeProject();
    await workbench.openProject(id);
    expect(workbench.session.store?.canUndo).toBe(false);
    expect(workbench.actions.get("edit.undo")?.enabled?.()).toBe(false);
    workbench.properties.commit([edit(20)]);
    expect(workbench.actions.get("edit.undo")?.enabled?.()).toBe(true);
    expect(workbench.trials.undoesFirst).toBe(true);
  });
});

describe("leaving a project with something being tried", () => {
  it("asks, and staying leaves everything as it is", async () => {
    const { workbench } = await trying();
    const leaving = workbench.closeProject();
    expect(await dialogOf(workbench)).toMatchObject({ kind: "choice" });
    workbench.dialogs.answer(undefined);
    await leaving;
    expect(workbench.session.store).toBeDefined();
    expect(countOf(workbench)).toBe(1);
  });

  it("saves when people say so, and then it is in the project", async () => {
    const { workbench, library, id } = await trying();
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await leaving;
    expect(workbench.session.store).toBeUndefined();
    const opening = workbench.openProject(id);
    await opening;
    const state = workbench.session.store?.getState();
    expect(state?.timelines["main"]?.clips["c"]?.properties?.["transform.x"]).toBe(10);
    expect(countOf(workbench)).toBe(0);
    expect(library.summaries.has(id)).toBe(true);
  });

  it("gives up when people say so, and nothing comes back", async () => {
    const { workbench, id } = await trying();
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("discard");
    await leaving;
    await workbench.openProject(id);
    await workbench.trials.settle();
    expect(countOf(workbench)).toBe(0);
  });

  it("keeps it for the next time when people say so, on this device", async () => {
    const { workbench, id, saved } = await trying();
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("keep");
    await leaving;
    expect(workbench.session.store).toBeUndefined();
    await workbench.openProject(id);
    await workbench.trials.settle();
    expect(countOf(workbench)).toBe(1);
    expect(workbench.trials.getValues().get("c")?.get("transform.x")).toBe(10);
    expect(notices(workbench)).toContain("notice.trialRestored");
    expect(
      workbench.session.store?.getState().timelines["main"]?.clips["c"]?.properties,
    ).toBeUndefined();
    expect(saved()).toBeUndefined();
  });

  it("stays when saving does not work", async () => {
    const { workbench, store, main } = await trying();
    const track = main()?.clips["c"]?.track;
    store.execute({
      type: "track.update",
      params: { timeline: "main", track, changes: { locked: true } },
    });
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await leaving;
    expect(workbench.session.store).toBeDefined();
    expect(countOf(workbench)).toBe(1);
  });

  it("warns once more when what should stay cannot be kept", async () => {
    const { workbench, trials, edit } = await trying();
    await workbench.trials.settle();
    trials.failing = true;
    workbench.properties.commit([edit(20)]);
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("keep");
    await vi.waitFor(() =>
      expect(workbench.dialogs.getSnapshot()).toMatchObject({ kind: "confirm", danger: true }),
    );
    workbench.dialogs.answer(false);
    await leaving;
    expect(workbench.session.store).toBeDefined();
  });

  it("waits for what was kept, and asks about that too", async () => {
    const { workbench, id, trials } = await trying();
    await workbench.trials.settle();
    const leaving = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("keep");
    await leaving;
    let finish = () => {};
    trials.duringLoad = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await workbench.openProject(id);
    expect(countOf(workbench)).toBe(0);
    await vi.waitFor(() => expect(trials.held.size).toBe(1));
    const again = workbench.closeProject();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    finish();
    expect(await dialogOf(workbench)).toMatchObject({ kind: "choice" });
    workbench.dialogs.answer(undefined);
    await again;
    expect(workbench.session.store).toBeDefined();
  });

  it("does not ask when nothing is being tried", async () => {
    const { workbench } = await trying();
    workbench.trials.discard();
    await workbench.closeProject();
    expect(workbench.session.store).toBeUndefined();
  });

  it("goes for opening another project and for making a new one as well", async () => {
    const { workbench, id } = await trying();
    const leaving = workbench.openProject(id);
    expect(await dialogOf(workbench)).toMatchObject({ kind: "choice" });
    workbench.dialogs.answer(undefined);
    await leaving;
    expect(countOf(workbench)).toBe(1);
  });
});

describe("what is set aside", () => {
  it("gets asked about on the way out when it cannot be kept", async () => {
    const { workbench, trials, store, edit } = await trying();
    await workbench.trials.settle();
    trials.failing = true;
    workbench.properties.commit([edit(20)]);
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(workbench.trials.getSnapshot()).toMatchObject({ count: 0, setAside: 1 });
    const leaving = workbench.closeProject();
    expect(await dialogOf(workbench)).toMatchObject({ kind: "confirm" });
    workbench.dialogs.answer(false);
    await leaving;
    expect(workbench.session.store).toBeDefined();
  });

  it("can be given up on from the menu, with nothing else being tried", async () => {
    const { workbench, store } = await trying();
    const discard = workbench.actions.get("trial.discard");
    const compare = workbench.actions.get("trial.compare");
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(notices(workbench)).toContain("notice.trialSetAside");
    expect(countOf(workbench)).toBe(0);
    expect(discard?.enabled?.()).toBe(true);
    expect(compare?.enabled?.()).toBe(false);
    run(workbench, "trial.discard");
    expect(workbench.trials.getSnapshot().setAside).toBe(0);
    expect(discard?.enabled?.()).toBe(false);
  });

  it("is no reason to ask when leaving", async () => {
    const { workbench, store } = await trying();
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    await workbench.closeProject();
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    expect(workbench.session.store).toBeUndefined();
  });

  it("comes back with undo, and people hear about it", async () => {
    const { workbench, store } = await trying();
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    run(workbench, "edit.undo");
    expect(countOf(workbench)).toBe(1);
    expect(notices(workbench)).toContain("notice.trialBack");
  });
});

describe("exporting with something being tried", () => {
  const target = (): FolderAccess => {
    const access = {
      chooseSource: async () => undefined,
      chooseTarget: vi.fn(async () => undefined),
    };
    return access;
  };

  it("asks first, and cancelling goes no further", async () => {
    const folders = target();
    const { workbench } = await trying(folders);
    const exporting = workbench.exportProject();
    expect(await dialogOf(workbench)).toMatchObject({ kind: "choice" });
    workbench.dialogs.answer(undefined);
    await exporting;
    expect(folders.chooseTarget).not.toHaveBeenCalled();
  });

  it("goes on with what is saved when people say so, and what is tried stays", async () => {
    const folders = target();
    const { workbench, saved } = await trying(folders);
    const exporting = workbench.exportProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("saved");
    await exporting;
    expect(folders.chooseTarget).toHaveBeenCalledOnce();
    expect(saved()).toBeUndefined();
    expect(countOf(workbench)).toBe(1);
  });

  it("saves first when people say so", async () => {
    const folders = target();
    const { workbench, saved } = await trying(folders);
    const exporting = workbench.exportProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await exporting;
    expect(saved()).toBe(10);
    expect(folders.chooseTarget).toHaveBeenCalledOnce();
  });

  it("does not ask without anything being tried", async () => {
    const folders = target();
    const { workbench } = await trying(folders);
    workbench.trials.discard();
    await workbench.exportProject();
    expect(folders.chooseTarget).toHaveBeenCalledOnce();
  });

  it("goes no further when saving first does not work", async () => {
    const folders = target();
    const { workbench, store, main } = await trying(folders);
    const track = main()?.clips["c"]?.track;
    const changes = { locked: true };
    store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
    const exporting = workbench.exportProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await exporting;
    expect(folders.chooseTarget).not.toHaveBeenCalled();
    expect(notices(workbench)).toContain("notice.commandFailed");
    expect(countOf(workbench)).toBe(1);
  });
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
    const addColorCall = (store: ProjectStore | undefined) => ({
      type: "clip.add",
      params: {
        timeline: "main",
        track: firstTrack(store)?.id,
        clip: { start: "0", duration: "1", source: { kind: "color", color: "#000000" } },
      },
    });
    const setTrackClip = (store: ProjectStore | undefined) => store?.execute(addColorCall(store));
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
      expect(notices(workbench)).toEqual(["notice.undoBlocked.changed"]);
      expect(nameOf(workbench)).toBe("三");
      expect(firstTrack(store)?.name).toBe("我的轨道");
      undo?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked.changed"]);
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
      expect(notices(workbench)).toEqual(["notice.undoBlocked.changed"]);
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
      expect(notices(workbench)).toEqual(["notice.undoPartly.changed"]);
      expect(nameOf(workbench)).toBe("三");
    });

    const addAsset = (store: ProjectStore | undefined) =>
      store?.execute({
        type: "asset.add",
        params: { id: "a", asset: { kind: "image", path: "assets/a.png", storage: "local" } },
      });
    const useAsset = (store: ProjectStore | undefined, options = {}) =>
      store?.execute(
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track: firstTrack(store)?.id,
            clip: {
              start: "0",
              duration: "1",
              source: { kind: "image", media: { asset: "a" } },
            },
          },
        },
        options,
      );

    it("says something is still in use, when that is why", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      addAsset(store);
      useAsset(store, AI);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked.inUse"]);
    });

    it("says part of it is still in use, when that is why", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      store?.executeBatch([
        { type: "project.rename", params: { name: "二" } },
        {
          type: "asset.add",
          params: { id: "a", asset: { kind: "image", path: "assets/a.png", storage: "local" } },
        },
      ]);
      useAsset(store, AI);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoPartly.inUse"]);
    });

    const lockTrack = (store: ProjectStore | undefined) =>
      store?.execute(
        {
          type: "track.update",
          params: { timeline: "main", track: firstTrack(store)?.id, changes: { locked: true } },
        },
        AI,
      );

    it("says the track is locked, when that is why", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      setTrackClip(store);
      lockTrack(store);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoBlocked.locked"]);
    });

    it("says part of it is on a locked track, when that is why", async () => {
      const { workbench } = setup();
      await create(workbench, "一");
      const { store } = workbench.session;
      store?.executeBatch([
        { type: "project.rename", params: { name: "二" } },
        addColorCall(store),
      ]);
      lockTrack(store);
      workbench.actions.get("edit.undo")?.run();
      expect(notices(workbench)).toEqual(["notice.undoPartly.locked"]);
      expect(nameOf(workbench)).toBe("一");
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
