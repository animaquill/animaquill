/**
 * Linking a copy of a project of the platform with a folder that has the same project in it: people
 * choose file by file, and nothing else changes on either side. Whatever stops it leaves the folder
 * and the project as they were, and what the folder had of a file that goes is kept first.
 */
import { ProjectStore, readFolder, type ReadOnlyFolder } from "@animaquill/core";
import type { FolderRecord, LocalFolder, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { MANIFEST_FILE } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  allOneSide,
  defaultChoices,
  type ReconcileChoices,
  type ReconcileSide,
} from "../cloud/reconcile.ts";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { FolderAdopt, type AdoptPlan, type AdoptResult } from "./adopt.ts";
import {
  CODE,
  MAIN,
  NOTES,
  PROJECT,
  clipIn,
  editOnDisk,
  filesOf,
  fixture,
  putProject,
  recovered,
  renameClip,
  run,
} from "./folder-support.ts";
import { loadProject, type LoadedProject } from "./move.ts";

const t = ((key: string) => key) as never;
const KEY = "云端1";
const SCENE = "scenes/title/index.html";
const NEW_CODE = "code/新的.js";
const ONLY_CLOUD = "code/云端的.js";
/** When the platform last changed the project, against which a file here is newer or not. */
const UPDATED_AT = 1_000;

const bytes = (text: string) => new TextEncoder().encode(text);

interface Setup {
  readonly disk: MemoryDisk;
  readonly folders: LocalFolders;
  readonly library: MemoryLibrary;
  readonly adopt: FolderAdopt;
  readonly copy: LoadedProject;
  readonly folder: LocalFolder;
}

function readOnly(files: ReadonlyMap<string, string>): ReadOnlyFolder {
  return {
    async *list() {
      yield* files.keys();
    },
    file: async (path) => new Blob([files.get(path) as string]),
  };
}

/** The copy of the project of the platform in this browser, and the same project in a folder. */
async function setup(
  { adopt: options = {} } = {} as {
    adopt?: Partial<ConstructorParameters<typeof FolderAdopt>[0]>;
  },
): Promise<Setup> {
  const disk = new MemoryDisk();
  const folders = memoryFolders(disk);
  const library = new MemoryLibrary();
  const files = fixture();
  const { project, sources } = await readFolder(readOnly(files));
  const store = ProjectStore.create(project, sources);
  await library.create({ id: KEY, name: project.manifest.name }, store.encodeState());
  store.destroy();
  putProject(disk, files);
  disk.chooseNext(PROJECT);
  const folder = (await folders.choose()) as LocalFolder;
  const copy = (await loadProject(library, KEY)) as LoadedProject;
  const adopt = new FolderAdopt({ folders, projects: library, t, now: () => 5_000, ...options });
  return { disk, folders, library, adopt, copy, folder };
}

async function planOf({ adopt, copy, folder }: Setup): Promise<AdoptPlan> {
  const look = await adopt.look(KEY, copy.store, folder, { updatedAt: UPDATED_AT });
  if (look.kind !== "plan") throw new Error(`Not a plan: ${look.kind}`);
  return look.plan;
}

function runIt(
  { adopt, copy, library }: Setup,
  plan: AdoptPlan,
  choices: ReconcileChoices,
  options: { signal?: AbortSignal; replacing?: FolderRecord } = {},
): Promise<AdoptResult> {
  return adopt.run(plan, choices, copy.store, library.media(KEY), {
    saved: copy.saved,
    ...options,
  });
}

/** The project files of the folder, without what belongs to tools. */
function projectFilesOn(disk: MemoryDisk): Map<string, string> {
  return new Map(
    [...filesOf(disk)].filter(([path]) => !path.startsWith(".animaquill/") && path !== "AGENTS.md"),
  );
}

const exported = (store: ProjectStore) => store.exportFiles().files;

/** The project in the folder, as files the way the editor writes them. */
const projectOn = async ({ adopt, folder }: Setup) => (await adopt.read(folder)).files;

