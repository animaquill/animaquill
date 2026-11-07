import { createProject, readProject, type SceneManifest } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { orderedTracks } from "./model.ts";
import { MAX_SOURCE_BYTES } from "./scene-edits.ts";
import { ProjectStore, aiTask, type CommandCall, type CommandResult } from "./store.ts";

const manifest: SceneManifest = { name: "标题", entry: "index.html", runtime: 1 };
const PAGE = "<!doctype html><h1>标题</h1>";

function open() {
  const store = ProjectStore.create(createProject({ name: "场景" }));
  const state = () => store.getState();
  const track = orderedTracks(state().timelines["main"] as never).find(
    ({ kind }) => kind === "video",
  )?.id as string;
  const run = (type: string, params: object, origin?: string) =>
    store.execute({ type, params } as CommandCall, origin === undefined ? {} : { origin });
  const ok = (result: CommandResult) => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result;
  };
  const code = (result: CommandResult) => (result.ok ? "ok" : result.error.code);
  const addScene = (id = "title", files: object = { "index.html": PAGE }, scene = manifest) =>
    ok(run("scene.add", { id, scene, files }));
  const useScene = (scene = "title", clip = "c", start = "0") =>
    ok(
      run("clip.add", {
        timeline: "main",
        track,
        clip: { id: clip, start, duration: "5", source: { kind: "scene", scene } },
      }),
    );
  const lock = () =>
    ok(run("track.update", { timeline: "main", track, changes: { locked: true } }));
  const unlock = () =>
    ok(run("track.update", { timeline: "main", track, changes: { locked: false } }));
  return { store, state, track, run, ok, code, addScene, useScene, lock, unlock };
}

describe("a new scene", () => {
  it("comes with its files, in one step", () => {
    const { store, state, addScene } = open();
    addScene("title", { "index.html": PAGE, "css/style.css": "h1 { color: red }" });
    expect(state().scenes["title"]).toEqual(manifest);
    expect(state().files["scenes/title/index.html"]).toBe(PAGE);
    expect(state().files["scenes/title/css/style.css"]).toBe("h1 { color: red }");
    store.undo();
    expect(state().scenes["title"]).toBeUndefined();
    expect(state().files).toEqual({});
    store.redo();
    expect(state().files["scenes/title/index.html"]).toBe(PAGE);
  });

  it("gets an id when it does not bring one", () => {
    const { run, ok } = open();
    const result = ok(run("scene.add", { scene: manifest, files: { "index.html": PAGE } }));
    expect((result.results[0] as { id: string }).id).toMatch(/^scene_/);
  });

  it("ends up in the files of the project, which open again", () => {
    const { store, addScene } = open();
    addScene();
    const { files, problems } = store.exportFiles();
    expect(problems).toEqual([]);
    expect(files.get("scenes/title/index.html")).toBe(PAGE);
    const read = readProject(files);
    expect(read.project?.scenes.get("title")).toEqual(manifest);
    expect(read.problems.filter(({ severity }) => severity === "error")).toEqual([]);
  });

  it("holds its files as text that merges", () => {
    const { store, addScene } = open();
    addScene();
    const files = store.doc.getMap("project").get("files") as Y.Map<unknown>;
    expect(files.get("scenes/title/index.html")).toBeInstanceOf(Y.Text);
  });

  it.each([
    ["an id that is taken", "id-taken", { id: "title" }],
    ["no entry", "missing-entry", { id: "b", files: {} }],
    ["an entry that is not there", "missing-entry", { id: "b", files: { "other.html": "" } }],
    ["an id that leads out", "invalid-params", { id: "../up" }],
    ["a path that leads out", "invalid-params", { id: "b", files: { "../up.html": "" } }],
    ["a path from the root", "invalid-params", { id: "b", files: { "/up.html": "" } }],
    ["a file of the format", "invalid-value", { id: "b", files: { "scene.json": "{}" } }],
    ["a hidden folder", "invalid-value", { id: "b", files: { ".git/config": "" } }],
    ["installed packages", "invalid-value", { id: "b", files: { "node_modules/a.js": "" } }],
    [
      "a runtime from the future",
      "runtime-too-new",
      { id: "b", scene: { ...manifest, runtime: 2 } },
    ],
    [
      "an entry that cannot run",
      "invalid-params",
      { id: "b", scene: { ...manifest, entry: "a.ts" } },
    ],
    ["no runtime", "invalid-params", { id: "b", scene: { name: "b", entry: "index.html" } }],
    ["a field nobody knows", "invalid-params", { id: "b", scene: { ...manifest, extra: 1 } }],
  ])("refuses %s, and writes nothing", (_, expected, params) => {
    const { state, run, code, addScene } = open();
    addScene();
    const before = state();
    expect(
      code(run("scene.add", { scene: manifest, files: { "index.html": PAGE }, ...params })),
    ).toBe(expected);
    expect(state()).toBe(before);
  });

  it("refuses a file and a folder of one name", () => {
    const { run, code } = open();
    const files = { "index.html": PAGE, a: "x", "a/b.js": "y" };
    expect(code(run("scene.add", { id: "b", scene: manifest, files }))).toBe("path-taken");
  });
});

