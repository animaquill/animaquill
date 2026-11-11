import { STORAGE } from "@animaquill/core";
import type { LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialogs, type DialogRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { Notifications } from "../workbench/notifications.ts";
import { ProjectSession } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "./cloud-support.ts";
import { CloudProjects, OLD_CLOUD_FILE } from "./projects.ts";
import {
  MESSAGES,
  account,
  answering,
  closeWindows,
  connectNow,
  fixtureState,
  messagesOf,
  t,
  track,
  windowOf,
} from "./projects-support.ts";
import { FakeRepositories } from "./repository-support.ts";

afterEach(closeWindows);

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

    await connectNow(here.cloud);
    await time.advance(200);

    // Nothing to ask: whoever began it asked people already, as the dialog that connects it does.
    expect(asked).toEqual([]);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    const link = await here.browser.links.get(id);
    expect(link?.creating).toBeUndefined();
    expect(platform.projects.get(link?.project ?? "")?.head).toBe(1);
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

  it("keeps the link of a folder in this browser only: a copy of it is a project of this computer", async () => {
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
    const asked = answering(here.dialogs, () => true);
    await connectNow(here.cloud);
    await time.advance(200);
    const link = await here.browser.links.get("本机1");
    const project = link?.project ?? "";
    expect(platform.projects.has(project)).toBe(true);
    // Nothing in the folder says which project of the platform it is.
    expect(disk.has(`原子/${OLD_CLOUD_FILE}`)).toBe(false);

    // People copy the folder, with the file an older editor left in it, and open the copy here.
    const old = JSON.stringify({ version: 1, platform: "https://platform.test", project });
    disk.write(`副本/${OLD_CLOUD_FILE}`, old, { quietly: true });
    disk.chooseNext("副本");
    const copy = (await local.choose()) as LocalFolder;
    folders.set("本机2", copy);
    await here.library.create({ id: "本机2", name: "原子", folder: true }, state);
    asked.splice(0);
    const connections = platform.connections;
    await here.open("本机2");
    await time.advance(200);
    // A project of this computer only: nobody is asked anything, and nothing goes anywhere.
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(asked).toEqual([]);
    expect(await here.browser.links.get("本机2")).toBeUndefined();
    expect(platform.connections).toBe(connections);
    expect(platform.projects.size).toBe(1);
    // What an older editor left in the copy stays: another browser may still go by it.
    expect(disk.text(`副本/${OLD_CLOUD_FILE}`)).toBe(old);
    here.session.store?.execute(write("code/copy.js", "only in the copy"));
    await time.advance(200);
    expect(filesOn(platform, project)["code/copy.js"]).toBeUndefined();

    // The original goes on syncing with the project of the platform, as it did.
    await here.open("本机1");
    await time.advance(200);
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", link: { project } });
    here.session.store?.execute(write("code/original.js", "o"));
    await time.advance(200);
    expect(filesOn(platform, project)["code/original.js"]).toBe("o");
    expect(filesOn(platform, project)["code/copy.js"]).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("takes the file of older editors out of a folder that this browser links, and goes on from where it was", async () => {
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
    const asked = answering(here.dialogs, () => true);
    await connectNow(here.cloud);
    await time.advance(200);
    here.session.store?.execute(write("code/synced.js", "s"));
    await time.advance(200);
    // Then the network goes, and a change stays in the log only.
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/offline.js", "only here"));
    await time.advance(100);
    const before = await here.browser.links.get("本机1");
    if (!before) throw new Error("no link");
    const project = before.project;
    expect(filesOn(platform, project)["code/synced.js"]).toBe("s");
    expect(filesOn(platform, project)["code/offline.js"]).toBeUndefined();
    await here.cloud.close();
    await here.session.close();

    // As an older editor left the folder: it says which project of the platform it is.
    const old = `${JSON.stringify({ version: 1, platform: "https://platform.test", project }, null, 2)}\n`;
    disk.write(`原子/.animaquill/.gitignore`, "*\n", { quietly: true });
    disk.write(`原子/${OLD_CLOUD_FILE}`, old, { quietly: true });
    // The page loads again, as a newer editor.
    platform.faults.silent = false;
    asked.splice(0);
    const again = await windowOf(platform, time, {
      browser: here.browser,
      library: here.library,
      folders: new Map([["本机1", folder]]),
    });
    const pushed: number[] = [];
    await again.open("本机1");
    pushed.push((await again.browser.links.get("本机1"))?.pushed ?? -1);
    await time.advance(2000);
    pushed.push((await again.browser.links.get("本机1"))?.pushed ?? -1);
    // The link is what it was: the same project of the platform, from where it got to.
    expect(again.cloud.getSnapshot()).toMatchObject({ kind: "linked", link: { project } });
    expect(again.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(pushed.every((mark) => mark >= before.pushed)).toBe(true);
    expect(pushed.at(-1)).toBeGreaterThan(before.pushed);
    expect(filesOn(platform, project)["code/offline.js"]).toBe("only here");
    expect(filesOn(platform, project)["code/synced.js"]).toBe("s");
    expect(platform.projects.size).toBe(1);
    expect(asked).toEqual([]);
    // The file of older editors is gone; what keeps .animaquill out of Git stays.
    expect(disk.has(`原子/${OLD_CLOUD_FILE}`)).toBe(false);
    expect(disk.text("原子/.animaquill/.gitignore")).toBe("*\n");
  });

  it("leaves the file of older editors in a folder that this browser does not link", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const disk = new MemoryDisk();
    const old = '{"version":1,"platform":"https://platform.test","project":"far"}';
    disk.write(`别处/${OLD_CLOUD_FILE}`, old, { quietly: true });
    disk.chooseNext("别处");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(platform, time, { folders: new Map([["本机3", folder]]) });
    const { state } = fixtureState();
    await here.library.create({ id: "本机3", name: "原子", folder: true }, state);
    const asked = answering(here.dialogs, () => true);
    await here.open("本机3");
    await time.advance(200);
    // A project of this computer only, which nobody is asked about. The file may be what an older
    // page in another browser goes by: it stays as it is.
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(asked).toEqual([]);
    expect(disk.text(`别处/${OLD_CLOUD_FILE}`)).toBe(old);
    expect(platform.connections).toBe(0);
    expect(here.cloud.canDisconnect).toBe(false);
  });

  it("disconnects a folder: the link goes, the folder stays, and the platform keeps the project", async () => {
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
    await connectNow(here.cloud);
    await time.advance(200);
    const link = await here.browser.links.get("本机1");
    expect(here.cloud.canDisconnect).toBe(true);
    await here.cloud.disconnect();
    expect(await here.browser.links.get("本机1")).toBeUndefined();
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
    await connectNow(here.cloud);
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
    // Where the platform saves no projects to repositories, there is no dialog to ask for: people
    // chose a new project, and that is what it becomes.
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
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

  it("does not offer to go on from the project as it is where the platform does not have the project", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? undefined : true,
    );
    // Taken away on the platform, on another computer.
    expect(platform.remove("ada", project)).toBe("removed");
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot().problem).toEqual({ kind: "missing" });
    here.session.store?.execute(write("code/late.js", "平台从来没有收到过"));
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot().pending).toBe(1);
    const before = (await here.browser.links.get(project))?.pushed ?? 0;
    await here.cloud.resolveStuck();
    const question = asked.at(-1) as Extract<DialogRequest, { kind: "choice" }>;
    expect(question.message).toBe(
      "云端找不到这个项目：它可能已经在别处删掉，或者属于另一个账号（那样的话，换回那个账号登录就能接着同步）。改动都在本机。可以断开云端连接，项目只留在本机；也可以把现在的项目连成一个新的云端项目。",
    );
    // There is nothing there to take what the project has: only letting go, or a new project.
    expect(question.choices).toEqual([
      { id: "disconnect", label: "断开" },
      { id: "new", label: "连成另一个云端项目", kind: "primary" },
    ]);
    // Asked for all the same, nothing is taken for sent: the platform took nothing.
    await here.cloud.session?.resyncFromHere();
    await time.advance(2000);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "missing" },
      pending: 1,
    });
    expect((await here.browser.links.get(project))?.pushed).toBe(before);
    // So taking the copy out of this browser still says what it would lose.
    await here.cloud.close();
    await here.session.close();
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "云端的项目列表里没有这个项目了，可能已经在别的设备上删掉。这个浏览器里的是最后一份。有 1 个改动还没同步到云端。现在移除，这个项目就找不回来了。",
    );
    expect(here.library.summaries.has(project)).toBe(true);
  });

  it("makes a project a new one of the platform in the dialog that does all of it, where there is one", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const repository = new FakeRepositories();
    repository.platform = platform;
    const disk = new MemoryDisk();
    disk.folder("原子", { quietly: true });
    disk.chooseNext("原子");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const folders = new Map([["本机1", folder]]);
    const here = await windowOf(platform, time, { repository, folders });
    const { state } = fixtureState();
    await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
    await here.open("本机1");
    let choice = "new";
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? choice : request.kind !== "repository",
    );
    await connectNow(here.cloud);
    await time.advance(200);
    const first = (await here.browser.links.get("本机1"))?.project;
    expect(platform.projects.has(first ?? "")).toBe(true);
    // Syncing stops at something the platform will never take, and people say: a new project.
    platform.faults.rejections.push({ reason: "quota", retry: false });
    here.session.store?.execute(write("code/a.js", "a"));
    await time.advance(500);
    asked.splice(0);
    // The dialog it asks for is the one that connects the project in one go.
    here.world.showConnect = async () => {
      // The old link is gone by then.
      expect(await here.browser.links.get("本机1")).toBeUndefined();
      expect(here.cloud.getSnapshot().kind).toBe("none");
      const connect = here.cloud.beginConnect();
      await time.advance(100);
      const done = connect?.submit();
      await time.advance(500);
      await done;
      connect?.close();
    };
    await here.cloud.resolveStuck();
    // Not the question from before every project of the platform had a repository, which could
    // be put off: the link is gone, and the dialog that does all of it is asked for.
    expect(asked[0]?.kind).toBe("choice");
    expect(here.world.shown).toBe(1);
    const second = (await here.browser.links.get("本机1"))?.project;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(repository.calls).toContain(`link ${second}`);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
  });

  it("keeps the link a project has, however soon after it opened connecting is asked for", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    answering(here.dialogs, () => true);
    await connectNow(here.cloud);
    await time.advance(200);
    const before = await here.browser.links.get(id);
    expect(before?.creating).toBeUndefined();
    await here.cloud.close();
    await here.session.close();
    // The page loads again, and connecting is asked for before the link of the project is read.
    const again = await windowOf(platform, time, { browser: here.browser, library: here.library });
    await again.session.open(id);
    const looking = again.cloud.follow();
    const begun = await again.cloud.beginLink();
    await looking;
    await time.advance(500);
    expect(begun).toMatchObject({ link: { project: before?.project }, isNew: false });
    expect((await again.browser.links.get(id))?.project).toBe(before?.project);
    expect(platform.projects.size).toBe(1);
    expect(again.cloud.session?.getSnapshot().state).toBe("online");
  });

  it("does not take a link it cannot read for none", async () => {
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
    const asked = answering(here.dialogs, () => true);
    await connectNow(here.cloud);
    await time.advance(200);
    const before = await here.browser.links.get("本机1");
    await here.cloud.close();
    await here.session.close();
    asked.splice(0);

    // The page loads again, and what the browser keeps about links cannot be read just then.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    here.browser.links.failing = true;
    await here.open("本机1");
    await time.advance(200);
    // Nothing is known: neither that it syncs, nor that its folder is one from somewhere else,
    // which people would be asked about.
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(asked).toEqual([]);
    // Connecting it now would make a second project of the platform of it: it does not begin.
    expect(await here.cloud.beginLink()).toBe("failed");
    expect(platform.projects.size).toBe(1);
    // Once the links can be read, the next look finds the one the project has.
    here.browser.links.failing = false;
    await here.cloud.follow();
    await time.advance(200);
    warn.mockRestore();
    expect(here.cloud.getSnapshot()).toMatchObject({
      kind: "linked",
      link: { project: before?.project },
    });
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    expect(disk.has(`原子/${OLD_CLOUD_FILE}`)).toBe(false);
  });

  it("opens a project of the platform in another browser, which then syncs both ways", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const first = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await first.library.create({ id, name: "原子" }, state);
    await first.open(id);
    answering(first.dialogs, () => true);
    await connectNow(first.cloud);
    await time.advance(200);
    const project = (await first.browser.links.get(id))?.project ?? "";

    const second = await windowOf(platform, time);
    answering(second.dialogs, () => true);
    await second.cloud.openCloudProject(project);
    await time.advance(200);
    // Kept by its id on the platform, which is its own: the id in the project is not.
    expect(second.session.key).toBe(project);
    expect(second.session.store?.getState().manifest.id).toBe(id);
    expect(second.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });
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
      track({ cloud, session });
      return { session, cloud, page };
    };
    const a = make("a");
    const b = make("b");
    await a.session.open(id);
    await b.session.open(id);
    await time.advance(10);
    expect(b.cloud.getSnapshot().kind).toBe("none");
    await connectNow(a.cloud);
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
    // A project in the browser has nowhere to stay without the platform: it does not disconnect,
    // it is taken out of the browser, see `removeFromBrowser`.
    expect(b.cloud.canDisconnect).toBe(false);
    await b.cloud.disconnect();
    expect(b.cloud.getSnapshot().kind).toBe("linked");
    expect(await browser.links.get(id)).toBeDefined();
  });

  it("goes on syncing once people signed in again", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    answering(here.dialogs, () => true);
    await connectNow(here.cloud);
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
    await connectNow(here.cloud);
    await time.advance(200);
    const link = await here.browser.links.get(id);
    return { time, here, asked, link: link!, id };
  }

  it("lists files written over and files taken away before going on with the editor's content", async () => {
    const repository = new FakeRepositories();
    const { time, here, asked, id } = await connected(repository, (request) =>
      request.kind === "confirm" ? true : undefined,
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
      (request) => !(request.kind === "confirm" && request.danger),
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
    await connectNow(here.cloud);
    await time.advance(200);
    expect(asked).toEqual([]);
    expect(here.cloud.savesToGitHub).toBe(false);
    expect(here.cloud.repository).toBeUndefined();
  });
});

