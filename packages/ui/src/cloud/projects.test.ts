import { ProjectStore } from "@animaquill/core";
import type { AccountAccess, AccountSnapshot, LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { createInstance } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { Dialogs, type DialogRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { Notifications } from "../workbench/notifications.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "./cloud-support.ts";
import { CLOUD_FILE, CloudProjects, readCloudFile } from "./projects.ts";
import { FakeRepositories, TestWindow } from "./repository-support.ts";

const t = createInstance();
await t.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } } });

const MESSAGES: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};

function fixtureState(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  const id = store.getState().manifest.id;
  const state = store.encodeState();
  store.destroy();
  return { id, state };
}

function account(status: "signedIn" | "signedOut" = "signedIn") {
  let snapshot: AccountSnapshot =
    status === "signedIn"
      ? { status: "signedIn", name: "ada", appInstalled: true }
      : { status: "signedOut" };
  const listeners = new Set<() => void>();
  const access: AccountAccess & { set(next: AccountSnapshot): void } = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: async () => {},
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
    set(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
  return access;
}

/** Answers every dialog with what `answer` says, as people would; a promise once it settles. */
function answering(dialogs: Dialogs, answer: (request: DialogRequest) => unknown) {
  const asked: DialogRequest[] = [];
  dialogs.subscribe(() => {
    const request = dialogs.getSnapshot();
    if (!request || request.kind === "progress" || asked.includes(request)) return;
    asked.push(request);
    void Promise.resolve()
      .then(() => answer(request))
      .then((value) => {
        if (dialogs.getSnapshot() === request) {
          dialogs.answer(value as Parameters<Dialogs["answer"]>[0]);
        }
      });
  });
  return asked;
}

/** A browser with one window, and what decides whether its project syncs. */
async function windowOf(
  platform: MemoryPlatform,
  time: TestTime,
  {
    signedIn = true,
    folders = new Map<string, LocalFolder>(),
    repository,
  }: {
    signedIn?: boolean;
    folders?: Map<string, LocalFolder>;
    repository?: FakeRepositories;
  } = {},
) {
  const browser = new TestCloudBrowser(platform, "ada");
  const library = new MemoryLibrary();
  const session = new ProjectSession(library, memoryAddress(), MESSAGES, { window: "w" });
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const who = account(signedIn ? "signedIn" : "signedOut");
  const signIn = vi.fn(async () => {});
  const installApp = vi.fn(() => {});
  const cloud = new CloudProjects({
    cloud: {
      ...browser.access({ isAlive: () => true, asleep: false }),
      ...(repository && { repository }),
    },
    session,
    projects: library,
    folderOf: (key) => folders.get(key),
    isFolder: (key) => folders.has(key),
    account: who,
    dialogs,
    notifications,
    t: t.t,
    window: "w",
    editor: "test",
    signIn,
    openProject: async (id) => {
      await cloud.close();
      await session.open(id);
      await cloud.follow();
    },
    environment: time,
    timing: { scanMs: 5, noteMs: 20 },
    repositoryEnvironment: new TestWindow(time),
    installApp,
  });
  const open = async (id: string) => {
    await cloud.close();
    await session.open(id);
    await cloud.follow();
  };
  windows.push({ cloud, session });
  return {
    browser,
    library,
    session,
    dialogs,
    notifications,
    who,
    signIn,
    installApp,
    cloud,
    open,
    folders,
  };
}

const windows: { cloud: CloudProjects; session: ProjectSession }[] = [];
afterEach(async () => {
  for (const { cloud, session } of windows.splice(0)) {
    await cloud.close();
    await session.close();
  }
});

const messagesOf = (notifications: Notifications) =>
  notifications.getSnapshot().map((notification) => notification.message);

describe("CloudProjects", () => {
  it("connects a project of the browser, whose state is the first version on the platform", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    const asked = answering(here.dialogs, () => true);

    await here.cloud.connect();
    await time.advance(200);

    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    const link = await here.browser.links.get(id);
    expect(link?.creating).toBeUndefined();
    expect(platform.projects.get(link?.project ?? "")?.head).toBe(1);
    expect(messagesOf(here.notifications)).toContain("已连接到云端，改动会实时同步。");
  });

  it("asks people to sign in first, and connects nothing until then", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time, { signedIn: false });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    const asked = answering(here.dialogs, () => "signIn");
    await here.cloud.connect();
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect(here.signIn).toHaveBeenCalledOnce();
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(platform.projects.size).toBe(0);
  });

  it("goes on with a project whose first version may not have got there, after a reload", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    // As a page that went away right after it kept the link.
    await here.browser.links.put({
      key: id,
      platform: "https://platform.test",
      project: "made-here",
      seq: 0,
      pushed: 0,
      linkedAt: 1,
      creating: true,
    });
    await here.open(id);
    await time.advance(200);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    expect(platform.projects.get("made-here")?.head).toBe(1);
    expect((await here.browser.links.get(id))?.creating).toBeUndefined();
  });

  it("has a folder say which project of the platform it is, and asks about a copy of it", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const disk = new MemoryDisk();
    const local = memoryFolders(disk);
    disk.folder("原子", { quietly: true });
    disk.chooseNext("原子");
    const original = (await local.choose()) as LocalFolder;
    const folders = new Map([["本机1", original]]);
    const here = await windowOf(platform, time, { folders });
    const { state } = fixtureState();
    await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
    await here.open("本机1");
    answering(here.dialogs, (request) => (request.kind === "choice" ? "new" : true));
    await here.cloud.connect();
    await time.advance(200);
    const link = await here.browser.links.get("本机1");
    const file = readCloudFile(disk.text(`原子/${CLOUD_FILE}`));
    expect(file).toEqual({ platform: "https://platform.test", project: link?.project });
    expect(disk.text("原子/.animaquill/.gitignore")).toBe("*\n");

    // People copy the folder, and open the copy in the same browser: a project of its own here.
    disk.write(`副本/${CLOUD_FILE}`, disk.text(`原子/${CLOUD_FILE}`), { quietly: true });
    disk.chooseNext("副本");
    const copy = (await local.choose()) as LocalFolder;
    folders.set("本机2", copy);
    await here.library.create({ id: "本机2", name: "原子", folder: true }, state);
    await here.open("本机2");
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "detached", reason: "copy" });
    // It becomes a project of its own on the platform; the original stays as it was.
    await time.advance(200);
    const made = await here.browser.links.get("本机2");
    expect(made?.project).toBeDefined();
    expect(made?.project).not.toBe(link?.project);
    expect(readCloudFile(disk.text(`副本/${CLOUD_FILE}`))?.project).toBe(made?.project);
    expect(readCloudFile(disk.text(`原子/${CLOUD_FILE}`))?.project).toBe(link?.project);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    expect(platform.projects.size).toBe(2);
  });

  it("lets a copy of a folder go from the platform, when people say so", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const disk = new MemoryDisk();
    disk.write(`别处/${CLOUD_FILE}`, '{"platform":"https://platform.test","project":"far"}', {
      quietly: true,
    });
    disk.chooseNext("别处");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(platform, time, { folders: new Map([["本机3", folder]]) });
    const { state } = fixtureState();
    await here.library.create({ id: "本机3", name: "原子", folder: true }, state);
    const asked = answering(here.dialogs, () => "disconnect");
    await here.open("本机3");
    await time.advance(50);
    // Nothing of this browser comes from that project: it is not synced from here.
    expect(asked[0]).toMatchObject({ kind: "choice", title: "这个文件夹连着云端项目" });
    expect(disk.has(`别处/${CLOUD_FILE}`)).toBe(false);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(platform.connections).toBe(0);
  });

  it("disconnects: the link and the folder's file go, and the platform keeps the project", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const disk = new MemoryDisk();
    disk.folder("原子", { quietly: true });
    disk.chooseNext("原子");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(platform, time, { folders: new Map([["本机1", folder]]) });
    const { state } = fixtureState();
    await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
    await here.open("本机1");
    answering(here.dialogs, () => true);
    await here.cloud.connect();
    await time.advance(200);
    const link = await here.browser.links.get("本机1");
    await here.cloud.disconnect();
    expect(await here.browser.links.get("本机1")).toBeUndefined();
    expect(disk.has(`原子/${CLOUD_FILE}`)).toBe(false);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(platform.projects.has(link?.project ?? "")).toBe(true);
  });

  it("lets a project whose syncing is stuck go on as a new project of the platform, or here", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    let choice = "new";
    const asked = answering(here.dialogs, (request) => (request.kind === "choice" ? choice : true));
    await here.cloud.connect();
    await time.advance(200);
    const first = (await here.browser.links.get(id))?.project;
    // The platform will not take the next change, ever.
    platform.faults.rejections.push({ reason: "quota", retry: false });
    here.session.store?.execute({ type: "file.write", params: { path: "code/a.js", text: "a" } });
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rejected", reason: "quota" },
    });
    await here.cloud.resolveStuck();
    await time.advance(500);
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "choice", "confirm"]);
    const second = (await here.browser.links.get(id))?.project;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(second ?? "").getState().files["code/a.js"]).toBe("a");
    // Or it stays here only.
    platform.faults.rejections.push({ reason: "quota", retry: false });
    here.session.store?.execute({ type: "file.write", params: { path: "code/b.js", text: "b" } });
    await time.advance(500);
    asked.splice(0);
    choice = "disconnect";
    await here.cloud.resolveStuck();
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(here.session.store?.getState().files["code/b.js"]).toBe("b");
  });

  it("opens a project of the platform in another browser, which then syncs both ways", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const first = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await first.library.create({ id, name: "原子" }, state);
    await first.open(id);
    answering(first.dialogs, () => true);
    await first.cloud.connect();
    await time.advance(200);
    const project = (await first.browser.links.get(id))?.project ?? "";

    const second = await windowOf(platform, time);
    answering(second.dialogs, (request) => (request.kind === "form" ? { project } : true));
    await second.cloud.openFromCloud();
    await time.advance(200);
    expect(second.session.key).toBe(id);
    expect(second.cloud.session?.getSnapshot().state).toBe("online");

    const write = (text: string) => ({ type: "file.write", params: { path: "code/x.js", text } });
    first.session.store?.execute(write("from the first"));
    await time.advance(200);
    expect(second.session.store?.getState().files["code/x.js"]).toBe("from the first");
    second.session.store?.execute(write("from the second"));
    await time.advance(200);
    expect(first.session.store?.getState().files["code/x.js"]).toBe("from the second");
  });

  it("lets another window of the browser that has the project open know it is connected now (R4)", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const browser = new TestCloudBrowser(platform, "ada");
    const library = new MemoryLibrary();
    const { id, state } = fixtureState();
    await library.create({ id, name: "原子" }, state);
    const make = (name: string) => {
      const session = new ProjectSession(library, memoryAddress(), MESSAGES, { window: name });
      const dialogs = new Dialogs();
      answering(dialogs, () => true);
      const page = { alive: true, isAlive: () => page.alive, asleep: false };
      const cloud = new CloudProjects({
        cloud: browser.access(page),
        session,
        projects: library,
        folderOf: () => undefined,
        isFolder: () => false,
        account: account(),
        dialogs,
        notifications: new Notifications(),
        t: t.t,
        window: name,
        editor: "test",
        signIn: vi.fn(async () => {}),
        openProject: async () => {},
        environment: time,
        timing: { scanMs: 5, noteMs: 20, answerMs: 20 },
      });
      session.subscribe(() => void cloud.follow());
      windows.push({ cloud, session });
      return { session, cloud, page };
    };
    const a = make("a");
    const b = make("b");
    await a.session.open(id);
    await b.session.open(id);
    await time.advance(10);
    expect(b.cloud.getSnapshot().kind).toBe("none");
    await a.cloud.connect();
    await time.advance(500);
    // The other window heard of it, and shows what the window that syncs says.
    expect(b.cloud.getSnapshot().kind).toBe("linked");
    expect(b.cloud.session?.getSnapshot()).toMatchObject({ here: false, state: "online" });
    const project = [...platform.projects.values()][0];
    if (!project) throw new Error("not on the platform");
    const has = (path: string) => platform.workingCopy(project.id).getState().files[path];
    b.session.store?.execute({ type: "file.write", params: { path: "code/b1.js", text: "1" } });
    await time.advance(500);
    expect(has("code/b1.js")).toBe("1");
    // The window that synced goes: the other one takes over.
    await a.cloud.close();
    await a.session.close();
    a.page.alive = false;
    browser.writers.sweep();
    b.session.store?.execute({ type: "file.write", params: { path: "code/b2.js", text: "2" } });
    await time.advance(5000);
    expect(b.cloud.session?.getSnapshot()).toMatchObject({ here: true, state: "online" });
    expect(has("code/b2.js")).toBe("2");
    // Disconnecting there is heard here too.
    await b.cloud.disconnect();
    expect(b.cloud.getSnapshot().kind).toBe("none");
  });

  it("goes on syncing once people signed in again", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    answering(here.dialogs, () => true);
    await here.cloud.connect();
    await time.advance(200);
    // The session ends on the platform: it closes the connection, saying so.
    platform.signOut("ada");
    here.who.set({ status: "signedOut" });
    await time.advance(100);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "signed-out" },
    });
    here.session.store?.execute({ type: "file.write", params: { path: "code/w.js", text: "w" } });
    await time.advance(60_000);
    expect(
      platform.workingCopy((await here.browser.links.get(id))?.project ?? "").getState().files[
        "code/w.js"
      ],
    ).toBeUndefined();
    platform.signIn("ada");
    here.who.set({ status: "signedIn", name: "ada", appInstalled: true });
    await time.advance(200);
    expect(
      platform.workingCopy((await here.browser.links.get(id))?.project ?? "").getState().files[
        "code/w.js"
      ],
    ).toBe("w");
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
  });
});

