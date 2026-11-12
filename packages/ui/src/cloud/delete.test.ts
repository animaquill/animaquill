/**
 * Deleting a project of the platform, and what this computer has of it then, see the design of the
 * start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 5 and 5.1: archived first, and
 * only what the platform has all of goes; a copy in this browser goes only where nothing of it is
 * only here. Also a project that was deleted elsewhere, and one whose repository cannot be used.
 * Folders are in workbench/cloud-delete.test.ts, with the workbench around them.
 */
import type { CloudRemoveOptions, ProjectLog, RepositoryStatus } from "@animaquill/host";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it } from "vitest";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { MemoryPlatform, TestTime, type PlatformRepository } from "./cloud-support.ts";
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

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });
const REPOSITORY: PlatformRepository = { id: 7, owner: "ada", name: "atom" };
const DAY = 24 * 3600_000;

/** A log that cannot be read once a test says so, as a browser that blocks its storage. */
class Unreadable extends MemoryLibrary {
  unreadable = new Set<string>();
  override async open(id: string): Promise<ProjectLog> {
    if (this.unreadable.has(id)) throw new Error("blocked");
    return super.open(id);
  }
}

/** A project on the platform, saved to a repository, made from another browser. */
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
  platform.repositories.set(project, REPOSITORY);
  return project;
}

/** GitHub as the platform saves to it: the repository of the project, archived as it goes. */
function repositoryOf(platform: MemoryPlatform, project: string): FakeRepositories {
  const repository = new FakeRepositories();
  repository.platform = platform;
  repository.followsPlatform = true;
  repository.autoArchive = true;
  repository.answer = {
    repository: {
      id: REPOSITORY.id,
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      fullName: "ada/atom",
      private: true,
      branch: "main",
      url: "https://github.com/ada/atom",
      createdHere: true,
      linkedAt: 1,
    },
    state: "ready",
    archiving: false,
    head: platform.projects.get(project)?.head ?? 1,
    archivedSeq: 0,
  };
  return repository;
}

/** A window with a copy of the project in its browser, open and in step. */
async function withCopy({ library }: { library?: MemoryLibrary } = {}) {
  const time = new TestTime();
  const platform = new MemoryPlatform();
  const project = await onPlatform(platform, time);
  const repository = repositoryOf(platform, project);
  const here = await windowOf(platform, time, { repository, ...(library && { library }) });
  await here.cloud.openCloudProject(project);
  await time.advance(200);
  expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
  return { time, platform, project, repository, here };
}

/** Lets time go by while `work` goes, as people wait for it. */
async function meanwhile<T>(time: TestTime, work: Promise<T>, step = 250): Promise<T> {
  const state = { done: false };
  const watched = work.finally(() => {
    state.done = true;
  });
  for (let round = 0; round < 2000; round++) {
    if (state.done) break;
    await time.advance(step);
  }
  return watched;
}

/** Says yes to whatever asks, and how it goes otherwise, by the kind of question. */
const sayingYes = (choose: (request: DialogRequest) => unknown = () => undefined) =>
  ((request: DialogRequest) => (request.kind === "confirm" ? true : choose(request))) as (
    request: DialogRequest,
  ) => unknown;