/**
 * Puts a project on the platform from a browser of its own, which then goes away. The project is
 * the fixture every time: two of them have the same id of their own, and are two projects there.
 */
async function onPlatform(platform: MemoryPlatform, time: TestTime) {
  const first = await windowOf(platform, time);
  const { id, state } = fixtureState();
  await first.library.create({ id, name: "原子" }, state);
  await first.open(id);
  answering(first.dialogs, () => true);
  await connectNow(first.cloud);
  await time.advance(200);
  const project = (await first.browser.links.get(id))?.project ?? "";
  expect(platform.projects.has(project)).toBe(true);
  await first.cloud.close();
  await first.session.close();
  return { project, id };
}

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });
const filesOn = (platform: MemoryPlatform, project: string) =>
  platform.workingCopy(project).getState().files;

describe("projects of the platform without a folder", () => {
  it("opens two projects of the platform that have the same id of their own, each as its own copy", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const one = await onPlatform(platform, time);
    const two = await onPlatform(platform, time);
    expect(one.id).toBe(two.id);
    expect(one.project).not.toBe(two.project);

    const here = await windowOf(platform, time);
    expect(await here.cloud.openCloudProject(one.project)).toBe(true);
    await time.advance(200);
    expect(here.session.key).toBe(one.project);
    here.session.store?.execute(write("code/one.js", "1"));
    await time.advance(200);

    // The other one has the same id in it, and is another project all the same.
    expect(await here.cloud.openCloudProject(two.project)).toBe(true);
    await time.advance(200);
    expect(here.session.key).toBe(two.project);
    expect(here.session.store?.getState().manifest.id).toBe(one.id);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    here.session.store?.execute(write("code/two.js", "2"));
    await time.advance(200);

    // Each is kept by its id on the platform, and syncs with its own project there.
    expect([...here.library.summaries.keys()].toSorted()).toEqual(
      [one.project, two.project].toSorted(),
    );
    expect((await here.browser.links.get(one.project))?.project).toBe(one.project);
    expect((await here.browser.links.get(two.project))?.project).toBe(two.project);
    expect(filesOn(platform, one.project)["code/one.js"]).toBe("1");
    expect(filesOn(platform, one.project)["code/two.js"]).toBeUndefined();
    expect(filesOn(platform, two.project)["code/two.js"]).toBe("2");
    expect(filesOn(platform, two.project)["code/one.js"]).toBeUndefined();
    expect(messagesOf(here.notifications)).toEqual([]);

    // And the first one opens again as the copy it is, with what it had.
    expect(await here.cloud.openCloudProject(one.project)).toBe(true);
    expect(here.session.key).toBe(one.project);
    expect(here.session.store?.getState().files["code/one.js"]).toBe("1");
  });

  it("goes on from where the platform was when the project came, and remembers what a list shows", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const head = platform.projects.get(project)?.head;
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    const kept = await here.browser.links.get(project);
    const there = platform.projects.get(project);
    expect(kept).toMatchObject({
      key: project,
      project,
      seq: head,
      digest: there?.digest,
      generation: 1,
      name: "原子是什么",
      owner: "user-ada",
    });
    // What came is what the platform has: none of it goes there again.
    const entries = await (await here.library.open(project)).entries?.();
    expect(kept?.pushed).toBe(entries?.at(-1)?.mark);
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(there?.head).toBe(head);
    expect(platform.effectiveRepairs).toBe(0);
  });

  it("opens what this browser has of a project before it asks the platform, also without one", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    here.session.store?.execute(write("code/kept.js", "kept"));
    await time.advance(200);
    await here.cloud.close();
    await here.session.close();

    // Nobody is signed in, and the platform is not there: the copy opens as it is.
    platform.faults.unreachable = true;
    platform.signOut("ada");
    here.who.set({ status: "signedOut" });
    const connections = platform.connections;
    const asked = answering(here.dialogs, () => undefined);
    expect(await here.cloud.openCloudProject(project)).toBe(true);
    expect(asked).toEqual([]);
    expect(here.session.key).toBe(project);
    expect(here.session.store?.getState().files["code/kept.js"]).toBe("kept");
    expect(here.library.summaries.size).toBe(1);
    // Nothing came from the platform for it: only syncing tries, and hears that nobody is signed in.
    await time.advance(200);
    expect(platform.connections).toBe(connections + 1);
    expect(here.cloud.session?.getSnapshot().problem).toEqual({ kind: "signed-out" });
  });

  it("opens the folder that is connected to a project, and a copy from before by the key it has", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project, id } = await onPlatform(platform, time);
    const disk = new MemoryDisk();
    disk.folder("原子", { quietly: true });
    disk.chooseNext("原子");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(platform, time, { folders: new Map([["本机1", folder]]) });
    const { state } = fixtureState();
    await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
    await here.browser.links.put({
      key: "本机1",
      platform: "https://platform.test",
      project,
      seq: 0,
      pushed: 0,
      linkedAt: 1,
    });
    const connections = platform.connections;
    expect(await here.cloud.openCloudProject(project)).toBe(true);
    expect(here.session.key).toBe("本机1");
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "folder" });
    // No second copy in the browser.
    expect([...here.library.summaries.keys()]).toEqual(["本机1"]);
    await time.advance(200);
    expect(platform.connections).toBe(connections + 1);

    // A copy that an editor from before kept by the id of the project goes on as it is.
    const before = await windowOf(platform, time);
    await before.library.create({ id, name: "原子" }, platform.workingCopy(project).encodeState());
    await before.browser.links.put({
      key: id,
      platform: "https://platform.test",
      project,
      seq: platform.projects.get(project)?.head ?? 0,
      pushed: 1,
      linkedAt: 1,
    });
    expect(await before.cloud.openCloudProject(project)).toBe(true);
    expect(before.session.key).toBe(id);
    expect([...before.library.summaries.keys()]).toEqual([id]);
    await time.advance(200);
    expect(before.cloud.session?.getSnapshot().state).toBe("online");
  });

  it("gives the copy a number of its own where this browser keeps another project by that id", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    // An older editor let people disconnect it: it is a project of this browser only now.
    await here.cloud.close();
    await here.session.close();
    await here.browser.links.remove(project);
    await here.open(project);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    here.session.store?.execute(write("code/local.js", "mine"));
    await time.advance(50);
    expect(await here.browser.links.get(project)).toBeUndefined();

    expect(await here.cloud.openCloudProject(project)).toBe(true);
    await time.advance(200);
    const key = here.session.key ?? "";
    expect(key).not.toBe(project);
    expect((await here.browser.links.get(key))?.project).toBe(project);
    expect(here.session.store?.getState().files["code/local.js"]).toBeUndefined();
    // What was disconnected stays as it was.
    expect(here.library.summaries.has(project)).toBe(true);
    expect(filesOn(platform, project)["code/local.js"]).toBeUndefined();
    // The next time it is that copy that opens.
    await here.cloud.close();
    await here.session.close();
    expect(await here.cloud.openCloudProject(project)).toBe(true);
    expect(here.session.key).toBe(key);
  });

  it("only opens a project whose working copy the platform has, and waits for one on its way back", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    const connections = platform.connections;
    expect(await here.cloud.openCloudProject(project, { copy: "released" })).toBe(false);
    expect(await here.cloud.openCloudProject(project, { copy: "somethingNew" })).toBe(false);
    expect(platform.connections).toBe(connections);
    expect(messagesOf(here.notifications)).toEqual([
      "这个云端项目要先从仓库取回，这一版编辑器还做不了。请刷新页面后再试。",
      "这个云端项目要先从仓库取回，这一版编辑器还做不了。请刷新页面后再试。",
    ]);

    platform.listed.set(project, { copy: "restoring" });
    const opening = here.cloud.openCloudProject(project, { copy: "restoring" });
    await time.advance(4000);
    expect(here.dialogs.getSnapshot()).toMatchObject({
      kind: "progress",
      title: "正在从仓库取回项目…",
    });
    expect(platform.connections).toBe(connections);
    platform.listed.set(project, { copy: "live" });
    await time.advance(4000);
    expect(await opening).toBe(true);
    expect(here.session.key).toBe(project);
  });

  it("opens a folder that names a project this browser has a copy of as a project of this computer", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const disk = new MemoryDisk();
    const old = JSON.stringify({ platform: "https://platform.test", project });
    disk.write(`别处/${OLD_CLOUD_FILE}`, old, { quietly: true });
    disk.chooseNext("别处");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const folders = new Map<string, LocalFolder>();
    const here = await windowOf(platform, time, { folders });
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    // A copy that is only in this browser has nowhere to stay without the platform.
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });
    expect(here.cloud.canDisconnect).toBe(false);

    // People open a folder of the same project of the platform in this browser.
    folders.set("本机5", folder);
    const { state } = fixtureState();
    await here.library.create({ id: "本机5", name: "原子", folder: true }, state);
    const asked = answering(here.dialogs, () => undefined);
    await here.open("本机5");
    await time.advance(50);
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none" });
    expect(asked).toEqual([]);
    // Nothing of the folder went to the platform, and the copy is as it was.
    expect(disk.text(`别处/${OLD_CLOUD_FILE}`)).toBe(old);
    expect(await here.browser.links.get("本机5")).toBeUndefined();
    expect((await here.browser.links.get(project))?.project).toBe(project);
  });
});