describe("changing a scene", () => {
  it("changes what it is told to, and can be undone", () => {
    const { store, state, run, ok, addScene } = open();
    addScene();
    ok(run("scene.update", { scene: "title", changes: { name: "新名字", description: "说明" } }));
    expect(state().scenes["title"]).toEqual({ ...manifest, name: "新名字", description: "说明" });
    ok(run("scene.update", { scene: "title", changes: {}, clear: ["description"] }));
    expect(state().scenes["title"]).toEqual({ ...manifest, name: "新名字" });
    store.undo();
    store.undo();
    expect(state().scenes["title"]).toEqual(manifest);
  });

  it("leaves no step when nothing changes", () => {
    const { store, run, ok, addScene } = open();
    addScene();
    const revision = store.revision;
    ok(run("scene.update", { scene: "title", changes: { name: manifest.name } }));
    expect(store.revision).toBe(revision);
  });

  it.each([
    ["a scene that is not there", "not-found", { scene: "nope", changes: { name: "a" } }],
    ["an entry that is not there", "missing-entry", { scene: "title", changes: { entry: "b.js" } }],
    ["a runtime from the future", "runtime-too-new", { scene: "title", changes: { runtime: 2 } }],
    ["a name of nothing", "invalid-params", { scene: "title", changes: { name: "" } }],
    ["a field nobody knows", "invalid-params", { scene: "title", changes: { extra: 1 } }],
    [
      "taking away what it needs",
      "invalid-params",
      { scene: "title", changes: {}, clear: ["name"] },
    ],
  ])("refuses %s", (_, expected, params) => {
    const { state, run, code, addScene } = open();
    addScene();
    const before = state();
    expect(code(run("scene.update", params))).toBe(expected);
    expect(state()).toBe(before);
  });
});

describe("removing a scene", () => {
  it("takes its files along, and undo brings them back", () => {
    const { store, state, run, ok, addScene } = open();
    addScene("title", { "index.html": PAGE, "a.js": "1" });
    addScene("other");
    ok(run("file.write", { path: "code/shared.js", text: "2" }));
    ok(run("scene.remove", { scene: "title" }));
    expect(state().scenes["title"]).toBeUndefined();
    expect(Object.keys(state().files).toSorted()).toEqual([
      "code/shared.js",
      "scenes/other/index.html",
    ]);
    store.undo();
    expect(state().scenes["title"]).toEqual(manifest);
    expect(state().files["scenes/title/a.js"]).toBe("1");
  });

  it("stays while a clip uses it", () => {
    const { run, code, addScene, useScene } = open();
    addScene();
    useScene();
    expect(code(run("scene.remove", { scene: "title" }))).toBe("scene-in-use");
  });

  it("stays whole when the task that made it is taken back after somebody started using it", () => {
    const { store, state, useScene } = open();
    const files = { "index.html": PAGE, "a.js": "1" };
    const made = store.execute(
      { type: "scene.add", params: { id: "b", scene: manifest, files } },
      { origin: aiTask("x") },
    );
    expect(made.ok).toBe(true);
    useScene("b");
    expect(store.undoTask("x").ok).toBe(false);
    expect(state().scenes["b"]).toEqual(manifest);
    expect(state().files["scenes/b/index.html"]).toBe(PAGE);
    expect(state().files["scenes/b/a.js"]).toBe("1");
  });
});

