import { STORAGE } from "@animaquill/core";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      "云端找不到这个项目：它可能已经在别处删掉，或者属于另一个账号（那样的话，换回那个账号登录就能接着同步）。改动都在这个浏览器里，可以先保存到文件夹，留一份。",
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
      "这个云端项目现在没法从 GitHub 取回，请稍后再试。",
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

describe("taking the copy of a project out of this browser", () => {
  it("says where the platform has changes GitHub does not, ", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform, time);
    const repository = new FakeRepositories();
    const here = await windowOf(platform, time, { repository });
    await here.cloud.openCloudProject(project);
    await time.advance(200);
    await here.cloud.close();
    await here.session.close();
    const releaseAt = Date.now() + 5 * 24 * 3600_000;
    // Archiving paused for two conflicts with GitHub, and changes wait.
    repository.answer = {
      archiving: false,
      state: "paused",
      reason: "conflicts",
      conflicts: 2,
      head: 9,
      archivedSeq: 4,
      releaseAt,
    };
    const asked = answering(here.dialogs, () => false);
    expect(await here.cloud.removeFromBrowser(project)).toBe(false);
    expect(asked[0]).toMatchObject({
      kind: "confirm",
      warning:
        "这个项目还有改动没存进 GitHub（有 2 处冲突）。把这个浏览器里的副本移除以后，这些改动只在平台上。建议先处理好再移除。",
      cancel: "先不移除",
      confirm: "仍然移除",
      keep: true,
      danger: true,
    });
    // Saying no keeps it.
    expect(here.library.summaries.has(project)).toBe(true);
    // Not where the platform keeps them anyway, as GitHub is away, nor where it lets nothing go,
    // nor where GitHub has everything.
    for (const more of [
      { state: "ready", head: 9, archivedSeq: 4, failures: 3, failingSince: 1, releaseAt },
      { state: "paused", reason: "protected", head: 9, archivedSeq: 4 },
      { state: "paused", reason: "protected", head: 9, archivedSeq: 9, releaseAt },
    ] as const) {
      repository.answer = { archiving: false, ...more };
      const again = answering(here.dialogs, () => false);
      expect(await here.cloud.removeFromBrowser(project)).toBe(false);
      expect(again[0]).not.toHaveProperty("warning");
    }
  });

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
      "有 1 个素材文件只在这个浏览器里，别处下载不到：assets/新素材.mp4。现在移除，这些内容就没有了。",
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
    await here.cloud.tidy();
    expect([...here.browser.links.links.keys()].toSorted()).toEqual(
      ["coming", id, project].toSorted(),
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
