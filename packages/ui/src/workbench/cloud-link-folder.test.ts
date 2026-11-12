/**
 * A project of the platform linked again with its folder, after the data of the browser was cleared:
 * the folder is a project of this computer then, and the project of the platform is only on the
 * list. Both may have changed. See the design of the start page of AnimaQuill Cloud, 4.2, and
 * `FolderAdopt` for what happens to the files, which is the real one here, with the workbench and a
 * platform in memory around it.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { account } from "../cloud/projects-support.ts";
import { FakeRepositories } from "../cloud/repository-support.ts";
import { LINKING_FILE } from "../folder/adopt.ts";
import { filesOf, recovered } from "../folder/folder-support.ts";
import type { DialogRequest, FormAnswer } from "./dialogs.ts";
import { FAST, folderOf, notices, written } from "./folder-windows.ts";
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

const FOLDER = "文档/下载";
const CODE = "code/动画.js";

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

/**
 * A browser of somebody who is signed in to the platform, on a computer with this disk: a new one
 * on the same disk is that browser after its data was cleared.
 */
function browserOn(
  platform: MemoryPlatform,
  {
    disk = new MemoryDisk(),
    repository,
  }: { disk?: MemoryDisk; repository?: FakeRepositories } = {},
) {
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  // How people organised their projects is the browser's, as every window shares it.
  const organizer = memoryOrganizer();
  const window = () => {
    const host: Host = {
      projects: library,
      address: memoryAddress(),
      windowMemory: memoryWindow(),
      organizer,
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
      cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20 },
    });
    opened.push(workbench);
    return workbench;
  };
  return { disk, library, links: cloud.links, trials, organizer, window };
}

/** Answers each question as `answer` says, by its kind, and keeps what was asked. */
function answering(workbench: Workbench, answer: (request: DialogRequest) => unknown) {
  const asked: DialogRequest[] = [];
  workbench.dialogs.subscribe(() => {
    const request = workbench.dialogs.getSnapshot();
    if (!request || request.kind === "progress" || asked.includes(request)) return;
    asked.push(request);
    void Promise.resolve()
      .then(() => answer(request))
      .then((value) => {
        if (workbench.dialogs.getSnapshot() === request) {
          workbench.dialogs.answer(value as never);
        }
      });
  });
  return asked;
}

const online = (workbench: Workbench) =>
  vi.waitFor(
    () =>
      expect(workbench.cloud?.session?.getSnapshot()).toMatchObject({
        state: "online",
        pending: 0,
      }),
    { timeout: 5000 },
  );

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });

/** Changes the project in another browser, until the platform has the changes. */
async function changeThere(
  platform: MemoryPlatform,
  project: string,
  there: Workbench,
  calls: readonly ReturnType<typeof write>[],
) {
  const head = platform.projects.get(project)?.head ?? 0;
  for (const call of calls) expect(there.session.store?.execute(call as never).ok).toBe(true);
  expect(await there.session.trySave()).toBe(true);
  // What goes together goes as one update.
  await vi.waitFor(() => expect(platform.projects.get(project)?.head).toBeGreaterThan(head));
  await online(there);
}

/** GitHub as the platform saves to it, archived right away. */
function repositoryOf(platform: MemoryPlatform, project: string): FakeRepositories {
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
    head: platform.projects.get(project)?.head ?? 1,
    archivedSeq: 0,
  };
  platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
  return repository;
}

/**
 * A project on the platform that a browser linked with a folder of this disk, and then lost all it
 * knew, as when its data is cleared: a new browser on the same disk. Another browser goes on having
 * the project open, which is how the platform changes meanwhile.
 */
async function linkedAndCleared() {
  const platform = new MemoryPlatform();
  const elsewhere = browserOn(platform, { disk: new MemoryDisk() });
  const there = elsewhere.window();
  expect(await there.session.create("片子")).toBe(true);
  there.session.store?.execute(write(CODE, "const a = 1;\n"));
  expect(await there.cloud?.beginLink()).toMatchObject({ isNew: true });
  await online(there);
  const project = (await elsewhere.links.get(there.session.key as string))?.project as string;
  const repository = repositoryOf(platform, project);

  const before = browserOn(platform, { repository });
  const first = before.window();
  before.disk.chooseNext(FOLDER);
  const linking = first.cloud?.linkFolder(project);
  answering(first, () => true);
  expect(await linking).toBe(true);
  await written(first);
  await first.cloud?.close();
  await first.projectFolders?.close();
  await first.session.close();

  // What the browser kept of the folder is gone, and the folder is as it was.
  const disk = new MemoryDisk();
  for (const path of filesOf(before.disk, FOLDER).keys()) {
    disk.write(`${FOLDER}/${path}`, before.disk.bytes(`${FOLDER}/${path}`), { quietly: true });
  }
  const cleared = browserOn(platform, { disk, repository });
  return { platform, project, there, repository, disk, cleared };
}

