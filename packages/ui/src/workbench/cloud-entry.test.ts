/**
 * The ways from the workbench to the platform, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 4: two items in the file menu, one status
 * that opens the dialog that connects a project or the panel, and what the panel's buttons do.
 * `CloudConnect` and `cloudPanel` have tests of their own; these are about what the workbench
 * makes of them.
 */
import type { FolderAccess, Host } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import type { CloudConnect } from "../cloud/connect.ts";
import { account } from "../cloud/projects-support.ts";
import { FakeRepositories } from "../cloud/repository-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST, folderOf } from "./folder-windows.ts";
import { layouts } from "./layouts.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryPresence,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import { Workbench } from "./workbench.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
  saveFile: () => {},
  chooseFile: async () => undefined,
  reopen: async () => "gone" as const,
  dropTarget: async () => false,
  savesInBrowser: false,
};

const opened: Workbench[] = [];
afterEach(async () => {
  for (const workbench of opened.splice(0)) {
    workbench.dialogs.answer(undefined);
    await workbench.cloud?.close();
    await workbench.projectFolders?.close();
    await workbench.session.close();
  }
});

/** A window of a browser, on a platform that saves projects to repositories unless `cloud` is off. */
function windowOn(
  platform: MemoryPlatform,
  { folders = false, cloud = true, signedIn = true } = {},
) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const browser = new TestCloudBrowser(platform, "ada");
  const repositories = new FakeRepositories();
  repositories.platform = platform;
  const who = account(signedIn ? "signedIn" : "signedOut");
  const signIn = vi.spyOn(who, "signIn");
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
    folders: noFolders,
    ...(folders && { localFolders: memoryFolders(disk) }),
    trials: new MemoryTrials(),
    drafts: new MemoryTrials(),
    exports: new MemoryExports(),
    presence: new MemoryPresence().window(),
    ...(cloud && {
      account: who,
      cloud: {
        ...browser.access({ isAlive: () => true, asleep: false }),
        repository: repositories,
      },
    }),
  };
  const workbench = new Workbench({
    host,
    t: ((key: string, words?: Record<string, unknown>) =>
      words ? `${key} ${JSON.stringify(words)}` : key) as never,
    version: "test",
    platform: "other",
    panels: [],
    layouts,
    compositorUrl: "",
    folderTiming: FAST,
    cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20 },
    connectTiming: { patienceMs: 2000, checkMs: 5 },
  });
  opened.push(workbench);
  return { workbench, disk, library, links: browser.links, repositories, who, signIn };
}

const menuIds = (workbench: Workbench, name = "file") =>
  workbench.actions
    .menu(name)
    .flat()
    .map(({ id }) => id);

/** The dialog that connects the open project, once it shows. */
async function connectDialog(workbench: Workbench): Promise<CloudConnect> {
  await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("connect"));
  return (workbench.dialogs.getSnapshot() as Extract<DialogRequest, { kind: "connect" }>).connect;
}

/** Goes through the dialog as people do: the name as it is, "连接到云端", and "关闭". */
async function connected(workbench: Workbench): Promise<void> {
  const showing = workbench.connectToCloud();
  const connect = await connectDialog(workbench);
  await vi.waitFor(() => expect(connect.canSubmit).toBe(true));
  await connect.submit();
  expect(connect.getSnapshot().phase).toBe("archiving");
  expect(await connect.cancel()).toBe("closed");
  workbench.dialogs.answer(undefined);
  await showing;
}

