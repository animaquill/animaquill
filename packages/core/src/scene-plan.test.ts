import { createProject, type SceneManifest } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { orderedTracks } from "./model.ts";
import { buildRenderPlan, samePlan, type RenderLayer } from "./render-plan.ts";
import { hashOfText, sceneFilesOf, sceneSourceOf, type SceneSource } from "./scene-plan.ts";
import { ProjectStore, USER } from "./store.ts";

const manifest: SceneManifest = { name: "标题", entry: "index.html", runtime: 1 };

function setup(format?: { width: number; height: number; fps: string }) {
  const store = ProjectStore.create(
    createProject({
      name: "计划",
      ...(format ? { format: { id: "wide", name: "宽", ...format } } : {}),
    }),
  );
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(result.error.message);
  };
  const main = store.getState().timelines["main"];
  const track = main && orderedTracks(main).find(({ kind }) => kind === "video")?.id;
  const addScene = (id = "title", files: object = { "index.html": "<p>a</p>" }, scene = manifest) =>
    run("scene.add", { id, scene, files });
  const addClip = (id = "c", scene = "title", extra: object = {}) =>
    run("clip.add", {
      timeline: "main",
      track,
      clip: { id, start: "1", duration: "2", source: { kind: "scene", scene }, ...extra },
    });
  const plan = () => {
    const result = buildRenderPlan(store.getState(), "main");
    if (!result) throw new Error("no plan");
    return result;
  };
  const layer = (id = "c") => plan().layers.find((candidate) => candidate.id === id) as RenderLayer;
  const source = (id = "c") => layer(id).source as SceneSource;
  return { store, run, addScene, addClip, plan, layer, source };
}

describe("a scene in the render plan", () => {
  it("says what to start and what it is written for", () => {
    const { addScene, addClip, source } = setup();
    addScene();
    addClip();
    expect(source()).toMatchObject({
      kind: "scene",
      scene: "title",
      entry: "scenes/title/index.html",
      runtime: 1,
    });
  });

  it("takes its time and curves like any other clip", () => {
    const { addScene, addClip, layer } = setup();
    addScene();
    addClip("c", "title", { offset: "1/2", properties: { "transform.x": 100 } });
    expect(layer()).toMatchObject({ start: 1, end: 3, offset: 0.5 });
    expect(layer().channels["transform.x"]).toBeDefined();
  });

  it("is laid out for its box, so nothing has to fit, whatever the clip says", () => {
    const { addScene, addClip, layer } = setup();
    addScene();
    addClip("c", "title", { properties: { fit: "cover" } });
    expect(layer().fit).toBe("fixed");
  });

  it("is left out when the scene is not there", () => {
    const { store, run, addClip, addScene, plan } = setup();
    addScene();
    addClip();
    run("clip.remove", { timeline: "main", clips: ["c"] });
    run("scene.remove", { scene: "title" });
    store.importFile(
      "timelines/main/timeline.json",
      store.exportFiles().files.get("timelines/main/timeline.json") as string,
      { origin: USER },
    );
    expect(plan().layers).toEqual([]);
  });

  it("is left out for a template of a library, which comes later", () => {
    const { store, run, plan } = setup();
    const main = store.getState().timelines["main"];
    const track = main && orderedTracks(main).find(({ kind }) => kind === "video")?.id;
    const source = { kind: "scene", library: "l", resource: "r" };
    const clip = { id: "c", start: "0", duration: "1", source };
    run("clip.add", { timeline: "main", track, clip });
    expect(plan().layers).toEqual([]);
  });

  it("tells scenes what they are shown as", () => {
    const { plan } = setup({ width: 1280, height: 720, fps: "30000/1001" });
    expect(plan().scenes).toEqual({
      format: "wide",
      language: "zh-CN",
      fps: { num: 30000, den: 1001 },
    });
  });
});