describe("deleting a project of the platform that is saved to a repository", () => {
  it("archives it first, takes it away once the repository has all of it, and the copy in this browser goes", async () => {
    const { time, platform, project, repository, here } = await withCopy();
    here.session.store?.execute(write("code/late.js", "最后一笔"));
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    const head = platform.projects.get(project)?.head;

    const asked = answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    // People were told what goes and what stays, once, and nobody typed a name.
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(asked[0]).toMatchObject({
      title: "删除云端项目“原子是什么”？",
      message:
        "平台上不再有这个云端项目。GitHub 仓库 ada/atom 留着，里面的存档不动。这个浏览器里的那一份会清掉（还有没同步的改动、只在这里的素材时留下）。删除之前先把最新的改动存进 GitHub。",
      danger: true,
    });
    // Archived first, and taken away only as of what was archived.
    expect(repository.calls).toContain(`archiveNow ${project}`);
    expect(platform.removals).toEqual([{ id: project, options: { archived: head } }]);
    expect(platform.projects.has(project)).toBe(false);
    // The repository stays as it is.
    expect(platform.repositories.has(project)).toBe(true);
    // The copy in this browser had nothing the platform did not: it is gone, with its link.
    expect(here.session.key).toBeUndefined();
    expect(here.library.summaries.has(project)).toBe(false);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(messagesOf(here.notifications).at(-1)).toBe(
      "已删除云端项目“原子是什么”。这个浏览器里的那一份已清掉。",
    );
  });

  it("does not delete it while changes of the copy in this browser cannot get to the platform", async () => {
    const { time, platform, project, here } = await withCopy();
    // Changes made while the platform cannot be reached, and the copy closed since.
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/offline.js", "离线时改的"));
    await time.advance(1000);
    await here.cloud.close();
    await here.session.close();

    const asked = answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    // It opened to send them, could not, said why, and went back to where people were.
    const notice = asked.find((request) => request.kind === "confirm" && request.noticeOnly);
    expect((notice as { message: string } | undefined)?.message).toMatch(
      /^这个浏览器里的改动没能同步上去，所以没有删除：/,
    );
    expect(here.session.key).toBeUndefined();
    // Nothing went: not on the platform, not here.
    expect(platform.removals).toEqual([]);
    expect(platform.projects.has(project)).toBe(true);
    expect(here.library.summaries.has(project)).toBe(true);
    expect((await here.browser.links.get(project))?.project).toBe(project);
  });

  it("sends the changes of a copy that is not open first, and only then deletes it", async () => {
    const { time, platform, project, here } = await withCopy();
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/offline.js", "离线时改的"));
    await time.advance(1000);
    await here.cloud.close();
    await here.session.close();
    platform.faults.silent = false;

    // What the platform has as it is asked to take the project away.
    let had: Readonly<Record<string, string>> | undefined;
    const remove = here.cloud;
    const removing = platform.remove.bind(platform);
    platform.remove = (user: string, id: string, options?: CloudRemoveOptions) => {
      if (platform.projects.has(id)) had = platform.workingCopy(id).getState().files;
      return removing(user, id, options);
    };
    answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, remove.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(had?.["code/offline.js"]).toBe("离线时改的");
    expect(platform.projects.has(project)).toBe(false);
    expect(here.library.summaries.has(project)).toBe(false);
  });

  it("asks before letting go of what the repository does not have, and does only where people say so", async () => {
    const { time, platform, project, repository, here } = await withCopy();
    // GitHub does not take the archive: nothing new gets there.
    repository.autoArchive = false;
    repository.answer = { ...repository.answer, state: "paused", reason: "protected" };
    platform.repositories.set(project, { ...REPOSITORY, state: "paused", reason: "protected" });

    // People cancel: nothing goes, and the project syncs on.
    let choice: string | undefined;
    const cancelling = answering(
      here.dialogs,
      sayingYes(() => choice),
    );
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    const question = cancelling.find((request) => request.kind === "choice");
    expect(question).toMatchObject({
      message:
        "最新的改动没能存进 GitHub：GitHub 不让存档写进这个仓库。可以取消，等能存了再删；也可以仍然删除，最后这些改动就不会进 GitHub。",
      choices: [{ id: "discard", label: "仍然删除（最后的改动不会进 GitHub）", kind: "danger" }],
    });
    expect(platform.removals).toEqual([]);
    expect(platform.projects.has(project)).toBe(true);
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");

    // People let go of it: it goes as it is.
    choice = "discard";
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(platform.removals).toEqual([{ id: project, options: { discard: true } }]);
    expect(platform.projects.has(project)).toBe(false);
  });

  it("archives again where something came after the archive", async () => {
    const { time, platform, project, repository, here } = await withCopy();
    const removing = platform.remove.bind(platform);
    let first = true;
    platform.remove = (user: string, id: string, options?: CloudRemoveOptions) => {
      if (first) {
        // Another computer sent a change right after the archive.
        first = false;
        platform.archivedSeq.set(id, (platform.projects.get(id)?.head ?? 1) - 1);
      }
      return removing(user, id, options);
    };
    answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(repository.calls.filter((call) => call.startsWith("archiveNow"))).toHaveLength(2);
    expect(platform.removals.map(({ options }) => options)).toEqual([
      { archived: platform.removals[0]?.options.archived },
      { archived: platform.removals[0]?.options.archived },
    ]);
    expect(platform.projects.has(project)).toBe(false);
  });

  it("says that files are still on their way into the repository, and goes only where people say so", async () => {
    const { time, platform, project, here } = await withCopy();
    platform.uploads.set(project, 2);
    let choice: string | undefined;
    const asked = answering(
      here.dialogs,
      sayingYes(() => choice),
    );
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    expect(
      (asked.find((request) => request.kind === "choice") as { message: string }).message,
    ).toBe(
      "最新的改动没能存进 GitHub：还有 2 个素材文件没传完。可以取消，等能存了再删；也可以仍然删除，最后这些改动就不会进 GitHub。",
    );
    expect(platform.projects.has(project)).toBe(true);
    choice = "discard";
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(platform.removals.at(-1)?.options).toEqual({ discard: true });
  });

  it("does nothing where people do not say yes, or the platform's list cannot be read", async () => {
    const { time, platform, project, here } = await withCopy();
    answering(here.dialogs, () => false);
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    platform.faults.unreachable = true;
    const other = await windowOf(platform, time);
    answering(other.dialogs, () => true);
    expect(await meanwhile(time, other.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    expect(messagesOf(other.notifications)).toContain(
      "现在读不到云端的项目列表，没有删除。联网后再试。",
    );
    platform.faults.unreachable = false;
    expect(platform.removals).toEqual([]);
    expect(platform.projects.has(project)).toBe(true);
  });

  it("is not done where the list of whoever is signed in does not have it", async () => {
    const { time, platform, project, here } = await withCopy();
    here.who.set({ status: "signedIn", id: "user-bob", name: "bob", appInstalled: true });
    const bob = await windowOf(platform, time, {
      browser: here.browser,
      overrides: { list: async () => platform.list("bob") },
    });
    answering(bob.dialogs, () => true);
    expect(await meanwhile(time, bob.cloud.deleteFromCloud(project, "原子是什么"))).toBe(false);
    expect(messagesOf(bob.notifications)).toContain(
      "云端的项目列表里没有“原子是什么”，可能已经删除，或者属于另一个账号。这台电脑上的那一份没有动。",
    );
    expect(platform.removals).toEqual([]);
    expect((await here.browser.links.get(project))?.project).toBe(project);
  });
});

describe("the copy in this browser of a project that was deleted", () => {
  /** A project whose repository cannot be used, which goes as it is: what is here is not sent. */
  async function unusableCopy(library?: MemoryLibrary) {
    const copy = await withCopy({ ...(library && { library }) });
    const { time, platform, project, repository } = copy;
    const unusable = { reason: "gone", since: 1, deleteAt: 1 + 7 * DAY, gone: "deleted" as const };
    platform.makeUnusable(project, unusable);
    repository.answer = { ...repository.answer, state: "paused", reason: "gone", unusable };
    await time.advance(500);
    expect(copy.here.cloud.session?.getSnapshot().problem).toEqual({
      kind: "unusable",
      reason: "gone",
    });
    return copy;
  }

  it("stays where it has changes that the platform does not have", async () => {
    const { time, platform, project, here } = await unusableCopy();
    // Made while the platform took no change of it: it is only here.
    here.session.store?.execute(write("code/only-here.js", "只在这里"));
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot().pending).toBe(1);

    const asked = answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    // Nothing could be archived: it went as it was, without being asked to sync first.
    expect(asked[0]).toMatchObject({
      message:
        "仓库已删除。平台上的这份和清单里的这一项会删掉，GitHub 那边什么都不动。这个浏览器里的那一份会清掉（还有没同步的改动、只在这里的素材时留下）。",
    });
    expect(platform.removals).toEqual([{ id: project, options: {} }]);
    expect(platform.projects.has(project)).toBe(false);
    // The copy stays, with what is only in it, as a project of this browser only.
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none", local: "browser" });
    expect(messagesOf(here.notifications).at(-1)).toBe(
      "已删除云端项目“原子是什么”。这个浏览器里的那一份留下了（还有没同步的改动、只在这里的素材，或者没保存的试改和代码），现在只在这个浏览器里，请移到文件夹或另存一份。",
    );
    // What only it had is there.
    await here.open(project);
    expect(here.session.store?.getState().files["code/only-here.js"]).toBe("只在这里");
  });

  it("stays where it has files of assets that nothing else has", async () => {
    const { time, platform, project, here } = await withCopy();
    const file = new Blob(["一段视频"]);
    const hash = await hashFile(file);
    await here.library.media(project).put(hash, file);
    here.session.store?.execute({
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
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });

    answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(platform.projects.has(project)).toBe(false);
    // Its file is only here: the copy stays, and so does the file.
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.library.media(project).get(hash)).toBeDefined();
    expect(await here.browser.links.get(project)).toBeUndefined();
  });

  it("stays where it cannot be read whether something is only in it", async () => {
    const library = new Unreadable();
    const { time, platform, project, here } = await unusableCopy(library);
    await here.cloud.close();
    await here.session.close();
    library.unreadable.add(project);

    answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(platform.projects.has(project)).toBe(false);
    library.unreadable.delete(project);
    expect(library.summaries.has(project)).toBe(true);
    expect(library.updates.get(project)?.length).toBeGreaterThan(0);
    expect(messagesOf(here.notifications).at(-1)).toContain("读不出它有没有只在这里的内容");
  });

  it("stays where another window has it open", async () => {
    const { time, platform, project, here } = await withCopy();
    here.world.others.set(project, 1);
    answering(here.dialogs, sayingYes());
    expect(await meanwhile(time, here.cloud.deleteFromCloud(project, "原子是什么"))).toBe(true);
    expect(platform.projects.has(project)).toBe(false);
    expect(here.library.summaries.has(project)).toBe(true);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(messagesOf(here.notifications).at(-1)).toContain("它在别的窗口还开着");
  });
});

