import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ExplorerState, nodeOfResource } from "./explorer.ts";
import {
  ASSETS_TAB_TYPES,
  parseProjectResourceId,
  parseTags,
  projectResourceId,
  projectResources,
} from "./project-resources.ts";
import { browse } from "./resources.ts";

function project() {
  const store = ProjectStore.create(createProject({ name: "资源" }));
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params } as never);
    if (!result.ok) throw new Error(result.error.message);
  };
  const asset = (id: string, kind: string, name?: string, tags?: string[]) =>
    run("asset.add", {
      id,
      asset: {
        ...(name && { name }),
        kind,
        path: `assets/${id}.bin`,
        storage: "local",
        ...(tags && { tags }),
      },
    });
  asset("video", "video", "采访.mp4", ["片头"]);
  asset("logo", "image");
  asset("voice", "audio", "配音.wav");
  asset("sans", "font", "思源黑体");
  asset("model", "model", "模型");
  run("scene.add", {
    id: "title",
    scene: { name: "标题", entry: "index.html", runtime: 1, tags: ["片头", "文字"] },
    files: { "index.html": "<h1>标题</h1>" },
  });
  return store;
}

describe("the resources of a project", () => {
  it("are its assets, scenes and sounds, by their types, with their names and tags", () => {
    const state = project().getState();
    const resources = projectResources(state, "p1");
    const byName = Object.fromEntries(resources.map((each) => [each.name, each]));
    expect(byName["采访.mp4"]).toMatchObject({
      id: "project:p1:asset:video",
      type: "media.video",
      tags: ["片头"],
      source: { kind: "project" },
    });
    // Without a name, a file is called by its own.
    expect(byName["logo.bin"]).toMatchObject({ type: "media.image", tags: [] });
    expect(byName["思源黑体"]?.type).toBe("font");
    expect(byName["模型"]?.type).toBe("file");
    expect(byName["标题"]).toMatchObject({ type: "scene", tags: ["片头", "文字"] });
    // The assets tab lists what can be used from it; other files only show in the explorer.
    expect(
      resources.filter(({ type }) => ASSETS_TAB_TYPES.has(type)).map(({ name }) => name),
    ).not.toContain("模型");
  });

  it("are found by their tags, and group by them", () => {
    const resources = projectResources(project().getState(), "p1");
    const found = browse(resources, { query: "片头", grouping: "tag", recent: [] });
    expect(found.map(({ key }) => key)).toEqual([
      { kind: "tag", tag: "片头" },
      { kind: "tag", tag: "文字" },
    ]);
    expect(found[0]?.items.map(({ name }) => name).toSorted()).toEqual(["标题", "采访.mp4"]);
  });

  it("have ids that say which project they are of, and where the explorer lists them", () => {
    const id = projectResourceId("p1", "asset", "a:b");
    expect(parseProjectResourceId(id)).toEqual({ project: "p1", kind: "asset", id: "a:b" });
    expect(parseProjectResourceId("transition:built-in:fade:enter")).toBeUndefined();
    expect(nodeOfResource(id)).toBe("project.media");
    expect(nodeOfResource(projectResourceId("p1", "scene", "t"))).toBe("project.scenes");
    expect(nodeOfResource(projectResourceId("p1", "sound", "s"))).toBe("project.sounds");
    expect(nodeOfResource("transition:built-in:fade:enter")).toBe("built-in.transitions");
    expect(nodeOfResource("effect:built-in:blur")).toBe("built-in.effects");
    expect(nodeOfResource("something else")).toBeUndefined();
  });
});

describe("tags as people type them", () => {
  it("are split by 、, commas and spaces, each once", () => {
    expect(parseTags("片头、 竖屏可用,科技风，片头  ")).toEqual(["片头", "竖屏可用", "科技风"]);
    expect(parseTags("  ")).toEqual([]);
  });
});

describe("the place in the explorer", () => {
  it("goes to a resource where it is listed, and says so each time", () => {
    const explorer = new ExplorerState();
    let heard = 0;
    explorer.subscribe(() => (heard += 1));
    expect(explorer.reveal("effect:built-in:blur")).toBe(true);
    expect(explorer.getSnapshot()).toEqual({
      node: "built-in.effects",
      selected: "effect:built-in:blur",
      revealed: 1,
    });
    explorer.reveal("effect:built-in:blur");
    expect(explorer.getSnapshot().revealed).toBe(2);
    expect(explorer.reveal("nowhere")).toBe(false);
    explorer.choose("missing");
    explorer.choose("missing");
    expect(heard).toBe(3);
  });
});
