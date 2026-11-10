import { ProjectStore, aiTask, orderedTracks } from "@animaquill/core";
import type {
  AccountAccess,
  AccountSnapshot,
  FolderAccess,
  Host,
  SignInOutcome,
} from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTarget, memorySource } from "../transfer/memory-folder.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { layouts } from "./layouts.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
  saveFile: () => {},
  chooseFile: async () => undefined,
  reopen: async () => "gone" as const,
  dropTarget: async () => false,
  savesInBrowser: false,
};

function setup(folders = noFolders, more: Partial<Host> = {}) {
  const library = new MemoryLibrary();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const values = new Map<string, unknown>();
  const host: Host = {
    ...more,
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
    drafts,
    exports: new MemoryExports(),
  };
  const workbench = new Workbench({
    host,
    t: ((key: string) => key) as never,
    version: "test",
    platform: "other",
    panels: [],
    layouts,
    compositorUrl: "",
  });
  return { workbench, library, trials, drafts };
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
async function trying(folders = noFolders, more: Partial<Host> = {}) {
  const context = setup(folders, more);
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
    const { workbench, store } = await trying();
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
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

  it("gets to what was tried after what somebody else wrote kept a step from going back", async () => {
    const { workbench, store, main } = await trying();
    const move = { timeline: "main", clips: [{ clip: "c", start: "2" }] };
    store.execute({ type: "clip.move", params: move });
    const moved = { timeline: "main", clips: [{ clip: "c", start: "3" }] };
    store.execute({ type: "clip.move", params: moved }, { origin: aiTask("t") });
    const start = main()?.clips["c"]?.start;

    run(workbench, "edit.undo");
    expect(notices(workbench)).toContain("notice.undoBlocked.changed");
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
    const moved = { timeline: "main", clips: [{ clip: "c", start: "3" }] };
    store.execute({ type: "clip.move", params: moved }, { origin: aiTask("t") });
    run(workbench, "edit.undo");
    expect(notices(workbench)).toContain("notice.undoPartly.changed");
    expect(store.getState().manifest.name).toBe("试改");
    expect(main()?.clips["c"]?.start).toBe("3");
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
    const { workbench, store } = await trying();
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
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

describe("exporting a frame", () => {
  it("needs a project, and is in the file menu", async () => {
    const { workbench } = setup();
    const action = workbench.actions.get("project.exportFrame");
    expect(action?.enabled?.()).toBe(false);
    await create(workbench, "我的项目");
    expect(action?.enabled?.()).toBe(true);
    const ids = workbench.actions
      .menu("file")
      .flat()
      .map(({ id }) => id);
    expect(ids).toContain("project.exportFrame");
  });

  it("goes straight on with nothing being tried", async () => {
    const { workbench } = setup();
    await create(workbench, "我的项目");
    const made = vi.spyOn(workbench.stills, "run").mockResolvedValue();
    await workbench.exportFrame();
    expect(made).toHaveBeenCalledOnce();
  });

  it("asks first with something being tried, and cancelling goes no further", async () => {
    const { workbench } = await trying();
    const made = vi.spyOn(workbench.stills, "run").mockResolvedValue();
    const exporting = workbench.exportFrame();
    expect(await dialogOf(workbench)).toMatchObject({
      kind: "choice",
      message: "trial.exportMessage",
    });
    workbench.dialogs.answer(undefined);
    await exporting;
    expect(made).not.toHaveBeenCalled();
  });

  it("leaves what is tried out of it when people say so, and it stays", async () => {
    const { workbench, saved } = await trying();
    const made = vi.spyOn(workbench.stills, "run").mockResolvedValue();
    const exporting = workbench.exportFrame();
    await dialogOf(workbench);
    workbench.dialogs.answer("saved");
    await exporting;
    expect(made).toHaveBeenCalledOnce();
    expect(saved()).toBeUndefined();
    expect(countOf(workbench)).toBe(1);
  });

  it("saves first when people say so, so that the frame has it", async () => {
    const { workbench, saved } = await trying();
    let then: unknown;
    vi.spyOn(workbench.stills, "run").mockImplementation(async () => {
      then = saved();
    });
    const exporting = workbench.exportFrame();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await exporting;
    expect(then).toBe(10);
  });
});

describe("exporting a video", () => {
  it("needs a project, and is in the file menu", async () => {
    const { workbench } = setup();
    const action = workbench.actions.get("project.exportVideo");
    expect(action?.enabled?.()).toBe(false);
    await create(workbench, "我的项目");
    expect(action?.enabled?.()).toBe(true);
    expect(
      workbench.actions
        .menu("file")
        .flat()
        .map(({ id }) => id),
    ).toContain("project.exportVideo");
  });

  it("asks first with something being tried, like any export", async () => {
    const { workbench } = await trying();
    const started = vi.spyOn(workbench.videos, "start").mockResolvedValue();
    const exporting = workbench.exportVideo();
    expect(await dialogOf(workbench)).toMatchObject({ message: "trial.exportMessage" });
    workbench.dialogs.answer(undefined);
    await exporting;
    expect(started).not.toHaveBeenCalled();
  });

  it("goes on with what is saved when people say so", async () => {
    const { workbench, saved } = await trying();
    const started = vi.spyOn(workbench.videos, "start").mockResolvedValue();
    const exporting = workbench.exportVideo();
    await dialogOf(workbench);
    workbench.dialogs.answer("saved");
    await exporting;
    expect(started).toHaveBeenCalledOnce();
    expect(saved()).toBeUndefined();
  });
});

describe("exporting with something being tried", () => {
  const target = (): FolderAccess => {
    const access = {
      chooseSource: async () => undefined,
      chooseTarget: vi.fn(async () => undefined),
      saveFile: vi.fn(),
      chooseFile: async () => undefined,
      reopen: async () => "gone" as const,
      dropTarget: async () => false,
      savesInBrowser: false,
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
    const { workbench, store } = await trying(folders);
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
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

describe("code", () => {
  const PATH = "code/a.js";

  async function withCode() {
    const context = setup();
    const { workbench } = context;
    await create(workbench, "项目");
    const store = workbench.session.store as ProjectStore;
    store.execute({ type: "file.write", params: { path: PATH, text: "one" } });
    workbench.code.open(PATH);
    workbench.code.edit(PATH, "mine");
    return { ...context, store };
  }

  it("stays with unsaved code when people want that", async () => {
    const { workbench } = await withCode();
    const closing = workbench.closeProject();
    expect((await dialogOf(workbench))?.title).toBe("code.leaveTitle");
    workbench.dialogs.answer(undefined);
    await closing;
    expect(workbench.session.store).toBeDefined();
    expect(workbench.code.hasUnsaved).toBe(true);
  });

  it("saves unsaved code on the way out", async () => {
    const { workbench, store } = await withCode();
    const closing = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await closing;
    expect(workbench.session.store).toBeUndefined();
    expect(store.exportFiles().files.get(PATH)).toBe("mine");
  });

  it("stays when code cannot be saved on the way out", async () => {
    const { workbench, store } = await withCode();
    vi.spyOn(store, "execute").mockReturnValue({
      ok: false,
      error: { code: "project-locked", message: "锁定了" },
    });
    const closing = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("save");
    await closing;
    expect(workbench.session.store).toBeDefined();
    expect(workbench.code.getSnapshot().documents[0]?.text).toBe("mine");
  });

  it("drops unsaved code on the way out when people say so, also on the device", async () => {
    const { workbench, store, drafts } = await withCode();
    const id = store.getState().manifest.id;
    await workbench.drafts.settle();
    expect([...(drafts.kept.get(id)?.values() ?? [])]).toHaveLength(1);
    const closing = workbench.closeProject();
    await dialogOf(workbench);
    workbench.dialogs.answer("discard");
    await closing;
    await workbench.drafts.settle();
    expect(workbench.session.store).toBeUndefined();
    expect(store.exportFiles().files.get(PATH)).toBe("one");
    expect([...(drafts.kept.get(id)?.values() ?? [])]).toEqual([]);
  });

  it("saves the file with the key that saves in the code panel, and only there", async () => {
    const { workbench, store } = await withCode();
    run(workbench, "project.save");
    expect(store.exportFiles().files.get(PATH)).toBe("one");
    run(workbench, "code.save");
    await vi.waitFor(() => expect(store.exportFiles().files.get(PATH)).toBe("mine"));
  });
});

describe("problems", () => {
  const problem = { kind: "error", message: "oops", frame: 0 } as const;

  async function opened() {
    const context = setup();
    await create(context.workbench, "项目");
    return context;
  }

  it("all go on the list, and only the first one of a state of a scene is told", async () => {
    const { workbench } = await opened();
    const { preview, problems } = workbench;
    preview.noteProblem("c", "1", problem);
    preview.noteProblem("c", "1", { ...problem, line: 2 });
    preview.noteProblem("c", "1", { ...problem, line: 3 });
    expect(problems.getSnapshot().errors).toBe(3);
    expect(notices(workbench)).toHaveLength(1);
    preview.noteProblem("c", "2", problem);
    expect(notices(workbench)).toHaveLength(2);
  });

  it("are not told while the list is on the screen", async () => {
    const { workbench } = await opened();
    vi.spyOn(workbench.layout, "getSnapshot").mockReturnValue({
      layout: "edit",
      layouts: [],
      visible: new Set(["problems"]),
      active: undefined,
    });
    workbench.preview.noteProblem("c", "1", problem);
    expect(workbench.problems.getSnapshot().errors).toBe(1);
    expect(notices(workbench)).toEqual([]);
  });

  it("say where they are in a column of their own", async () => {
    const { workbench } = await opened();
    const place = { file: "scenes/a/a.js", line: 3, column: 7 };
    workbench.preview.noteProblem("c", "1", { ...problem, ...place });
    expect(workbench.problems.getSnapshot().problems[0]).toMatchObject({
      ...place,
      text: "scene.problems.error",
    });
  });

  it("go when the scene gets a new state", async () => {
    const { workbench } = await opened();
    workbench.preview.noteProblem("c", "1", problem);
    workbench.preview.noteRevisions(new Map([["c", "2"]]));
    expect(workbench.problems.getSnapshot().problems).toEqual([]);
  });

  it("include scenes that stopped, until they run again", async () => {
    const { workbench } = await opened();
    workbench.preview.noteScene("c", { state: "stopped", reason: "silent" });
    expect(workbench.problems.getSnapshot().errors).toBe(1);
    workbench.preview.noteScene("c", { state: "ready" });
    expect(workbench.problems.getSnapshot().errors).toBe(0);
  });

  it("stay with their project", async () => {
    const { workbench } = await opened();
    workbench.preview.noteProblem("c", "1", problem);
    await workbench.closeProject();
    expect(workbench.problems.getSnapshot().problems).toEqual([]);
  });

  it("lead to the file and line", async () => {
    const { workbench } = await opened();
    const store = workbench.session.store as ProjectStore;
    store.execute({ type: "file.write", params: { path: "code/a.js", text: "one" } });
    const listed = { id: "", severity: "error", text: "", origin: "", file: "code/a.js", line: 4 };
    workbench.goToProblem(listed as never);
    expect(workbench.code.getSnapshot().reveal).toMatchObject({ path: "code/a.js", line: 4 });
  });

  it("say so when the file is not there to go to", async () => {
    const { workbench } = await opened();
    const listed = { id: "", severity: "error", text: "", origin: "", file: "assets.json" };
    workbench.goToProblem(listed as never);
    expect(notices(workbench)).toEqual(["problems.notInProject"]);
    expect(workbench.code.getSnapshot().documents).toEqual([]);
  });

  it("of an import stay on the list after its dialog", async () => {
    const store = ProjectStore.create(createProject({ name: "文件夹里的项目" }));
    const files = store.exportFiles().files;
    files.set("notes/left.txt", "这个文件项目用不上");
    const source = memorySource("文件夹", files);
    const { workbench } = setup({ ...noFolders, chooseSource: async () => source });
    const importing = workbench.importProject();
    await vi.waitFor(() => expect(workbench.problems.getSnapshot().imported).toBe(true));
    workbench.dialogs.answer(true);
    await importing;
    expect(workbench.problems.getSnapshot().warnings).toBeGreaterThan(0);
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

describe("the black box", () => {
  const kinds = (workbench: Workbench) =>
    workbench.diagnostics.trail.entries().map((entry) => {
      const { t, ...rest } = entry;
      expect(t).toBeTypeOf("number");
      return rest;
    });

  it("has what people did, by name, and nothing they wrote", async () => {
    const { workbench } = setup();
    await create(workbench, "秘密发布会");
    const store = workbench.session.store as ProjectStore;
    const action = workbench.actions.get("layout.reset");
    if (!action) throw new Error("No action");
    workbench.actions.perform(action, "palette");
    store.execute({ type: "project.rename", params: { name: "更秘密的名字" } });
    store.execute({ type: "project.rename", params: { name: "" } });
    const trail = kinds(workbench);
    expect(trail).toContainEqual({ kind: "project", open: true });
    expect(trail).toContainEqual({ kind: "action", id: "layout.reset", way: "palette" });
    expect(trail).toContainEqual({ kind: "command", name: "project.rename", by: "user", ok: true });
    expect(trail).toContainEqual({
      kind: "command",
      name: "project.rename",
      by: "user",
      ok: false,
      code: "invalid-params",
    });
    expect(JSON.stringify(trail)).not.toMatch(/秘密/);
  });

  it("follows the project that is open now", async () => {
    const { workbench } = setup();
    await create(workbench, "一");
    const first = workbench.session.store as ProjectStore;
    await create(workbench, "二");
    first.execute({ type: "project.rename", params: { name: "旧的" } });
    expect(kinds(workbench).filter(({ kind }) => kind === "command")).toEqual([]);
  });

  it("reports a command that went wrong, with its name and no project in it", async () => {
    const { workbench } = setup();
    await create(workbench, "SecretLaunch");
    const store = workbench.session.store as ProjectStore;
    const broken = new TypeError("SecretLaunch cannot be renamed");
    vi.spyOn(store.doc, "transact").mockImplementation(() => {
      throw broken;
    });
    expect(() => store.execute({ type: "project.rename", params: { name: "x" } })).toThrow(broken);
    const [caught] = workbench.errors.getSnapshot().errors;
    expect(caught?.report.error).toMatchObject({
      source: "command",
      name: "TypeError",
      commands: ["project.rename"],
    });
    expect(JSON.stringify(caught?.report)).not.toContain("SecretLaunch");
    expect(caught?.report.trail.at(-2)).toMatchObject({
      kind: "command",
      name: "project.rename",
      code: "threw",
    });
  });
});

describe("the report of how it runs", () => {
  it("has only these facts about a project, and none of its names", async () => {
    const { workbench } = setup();
    await create(workbench, "秘密发布会");
    const store = workbench.session.store as ProjectStore;
    const main = store.getState().timelines["main"];
    const track = orderedTracks(main as never).find(({ kind }) => kind === "video")?.id;
    const added = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        clip: {
          id: "clip_a",
          start: "0",
          duration: "2",
          source: { kind: "color", color: "#ff0000" },
        },
      },
    });
    expect(added.ok).toBe(true);
    // What the device says about itself, which a page has.
    vi.stubGlobal("screen", { width: 1440, height: 900 });
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    try {
      workbench.finishDiagnostics();
    } finally {
      vi.unstubAllGlobals();
    }
    const report = workbench.diagnostics.getSnapshot().report;
    expect(Object.keys(report ?? {}).toSorted()).toEqual(
      [
        "device",
        "dropped",
        "durationMs",
        "during",
        "events",
        "format",
        "frameTimes",
        "project",
        "startedAt",
        "version",
      ].toSorted(),
    );
    const project = report?.project as Record<string, unknown>;
    expect(Object.keys(project).toSorted()).toEqual(
      [
        "assets",
        "clips",
        "formats",
        "fps",
        "layout",
        "previewQuality",
        "storage",
        "tracks",
      ].toSorted(),
    );
    expect(project["storage"]).toBe("browser");
    // Which decides whether the preview decodes proxies, which a project in the browser has none of.
    expect(project["previewQuality"]).toBe("auto");
    const layout = project["layout"] as Record<string, unknown>[];
    expect(layout).toEqual([{ id: "clip_a", kind: "color", track, start: 0, end: 2, offset: 0 }]);
    expect(JSON.stringify(report)).not.toContain("秘密");
  });
});

describe("keys of AI services", () => {
  it("never get into a report of an error, or into what happened before it", async () => {
    const { workbench } = setup();
    await create(workbench, "报告");
    const key = "sk-ant-api03-SECRETSECRET0123456789";
    const id = workbench.ai.add("anthropic", "Anthropic") as string;
    await workbench.ai.setKey(id, key);
    workbench.errors.capture("window", new Error(`401 invalid x-api-key: ${key}`));
    workbench.errors.capture("window", new Error(`Fetch "${key}" failed`));
    const report = JSON.stringify(workbench.errors.getSnapshot());
    expect(report).not.toContain("SECRETSECRET");
    // How the editor runs is told by what happened, which never has a key in it.
    expect(JSON.stringify(workbench.diagnostics.trail.entries())).not.toContain("SECRETSECRET");
  });
});

/** An account where the editor is hosted, which notes what the editor asks of it. */
function fakeAccount(snapshot: AccountSnapshot = { status: "signedOut" }, outcome?: SignInOutcome) {
  const asked: string[] = [];
  let current = snapshot;
  let told = outcome;
  const account: AccountAccess & { failing: boolean } = {
    failing: false,
    subscribe: () => () => {},
    getSnapshot: () => current,
    refresh: async () => {},
    takeOutcome() {
      const taken = told;
      told = undefined;
      return taken;
    },
    signIn: () => void asked.push("signIn"),
    installApp: () => void asked.push("installApp"),
    async signOut() {
      asked.push("signOut");
      if (account.failing) throw new Error("offline");
      current = { status: "signedOut" };
    },
  };
  return { account, asked };
}

describe("leaving the page to sign in", () => {
  it("keeps what is being tried first, and the project with its address", async () => {
    const { account, asked } = fakeAccount();
    const { workbench, trials, id } = await trying(noFolders, { account });
    // Keeping takes a moment, and the page must not go before it is done.
    let keptWhenLeaving: unknown;
    trials.duringSave = () => new Promise((done) => setTimeout(done, 30));
    workbench.properties.commit([
      { owner: { clip: "c" }, path: "transform.x", op: "write", time: "1", value: 20 },
    ]);
    const signIn = account.signIn;
    account.signIn = () => {
      keptWhenLeaving = structuredClone([...(trials.kept.get(id)?.values() ?? [])]);
      signIn();
    };
    await workbench.signIn();
    expect(asked).toEqual(["signIn"]);
    expect(JSON.stringify(keptWhenLeaving)).toContain("20");
    expect(workbench.leavingPage).toBe(true);
    expect(workbench.trials.notKept).toBe(false);
    // Nothing closed: the page comes back to this project.
    expect(workbench.session.store?.getState().manifest.id).toBe(id);
    expect(countOf(workbench)).toBe(1);
  });

  it("keeps code that is not saved first, without saving it, and without asking", async () => {
    const { account, asked } = fakeAccount();
    const { workbench, drafts } = setup(noFolders, { account });
    await create(workbench, "项目");
    const store = workbench.session.store as ProjectStore;
    const id = store.getState().manifest.id;
    store.execute({ type: "file.write", params: { path: "code/a.js", text: "one" } });
    workbench.code.open("code/a.js");
    drafts.duringSave = () => new Promise((done) => setTimeout(done, 30));
    let keptWhenLeaving: unknown;
    const signIn = account.signIn;
    account.signIn = () => {
      keptWhenLeaving = structuredClone([...(drafts.kept.get(id)?.values() ?? [])]);
      signIn();
    };
    workbench.code.edit("code/a.js", "mine");
    await workbench.signIn();
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    expect(asked).toEqual(["signIn"]);
    expect(JSON.stringify(keptWhenLeaving)).toContain("mine");
    expect(store.exportFiles().files.get("code/a.js")).toBe("one");
    expect(workbench.code.hasUnsaved).toBe(true);
  });

  it("asks before leaving what could not be saved, and stays when told to", async () => {
    const { account, asked } = fakeAccount();
    const { workbench, library } = setup(noFolders, { account });
    await create(workbench, "一");
    await failToSave(workbench, library);
    const leaving = workbench.signIn();
    expect((await dialogOf(workbench))?.title).toBe("app.leaveUnsavedTitle");
    workbench.dialogs.answer(false);
    await leaving;
    expect(asked).toEqual([]);
    expect(workbench.leavingPage).toBe(false);

    const again = workbench.signIn();
    await dialogOf(workbench);
    workbench.dialogs.answer(true);
    await again;
    expect(asked).toEqual(["signIn"]);
    expect(workbench.leavingPage).toBe(true);
    library.failing = false;
    await workbench.session.trySave();
  });

  it("does not leave while something would stop halfway, such as bringing a project in", async () => {
    const { account, asked } = fakeAccount();
    const { workbench } = setup(noFolders, { account });
    await create(workbench, "一");
    vi.spyOn(workbench.transfer, "running", "get").mockReturnValue(true);
    const leaving = workbench.installApp();
    const dialog = await dialogOf(workbench);
    expect(dialog).toMatchObject({ title: "app.leaveBusyTitle", noticeOnly: true });
    workbench.dialogs.answer(true);
    await leaving;
    expect(asked).toEqual([]);
    expect(workbench.leavingPage).toBe(false);
  });

  it("says how the sign-in that brought the page here ended, and offers the App where it is missing", async () => {
    const { account, asked } = fakeAccount(
      { status: "signedIn", name: "octo", appInstalled: false },
      "signedIn",
    );
    const { workbench } = setup(noFolders, { account });
    await workbench.load();
    await vi.waitFor(() => expect(notices(workbench)).toEqual(["account.signedInWithoutApp"]));
    const [notice] = workbench.notifications.getSnapshot();
    expect(notice?.actions?.map((action) => action.label)).toEqual(["account.install"]);
    notice?.actions?.[0]?.run();
    await vi.waitFor(() => expect(asked).toEqual(["installApp"]));
  });

  it("says nothing more once the App is there, and what went wrong when it did", async () => {
    const installed = setup(noFolders, {
      account: fakeAccount({ status: "signedIn", name: "octo", appInstalled: true }, "signedIn")
        .account,
    });
    await installed.workbench.load();
    await vi.waitFor(() => expect(notices(installed.workbench)).toEqual(["account.signedIn"]));
    const failed = setup(noFolders, { account: fakeAccount(undefined, "expired").account });
    await failed.workbench.load();
    await vi.waitFor(() => expect(notices(failed.workbench)).toEqual(["account.outcome.expired"]));
    const nothing = setup(noFolders, { account: fakeAccount().account });
    await nothing.workbench.load();
    await Promise.resolve();
    expect(notices(nothing.workbench)).toEqual([]);
  });

  it("signs out without leaving, and says when that did not work", async () => {
    const { account, asked } = fakeAccount({
      status: "signedIn",
      name: "octo",
      appInstalled: true,
    });
    const { workbench } = setup(noFolders, { account });
    account.failing = true;
    await workbench.signOut();
    expect(notices(workbench)).toEqual(["account.signOutFailed"]);
    account.failing = false;
    await workbench.signOut();
    expect(notices(workbench)).toEqual(["account.signOutFailed", "account.signedOut"]);
    expect(asked).toEqual(["signOut", "signOut"]);
    expect(workbench.leavingPage).toBe(false);
  });

  it("is not there without accounts", async () => {
    const { workbench } = setup();
    expect(workbench.account).toBeUndefined();
    await workbench.signIn();
    await workbench.signOut();
    expect(workbench.leavingPage).toBe(false);
  });
});

describe("a platform to keep projects in step with", () => {
  it("is there only with an account, which is how people get to it", async () => {
    const { MemoryPlatform, TestCloudBrowser } = await import("../cloud/cloud-support.ts");
    const cloud = new TestCloudBrowser(new MemoryPlatform(), "ada").access({
      isAlive: () => true,
      asleep: false,
    });
    const without = setup(noFolders, { cloud });
    expect(without.workbench.cloud).toBeUndefined();
    expect(without.workbench.actions.get("cloud.connect")).toBeUndefined();
    const { account } = fakeAccount();
    const withAccount = setup(noFolders, { cloud, account });
    expect(withAccount.workbench.cloud).toBeDefined();
    expect(withAccount.workbench.actions.get("cloud.connect")).toBeDefined();
  });
});
