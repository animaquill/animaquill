/**
 * The assets of a project that is a folder, as people go about them in the workbench: bringing files
 * in, which go into the folder and never into the browser, using what is in the folder already,
 * and what happens when files change, move or go away outside.
 */
import { STORAGE, type ProjectStore } from "@animaquill/core";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, putProject } from "../folder/folder-support.ts";
import {
  answer,
  browserOf,
  closeWindows,
  folderOf,
  openAt,
  windowOf,
  written,
} from "./folder-windows.ts";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { projectKeyOf } from "./session.ts";
import type { Workbench } from "./workbench.ts";

vi.mock("@animaquill/media", async (original) => ({
  ...(await original<typeof import("@animaquill/media")>()),
  // What the browser would find out about these files.
  probeMedia: async (file: Blob) => {
    const name = file instanceof File ? file.name : "";
    if (name.endsWith(".txt")) return undefined;
    if (name.endsWith(".wav")) return { kind: "audio", duration: 1, sampleRate: 48_000 };
    return { kind: "video", duration: file.size, width: 16, height: 9 };
  },
}));

afterEach(closeWindows);

const ROOT = "文档/片子";

/** A new project in a folder, open in a window, with all of it in the folder. */
async function newFolderProject() {
  const browser = browserOf();
  browser.disk.folder(ROOT);
  const workbench = windowOf(browser);
  browser.disk.chooseNext(ROOT);
  const creating = workbench.newProject();
  await answer(workbench, "片子");
  await creating;
  await written(workbench);
  const store = workbench.session.store as ProjectStore;
  const key = folderOf(workbench)?.record.id as string;
  return { browser, disk: browser.disk, workbench, store, key };
}

const assetOf = (store: ProjectStore, id: string | undefined) =>
  id === undefined ? undefined : store.getState().assets?.[id];