describe("taking the copy of a project out of this browser", () => {
  /** A browser with a copy of a project of the platform, opened and in step, on the start page. */
  async function withCopy() {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    const leave = async () => {
      await here.cloud.close();
      await here.session.close();
    };
    return { time, platform, project, here, leave };
  }

  it("takes away the log, the files and the link once people say so, and the platform keeps the project", async () => {
    const { platform, project, here, leave } = await withCopy();
    await here.library.media(project).put("sound-1:made", new Blob(["made"]));
    await leave();
    const asked = answering(here.dialogs, () => true);
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(asked[0]).toMatchObject({
      title: "从这个浏览器移除“原子是什么”？",
      message: "只移除这个浏览器里的这一份，云端的项目不受影响，以后可以再打开。",
    });
    expect(here.library.summaries.has(project)).toBe(false);
    expect(here.library.updates.has(project)).toBe(false);
    expect([...here.library.files.keys()]).toEqual([]);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(platform.projects.has(project)).toBe(true);
    expect(platform.removed).toEqual([]);
    expect(messagesOf(here.notifications)).toContain(
      "已从这个浏览器移除“原子是什么”。云端的项目还在。",
    );
    // It opens again from the platform.
    expect(await here.cloud.openCloudProject(project)).toBe(true);
  });

  it("reads the log first, and asks where changes did not get to the platform", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    // Without a network people go on working, and then close the project.
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/offline.js", "only here"));
    await time.advance(100);
    await leave();
    // The hint a list goes by can be wrong, as after a crash: the log is what is read.
    const link = await here.browser.links.get(project);
    if (!link) throw new Error("no link");
    here.browser.links.links.set(project, { ...link, pending: 0 });

    let answer: string | undefined;
    const asked = answering(here.dialogs, (request) => (request.kind === "choice" ? answer : true));
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    const question = asked[0] as Extract<DialogRequest, { kind: "choice" }>;
    expect(question.title).toBe("“原子是什么”还有内容只在这个浏览器里");
    expect(question.message).toBe("有 1 个改动还没同步到云端。现在移除，这些内容就没有了。");
    expect(question.choices).toEqual([
      { id: "open", label: "打开项目让它同步" },
      { id: "remove", label: "仍然移除", kind: "danger" },
    ]);
    // Leaving it: all of it is still there.
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeDefined();

    // Opening it lets it sync.
    answer = "open";
    platform.faults.silent = false;
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(here.session.key).toBe(project);
    await time.advance(2000);
    expect(filesOn(platform, project)["code/offline.js"]).toBe("only here");
    await leave();

    // Now the platform has all of it, and people are only asked whether they mean it.
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(here.library.summaries.has(project)).toBe(false);
  });

  it("takes it away all the same where people say so, knowing what goes", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/a.js", "a"));
    await time.advance(100);
    here.session.store?.execute(write("code/b.js", "b"));
    await time.advance(100);
    await leave();
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? "remove" : true,
    );
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect((asked[0] as { message: string }).message).toContain("有 2 个改动还没同步到云端。");
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect(here.library.summaries.has(project)).toBe(false);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(platform.projects.has(project)).toBe(true);
  });

  it("takes a project that never got to the platform for one that is not there at all", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    // Connected while the platform could not be reached: the first version never went.
    platform.faults.silent = true;
    await here.open(id);
    answering(here.dialogs, () => true);
    await connectNow(here.cloud);
    await time.advance(200);
    expect((await here.browser.links.get(id))?.creating).toBe(true);
    await here.cloud.close();
    await here.session.close();
    const asked: DialogRequest[] = [];
    here.dialogs.subscribe(() => {
      const request = here.dialogs.getSnapshot();
      if (request && !asked.includes(request)) asked.push(request);
    });
    expect(await here.cloud.removeFromBrowser(id)).toBe(false);
    const question = asked.find((request) => request.kind === "choice") as { message: string };
    expect(question.message).toBe("这个项目还没传到云端。现在移除，这些内容就没有了。");
    expect(here.library.summaries.has(id)).toBe(true);
    expect(platform.projects.size).toBe(0);
  });

  it("asks about files of assets that are only in this browser, which nothing brings back", async () => {
    const { time, project, here, leave } = await withCopy();
    const file = new Blob(["一段视频"]);
    const hash = await hashFile(file);
    await here.library.media(project).put(hash, file);
    const added = here.session.store?.execute({
      type: "asset.add",
      params: {
        id: "asset_new",
        asset: {
          kind: "video",
          storage: "local",
          path: "assets/新素材.mp4",
          hash,
          size: file.size,
        },
      },
    });
    expect(added?.ok).toBe(true);
    await time.advance(500);
    // The project itself is on the platform: what it says about the asset, not its file.
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    await leave();

    const asked = answering(here.dialogs, () => undefined);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "有 1 个素材文件只在这个浏览器里，别处下载不到：assets/新素材.mp4。现在移除，这些内容就没有了。素材文件可以先用“下载到文件夹…”留一份。",
    );
    expect(here.library.files.size).toBe(1);
    expect(here.library.summaries.has(project)).toBe(true);
  });

  it("leaves the project first where it is the open one, and looks again at what leaving saved", async () => {
    const { time, platform, project, here } = await withCopy();
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? undefined : true,
    );
    // In step when people ask...
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    platform.faults.silent = true;
    // ...and a change comes in right as they say yes, which leaving the project saves.
    const stop = here.dialogs.subscribe(() => {
      if (here.dialogs.getSnapshot()?.kind !== "confirm") return;
      stop();
      here.session.store?.execute(write("code/late.js", "late"));
    });
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "choice"]);
    expect((asked[1] as { message: string }).message).toContain("有 1 个改动还没同步到云端。");
    expect(here.session.key).toBeUndefined();
    expect(here.library.summaries.has(project)).toBe(true);
    await time.advance(10);

    // Nothing in the way: it is left, and gone.
    platform.faults.silent = false;
    await here.cloud.openCloudProject(project);
    await time.advance(2000);
    expect(filesOn(platform, project)["code/late.js"]).toBe("late");
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(here.session.key).toBeUndefined();
    expect(here.library.summaries.has(project)).toBe(false);
  });

  it("asks the platform whether it still has the project, and says so where this copy is the last one", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    here.session.store?.execute(write("code/only.js", "这一份现在只在这个浏览器里"));
    await time.advance(500);
    // In step: as far as this browser knows, the platform has all of it.
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    await leave();
    // Taken away there since, on another computer.
    expect(platform.remove("ada", project)).toBe("removed");
    let answer: string | undefined;
    const asked = answering(here.dialogs, (request) => (request.kind === "choice" ? answer : true));
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    const question = asked[0] as Extract<DialogRequest, { kind: "choice" }>;
    expect(question.title).toBe("云端已经没有“原子是什么”了");
    expect(question.message).toBe(
      "云端的项目列表里没有这个项目了，可能已经在别的设备上删掉。这个浏览器里的是最后一份。现在移除，这个项目就找不回来了。",
    );
    expect(question.choices).toEqual([
      { id: "open", label: "打开项目" },
      { id: "remove", label: "仍然移除", kind: "danger" },
    ]);
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeDefined();

    // People say so all the same: it goes, and nothing says that the platform still has it.
    answer = "remove";
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect(here.library.summaries.has(project)).toBe(false);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(messagesOf(here.notifications)).toContain("已从这个浏览器移除“原子是什么”。");
    expect(messagesOf(here.notifications).join("")).not.toContain("云端的项目还在");
  });

  it("asks as about something it cannot make sure of where the platform cannot say which projects it has", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    await leave();
    let answer: string | undefined;
    const asked = answering(here.dialogs, (request) => (request.kind === "choice" ? answer : true));
    const unsure = {
      kind: "choice",
      title: "没法确认云端的“原子是什么”是完整的",
      message:
        "现在读不到云端的项目列表（没有网络，或者没有登录），没法确认云端还有没有这个项目。如果云端已经没有了，这个浏览器里的就是最后一份，移除以后找不回来。",
      // Nothing waits to sync: opening the project would not tell either.
      choices: [{ id: "remove", label: "仍然移除", kind: "danger" }],
    };
    // The platform is out of reach.
    platform.faults.unreachable = true;
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject(unsure);
    platform.faults.unreachable = false;
    // Nobody is signed in.
    platform.signOut("ada");
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject(unsure);
    platform.signIn("ada");
    // It does not answer at all: people are not left waiting for it.
    platform.faults.hangs = true;
    const removing = here.cloud.removeFromBrowser(project);
    await time.advance(8000);
    expect(await removing).toBe(false);
    expect(asked).toHaveLength(3);
    expect(asked[2]).toMatchObject(unsure);
    platform.faults.hangs = false;
    expect(here.library.summaries.has(project)).toBe(true);

    // Taken away all the same, without knowing: nothing says that the platform has it.
    platform.faults.unreachable = true;
    answer = "remove";
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(messagesOf(here.notifications)).toContain("已从这个浏览器移除“原子是什么”。");
    expect(messagesOf(here.notifications).join("")).not.toContain("云端的项目还在");
  });

  it("says that it cannot tell where the project is of another account than the one that is signed in", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    // This browser asks the platform as whoever is signed in, which changes below.
    let user = "ada";
    const here = await windowOf(platform, time, {
      overrides: { list: async () => platform.list(user) },
    });
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    expect((await here.browser.links.get(project))?.owner).toBe("user-ada");
    await here.cloud.close();
    await here.session.close();
    // Somebody else signs in: their list does not have ada's project, and says nothing about it.
    user = "bob";
    here.who.set({ status: "signedIn", id: "user-bob", name: "bob", appInstalled: true });
    const asked = answering(here.dialogs, () => undefined);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: "choice",
      title: "没法确认云端的“原子是什么”是完整的",
      message:
        "这个项目是用另一个账号连到云端的，现在登录的账号看不到它，没法确认云端还有没有这个项目。如果云端已经没有了，这个浏览器里的就是最后一份，移除以后找不回来。",
    });
    expect(here.library.summaries.has(project)).toBe(true);
    expect(platform.projects.has(project)).toBe(true);
  });

  it("does not say that the platform has a project that never got there, once it goes all the same", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    platform.faults.silent = true;
    await here.open(id);
    expect(typeof (await here.cloud.beginLink())).toBe("object");
    await time.advance(200);
    expect((await here.browser.links.get(id))?.creating).toBe(true);
    await here.cloud.close();
    await here.session.close();
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? "remove" : true,
    );
    expect(await here.cloud.removeFromBrowser(id)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "这个项目还没传到云端。现在移除，这些内容就没有了。",
    );
    expect(here.library.summaries.has(id)).toBe(false);
    expect(messagesOf(here.notifications)).toEqual(["已从这个浏览器移除“原子”。"]);
  });

  it("reads all of it again right before anything goes, whichever window had the project open meanwhile", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    await leave();
    const other = await windowOf(platform, time, { browser: here.browser, library: here.library });
    let isDone = false;
    const asked = answering(here.dialogs, async (request) => {
      if (request.kind === "confirm" && !isDone) {
        isDone = true;
        // While the question is on the screen, another window opens the project, changes it
        // without a network, and closes again.
        platform.faults.silent = true;
        platform.drop();
        await other.open(project);
        other.session.store?.execute(write("code/other.js", "在另一个窗口里改的"));
        await time.advance(200);
        await other.cloud.close();
        await other.session.close();
      }
      return request.kind === "choice" ? undefined : true;
    });
    // In step when people were asked, and not any more when they said yes.
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "choice"]);
    expect((asked[1] as { message: string }).message).toBe(
      "有 1 个改动还没同步到云端。现在移除，这些内容就没有了。",
    );
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeDefined();
    // What the other window wrote is still there, and gets to the platform.
    platform.faults.silent = false;
    await here.cloud.openCloudProject(project);
    await time.advance(40_000);
    expect(filesOn(platform, project)["code/other.js"]).toBe("在另一个窗口里改的");
  });

  it("asks again where more is only here by the time people said yes than they were told", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/a.js", "a"));
    await time.advance(100);
    await leave();
    const other = await windowOf(platform, time, { browser: here.browser, library: here.library });
    let isDone = false;
    const asked = answering(here.dialogs, async (request) => {
      if (request.kind !== "choice") return true;
      if (!isDone) {
        isDone = true;
        await other.open(project);
        other.session.store?.execute(write("code/b.js", "b"));
        await time.advance(100);
        await other.cloud.close();
        await other.session.close();
      }
      return "remove";
    });
    // Told of one change, they said to take it away; by then there were two.
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => (request as { message: string }).message)).toEqual([
      "有 1 个改动还没同步到云端。现在移除，这些内容就没有了。",
      "有 2 个改动还没同步到云端。现在移除，这些内容就没有了。",
    ]);
    expect(here.library.summaries.has(project)).toBe(false);
  });

  it("says so once it can be read after all, where what people said yes to was that nothing could be", async () => {
    const { platform, project, here, leave } = await withCopy();
    await leave();
    expect(platform.remove("ada", project)).toBe("removed");
    // The log cannot be read the first time, and can from then on.
    const open = here.library.open.bind(here.library);
    let isBusy = true;
    here.library.open = async (id) => {
      if (isBusy) {
        isBusy = false;
        throw new Error("busy");
      }
      return open(id);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? "remove" : true,
    );
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    warn.mockRestore();
    // "It may have changes the platform does not have" is not "this is the last copy".
    expect(asked.map((request) => (request as { message: string }).message)).toEqual([
      "没法确认这个浏览器里的改动是否都已同步到云端。现在移除，这些内容就没有了。",
      "云端的项目列表里没有这个项目了，可能已经在别的设备上删掉。这个浏览器里的是最后一份。现在移除，这个项目就找不回来了。",
    ]);
    expect(here.library.summaries.has(project)).toBe(false);
  });

  it("does not ask over and over where it cannot be read at all", async () => {
    const { project, here, leave } = await withCopy();
    await leave();
    here.library.open = async () => {
      throw new Error("busy");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? "remove" : true,
    );
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    warn.mockRestore();
    // Once: people said yes to not knowing, and not knowing is all there is.
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect(asked[0]).toMatchObject({ title: "没法确认云端的“原子是什么”是完整的" });
  });

  it("counts what windows left on the project that is not saved, which goes with it", async () => {
    const { project, here } = await withCopy();
    here.world.left.set(project, ["trial", "drafts"]);
    const asked = answering(here.dialogs, (request) =>
      request.kind === "choice" ? undefined : true,
    );
    // Not while the project is open here: what this window keeps on it is its own to settle as
    // it leaves. Once it left, what is still there is read like everything else.
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "choice"]);
    expect(asked[1]).toMatchObject({
      title: "“原子是什么”还有内容只在这个浏览器里",
      message: "还有没保存的试改和代码，只在这个浏览器里。现在移除，这些内容就没有了。",
      choices: [
        { id: "open", label: "打开项目" },
        { id: "remove", label: "仍然移除", kind: "danger" },
      ],
    });
    expect(here.session.key).toBeUndefined();
    expect(here.library.summaries.has(project)).toBe(true);
    // Not open anywhere: said at once.
    here.world.left.set(project, ["trial"]);
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "还有没保存的试改，只在这个浏览器里。现在移除，这些内容就没有了。",
    );
    // Nothing left: only whether people mean it.
    here.world.left.clear();
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
  });

  it("takes what waits to go to the platform in one piece for not there, until the platform took it", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    let answer: (request: DialogRequest) => unknown = () => true;
    const asked = answering(here.dialogs, (request) => answer(request));
    // The platform does not take a change, and never will as it is.
    platform.faults.rejections.push({ reason: "invalid", retry: false });
    here.session.store?.execute(write("code/a.js", "a"));
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot().problem).toMatchObject({ kind: "rejected" });
    const before = (await here.browser.links.get(project))?.pushed ?? 0;
    // People say to go on from the project as it is, just as the platform goes out of reach.
    platform.faults.silent = true;
    platform.drop();
    answer = (request) => (request.kind === "choice" ? "resync" : true);
    await here.cloud.resolveStuck();
    await time.advance(2000);
    const waiting = await here.browser.links.get(project);
    // Nothing is taken for sent: the platform took nothing yet.
    expect(waiting?.pushed).toBe(before);
    expect(waiting?.resync).toBeGreaterThan(before);
    expect(here.cloud.session?.getSnapshot().pending).toBe(1);
    await leave();
    asked.splice(0);
    answer = (request) => (request.kind === "choice" ? undefined : true);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "有 1 个改动还没同步到云端。现在移除，这些内容就没有了。",
    );

    // The platform is back: what waited goes there in one piece, and only then counts as sent.
    platform.faults.silent = false;
    await here.cloud.openCloudProject(project);
    await time.advance(5000);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(filesOn(platform, project)["code/a.js"]).toBe("a");
    const settled = await here.browser.links.get(project);
    expect(settled?.pushed).toBeGreaterThan(before);
    expect(settled).not.toHaveProperty("resync");
    await leave();

    // A link that still says something waits like that is not taken to be all there, whatever
    // its log says.
    if (!settled) throw new Error("no link");
    here.browser.links.links.set(project, { ...settled, resync: settled.pushed });
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toBe(
      "没法确认这个浏览器里的改动是否都已同步到云端。现在移除，这些内容就没有了。",
    );
    here.browser.links.links.set(project, settled);
    asked.splice(0);
    answer = () => true;
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
  });

  it("takes a file that is kept where this copy cannot get it from for one that is only here", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
    const file = new Blob(["一段视频"]);
    const hash = await hashFile(file);
    await here.library.media(project).put(hash, file);
    const asset = {
      kind: "video",
      storage: "local",
      path: "assets/新素材.mp4",
      hash,
      size: file.size,
    };
    expect(
      here.session.store?.execute({ type: "asset.add", params: { id: "asset_new", asset } }).ok,
    ).toBe(true);
    // An upload wrote down that the file is in the large file storage of a repository.
    const placed = (repo: string) =>
      here.session.store?.execute(
        { type: "asset.setStorage", params: { asset: "asset_new", storage: "lfs", hash, repo } },
        { origin: STORAGE },
      );
    // Of the repository the project is saved to, as its link remembers: it comes from there.
    const link = await here.browser.links.get(project);
    if (!link) throw new Error("no link");
    await here.browser.links.update(project, project, {
      repository: { id: 7, fullName: "ada/atom" },
    });
    expect(placed("7")?.ok).toBe(true);
    await time.advance(500);
    await leave();
    const asked = answering(here.dialogs, () => undefined);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);

    // Of another repository, as in a copy of the project: this one cannot get it from there.
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    expect(placed("999")?.ok).toBe(true);
    await time.advance(500);
    await leave();
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked.map((request) => request.kind)).toEqual(["choice"]);
    expect((asked[0] as { message: string }).message).toContain(
      "有 1 个素材文件只在这个浏览器里，别处下载不到：assets/新素材.mp4。",
    );
    expect(here.library.files.size).toBe(1);
  });

  it("takes the link away last, and tidies up one that stayed behind", async () => {
    const { project, here, leave } = await withCopy();
    await leave();
    answering(here.dialogs, () => true);
    // The copy cannot be taken away: nothing goes, the link least of all.
    const remove = here.library.remove.bind(here.library);
    here.library.remove = async () => {
      throw new Error("blocked");
    };
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeDefined();
    expect(messagesOf(here.notifications)).toContain("没能从这个浏览器移除，可以再试一次。");
    here.library.remove = remove;

    // The copy goes, and its link cannot be taken away: a link to nothing stays, which is in
    // nobody's way, where a copy without its link would look like a project of this browser only.
    const forget = here.browser.links.remove.bind(here.browser.links);
    let tries = 0;
    here.browser.links.remove = async () => {
      tries += 1;
      throw new Error("blocked");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await here.cloud.removeFromBrowser(project)).toBe(true);
    warn.mockRestore();
    expect(tries).toBe(2);
    expect(here.library.summaries.has(project)).toBe(false);
    const left = await here.browser.links.get(project);
    expect(left).toBeDefined();
    here.browser.links.remove = forget;
    // The project opens from the platform again all the same, in place of what was left.
    expect(await here.cloud.openCloudProject(project)).toBe(true);
    await leave();
    expect(here.library.summaries.has(project)).toBe(true);

    // The next time the page loads, links to nothing go: not one that was made just now, whose
    // copy may still be on its way in, and never one whose copy is there.
    const { id, state } = fixtureState();
    if (!left) throw new Error("no link");
    here.browser.links.links.set("gone-long-ago", { ...left, key: "gone-long-ago", linkedAt: 1 });
    here.browser.links.links.set("coming", { ...left, key: "coming", linkedAt: Date.now() });
    await here.library.create({ id, name: "原子" }, state);
    here.browser.links.links.set(id, { ...left, key: id, linkedAt: 1 });
    here.folders.set("a-folder", {} as LocalFolder);
    here.browser.links.links.set("a-folder", { ...left, key: "a-folder", linkedAt: 1 });
    await here.cloud.tidy();
    expect([...here.browser.links.links.keys()].toSorted()).toEqual(
      ["a-folder", "coming", id, project].toSorted(),
    );
  });

  it("takes a browser that cannot tell which windows have the project open for one that has", async () => {
    const { project, here, leave } = await withCopy();
    await leave();
    here.world.othersFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = answering(here.dialogs, () => true);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    warn.mockRestore();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: "confirm",
      noticeOnly: true,
      message: "没法确认这个浏览器的其他窗口有没有开着这个项目。先关掉其他窗口，再试一次。",
    });
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeDefined();
  });

  it("does not take away a copy that another window has open, or a folder", async () => {
    const { project, here, leave } = await withCopy();
    await leave();
    here.world.others.set(project, 1);
    const asked = answering(here.dialogs, () => true);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked[0]).toMatchObject({
      kind: "confirm",
      noticeOnly: true,
      message: "这个浏览器的其他窗口还开着这个项目。先关掉那些窗口，再移除。",
    });
    expect(here.library.summaries.has(project)).toBe(true);

    // A folder is the project itself: it goes off the list of folders, never like this.
    here.world.others.clear();
    here.folders.set(project, {} as LocalFolder);
    asked.splice(0);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked).toEqual([]);
    expect(here.library.summaries.has(project)).toBe(true);
    // And a project that is not connected is not one of these.
    expect(await here.cloud.removeFromBrowser("nothing")).toBe(false);
  });
});

