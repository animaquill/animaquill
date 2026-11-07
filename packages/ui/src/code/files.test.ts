import { entryOf, ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { Dialogs } from "../workbench/dialogs.ts";
import { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { CodeDocuments } from "./documents.ts";
import { FileActions } from "./files.ts";
import { findNode, type TreeNode } from "./tree.ts";

const { t } = await createI18n();

function setup() {
  const store = ProjectStore.create(createProject({ name: "项目" }));
  store.execute({
    type: "scene.add",
    params: {
      id: "a",
      scene: { name: "片头", entry: "index.html", runtime: 1 },
      files: { "index.html": "<!doctype html>", "main.js": "one", "js/a.js": "a", "js/b.js": "b" },
    },
  });
  const session = { store, subscribe: () => () => {} } as unknown as ProjectSession;
  const code = new CodeDocuments(
    session,
    { commandFailed: () => {}, closedRemoved: () => {} },
    {
      unsaved: () => Promise.resolve(undefined),
      overwrite: () => Promise.resolve(undefined),
    },
  );
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const shown = vi.fn<(path: string, edit: boolean) => void>();
  const files = new FileActions(session, code, shown, dialogs, notifications, t as TFunction);
  const node = (path: string) => findNode(files.tree, path) as TreeNode;
  const text = (path: string) => entryOf(store.getState().files, path);
  const said = () => notifications.getSnapshot().map(({ message }) => message);
  return { store, code, dialogs, files, node, text, said, shown };
}

describe("what people do to files", () => {
  beforeEach(() => vi.useFakeTimers());

  /** Runs something that asks one question, with this as the answer. */
  async function answering<T>(
    { dialogs }: ReturnType<typeof setup>,
    answer: string | boolean | undefined,
    run: () => Promise<T>,
  ) {
    const done = run();
    expect(dialogs.getSnapshot()).toBeDefined();
    dialogs.answer(answer);
    await done;
  }

  it("makes an empty file next to what is selected, and shows it", async () => {
    const context = setup();
    const { files, text, shown } = context;
    files.select("scenes/a/main.js");
    await answering(context, "new.js", () => files.newFile());
    expect(text("scenes/a/new.js")).toBe("");
    expect(shown).toHaveBeenCalledWith("scenes/a/new.js", true);
  });

  it("makes a file in shared code when nothing says where", async () => {
    const context = setup();
    await answering(context, "lib.js", () => context.files.newFile());
    expect(context.text("code/lib.js")).toBe("");
  });

  it("makes a file in the folder that was clicked", async () => {
    const context = setup();
    await answering(context, "c.js", () => context.files.newFile(context.node("scenes/a/js")));
    expect(context.text("scenes/a/js/c.js")).toBe("");
  });

  it("makes a folder by naming one", async () => {
    const context = setup();
    await answering(context, "lib/deep/x.js", () => context.files.newFile());
    expect(context.text("code/lib/deep/x.js")).toBe("");
  });

  it("does not replace a file that is there", async () => {
    const context = setup();
    const { files, text, said } = context;
    files.select("scenes/a/index.html");
    await answering(context, "main.js", () => files.newFile());
    expect(text("scenes/a/main.js")).toBe("one");
    expect(said()).toEqual(["已经有这个文件了：scenes/a/main.js"]);
  });

  it("says why when a name cannot be", async () => {
    const context = setup();
    await answering(context, "../x.js", () => context.files.newFile());
    expect(context.said()).toHaveLength(1);
    expect(context.store.getState().files).not.toHaveProperty("x.js");
  });

  it("does nothing when people change their mind", async () => {
    const context = setup();
    const before = context.store.revision;
    await answering(context, undefined, () => context.files.newFile());
    await answering(context, undefined, () =>
      context.files.rename(context.node("scenes/a/main.js")),
    );
    await answering(context, false, () => context.files.remove(context.node("scenes/a/main.js")));
    expect(context.store.revision).toBe(before);
  });

  it("renames a file, and the tab goes along", async () => {
    const context = setup();
    const { code, files, node, text } = context;
    code.open("scenes/a/main.js");
    await answering(context, "other.js", () => files.rename(node("scenes/a/main.js")));
    expect(text("scenes/a/main.js")).toBeUndefined();
    expect(text("scenes/a/other.js")).toBe("one");
    expect(code.getSnapshot().active).toBe("scenes/a/other.js");
  });

  it("renames a folder as one step, and what is open in it goes along", async () => {
    const context = setup();
    const { code, files, node, store, text } = context;
    code.open("scenes/a/js/a.js");
    await answering(context, "src", () => files.rename(node("scenes/a/js")));
    expect(text("scenes/a/src/a.js")).toBe("a");
    expect(text("scenes/a/src/b.js")).toBe("b");
    expect(code.getSnapshot().active).toBe("scenes/a/src/a.js");
    store.undo();
    expect(text("scenes/a/js/a.js")).toBe("a");
    expect(text("scenes/a/js/b.js")).toBe("b");
  });

  it("renames a scene by its name, which leaves its folder as it is", async () => {
    const context = setup();
    const { files, node, store } = context;
    await answering(context, "结尾", () => files.rename(node("scenes/a")));
    expect(entryOf(store.getState().scenes, "a")?.name).toBe("结尾");
    expect(context.text("scenes/a/main.js")).toBe("one");
  });

  it("removes a file", async () => {
    const context = setup();
    await answering(context, true, () => context.files.remove(context.node("scenes/a/main.js")));
    expect(context.text("scenes/a/main.js")).toBeUndefined();
  });

  it("removes a folder as one step", async () => {
    const context = setup();
    const { files, node, store, text } = context;
    await answering(context, true, () => files.remove(node("scenes/a/js")));
    expect(text("scenes/a/js/a.js")).toBeUndefined();
    store.undo();
    expect(text("scenes/a/js/a.js")).toBe("a");
    expect(text("scenes/a/js/b.js")).toBe("b");
  });

  it("removes a scene with the command for that", async () => {
    const context = setup();
    await answering(context, true, () => context.files.remove(context.node("scenes/a")));
    expect(entryOf(context.store.getState().scenes, "a")).toBeUndefined();
    expect(context.text("scenes/a/main.js")).toBeUndefined();
  });

  it("says why when the command refuses, and keeps the selection", async () => {
    const context = setup();
    const { files, node, said, text } = context;
    files.select("scenes/a/index.html");
    await answering(context, true, () => files.remove(node("scenes/a/index.html")));
    expect(text("scenes/a/index.html")).toBeDefined();
    expect(said()).toHaveLength(1);
    expect(files.getSnapshot().selected).toBe("scenes/a/index.html");
  });

  it("leaves what stands for a part of the format alone", async () => {
    const { dialogs, files, node } = setup();
    await files.rename(node("code"));
    await files.remove(node("code"));
    await files.remove(node("scenes"));
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("makes another file the entry, after which the old one can go", async () => {
    const context = setup();
    const { files, node, store, text } = context;
    files.setEntry("scenes/a/js/a.js");
    expect(entryOf(store.getState().scenes, "a")?.entry).toBe("js/a.js");
    await answering(context, true, () => files.remove(node("scenes/a/index.html")));
    expect(text("scenes/a/index.html")).toBeUndefined();
  });

  it("opens a file with a click, and opens and closes a folder", () => {
    const { files, node, shown } = setup();
    files.activate(node("scenes/a/main.js"));
    expect(shown).toHaveBeenCalledWith("scenes/a/main.js", false);
    files.activate(node("scenes/a/js"));
    expect(files.getSnapshot().collapsed.has("scenes/a/js")).toBe(true);
    files.activate(node("scenes/a/js"));
    expect(files.getSnapshot().collapsed.has("scenes/a/js")).toBe(false);
  });
});