describe("files", () => {
  it("writes a new file and changes one that is there", () => {
    const { store, state, run, ok, addScene } = open();
    addScene();
    ok(run("file.write", { path: "scenes/title/main.js", text: "1" }));
    ok(run("file.write", { path: "scenes/title/main.js", text: "2" }));
    expect(state().files["scenes/title/main.js"]).toBe("2");
    store.undo();
    expect(state().files["scenes/title/main.js"]).toBe("1");
    store.undo();
    expect(state().files["scenes/title/main.js"]).toBeUndefined();
    store.redo();
    store.redo();
    expect(state().files["scenes/title/main.js"]).toBe("2");
  });

  it("leaves no step for the same text", () => {
    const { store, run, ok, addScene } = open();
    addScene();
    const revision = store.revision;
    ok(run("file.write", { path: "scenes/title/index.html", text: PAGE }));
    expect(store.revision).toBe(revision);
  });

  it("writes shared code without a scene", () => {
    const { state, run, ok } = open();
    ok(run("file.write", { path: "code/shared.js", text: "1" }));
    expect(state().files["code/shared.js"]).toBe("1");
  });

  it("writes into the folder of a sound", () => {
    const { store, run, code } = open();
    expect(code(run("file.write", { path: "sounds/s/main.js", text: "" }))).toBe("not-found");
    const files = new Map(store.exportFiles().files);
    files.set("sounds/s/sound.json", JSON.stringify({ name: "s", entry: "main.js", runtime: 1 }));
    files.set("sounds/s/main.js", "1");
    const { store: withSound } = ProjectStore.open(files);
    const written = withSound?.execute({
      type: "file.write",
      params: { path: "sounds/s/main.js", text: "2" },
    });
    expect(written?.ok).toBe(true);
    expect(withSound?.getState().files["sounds/s/main.js"]).toBe("2");
  });

  it.each([
    ["outside of the code", "invalid-params", "assets/a.png"],
    ["a document of the format", "invalid-params", "scenes/title/scene.json"],
    ["the way up", "invalid-params", "scenes/../animaquill.json"],
    ["the folder of a scene", "invalid-params", "scenes/title"],
    ["a hidden file", "invalid-params", "code/.env"],
    ["installed packages", "invalid-params", "code/node_modules/a.js"],
    ["a scene that is not there", "not-found", "scenes/nope/a.js"],
    ["inside a file", "path-taken", "scenes/title/index.html/a.js"],
  ])("refuses a write to %s", (_, expected, path) => {
    const { state, run, code, addScene } = open();
    addScene();
    const before = state();
    expect(code(run("file.write", { path, text: "x" }))).toBe(expected);
    expect(state()).toBe(before);
  });

  it("refuses a file where a folder is", () => {
    const { run, ok, code, addScene } = open();
    addScene();
    ok(run("file.write", { path: "scenes/title/a/b.js", text: "x" }));
    expect(code(run("file.write", { path: "scenes/title/a", text: "x" }))).toBe("path-taken");
  });

  it("refuses more than a file can be, by what it takes in bytes", () => {
    const { run, ok, code, addScene } = open();
    addScene();
    const path = "scenes/title/big.js";
    const justRight = "a".repeat(MAX_SOURCE_BYTES);
    expect(ok(run("file.write", { path, text: justRight })).ok).toBe(true);
    expect(code(run("file.write", { path, text: `${justRight}a` }))).toBe("file-too-large");
    const wide = "好".repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1);
    expect(code(run("file.write", { path, text: wide }))).toBe("file-too-large");
  });

  it("removes a file, and undo brings it back", () => {
    const { store, state, run, ok, addScene } = open();
    addScene("title", { "index.html": PAGE, "a.js": "1" });
    ok(run("file.remove", { path: "scenes/title/a.js" }));
    expect(state().files["scenes/title/a.js"]).toBeUndefined();
    store.undo();
    expect(state().files["scenes/title/a.js"]).toBe("1");
  });

  it("keeps the file a scene starts with", () => {
    const { run, code, addScene } = open();
    addScene();
    expect(code(run("file.remove", { path: "scenes/title/index.html" }))).toBe("entry-in-use");
    expect(code(run("file.remove", { path: "scenes/title/none.js" }))).toBe("not-found");
  });

  it("renames a file", () => {
    const { store, state, run, ok, addScene } = open();
    addScene("title", { "index.html": PAGE, "a.js": "1" });
    ok(run("file.rename", { from: "scenes/title/a.js", to: "scenes/title/lib/b.js" }));
    expect(state().files["scenes/title/a.js"]).toBeUndefined();
    expect(state().files["scenes/title/lib/b.js"]).toBe("1");
    store.undo();
    expect(state().files["scenes/title/a.js"]).toBe("1");
    expect(state().files["scenes/title/lib/b.js"]).toBeUndefined();
  });

  it("renaming the entry takes the scene along, in one step", () => {
    const { store, state, run, ok, addScene } = open();
    addScene();
    ok(run("file.rename", { from: "scenes/title/index.html", to: "scenes/title/main.html" }));
    expect(state().scenes["title"]?.entry).toBe("main.html");
    store.undo();
    expect(state().scenes["title"]?.entry).toBe("index.html");
    expect(state().files["scenes/title/index.html"]).toBe(PAGE);
  });

  it.each([
    ["what is not there", "not-found", "scenes/title/none.js", "scenes/title/x.js"],
    ["onto another file", "path-taken", "scenes/title/a.js", "scenes/title/index.html"],
    ["the entry out of its scene", "entry-in-use", "scenes/title/index.html", "code/a.html"],
    [
      "the entry to what cannot run",
      "invalid-value",
      "scenes/title/index.html",
      "scenes/title/a.txt",
    ],
  ])("refuses to rename %s", (_, expected, from, to) => {
    const { state, run, code, addScene } = open();
    addScene("title", { "index.html": PAGE, "a.js": "1" });
    const before = state();
    expect(code(run("file.rename", { from, to }))).toBe(expected);
    expect(state()).toBe(before);
  });

  it("merges two people writing to one file", () => {
    const { store, run, ok, addScene } = open();
    addScene("title", { "index.html": "abc", "a.js": "1" });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
    const other = new ProjectStore(doc);
    ok(run("file.write", { path: "scenes/title/index.html", text: "Xabc" }));
    other.execute({
      type: "file.write",
      params: { path: "scenes/title/index.html", text: "abcY" },
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc, Y.encodeStateVector(doc)), "sync");
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(store.doc)), "sync");
    expect(store.getState().files["scenes/title/index.html"]).toBe("XabcY");
    expect(other.getState().files["scenes/title/index.html"]).toBe("XabcY");
  });

  it("takes back only what is still there", () => {
    const { store, state, run, ok, addScene } = open();
    addScene();
    ok(run("file.write", { path: "scenes/title/a.js", text: "mine" }));
    store.execute(
      { type: "file.write", params: { path: "scenes/title/a.js", text: "theirs" } },
      { origin: aiTask("t") },
    );
    const result = store.undo();
    expect(result.ok).toBe(false);
    expect(state().files["scenes/title/a.js"]).toBe("theirs");
  });
});