describe("downloading a project of the platform into a folder", () => {
  it("opens the project, and moves it into a folder that people choose", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    here.world.move = async () => true;
    expect(await here.cloud.downloadToFolder(project)).toBe(true);
    expect(here.session.key).toBe(project);
    expect(here.world.moved).toEqual([project]);
    expect(here.dialogs.getSnapshot()).toBeUndefined();
  });

  it("asks before it asks for the folder where the project took a while to come", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    here.world.move = async () => true;
    // The browser lets a page ask for a folder only right after people did something.
    here.world.active = false;
    let go = false;
    const asked = answering(here.dialogs, () => go);
    expect(await here.cloud.downloadToFolder(project)).toBe(false);
    expect(asked[0]).toMatchObject({
      kind: "confirm",
      title: "把“原子是什么”放进文件夹",
      confirm: "选文件夹…",
      cancel: "先不放",
    });
    // Put off: it is open as a project of the platform without a folder, which is fine.
    expect(here.world.moved).toEqual([]);
    expect(here.session.key).toBe(project);
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });

    // Again, from the open project: no second copy, and the click is what lets the browser ask.
    go = true;
    expect(await here.cloud.downloadToFolder(project)).toBe(true);
    expect(here.world.moved).toEqual([project]);
    expect(here.library.summaries.size).toBe(1);
  });

  it("goes on with the same link once the project moved into a folder, which says nothing of it", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const disk = new MemoryDisk();
    disk.folder("下载", { quietly: true });
    disk.chooseNext("下载");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(platform, time);
    // As `FolderMove` leaves it: the same key, a folder from now on, and the project stays open.
    here.world.move = async (key) => {
      await here.library.toFolder(key);
      here.folders.set(key, folder);
      await here.cloud.follow();
      return true;
    };
    expect(await here.cloud.downloadToFolder(project)).toBe(true);
    await time.advance(200);
    expect(disk.has(`下载/${OLD_CLOUD_FILE}`)).toBe(false);
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "folder" });
    // The same link goes on: nothing was connected again.
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    here.session.store?.execute(write("code/in-folder.js", "f"));
    await time.advance(200);
    expect(filesOn(platform, project)["code/in-folder.js"]).toBe("f");

    // From now on the project is that folder: downloading again opens it, and moves nothing.
    here.world.moved.splice(0);
    await here.cloud.close();
    await here.session.close();
    expect(await here.cloud.downloadToFolder(project)).toBe(true);
    expect(here.world.moved).toEqual([]);
    expect(messagesOf(here.notifications)).toContain(
      "这个云端项目在这台电脑上已经有文件夹了，直接打开它。",
    );
  });
});

