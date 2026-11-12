/**
 * Projects of the platform that are folders, or not here at all, as the workbench goes through what
 * the design of the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud) says of them in
 * 4.3, 5 and 5.1: deleted on the platform, the folder stays as a project of this computer; saved as
 * a project of this computer, a copy of its own; and while its repository cannot be used, nothing
 * changes it, its folder included, until it can be used again. See cloud/delete.test.ts for the
 * rest of deleting one.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host, RepositoryStatus } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { account } from "../cloud/projects-support.ts";
import { FakeRepositories } from "../cloud/repository-support.ts";
import { filesOf } from "../folder/folder-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST, folderOf, written } from "./folder-windows.ts";
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

// Any file is a picture here, as the browser would read one.
vi.mock("@animaquill/media", async (original) => ({
  ...(await original<typeof import("@animaquill/media")>()),
  probeMedia: async () => ({ kind: "image", width: 1, height: 1 }),
}));

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
    await workbench.cloud?.close();
    await workbench.projectFolders?.close();
    await workbench.session.close();
  }
});

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });
const DAY = 24 * 3600_000;

/** GitHub as the platform saves to it, quick to archive. */
function repositoryOf(platform: MemoryPlatform): FakeRepositories {
  const repository = new FakeRepositories();
  repository.platform = platform;
  repository.followsPlatform = true;
  repository.autoArchive = true;
  repository.answer = {
    repository: {
      id: 7,
      owner: "ada",
      name: "atom",
      fullName: "ada/atom",
      private: true,
      branch: "main",
      url: "https://github.com/ada/atom",
      createdHere: true,
      linkedAt: 1,
    },
    state: "ready",
    archiving: false,
    head: 1,
    archivedSeq: 0,
  };
  return repository;
}

/** A browser of somebody who is signed in, which can write folders. */
function browserOn(platform: MemoryPlatform, repository?: FakeRepositories) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const window = () => {
    const host: Host = {
      projects: library,
      address: memoryAddress(),
      windowMemory: memoryWindow(),
      organizer: memoryOrganizer(),
      settings: {
        load: async (key) => values.get(key),
        save: async (key, value) => void values.set(key, value),
        listen: () => () => {},
      },
      folders: noFolders,
      localFolders: memoryFolders(disk),
      trials,
      drafts,
      exports: new MemoryExports(),
      presence: presence.window(),
      account: account(),
      cloud: {
        ...cloud.access({ isAlive: () => true, asleep: false }),
        ...(repository && { repository }),
      },
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
      cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20, longestRetryMs: 200 },
    });
    opened.push(workbench);
    return workbench;
  };
  return { disk, library, links: cloud.links, window };
}

/** Who answers the dialogs of a window now: one at a time. */
const answerers = new WeakMap<Workbench, () => void>();

/**
 * Answers what the workbench asks, as people would, by kind, in place of whoever did before;
 * progress goes by itself.
 */
function answering(workbench: Workbench, answer: (request: DialogRequest) => unknown) {
  answerers.get(workbench)?.();
  const asked: DialogRequest[] = [];
  const stop = workbench.dialogs.subscribe(() => {
    const request = workbench.dialogs.getSnapshot();
    if (!request || request.kind === "progress" || asked.includes(request)) return;
    asked.push(request);
    void Promise.resolve().then(() => {
      if (workbench.dialogs.getSnapshot() === request)
        workbench.dialogs.answer(answer(request) as never);
    });
  });
  answerers.set(workbench, stop);
  return asked;
}

const online = (workbench: Workbench) =>
  vi.waitFor(() =>
    expect(workbench.cloud?.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 }),
  );

/**
 * A project of the platform, saved to a repository, and a browser that has it as a folder,
 * "文档/原子", with a file of an asset in it.
 */
