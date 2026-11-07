import type { ProjectState } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { fileTree, filesIn, findNode, visibleRows, type FolderNode } from "./tree.ts";

const NAMES = { scenes: "场景", sounds: "声音", shared: "共用代码" };

const state = (
  files: Record<string, string>,
  scenes: Record<string, { name: string; entry: string }> = {},
  sounds: Record<string, { name: string; entry: string }> = {},
) => ({ files, scenes, sounds }) as unknown as ProjectState;

const SCENES = { a: { name: "片头", entry: "index.html" } };

describe("the tree of files", () => {
  it("shows scenes by their names, with what is in their folders", () => {
    const [scenes] = fileTree(
      state({ "scenes/a/index.html": "", "scenes/a/js/main.js": "" }, SCENES),
      NAMES,
    );
    const [scene] = (scenes as FolderNode).children as FolderNode[];
    expect(scene).toMatchObject({ name: "片头", role: "scene", id: "a", path: "scenes/a" });
    expect(scene?.children.map(({ name }) => name)).toEqual(["js", "index.html"]);
    expect(findNode([scene as FolderNode], "scenes/a/js/main.js")).toMatchObject({
      kind: "file",
      name: "main.js",
    });
  });

  it("marks the file a scene starts with", () => {
    const tree = fileTree(
      state({ "scenes/a/index.html": "", "scenes/a/x.html": "" }, SCENES),
      NAMES,
    );
    expect(findNode(tree, "scenes/a/index.html")).toMatchObject({ entry: true });
    expect(findNode(tree, "scenes/a/x.html")).toMatchObject({ entry: false });
  });

  it("does not take a file deeper down for the entry", () => {
    const tree = fileTree(state({ "scenes/a/x/index.html": "" }, SCENES), NAMES);
    expect(findNode(tree, "scenes/a/x/index.html")).toMatchObject({ entry: false });
  });

  it("sorts numbers the way people count", () => {
    const tree = fileTree(state({ "code/a10.js": "", "code/a2.js": "", "code/z/b.js": "" }), NAMES);
    const shared = tree.at(-1) as FolderNode;
    expect(shared.children.map(({ name }) => name)).toEqual(["z", "a2.js", "a10.js"]);
  });

  it("always has a place for shared code, and only has sounds when there are any", () => {
    expect(fileTree(state({}), NAMES).map(({ role }) => role)).toEqual(["group", "shared"]);
    const withSound = state(
      { "sounds/s/main.js": "" },
      {},
      { s: { name: "鼓", entry: "main.js" } },
    );
    expect(fileTree(withSound, NAMES).map(({ name }) => name)).toEqual([
      "场景",
      "声音",
      "共用代码",
    ]);
  });

  it("shows files with no scene around them, which an import can leave", () => {
    const tree = fileTree(state({ "scenes/gone/a.js": "" }), NAMES);
    expect(findNode(tree, "scenes/gone")).toMatchObject({ name: "gone", role: "scene" });
    expect(findNode(tree, "scenes/gone/a.js")).toBeDefined();
  });

  it("finds all files of a folder, however deep", () => {
    const tree = fileTree(state({ "code/a.js": "", "code/b/c/d.js": "" }), NAMES);
    expect(filesIn(tree.at(-1) as FolderNode).toSorted()).toEqual(["code/a.js", "code/b/c/d.js"]);
  });

  it("does not take one folder for another with the same beginning", () => {
    const tree = fileTree(state({ "code/ab/x.js": "", "code/a/y.js": "" }), NAMES);
    expect(findNode(tree, "code/ab/x.js")).toBeDefined();
    expect(findNode(tree, "code/a/x.js")).toBeUndefined();
  });

  it("leaves out what is in a folder that is closed", () => {
    const tree = fileTree(state({ "code/b/c.js": "", "code/a.js": "" }), NAMES);
    const paths = (closed: string[]) =>
      visibleRows(tree, new Set(closed)).map(({ node, depth }) => `${depth} ${node.path}`);
    expect(paths([])).toEqual(["0 scenes", "0 code", "1 code/b", "2 code/b/c.js", "1 code/a.js"]);
    expect(paths(["code/b"])).toEqual(["0 scenes", "0 code", "1 code/b", "1 code/a.js"]);
  });
});
