import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it } from "vitest";
import { type DialogRequest } from "../workbench/dialogs.ts";
import { MemoryPlatform, TestTime } from "./cloud-support.ts";
import {
  answering,
  closeWindows,
  connectNow,
  fixtureState,
  messagesOf,
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
    // Taken away on the platform, on another computer, as a platform says it that does not tell
    // editors that it was deleted yet, see `MemoryPlatform.knowsDeleted`.
    platform.knowsDeleted = false;
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
      "服务器找不到这个项目：它可能已经在别处删掉，或者属于另一个账号（那样的话，换回那个账号登录就能接着同步）。改动都在这个浏览器里，可以先保存到文件夹，留一份。",
    );
    // There is nothing there to take what the project has: only a copy in a folder.
    expect(question.choices).toEqual([
      { id: "saveToFolder", label: "保存到文件夹…", kind: "primary" },
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
    // So clearing this computer still says what it would lose.
    await here.cloud.close();
    await here.session.close();
    const [found] = await here.cloud.unsavedHere();
    expect(found?.said).toContain("这个浏览器里的是最后一份。有 1 个改动还没同步到服务器。");
    expect(here.library.summaries.has(project)).toBe(true);
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
    expect(second.cloud.getSnapshot()).toMatchObject({ kind: "linked" });
    expect(second.cloud.session?.getSnapshot().state).toBe("online");

    const write = (text: string) => ({ type: "file.write", params: { path: "code/x.js", text } });
    first.session.store?.execute(write("from the first"));
    await time.advance(200);
    expect(second.session.store?.getState().files["code/x.js"]).toBe("from the first");
    second.session.store?.execute(write("from the second"));
    await time.advance(200);
    expect(first.session.store?.getState().files["code/x.js"]).toBe("from the second");
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

  it("asks for a working copy that only the repository has, and waits for one on its way back", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const here = await windowOf(platform, time);
    const connections = platform.connections;
    // A word this editor does not know is nothing it can open yet.
    expect(await here.cloud.openCloudProject(project, { copy: "somethingNew" })).toBe(false);
    expect(platform.connections).toBe(connections);
    expect(messagesOf(here.notifications)).toEqual([
      "这个在线项目现在没法从 GitHub 取回，请稍后再试。",
    ]);

    platform.listed.set(project, { copy: "restoring" });
    const opening = here.cloud.openCloudProject(project, { copy: "restoring" });
    await time.advance(4000);
    expect(here.dialogs.getSnapshot()).toMatchObject({
      kind: "progress",
      title: "正在从 GitHub 取回…",
    });
    expect(platform.connections).toBe(connections);
    platform.listed.set(project, { copy: "live" });
    await time.advance(4000);
    expect(await opening).toBe(true);
    expect(here.session.key).toBe(project);
  });
});

describe("what of the copies of this browser the platform may not have (清掉这台电脑上的数据)", () => {
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

  it("is nothing where the platform has all of it", async () => {
    const { here, leave } = await withCopy();
    await leave();
    expect(await here.cloud.unsavedHere()).toEqual([]);
  });

  it("reads the log, not the hint a list goes by: changes that did not get there", async () => {
    const { time, platform, project, here, leave } = await withCopy();
    // Without a network people go on working, and then close the project.
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/a.js", "a"));
    await time.advance(100);
    here.session.store?.execute(write("code/b.js", "b"));
    await time.advance(100);
    await leave();
    const link = await here.browser.links.get(project);
    if (!link) throw new Error("no link");
    here.browser.links.links.set(project, { ...link, pending: 0 });
    platform.faults.silent = false;
    expect(await here.cloud.unsavedHere()).toEqual([
      { name: "原子是什么", said: "有 2 个改动还没同步到服务器。" },
    ]);
    // Opened, it syncs, and nothing is only here any more.
    await here.cloud.openCloudProject(project);
    await time.advance(2000);
    expect(filesOn(platform, project)["code/a.js"]).toBe("a");
    await leave();
    expect(await here.cloud.unsavedHere()).toEqual([]);
  });

  it("counts files of assets that are only in this browser, which nothing brings back", async () => {
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
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    await leave();
    expect(await here.cloud.unsavedHere()).toEqual([
      {
        name: "原子是什么",
        said: "有 1 个素材文件只在这个浏览器里，别处下载不到：assets/新素材.mp4。",
      },
    ]);
  });

  it("says where the platform does not have the project any more: this copy is the last one", async () => {
    const { project, platform, here, leave } = await withCopy();
    await leave();
    platform.knowsDeleted = false;
    expect(platform.remove("ada", project)).toBe("removed");
    const [found] = await here.cloud.unsavedHere();
    expect(found?.said).toContain("服务器的项目列表里没有这个项目了");
  });

  it("rejects where the list of the platform cannot be read: nothing can be said", async () => {
    const { platform, here, leave } = await withCopy();
    await leave();
    platform.faults.unreachable = true;
    await expect(here.cloud.unsavedHere()).rejects.toThrow();
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
});

describe("asking the browser to keep what it stores (R-ST-9)", () => {
  const persistence = (answer: boolean, before = false) => {
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
        wasAsked: () => asked.includes("persist") || before,
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

  it("says nothing where this browser was asked before, by any page", async () => {
    const time = new TestTime();
    const { persistence: kept } = persistence(false, true);
    const here = await windowOf(new MemoryPlatform(), time, { persistence: kept });
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    await connectNow(here.cloud);
    await time.advance(10);
    // The panel still says it; only the notice is not given again.
    expect(here.cloud.persisted).toBe(false);
    expect(messagesOf(here.notifications)).toEqual([]);
  });
});
