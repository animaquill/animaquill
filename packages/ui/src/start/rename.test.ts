import { ProjectStore } from "@animaquill/core";
import { MemoryCloudLinks, type FolderRecord, type LocalFolder } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { renameUnopened } from "./rename.ts";

/**
 * Renaming from the start page, without opening the project: the design of the start page, 6.6.
 * The change goes into the log as one of people, the way a window writes one.
 */

async function libraryWith(id: string, name: string, folder = false) {
  const projects = new MemoryLibrary();
  const store = ProjectStore.create(createProject({ name }));
  await projects.create({ id, name, folder }, store.encodeState());
  store.destroy();
  return projects;
}

async function nameIn(projects: MemoryLibrary, id: string) {
  const log = await projects.open(id);
  const { store } = ProjectStore.fromUpdates(await log.load());
  log.close();
  const name = store?.getState().manifest.name;
  store?.destroy();
  return name;
}

describe("renaming a project that is not open", () => {
  it("writes the change of people into its log, which the list shows", async () => {
    const projects = await libraryWith("p", "片头");
    expect(
      await renameUnopened("p", " 片头 第二版 ", { projects, window: "w1", now: () => 7 }),
    ).toBe("renamed");
    expect(await nameIn(projects, "p")).toBe("片头 第二版");
    expect((await projects.list())[0]?.name).toBe("片头 第二版");
    const entries = await (await projects.open("p")).entries?.();
    expect(entries?.at(-1)?.source).toEqual({ kind: "user", window: "w1", at: 7 });
    expect(entries).toHaveLength(2);
  });

  it("reaches a window that has the project open, as a change of another window", async () => {
    const projects = await libraryWith("p", "片头");
    const open = await projects.open("p");
    const { store } = ProjectStore.fromUpdates(await open.load());
    open.listen((update) => store?.applyUpdates([update]));
    await renameUnopened("p", "改过的", { projects });
    expect(store?.getState().manifest.name).toBe("改过的");
    // The one change, once.
    expect(await (await projects.open("p")).entries?.()).toHaveLength(2);
    store?.destroy();
  });

  it("does nothing where it is called that already, or where the name is empty", async () => {
    const projects = await libraryWith("p", "片头");
    expect(await renameUnopened("p", "片头", { projects })).toBe("unchanged");
    expect(await renameUnopened("p", "   ", { projects })).toBe("failed");
    expect(await (await projects.open("p")).entries?.()).toHaveLength(1);
  });

  it("says so where the log has nothing usable, or cannot be written", async () => {
    const projects = new MemoryLibrary();
    await projects.create({ id: "empty", name: "空的" }, new Uint8Array([0, 0]));
    expect(await renameUnopened("empty", "新名字", { projects })).toBe("unreadable");
    const failing = await libraryWith("p", "片头");
    failing.failing = true;
    expect(await renameUnopened("p", "新名字", { projects: failing })).toBe("failed");
  });

  it("says that a locked project cannot be renamed, which trying again does not change", async () => {
    const projects = new MemoryLibrary();
    const store = ProjectStore.create(createProject({ name: "定稿" }));
    expect(
      store.execute({ type: "project.setTags", params: { tags: [{ name: "定稿", locked: true }] } })
        .ok,
    ).toBe(true);
    await projects.create({ id: "p", name: "定稿" }, store.encodeState());
    store.destroy();
    expect(await renameUnopened("p", "新名字", { projects })).toBe("locked");
    expect(await (await projects.open("p")).entries?.()).toHaveLength(1);
  });

  it("renames what the list of folders shows of a folder, which gets the name when it opens", async () => {
    const projects = await libraryWith("f", "片头", true);
    const record: FolderRecord = {
      id: "f",
      folder: { name: "intro" } as LocalFolder,
      project: "project-id",
      name: "片头",
      openedAt: 1,
    };
    const records = new Map([["f", record]]);
    await renameUnopened("f", "开场", {
      projects,
      records: {
        get: async (id) => records.get(id),
        put: async (next) => void records.set(next.id, next),
      },
    });
    expect(records.get("f")).toMatchObject({ name: "开场", folder: { name: "intro" } });
    expect(await nameIn(projects, "f")).toBe("开场");
  });

  it("counts one change more for a project of the platform, which has not got it yet", async () => {
    const projects = await libraryWith("k", "片头");
    const links = new MemoryCloudLinks();
    await links.put({
      key: "k",
      platform: "https://platform.test",
      project: "p-1",
      seq: 12,
      pushed: 3,
      linkedAt: 1,
      name: "片头",
    });
    await renameUnopened("k", "开场", { projects, links, window: "w1", now: () => 9 });
    expect(await links.get("k")).toMatchObject({ name: "开场", pending: 1, seq: 12, pushed: 3 });
    // As a window that had the platform's updates up to where the link says.
    const entries = await (await projects.open("k")).entries?.();
    expect(entries?.at(-1)?.source).toEqual({ kind: "user", window: "w1", at: 9, seq: 12 });
  });
});