/** A file of code on the disk, as another program writes it. */
const writeOnDisk = (disk: MemoryDisk, path: string, text: string) =>
  disk.write(`${PROJECT}/${path}`, text);

/**
 * Both sides change: the folder its code, a clip, and a new file; the platform its code too, the
 * scene, and a file of its own. The folder's changes are newer than the platform's.
 */
function changeBoth({ disk, copy }: Setup): void {
  run(copy.store, "file.write", { path: CODE, text: "export const 云端 = 1;\n" });
  run(copy.store, "file.write", { path: SCENE, text: "<p>云端的标题</p>\n" });
  run(copy.store, "file.write", { path: ONLY_CLOUD, text: "export const 只在云端 = 1;\n" });
  writeOnDisk(disk, CODE, "export const 文件夹 = 1;\n");
  writeOnDisk(disk, NEW_CODE, "export const 新 = 1;\n");
  editOnDisk(disk, MAIN, (document) => {
    clipIn(document, "clip_title").name = "文件夹里改的名字";
  });
}

describe("FolderAdopt", () => {
  it("links right away where both sides are the same, and changes neither", async () => {
    const world = await setup();
    const before = projectFilesOn(world.disk);
    const cloud = exported(world.copy.store);
    const plan = await planOf(world);
    expect(plan.differences).toEqual([]);
    const result = await runIt(world, plan, new Map());
    expect(result.kind).toBe("adopted");
    expect(projectFilesOn(world.disk)).toEqual(before);
    expect(exported(world.copy.store)).toEqual(cloud);
    // Nothing was kept, as nothing went.
    expect(recovered(world.disk).size).toBe(0);
    const record = await world.folders.records.get(KEY);
    expect(record?.project).toBe(world.copy.store.getState().manifest.id);
    // What the editor knows the files by is what the folder has.
    const bases = new Map(
      (await world.folders.bases.load(KEY)).map(({ path, base }) => [path, base]),
    );
    expect(bases.get(MAIN)).toBe(world.disk.text(`${PROJECT}/${MAIN}`));
    expect((await world.library.list()).find(({ id }) => id === KEY)?.folder).toBe(true);
  });

  it("refuses a folder with another project in it", async () => {
    const world = await setup();
    editOnDisk(world.disk, MANIFEST_FILE, (manifest) => {
      manifest.id = "another-project";
      manifest.name = "另一个";
    });
    const look = await world.adopt.look(KEY, world.copy.store, world.folder);
    expect(look).toEqual({ kind: "other", name: "另一个" });
  });

  it("lists every file that differs, with the newer side chosen until people say", async () => {
    const world = await setup({ adopt: { now: () => 5_000 } });
    changeBoth(world);
    const plan = await planOf(world);
    const kinds = Object.fromEntries(plan.differences.map(({ path, kind }) => [path, kind]));
    expect(kinds).toEqual({
      [CODE]: "both",
      [MAIN]: "both",
      [NEW_CODE]: "here",
      [ONLY_CLOUD]: "cloud",
      [SCENE]: "both",
    });
    // The folder's files were written after the platform last changed the project.
    expect(plan.differences.find(({ path }) => path === CODE)?.newer).toBe("here");
    const choices = defaultChoices(plan.differences);
    expect(choices.get(CODE)).toBe("here");
    expect(choices.get(NEW_CODE)).toBe("here");
    expect(choices.get(ONLY_CLOUD)).toBe("cloud");
  });

  it("makes every file on both sides what people chose for it", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    const choices = new Map<string, ReconcileSide>([
      [CODE, "here"],
      [SCENE, "cloud"],
      [MAIN, "here"],
      [NEW_CODE, "cloud"],
      [ONLY_CLOUD, "here"],
    ]);
    const result = await runIt(world, plan, choices);
    expect(result.kind).toBe("adopted");
    const folderAfter = await projectOn(world);
    const cloudAfter = exported(world.copy.store);
    expect(projectFilesOn(world.disk).get(CODE)).toBe(folderBefore.get(CODE));
    expect(cloudAfter.get(CODE)).toBe(folderBefore.get(CODE));
    expect(folderAfter.get(SCENE)).toBe(cloudBefore.get(SCENE));
    expect(cloudAfter.get(SCENE)).toBe(cloudBefore.get(SCENE));
    // Chosen as the platform has it: the new file of the folder goes, and so does the platform's own.
    expect(folderAfter.has(NEW_CODE)).toBe(false);
    expect(cloudAfter.has(NEW_CODE)).toBe(false);
    expect(folderAfter.has(ONLY_CLOUD)).toBe(false);
    expect(cloudAfter.has(ONLY_CLOUD)).toBe(false);
    expect(clipIn(JSON.parse(cloudAfter.get(MAIN) as string), "clip_title").name).toBe(
      "文件夹里改的名字",
    );
    // Both sides are one project now, file by file.
    // Both sides are one project now, file by file.
    expect(folderAfter).toEqual(cloudAfter);
    // What the project took in is in its log, as one batch.
    const reopened = (await loadProject(world.library, KEY)) as LoadedProject;
    expect(exported(reopened.store)).toEqual(cloudAfter);
    reopened.close();
  });

  it("keeps what the folder had of every file that goes, as it was, before writing over it", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const plan = await planOf(world);
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result.kind).toBe("adopted");
    if (result.kind !== "adopted") return;
    expect(result.kept).toMatch(/^\.animaquill\/recovered\//);
    const kept = recovered(world.disk);
    expect(kept.get(CODE)).toEqual([folderBefore.get(CODE)]);
    expect(kept.get(MAIN)).toEqual([folderBefore.get(MAIN)]);
    expect(kept.get(NEW_CODE)).toEqual([folderBefore.get(NEW_CODE)]);
    // Nothing of the folder changed that the platform had the same way.
    expect(kept.has(NOTES)).toBe(false);
    expect(await projectOn(world)).toEqual(exported(world.copy.store));
  });

  it("writes nothing where what the folder had cannot be kept", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    const write = world.folder.write.bind(world.folder);
    world.folder.write = async (path, content, options) => {
      if (path.startsWith(".animaquill/recovered/")) throw new Error("No room");
      return write(path, content, options);
    };
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result).toMatchObject({ kind: "stopped", stage: "keeping", restored: true });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
    expect(await world.folders.records.get(KEY)).toBeUndefined();
  });

  it("writes nothing where what was kept does not read back as it was", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const plan = await planOf(world);
    // What lands in the kept file is not what was read, as on a disk that goes bad.
    const read = world.folder.read.bind(world.folder);
    world.folder.read = async (path) => {
      const content = await read(path);
      if (path.startsWith(".animaquill/recovered/")) content[0] = (content[0] ?? 0) ^ 1;
      return content;
    };
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result).toMatchObject({ kind: "stopped", stage: "keeping" });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
  });

  it("puts the folder back, and leaves the project, where writing stops halfway", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    // The timeline and the scene are written by then, and the code fails.
    world.disk.failWrites(`${PROJECT}/${CODE}`);
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result).toMatchObject({ kind: "stopped", stage: "writing", restored: true });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
    expect(await world.folders.records.get(KEY)).toBeUndefined();
    // What was kept stays.
    expect(recovered(world.disk).get(CODE)).toEqual([folderBefore.get(CODE)]);
  });

  it("puts the folder back where people stop it", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    const stopping = new AbortController();
    world.disk.onNext("written", `${PROJECT}/${CODE}`, () => stopping.abort());
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"), {
      signal: stopping.signal,
    });
    expect(result).toMatchObject({ kind: "stopped", cancelled: true, restored: true });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
  });

  it("puts both sides back where the folder cannot be kept as the project", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    const put = world.folders.records.put.bind(world.folders.records);
    world.folders.records.put = async (record) => {
      if (record.id === KEY) throw new Error("No room");
      return put(record);
    };
    const result = await runIt(world, plan, defaultChoices(plan.differences));
    expect(result).toMatchObject({
      kind: "stopped",
      stage: "linking",
      restored: true,
      cloudBack: true,
    });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
  });

  it.each([1, 2, 3, 4, "linking"] as const)(
    "where the page goes away (%s), both sides can be linked again with the same choices",
    async (stopAt) => {
      const world = await setup();
      changeBoth(world);
      const folderBefore = projectFilesOn(world.disk);
      const plan = await planOf(world);
      const choices = new Map<string, ReconcileSide>([
        [CODE, "here"],
        [SCENE, "cloud"],
        [MAIN, "cloud"],
        [NEW_CODE, "cloud"],
        [ONLY_CLOUD, "cloud"],
      ]);
      const chosen = new Map(
        [...choices].map(([path, side]) => [
          path,
          side === "here" ? plan.here.files.get(path) : plan.cloud.get(path),
        ]),
      );
      // The page goes away right before a file is written or goes, or before the record that links
      // them: one goes, and three are written.
      let stopped: () => void = () => {};
      const gone = new Promise<void>((resolve) => (stopped = resolve));
      const never = () => {
        stopped();
        return new Promise<never>(() => {});
      };
      let writes = 0;
      const write = world.folder.write.bind(world.folder);
      const isLast = (path: string) =>
        !path.startsWith(".animaquill/") && stopAt !== "linking" && ++writes === stopAt;
      world.folder.write = (path, content, options) =>
        isLast(path) ? never() : write(path, content, options);
      const remove = world.folder.remove.bind(world.folder);
      world.folder.remove = (path, options) => (isLast(path) ? never() : remove(path, options));
      if (stopAt === "linking") world.folders.records.put = never;
      void runIt(world, plan, choices);
      await gone;
      await world.copy.saved();
      world.disk.crash();

      // A new page: what the log has, and the folder as it is.
      const folders = memoryFolders(world.disk);
      world.disk.chooseNext(PROJECT);
      const folder = (await folders.choose()) as LocalFolder;
      const copy = (await loadProject(world.library, KEY)) as LoadedProject;
      const adopt = new FolderAdopt({ folders, projects: world.library, t });
      const again = await adopt.look(KEY, copy.store, folder, { updatedAt: UPDATED_AT });
      if (again.kind !== "plan") throw new Error(again.kind);
      // Nothing that people did not choose for differs now, and what was done is done.
      for (const { path } of again.plan.differences) expect(choices.has(path)).toBe(true);
      const result = await adopt.run(
        again.plan,
        new Map(
          again.plan.differences.map(({ path }) => [path, choices.get(path) as ReconcileSide]),
        ),
        copy.store,
        world.library.media(KEY),
        { saved: copy.saved },
      );
      expect(result.kind).toBe("adopted");
      const cloud = exported(copy.store);
      expect((await adopt.read(folder)).files).toEqual(cloud);
      for (const [path, text] of chosen) expect(cloud.get(path)).toBe(text);
      // What went of the folder is kept, the first time or the second.
      const kept = recovered(world.disk);
      for (const path of [SCENE, NEW_CODE]) {
        expect(kept.get(path)?.[0]).toBe(folderBefore.get(path));
      }
      copy.close();
    },
  );

  it("changes neither side where a file has no choice", async () => {
    const world = await setup();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const plan = await planOf(world);
    const choices = allOneSide(plan.differences, "cloud");
    choices.delete(SCENE);
    const result = await runIt(world, plan, choices);
    expect(result).toMatchObject({ kind: "refused", reason: "unsettled" });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
    expect(recovered(world.disk).size).toBe(0);
  });

  it("looks again where the folder changed after people chose", async () => {
    const world = await setup();
    changeBoth(world);
    const plan = await planOf(world);
    writeOnDisk(world.disk, NOTES, '{"notes": []}\n');
    const folderBefore = projectFilesOn(world.disk);
    const cloudBefore = exported(world.copy.store);
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result.kind).toBe("changed");
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
    expect(exported(world.copy.store)).toEqual(cloudBefore);
  });

  it("looks again where the project changed after people chose", async () => {
    const world = await setup();
    changeBoth(world);
    const plan = await planOf(world);
    renameClip(world.copy.store, "clip_logo", "别处刚改的");
    const folderBefore = projectFilesOn(world.disk);
    const result = await runIt(world, plan, allOneSide(plan.differences, "here"));
    expect(result.kind).toBe("changed");
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
  });

  it("refuses choices that do not go together, and changes nothing", async () => {
    const world = await setup();
    // Only here: a scene of its own, which the timeline of the folder uses.
    const sceneJson = world.disk.text(`${PROJECT}/scenes/title/scene.json`);
    writeOnDisk(world.disk, "scenes/其他/scene.json", sceneJson);
    writeOnDisk(world.disk, "scenes/其他/index.html", "<p>其他</p>\n");
    editOnDisk(world.disk, MAIN, (document) => {
      clipIn(document, "clip_title").source = { kind: "scene", scene: "其他" };
    });
    const folderBefore = projectFilesOn(world.disk);
    const plan = await planOf(world);
    const choices = allOneSide(plan.differences, "cloud");
    choices.set(MAIN, "here");
    expect("problems" in world.adopt.settle(plan, world.copy.store, choices)).toBe(true);
    const result = await runIt(world, plan, choices);
    expect(result).toMatchObject({ kind: "refused", reason: "unsettled" });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
  });

  it("brings the files of assets that the folder lacks from the browser, and never writes over one", async () => {
    const world = await setup();
    const { copy, disk, library } = world;
    const picture = new Blob([bytes("图片")]);
    const other = new Blob([bytes("别的图片")]);
    const lost = new Blob([bytes("哪里都没有")]);
    const add = async (id: string, path: string, file: Blob) => {
      const hash = await hashFile(file);
      run(copy.store, "asset.add", {
        id,
        asset: { kind: "image", storage: "local", path, hash, size: file.size, name: path },
      });
      return hash;
    };
    await library.media(KEY).put(await add("asset_picture", "images/图.png", picture), picture);
    await add("asset_other", "images/别.png", other);
    await add("asset_lost", "images/没.png", lost);
    // The folder has another file where the platform's second one is.
    disk.write(`${PROJECT}/images/别.png`, bytes("文件夹里的另一张"));
    const plan = await planOf(world);
    const result = await runIt(world, plan, allOneSide(plan.differences, "cloud"));
    expect(result).toMatchObject({
      kind: "adopted",
      missing: ["images/没.png"],
      changedAssets: ["images/别.png"],
    });
    expect(disk.text(`${PROJECT}/images/图.png`)).toBe("图片");
    expect(disk.text(`${PROJECT}/images/别.png`)).toBe("文件夹里的另一张");
  });

  it("takes the place of what this browser kept of the folder as a project of this computer", async () => {
    const world = await setup();
    const { folders, library, folder } = world;
    const old: FolderRecord = {
      id: "本机旧",
      folder,
      project: world.copy.store.getState().manifest.id,
      name: "旧的",
      openedAt: 1,
    };
    await folders.records.put(old);
    await library.create(
      { id: old.id, name: "旧的", folder: true },
      world.copy.store.encodeState(),
    );
    changeBoth(world);
    const plan = await planOf(world);
    const result = await runIt(world, plan, defaultChoices(plan.differences), { replacing: old });
    expect(result.kind).toBe("adopted");
    expect(await folders.records.get(old.id)).toBeUndefined();
    expect((await library.list()).some(({ id }) => id === old.id)).toBe(false);
    expect((await folders.records.find(folder))?.id).toBe(KEY);
  });

  it("does nothing while another window writes the folder", async () => {
    const world = await setup();
    const { folders, folder } = world;
    const old: FolderRecord = {
      id: "本机旧",
      folder,
      project: world.copy.store.getState().manifest.id,
      name: "旧的",
      openedAt: 1,
    };
    const held = await folders.writer(old.id).claim();
    changeBoth(world);
    const folderBefore = projectFilesOn(world.disk);
    const plan = await planOf(world);
    const result = await runIt(world, plan, defaultChoices(plan.differences), { replacing: old });
    held.release();
    expect(result).toEqual({ kind: "refused", reason: "busy" });
    expect(projectFilesOn(world.disk)).toEqual(folderBefore);
  });
});
