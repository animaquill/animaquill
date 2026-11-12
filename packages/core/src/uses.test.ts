import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import type { ProjectState } from "./model.ts";
import { ProjectStore, type CommandCall, type CommandResult } from "./store.ts";
import { missingIn, usesOf } from "./uses.ts";

/** The example project without its locked tag. */
function example(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("The example did not open");
  return store;
}

const run = (store: ProjectStore, type: string, params: object): CommandResult =>
  store.execute({ type, params } as CommandCall);

const ok = (result: CommandResult) => {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
};

const clipsOf = (store: ProjectStore) => Object.keys(store.getState().timelines["main"]!.clips);

describe("where a resource is used", () => {
  it("finds the clips of an asset, and versions that show a clip with it", () => {
    const state = example().getState();
    expect(usesOf(state, { kind: "asset", id: "narration-zh" })).toEqual([
      { timeline: "main", clip: "clip_voice" },
    ]);
    expect(usesOf(state, { kind: "asset", id: "narration-en" })).toEqual([
      { timeline: "main", clip: "clip_voice", version: "language.en" },
    ]);
    expect(usesOf(state, { kind: "asset", id: "raw-footage" })).toEqual([]);
  });

  it("finds scenes, sounds, effects and transitions, in the order of the timeline", () => {
    const state = example().getState();
    expect(usesOf(state, { kind: "scene", id: "title" })).toEqual([
      { timeline: "main", clip: "clip_title" },
    ]);
    expect(usesOf(state, { kind: "sound", id: "impacts" })).toEqual([
      { timeline: "main", clip: "clip_hit" },
    ]);
    const blur = usesOf(state, { kind: "effect", type: "blur" });
    expect(blur).toEqual([
      { timeline: "main", clip: "clip_interview", effect: expect.any(String) },
    ]);
    // A fade going in is not a fade between clips, and both are not a fade going out.
    expect(usesOf(state, { kind: "transition", use: "enter", ref: { type: "fade" } })).toEqual([
      { timeline: "main", clip: "clip_title", edge: "enter" },
      { timeline: "main", clip: "clip_interview_audio", edge: "enter" },
    ]);
    expect(usesOf(state, { kind: "transition", use: "join", ref: { type: "fade" } })).toEqual([
      { timeline: "main", join: "join_1", clip: "clip_title" },
    ]);
    expect(usesOf(state, { kind: "transition", use: "exit", ref: { type: "fade" } })).toEqual([
      { timeline: "main", clip: "clip_card", edge: "exit" },
    ]);
  });
});

describe("what is missing", () => {
  it("lists what clips use that is not there, with where", () => {
    const state = example().getState();
    const { interview: _gone, ...assets } = state.assets ?? {};
    const { impacts: _sound, ...sounds } = state.sounds;
    const without: ProjectState = { ...state, assets, sounds };
    const missing = missingIn(without);
    expect(missing).toContainEqual({
      kind: "asset",
      id: "interview",
      uses: [{ timeline: "main", clip: "clip_interview" }],
    });
    expect(missing).toContainEqual({
      kind: "sound",
      id: "impacts",
      uses: [{ timeline: "main", clip: "clip_hit" }],
    });
    expect(missing).toContainEqual(
      expect.objectContaining({ kind: "effect", type: "plugin.film-grade" }),
    );
    expect(missing).toContainEqual(
      expect.objectContaining({
        kind: "transition",
        use: "join",
        why: expect.objectContaining({ reason: "library" }),
        uses: [{ timeline: "main", join: "join_2", clip: "clip_logo" }],
      }),
    );
    expect(missing).toContainEqual({
      kind: "library",
      library: "lib_7f3a",
      item: "title-card",
      uses: [{ timeline: "main", clip: "clip_card" }],
    });
    // What is there is not missing, and an effect that only does not fit is a problem of its place.
    expect(missing.some((each) => each.kind === "asset" && each.id === "narration-zh")).toBe(false);
    expect(missing.some((each) => each.kind === "effect" && each.type === "blur")).toBe(false);
  });

  it("lists nothing for a project that has everything", () => {
    const store = ProjectStore.create(createProject({ name: "空的" }));
    expect(missingIn(store.getState())).toEqual([]);
  });
});

