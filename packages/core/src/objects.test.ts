import {
  BUILT_IN_PROPERTIES,
  CLIP_SOUND,
  CLIP_VISUAL,
  SCENE_VISUAL,
  createProject,
} from "@animaquill/schema";
import type { ObjectDescriptor, PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { ClipState } from "./model.ts";
import {
  SCENE_OBJECT_TYPES,
  describeClip,
  nameKeyOf,
  naturalSizeOf,
  objectsOf,
  valueWithout,
  type SceneRegistry,
} from "./objects.ts";
import type { Registration } from "./registration.ts";
import { ProjectStore } from "./store.ts";

const spec = (path: string) => BUILT_IN_PROPERTIES[path] as PropertySpec;

const clip = (source: object, extra: object = {}) =>
  ({ id: "c", start: "2", duration: "5", track: "t", source, ...extra }) as ClipState;

function state(info?: object) {
  const store = ProjectStore.create(createProject({ name: "对象" }));
  const asset = {
    kind: "image",
    path: "assets/a.png",
    storage: "local",
    ...(info ? { info } : {}),
  };
  store.execute({ type: "asset.add", params: { id: "a", asset } });
  return store.getState();
}

const image = { kind: "image", media: { asset: "a" } };
const color = { kind: "color", color: "#000000" };

describe("what a clip offers", () => {
  it.each(["video", "image", "color"])("a %s has a picture to place", (kind) => {
    expect(objectsOf(clip({ kind }))).toEqual([CLIP_VISUAL]);
  });

  it("a scene has a picture to place, and nothing has to fit in its box", () => {
    expect(objectsOf(clip({ kind: "scene" }))).toEqual([SCENE_VISUAL]);
    const paths = SCENE_VISUAL.properties.map(({ path }) => path);
    expect(paths).toEqual(
      CLIP_VISUAL.properties.map(({ path }) => path).filter((p) => p !== "fit"),
    );
  });

  it("a sound made by code has its volume", () => {
    expect(objectsOf(clip({ kind: "sound" }))).toEqual([CLIP_SOUND]);
  });

  it.each(["audio", "music", "timeline", "caption", "plugin.lottie"])(
    "a %s has nothing to place yet",
    (kind) => {
      expect(objectsOf(clip({ kind }))).toEqual([]);
    },
  );
});

describe("the size of media", () => {
  it("is what the project knows about the file", () => {
    expect(naturalSizeOf(state({ width: 640, height: 480 }), clip(image))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it.each([
    ["no facts about the file", state(), image],
    ["only half of them", state({ width: 640 }), image],
    ["a file it does not know", state(), { kind: "image", media: { asset: "nope" } }],
    ["a file of a library", state(), { kind: "image", media: { library: "l", path: "a.png" } }],
    ["no file at all", state(), color],
  ])("is not known with %s", (_, project, source) => {
    expect(naturalSizeOf(project, clip(source))).toBeUndefined();
  });
});

describe("a property without a value", () => {
  it("uses its default", () => {
    expect(valueWithout(state(), clip(color), spec("transform.scale"), 3)).toBe(1);
    expect(valueWithout(state(), clip(color), spec("fit"), 3)).toBe("contain");
  });

  it("has a clip box that follows the stage", () => {
    expect(valueWithout(state(), clip(color), spec("transform.width"), 3)).toBe(1920);
    expect(valueWithout(state(), clip(color), spec("transform.height"), 3)).toBe(1080);
  });

  it("has a clip box that follows the media with fixed", () => {
    const fixed = clip(image, { properties: { fit: "fixed" } });
    const project = state({ width: 640, height: 480 });
    expect(valueWithout(project, fixed, spec("transform.width"), 3)).toBe(640);
  });

  it("follows the other side at this moment, on the clock of the clip", () => {
    const keys = [
      { time: "1", value: 100 },
      { time: "3", value: 300 },
    ];
    const moving = clip(color, { offset: "1", properties: { "transform.width": { keys } } });
    // At 3 on the timeline the clock reads 2, so the width is 200, and the stage is 16 by 9.
    expect(valueWithout(state(), moving, spec("transform.height"), 3)).toBeCloseTo(112.5, 9);
  });

  it("follows the stage of the version being looked at", () => {
    const project = createProject({ name: "画幅" });
    const vertical = { id: "vertical", name: "竖屏", width: 1080, height: 1920, fps: "30" };
    const manifest = { ...project.manifest, formats: [...project.manifest.formats, vertical] };
    const twoFormats = ProjectStore.create({ ...project, manifest }).getState();
    const version = { format: "vertical" };
    const width = spec("transform.width");
    const height = spec("transform.height");
    expect(valueWithout(twoFormats, clip(color), width, 3, version)).toBe(1080);
    expect(valueWithout(twoFormats, clip(color), height, 3, version)).toBe(1920);
    expect(valueWithout(twoFormats, clip(color), width, 3)).toBe(1920);
  });

  it("is nothing for a version that is not there", () => {
    const version = { format: "nothing" };
    expect(valueWithout(state(), clip(color), spec("transform.width"), 3, version)).toBeUndefined();
  });

  it("is nothing where there is nothing to go on", () => {
    const open = { path: "param.size", type: "number" } as const;
    expect(valueWithout(state(), clip(color), open, 3)).toBeUndefined();
  });
});

describe("what a clip with a scene offers", () => {
  const sceneState = (params?: readonly object[]) => {
    const store = ProjectStore.create(createProject({ name: "场景" }));
    const scene = { name: "标题", entry: "index.html", runtime: 1, ...(params && { params }) };
    store.execute({
      type: "scene.add",
      params: { id: "s", scene, files: { "index.html": "<p id=logo>标题</p>" } },
    });
    return store.getState();
  };
  const sceneClip = (properties: object = {}) =>
    clip({ kind: "scene", scene: "s" }, { properties }) as ClipState;
  const registry = (registration: Registration | undefined): SceneRegistry => ({
    registrationOf: () => registration,
  });
  const registration = (extra: Partial<Registration> = {}): Registration => ({
    objects: [],
    elements: [],
    complete: true,
    ...extra,
  });
  const paths = (objects: readonly ObjectDescriptor[]) =>
    objects.map(({ id, properties }) => [id, properties.map(({ path }) => path)]);

  it("is its picture until its code ran", () => {
    const described = describeClip(sceneState(), sceneClip(), undefined);
    expect(described).toEqual({ objects: [SCENE_VISUAL], ran: "never" });
  });

  it("has the parameters of its scene, which do not need the code to run", () => {
    const params = [
      { id: "title", name: "标题", type: "text", default: "你好" },
      { id: "size", name: "字号", type: "number", default: 64, min: 12, max: 200 },
      { id: "颜色", name: "颜色", type: "color" },
    ];
    const { objects } = describeClip(sceneState(params), sceneClip(), undefined);
    expect(objects[1]).toEqual({
      id: "params",
      type: SCENE_OBJECT_TYPES.params,
      properties: [
        { path: "param.title", type: "text", name: "标题", default: "你好" },
        { path: "param.size", type: "number", name: "字号", default: 64, min: 12, max: 200 },
      ],
    });
  });

  it("has the elements of its page, below one object for all of them", () => {
    const found = registration({
      elements: [
        { id: "logo", kind: "html", start: { color: "#ff0000" } },
        { id: "dot", kind: "svg" },
      ],
    });
    const { objects } = describeClip(sceneState(), sceneClip(), registry(found));
    expect(objects.map(({ id, parent }) => [id, parent])).toEqual([
      ["visual", undefined],
      ["elements", undefined],
      ["element.logo", "elements"],
      ["element.dot", "elements"],
    ]);
    const logo = objects[2]?.properties;
    expect(logo?.map(({ path }) => path)).toContain("element.logo.background");
    expect(logo?.find(({ path }) => path === "element.logo.color")?.default).toBe("#ff0000");
    expect(objects[3]?.properties.map(({ path }) => path)).toContain("element.dot.fill");
  });

  it("has what its code registered, with the paths of the clip", () => {
    const found = registration({
      objects: [
        { id: "rig", properties: [] },
        {
          id: "rig.arm",
          name: "手臂",
          parent: "rig",
          presence: "shown",
          spans: [[0, 2]],
          properties: [
            { path: "shown", type: "boolean", default: true },
            { path: "rotation", type: "angle", default: 0, name: "转动" },
          ],
        },
      ],
    });
    const { objects, ran } = describeClip(sceneState(), sceneClip(), registry(found));
    expect(ran).toBe("complete");
    expect(objects.slice(1)).toEqual([
      { id: "object.rig", name: "rig", properties: [] },
      {
        id: "object.rig.arm",
        name: "手臂",
        parent: "object.rig",
        spans: [[0, 2]],
        presence: "object.rig.arm.shown",
        properties: [
          { path: "object.rig.arm.shown", type: "boolean", default: true, name: "shown" },
          { path: "object.rig.arm.rotation", type: "angle", default: 0, name: "转动" },
        ],
      },
    ]);
  });

  it("says when its code did not get through loading", () => {
    const { ran } = describeClip(
      sceneState(),
      sceneClip(),
      registry(registration({ complete: false })),
    );
    expect(ran).toBe("partial");
  });

  it("reads keys from a path a property went by before, as long as its own path has none", () => {
    const found = registration({
      objects: [
        {
          id: "arm_l",
          aliases: ["arm"],
          properties: [
            { path: "rotation", type: "angle", default: 0, aliases: ["angle"] },
            { path: "x", type: "number", default: 0 },
          ],
        },
      ],
    });
    const keys = { keys: [{ time: "0", value: 10 }] };
    const at = (properties: object) =>
      describeClip(sceneState(), sceneClip(properties), registry(found));
    const renamed = at({ "object.arm.angle": keys, "object.arm.x": 3 });
    expect(paths(renamed.objects.slice(1))).toEqual([
      ["object.arm_l", ["object.arm.angle", "object.arm.x"]],
    ]);
    expect(renamed.renames).toEqual([
      { from: "object.arm.angle", to: "object.arm_l.rotation" },
      { from: "object.arm.x", to: "object.arm_l.x" },
    ]);
    const own = at({ "object.arm_l.rotation": keys, "object.arm_l.angle": keys });
    expect(paths(own.objects.slice(1))).toEqual([
      ["object.arm_l", ["object.arm_l.rotation", "object.arm_l.x"]],
    ]);
    expect(own.renames).toBeUndefined();
  });

  it("stays the same for every clip without keys under older paths", () => {
    const found = registration({ objects: [{ id: "a", aliases: ["b"], properties: [] }] });
    const project = sceneState();
    const first = describeClip(project, sceneClip({ "object.a.x": 1 }), registry(found));
    const second = describeClip(project, sceneClip(), registry(found));
    expect(first.objects).toBe(second.objects);
  });
});

describe("the name of a property", () => {
  it("of an element is the name of its kind of property", () => {
    expect(nameKeyOf("element.logo.opacity")).toBe("element.opacity");
    expect(nameKeyOf("transform.x")).toBe("transform.x");
    expect(nameKeyOf("object.logo.opacity")).toBe("object.logo.opacity");
  });
});