async function inFolder() {
  const platform = new MemoryPlatform();
  const repository = repositoryOf(platform);
  const browser = browserOn(platform, repository);
  const workbench = browser.window();
  expect(await workbench.session.create("原子")).toBe(true);
  workbench.session.store?.execute(write("code/动画.js", "const a = 1;\n"));
  const begun = await workbench.cloud?.beginLink();
  if (typeof begun !== "object") throw new Error("not connected");
  await online(workbench);
  const project = begun.link.project;
  platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
  // Into a folder, which syncs on as that folder.
  browser.disk.chooseNext("文档/原子");
  answering(workbench, () => true);
  expect(await workbench.moveToFolder()).toBe(true);
  await vi.waitFor(() =>
    expect(workbench.cloud?.getSnapshot()).toMatchObject({ kind: "linked", local: "folder" }),
  );
  await written(workbench);
  // A file of an asset that is in the folder, and one that is nowhere on this computer.
  const file = new Blob(["一段视频"]);
  const hash = await hashFile(file);
  browser.disk.write("文档/原子/assets/片头.mp4", new Uint8Array(await file.arrayBuffer()));
  const store = workbench.session.store;
  store?.execute({
    type: "asset.add",
    params: {
      id: "asset_here",
      asset: { kind: "video", storage: "local", path: "assets/片头.mp4", hash, size: file.size },
    },
  });
  const away = new Blob(["在另一台电脑上"]);
  const added = store?.execute({
    type: "asset.add",
    params: {
      id: "asset_away",
      asset: {
        kind: "video",
        storage: "local",
        path: "assets/别处.mp4",
        hash: await hashFile(away),
        size: away.size,
      },
    },
  });
  expect(added?.ok).toBe(true);
  await written(workbench);
  await online(workbench);
  const key = workbench.session.key as string;
  return { platform, repository, browser, workbench, project, key };
}

describe("deleting a project of the platform that is a folder here", () => {
  it("leaves the folder as a project of this computer, with all of it", async () => {
    const { platform, browser, workbench, project, key } = await inFolder();
    const before = filesOf(browser.disk, "文档/原子");
    const asked = answering(workbench, (request) => request.kind === "confirm");
    expect(await workbench.deleteFromCloud()).toBe(true);
    expect(asked[asked.length - 1]?.kind).toBe("confirm");
    expect(platform.projects.has(project)).toBe(false);
    // The folder stays, as it was, and is the project of this computer it always was.
    expect(filesOf(browser.disk, "文档/原子")).toEqual(before);
    expect(workbench.session.key).toBe(key);
    expect(folderOf(workbench)?.record.id).toBe(key);
    expect(await browser.links.get(key)).toBeUndefined();
    expect(workbench.cloud?.getSnapshot().kind).toBe("none");
    // It goes on as one: what changes goes into the folder, and nowhere else.
    workbench.session.store?.execute(write("code/之后.js", "after\n"));
    await vi.waitFor(() =>
      expect(filesOf(browser.disk, "文档/原子").get("code/之后.js")).toBe("after\n"),
    );
    expect(platform.projects.size).toBe(0);
  });
});

