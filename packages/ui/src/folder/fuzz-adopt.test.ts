/**
 * Linking a folder with a copy of a project of the platform where both changed at random, people
 * choose at random, and something goes wrong at random: each file ends up as the side people chose
 * for it, on both sides, and the other side of it can be found again, in what was kept of the
 * folder or in what the platform archived before. Where it stops, both sides are as they were.
 */
import { ProjectStore, readFolder, type ReadOnlyFolder } from "@animaquill/core";
import type { LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { describe, expect, it } from "vitest";
import { randomFrom } from "../../../core/src/fuzz-support.ts";
import { isSettled, sidesOf, type ReconcileSide } from "../cloud/reconcile.ts";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { FolderAdopt } from "./adopt.ts";
import {
  CODE,
  MAIN,
  PROJECT,
  clipIn,
  editOnDisk,
  filesOf,
  fixture,
  putProject,
  renameClip,
  run,
} from "./folder-support.ts";
import { loadProject, type LoadedProject } from "./move.ts";

const t = ((key: string) => key) as never;
const KEY = "云端1";
const CODES = [CODE, "code/甲.js", "code/乙.js", "code/丙.js"];
const CLIPS = ["clip_title", "clip_logo", "clip_card"];
const FAULTS = ["none", "none", "keep", "write", "link", "cancel"] as const;

const readOnly = (files: ReadonlyMap<string, string>): ReadOnlyFolder => ({
  async *list() {
    yield* files.keys();
  },
  file: async (path) => new Blob([files.get(path) as string]),
});

/** Every file of the folder, with what belongs to tools, byte for byte as text. */
const everything = (disk: MemoryDisk) => filesOf(disk);

async function fuzzAdopt(seed: number): Promise<void> {
  const random = randomFrom(seed);
  const context = `seed ${seed}`;
  const disk = new MemoryDisk();
  const folders = memoryFolders(disk);
  const library = new MemoryLibrary();
  const files = fixture();
  const { project, sources } = await readFolder(readOnly(files));
  const made = ProjectStore.create(project, sources);
  await library.create({ id: KEY, name: project.manifest.name }, made.encodeState());
  made.destroy();
  putProject(disk, files);
  disk.chooseNext(PROJECT);
  const folder = (await folders.choose()) as LocalFolder;
  const copy = (await loadProject(library, KEY)) as LoadedProject;
  const adopt = new FolderAdopt({ folders, projects: library, t });
  const { store } = copy;

  // Both sides change, each its own way.
  for (let step = random.int(8); step >= 0; step--) {
    const path = random.pick(CODES) as string;
    const text = `export const 第${seed}_${step} = ${random.int(100)};\n`;
    switch (random.int(6)) {
      case 0:
        run(store, "file.write", { path, text });
        break;
      case 1:
        if (store.getState().files[path] !== undefined) run(store, "file.remove", { path });
        break;
      case 2:
        renameClip(store, random.pick(CLIPS) as string, `云端${step}`);
        break;
      case 3:
        disk.write(`${PROJECT}/${path}`, text);
        break;
      case 4:
        if (disk.has(`${PROJECT}/${path}`)) disk.remove(`${PROJECT}/${path}`);
        break;
      default:
        editOnDisk(disk, MAIN, (document) => {
          clipIn(document, random.pick(CLIPS) as string).name = `文件夹${step}`;
        });
    }
  }
  const look = await adopt.look(KEY, store, folder, { updatedAt: Date.UTC(2026, 10, 8) });
  expect(look.kind, context).toBe("plan");
  if (look.kind !== "plan") return;
  const { plan } = look;
  const choices = new Map<string, ReconcileSide>(
    plan.differences.map((difference) => [
      difference.path,
      random.pick(sidesOf(difference)) as ReconcileSide,
    ]),
  );
  // Choices that cannot go together are refused, and only those.
  const isFine = isSettled(adopt.settle(plan, store, choices));
  // What the platform archives right before: the project as the platform has it then.
  const archived = store.exportFiles().files;
  const folderBefore = everything(disk);

  const fault = random.pick(FAULTS) as (typeof FAULTS)[number];
  const stopping = new AbortController();
  const changing = plan.differences.filter(({ path }) => choices.get(path) === "cloud");
  const target = random.pick(changing)?.path;
  if (fault === "keep") {
    const write = folder.write.bind(folder);
    folder.write = (path, content, options) =>
      path.startsWith(".animaquill/recovered/")
        ? Promise.reject(new Error("No room"))
        : write(path, content, options);
  } else if (fault === "write" && target !== undefined) {
    disk.failWrites(`${PROJECT}/${target}`);
  } else if (fault === "cancel" && target !== undefined) {
    disk.onNext("removeEntry", `${PROJECT}/${target}`, () => stopping.abort());
    disk.onNext("written", `${PROJECT}/${target}`, () => stopping.abort());
  } else if (fault === "link") {
    folders.records.put = () => Promise.reject(new Error("No room"));
  }
  const result = await adopt.run(plan, choices, store, library.media(KEY), {
    saved: copy.saved,
    signal: stopping.signal,
  });

  const cloudAfter = store.exportFiles().files;
  if (fault === "none" && isFine) expect(result.kind, context).toBe("adopted");
  if (result.kind !== "adopted") {
    // Nothing changed, apart from what was kept of the folder.
    expect(result.kind, context).toBe(isFine ? "stopped" : "refused");
    if (result.kind === "stopped") {
      expect(result.restored, context).toBe(true);
      expect(result.cloudBack, context).toBe(true);
    }
    const now = everything(disk);
    for (const [path, text] of folderBefore) expect(now.get(path), `${context} ${path}`).toBe(text);
    for (const path of now.keys()) {
      if (!folderBefore.has(path)) expect(path, context).toMatch(/^\.animaquill\//);
    }
    expect(cloudAfter, context).toEqual(archived);
    expect(await folders.records.get(KEY), context).toBeUndefined();
    copy.close();
    return;
  }

  // Each file is the side chosen for it, on both sides.
  const folderAfter = (await adopt.read(folder)).files;
  expect(folderAfter, context).toEqual(cloudAfter);
  for (const { path } of plan.differences) {
    const side = choices.get(path);
    const chosen = side === "here" ? plan.here.files.get(path) : plan.cloud.get(path);
    expect(cloudAfter.get(path), `${context} ${path}`).toBe(chosen);
    // What the other side had can be found again.
    if (side === "cloud") {
      const raw = plan.here.found.get(path);
      if (raw && result.kept !== undefined) {
        const kept = disk.text(`${PROJECT}/${result.kept}/${path}`);
        expect(kept, `${context} ${path}`).toBe(new TextDecoder().decode(raw.content));
      } else expect(raw, `${context} ${path}`).toBeUndefined();
    } else if (plan.cloud.has(path)) {
      expect(archived.get(path), `${context} ${path}`).toBe(plan.cloud.get(path));
    }
  }
  // Nothing that nobody chose for changed.
  const asked = new Set(plan.differences.map(({ path }) => path));
  for (const [path, text] of archived) {
    if (!asked.has(path)) expect(cloudAfter.get(path), `${context} ${path}`).toBe(text);
  }
  // The log has it all.
  copy.close();
  const reopened = (await loadProject(library, KEY)) as LoadedProject;
  expect(reopened.store.exportFiles().files, context).toEqual(cloudAfter);
  reopened.close();
}

describe("linking a folder where both sides changed at random", () => {
  it.each(Array.from({ length: 40 }, (_, index) => index + 1))(
    "every file is the side people chose, the other side is kept, and a stop changes nothing: seed %i",
    async (seed) => {
      await fuzzAdopt(seed);
    },
    60_000,
  );
});
