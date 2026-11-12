import { entryOf, ProjectStore, type CommandFailure } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import { MemoryTrials } from "../workbench/memory-library.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { CodeDocuments } from "./documents.ts";
import { CodeDrafts, readDrafts, type DraftMessages } from "./drafts.ts";

const PATH = "scenes/a/main.js";

function storeWithScene(): ProjectStore {
  const store = ProjectStore.create(createProject({ name: "项目" }));
  const result = store.execute({
    type: "scene.add",
    params: {
      id: "a",
      manifest: { name: "场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<!doctype html>", "main.js": "one" },
    },
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return store;
}

class FakeSession {
  readonly #emitter = new Emitter();
  store: ProjectStore | undefined;
  subscribe = this.#emitter.subscribe;
  constructor(store: ProjectStore | undefined) {
    this.store = store;
  }
  change(store: ProjectStore | undefined): void {
    this.store = store;
    this.#emitter.emit();
  }
}

/** One window on a project, which can go away and come back as another one. */
function window(store: ProjectStore | undefined, places: MemoryTrials) {
  const session = new FakeSession(store);
  const commandFailed = vi.fn<(failure: CommandFailure) => void>();
  const code = new CodeDocuments(
    session as unknown as ProjectSession,
    { commandFailed, closedRemoved: () => {} },
    {
      unsaved: () => Promise.resolve(undefined),
      overwrite: () => Promise.resolve("overwrite"),
    },
  );
  const messages = {
    restored: vi.fn(),
    dropped: vi.fn(),
    readFailed: vi.fn(),
    keepFailed: vi.fn(),
    keepRecovered: vi.fn(),
  } satisfies DraftMessages;
  const drafts = new CodeDrafts(session as unknown as ProjectSession, code, places, messages);
  const document = (path = PATH) => code.getSnapshot().documents.find((one) => one.path === path);
  /** The window goes, and what it had written stays. A crash is the same, minus the last write. */
  const leave = async () => {
    await drafts.settle();
    session.change(undefined);
    await drafts.settle();
  };
  return { session, code, drafts, messages, document, leave, commandFailed };
}

const kept = (places: MemoryTrials, project: string) => [
  ...(places.kept.get(project)?.values() ?? []),
];

describe("code that is not saved", () => {
  let store: ProjectStore;
  let places: MemoryTrials;
  let id: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store = storeWithScene();
    places = new MemoryTrials();
    id = store.getState().manifest.id;
  });

  afterEach(() => vi.restoreAllMocks());

  /** Somebody typed in a window that is gone now. */
  async function typedAndLeft(text = "mine") {
    const before = window(store, places);
    before.code.open(PATH);
    before.code.edit(PATH, text);
    await before.leave();
  }

  it("goes on the device as it is typed", async () => {
    const { code, drafts } = window(store, places);
    code.open(PATH);
    code.edit(PATH, "mine");
    await drafts.settle();
    expect(kept(places, id)).toEqual([
      { version: 1, drafts: [{ path: PATH, text: "mine", base: "one" }] },
    ]);
  });

  it("leaves nothing on the device once it is saved", async () => {
    const { code, drafts } = window(store, places);
    code.open(PATH);
    code.edit(PATH, "mine");
    await drafts.settle();
    await code.save();
    await drafts.settle();
    expect(kept(places, id)).toEqual([]);
  });

  it("comes back unsaved in a window after a reload, and the project stays as it was", async () => {
    await typedAndLeft();
    const revision = store.revision;
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.document()).toMatchObject({ text: "mine", base: "one", conflict: undefined });
    expect(after.code.getSnapshot().active).toBe(PATH);
    expect(after.messages.restored).toHaveBeenCalledWith(1);
    expect(store.revision).toBe(revision);
    expect(entryOf(store.getState().files, PATH)).toBe("one");
  });

  it("comes back as a conflict when the file changed in the meantime", async () => {
    await typedAndLeft();
    store.execute({ type: "file.write", params: { path: PATH, text: "theirs" } });
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.document()).toMatchObject({ text: "mine", conflict: "changed" });
    expect(entryOf(store.getState().files, PATH)).toBe("theirs");
  });

  it("comes back when the file is gone, and saving brings it back", async () => {
    await typedAndLeft();
    store.execute({ type: "file.remove", params: { path: PATH } });
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.document()).toMatchObject({ text: "mine", conflict: "removed" });
    expect(await after.code.save()).toBe(true);
    expect(entryOf(store.getState().files, PATH)).toBe("mine");
  });

  it("comes back at its old path after a rename, and the file under its new name stays", async () => {
    await typedAndLeft();
    store.execute({ type: "file.rename", params: { from: PATH, to: "scenes/a/new.js" } });
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.document()).toMatchObject({ text: "mine", conflict: "removed" });
    expect(entryOf(store.getState().files, "scenes/a/new.js")).toBe("one");
  });

  it("stays with people when its scene is gone, and saving says why it cannot", async () => {
    const other = "scenes/b/main.js";
    store.execute({
      type: "scene.add",
      params: {
        id: "b",
        manifest: { name: "别的", entry: "index.html", runtime: 1 },
        files: { "index.html": "", "main.js": "one" },
      },
    });
    const before = window(store, places);
    before.code.open(other);
    before.code.edit(other, "mine");
    await before.leave();
    store.execute({ type: "scene.remove", params: { scene: "b" } });
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.document(other)).toMatchObject({ text: "mine", conflict: "removed" });
    expect(await after.code.save(other)).toBe(false);
    expect(after.commandFailed).toHaveBeenCalledOnce();
    expect(after.document(other)?.text).toBe("mine");
  });

  it("has nothing to bring back when somebody saved the same text since", async () => {
    await typedAndLeft();
    store.execute({ type: "file.write", params: { path: PATH, text: "mine" } });
    const after = window(store, places);
    await after.drafts.settle();
    expect(after.messages.restored).not.toHaveBeenCalled();
    expect(after.code.hasUnsaved).toBe(false);
    expect(kept(places, id)).toEqual([]);
  });

  it("does not lose what was kept when the window starts typing before it came back", async () => {
    await typedAndLeft();
    const { promise, resolve } = Promise.withResolvers<void>();
    places.duringLoad = () => promise;
    const after = window(store, places);
    after.code.open("scenes/a/index.html");
    after.code.edit("scenes/a/index.html", "new");
    resolve();
    await after.drafts.settle();
    expect(after.document()).toMatchObject({ text: "mine" });
    expect(after.document("scenes/a/index.html")).toMatchObject({ text: "new" });
  });

  it("keeps what another project had when the window moves on without leaving it", async () => {
    const first = window(store, places);
    first.code.open(PATH);
    first.code.edit(PATH, "mine");
    await first.drafts.settle();
    first.session.change(storeWithScene());
    await first.drafts.settle();
    expect(kept(places, id)).toHaveLength(1);
  });

  it("says so when the device cannot hold it, and when it can again", async () => {
    const { code, drafts, messages } = window(store, places);
    places.failing = true;
    code.open(PATH);
    code.edit(PATH, "mine");
    await drafts.settle();
    expect(messages.keepFailed).toHaveBeenCalledOnce();
    places.failing = false;
    code.edit(PATH, "mine, more");
    await drafts.settle();
    expect(messages.keepRecovered).toHaveBeenCalledOnce();
  });

  it("opens the project as it is whatever the device kept", async () => {
    for (const junk of [{ version: 9 }, "text", [1, 2], { version: 1, drafts: "x" }]) {
      places.kept.set(id, new Map([["place1", junk]]));
      const after = window(store, places);
      await after.drafts.settle();
      expect(after.code.getSnapshot().documents).toEqual([]);
      expect(after.messages.dropped).toHaveBeenCalledWith(1);
      await after.leave();
    }
  });
});