describe("what a scene gets", () => {
  it("is its own folder and the shared code, and nothing of other scenes", () => {
    const { store, run, addScene } = setup();
    addScene("title", { "index.html": "a", "lib/b.js": "b" });
    addScene("other", { "index.html": "secret" });
    run("file.write", { path: "code/shared.js", text: "c" });
    expect(sceneFilesOf(store.getState(), "title")).toEqual([
      "code/shared.js",
      "scenes/title/index.html",
      "scenes/title/lib/b.js",
    ]);
  });

  it("does not get a folder that starts the same", () => {
    const { store, addScene } = setup();
    addScene("a", { "index.html": "a" });
    addScene("a-b", { "index.html": "b" });
    expect(sceneFilesOf(store.getState(), "a")).toEqual(["scenes/a/index.html"]);
  });

  it("gets the assets it names, and only those", () => {
    const { run, addScene, addClip, source } = setup();
    const asset = (hash: string) => ({
      kind: "image",
      path: `assets/${hash}.png`,
      storage: "local",
      hash,
    });
    run("asset.add", { id: "logo", asset: asset("sha256-logo") });
    run("asset.add", { id: "photo", asset: asset("sha256-photo") });
    run("asset.add", { id: "secret", asset: asset("sha256-secret") });
    addScene("title", {
      "index.html": `<script>const a = aq.asset("logo"); const b = aq . asset( 'photo' );</script>`,
    });
    addClip();
    expect(source().assets).toEqual([
      { id: "logo", file: "sha256-logo" },
      { id: "photo", file: "sha256-photo" },
    ]);
  });

  it("gets what shared code names", () => {
    const { run, addScene, addClip, source } = setup();
    const asset = { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a" };
    run("asset.add", { id: "logo", asset });
    addScene();
    run("file.write", { path: "code/shared.js", text: `aq.asset("logo")` });
    addClip();
    expect(source().assets).toEqual([{ id: "logo", file: "sha256-a" }]);
  });

  it("gets what a parameter starts out with", () => {
    const { run, addScene, addClip, source } = setup();
    const asset = { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a" };
    run("asset.add", { id: "logo", asset });
    const param = { id: "p", name: "图", type: "asset", default: { asset: "logo" } };
    addScene("title", undefined, { ...manifest, params: [param] } as SceneManifest);
    addClip();
    expect(source().assets).toEqual([{ id: "logo", file: "sha256-a" }]);
  });

  it("does not get what has no file yet", () => {
    const { run, addScene, addClip, source } = setup();
    run("asset.add", { id: "logo", asset: { kind: "image", path: "a.png", storage: "local" } });
    addScene("title", { "index.html": `aq.asset("logo"); aq.asset("nothing")` });
    addClip();
    expect(source().assets).toEqual([]);
  });
});

describe("the revision of a scene", () => {
  const changes: readonly (readonly [string, string, object])[] = [
    ["its page", "file.write", { path: "scenes/title/index.html", text: "new" }],
    ["a file next to it", "file.write", { path: "scenes/title/a.js", text: "new" }],
    ["shared code", "file.write", { path: "code/shared.js", text: "new" }],
    ["which file is the entry", "scene.update", { scene: "title", changes: { entry: "a.html" } }],
  ];

  it.each(changes)("changes with %s", (_, type, params) => {
    const { run, addScene, addClip, source } = setup();
    addScene("title", { "index.html": "a", "a.html": "b" });
    addClip();
    const before = source().revision;
    run(type, params);
    expect(source().revision).not.toBe(before);
  });

  it("changes with the file of an asset", () => {
    const { run, addScene, addClip, source } = setup();
    const asset = { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a" };
    run("asset.add", { id: "logo", asset });
    addScene("title", { "index.html": `aq.asset("logo")` });
    addClip();
    const before = source().revision;
    run("file.write", { path: "scenes/title/index.html", text: "" });
    run("asset.remove", { asset: "logo" });
    run("asset.add", { id: "logo", asset: { ...asset, hash: "sha256-b" } });
    run("file.write", { path: "scenes/title/index.html", text: `aq.asset("logo")` });
    expect(source().revision).not.toBe(before);
  });

  it("does not change with another scene, and the plan stays the same", () => {
    const { run, addScene, addClip, plan, source } = setup();
    addScene();
    addScene("other");
    addClip();
    const before = plan();
    const { revision } = source();
    run("file.write", { path: "scenes/other/index.html", text: "new" });
    expect(source().revision).toBe(revision);
    expect(samePlan(before, plan())).toBe(true);
  });

  it("does not change with its name, which it knows nothing of", () => {
    const { run, addScene, addClip, plan } = setup();
    addScene();
    addClip();
    const before = plan();
    run("scene.update", { scene: "title", changes: { name: "新名字" } });
    expect(samePlan(before, plan())).toBe(true);
  });

  it("is what the content says, so that undo comes back to it", () => {
    const { store, run, addScene, addClip, source } = setup();
    addScene();
    addClip();
    const before = source().revision;
    run("file.write", { path: "scenes/title/index.html", text: "new" });
    store.undo();
    expect(source().revision).toBe(before);
  });

  it("tells a change from a move of the same text to another file", () => {
    const { run, addScene, addClip, source } = setup();
    addScene("title", { "index.html": "a", "a.js": "b" });
    addClip();
    const before = source().revision;
    run("file.rename", { from: "scenes/title/a.js", to: "scenes/title/b.js" });
    expect(source().revision).not.toBe(before);
  });
});

describe("what stays the same", () => {
  it("a plan sees a new layer only for a clip that changed", () => {
    const { run, addScene, addClip, layer } = setup();
    addScene();
    addClip("a");
    addClip("b", "title", { start: "5" });
    const [a, b] = [layer("a"), layer("b")];
    run("clip.setProperty", { timeline: "main", clip: "b", path: "opacity", value: 0.5 });
    expect(layer("a")).toBe(a);
    expect(layer("b")).not.toBe(b);
  });

  it("gives the same seed to both halves of a clip that got cut", () => {
    const { run, addScene, addClip, plan } = setup();
    addScene();
    addClip();
    run("clip.split", { timeline: "main", clip: "c", at: "2", id: "d" });
    const [left, right] = plan().layers.map(({ source }) => source as SceneSource);
    expect(left?.seed).toBe(right?.seed);
  });

  it("gives scenes a seed of their own", () => {
    const { store, addScene } = setup();
    addScene("a");
    addScene("b");
    const [a, b] = ["a", "b"].map((id) => sceneSourceOf(store.getState(), id));
    expect(a?.seed).not.toBe(b?.seed);
    expect(Number.isSafeInteger(a?.seed)).toBe(true);
  });

  it("looks at a large file once, however many times the plan is built", () => {
    const { store, run, addScene, addClip } = setup();
    addScene("title", { "index.html": "a".repeat(8 * 1024 * 1024) });
    addClip();
    buildRenderPlan(store.getState(), "main");
    const started = performance.now();
    for (let round = 0; round < 50; round += 1) {
      run("clip.setProperty", { timeline: "main", clip: "c", path: "opacity", value: round / 50 });
      run("file.write", { path: "scenes/title/small.js", text: String(round) });
      buildRenderPlan(store.getState(), "main");
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("a hash", () => {
  it("tells texts apart that differ in one place", () => {
    const hashes = new Set(Array.from({ length: 20000 }, (_, index) => hashOfText(`a${index}b`)));
    expect(hashes.size).toBe(20000);
  });

  it("is the same on every run, because it is part of what a plan compares", () => {
    expect(hashOfText("animation")).toBe(hashOfText("animation"));
    expect(hashOfText("")).not.toBe(hashOfText(" "));
  });
});