describe("taking a project without a repository away on the platform", () => {
  it("takes it away once people say so, and what this browser has of it is of this browser only", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    const asked = answering(here.dialogs, () => true);
    expect(await here.cloud.deleteFromCloud(project, "原子是什么")).toBe(true);
    expect(asked[0]).toMatchObject({
      kind: "confirm",
      danger: true,
      title: "删除云端项目“原子是什么”？",
    });
    expect(platform.projects.has(project)).toBe(false);
    expect(platform.removed).toEqual([project]);
    // The copy stays, and is not connected any more: nothing makes the project again.
    expect(here.session.key).toBe(project);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(await here.browser.links.get(project)).toBeUndefined();
    here.session.store?.execute(write("code/after.js", "a"));
    await time.advance(2000);
    expect(platform.projects.size).toBe(0);
    expect(messagesOf(here.notifications)).toContain("已删除云端项目“原子是什么”。");
  });

  it("leaves a project that has a repository, and everything as it was", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
    const here = await windowOf(platform, time);
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    answering(here.dialogs, () => true);
    expect(await here.cloud.deleteFromCloud(project, "原子是什么")).toBe(false);
    expect(platform.projects.has(project)).toBe(true);
    expect(messagesOf(here.notifications)).toContain("这个云端项目已经有仓库，不能在这里删除。");
    // It syncs on.
    await time.advance(200);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    expect((await here.browser.links.get(project))?.project).toBe(project);

    // And nothing happens where people do not say yes, or the platform cannot be reached.
    const other = await windowOf(platform, time);
    answering(other.dialogs, () => false);
    expect(await other.cloud.deleteFromCloud(project, "原子是什么")).toBe(false);
    platform.repositories.delete(project);
    platform.faults.unreachable = true;
    const third = await windowOf(platform, time);
    answering(third.dialogs, () => true);
    expect(await third.cloud.deleteFromCloud(project, "原子是什么")).toBe(false);
    expect(messagesOf(third.notifications)).toContain("没能删除云端项目，请稍后再试。");
    expect(platform.projects.has(project)).toBe(true);
  });
});