describe("a project of the platform linked again with its folder, once the browser forgot both", () => {
  it("links right away where the folder and the platform have the same, and syncs on", async () => {
    const { project, there, disk, cleared } = await linkedAndCleared();
    const before = filesOf(disk, FOLDER);
    const workbench = cleared.window();
    const asked = answering(workbench, () => true);
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(true);
    // Nothing to choose, and nothing kept: both were the same.
    expect(asked.filter(({ kind }) => kind === "reconcile")).toEqual([]);
    expect(notices(workbench).some((said) => said.startsWith("folder.adopt.doneSame"))).toBe(true);
    expect(folderOf(workbench)?.record.id).toBe(project);
    expect(filesOf(disk, FOLDER)).toEqual(before);
    await online(workbench);
    // Both ways.
    there.session.store?.execute(write(CODE, "const a = 2;\n"));
    await vi.waitFor(() => expect(filesOf(disk, FOLDER).get(CODE)).toBe("const a = 2;\n"));
    workbench.session.store?.execute(write("code/新的.js", "new\n"));
    await vi.waitFor(() =>
      expect(there.session.store?.getState().files["code/新的.js"]).toBe("new\n"),
    );
  });

  it(
    "has people choose file by file where both changed, archives first, and keeps what goes",
    { timeout: 30_000 },
    async () => {
      const { platform, project, there, repository, disk, cleared } = await linkedAndCleared();
      // Meanwhile the folder changed one file, and the platform another, and both the same one.
      await changeThere(platform, project, there, [
        write(CODE, "云端改的\n"),
        write("code/云端的.js", "只在云端\n"),
      ]);
      disk.write(`${FOLDER}/${CODE}`, "文件夹改的\n");
      disk.write(`${FOLDER}/code/文件夹的.js`, "只在文件夹\n");
      const folderBefore = filesOf(disk, FOLDER);
      // What GitHub has once the platform archived it.
      let archived: Map<string, string> | undefined;
      const archiveNow = repository.archiveNow.bind(repository);
      repository.archiveNow = (id, options) => {
        archived = there.session.store?.exportFiles().files;
        return archiveNow(id, options);
      };

      const workbench = cleared.window();
      const asked = answering(workbench, (request) => {
        if (request.kind !== "reconcile") return true;
        // The folder's files are newer than the platform's last change, and what only one side
        // has stays until people say otherwise.
        expect(new Map(request.items.map(({ path, value }) => [path, value]))).toEqual(
          new Map([
            [CODE, "here"],
            ["code/云端的.js", "cloud"],
            ["code/文件夹的.js", "here"],
          ]),
        );
        const answer: FormAnswer = {
          [CODE]: "here",
          "code/云端的.js": "cloud",
          "code/文件夹的.js": "cloud",
        };
        return answer;
      });
      disk.chooseNext(FOLDER);
      expect(await workbench.cloud?.linkFolder(project)).toBe(true);
      expect(asked.map(({ kind }) => kind)).toContain("reconcile");
      // The platform archived before anything of it was put in place of.
      expect(repository.calls).toContain(`archiveNow ${project}`);
      expect(archived?.get(CODE)).toBe("云端改的\n");

      await written(workbench);
      await online(workbench);
      const folderAfter = filesOf(disk, FOLDER);
      expect(folderAfter.get(CODE)).toBe("文件夹改的\n");
      expect(folderAfter.get("code/云端的.js")).toBe("只在云端\n");
      expect(folderAfter.has("code/文件夹的.js")).toBe(false);
      // What went from the folder is kept.
      expect(recovered(disk, FOLDER).get("code/文件夹的.js")).toEqual([
        folderBefore.get("code/文件夹的.js"),
      ]);
      // And the platform has what people chose.
      await vi.waitFor(() =>
        expect(there.session.store?.getState().files[CODE]).toBe("文件夹改的\n"),
      );
      expect(there.session.store?.getState().files["code/云端的.js"]).toBe("只在云端\n");
      expect(there.session.store?.getState().files["code/文件夹的.js"]).toBeUndefined();
    },
  );

  it("goes on only where people say so when the platform cannot archive first", async () => {
    const { project, there, repository, disk, cleared } = await linkedAndCleared();
    disk.write(`${FOLDER}/${CODE}`, "文件夹改的\n");
    repository.followsPlatform = false;
    repository.autoArchive = false;
    repository.refuse.archiveNow = new Error("GitHub is away");
    const folderBefore = filesOf(disk, FOLDER);

    // People cancel once they hear that it cannot be archived: nothing changes on either side.
    const workbench = cleared.window();
    const asked = answering(workbench, (request) =>
      request.kind === "reconcile"
        ? { [CODE]: "here" }
        : request.kind === "choice"
          ? undefined
          : true,
    );
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(false);
    const question = asked.find(({ kind }) => kind === "choice");
    expect(question).toMatchObject({ choices: [{ id: "discard" }] });
    expect((question as { message: string }).message).toMatch(/^cloud\.link\.notArchived/);
    expect(filesOf(disk, FOLDER)).toEqual(folderBefore);
    expect(there.session.store?.getState().files[CODE]).toBe("const a = 1;\n");
    expect(folderOf(workbench)).toBeUndefined();
  });

  it("refuses a folder with another project in it, and keeps nothing it brought for that", async () => {
    const { project, disk, cleared } = await linkedAndCleared();
    const manifest = JSON.parse(disk.text(`${FOLDER}/animaquill.json`));
    manifest.id = "another-project";
    manifest.name = "另一个";
    disk.write(`${FOLDER}/animaquill.json`, JSON.stringify(manifest, null, 2));
    const folderBefore = filesOf(disk, FOLDER);
    const workbench = cleared.window();
    const asked = answering(workbench, () => true);
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(false);
    expect(asked.find(({ kind }) => kind === "confirm")).toMatchObject({
      title: expect.stringMatching(/^folder\.adopt\.otherTitle/),
      noticeOnly: true,
    });
    expect(filesOf(disk, FOLDER)).toEqual(folderBefore);
    // It came into this browser only for this, and nothing of it is only here: it went again.
    await vi.waitFor(() => expect(cleared.library.summaries.has(project)).toBe(false));
    expect(await cleared.links.get(project)).toBeUndefined();
    expect(workbench.session.key).toBeUndefined();
  });

  it("keeps the copy it brought where something of it is only here once people cancel", async () => {
    const { platform, project, disk, cleared } = await linkedAndCleared();
    disk.write(`${FOLDER}/${CODE}`, "文件夹改的\n");
    const workbench = cleared.window();
    answering(workbench, (request) => {
      if (request.kind !== "reconcile") return true;
      // People change the copy meanwhile, and the platform does not get it.
      platform.faults.silent = true;
      platform.drop();
      workbench.session.store?.execute(write("code/这里改的.js", "只在这里\n"));
      return undefined;
    });
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(false);
    expect(cleared.library.summaries.has(project)).toBe(true);
    expect(workbench.session.key).toBe(project);
    expect(workbench.session.store?.getState().files["code/这里改的.js"]).toBe("只在这里\n");
  });

  it("changes nothing where people cancel, and keeps a copy that was here before", async () => {
    const { platform, project, there, disk, cleared } = await linkedAndCleared();
    await changeThere(platform, project, there, [write(CODE, "云端改的\n")]);
    disk.write(`${FOLDER}/${CODE}`, "文件夹改的\n");
    const folderBefore = filesOf(disk, FOLDER);
    const workbench = cleared.window();
    // The copy is in this browser already: opened before, without a folder.
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    await online(workbench);
    answering(workbench, (request) => (request.kind === "reconcile" ? undefined : true));
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(false);
    expect(filesOf(disk, FOLDER)).toEqual(folderBefore);
    expect(there.session.store?.getState().files[CODE]).toBe("云端改的\n");
    expect(cleared.library.summaries.has(project)).toBe(true);
    expect(workbench.session.key).toBe(project);
  });

  it("takes the place of the folder as a project of this computer only where nothing of it is left unsaved, and takes its star along", async () => {
    const { project, disk, cleared } = await linkedAndCleared();
    const workbench = cleared.window();
    // People opened the folder as a project of this computer, as after clearing the browser.
    disk.chooseNext(FOLDER);
    answering(workbench, () => true);
    await workbench.projectFolders?.open();
    await vi.waitFor(() => expect(folderOf(workbench)?.record).toBeDefined());
    const old = folderOf(workbench)?.record.id as string;
    expect(old).not.toBe(project);
    await workbench.closeProject();

    // A window left something it was trying out on it: that goes first.
    cleared.trials.kept.set(old, new Map([["place1", { tried: true }]]));
    const asked = answering(workbench, () => true);
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(false);
    expect(
      asked.some(
        (request) => "message" in request && request.message.startsWith("folder.adopt.leftBehind"),
      ),
    ).toBe(true);
    expect((await workbench.projectFolders?.projects.records.get(old))?.id).toBe(old);

    // Nothing left, and a star: it goes with the folder.
    cleared.trials.kept.delete(old);
    const starred = Date.now();
    await cleared.organizer.mark(old, {
      at: starred,
      starredAt: starred,
      starAt: starred,
      mine: true,
    });
    disk.chooseNext(FOLDER);
    expect(await workbench.cloud?.linkFolder(project)).toBe(true);
    expect(await workbench.projectFolders?.projects.records.get(old)).toBeUndefined();
    expect(folderOf(workbench)?.record.id).toBe(project);
    expect((await cleared.organizer.read()).marks.get(project)?.starredAt).toBe(starred);
  });

  it("asks what to do with a folder that linking left halfway, also as it opens as a project of this computer", async () => {
    const { project, disk, cleared } = await linkedAndCleared();
    const before = filesOf(disk, FOLDER);
    // Linking stopped halfway: one file is the platform's already, what it had is kept.
    const kept = ".animaquill/recovered/2026-11-12 10.00.00";
    disk.write(`${FOLDER}/${kept}/${CODE}`, before.get(CODE) as string);
    disk.write(`${FOLDER}/${CODE}`, "半截的\n");
    disk.write(`${FOLDER}/code/新来的.js`, "新来的\n");
    disk.write(
      `${FOLDER}/${LINKING_FILE}`,
      JSON.stringify({
        kept,
        files: [
          { path: CODE, existed: true },
          { path: "code/新来的.js", existed: false },
        ],
      }),
    );
    const workbench = cleared.window();
    // As a project of this computer: put back first, then it opens as it was.
    const asked = answering(workbench, (request) => (request.kind === "choice" ? "restore" : true));
    disk.chooseNext(FOLDER);
    await workbench.projectFolders?.open();
    expect(asked.find(({ kind }) => kind === "choice")).toMatchObject({
      title: expect.stringMatching(/^folder\.adopt\.unfinishedTitle/),
      choices: [{ id: "restore" }],
    });
    await vi.waitFor(() => expect(folderOf(workbench)?.record).toBeDefined());
    const now = filesOf(disk, FOLDER);
    expect(now.get(CODE)).toBe(before.get(CODE));
    expect(now.has("code/新来的.js")).toBe(false);
    expect(now.has(LINKING_FILE)).toBe(false);
    expect(workbench.session.store?.getState().files[CODE]).toBe(before.get(CODE));
    const record = folderOf(workbench)?.record;
    await workbench.closeProject();
    expect(project).toBeDefined();

    // The same for a folder this browser knows, as it opens again.
    disk.write(`${FOLDER}/${CODE}`, "又是半截的\n");
    disk.write(
      `${FOLDER}/${LINKING_FILE}`,
      JSON.stringify({ kept, files: [{ path: CODE, existed: true }] }),
    );
    const before2 = asked.length;
    await workbench.projectFolders?.openRecent(record!);
    expect(asked.slice(before2).some(({ kind }) => kind === "choice")).toBe(true);
    await vi.waitFor(() => expect(folderOf(workbench)?.record.id).toBe(record?.id));
    expect(filesOf(disk, FOLDER).get(CODE)).toBe(before.get(CODE));
    expect(filesOf(disk, FOLDER).has(LINKING_FILE)).toBe(false);
  });

  it("says what each side loses before people link, and marks what the platform takes only in part", async () => {
    const { project, disk, cleared } = await linkedAndCleared();
    const manifest = JSON.parse(disk.text(`${FOLDER}/animaquill.json`));
    disk.write(
      `${FOLDER}/animaquill.json`,
      JSON.stringify({ ...manifest, tags: [{ name: "草稿" }] }, null, 2),
    );
    disk.write(`${FOLDER}/${CODE}`, "文件夹改的\n");
    const workbench = cleared.window();
    const shown: { summary?: string; confirm?: string; notes: string[]; error?: string }[] = [];
    answering(workbench, (request) => {
      if (request.kind !== "reconcile") return request.kind === "choice" ? "discard" : true;
      const values = Object.fromEntries(request.items.map(({ path }) => [path, "here"]));
      const said = request.summarize?.(values);
      shown.push({
        ...(said && { summary: said.text, confirm: said.confirm }),
        notes: request.items.flatMap(({ path, note }) => (note ? [path] : [])),
        ...(request.error !== undefined && { error: request.error }),
      });
      return values;
    });
    disk.chooseNext(FOLDER);
    const linked = await workbench.cloud?.linkFolder(project);
    expect(linked).toBe(true);
    // Once with what each side loses; again with the file the platform takes only in part.
    expect(shown[0]).toMatchObject({
      summary: 'folder.adopt.summary {"cloud":2,"here":0}',
      confirm: 'folder.adopt.confirmReplacing {"count":2}',
      notes: [],
    });
    expect(shown[1]).toMatchObject({
      notes: ["animaquill.json"],
      error: 'folder.adopt.partlyAsk {"count":1}',
    });
    expect(shown).toHaveLength(2);
  });
});