describe("a project that was deleted elsewhere (SYNC_CLOSE.deleted)", () => {
  it("leaves the copy in this browser as one of this browser only, with everything in it, and says so once", async () => {
    const { time, platform, project, here } = await withCopy();
    // Changes that did not get there before it went.
    platform.faults.silent = true;
    platform.drop();
    here.session.store?.execute(write("code/late.js", "没来得及同步"));
    await time.advance(500);
    platform.faults.silent = false;
    // Deleted on another computer, which let go of what was not archived.
    expect(platform.remove("ada", project, { discard: true })).toBe("removed");
    await time.advance(40_000);
    expect(await here.browser.links.get(project)).toBeUndefined();
    expect(here.cloud.getSnapshot()).toEqual({ kind: "none", local: "browser" });
    // Nothing of it went: the copy, and its changes.
    expect(here.library.summaries.has(project)).toBe(true);
    expect(here.session.store?.getState().files["code/late.js"]).toBe("没来得及同步");
    expect(messagesOf(here.notifications)).toEqual([
      "“原子是什么”这个云端项目已经在别处删除。这个浏览器里的那一份留着，没有清掉，现在它只在这个浏览器里：浏览器清理数据时会丢，请移到文件夹、另存一份，或者连接到云端。",
    ]);
    // Opened again, it says nothing more, and makes nothing on the platform.
    await here.open(project);
    await time.advance(2000);
    expect(platform.projects.size).toBe(0);
  });
});

