import {
  ProjectStore,
  buildRenderPlan,
  orderedTracks,
  type RenderLayer,
  type RenderPlan,
  type SceneSource,
} from "@animaquill/core";
import { RUNTIME_VERSION } from "@animaquill/scene";
import { CURRENT_SCENE_RUNTIME, createProject } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { sceneContent } from "./content.ts";

function setup() {
  const store = ProjectStore.create(createProject({ name: "内容" }));
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(result.error.message);
  };
  const scene = { name: "a", entry: "index.html", runtime: 1 };
  const asset = (hash: string) => ({ kind: "image", path: "a.png", storage: "local", hash });
  run("asset.add", { id: "logo", asset: asset("sha256-logo") });
  run("asset.add", { id: "secret", asset: asset("sha256-secret") });
  run("scene.add", {
    id: "a",
    scene,
    files: { "index.html": `<p>a</p><script>aq.asset("logo")</script>`, "b.js": "1" },
  });
  run("scene.add", { id: "other", scene, files: { "index.html": "secret" } });
  run("file.write", { path: "code/shared.js", text: "2" });
  const main = store.getState().timelines["main"];
  const track = main && orderedTracks(main).find(({ kind }) => kind === "video")?.id;
  const source = { kind: "scene", scene: "a" };
  const clip = { id: "c", start: "0", duration: "1", source };
  run("clip.add", { timeline: "main", track, clip });
  const plan = buildRenderPlan(store.getState(), "main");
  const [layer] = (plan as RenderPlan).layers;
  const { revision } = (layer as RenderLayer).source as SceneSource;
  const media = vi.fn(async (hash: string) => new Blob([hash]));
  return { store, plan, revision, media };
}

describe("the runtime", () => {
  it("is the one projects get written for", () => {
    expect(RUNTIME_VERSION).toBe(CURRENT_SCENE_RUNTIME);
  });
});

describe("what a scene gets", () => {
  it("is its own files, shared code and the assets it names", async () => {
    const { store, plan, revision, media } = setup();
    const content = await sceneContent(store.getState(), plan, { scene: "a", revision }, media);
    expect([...(content?.files.keys() ?? [])]).toEqual([
      "code/shared.js",
      "scenes/a/b.js",
      "scenes/a/index.html",
    ]);
    expect([...(content?.assets.keys() ?? [])]).toEqual(["logo"]);
    expect(await content?.files.get("scenes/a/b.js")?.text()).toBe("1");
    expect(media).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledWith("sha256-logo");
  });

  it("is nothing for a scene the plan does not show, however it asks", async () => {
    const { store, plan, revision, media } = setup();
    const asked = { scene: "other", revision };
    expect(await sceneContent(store.getState(), plan, asked, media)).toBeUndefined();
    expect(media).not.toHaveBeenCalled();
  });

  it("is nothing for a state the plan is not about", async () => {
    const { store, plan, media } = setup();
    const asked = { scene: "a", revision: "something else" };
    expect(await sceneContent(store.getState(), plan, asked, media)).toBeUndefined();
  });

  it("is nothing without a plan", async () => {
    const { store, revision, media } = setup();
    const asked = { scene: "a", revision };
    expect(await sceneContent(store.getState(), undefined, asked, media)).toBeUndefined();
  });

  it("goes without an asset that cannot be read", async () => {
    const { store, plan, revision } = setup();
    const asked = { scene: "a", revision };
    const broken = () => Promise.reject(new Error("no such file"));
    const content = await sceneContent(store.getState(), plan, asked, broken);
    expect(content?.assets.size).toBe(0);
  });

  it("goes without an asset that is not there", async () => {
    const { store, plan, revision } = setup();
    const asked = { scene: "a", revision };
    const content = await sceneContent(store.getState(), plan, asked, async () => undefined);
    expect(content?.assets.size).toBe(0);
    expect(content?.files.size).toBe(3);
  });
});