describe("saving a project of the platform as a project of this computer", () => {
  it("writes a copy of its own into an empty folder, with the files this computer has, and leaves the project as it was", async () => {
    const { browser, workbench, project, key } = await inFolder();
    const original = filesOf(browser.disk, "文档/原子");
    const linkBefore = await browser.links.get(key);
    browser.disk.chooseNext("文档/副本");
    const asked = answering(workbench, (request) =>
      request.kind === "prompt" ? "原子的副本" : request.kind === "choice" ? "stay" : true,
    );
    await workbench.saveAsLocal();
    const prompt = asked.find((request) => request.kind === "prompt");
    expect(prompt).toMatchObject({ title: 'folder.saveAs.title {"name":"原子"}', value: "原子" });
    const done = asked.find((request) => request.kind === "choice") as { message: string };
    // What this computer did not have is said, and is missing in the copy.
    expect(done.message).toContain("folder.saveAs.missing");
    expect(done.message).toContain("assets/别处.mp4");

    const copied = filesOf(browser.disk, "文档/副本");
    const manifest = JSON.parse(copied.get("animaquill.json") as string);
    const before = JSON.parse(original.get("animaquill.json") as string);
    // A project of its own: another id, the name people chose.
    expect(manifest.id).not.toBe(before.id);
    expect(manifest.name).toBe("原子的副本");
    expect(copied.get("code/动画.js")).toBe("const a = 1;\n");
    expect(browser.disk.has("文档/副本/assets/片头.mp4")).toBe(true);
    expect(browser.disk.has("文档/副本/assets/别处.mp4")).toBe(false);
    expect(browser.disk.has("文档/副本/导出未完成.txt")).toBe(false);
    // This browser knows it as a project of this computer, which is not connected.
    const records = await workbench.projectFolders?.list();
    const record = records?.find((each) => each.folder.name === "副本");
    expect(record).toMatchObject({ project: manifest.id, name: "原子的副本" });
    expect(await browser.links.get(record?.id as string)).toBeUndefined();
    // The project it came from, and how it is connected, as they were.
    expect(filesOf(browser.disk, "文档/原子")).toEqual(original);
    expect(await browser.links.get(key)).toEqual(linkBefore);
    expect(workbench.session.key).toBe(key);
    expect((await browser.links.get(key))?.project).toBe(project);
  });

  it("takes only an empty folder, or a new one in another", async () => {
    const { browser, workbench } = await inFolder();
    // A folder that is a project: nothing is compared, people choose another.
    browser.disk.chooseNext("文档/原子");
    const asked = answering(workbench, (request) =>
      request.kind === "prompt" ? "副本" : request.kind === "confirm" ? true : undefined,
    );
    await workbench.saveAsLocal();
    expect(asked.at(-1)).toMatchObject({ kind: "confirm", noticeOnly: true });
    expect(browser.disk.has("文档/原子/导出未完成.txt")).toBe(false);
    // One with other things in it: only a new folder in it.
    browser.disk.write("文档/杂物/说明.txt", "别的东西");
    browser.disk.chooseNext("文档/杂物");
    const more = answering(workbench, (request) =>
      request.kind === "prompt" ? "副本" : request.kind === "choice" ? "inside" : true,
    );
    await workbench.saveAsLocal();
    const where = more.find((request) => request.kind === "choice");
    expect(where?.kind === "choice" && where.choices.map(({ id }) => id)).toEqual(["inside"]);
    expect(browser.disk.has("文档/杂物/副本/animaquill.json")).toBe(true);
    expect(browser.disk.has("文档/杂物/animaquill.json")).toBe(false);
  });

  it("copies what the platform has of one that this computer never opened, and keeps nothing of it in the browser", async () => {
    const { platform, workbench, project } = await inFolder();
    await workbench.closeProject();
    const other = browserOn(platform, repositoryOf(platform));
    const elsewhere = other.window();
    other.disk.chooseNext("下载/原子");
    answering(elsewhere, (request) =>
      request.kind === "prompt" ? "原子" : request.kind === "choice" ? "stay" : true,
    );
    await elsewhere.saveAsLocal(project, "原子");
    const copied = filesOf(other.disk, "下载/原子");
    expect(copied.get("code/动画.js")).toBe("const a = 1;\n");
    // No copy of the project of the platform here, and no link to it: only the new project.
    expect(await other.links.list()).toEqual([]);
    expect([...other.library.summaries.values()].map(({ folder }) => folder)).toEqual([true]);
    expect(elsewhere.session.key).toBeUndefined();
  });
});