describe("saving projects of the platform to GitHub", () => {
  async function connected(
    repository: FakeRepositories,
    answer: (request: DialogRequest) => unknown,
  ) {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time, { repository });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    const asked = answering(here.dialogs, answer);
    await here.cloud.connect();
    await time.advance(200);
    const link = await here.browser.links.get(id);
    return { time, here, asked, link: link!, id };
  }

  it("asks once, right after connecting, whether to save the project to GitHub", async () => {
    const repository = new FakeRepositories();
    const { here, asked, link } = await connected(
      repository,
      (request) => request.kind !== "repository",
    );
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "repository"]);
    expect(asked[1]).toMatchObject({ title: "把项目存到 GitHub？" });
    const picker = (asked[1] as Extract<DialogRequest, { kind: "repository" }>).picker;
    // A new private one at first, by a name GitHub takes.
    expect(picker.getSnapshot()).toMatchObject({ mode: "create", nameProblem: undefined });
    expect(picker.asking).toBe(true);
    expect(messagesOf(here.notifications)).toContain("已连接到云端，改动会实时同步。");
    // Put off: the status says so, and nothing went to GitHub.
    expect(repository.links).toEqual([]);
    expect(here.cloud.repository?.status?.state).toBe("none");
    expect(here.cloud.repository?.project).toBe(link.project);
    expect(here.cloud.canSaveToGitHub).toBe(true);
  });

  it("saves to a new repository from the dialog, and archiving shows from then on", async () => {
    const repository = new FakeRepositories();
    const { here, link } = await connected(repository, async (request) =>
      request.kind === "repository" ? (await request.picker.submit()) !== undefined : true,
    );
    expect(repository.links).toHaveLength(1);
    expect(repository.calls).toContain(`link ${link.project}`);
    expect(here.cloud.repository?.getSnapshot()).toMatchObject({
      hurrying: true,
      status: { state: "ready", archiving: true },
    });
    expect(here.cloud.canSaveToGitHub).toBe(false);
  });

  it("lists files written over and files taken away before going on with the editor's content", async () => {
    const repository = new FakeRepositories();
    const { time, here, asked, id } = await connected(repository, (request) =>
      request.kind === "repository" ? false : request.kind === "confirm" ? true : undefined,
    );
    const files = here.session.store!.exportFiles().files;
    const timeline = [...files.keys()].find((path) => path.startsWith("timelines/"))!;
    repository.answer = {
      ...repository.answer,
      state: "paused",
      reason: "diverged",
      diverged: {
        sha: "b".repeat(40),
        files: ["code/new-on-github.js", timeline],
        deleted: [],
      },
    };
    await here.cloud.repository!.refresh();
    expect(here.session.key).toBe(id);
    await here.cloud.continueWithEditor();
    const confirm = asked.at(-1) as Extract<DialogRequest, { kind: "confirm" }>;
    expect(confirm).toMatchObject({
      kind: "confirm",
      title: "以编辑器的内容接着存？",
      danger: true,
    });
    expect(confirm.details).toEqual([
      { title: "会被覆盖的文件", items: [timeline] },
      { title: "会被删除的文件（GitHub 上有，项目里没有）", items: ["code/new-on-github.js"] },
    ]);
    expect(repository.archives).toEqual([{ replace: "b".repeat(40) }]);
    await time.advance(0);
    expect(here.cloud.repository?.status?.state).toBe("ready");
  });

  it("goes on with nothing where people do not confirm", async () => {
    const repository = new FakeRepositories();
    const { here } = await connected(
      repository,
      (request) => request.kind !== "repository" && !(request.kind === "confirm" && request.danger),
    );
    repository.answer = {
      ...repository.answer,
      state: "paused",
      reason: "diverged",
      diverged: { sha: "b".repeat(40), files: ["code/a.js"], deleted: [] },
    };
    await here.cloud.repository!.refresh();
    await here.cloud.continueWithEditor();
    expect(repository.archives).toEqual([]);
  });

  it("has no repository where the platform does not save projects to GitHub", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    const asked = answering(here.dialogs, () => true);
    await here.cloud.connect();
    await time.advance(200);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(here.cloud.savesToGitHub).toBe(false);
    expect(here.cloud.repository).toBeUndefined();
  });
});
