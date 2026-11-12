import { STORAGE, USER, type Here } from "@animaquill/core";
import { hashFile } from "@animaquill/media";
import type { Asset } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { MediaLibrary } from "../media/library.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { MissingFileWatch, isMissing, type MissingFiles } from "./missing-files.ts";

vi.mock("@animaquill/media", async (original) => ({
  ...(await original<typeof import("@animaquill/media")>()),
  probeMedia: async () => ({ kind: "image", width: 1, height: 1 }),
}));

const CONTENT = new File(["这是一张图片"], "封面.png", { type: "image/png" });

/** A project in this browser that knows files it does not have, as after an import without them. */
async function setup(here?: Here) {
  const projects = new MemoryLibrary();
  const silent = () => {};
  const session = new ProjectSession(projects, memoryAddress(), {
    createFailed: silent,
    notFound: silent,
    openFailed: silent,
    tooNew: silent,
    damaged: silent,
    saveFailed: silent,
    saveRecovered: silent,
  });
  const fail = () => {
    throw new Error("not expected");
  };
  const messages = {
    unsupported: fail,
    tooLarge: fail,
    saveFailed: fail,
    commandFailed: fail,
    confirmCopy: async () => true,
    copyFailed: fail,
    readFailed: fail,
    otherKind: fail,
    readOnly: fail,
  };
  const media = new MediaLibrary(session, projects, messages, "");
  await session.create("我的项目");
  const store = session.store;
  if (!store) throw new Error("No project");
  const hash = await hashFile(CONTENT);
  /** An asset, as assets.json says it: only files say where else a file is, and uploads. */
  const know = (id: string, fields: Partial<Asset> = {}) => {
    const text = store.exportFiles().files.get("assets.json") ?? '{ "assets": {} }';
    const document = JSON.parse(text);
    const asset = { kind: "image", path: `assets/${id}.png`, storage: "local", hash, size: 18 };
    document.assets[id] = { ...asset, ...fields };
    const result = store.importFile("assets.json", JSON.stringify(document), { origin: USER });
    expect(result.ok).toBe(true);
  };
  const watch = new MissingFileWatch(session, media, undefined, () => here);
  let snapshot: MissingFiles = new Map();
  watch.subscribe(() => (snapshot = watch.getSnapshot()));
  return { store, media, know, hash, files: () => snapshot };
}

describe("the files of a project in this browser", () => {
  it("are missing where nothing else has them, and can come from where they are kept", async () => {
    const { know, files } = await setup();
    know("here");
    know("lfs", { storage: "lfs" });
    know("remote", { storage: "remote", url: "https://storage.example.com/a.png" });
    // Without its hash and size nothing could check what came from there.
    know("old", { storage: "lfs", hash: undefined, size: undefined });
    await vi.waitFor(() => expect(files().size).toBe(4));
    expect(files().get("here")).toEqual({ asset: "here", path: "assets/here.png" });
    expect(files().get("lfs")).toEqual({ asset: "lfs", path: "assets/lfs.png", elsewhere: "lfs" });
    expect(files().get("remote")?.elsewhere).toBe("remote");
    expect([...files().values()].filter(isMissing).map(({ asset }) => asset)).toEqual([
      "here",
      "old",
    ]);
  });

  it("can come from where an upload put them, as soon as it did", async () => {
    const { store, know, hash, files } = await setup();
    know("a");
    await vi.waitFor(() => expect(files().get("a")).toBeDefined());
    expect(isMissing(files().get("a"))).toBe(true);
    const params = { asset: "a", storage: "platform", hash, owner: "u-1" };
    expect(store.execute({ type: "asset.setStorage", params }, { origin: STORAGE }).ok).toBe(true);
    await vi.waitFor(() => expect(files().get("a")?.elsewhere).toBe("platform"));
  });

  it("are missing where what they were put in is not here, as in a copy in another repository", async () => {
    const { store, know, hash, files } = await setup({ repo: "999" });
    know("a");
    const params = { asset: "a", storage: "lfs", hash, repo: "123" };
    expect(store.execute({ type: "asset.setStorage", params }, { origin: STORAGE }).ok).toBe(true);
    await vi.waitFor(() => expect(files().get("a")).toBeDefined());
    expect(isMissing(files().get("a"))).toBe(true);
  });

  it("are neither once they are here", async () => {
    const { media, know, files } = await setup();
    know("lfs", { storage: "lfs" });
    await vi.waitFor(() => expect(files().size).toBe(1));
    await media.importFiles([CONTENT]);
    await vi.waitFor(() => expect(files().size).toBe(0));
  });
});