describe("the file menu", () => {
  it("has two items about the platform, and the others stay in the palette by their ids", async () => {
    const { workbench } = windowOn(new MemoryPlatform());
    const cloud = menuIds(workbench).filter((id) => id.startsWith("cloud."));
    expect(cloud).toEqual(["cloud.open", "cloud.panel"]);
    for (const id of ["cloud.connect", "cloud.disconnect", "cloud.saveToGitHub"]) {
      const action = workbench.actions.get(id);
      expect(action, id).toBeDefined();
      expect(action?.menu, id).toBeUndefined();
      expect(action?.palette, id).not.toBe(false);
    }
    // Without a project there is nothing to say about one; the projects of the platform are there.
    expect(workbench.actions.get("cloud.panel")?.enabled?.()).toBe(false);
    expect(workbench.actions.get("cloud.open")?.enabled?.()).not.toBe(false);
  });

  it("offers to connect a project only once it is known whether it is connected", async () => {
    const { workbench } = windowOn(new MemoryPlatform());
    const canConnect = () => workbench.actions.get("cloud.connect")?.enabled?.();
    expect(workbench.cloudKnown.getSnapshot()).toBe(false);
    expect(canConnect()).toBe(false);
    expect(await workbench.session.create("片子")).toBe(true);
    await vi.waitFor(() => expect(workbench.cloudKnown.getSnapshot()).toBe(true));
    expect(canConnect()).toBe(true);
    await connected(workbench);
    expect(canConnect()).toBe(false);
    // Another project is looked at anew.
    await workbench.closeProject();
    expect(workbench.cloudKnown.getSnapshot()).toBe(false);
  });

  it("says nothing about a platform where the editor is hosted on none", () => {
    const { workbench } = windowOn(new MemoryPlatform(), { cloud: false });
    expect(workbench.cloud).toBeUndefined();
    expect(menuIds(workbench).filter((id) => id.startsWith("cloud."))).toEqual([]);
    expect(workbench.actions.get("cloud.connect")).toBeUndefined();
    expect(workbench.start.getSnapshot().cloudState).toBe("none");
  });

  it("offers a folder only to a project of the browser", async () => {
    const { workbench, disk } = windowOn(new MemoryPlatform(), { folders: true });
    // No project is open.
    expect(menuIds(workbench)).not.toContain("project.moveToFolder");
    expect(await workbench.session.create("在浏览器里")).toBe(true);
    expect(menuIds(workbench)).toContain("project.moveToFolder");

    // It moves into a folder: from then on there is nowhere to move it.
    disk.chooseNext("文档/片子");
    const moving = workbench.moveToFolder();
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("confirm"));
    workbench.dialogs.answer(false);
    expect(await moving).toBe(true);
    expect(folderOf(workbench)).toBeDefined();
    expect(menuIds(workbench)).not.toContain("project.moveToFolder");
    // Not in the palette either: it has no place there.
    const found = workbench.palette.search("", workbench.t).map(({ action }) => action.id);
    expect(found).not.toContain("project.moveToFolder");
    expect(found).toContain("project.close");
  });

  it("leaves out of the menu only what says it has no place", () => {
    const { workbench } = windowOn(new MemoryPlatform(), { cloud: false });
    workbench.actions.register({
      id: "test.hidden",
      title: () => "hidden",
      run: () => {},
      menu: { name: "test", group: "a" },
      visible: () => false,
    });
    workbench.actions.register({
      id: "test.shown",
      title: () => "shown",
      run: () => {},
      menu: { name: "test", group: "a" },
      enabled: () => false,
    });
    // Greyed out is still there.
    expect(menuIds(workbench, "test")).toEqual(["test.shown"]);
  });
});