describe("an asset that code asks for", () => {
  const image = { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a" };

  function withLogo() {
    const project = open();
    project.ok(project.run("asset.add", { id: "logo", asset: image }));
    const remove = () => project.run("asset.remove", { asset: "logo" });
    return { ...project, remove };
  }

  const messageOf = (result: CommandResult) => (result.ok ? "" : result.error.message);

  it("stays while a scene names it, and people hear where", () => {
    const { state, code, addScene, remove } = withLogo();
    addScene("title", { "index.html": `<script>aq.asset("logo")</script>` });
    const result = remove();
    expect(code(result)).toBe("asset-in-use");
    expect(messageOf(result)).toContain("scenes/title/index.html");
    expect(state().assets?.["logo"]).toBeDefined();
  });

  it.each([
    ["other quotes", `aq.asset('logo')`],
    ["a template", "aq.asset(`logo`)"],
    ["spaces", `aq . asset( "logo" )`],
    ["code nobody runs", `// aq.asset("logo")`],
  ])("stays with %s", (_, text) => {
    const { code, addScene, remove } = withLogo();
    addScene("title", { "index.html": text });
    expect(code(remove())).toBe("asset-in-use");
  });

  it("stays while shared code names it, whether a scene uses that or not", () => {
    const { ok, run, code, remove } = withLogo();
    ok(run("file.write", { path: "code/logo.js", text: `aq.asset("logo")` }));
    const result = remove();
    expect(code(result)).toBe("asset-in-use");
    expect(messageOf(result)).toContain("code/logo.js");
  });

  it("stays while a parameter starts out with it", () => {
    const { code, addScene, remove } = withLogo();
    const params = [{ id: "p", name: "图", type: "asset", default: { asset: "logo" } }];
    addScene("title", { "index.html": PAGE }, { ...manifest, params } as SceneManifest);
    const result = remove();
    expect(code(result)).toBe("asset-in-use");
    expect(messageOf(result)).toContain("scenes/title");
  });

  it("can go once nothing names it any more, and that can be undone", () => {
    const { store, state, ok, run, addScene, remove } = withLogo();
    addScene("title", { "index.html": `aq.asset("logo")` });
    ok(run("file.write", { path: "scenes/title/index.html", text: PAGE }));
    ok(remove());
    expect(state().assets?.["logo"]).toBeUndefined();
    store.undo();
    expect(state().assets?.["logo"]).toBeDefined();
  });

  it.each([
    ["another asset", `aq.asset("logo-2")`],
    ["the word in a text", `<p>logo</p><script>const a = "logo"</script>`],
    ["an id that code works out, which nothing can see", `aq.asset("lo" + "go")`],
  ])("can go with %s", (_, text) => {
    const { ok, addScene, remove } = withLogo();
    addScene("title", { "index.html": text });
    ok(remove());
  });
});

describe("the file that says what a scene or sound is", () => {
  it("is no place for a file of the scene, nor for a folder of them", () => {
    const { run, code, addScene } = open();
    addScene("title", { "index.html": PAGE, "a.js": "" });
    expect(code(run("file.write", { path: "scenes/title/scene.json", text: "x" }))).not.toBe("ok");
    const inside = "scenes/title/scene.json/a.js";
    expect(code(run("file.write", { path: inside, text: "x" }))).toBe("path-taken");
    expect(code(run("file.rename", { from: "scenes/title/a.js", to: inside }))).toBe("path-taken");
  });

  it("is no place for one of a sound either", () => {
    const { run, code } = soundProject();
    const path = "sounds/beep/sound.json/a.js";
    expect(code(run("file.write", { path, text: "x" }))).toBe("path-taken");
  });
});

/** A project with a sound, which only comes in with a project for now. */
function soundProject() {
  const sound = { name: "响", entry: "main.js", runtime: 1 };
  const project = { ...createProject({ name: "声音" }), sounds: new Map([["beep", sound]]) };
  const store = ProjectStore.create(project, { "sounds/beep/main.js": "// beep" });
  const run = (type: string, params: object) => store.execute({ type, params } as CommandCall);
  const code = (result: CommandResult) => (result.ok ? "ok" : result.error.code);
  return { store, run, code, state: () => store.getState() };
}

describe("the entry of a sound", () => {
  it("can get another name in its folder, and the sound follows, in one step", () => {
    const { store, run, code, state } = soundProject();
    const result = run("file.rename", { from: "sounds/beep/main.js", to: "sounds/beep/start.js" });
    expect(code(result)).toBe("ok");
    expect(state().sounds["beep"]?.entry).toBe("start.js");
    expect(state().files["sounds/beep/start.js"]).toBe("// beep");
    store.undo();
    expect(state().sounds["beep"]?.entry).toBe("main.js");
    expect(state().files["sounds/beep/main.js"]).toBe("// beep");
  });

  it("does not leave its folder, also not for a scene of the same name", () => {
    const { run, code } = soundProject();
    expect(code(run("file.rename", { from: "sounds/beep/main.js", to: "code/main.js" }))).toBe(
      "entry-in-use",
    );
  });

  it("needs a name that can start it", () => {
    const { run, code } = soundProject();
    expect(
      code(run("file.rename", { from: "sounds/beep/main.js", to: "sounds/beep/main.ts" })),
    ).not.toBe("ok");
  });
});

describe("a clip of a scene", () => {
  const color = { kind: "color", color: "#000000" };

  it("needs a scene that is there", () => {
    const { track, run, code } = open();
    const clip = { start: "0", duration: "1", source: { kind: "scene", scene: "nope" } };
    expect(code(run("clip.add", { timeline: "main", track, clip }))).toBe("not-found");
  });

  it("can come along with its scene, in one step", () => {
    const { store, track, state } = open();
    const clip = { id: "c", start: "0", duration: "1", source: { kind: "scene", scene: "new" } };
    const files = { "index.html": PAGE };
    const result = store.executeBatch([
      { type: "scene.add", params: { id: "new", scene: manifest, files } },
      { type: "clip.add", params: { timeline: "main", track, clip } },
    ]);
    expect(result.ok).toBe(true);
    store.undo();
    expect(state().scenes).toEqual({});
    expect(state().timelines["main"]?.clips).toEqual({});
  });

  it("cannot be pointed at a scene that is not there", () => {
    const { track, run, ok, code, state } = open();
    const clip = { id: "c", start: "0", duration: "1", source: color };
    ok(run("clip.add", { timeline: "main", track, clip }));
    const changes = { source: { kind: "scene", scene: "nope" } };
    expect(code(run("clip.update", { timeline: "main", clip: "c", changes }))).toBe("not-found");
    expect(state().timelines["main"]?.clips["c"]?.source).toEqual(color);
  });

  it("can be something from a library, which is not in the project", () => {
    const { track, run, ok } = open();
    const source = { kind: "scene", library: "l", resource: "r" };
    const clip = { start: "0", duration: "1", source };
    ok(run("clip.add", { timeline: "main", track, clip }));
  });
});

describe("a locked project", () => {
  const locked = () => {
    const opened = open();
    opened.addScene();
    opened.ok(opened.run("project.setTags", { tags: [{ name: "已发布", locked: true }] }));
    return opened;
  };

  it.each([
    ["scene.add", { id: "b", scene: manifest, files: { "index.html": PAGE } }],
    ["scene.update", { scene: "title", changes: { name: "a" } }],
    ["scene.remove", { scene: "title" }],
    ["file.write", { path: "scenes/title/a.js", text: "1" }],
    ["file.remove", { path: "scenes/title/index.html" }],
    ["file.rename", { from: "scenes/title/index.html", to: "scenes/title/a.html" }],
  ])("refuses %s", (type, params) => {
    const { run, code } = locked();
    expect(code(run(type, params))).toBe("project-locked");
  });
});

describe("a scene on a locked track", () => {
  const onLocked = () => {
    const opened = open();
    opened.addScene("title", { "index.html": PAGE, "a.js": "1" });
    opened.addScene("free");
    opened.useScene();
    opened.ok(opened.run("file.write", { path: "code/shared.js", text: "1" }));
    opened.lock();
    return opened;
  };

  it.each([
    ["scene.update", { scene: "title", changes: { name: "a" } }],
    ["file.write", { path: "scenes/title/a.js", text: "2" }],
    ["file.write", { path: "scenes/title/new.js", text: "2" }],
    ["file.remove", { path: "scenes/title/a.js" }],
    ["file.rename", { from: "scenes/title/a.js", to: "scenes/title/b.js" }],
    ["file.write", { path: "code/shared.js", text: "2" }],
    ["file.write", { path: "code/new.js", text: "2" }],
    ["file.remove", { path: "code/shared.js" }],
  ])("stays as it is, for %s", (type, params) => {
    const { state, run, code } = onLocked();
    const before = state();
    expect(code(run(type, params))).toBe("track-locked");
    expect(code(run(type, params, aiTask("t")))).toBe("track-locked");
    expect(state()).toBe(before);
  });

  it("does not lose a file of it to another scene", () => {
    const { state, run, code } = onLocked();
    const before = state();
    const away = { from: "scenes/title/a.js", to: "scenes/free/a.js" };
    expect(code(run("file.rename", away))).toBe("track-locked");
    expect(state()).toBe(before);
  });

  it("does not get a file from another scene", () => {
    const { state, run, ok, code } = onLocked();
    ok(run("file.write", { path: "scenes/free/a.js", text: "1" }));
    const before = state();
    const over = { from: "scenes/free/a.js", to: "scenes/title/new.js" };
    expect(code(run("file.rename", over))).toBe("track-locked");
    expect(state()).toBe(before);
  });

  it("leaves other scenes open", () => {
    const { run, ok } = onLocked();
    ok(run("file.write", { path: "scenes/free/a.js", text: "1" }));
    ok(run("scene.update", { scene: "free", changes: { name: "a" } }));
  });

  it("opens again with the track", () => {
    const { run, ok, unlock } = onLocked();
    unlock();
    ok(run("file.write", { path: "scenes/title/a.js", text: "2" }));
  });

  it("also counts where a version shows it on a locked track", () => {
    const { store, track, run, ok, code, addScene, lock } = open();
    addScene();
    const clip = {
      id: "c",
      start: "0",
      duration: "1",
      source: { kind: "color", color: "#000000" },
    };
    ok(run("clip.add", { timeline: "main", track, clip }));
    const scene = { kind: "scene", scene: "title" };
    const version = {
      scope: { format: "landscape" },
      clips: { c: { source: { value: scene } } },
    };
    ok(store.importFile("timelines/main/overrides/format.landscape.json", JSON.stringify(version)));
    lock();
    expect(code(run("file.write", { path: "scenes/title/a.js", text: "1" }))).toBe("track-locked");
  });

  it("taking back a change to it counts as a change", () => {
    const { store, state, track, run, ok, addScene, useScene } = open();
    addScene();
    useScene();
    ok(run("file.write", { path: "scenes/title/a.js", text: "1" }));
    const changes = { locked: true };
    ok(run("track.update", { timeline: "main", track, changes }, aiTask("t")));
    const undone = store.undo();
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error.obstacle).toBe("locked");
    expect(state().files["scenes/title/a.js"]).toBe("1");
  });

  it("a new file of a scene in use can go back, with or without a clip", () => {
    const { store, state, run, ok, addScene, useScene } = open();
    addScene();
    useScene();
    ok(run("file.write", { path: "scenes/title/a.js", text: "1" }));
    expect(store.undo().ok).toBe(true);
    expect(state().files["scenes/title/a.js"]).toBeUndefined();
    expect(store.redo().ok).toBe(true);
    expect(state().files["scenes/title/a.js"]).toBe("1");
  });

  it("a file that came in from outside can go back past a lock, like a clip of a file", () => {
    const { store, state, run, ok, addScene, useScene, lock } = open();
    addScene();
    useScene();
    ok(run("file.write", { path: "scenes/title/a.js", text: "1" }));
    lock();
    ok(store.importFile("scenes/title/a.js", "from outside"));
    expect(state().files["scenes/title/a.js"]).toBe("from outside");
    expect(store.undo().ok).toBe(true);
    expect(state().files["scenes/title/a.js"]).toBe("1");
  });
});
