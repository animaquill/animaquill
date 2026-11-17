import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ProjectStore, type CommandResult } from "./store.ts";

/** Linking and unlinking clips: the groups that people select, move, trim and cut together. */

const MAIN = "timelines/main/timeline.json";

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

/**
 * The picture and the sound of a video as one group "film", another picture and sound as "other",
 * and a color clip of its own.
 */
function project() {
  const files = writeProject(createProject({ name: "联动" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
  const audio = timeline.tracks.find(({ kind }: { kind: string }) => kind === "audio");
  const media = { asset: "file" };
  video.clips.push(
    { id: "v", start: "0", duration: "2", source: { kind: "video", media }, link: "film" },
    { id: "w", start: "4", duration: "2", source: { kind: "video", media }, link: "other" },
    { id: "c", start: "8", duration: "2", source: { kind: "color", color: "#ff0000" } },
  );
  audio.clips.push(
    { id: "s", start: "0", duration: "2", source: { kind: "audio", media }, link: "film" },
    { id: "t", start: "4", duration: "2", source: { kind: "audio", media }, link: "other" },
  );
  files.set(MAIN, JSON.stringify(timeline));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  const linkOf = (id: string) => store.getState().timelines["main"]?.clips[id]?.link;
  const run = (type: string, params: Record<string, unknown>) =>
    store.execute({ type, params: { timeline: "main", ...params } });
  return { store, linkOf, run };
}

describe("clip.link", () => {
  it("gives the clips a new link of their own, and says which", () => {
    const { linkOf, run } = project();
    const result = success(run("clip.link", { clips: ["v", "s", "c"] }));
    const link = (result.results[0] as { link: string }).link;
    expect(link).not.toBe("film");
    expect([linkOf("v"), linkOf("s"), linkOf("c")]).toEqual([link, link, link]);
    expect([linkOf("w"), linkOf("t")]).toEqual(["other", "other"]);
  });

  it("leaves no group of one: the clip that stays behind is linked to nothing", () => {
    const { linkOf, run } = project();
    success(run("clip.link", { clips: ["v", "w"] }));
    expect(linkOf("v")).toBe(linkOf("w"));
    expect(linkOf("s")).toBeUndefined();
    expect(linkOf("t")).toBeUndefined();
  });

  it("is one step, which undo takes back to the groups as they were", () => {
    const { store, linkOf, run } = project();
    success(run("clip.link", { clips: ["v", "w"] }));
    store.undo();
    expect([linkOf("v"), linkOf("s"), linkOf("w"), linkOf("t")]).toEqual([
      "film",
      "film",
      "other",
      "other",
    ]);
    store.redo();
    expect(linkOf("s")).toBeUndefined();
    expect(linkOf("v")).toBe(linkOf("w"));
  });

  it("takes at least two clips, each once, that are all there", () => {
    const { store, run } = project();
    const before = store.getState();
    for (const clips of [["v"], ["v", "v"]]) {
      const result = run("clip.link", { clips });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid-params");
    }
    const missing = run("clip.link", { clips: ["v", "nothing"] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not-found");
    expect(store.getState()).toBe(before);
  });
});

describe("clip.unlink", () => {
  it("takes the link away, and from the one clip left behind as well", () => {
    const { linkOf, run } = project();
    success(run("clip.unlink", { clips: ["v"] }));
    expect(linkOf("v")).toBeUndefined();
    expect(linkOf("s")).toBeUndefined();
    expect([linkOf("w"), linkOf("t")]).toEqual(["other", "other"]);
  });

  it("keeps a group that still has two clips", () => {
    const { linkOf, run } = project();
    success(run("clip.link", { clips: ["v", "s", "c"] }));
    const link = linkOf("v");
    success(run("clip.unlink", { clips: ["c"] }));
    expect(linkOf("c")).toBeUndefined();
    expect([linkOf("v"), linkOf("s")]).toEqual([link, link]);
  });

  it("does nothing to a clip that has no link, and links again afterwards", () => {
    const { store, linkOf, run } = project();
    success(run("clip.unlink", { clips: ["c", "v", "s"] }));
    expect([linkOf("c"), linkOf("v"), linkOf("s")]).toEqual([undefined, undefined, undefined]);
    success(run("clip.link", { clips: ["v", "s"] }));
    expect(linkOf("v")).toBeDefined();
    expect(linkOf("v")).toBe(linkOf("s"));
    store.undo();
    store.undo();
    expect([linkOf("v"), linkOf("s")]).toEqual(["film", "film"]);
  });

  it("still lets clip.update clear a link, as before", () => {
    const { linkOf, run } = project();
    success(run("clip.update", { clip: "v", changes: {}, clear: ["link"] }));
    expect(linkOf("v")).toBeUndefined();
    expect(linkOf("s")).toBe("film");
  });
});
