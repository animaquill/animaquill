import { ProjectStore } from "@animaquill/core";
import { RepositoryRefused, type LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it } from "vitest";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "./cloud-support.ts";
import {
  answering,
  closeWindows,
  connectNow,
  fixtureState,
  messagesOf,
  windowOf,
} from "./projects-support.ts";
import { FakeRepositories } from "./repository-support.ts";
import { keepFolderFiles } from "./take-back-flow.ts";

afterEach(closeWindows);

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });

/** GitHub as the platform saves to it, following the platform. */
function repositoryOf(platform: MemoryPlatform): FakeRepositories {
  const repository = new FakeRepositories();
  repository.platform = platform;
  repository.followsPlatform = true;
  repository.repositories = [
    {
      id: 7,
      owner: "ada",
      name: "atom",
      fullName: "ada/atom",
      private: true,
      pushable: true,
      empty: false,
      archived: false,
      linked: false,
    },
  ];
  return repository;
}

/** A window with a project of the platform it made, saved to a repository and archived. */
async function connected(platform: MemoryPlatform, time: TestTime) {
  const repository = repositoryOf(platform);
  const browser = new TestCloudBrowser(platform, "ada");
  const here = await windowOf(platform, time, { repository, browser });
  const { id, state } = fixtureState();
  await here.library.create({ id, name: "原子" }, state);
  await here.open(id);
  // What people answer, which a test can say otherwise.
  const answers = { of: (_request: DialogRequest): unknown => true };
  answering(here.dialogs, (request) => answers.of(request));
  await connectNow(here.cloud);
  await time.advance(300);
  const project = (await here.browser.links.get(id))?.project ?? "";
  platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
  platform.archive(project);
  return { here, repository, browser, id, project, answers };
}

