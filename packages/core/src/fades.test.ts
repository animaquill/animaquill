import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { orderedTracks } from "./model.ts";
import { ProjectStore, type CommandResult } from "./store.ts";

/** Fades that get too long for their clip, when it gets shorter by trimming or cutting. */

const color = { kind: "color", color: "#ff0000" };

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function withClip(clip: Record<string, unknown>) {
  const store = ProjectStore.create(createProject({ name: "淡入淡出" }));
  const main = store.getState().timelines["main"];
  const track = main && orderedTracks(main).find(({ kind }) => kind === "video");
  if (!track) throw new Error("no video track");
  success(
    store.execute({
      type: "clip.add",
      params: { timeline: "main", track: track.id, clip: { id: "a", source: color, ...clip } },
    }),
  );
  const fades = (id = "a") => {
    const found = store.getState().timelines["main"]?.clips[id];
    return [found?.fadeIn, found?.fadeOut];
  };
  const trim = (edges: Record<string, string>) =>
    success(
      store.execute({ type: "clip.trim", params: { timeline: "main", clip: "a", ...edges } }),
    );
  const split = (at: string) => {
    const result = success(
      store.execute({ type: "clip.split", params: { timeline: "main", clip: "a", at } }),
    );
    return (result.results[0] as { id: string }).id;
  };
  return { store, fades, trim, split };
}

describe("fades of a clip that gets shorter", () => {
  it("stay as they are while they fit", () => {
    const { fades, trim } = withClip({ start: "0", duration: "6", fadeIn: "1", fadeOut: "2" });
    trim({ end: "3" });
    expect(fades()).toEqual(["1", "2"]);
  });

  it("first give up the fade at the edge that moved, then the other, in one step", () => {
    const { store, fades, trim } = withClip({
      start: "0",
      duration: "6",
      fadeIn: "2",
      fadeOut: "3",
    });
    trim({ end: "4" });
    expect(fades()).toEqual(["2", "2"]);
    store.undo();
    expect(fades()).toEqual(["2", "3"]);
    trim({ start: "2" });
    expect(fades()).toEqual(["1", "3"]);
    store.undo();
    trim({ start: "4" });
    // Two seconds are left: the fade out takes them all, and there is no fade in any more.
    expect(fades()).toEqual([undefined, "2"]);
    store.undo();
    expect(fades()).toEqual(["2", "3"]);
  });

  it("are shortened by frames as exactly as the clip is", () => {
    const { fades, trim } = withClip({ start: "0", duration: "2", fadeIn: "1", fadeOut: "1" });
    trim({ end: "59/30" });
    expect(fades()).toEqual(["1", "29/30"]);
  });

  it("go to the part of a cut they are at, each as long as its part can take", () => {
    const { store, fades, split } = withClip({
      start: "0",
      duration: "6",
      fadeIn: "4",
      fadeOut: "5",
    });
    const right = split("1");
    expect(fades()).toEqual(["1", undefined]);
    expect(fades(right)).toEqual([undefined, "5"]);
    store.undo();
    expect(fades()).toEqual(["4", "5"]);
    const later = split("5");
    expect(fades()).toEqual(["4", undefined]);
    expect(fades(later)).toEqual([undefined, "1"]);
  });
});
