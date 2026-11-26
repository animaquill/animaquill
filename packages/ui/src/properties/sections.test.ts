import { objectsOf, ProjectStore, type ClipState } from "@animaquill/core";
import type { SettingsStore } from "@animaquill/host";
import { CLIP_SOUND, CLIP_VISUAL, MASTER_SOUND, SCENE_VISUAL } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { COLLAPSED_LIMIT, PROPERTY_SECTIONS_KEY, PropertySections } from "./collapsed.ts";
import { sectionsOf } from "./sections.ts";

const paths = (section: { object: { properties: readonly { path: string }[] } }) =>
  section.object.properties.map(({ path }) => path);

describe("the groups of the properties tab", () => {
  it("split the picture of a clip into where it is and how it shows", () => {
    const sections = sectionsOf([CLIP_VISUAL]);
    expect(sections.map(({ id }) => id)).toEqual(["transform", "opacity"]);
    expect(paths(sections[0]!)).toEqual([
      "transform.x",
      "transform.y",
      "transform.width",
      "transform.height",
      "transform.anchorX",
      "transform.anchorY",
      "transform.scale",
      "transform.rotation",
      "fit",
    ]);
    expect(paths(sections[1]!)).toEqual(["opacity", "blend"]);
    // A scene has no fit, and the same groups.
    expect(sectionsOf([SCENE_VISUAL]).map(({ id }) => id)).toEqual(["transform", "opacity"]);
  });

  it("have sound, the master and every other object as one each", () => {
    expect(sectionsOf([CLIP_SOUND]).map(({ id, kind }) => [id, kind])).toEqual([
      ["sound", "sound"],
    ]);
    expect(sectionsOf([MASTER_SOUND]).map(({ id }) => id)).toEqual(["master"]);
    const params = { id: "params", type: "scene.params", properties: CLIP_SOUND.properties };
    const empty = { id: "nothing", properties: [] };
    expect(sectionsOf([params, empty]).map(({ id }) => id)).toEqual(["object:params"]);
  });

  it("put speed in a group of its own, and keep what they do not know with its object", () => {
    const speed = { path: "time.speed", type: "number" } as const;
    const own = { path: "glow", type: "number" } as const;
    const visual = { ...CLIP_VISUAL, properties: [...CLIP_VISUAL.properties, speed, own] };
    const sections = sectionsOf([visual]);
    expect(sections.map(({ id }) => id)).toEqual([
      "transform",
      "opacity",
      "speed",
      "object:visual",
    ]);
    expect(paths(sections[3]!)).toEqual(["glow"]);
  });

  it("are the same for the clips of the example as their objects say", () => {
    const { store } = ProjectStore.open(loadFixture("v1"));
    if (!store) throw new Error("The example did not open");
    const clips = store.getState().timelines["main"]!.clips;
    const ids = (clip: ClipState) => sectionsOf(objectsOf(clip)).map(({ id }) => id);
    expect(ids(clips["clip_voice"]!)).toEqual(["sound"]);
    expect(ids(clips["clip_title"]!)).toEqual(["transform", "opacity"]);
  });
});

function settings() {
  const saved = new Map<string, unknown>();
  let other: (value: unknown) => void = () => {};
  const store: SettingsStore = {
    load: async (key) => saved.get(key),
    save: async (key, value) => void saved.set(key, value),
    listen: (_, listener) => {
      other = listener;
      return () => {};
    },
  };
  return { store, saved, fromOtherWindow: (value: unknown) => other(value) };
}

describe("the groups people folded up", () => {
  it("are kept by the kind of clip, and come back", async () => {
    const { store, saved } = settings();
    const sections = new PropertySections(store);
    await sections.load();
    expect(sections.isCollapsed("video", "transform")).toBe(false);
    sections.set("video", ["transform"], true);
    sections.set("video", ["transform", "opacity"], true);
    sections.set("scene", ["object:params"], true);
    sections.set("video", ["transform"], false);
    expect(sections.collapsedFor("video")).toEqual(["opacity"]);
    expect(sections.collapsedFor("scene")).toEqual(["object:params"]);
    expect(sections.collapsedFor("image")).toEqual([]);
    expect(saved.get(PROPERTY_SECTIONS_KEY)).toMatchObject({ version: 1 });
    const again = new PropertySections(store);
    await again.load();
    expect(again.collapsedFor("video")).toEqual(["opacity"]);
  });

  it("follow other windows, ignore what they cannot read, and keep only so many", async () => {
    const { store, fromOtherWindow } = settings();
    const sections = new PropertySections(store);
    await sections.load();
    fromOtherWindow({ version: 1, collapsed: { video: ["sound", 3], image: "nonsense" } });
    expect(sections.collapsedFor("video")).toEqual(["sound"]);
    expect(sections.collapsedFor("image")).toEqual([]);
    fromOtherWindow("broken");
    expect(sections.collapsedFor("video")).toEqual(["sound"]);
    const many = Array.from({ length: COLLAPSED_LIMIT + 5 }, (_, index) => `effect:${index}`);
    sections.set("audio", many, true);
    expect(sections.collapsedFor("audio")).toHaveLength(COLLAPSED_LIMIT);
    expect(sections.collapsedFor("audio").at(-1)).toBe(many.at(-1));
  });
});