const folderProblems = (workbench: Workbench) =>
  workbench.problems.getSnapshot().problems.filter(({ origin }) => origin === "folder.origin");

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a file people bring into a project folder", () => {
  it("is copied into its assets folder, and is in the project once all of it is there", async () => {
    const { disk, workbench, store, key, browser } = await newFolderProject();
    const file = new File(["红色的视频"], "红色.webm", { type: "video/webm" });
    const hash = await hashFile(file);
    let whileWriting: unknown;
    let shown: unknown;
    disk.onNext("createWritable", `${ROOT}/assets/红色.webm`, () => {
      shown = workbench.media.getCopying();
    });
    disk.onNext("written", `${ROOT}/assets/红色.webm`, () => {
      whileWriting = Object.keys(store.getState().assets ?? {});
    });
    const [id] = await workbench.media.importFiles([file]);
    expect(shown).toMatchObject({ name: "红色.webm", stage: "copying" });
    expect(whileWriting).toEqual([]);
    expect(workbench.media.getCopying()).toBeUndefined();
    expect(disk.text(`${ROOT}/assets/红色.webm`)).toBe("红色的视频");
    expect(assetOf(store, id)).toMatchObject({
      name: "红色.webm",
      path: "assets/红色.webm",
      storage: "local",
      hash,
      size: file.size,
    });
    // The browser has none of it: the project reads it from the folder.
    expect(await browser.library.media(key).get(hash)).toBeUndefined();
    expect(await (await workbench.projects.media(key).get(hash))?.text()).toBe("红色的视频");
    await vi.waitFor(() =>
      expect(JSON.parse(disk.text(`${ROOT}/assets.json`)).assets[id as string]).toMatchObject({
        path: "assets/红色.webm",
      }),
    );
  });

  it("is used where it is when it is in the folder already", async () => {
    const { disk, workbench, store } = await newFolderProject();
    disk.write(`${ROOT}/footage/采访.webm`, "采访的视频");
    const [id] = await workbench.importDropped(disk.drop(`${ROOT}/footage/采访.webm`));
    expect(assetOf(store, id)).toMatchObject({
      path: "footage/采访.webm",
      hash: await hashFile(new Blob([bytes("采访的视频")])),
    });
    expect(disk.has(`${ROOT}/assets`)).toBe(false);
    // Bringing it in again is the same asset.
    expect(await workbench.importDropped(disk.drop(`${ROOT}/footage/采访.webm`))).toEqual([id]);
  });

  it("comes from a dialog that starts in the project folder", async () => {
    const { disk, workbench, store } = await newFolderProject();
    disk.write(`${ROOT}/assets/在里面.webm`, "里面的");
    disk.write("下载/外面的.webm", "外面的");
    disk.chooseFilesNext(`${ROOT}/assets/在里面.webm`, "下载/外面的.webm");
    const ids = await workbench.pickFiles();
    expect(disk.filesStartedIn).toBe(ROOT);
    expect(ids.map((id) => assetOf(store, id)?.path)).toEqual([
      "assets/在里面.webm",
      "assets/外面的.webm",
    ]);
    expect(disk.text(`${ROOT}/assets/外面的.webm`)).toBe("外面的");
    disk.chooseFilesNext("cancel");
    expect(await workbench.pickFiles()).toEqual([]);
  });

  it("is not copied again when the project has it", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const [first] = await workbench.media.importFiles([new File(["同样的"], "一.webm")]);
    const [second] = await workbench.media.importFiles([new File(["同样的"], "二.webm")]);
    expect(second).toBe(first);
    expect(disk.has(`${ROOT}/assets/二.webm`)).toBe(false);
    expect(Object.keys(store.getState().assets ?? {})).toHaveLength(1);
  });

  it("takes the place of a file of the project that another one took the place of, which stays", async () => {
    const { disk, workbench, store, key } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    const hash = assetOf(store, id)?.hash as string;
    // Replaced outside by another file of the same size.
    disk.write(`${ROOT}/assets/红色.webm`, "蓝色的视频");
    expect(await workbench.media.importFiles([new File(["红色的视频"], "红色原片.webm")])).toEqual([
      id,
    ]);
    expect(assetOf(store, id)?.path).toBe("assets/红色原片.webm");
    expect(await (await workbench.projects.media(key).get(hash))?.text()).toBe("红色的视频");
    expect(disk.text(`${ROOT}/assets/红色.webm`)).toBe("蓝色的视频");
  });

  it("takes the place of such a file also when the project does not know its size", async () => {
    const { disk, workbench, store, key } = await newFolderProject();
    const hash = await hashFile(new Blob([bytes("红色的视频")]));
    // As another tool wrote it down, with a hash and no size.
    store.execute({
      type: "asset.add",
      params: {
        id: "asset_red",
        asset: {
          name: "红色.webm",
          kind: "video",
          path: "assets/红色.webm",
          storage: "local",
          hash,
        },
      },
    });
    disk.write(`${ROOT}/assets/红色.webm`, "别的内容，长短也不一样");
    expect(await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")])).toEqual([
      "asset_red",
    ]);
    expect(assetOf(store, "asset_red")?.path).toBe("assets/红色 (2).webm");
    expect(await (await workbench.projects.media(key).get(hash))?.text()).toBe("红色的视频");
    expect(disk.text(`${ROOT}/assets/红色.webm`)).toBe("别的内容，长短也不一样");
  });

  it("is copied when it is a file of a scene, a sound or code, which belongs to that", async () => {
    const { disk, workbench, store } = await newFolderProject();
    disk.write(`${ROOT}/scenes/片头/背景.webm`, "背景视频");
    const [id] = await workbench.importDropped(disk.drop(`${ROOT}/scenes/片头/背景.webm`));
    expect(assetOf(store, id)?.path).toBe("assets/背景.webm");
    expect(disk.text(`${ROOT}/assets/背景.webm`)).toBe("背景视频");
    expect(disk.text(`${ROOT}/scenes/片头/背景.webm`)).toBe("背景视频");
  });

  it("comes in under another name when another one of that name comes in at the same time", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const one = new File(["第一台机器拍的".repeat(50)], "clip.mp4");
    const two = new File(["第二台机器拍的".repeat(50)], "clip.mp4");
    const [first, second] = await Promise.all([
      workbench.media.importFiles([one]),
      workbench.media.importFiles([two]),
    ]);
    const paths = [...(first ?? []), ...(second ?? [])].map((id) => assetOf(store, id)?.path);
    expect(new Set(paths)).toEqual(new Set(["assets/clip.mp4", "assets/clip (2).mp4"]));
    expect(disk.names(`${ROOT}/assets`)).toHaveLength(2);
  });

  it("takes the place of a file of the project that went away", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["同样的"], "一.webm")]);
    disk.remove(`${ROOT}/assets/一.webm`);
    expect(await workbench.media.importFiles([new File(["同样的"], "二.webm")])).toEqual([id]);
    expect(assetOf(store, id)?.path).toBe("assets/二.webm");
  });

  it("is asked about first when it is large, as it takes as much room again", async () => {
    const { disk, workbench } = await newFolderProject();
    const large = new File(["很大"], "很大.webm");
    Object.defineProperty(large, "size", { value: 3 * 1024 ** 3 });
    const importing = workbench.media.importFiles([large]);
    const asked = await answer(workbench, false);
    expect(asked).toMatchObject({ title: expect.stringContaining("folder.copy.title") });
    expect(asked).toMatchObject({ message: expect.stringContaining("3.2 GB") });
    expect(await importing).toEqual([]);
    expect(disk.has(`${ROOT}/assets/很大.webm`)).toBe(false);
  });

  it("can be stopped while it is copied, which leaves nothing", async () => {
    const { disk, workbench, store } = await newFolderProject();
    disk.onNext("createWritable", `${ROOT}/assets/红色.webm`, () => {
      workbench.media.getCopying()?.stop();
    });
    expect(await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")])).toEqual([]);
    expect(disk.has(`${ROOT}/assets/红色.webm`)).toBe(false);
    expect(store.getState().assets ?? {}).toEqual({});
    expect(workbench.notifications.getSnapshot()).toEqual([]);
  });

  it("does not stay behind, nor go into another project, once its project closes", async () => {
    const { disk, workbench } = await newFolderProject();
    let closing: Promise<void> | undefined;
    disk.onNext("createWritable", `${ROOT}/assets/一.webm`, () => {
      closing = workbench.closeProject();
    });
    const ids = await workbench.media.importFiles([
      new File(["一"], "一.webm"),
      new File(["二"], "二.webm"),
    ]);
    await closing;
    expect(ids).toEqual([]);
    expect(disk.has(`${ROOT}/assets/一.webm`)).toBe(false);
    expect(disk.has(`${ROOT}/assets/二.webm`)).toBe(false);
    expect(workbench.media.getImporting()).toBe(0);
  });

  it("says why it did not get in", async () => {
    const { disk, workbench } = await newFolderProject();
    disk.failWrites(`${ROOT}/assets/红色.webm`, { name: "QuotaExceededError" });
    expect(await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")])).toEqual([]);
    expect(workbench.notifications.getSnapshot().map(({ message }) => message)).toEqual([
      expect.stringContaining("folder.copy.failed.full"),
    ]);
  });
});