describe("a project whose repository cannot be used (SYNC_CLOSE.unusable)", () => {
  it("cannot sync, keeps what did not get there, says why and until when, and goes on once the repository can be used", async () => {
    const { time, platform, project, repository, here } = await withCopy();
    const unusable = { reason: "transferred", since: 5, deleteAt: 5 + 7 * DAY };
    platform.makeUnusable(project, unusable);
    repository.answer = {
      ...repository.answer,
      state: "paused",
      reason: "transferred",
      unusable,
    } as RepositoryStatus;
    await time.advance(500);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "unusable", reason: "transferred" },
    });
    // What the platform says of it, as it was asked again once syncing heard.
    expect(here.cloud.unusable).toEqual(unusable);
    // A change made before the workbench held the project: it stays here, and waits.
    here.session.store?.execute(write("code/kept.js", "留在本机"));
    await time.advance(2000);
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "paused", pending: 1 });
    expect(platform.workingCopy(project).getState().files["code/kept.js"]).toBeUndefined();

    // Still not: people hear why.
    expect((await here.cloud.recheck())?.unusable).toEqual(unusable);
    expect(messagesOf(here.notifications).at(-1)).toBe(
      "问过 GitHub 了，仓库还是用不了：仓库已转到别的账号。",
    );
    // Moved back: it can be edited again, and what waited goes.
    platform.makeUnusable(project, undefined);
    repository.recheckAnswer = { ...repository.answer, state: "ready" } as RepositoryStatus;
    delete (repository.recheckAnswer as { unusable?: unknown }).unusable;
    delete (repository.recheckAnswer as { reason?: unknown }).reason;
    await here.cloud.recheck();
    await time.advance(2000);
    expect(here.cloud.unusable).toBeUndefined();
    expect(here.cloud.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(project).getState().files["code/kept.js"]).toBe("留在本机");
    expect(messagesOf(here.notifications).at(-1)).toBe("仓库能用了，项目可以接着编辑。");
  });

  it("can still be read, without counting as opening it, for a copy as a project of this computer", async () => {
    const { time, platform, project, here } = await withCopy();
    platform.makeUnusable(project, { reason: "gone", since: 5 });
    await time.advance(500);
    // From another browser that has nothing of it: read only, nothing kept there.
    const other = await windowOf(platform, time);
    const signal = new AbortController().signal;
    const copied = await other.cloud.copySource(project, signal, () => ({
      get: async () => undefined,
    }));
    expect(copied?.store.getState().manifest.name).toBe("原子是什么");
    copied?.close();
    expect(await other.browser.links.list()).toEqual([]);
    expect(await other.library.list()).toEqual([]);
    // The copy of the window that has it open is what it has, with what only it has.
    here.session.store?.execute(write("code/only-here.js", "只在这里"));
    const mine = await here.cloud.copySource(project, signal, () => ({
      get: async () => undefined,
    }));
    expect(mine?.store.getState().files["code/only-here.js"]).toBe("只在这里");
    mine?.close();
    // ...and the project itself is as it was, connected as it was.
    expect((await here.browser.links.get(project))?.project).toBe(project);
  });
});
