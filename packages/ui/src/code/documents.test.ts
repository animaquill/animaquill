import { entryOf, ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { CodeDocuments, isDirty, type CodeQuestions } from "./documents.ts";

const PATH = "scenes/a/main.js";
const OTHER = "scenes/a/other.js";

function storeWithScene(): ProjectStore {
  const store = ProjectStore.create(createProject({ name: "项目" }));
  const result = store.execute({
    type: "scene.add",
    params: {
      id: "a",
      scene: { name: "场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<!doctype html>", "main.js": "one", "other.js": "two" },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return store;
}

class FakeSession {
  readonly #emitter = new Emitter();
  store: ProjectStore | undefined;
  subscribe = this.#emitter.subscribe;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  change(store: ProjectStore | undefined): void {
    this.store = store;
    this.#emitter.emit();
  }
}

describe("open files", () => {
  let store: ProjectStore;
  let session: FakeSession;
  let failed: ReturnType<typeof vi.fn<(message: string) => void>>;
  let closedRemoved: ReturnType<typeof vi.fn<(path: string) => void>>;
  let questions: { [K in keyof CodeQuestions]: ReturnType<typeof vi.fn<CodeQuestions[K]>> };
  let code: CodeDocuments;

  const document = (path = PATH) => code.getSnapshot().documents.find((one) => one.path === path);
  const saved = (path = PATH) => entryOf(store.getState().files, path);
  /** Changes a file the way another window or an import does: it just is different afterwards. */
  const elsewhere = (text: string, path = PATH) => {
    const result = store.execute({ type: "file.write", params: { path, text } });
    if (!result.ok) throw new Error(result.error.message);
  };

  beforeEach(() => {
    store = storeWithScene();
    session = new FakeSession(store);
    failed = vi.fn<(message: string) => void>();
    closedRemoved = vi.fn<(path: string) => void>();
    questions = {
      unsaved: vi.fn<CodeQuestions["unsaved"]>(() => Promise.resolve(undefined)),
      overwrite: vi.fn<CodeQuestions["overwrite"]>(() => Promise.resolve(undefined)),
    };
    code = new CodeDocuments(
      session as unknown as ProjectSession,
      { commandFailed: failed, closedRemoved },
      questions,
    );
  });

  it("opens a file once, and goes to the tab it has", () => {
    expect(code.open(PATH)).toBe(true);
    expect(code.open(OTHER)).toBe(true);
    expect(code.open(PATH)).toBe(true);
    const { documents, active } = code.getSnapshot();
    expect(documents.map(({ path }) => path)).toEqual([PATH, OTHER]);
    expect(active).toBe(PATH);
  });

  it("opens no file that is not there", () => {
    expect(code.open("scenes/a/nothing.js")).toBe(false);
    expect(code.getSnapshot().documents).toEqual([]);
  });

  it("asks for a place every time, also the same one twice", () => {
    code.open(PATH, { line: 3 });
    const first = code.getSnapshot().reveal;
    code.open(PATH, { line: 3 });
    const second = code.getSnapshot().reveal;
    expect(first).toMatchObject({ path: PATH, line: 3 });
    expect(second?.request).not.toBe(first?.request);
  });

  it("does not aim at what cannot be a line", () => {
    for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      code.open(PATH, { line });
      expect(code.getSnapshot().reveal).toBeUndefined();
    }
  });

  it("keeps edits in here until they are saved", () => {
    code.open(PATH);
    code.edit(PATH, "changed");
    expect(saved()).toBe("one");
    expect(isDirty(document() as never)).toBe(true);
    expect(code.hasUnsaved).toBe(true);
  });

  it("is clean again when the text is back to what it was", () => {
    code.open(PATH);
    code.edit(PATH, "changed");
    code.edit(PATH, "one");
    expect(code.hasUnsaved).toBe(false);
  });

  it("saves with the command, in one step to undo", async () => {
    code.open(PATH);
    code.edit(PATH, "changed");
    expect(await code.save()).toBe(true);
    expect(saved()).toBe("changed");
    expect(code.hasUnsaved).toBe(false);
    expect(store.history.at(-1)?.commands).toEqual(["file.write"]);
    store.undo();
    expect(saved()).toBe("one");
  });

  it("writes nothing when nothing changed", async () => {
    code.open(PATH);
    const before = store.revision;
    expect(await code.save()).toBe(true);
    expect(store.revision).toBe(before);
  });

  it("keeps the edits when saving fails, and says why", async () => {
    code.open(PATH);
    code.edit(PATH, "changed");
    vi.spyOn(store, "execute").mockReturnValue({
      ok: false,
      error: { code: "project-locked", message: "锁定了" },
    });
    expect(await code.save()).toBe(false);
    expect(failed).toHaveBeenCalledWith("锁定了");
    expect(document()?.text).toBe("changed");
    expect(code.hasUnsaved).toBe(true);
  });

  describe("when the file changes elsewhere", () => {
    it("follows it when nothing is unsaved, and tells the editor", () => {
      code.open(PATH);
      const before = document()?.version as number;
      elsewhere("theirs");
      expect(document()).toMatchObject({ text: "theirs", base: "theirs", conflict: undefined });
      expect(document()?.version).toBeGreaterThan(before);
      expect(code.hasUnsaved).toBe(false);
    });

    it("loses nothing that was typed, and says so", () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      const before = document()?.version;
      elsewhere("theirs");
      expect(document()).toMatchObject({ text: "mine", base: "one", conflict: "changed" });
      expect(document()?.version).toBe(before);
    });

    it("does not call it a conflict when both came to the same text", () => {
      code.open(PATH);
      code.edit(PATH, "same");
      elsewhere("same");
      expect(document()).toMatchObject({ text: "same", base: "same", conflict: undefined });
      expect(code.hasUnsaved).toBe(false);
    });

    it("asks before saving over it, and nothing happens unless people say so", async () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      expect(await code.save()).toBe(false);
      expect(questions.overwrite).toHaveBeenCalledOnce();
      expect(saved()).toBe("theirs");
      expect(document()?.text).toBe("mine");
    });

    it("saves over it when people say so", async () => {
      questions.overwrite.mockResolvedValue("overwrite");
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      expect(await code.save()).toBe(true);
      expect(saved()).toBe("mine");
      expect(document()?.conflict).toBeUndefined();
    });

    it("saves what is in the tab by the time people answered", async () => {
      const { promise, resolve: answer } = Promise.withResolvers<"overwrite">();
      questions.overwrite.mockReturnValue(promise);
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      const saving = code.save();
      code.edit(PATH, "mine, and more");
      answer("overwrite");
      await saving;
      expect(saved()).toBe("mine, and more");
    });

    it("takes their version when people want that", async () => {
      questions.overwrite.mockResolvedValue("theirs");
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      const before = document()?.version as number;
      expect(await code.save()).toBe(true);
      expect(document()).toMatchObject({ text: "theirs", conflict: undefined });
      expect(document()?.version).toBeGreaterThan(before);
      expect(saved()).toBe("theirs");
    });

    it("goes on with what is in the tab when people want that, without a second question", async () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      code.keepMine(PATH);
      expect(document()).toMatchObject({ text: "mine", base: "theirs", conflict: undefined });
      expect(code.hasUnsaved).toBe(true);
      expect(await code.save()).toBe(true);
      expect(questions.overwrite).not.toHaveBeenCalled();
      expect(saved()).toBe("mine");
    });

    it("clears the conflict when people type their way to the same text", () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      code.edit(PATH, "theirs");
      expect(document()).toMatchObject({ base: "theirs", conflict: undefined });
    });

    it("follows it again when people undo everything they typed", () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      elsewhere("theirs");
      code.edit(PATH, "one");
      expect(document()).toMatchObject({ text: "theirs", base: "theirs", conflict: undefined });
    });
  });

  describe("when the file goes away", () => {
    const remove = (path = PATH) => {
      const result = store.execute({ type: "file.remove", params: { path } });
      if (!result.ok) throw new Error(result.error.message);
    };

    it("closes a tab with nothing unsaved, and says so", () => {
      code.open(OTHER);
      code.open(PATH);
      remove();
      const { documents, active } = code.getSnapshot();
      expect(documents.map(({ path }) => path)).toEqual([OTHER]);
      expect(active).toBe(OTHER);
      expect(closedRemoved).toHaveBeenCalledWith(PATH);
    });

    it("keeps what was typed, and saving brings the file back", async () => {
      questions.overwrite.mockResolvedValue("overwrite");
      code.open(PATH);
      code.edit(PATH, "mine");
      remove();
      expect(document()).toMatchObject({ text: "mine", conflict: "removed" });
      expect(await code.save()).toBe(true);
      expect(saved()).toBe("mine");
      expect(code.hasUnsaved).toBe(false);
    });

    it("stays unsaved when people keep it, also with no text at all", () => {
      code.open(PATH);
      code.edit(PATH, "");
      remove();
      code.keepMine(PATH);
      expect(document()).toMatchObject({ base: undefined, conflict: undefined });
      expect(code.hasUnsaved).toBe(true);
    });

    it("lets go of the tab when people take that", () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      remove();
      code.takeTheirs(PATH);
      expect(code.getSnapshot().documents).toEqual([]);
    });
  });

  describe("a rename from here", () => {
    const NEW = "scenes/a/new.js";
    const rename = () =>
      code.moving(
        new Map([[PATH, NEW]]),
        () => store.execute({ type: "file.rename", params: { from: PATH, to: NEW } }).ok,
      );

    it("takes the tab along, with what is unsaved in it", () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      expect(rename()).toBe(true);
      expect(code.getSnapshot().active).toBe(NEW);
      expect(document(NEW)).toMatchObject({ text: "mine", base: "one" });
    });

    it("keeps a tab with nothing unsaved, which is no file going away", () => {
      code.open(PATH);
      rename();
      expect(document(NEW)).toMatchObject({ text: "one", base: "one" });
      expect(closedRemoved).not.toHaveBeenCalled();
    });

    it("leaves the tab where it is when the command fails", () => {
      code.open(PATH);
      code.moving(new Map([[PATH, NEW]]), () => false);
      expect(document()).toBeDefined();
      expect(document(NEW)).toBeUndefined();
    });
  });

  describe("closing a tab", () => {
    it("goes to the one next to it", async () => {
      code.open(PATH);
      code.open(OTHER);
      code.open("scenes/a/index.html");
      code.activate(OTHER);
      await code.close(OTHER);
      expect(code.getSnapshot().active).toBe("scenes/a/index.html");
    });

    it("asks nothing when nothing is unsaved", async () => {
      code.open(PATH);
      expect(await code.close(PATH)).toBe(true);
      expect(questions.unsaved).not.toHaveBeenCalled();
    });

    it("stays when people do not answer", async () => {
      code.open(PATH);
      code.edit(PATH, "mine");
      expect(await code.close(PATH)).toBe(false);
      expect(document()?.text).toBe("mine");
    });

    it("saves first when people want that", async () => {
      questions.unsaved.mockResolvedValue("save");
      code.open(PATH);
      code.edit(PATH, "mine");
      expect(await code.close(PATH)).toBe(true);
      expect(saved()).toBe("mine");
    });

    it("stays open when saving fails, so that nothing is lost", async () => {
      questions.unsaved.mockResolvedValue("save");
      code.open(PATH);
      code.edit(PATH, "mine");
      vi.spyOn(store, "execute").mockReturnValue({
        ok: false,
        error: { code: "project-locked", message: "锁定了" },
      });
      expect(await code.close(PATH)).toBe(false);
      expect(document()?.text).toBe("mine");
    });

    it("drops the edits when people say so", async () => {
      questions.unsaved.mockResolvedValue("discard");
      code.open(PATH);
      code.edit(PATH, "mine");
      expect(await code.close(PATH)).toBe(true);
      expect(saved()).toBe("one");
    });
  });

  it("saves every tab that has something to save", async () => {
    code.open(PATH);
    code.open(OTHER);
    code.edit(PATH, "first");
    code.edit(OTHER, "second");
    expect(await code.saveAll()).toBe(true);
    expect([saved(), saved(OTHER)]).toEqual(["first", "second"]);
  });

  it("starts empty with another project", () => {
    code.open(PATH);
    session.change(storeWithScene());
    expect(code.getSnapshot().documents).toEqual([]);
    expect(code.open(PATH)).toBe(true);
  });

  it("no longer listens to a project that is closed", () => {
    code.open(PATH);
    session.change(undefined);
    elsewhere("theirs");
    expect(code.getSnapshot().documents).toEqual([]);
    expect(closedRemoved).not.toHaveBeenCalled();
  });
});