describe("a project whose working copy the platform let go of", () => {
  it("takes the copy here back by itself, with what it has that the repository does not", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, id, project } = await connected(platform, time);
    // On the platform, never archived: once the copy goes, only this browser has it.
    expect(here.session.store?.execute(write("code/late.js", "late")).ok).toBe(true);
    await time.advance(300);
    await here.cloud.close();
    await here.session.close();
    platform.release(project);

    await here.open(id);
    // The platform makes it again meanwhile, and the window hears that it is another copy.
    for (let round = 0; round < 6; round++) await time.advance(10_000);
    expect(await here.browser.links.get(id)).toMatchObject({ generation: 2 });
    expect(here.session.store?.getState().files["code/late.js"]).toBe("late");
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(project).getState().files["code/late.js"]).toBe("late");
    expect(messagesOf(here.notifications).at(-1)).toBe(
      "“原子是什么”已经接回，这台电脑上 1 个文件的改动并回了云端。",
    );
    // What the log had before goes once the platform has what came of it.
    await time.advance(5000);
    expect(await here.library.backups(id)).toEqual([]);
  });

  it("asks people where both changed the same place, and waits for them where they do not say", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, id, project, answers } = await connected(platform, time);
    const other = new TestCloudBrowser(platform, "ada");
    const there = await windowOf(platform, time, { browser: other });
    expect(await there.cloud.openCloudProject(project)).toBe(true);
    await time.advance(300);
    await here.cloud.close();
    await here.session.close();
    // Both change the same file: this one while it is away.
    expect(there.session.store?.execute(write("code/a.js", "theirs")).ok).toBe(true);
    await time.advance(300);
    platform.archive(project);
    await there.cloud.close();
    await there.session.close();
    platform.release(project);
    const library = here.library;
    const log = await library.open(id);
    const store = ProjectStore.fromUpdates(await log.load()).store as ProjectStore;
    // As this browser changed it offline, before it came back.
    const change = (() => {
      const before = store.stateVector();
      store.execute(write("code/a.js", "mine"));
      return store.diffSince(before);
    })();
    await log.append(change, "原子", { kind: "user", window: "w" });
    log.close();
    store.destroy();

    let asked: DialogRequest | undefined;
    const choices: ("cancel" | "here")[] = ["cancel", "here"];
    answers.of = (request) => {
      if (request.kind !== "reconcile") return true;
      asked = request;
      const choice = choices.shift();
      return choice === "here" ? { "code/a.js": "here" } : undefined;
    };
    await here.open(id);
    for (let round = 0; round < 6; round++) await time.advance(10_000);
    expect(asked).toMatchObject({
      kind: "reconcile",
      title: "接回“原子是什么”",
      items: [{ path: "code/a.js", status: "这台电脑和云端都改了同一处" }],
    });
    // Nothing changed: it waits, and can be looked at only.
    expect(here.cloud.rebuilt).toBe(true);
    expect(here.cloud.takeBack).toBe("stopped");
    expect((await here.browser.links.get(id))?.generation ?? 1).toBe(1);

    await here.cloud.takeBackAgain();
    for (let round = 0; round < 3; round++) await time.advance(10_000);
    expect(await here.browser.links.get(id)).toMatchObject({ generation: 2 });
    expect(platform.workingCopy(project).getState().files["code/a.js"]).toBe("mine");
  });

  it("opens again from the new copy in every window of the browser that has it", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, id, project, browser, repository } = await connected(platform, time);
    expect(here.session.store?.execute(write("code/late.js", "late")).ok).toBe(true);
    await time.advance(300);
    await here.cloud.close();
    await here.session.close();
    platform.release(project);
    const second = await windowOf(platform, time, { browser, library: here.library, repository });
    await here.open(id);
    await second.open(id);
    for (let round = 0; round < 6; round++) await time.advance(10_000);
    for (const window of [here, second]) {
      expect(window.session.store?.getState().files["code/late.js"]).toBe("late");
      expect(window.cloud.rebuilt).toBe(false);
      expect(window.cloud.session?.generation).toBe(2);
    }
    // Only one of them took it back: the change went once.
    const changes = platform.projects
      .get(project)
      ?.updates.filter((update) => update.kind === "other");
    expect(changes).toHaveLength(1);
  });

  it("is opened from the list once the platform made it again from the repository", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, project } = await connected(platform, time);
    expect(here.session.store?.execute(write("code/a.js", "archived")).ok).toBe(true);
    await time.advance(300);
    platform.archive(project);
    await here.cloud.close();
    await here.session.close();
    platform.release(project);

    const elsewhere = await windowOf(platform, time);
    expect(await elsewhere.cloud.openCloudProject(project, { copy: "released" })).toBe(true);
    expect(elsewhere.session.store?.getState().files["code/a.js"]).toBe("archived");
    expect(platform.projects.get(project)?.generation).toBe(2);
  });

  it("says why it could not come, and takes the repository as it is once people put it right", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, project } = await connected(platform, time);
    await here.cloud.close();
    await here.session.close();
    platform.release(project);
    platform.rebuildFails = "unreadable";
    const elsewhere = await windowOf(platform, time);
    const asked: DialogRequest[] = [];
    answering(elsewhere.dialogs, (request) => {
      asked.push(request);
      return request.kind === "choice" ? "fromBranch" : true;
    });
    expect(
      await elsewhere.cloud.openCloudProject(project, { copy: "released", name: "原子是什么" }),
    ).toBe(true);
    expect(asked[0]).toMatchObject({ kind: "choice", title: "没能从 GitHub 取回“原子是什么”" });
    expect((asked[0] as unknown as { choices: unknown[] }).choices).toContainEqual({
      id: "fromBranch",
      label: "我已在 GitHub 上修好，按现在的样子取回",
      kind: "primary",
    });
    expect((asked[0] as unknown as { message: string }).message).toContain(
      "GitHub 仓库里有读不懂的文件：timeline.json",
    );
    expect(platform.projects.get(project)?.copy).toBe("live");
  });
});

