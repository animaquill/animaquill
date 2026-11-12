import { USER } from "@animaquill/core";
import { hashFile } from "@animaquill/media";
import type { Asset } from "@animaquill/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { MediaLibrary, type CopyFailure } from "./library.ts";

vi.mock("@animaquill/media", async (original) => ({
  ...(await original<typeof import("@animaquill/media")>()),
  probeMedia: async () => ({ kind: "image", width: 1, height: 1 }),
}));

const CONTENT = new File(["这是一张图片"], "封面.png", { type: "image/png" });

async function setup() {
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
  const messages = {
    unsupported: vi.fn<(name: string) => void>(),
    tooLarge: vi.fn<(name: string) => void>(),
    saveFailed: vi.fn<(name: string) => void>(),
    commandFailed: vi.fn<(message: string) => void>(),
    confirmCopy: vi.fn<(name: string, bytes: number) => Promise<boolean>>(async () => true),
    copyFailed: vi.fn<(name: string, reason: CopyFailure) => void>(),
    readFailed: vi.fn<(name: string) => void>(),
    otherKind: vi.fn<(name: string) => void>(),
    readOnly: vi.fn<() => void>(),
  };
  const library = new MediaLibrary(session, projects, messages, "");
  await session.create("我的项目");
  const store = session.store;
  if (!store) throw new Error("No project");
  const id = store.getState().manifest.id;
  /** A project that knows a file this host does not have, as after an import without it. */
  const knowFile = (hash: string, fields: Partial<Asset> = {}) =>
    store.execute({
      type: "asset.add",
      params: {
        id: "cover",
        asset: { kind: "image", path: "assets/cover.png", storage: "local", hash, ...fields },
      },
    });
  const assets = () => Object.keys(store.getState().assets ?? {});
  return { projects, session, store, library, messages, id, knowFile, assets };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a file the project knows but this browser does not have", () => {
  it("comes back when people bring in that very file", async () => {
    const { projects, library, id, knowFile, assets } = await setup();
    const hash = await hashFile(CONTENT);
    knowFile(hash);
    expect(await projects.media(id).get(hash)).toBeUndefined();

    expect(await library.importFiles([CONTENT])).toEqual(["cover"]);
    expect(assets()).toEqual(["cover"]);
    expect(await (await projects.media(id).get(hash))?.text()).toBe("这是一张图片");
  });

  it("tells whatever looked for it in vain to look again", async () => {
    const { library, knowFile } = await setup();
    const hash = await hashFile(CONTENT);
    knowFile(hash);
    expect(await library.urlOf("cover")).toBeUndefined();
    const onRestored = vi.fn<(hash: string) => void>();
    library.onRestored(onRestored);
    const changed = vi.fn<() => void>();
    library.subscribe(changed);
    const before = library.getRestored();

    await library.importFiles([CONTENT]);

    expect(onRestored).toHaveBeenCalledExactlyOnceWith(hash);
    expect(library.getRestored()).toBe(before + 1);
    expect(changed).toHaveBeenCalled();
    expect(await library.urlOf("cover")).toMatch(/^blob:/);
  });

  it("is found also when another tool wrote its hash in another way", async () => {
    const { projects, library, id, knowFile, assets } = await setup();
    const digest = await crypto.subtle.digest("SHA-256", await CONTENT.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
    const hash = `sha256-${hex.join("")}`;
    knowFile(hash);
    await library.importFiles([CONTENT]);
    expect(assets()).toEqual(["cover"]);
    expect(await projects.media(id).get(hash)).toBeDefined();
  });

  it("says so when there is no room for it", async () => {
    const { projects, library, messages, knowFile } = await setup();
    knowFile(await hashFile(CONTENT));
    projects.failing = true;
    expect(await library.importFiles([CONTENT])).toEqual([]);
    expect(messages.saveFailed).toHaveBeenCalledWith("封面.png");
  });

  it("says why when the project does not take it", async () => {
    const { library, messages, store } = await setup();
    const lock = { tags: [{ name: "定稿", locked: true }] };
    store.execute({ type: "project.setTags", params: lock });
    expect(await library.importFiles([CONTENT])).toEqual([]);
    expect(messages.commandFailed).toHaveBeenCalledOnce();
  });

  it("is left alone when it is here, and nothing has to look again", async () => {
    const { projects, library, id, assets } = await setup();
    const [first] = await library.importFiles([CONTENT]);
    const hash = await hashFile(CONTENT);
    const kept = await projects.media(id).get(hash);
    const onRestored = vi.fn<(hash: string) => void>();
    library.onRestored(onRestored);

    expect(await library.importFiles([new File([CONTENT], "别的名字.png")])).toEqual([first]);
    expect(assets()).toEqual([first]);
    expect(await projects.media(id).get(hash)).toBe(kept);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("stops being told about when asked to", async () => {
    const { library, knowFile } = await setup();
    knowFile(await hashFile(CONTENT));
    const onRestored = vi.fn<(hash: string) => void>();
    library.onRestored(onRestored)();
    await library.importFiles([CONTENT]);
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("another file for an asset", () => {
  it("knows whether this browser has the file of an asset", async () => {
    const { library, knowFile } = await setup();
    knowFile(await hashFile(CONTENT));
    expect(await library.hasFile("cover")).toBe(false);
    expect(await library.hasFile("nothing")).toBe(false);
    await library.importFiles([CONTENT]);
    expect(await library.hasFile("cover")).toBe(true);
  });

  it("does not take a file kept somewhere else for one that is here", async () => {
    const { library, store } = await setup();
    const url = "https://storage.example.com/cover.png";
    const hash = await hashFile(CONTENT);
    // Only files say where else a file is, and uploads.
    const asset = {
      kind: "image",
      path: "assets/cover.png",
      storage: "remote",
      url,
      hash,
      size: 18,
    };
    const text = JSON.stringify({ assets: { cover: asset } });
    expect(store.importFile("assets.json", text, { origin: USER }).ok).toBe(true);
    expect(await library.hasFile("cover")).toBe(false);
    await library.importFiles([CONTENT]);
    expect(await library.hasFile("cover")).toBe(true);
  });

  it("takes the place of the old one in one step, with the clips staying on the asset", async () => {
    const { projects, library, store, id, knowFile } = await setup();
    knowFile(await hashFile(CONTENT), { name: "封面" });
    const other = new File(["另一张图片的内容"], "新封面.webp", { type: "image/webp" });
    const restored = library.getRestored();
    expect(await library.replaceFile("cover", { file: other })).toBe(true);
    const asset = store.getState().assets?.["cover"];
    const hash = await hashFile(other);
    expect(asset).toMatchObject({
      name: "封面",
      hash,
      size: other.size,
      path: "assets/cover.webp",
    });
    expect(await (await projects.media(id).get(hash))?.text()).toBe("另一张图片的内容");
    expect(library.getRestored()).toBeGreaterThan(restored);
    store.undo();
    expect(store.getState().assets?.["cover"]?.path).toBe("assets/cover.png");
  });

  it("refuses a file of another kind, which the clips could not show", async () => {
    const { library, store, messages, knowFile } = await setup();
    knowFile(await hashFile(CONTENT), { kind: "video" });
    const before = store.getState().assets?.["cover"];
    expect(await library.replaceFile("cover", { file: CONTENT })).toBe(false);
    expect(messages.otherKind).toHaveBeenCalledWith("封面.png");
    expect(store.getState().assets?.["cover"]).toEqual(before);
  });
});