describe("“云端…”", () => {
  it("opens the dialog for a project that is not connected, and the panel once it is", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links, repositories } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;

    workbench.showCloud();
    const connect = await connectDialog(workbench);
    expect(workbench.dialogs.getSnapshot()).toMatchObject({
      title: 'cloud.connect.title {"name":"片子","interpolation":{"escapeValue":false}}',
    });
    expect(workbench.cloudPanel.getSnapshot()).toBe(false);
    await vi.waitFor(() => expect(connect.canSubmit).toBe(true));
    await connect.submit();
    expect(connect.getSnapshot()).toMatchObject({ phase: "archiving" });
    const project = (await links.get(key))?.project as string;
    expect(platform.projects.has(project)).toBe(true);
    expect(repositories.links).toEqual([{ create: { name: "animaquill-project" } }]);
    // Closing now takes nothing back.
    expect(connect.takesBack).toBe(false);
    expect(await connect.cancel()).toBe("closed");
    workbench.dialogs.answer(undefined);
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()).toBeUndefined());
    expect(workbench.cloud?.getSnapshot().kind).toBe("linked");

    // It has its repository: there is nothing to connect, and the panel says how it goes.
    workbench.showCloud();
    await vi.waitFor(() => expect(workbench.cloudPanel.getSnapshot()).toBe(true));
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    // "连接到云端…" of the palette comes to the same.
    workbench.cloudPanel.set(false);
    await workbench.connectToCloud();
    expect(workbench.cloudPanel.getSnapshot()).toBe(true);
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();

    // Leaving the project closes the panel with it.
    await workbench.closeProject();
    expect(workbench.cloudPanel.getSnapshot()).toBe(false);
    workbench.showCloud();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workbench.cloudPanel.getSnapshot()).toBe(false);
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
  });

  it("opens the panel, never the dialog, for a connected project that just opened", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;
    await connected(workbench);
    const project = (await links.get(key))?.project;
    await workbench.closeProject();

    // Asked for the moment it is open, before anything looked at its link.
    let asked = 0;
    const stop = workbench.session.subscribe(() => {
      if (!workbench.session.store || asked++ > 0) return;
      expect(workbench.cloud?.getSnapshot().kind).toBe("none");
      void workbench.connectToCloud();
    });
    await workbench.openProject(key);
    stop();
    expect(asked).toBeGreaterThan(0);
    await vi.waitFor(() => expect(workbench.cloudPanel.getSnapshot()).toBe(true));
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
    // The link it had is the one it has: no second project was made for it.
    expect((await links.get(key))?.project).toBe(project);
    expect(platform.projects.size).toBe(1);
  });

  it("takes nothing back where another dialog takes the place of the one that connects", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links, repositories } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;
    // The repository cannot be made: the project is on the platform, by this dialog, without one.
    repositories.taken.add("mine");
    const showing = workbench.connectToCloud();
    const connect = await connectDialog(workbench);
    connect.picker.setName("mine");
    await vi.waitFor(() => expect(connect.picker.getSnapshot().nameProblem).toBe("taken"));
    repositories.taken.clear();
    connect.picker.setName("other");
    repositories.refuse.link = new Error("not now");
    await vi.waitFor(() => expect(connect.canSubmit).toBe(true));
    await connect.submit();
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      steps: { upload: "done", repository: "failed" },
    });
    expect(connect.takesBack).toBe(true);
    const project = (await links.get(key))?.project as string;

    // Something else asks: the dialog is gone, and so is nothing of what it made.
    const asking = workbench.dialogs.confirm({ title: "别的事", message: "", confirm: "好" });
    await showing;
    expect(workbench.dialogs.getSnapshot()?.kind).toBe("confirm");
    workbench.dialogs.answer(true);
    await asking;
    expect(platform.projects.has(project)).toBe(true);
    expect(platform.removed).toEqual([]);
    expect((await links.get(key))?.project).toBe(project);
    expect(workbench.cloud?.getSnapshot().kind).toBe("linked");

    // People go on from the panel: the dialog comes back for what is missing.
    workbench.runCloudAction("chooseRepository");
    const again = await connectDialog(workbench);
    expect(again).not.toBe(connect);
    await vi.waitFor(() => expect(again.getSnapshot().repositoryOnly).toBe(true));
    expect(workbench.dialogs.getSnapshot()).toMatchObject({ kind: "connect" });
  });

  it("comes back with what people chose once the page is back from signing in", async () => {
    const platform = new MemoryPlatform();
    const { workbench, who, signIn } = windowOn(platform, { signedIn: false });
    expect(await workbench.session.create("片子")).toBe(true);
    const showing = workbench.connectToCloud();
    const connect = await connectDialog(workbench);
    expect(connect.getSnapshot().need).toBe("signIn");
    connect.picker.setName("my-film");
    await connect.signIn();
    expect(signIn).toHaveBeenCalledOnce();
    // The page goes: its dialog with it.
    workbench.dialogs.answer(undefined);
    await showing;

    // ...and comes back, signed in, with the project open again.
    who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    await workbench.resume();
    const back = await connectDialog(workbench);
    expect(back).not.toBe(connect);
    expect(back.picker.getSnapshot()).toMatchObject({ mode: "create", name: "my-film" });
    expect(back.getSnapshot().need).toBeUndefined();
    // Only once: a reload after that starts nothing.
    workbench.dialogs.answer(undefined);
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()).toBeUndefined());
    await workbench.resume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
  });

  it("starts nothing by itself on a page that did not leave from the dialog", async () => {
    const { workbench } = windowOn(new MemoryPlatform());
    expect(await workbench.session.create("片子")).toBe(true);
    await workbench.resume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workbench.dialogs.getSnapshot()).toBeUndefined();
  });
});