describe("a project of somebody else, which the platform says is not there", () => {
  it("is not taken for gone where what this computer has of it says whose it is", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    // This browser reaches the platform as whoever is signed in, which changes below.
    let user = "ada";
    const here = await windowOf(platform, time, {
      overrides: {
        connect: () => platform.connect(user),
        remove: async (id) => platform.remove(user, id),
      },
    });
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    expect((await here.browser.links.get(project))?.owner).toBe("user-ada");
    // Somebody else signs in on this browser, and asks to take the project away: the platform
    // says "no such project" of ada's, as it would of one that is gone.
    user = "bob";
    here.who.set({ status: "signedIn", id: "user-bob", name: "bob", appInstalled: true });
    answering(here.dialogs, () => true);
    expect(await here.cloud.deleteFromCloud(project, "原子是什么")).toBe(false);
    expect(messagesOf(here.notifications)).toContain(
      "云端找不到这个项目，它可能属于另一个账号，所以没有删除，这台电脑上的那一份也没有动。换回连接它时用的账号再试。",
    );
    // Nothing went: neither the project of the platform, nor what connects this copy to it.
    expect(platform.projects.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toMatchObject({ project, owner: "user-ada" });
    await time.advance(200);
    expect(here.cloud.getSnapshot().kind).toBe("linked");

    // Their own project that is gone already is gone, as ever: the copy is of this browser only.
    user = "ada";
    here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    expect(platform.remove("ada", project)).toBe("removed");
    expect(await here.cloud.deleteFromCloud(project, "原子是什么")).toBe(true);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(here.cloud.getSnapshot().kind).toBe("none");
  });
});