describe("a project this browser has whose working copy the platform could not make again", () => {
  it("says why, and takes the branch as it is once people put it right, asking about every file", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, id, project, answers } = await connected(platform, time);
    expect(here.session.store?.execute(write("code/a.js", "mine")).ok).toBe(true);
    await time.advance(300);
    await here.cloud.close();
    await here.session.close();
    platform.release(project);
    platform.rebuildFails = "unreadable";

    await here.open(id);
    for (let round = 0; round < 3; round++) await time.advance(10_000);
    // It waits for the platform, and says why it has to.
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ restoring: "released" });
    expect(here.cloud.copyProblem).toMatchObject({ code: "unreadable", files: ["timeline.json"] });
    expect(platform.projects.get(project)?.copy).toBe("released");

    // People put it right on GitHub: the copy is made from the branch, which has nothing in
    // common with what this computer has, so they choose for each file that is not the same.
    const branch = new Map(platform.archives.get(project));
    branch.set("code/a.js", "on github");
    platform.branches.set(project, branch);
    let asked: DialogRequest | undefined;
    answers.of = (request) => {
      if (request.kind !== "reconcile") return true;
      asked = request;
      return { "code/a.js": "here" };
    };
    await here.cloud.wakeFromBranch();
    for (let round = 0; round < 6; round++) await time.advance(10_000);
    expect(asked).toMatchObject({
      kind: "reconcile",
      items: [{ path: "code/a.js", status: "两边不一样" }],
    });
    expect(await here.browser.links.get(id)).toMatchObject({ generation: 2 });
    expect(platform.workingCopy(project).getState().files["code/a.js"]).toBe("mine");
    expect(here.cloud.copyProblem).toBeUndefined();
  });
});

describe("restoring a repository as a project of the platform", () => {
  it("makes the project from what the repository has, and opens it in this browser", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, repository } = await connected(platform, time);
    const files = platform.workingCopy([...platform.projects.keys()][0] ?? "").exportFiles().files;
    files.set("code/restored.js", "from github");
    repository.contents.set(7, files);
    const opened = await here.cloud.restoreFromRepository({ id: 7, fullName: "ada/atom" });
    expect(opened).toBe(true);
    expect(here.session.store?.getState().files["code/restored.js"]).toBe("from github");
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });
  });

  it("waits for one that takes longer, as the list says", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, repository } = await connected(platform, time);
    repository.contents.set(
      7,
      platform.workingCopy([...platform.projects.keys()][0] ?? "").exportFiles().files,
    );
    repository.restoreSlowly = true;
    const opening = here.cloud.restoreFromRepository({ id: 7, fullName: "ada/atom" });
    await time.advance(4000);
    expect(here.dialogs.getSnapshot()).toMatchObject({
      kind: "progress",
      title: "正在从 GitHub 取回…",
    });
    const made = [...platform.projects.values()].find((each) => each.copy === "restoring");
    if (made) made.copy = "live";
    await time.advance(4000);
    expect(await opening).toBe(true);
  });

  it("says why it was refused, with the files that do not read", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { here, repository, answers } = await connected(platform, time);
    const told: DialogRequest[] = [];
    answers.of = (request) => {
      told.push(request);
      return true;
    };
    repository.refuseRestore = new RepositoryRefused("unreadable", { files: ["timeline.json"] });
    expect(await here.cloud.restoreFromRepository({ id: 7, fullName: "ada/atom" })).toBe(false);
    expect(told.at(-1)).toMatchObject({
      title: "没能从仓库 ada/atom 恢复",
      message: "仓库里有读不懂的文件：timeline.json。在 GitHub 上修好以后再试。",
    });
    repository.refuseRestore = new RepositoryRefused("unavailable");
    expect(await here.cloud.restoreFromRepository({ id: 7, fullName: "ada/atom" })).toBe(false);
    expect(told.at(-1)).toMatchObject({
      message: "GitHub 或平台暂时出了问题，什么都没留下，可以再试一次。",
    });
  });
});

describe("keepFolderFiles", () => {
  it("keeps what the folder has of the files that change, read back, and nothing of the others", async () => {
    const disk = new MemoryDisk();
    disk.write("项目/code/a.js", "mine", { quietly: true });
    disk.chooseNext("项目");
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    const kept = await keepFolderFiles(
      folder,
      ["code/a.js", "code/none.js"],
      Date.UTC(2026, 10, 12, 8),
    );
    expect(kept).toMatch(/^\.animaquill\/recovered\/.+-rebuilt$/);
    expect(await folder.readText(`${kept}/code/a.js`)).toBe("mine");
    await expect(folder.readText(`${kept}/code/none.js`)).rejects.toThrow();
    // Another time, another place: nothing is written over.
    const again = await keepFolderFiles(folder, ["code/a.js"], Date.UTC(2026, 10, 12, 8));
    expect(again).toBe(`${kept}-2`);
    expect(await keepFolderFiles(folder, ["code/none.js"], 0)).toBeUndefined();
  });
});
