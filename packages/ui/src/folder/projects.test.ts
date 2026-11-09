import type { LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { MANIFEST_FILE } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { fixture, putProject } from "./folder-support.ts";
import { FolderProjects } from "./projects.ts";

const t = ((key: string) => key) as never;

function setup() {
  const disk = new MemoryDisk();
  const folders = memoryFolders(disk);
  const library = new MemoryLibrary();
  let count = 0;
  const projects = new FolderProjects({
    folders,
    projects: library,
    t,
    newKey: () => `本机${(count += 1)}`,
    now: () => 1000 + count,
  });
  const choose = async (path: string) => {
    if (!disk.has(path)) disk.folder(path);
    disk.chooseNext(path);
    return (await folders.choose()) as LocalFolder;
  };
  return { disk, folders, library, projects, choose };
}

const manifestIn = (disk: MemoryDisk, path: string) =>
  JSON.parse(disk.text(`${path}/${MANIFEST_FILE}`)) as { id: string; name: string };

describe("a new project", () => {
  it("goes right into an empty folder, kept by a number of this browser", async () => {
    const { disk, library, projects, choose } = setup();
    const folder = await choose("文档/新的");
    expect(await projects.placeFor(folder, "新项目")).toEqual({ kind: "empty" });
    const record = await projects.create("新项目", folder);
    expect(record).toMatchObject({ id: "本机1", name: "新项目" });
    expect(record.project).not.toBe(record.id);
    expect(await projects.records.list()).toEqual([expect.objectContaining({ id: "本机1" })]);
    // The log is there, under that number: the editor writes the files once it is open.
    expect(library.updates.get("本机1")?.length).toBe(1);
    expect(disk.has(`文档/新的/${MANIFEST_FILE}`)).toBe(false);
  });

  it("goes into a folder of its own where other things are, with a name nothing has", async () => {
    const { disk, projects, choose } = setup();
    disk.write("文档/仓库/README.md", "# 说明");
    disk.write("文档/仓库/新项目/笔记.txt", "别人的");
    const folder = await choose("文档/仓库");
    const place = await projects.placeFor(folder, "新项目");
    expect(place).toEqual({ kind: "other", inside: "新项目 (2)", clashes: [] });
    const record = await projects.create("新项目", folder, "新项目 (2)");
    expect(record.folder.name).toBe("新项目 (2)");
    expect(disk.has("文档/仓库/新项目 (2)")).toBe(true);
  });

  it("does not go where a project is, or what is left of an export", async () => {
    const { disk, projects, choose } = setup();
    putProject(disk, fixture(), "文档/原子");
    expect(await projects.placeFor(await choose("文档/原子"), "新项目")).toEqual({
      kind: "project",
    });
    disk.write("文档/半个/导出未完成.txt", "导出没有完成");
    expect(await projects.placeFor(await choose("文档/半个"), "新项目")).toEqual({
      kind: "incomplete",
    });
  });
});

describe("a folder people open", () => {
  it("that this browser does not know is read once, into a log of a new number", async () => {
    const { disk, library, projects, choose } = setup();
    putProject(disk, fixture(), "文档/原子");
    const look = await projects.look(await choose("文档/原子"));
    expect(look).toMatchObject({ kind: "project", replacing: undefined, moved: [] });
    if (look.kind !== "project") return;
    const { record, report } = await projects.adopt(look);
    expect(record.id).toBe("本机1");
    expect(record.project).toBe(manifestIn(disk, "文档/原子").id);
    expect(report).toMatchObject({ id: "本机1", copied: false });
    expect(library.updates.get("本机1")?.length).toBeGreaterThan(0);
    // Once more, it is the same folder, and nothing is read again.
    const again = await projects.look(await choose("文档/原子"));
    expect(again).toMatchObject({ kind: "known", record: { id: "本机1" } });
    expect(await projects.records.list()).toHaveLength(1);
  });

  it("with the project right inside opens that folder", async () => {
    const { disk, projects, choose } = setup();
    putProject(disk, fixture(), "文档/作品/原子");
    const look = await projects.look(await choose("文档/作品"));
    expect(look).toMatchObject({ kind: "project" });
    if (look.kind !== "project") return;
    expect(look.folder.name).toBe("原子");
    const { record } = await projects.adopt(look);
    expect(record.folder.name).toBe("原子");
  });

  it("that is empty can have a project, and one that is not a project is refused", async () => {
    const { disk, projects, choose } = setup();
    expect(await projects.look(await choose("文档/空的"))).toMatchObject({ kind: "empty" });
    disk.write("文档/别的/笔记.txt", "笔记");
    const look = await projects.look(await choose("文档/别的"));
    expect(look).toMatchObject({ kind: "refused" });
    if (look.kind === "refused") expect(look.error.reason).toBe("not-a-project");
  });

  it("that moved is offered as the folder it was, which keeps everything that was kept", async () => {
    const { disk, projects, choose } = setup();
    putProject(disk, fixture(), "文档/原子");
    const first = await projects.look(await choose("文档/原子"));
    if (first.kind !== "project") throw new Error("Not a project");
    const { record } = await projects.adopt(first);
    disk.move("文档/原子", "桌面/原子");
    const look = await projects.look(await choose("桌面/原子"));
    expect(look).toMatchObject({
      kind: "project",
      replacing: undefined,
      moved: [{ id: record.id }],
    });
    if (look.kind !== "project") return;
    const moved = await projects.adopt(look, look.moved[0]);
    expect(moved.record.id).toBe(record.id);
    expect(moved.report).toBeUndefined();
    expect(await projects.records.list()).toHaveLength(1);
  });
});

describe("a folder that is not where it was", () => {
  it("is found again only where the same project is", async () => {
    const { disk, projects, choose } = setup();
    putProject(disk, fixture(), "文档/原子");
    const look = await projects.look(await choose("文档/原子"));
    if (look.kind !== "project") throw new Error("Not a project");
    const { record } = await projects.adopt(look);
    disk.move("文档/原子", "桌面/原子");
    expect(await projects.statusOf(record)).toBe("gone");
    disk.write("文档/别的/笔记.txt", "笔记");
    expect(await projects.findAgain(record, await choose("文档/别的"))).toBe("not-a-project");
    const other = new Map(fixture());
    other.set(MANIFEST_FILE, JSON.stringify({ ...manifestIn(disk, "桌面/原子"), id: "另一个" }));
    putProject(disk, other, "文档/另一个");
    expect(await projects.findAgain(record, await choose("文档/另一个"))).toBe("other-project");
    expect(await projects.findAgain(record, await choose("桌面/原子"))).toBe("found");
    expect(await projects.statusOf((await projects.records.list())[0]!)).toBe("ready");
  });

  it("goes from the list with everything this browser kept of it, and nothing else", async () => {
    const { disk, folders, library, projects, choose } = setup();
    putProject(disk, fixture(), "文档/原子");
    const look = await projects.look(await choose("文档/原子"));
    if (look.kind !== "project") throw new Error("Not a project");
    const { record } = await projects.adopt(look);
    await folders.bases.save(record.id, await folders.bases.claim(record.id), {
      put: [{ path: MANIFEST_FILE, base: "{}" }],
    });
    await projects.forget(record.id);
    expect(await projects.records.list()).toEqual([]);
    expect(await folders.bases.load(record.id)).toEqual([]);
    expect(library.summaries.has(record.id)).toBe(false);
    expect(disk.has(`文档/原子/${MANIFEST_FILE}`)).toBe(true);
  });
});