describe("a project the platform would not make", () => {
  /** A project whose first version is on its way to the platform, which cannot be reached. */
  async function onItsWay() {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    here.session.store?.execute(write("code/mine.js", "在这台电脑上写的"));
    platform.faults.silent = true;
    const begun = await here.cloud.beginLink();
    if (typeof begun === "string") throw new Error(begun);
    await time.advance(200);
    expect(here.cloud.session?.getSnapshot().state).toBe("connecting");
    /** The platform is there again, and the window says hello once more. */
    const back = async () => {
      platform.faults.silent = false;
      time.wake();
      await time.advance(40_000);
    };
    return { time, platform, here, id, project: begun.link.project, back };
  }

  it("is one of this computer only again, with a word about it, as connecting it was given up on", async () => {
    const { platform, here, id, project, back } = await onItsWay();
    // The platform was asked to take the project away, as where giving up on connecting got no
    // answer back, or another window gave up on it: it makes none under that id again.
    platform.deleted.add(project);
    await back();
    expect(platform.projects.size).toBe(0);
    // People are not left with "the platform does not have this project" to choose about.
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(messagesOf(here.notifications)).toEqual([
      "云端的项目没有建成：这次连接已经取消。项目还在这台电脑上，内容没有动，可以重新连接到云端。",
    ]);
    // The project is as it was, to the last change.
    expect(here.session.key).toBe(id);
    expect(here.library.summaries.has(id)).toBe(true);
    expect(here.session.store?.getState().files["code/mine.js"]).toBe("在这台电脑上写的");
    // And it connects anew, as another project of the platform.
    const again = await here.cloud.beginLink();
    if (typeof again === "string") throw new Error(again);
    await here.time.advance(500);
    expect(again.link.project).not.toBe(project);
    expect(platform.projects.has(again.link.project)).toBe(true);
    expect(filesOn(platform, again.link.project)["code/mine.js"]).toBe("在这台电脑上写的");
  });

  it("keeps its link where somebody else is signed in than whoever began to connect it", async () => {
    const { platform, here, id, project, back } = await onItsWay();
    platform.deleted.add(project);
    expect((await here.browser.links.get(id))?.owner).toBe("user-ada");
    here.who.set({ status: "signedIn", id: "user-bob", name: "bob", appInstalled: true });
    await back();
    // The platform says the same of a project of somebody else: nothing says this one is gone.
    expect(here.cloud.getSnapshot().kind).toBe("linked");
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "missing", unmade: true },
    });
    expect((await here.browser.links.get(id))?.project).toBe(project);
    expect(messagesOf(here.notifications)).toEqual([]);
  });

  it("is something for people to look at where it was on the platform, and is not any more", async () => {
    const { platform, here, id, project, back } = await onItsWay();
    await back();
    expect(platform.projects.has(project)).toBe(true);
    expect((await here.browser.links.get(id))?.creating).toBeUndefined();
    // Taken away there, on another computer: the copy here was of a project that was there.
    expect(platform.remove("ada", project)).toBe("removed");
    await here.time.advance(40_000);
    expect(here.cloud.getSnapshot().kind).toBe("linked");
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "missing" },
    });
    expect(here.cloud.session?.getSnapshot().problem).not.toHaveProperty("unmade");
    expect((await here.browser.links.get(id))?.project).toBe(project);
    expect(messagesOf(here.notifications)).toEqual([]);
  });
});