describe("tags and names of resources", () => {
  it("renames an asset and gives it tags, and no tags take them away", () => {
    const store = example();
    ok(
      run(store, "asset.update", {
        asset: "interview",
        changes: { name: "采访 第二版", tags: ["片头", "竖屏可用"] },
      }),
    );
    expect(store.getState().assets?.["interview"]).toMatchObject({
      name: "采访 第二版",
      tags: ["片头", "竖屏可用"],
    });
    ok(run(store, "asset.update", { asset: "interview", changes: { tags: [] } }));
    expect(store.getState().assets?.["interview"]).not.toHaveProperty("tags");
    store.undo();
    store.undo();
    expect(store.getState().assets?.["interview"]).toMatchObject({ name: "采访" });
    expect(store.getState().assets?.["interview"]).not.toHaveProperty("tags");
  });

  it("refuses an empty name and tags that repeat", () => {
    const store = example();
    expect(run(store, "asset.update", { asset: "interview", changes: { name: " " } }).ok).toBe(
      false,
    );
    const twice = run(store, "asset.update", {
      asset: "interview",
      changes: { tags: ["片头", "片头"] },
    });
    expect(twice.ok).toBe(false);
  });

  it("gives scenes and sounds tags, which their files keep", () => {
    const store = example();
    ok(run(store, "scene.update", { scene: "title", changes: { tags: ["片头"] } }));
    ok(run(store, "sound.update", { sound: "impacts", changes: { tags: ["打击"] } }));
    const { files } = store.exportFiles();
    expect(JSON.parse(files.get("scenes/title/scene.json") as string).tags).toEqual(["片头"]);
    expect(JSON.parse(files.get("sounds/impacts/sound.json") as string).tags).toEqual(["打击"]);
    ok(run(store, "scene.update", { scene: "title", changes: {}, clear: ["tags"] }));
    expect(store.getState().scenes["title"]).not.toHaveProperty("tags");
  });
});

describe("removing a resource in use", () => {
  it("is refused unless the clips go along, which they do in one step", () => {
    const store = example();
    const refused = run(store, "asset.remove", { asset: "narration-zh" });
    expect(refused).toMatchObject({ ok: false, error: { code: "asset-in-use" } });
    ok(run(store, "asset.remove", { asset: "narration-zh", withUses: true }));
    expect(store.getState().assets).not.toHaveProperty("narration-zh");
    expect(clipsOf(store)).not.toContain("clip_voice");
    store.undo();
    expect(store.getState().assets).toHaveProperty("narration-zh");
    expect(clipsOf(store)).toContain("clip_voice");
  });

  it("takes away only what a version changes when the clip itself uses something else", () => {
    const store = example();
    ok(run(store, "asset.remove", { asset: "narration-en", withUses: true }));
    expect(clipsOf(store)).toContain("clip_voice");
    const version = store.getState().timelines["main"]!.overrides["language.en"];
    expect(version?.clips?.["clip_voice"]?.source).toBeUndefined();
    expect(usesOf(store.getState(), { kind: "asset", id: "narration-en" })).toEqual([]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("takes the joins of the clips along, and the files of a scene", () => {
    const store = example();
    ok(run(store, "scene.remove", { scene: "title", withUses: true }));
    const timeline = store.getState().timelines["main"]!;
    expect(timeline.clips).not.toHaveProperty("clip_title");
    expect(timeline.joins ?? {}).not.toHaveProperty("join_1");
    expect(Object.keys(store.getState().files).some((path) => path.startsWith("scenes/"))).toBe(
      false,
    );
    expect(run(store, "sound.remove", { sound: "impacts" }).ok).toBe(false);
    ok(run(store, "sound.remove", { sound: "impacts", withUses: true }));
    expect(clipsOf(store)).not.toContain("clip_hit");
  });
});

describe("another resource in the place of one", () => {
  it("moves every clip and version over, in one step", () => {
    const store = example();
    ok(run(store, "source.replace", { kind: "asset", from: "narration-en", to: "studio-loop" }));
    const version = store.getState().timelines["main"]!.overrides["language.en"];
    expect(version?.clips?.["clip_voice"]?.source?.value).toEqual({
      kind: "audio",
      media: { asset: "studio-loop" },
    });
    ok(run(store, "source.replace", { kind: "asset", from: "interview", to: "raw-footage" }));
    const clip = store.getState().timelines["main"]!.clips["clip_interview"];
    expect(clip?.source).toMatchObject({ kind: "video", media: { asset: "raw-footage" } });
    store.undo();
    expect(store.getState().timelines["main"]!.clips["clip_interview"]?.source).toMatchObject({
      media: { asset: "interview" },
    });
  });

  it("works for what is not there any more, and refuses what clips cannot show", () => {
    const store = example();
    const sound = run(store, "source.replace", {
      kind: "asset",
      from: "interview",
      to: "narration-zh",
    });
    expect(sound).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    // The sound of a video plays where a sound file did.
    ok(run(store, "source.replace", { kind: "asset", from: "narration-zh", to: "interview" }));
    const nothing = run(store, "source.replace", { kind: "scene", from: "nobody", to: "title" });
    expect(nothing).toMatchObject({ ok: false, error: { code: "not-in-use" } });
    const unknown = run(store, "source.replace", { kind: "scene", from: "title", to: "nobody" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
