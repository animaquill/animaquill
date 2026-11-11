import type { LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialogs, type DialogRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { Notifications } from "../workbench/notifications.ts";
import { ProjectSession } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "./cloud-support.ts";
import { CLOUD_FILE, CloudProjects, readCloudFile } from "./projects.ts";
import {
  MESSAGES,
  account,
  answering,
  closeWindows,
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
  await first.cloud.connect();
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
    // People disconnect it, as the menu still lets them: it is a project of this browser only now.
    answering(here.dialogs, () => true);
    await here.cloud.disconnect();
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

  it("says that a folder names a project this browser has a copy of its own of", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const disk = new MemoryDisk();
    disk.write(
      `别处/${CLOUD_FILE}`,
      JSON.stringify({ platform: "https://platform.test", project }),
      { quietly: true },
    );
    disk.chooseNext("别处");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const folders = new Map<string, LocalFolder>();
    const here = await windowOf(platform, time, { folders });
    await here.cloud.openCloudProject(project);
    await time.advance(200);

    // People open a folder of the same project of the platform in this browser.
    folders.set("本机5", folder);
    const { state } = fixtureState();
    await here.library.create({ id: "本机5", name: "原子", folder: true }, state);
    const asked = answering(here.dialogs, () => undefined);
    await here.open("本机5");
    await time.advance(50);
    expect(here.cloud.getSnapshot()).toEqual({ kind: "detached", project, reason: "browser" });
    expect(asked[0]).toMatchObject({
      kind: "choice",
      title: "这个云端项目在浏览器里已经有一份",
    });
    expect((asked[0] as { message: string }).message).toContain(
      "一个云端项目在一个浏览器里只能有一份",
    );
    // Nothing of the folder went to the platform, and the copy is as it was.
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
    await here.cloud.connect();
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

  it("has the folder say which project of the platform it is once the project moved into it", async () => {
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
    expect(readCloudFile(disk.text(`下载/${CLOUD_FILE}`))).toEqual({
      platform: "https://platform.test",
      project,
    });
    expect(disk.text("下载/.animaquill/.gitignore")).toBe("*\n");
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

describe("what a link remembers for lists", () => {
  it("keeps the name, the owner and the repository of the open project as they are found out", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const repository = new FakeRepositories();
    const here = await windowOf(platform, time, { repository });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    // People put the question about GitHub off.
    answering(here.dialogs, (request) => request.kind !== "repository");
    await here.cloud.connect();
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
    await here.cloud.connect();
    await time.advance(200);
    repository.archived(time.now());
    await here.cloud.repository?.refresh();
    expect(here.cloud.repository?.status?.state).toBe("ready");
    expect(here.cloud.canSaveToGitHub).toBe(false);
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