describe("what a link remembers for lists", () => {
  it("keeps the name, the owner and the repository of the open project as they are found out", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const repository = new FakeRepositories();
    const here = await windowOf(platform, time, { repository });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    await connectNow(here.cloud);
    await time.advance(200);
    // Connected, and the platform said that it has no repository.
    expect(await here.browser.links.get(id)).toMatchObject({
      name: "原子是什么",
      owner: "user-ada",
      repository: null,
    });
    // Once it has one, and under another name.
    repository.answer = await repository.link("p", { create: { name: "atom" } });
    await here.cloud.repository?.refresh();
    here.session.store?.execute({ type: "project.rename", params: { name: "原子 2" } });
    await time.advance(100);
    await here.cloud.close();
    await time.advance(10);
    expect(await here.browser.links.get(id)).toMatchObject({
      name: "原子 2",
      repository: { id: 99, fullName: "ada/atom" },
    });
  });

  it("lets a project go to another repository at any time, saying so to the platform", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const repository = new FakeRepositories();
    const here = await windowOf(platform, time, { repository });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    const asked = answering(here.dialogs, async (request) =>
      request.kind === "repository" ? (await request.picker.submit()) !== undefined : true,
    );
    const link = await connectNow(here.cloud);
    await time.advance(200);
    expect(here.cloud.canSwitchRepository).toBe(false);
    // Its first repository, as the dialog that connects it gets it.
    repository.answer = await repository.link(link.project, { create: { name: "atom" } });
    repository.archived(time.now());
    await here.cloud.repository?.refresh();
    expect(here.cloud.repository?.status?.state).toBe("ready");
    expect(here.cloud.canSwitchRepository).toBe(true);

    asked.splice(0);
    await here.cloud.switchRepository();
    const dialog = asked[0] as Extract<DialogRequest, { kind: "repository" }>;
    expect(dialog).toMatchObject({ kind: "repository", title: "换一个仓库" });
    // The one it has shows as that, and the platform hears that this is on purpose.
    expect(dialog.picker.current?.id).toBe(99);
    expect(repository.links.at(-1)).toMatchObject({ switch: true });
    expect(repository.links).toHaveLength(2);
  });
});

describe("a project only in this browser, without the platform (the design of the start page, 7)", () => {
  it("is told apart from a folder, and people hear once that it is not safe", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    here.world.tellOnlyHere = true;
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none", local: "browser" });
    expect(
      messagesOf(here.notifications).filter((text) => text.includes("只在这个浏览器里")),
    ).toHaveLength(1);
    await here.cloud.close();
    await here.session.close();
    await here.open(id);
    expect(
      messagesOf(here.notifications).filter((text) => text.includes("只在这个浏览器里")),
    ).toHaveLength(1);
    // Once it is connected, it is not only here any more.
    const link = await connectNow(here.cloud);
    expect(here.cloud.getSnapshot().kind).toBe("linked");
    // ...and it is again once connecting is given up on.
    await time.advance(100);
    const outcome = here.cloud.abandonConnect(link);
    await time.advance(5000);
    expect(await outcome).toBe("cancelled");
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none", local: "browser" });
  });

  it("says nothing about one that was made there on purpose, as tests do", async () => {
    const time = new TestTime();
    const here = await windowOf(new MemoryPlatform(), time);
    here.world.tellOnlyHere = true;
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    here.cloud.noteToldOnlyHere(id);
    await here.open(id);
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none", local: "browser" });
    expect(messagesOf(here.notifications)).toEqual([]);
  });

  it("is no such project where it is a folder", async () => {
    const disk = new MemoryDisk();
    disk.folder("atom", { quietly: true });
    disk.chooseNext("atom");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const here = await windowOf(new MemoryPlatform(), new TestTime(), {
      folders: new Map([["本机1", folder]]),
    });
    const { state } = fixtureState();
    await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
    await here.open("本机1");
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none" });
    expect(messagesOf(here.notifications)).toEqual([]);
  });
});

describe("asking the browser to keep what it stores (R-ST-9)", () => {
  const persistence = (answer: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      persistence: {
        persisted: async () => {
          asked.push("persisted");
          return false;
        },
        persist: async () => {
          asked.push("persist");
          return answer;
        },
        clearsWhenIdle: false,
      },
    };
  };

  it("asks once a project of the platform is only in this browser, and says so where it says no", async () => {
    const time = new TestTime();
    const { asked, persistence: kept } = persistence(false);
    const here = await windowOf(new MemoryPlatform(), time, { persistence: kept });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    here.cloud.noteToldOnlyHere(id);
    await here.open(id);
    // Not for a project that is not of the platform.
    expect(asked).toEqual([]);
    await connectNow(here.cloud);
    await time.advance(10);
    expect(asked).toEqual(["persisted", "persist"]);
    expect(here.cloud.persisted).toBe(false);
    expect(messagesOf(here.notifications).some((text) => text.includes("长期保存"))).toBe(true);
    // Once.
    await here.cloud.close();
    await here.open(id);
    await time.advance(10);
    expect(asked).toEqual(["persisted", "persist"]);
  });

  it("says nothing where the browser keeps it", async () => {
    const time = new TestTime();
    const { asked, persistence: kept } = persistence(true);
    const here = await windowOf(new MemoryPlatform(), time, { persistence: kept });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    here.cloud.noteToldOnlyHere(id);
    await here.open(id);
    await connectNow(here.cloud);
    await time.advance(10);
    expect(asked).toEqual(["persisted", "persist"]);
    expect(here.cloud.persisted).toBe(true);
    expect(messagesOf(here.notifications)).toEqual([]);
  });
});