describe("a project of the platform whose repository cannot be used, open here", () => {
  it("cannot be edited, leaves its folder as it is, keeps what did not get there, and goes on once the repository can be used", async () => {
    const { platform, repository, browser, workbench, project } = await inFolder();
    // A change that does not get to the platform before it finds the repository gone.
    platform.faults.silent = true;
    platform.drop();
    workbench.session.store?.execute(write("code/之前.js", "before\n"));
    await written(workbench);
    const unusable = { reason: "gone", since: Date.now(), deleteAt: Date.now() + 7 * DAY };
    platform.faults.silent = false;
    platform.makeUnusable(project, unusable);
    repository.answer = { ...repository.answer, state: "paused", reason: "gone", unusable };
    // The connection that was silent comes back, and hears it.
    platform.drop();
    await vi.waitFor(() => expect(workbench.readOnly.getSnapshot()).toBe(true));
    const store = workbench.session.store;
    expect(store?.readOnly).toBe(true);
    // Nothing changes it, whoever asks.
    const refused = store?.execute(write("code/不行.js", "no\n"));
    expect(refused?.ok ? undefined : refused?.error.code).toBe("read-only");
    await vi.waitFor(() =>
      expect(folderOf(workbench)?.snapshot.trouble).toEqual({ reason: "held" }),
    );
    // A file people bring in does not come in, and is not copied into the folder either.
    const picture = new File(["一张图"], "新图.png", { type: "image/png" });
    expect(await workbench.media.importFiles([picture])).toEqual([]);
    expect(browser.disk.has("文档/原子/assets/新图.png")).toBe(false);
    expect(browser.disk.names("文档/原子/assets").toSorted()).toEqual(["片头.mp4"]);
    // What changes in the folder meanwhile stays there, and does not come in.
    browser.disk.write("文档/原子/code/外面.js", "outside\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store?.getState().files["code/外面.js"]).toBeUndefined();
    expect(browser.disk.text("文档/原子/code/外面.js")).toBe("outside\n");
    // ...and what was not on the platform waits here.
    expect(workbench.cloud?.session?.getSnapshot().pending).toBeGreaterThan(0);

    // The repository can be used again: it can be edited, the folder comes in, and what waited goes.
    platform.makeUnusable(project, undefined);
    repository.recheckAnswer = { ...repository.answer, state: "ready" } as RepositoryStatus;
    delete (repository.recheckAnswer as { unusable?: unknown }).unusable;
    delete (repository.recheckAnswer as { reason?: unknown }).reason;
    await workbench.cloud?.recheck();
    await vi.waitFor(() => expect(workbench.readOnly.getSnapshot()).toBe(false));
    expect(store?.readOnly).toBe(false);
    await vi.waitFor(() => expect(store?.getState().files["code/外面.js"]).toBe("outside\n"));
    await online(workbench);
    const there = platform.workingCopy(project).getState().files;
    expect(there["code/之前.js"]).toBe("before\n");
    expect(there["code/外面.js"]).toBe("outside\n");
  });

  it("goes on as a project of this computer once it is disconnected, with what changed in its folder", async () => {
    const { platform, repository, browser, workbench, project, key } = await inFolder();
    const unusable = { reason: "transferred", since: Date.now() };
    platform.makeUnusable(project, unusable);
    repository.answer = { ...repository.answer, state: "paused", reason: "transferred", unusable };
    await vi.waitFor(() => expect(workbench.readOnly.getSnapshot()).toBe(true));
    browser.disk.write("文档/原子/code/外面.js", "outside\n");
    answering(workbench, () => true);
    await workbench.cloud?.disconnect();
    expect(await browser.links.get(key)).toBeUndefined();
    await vi.waitFor(() => expect(workbench.readOnly.getSnapshot()).toBe(false));
    const store = workbench.session.store;
    await vi.waitFor(() => expect(store?.getState().files["code/外面.js"]).toBe("outside\n"));
    expect(store?.execute(write("code/接着.js", "on\n")).ok).toBe(true);
    await vi.waitFor(() =>
      expect(filesOf(browser.disk, "文档/原子").get("code/接着.js")).toBe("on\n"),
    );
  });
});

/** One browser, two windows of the same project of the platform: the first one syncs. */
async function inBrowserTwice() {
  const platform = new MemoryPlatform();
  const repository = repositoryOf(platform);
  const browser = browserOn(platform, repository);
  const a = browser.window();
  expect(await a.session.create("原子")).toBe(true);
  a.session.store?.execute(write("code/动画.js", "const a = 1;\n"));
  const begun = await a.cloud?.beginLink();
  if (typeof begun !== "object") throw new Error("not connected");
  await online(a);
  const project = begun.link.project;
  platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
  const key = a.session.key as string;
  const b = browser.window();
  await b.openProject(key);
  await vi.waitFor(() => expect(b.cloud?.getSnapshot().kind).toBe("linked"));
  return { platform, repository, a, b, project };
}

describe("a project of the platform open in two windows, whose repository can be used again", () => {
  it("can be edited in both as soon as the window that does not sync finds that out", async () => {
    const { platform, repository, a, b, project } = await inBrowserTwice();
    expect(a.cloud?.session?.getSnapshot().here).toBe(true);
    expect(b.cloud?.session?.getSnapshot().here).toBe(false);
    const unusable = { reason: "gone", since: Date.now(), deleteAt: Date.now() + 7 * DAY };
    platform.makeUnusable(project, unusable);
    repository.answer = { ...repository.answer, state: "paused", reason: "gone", unusable };
    platform.drop();
    await vi.waitFor(() => expect(a.readOnly.getSnapshot()).toBe(true));
    await vi.waitFor(() => expect(b.readOnly.getSnapshot()).toBe(true));
    // Back on GitHub, and people ask again in the window that does not sync.
    platform.makeUnusable(project, undefined);
    const usable = { ...repository.answer, state: "ready" } as RepositoryStatus;
    delete (usable as { unusable?: unknown }).unusable;
    delete (usable as { reason?: unknown }).reason;
    repository.recheckAnswer = usable;
    expect((await b.cloud?.recheck())?.unusable).toBeUndefined();
    await vi.waitFor(() => expect(b.readOnly.getSnapshot()).toBe(false), { timeout: 3000 });
    await vi.waitFor(() => expect(a.readOnly.getSnapshot()).toBe(false), { timeout: 3000 });
    await vi.waitFor(() =>
      expect(a.cloud?.session?.getSnapshot()).toMatchObject({
        state: "online",
        problem: undefined,
      }),
    );
    expect(b.session.store?.execute(write("code/又能改.js", "yes\n")).ok).toBe(true);
    await vi.waitFor(() =>
      expect(platform.workingCopy(project).getState().files["code/又能改.js"]).toBe("yes\n"),
    );
  }, 20_000);
});