describe("what the panel's buttons do", () => {
  it("asks before it disconnects, and says where the project of the platform is from then on", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;
    await connected(workbench);
    const project = (await links.get(key))?.project as string;

    workbench.cloudPanel.set(true);
    workbench.runCloudAction("disconnect");
    // The panel makes room for the question.
    expect(workbench.cloudPanel.getSnapshot()).toBe(false);
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("confirm"));
    expect(workbench.dialogs.getSnapshot()).toMatchObject({
      title: "cloud.disconnectTitle",
      danger: true,
    });
    workbench.dialogs.answer(true);
    await vi.waitFor(() => expect(workbench.cloud?.getSnapshot().kind).toBe("none"));
    expect(await links.get(key)).toBeUndefined();
    // The project of the platform stays, for the start page to list.
    expect(platform.projects.has(project)).toBe(true);
    await workbench.start.refresh();
    expect(workbench.start.getSnapshot().cloud.map((row) => row.project)).toEqual([project]);
  });

  it("archives and tries again without closing the panel", async () => {
    const { workbench, repositories } = windowOn(new MemoryPlatform());
    expect(await workbench.session.create("片子")).toBe(true);
    await connected(workbench);
    workbench.cloudPanel.set(true);
    workbench.runCloudAction("archiveNow");
    await vi.waitFor(() => expect(repositories.archives).toHaveLength(1));
    workbench.runCloudAction("retry");
    expect(workbench.cloudPanel.getSnapshot()).toBe(true);
  });

  it("goes to the other repository through the dialog for that", async () => {
    const { workbench } = windowOn(new MemoryPlatform());
    expect(await workbench.session.create("片子")).toBe(true);
    await connected(workbench);
    await vi.waitFor(() => expect(workbench.cloud?.canSwitchRepository).toBe(true));
    workbench.runCloudAction("switchRepository");
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("repository"));
    expect(workbench.dialogs.getSnapshot()).toMatchObject({ title: "repository.switchTitle" });
    workbench.dialogs.answer(false);
  });
});

describe("what asks for the dialog that connects a project", () => {
  it("is the one dialog that does all of it, where people make a stuck project a new one", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;
    await connected(workbench);
    const first = (await links.get(key))?.project as string;
    // The platform will never take the next change.
    platform.faults.rejections.push({ reason: "quota", retry: false });
    workbench.session.store?.execute({
      type: "file.write",
      params: { path: "code/a.js", text: "a" },
    });
    await vi.waitFor(() => expect(workbench.cloud?.session?.getSnapshot().state).toBe("paused"));
    workbench.runCloudAction("resolveStuck");
    await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe("choice"));
    workbench.dialogs.answer("new");
    // Not the question from before, which could put the repository off.
    const connect = await connectDialog(workbench);
    expect(workbench.dialogs.getSnapshot()).toMatchObject({
      title: 'cloud.connect.title {"name":"片子","interpolation":{"escapeValue":false}}',
    });
    expect(connect.getSnapshot()).toMatchObject({ repositoryOnly: false, phase: "choosing" });
    expect(await links.get(key)).toBeUndefined();
    expect(platform.projects.has(first)).toBe(true);
    expect(await connect.cancel()).toBe("closed");
    workbench.dialogs.answer(undefined);
  });

  it("is where “接着连接…” goes for a project whose connecting is not finished", async () => {
    const platform = new MemoryPlatform();
    const { workbench, links } = windowOn(platform);
    expect(await workbench.session.create("片子")).toBe(true);
    const key = workbench.session.key as string;
    // The first version never gets there.
    platform.faults.silent = true;
    expect(await workbench.cloud?.beginLink()).toMatchObject({ isNew: true });
    expect(workbench.cloud?.getSnapshot()).toMatchObject({ kind: "linked", made: false });
    workbench.cloudPanel.set(true);
    workbench.runCloudAction("finishConnect");
    expect(workbench.cloudPanel.getSnapshot()).toBe(false);
    const connect = await connectDialog(workbench);
    expect(connect.getSnapshot()).toMatchObject({ repositoryOnly: false, phase: "choosing" });
    // The link was there before the dialog: closing it takes nothing back.
    expect(connect.takesBack).toBe(false);
    expect(await connect.cancel()).toBe("closed");
    workbench.dialogs.answer(undefined);
    expect((await links.get(key))?.creating).toBe(true);
  });
});

describe("“打开云端的项目…”", () => {
  it("leaves the open project for the start page, at its projects of the platform", async () => {
    const { workbench } = windowOn(new MemoryPlatform());
    expect(await workbench.session.create("片子")).toBe(true);
    await workbench.openCloudProjects();
    expect(workbench.session.store).toBeUndefined();
    expect(workbench.cloudColumn.getSnapshot()).toBe(true);
  });
});