describe("the files of the assets of a project folder", () => {
  it("are listed when one is missing, also where it is now, which people can take", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    disk.move(`${ROOT}/assets/红色.webm`, `${ROOT}/footage/红色.webm`);
    await vi.waitFor(() => expect(folderProblems(workbench)).toHaveLength(1), { timeout: 3000 });
    const [problem] = folderProblems(workbench);
    expect(problem).toMatchObject({
      severity: "warning",
      file: "assets/红色.webm",
      text: expect.stringContaining("folder.asset.moved"),
      action: { label: "folder.asset.usePlace" },
    });
    problem?.action?.run();
    await vi.waitFor(() => expect(assetOf(store, id)?.path).toBe("footage/红色.webm"));
    await vi.waitFor(() => expect(folderProblems(workbench)).toEqual([]), { timeout: 3000 });
  });

  it("are listed when one was replaced outside, and the new one is taken when people say", async () => {
    const { disk, workbench, store, key } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    disk.write(`${ROOT}/assets/红色.webm`, "换成了蓝色的视频");
    await vi.waitFor(() => expect(folderProblems(workbench)).toHaveLength(1), { timeout: 3000 });
    const [problem] = folderProblems(workbench);
    expect(problem).toMatchObject({
      severity: "warning",
      text: "folder.asset.changed",
      action: { label: "folder.asset.useNew" },
    });
    // Until then, what was the file is not there.
    const before = assetOf(store, id)?.hash as string;
    expect(await workbench.projects.media(key).get(before)).toBeUndefined();
    problem?.action?.run();
    const after = await hashFile(new Blob([bytes("换成了蓝色的视频")]));
    await vi.waitFor(() =>
      expect(assetOf(store, id)).toMatchObject({
        hash: after,
        size: bytes("换成了蓝色的视频").byteLength,
        info: { duration: String(bytes("换成了蓝色的视频").byteLength) },
      }),
    );
    await vi.waitFor(() => expect(folderProblems(workbench)).toEqual([]), { timeout: 3000 });
    expect(await (await workbench.projects.media(key).get(after))?.text()).toBe("换成了蓝色的视频");
  });

  it("are listed when one goes away, until it is back", async () => {
    const { disk, workbench } = await newFolderProject();
    await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    disk.remove(`${ROOT}/assets/红色.webm`);
    await vi.waitFor(() => expect(folderProblems(workbench)).toHaveLength(1), { timeout: 3000 });
    expect(folderProblems(workbench)[0]).toMatchObject({ text: "folder.asset.missing" });
    disk.write(`${ROOT}/assets/红色.webm`, "红色的视频");
    await vi.waitFor(() => expect(folderProblems(workbench)).toEqual([]), { timeout: 3000 });
  });

  it("can come from where an upload put them, and are missing once people keep them here only", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    const hash = assetOf(store, id)?.hash as string;
    disk.remove(`${ROOT}/assets/红色.webm`);
    await vi.waitFor(() => expect(folderProblems(workbench)).toHaveLength(1), { timeout: 3000 });
    expect(folderProblems(workbench)[0]).toMatchObject({ text: "folder.asset.missing" });
    // Only where the file is kept changes: that is enough to look again.
    const params = { asset: id, storage: "platform", hash, owner: "u-1" };
    expect(store.execute({ type: "asset.setStorage", params }, { origin: STORAGE }).ok).toBe(true);
    await vi.waitFor(
      () =>
        expect(folderProblems(workbench)[0]?.text).toBe(
          'folder.asset.elsewhere {"download":"storage.download.platform"}',
        ),
      { timeout: 3000 },
    );
    const here = { asset: id, storage: "local", hash };
    expect(store.execute({ type: "asset.setStorage", params: here }).ok).toBe(true);
    await vi.waitFor(
      () => expect(folderProblems(workbench)[0]?.text).toBe("folder.asset.missing"),
      { timeout: 3000 },
    );
  });

  it("are looked at again once the editor may get at the folder again", async () => {
    const { disk, workbench, store } = await newFolderProject();
    await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    await workbench.projectFolders?.assetsChecked();
    disk.forgetPermissions();
    store.execute({ type: "project.rename", params: { name: "没权限的时候" } });
    await vi.waitFor(() => expect(folderOf(workbench)?.snapshot.trouble).toBeDefined(), {
      timeout: 3000,
    });
    // Meanwhile, and the browser does not tell.
    disk.write(`${ROOT}/assets/红色.webm`, "换成了蓝色的视频", { quietly: true });
    disk.grant(ROOT);
    await vi.waitFor(() => expect(folderOf(workbench)?.snapshot.trouble).toBeUndefined(), {
      timeout: 3000,
    });
    await vi.waitFor(
      () =>
        expect(folderProblems(workbench)).toEqual([
          expect.objectContaining({ text: "folder.asset.changed" }),
        ]),
      { timeout: 3000 },
    );
  });

  it("are got again by whatever has them when they change on the disk", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const [id] = await workbench.media.importFiles([new File(["红色的视频"], "红色.webm")]);
    const hash = assetOf(store, id)?.hash as string;
    const again: string[] = [];
    workbench.media.onRestored((file) => void again.push(file));
    disk.touch(`${ROOT}/assets/红色.webm`);
    disk.tell("modified", `${ROOT}/assets/红色.webm`);
    await vi.waitFor(() => expect(again).toContain(hash), { timeout: 3000 });
    expect(folderProblems(workbench)).toEqual([]);
  });
});