describe("what the device kept", () => {
  const read = (drafts: unknown[]) => readDrafts({ version: 1, drafts });

  it("is only code of the project, once for each path", () => {
    const { drafts, dropped } = read([
      { path: "scenes/a/x.js", text: "a", base: "b" },
      { path: "code/y.js", text: "a", base: null },
      { path: "scenes/a/x.js", text: "again", base: "b" },
      { path: "../x.js", text: "a", base: null },
      { path: "/etc/x.js", text: "a", base: null },
      { path: "assets/a.png", text: "a", base: null },
      { path: "scenes/a/z.js", text: 1, base: null },
      { path: "scenes/a/z.js", text: "a", base: 1 },
      null,
    ]);
    expect(drafts).toEqual([
      { path: "scenes/a/x.js", text: "a", base: "b" },
      { path: "code/y.js", text: "a", base: undefined },
    ]);
    expect(dropped).toBe(7);
  });

  it("is nothing when there is nothing", () => {
    expect(readDrafts(undefined)).toEqual({ drafts: [], dropped: 0 });
  });

  it("leaves out what no file can be", () => {
    const huge = "x".repeat(12 * 1024 ** 2);
    expect(read([{ path: "code/a.js", text: huge, base: null }]).drafts).toEqual([]);
  });
});
