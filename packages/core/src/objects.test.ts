import { BUILT_IN_PROPERTIES, CLIP_VISUAL, createProject } from "@animaquill/schema";
import type { PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { ClipState } from "./model.ts";
import { naturalSizeOf, objectsOf, valueWithout } from "./objects.ts";
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

  it.each(["audio", "sound", "music", "scene", "timeline", "caption", "plugin.lottie"])(
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