/** The example project in a folder, with the file of one of its assets, as the project says. */
async function exampleWithFile() {
  const browser = browserOf();
  const files = fixture();
  const hash = await hashFile(new Blob([bytes("原始素材")]));
  const assets = JSON.parse(files.get("assets.json") as string);
  assets.assets["raw-footage"].hash = hash;
  assets.assets["raw-footage"].size = bytes("原始素材").byteLength;
  files.set("assets.json", JSON.stringify(assets, null, 2));
  putProject(browser.disk, files, "文档/原子");
  browser.disk.write("文档/原子/assets/raw.mov", "原始素材");
  return { browser, hash };
}

describe("reading the files of a project folder for their hashes", () => {
  it("says how far it is, and which files the preview waits for", async () => {
    const { browser, hash } = await exampleWithFile();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const hasher: Hasher = {
      file: async (file, options) => {
        await held;
        return hasherHere.file(file, options);
      },
      copy: (file) => hasherHere.copy(file),
    };
    const workbench = windowOf(browser, undefined, hasher);
    await openAt(browser, workbench, "文档/原子");
    const folders = workbench.projectFolders as NonNullable<Workbench["projectFolders"]>;
    const key = folderOf(workbench)?.record.id as string;
    await vi.waitFor(() =>
      expect(folders.getProgress()).toMatchObject({
        reading: [{ path: "assets/raw.mov" }],
        checked: { total: 7 },
      }),
    );
    const showing = workbench.projects.media(key).get(hash);
    await vi.waitFor(() => expect(folders.getProgress().waiting).toEqual(["assets/raw.mov"]));
    release();
    expect(await (await showing)?.text()).toBe("原始素材");
    await vi.waitFor(() => expect(folders.getProgress()).toEqual({ reading: [], waiting: [] }));
  });
});

describe("a project folder that opens", () => {
  it("lets go of empty files in its assets folder that no asset has, and only those", async () => {
    const { browser } = await exampleWithFile();
    browser.disk.write("文档/原子/assets/没写完.webm", "");
    browser.disk.write("文档/原子/footage/空的.webm", "");
    const workbench = windowOf(browser);
    await openAt(browser, workbench, "文档/原子");
    await vi.waitFor(() => expect(browser.disk.has("文档/原子/assets/没写完.webm")).toBe(false));
    expect(browser.disk.text("文档/原子/assets/raw.mov")).toBe("原始素材");
    expect(browser.disk.has("文档/原子/footage/空的.webm")).toBe(true);
  });
});

describe("a project folder that comes into this browser", () => {
  it("has its files read from the folder from the moment its project opens", async () => {
    const { browser, hash } = await exampleWithFile();
    const workbench = windowOf(browser);
    // What shows the project asks for files as soon as it is there.
    let early: Promise<string | undefined> | undefined;
    workbench.session.subscribe(() => {
      const { store } = workbench.session;
      if (!store || early) return;
      early = workbench.projects
        .media(projectKeyOf(store))
        .get(hash)
        .then((file) => file?.text());
    });
    await openAt(browser, workbench, "文档/原子");
    expect(await early).toBe("原始素材");
  });

  it("leaves the files of its assets where they are, and says which are not there", async () => {
    const { browser } = await exampleWithFile();
    const workbench = windowOf(browser);
    await openAt(browser, workbench, "文档/原子");
    const key = folderOf(workbench)?.record.id as string;
    const store = workbench.session.store as ProjectStore;
    const media = await browser.library.media(key);
    for (const asset of Object.values(store.getState().assets ?? {})) {
      if (asset.hash) expect(await media.get(asset.hash)).toBeUndefined();
    }
    await workbench.projectFolders?.assetsChecked();
    const problems = folderProblems(workbench);
    const listed = new Map(problems.map(({ file, text }) => [file, text]));
    // raw.mov is there. Of what is not, a file only here, or one that nothing could check where it
    // would come from (an address alone), is missing.
    expect(listed.has("assets/raw.mov")).toBe(false);
    for (const path of ["assets/fonts/sans.woff2", "assets/logo.svg", "assets/loop.wav"]) {
      expect(listed.get(path), path).toBe("folder.asset.missing");
    }
    // What can come from where it is kept is no file of its own on the list: all of it is one line.
    for (const path of ["assets/interview.mp4", "assets/voice/zh.flac", "assets/voice/en.flac"]) {
      expect(listed.has(path), path).toBe(false);
    }
    expect(problems.filter(({ file }) => file === undefined).map(({ text }) => text)).toEqual([
      'folder.asset.elsewhereMany {"count":3}',
    ]);
    // It reads the one that is there from the folder.
    const hash = store.getState().assets?.["raw-footage"]?.hash as string;
    expect(await (await workbench.projects.media(key).get(hash))?.text()).toBe("原始素材");
  });
});

describe("a project folder taken off the list", () => {
  it("takes what the browser made of its files along, as the browser has nothing else of it", async () => {
    const { workbench, browser, key } = await newFolderProject();
    await workbench.projects.media(key).put("sound-1:abc", new Blob(["做出来的声音"]));
    expect(await browser.library.media(key).get("sound-1:abc")).toBeDefined();
    const record = folderOf(workbench)?.record;
    await workbench.closeProject();
    const removing = workbench.projectFolders?.remove(record as never);
    await answer(workbench, true);
    expect(await removing).toBe(true);
    expect(await browser.library.media(key).get("sound-1:abc")).toBeUndefined();
  });
});
