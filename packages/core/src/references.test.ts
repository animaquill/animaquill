import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { ProjectState, TimelineState } from "./model.ts";
import { danglingAt } from "./references.ts";
import { ProjectStore } from "./store.ts";

const ASSET = { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a" };

function project(change: (timeline: TimelineState) => Partial<TimelineState> = () => ({})) {
  const state = ProjectStore.create(createProject({ name: "引用" })).getState();
  const main = state.timelines["main"] as TimelineState;
  const track = Object.keys(main.tracks)[0] as string;
  const clip = {
    id: "c",
    start: "0",
    duration: "1",
    track,
    source: { kind: "image", media: { asset: "a" } },
  };
  const withClip = { ...main, clips: { c: clip } } as unknown as TimelineState;
  const timeline = { ...withClip, ...change(withClip) };
  const result = {
    ...state,
    assets: { a: ASSET },
    timelines: { main: timeline },
  } as unknown as ProjectState;
  return { state: result, timeline, track };
}

const withSource = (timeline: TimelineState, source: unknown) =>
  ({ clips: { c: { ...timeline.clips["c"], source } } }) as unknown as Partial<TimelineState>;

const CLIP = ["timelines", "main", "clips", "c"];

describe("what points at nothing", () => {
  it("is nothing when everything is there", () => {
    const { state, track } = project();
    expect(danglingAt(state, ["assets", "a"])).toEqual([]);
    expect(danglingAt(state, CLIP)).toEqual([]);
    expect(danglingAt(state, [...CLIP, "track"])).toEqual([]);
    expect(danglingAt(state, [...CLIP, "source"])).toEqual([]);
    expect(danglingAt(state, ["timelines", "main", "tracks", track])).toEqual([]);
    expect(danglingAt(state, ["timelines", "main"])).toEqual([]);
  });

  it("is a clip whose asset went away", () => {
    const { state } = project();
    const { assets: _assets, ...without } = state;
    const link = "timelines/main/clips/c -> assets/a";
    expect(danglingAt(without, ["assets", "a"])).toEqual([link]);
    expect(danglingAt(without, CLIP)).toEqual([link]);
    expect(danglingAt(without, [...CLIP, "source"])).toEqual([link]);
    expect(danglingAt(without, ["timelines", "main"])).toEqual([link]);
  });

  it("is every clip that uses it", () => {
    const { state } = project((timeline) => ({
      clips: {
        c: timeline.clips["c"],
        d: { ...timeline.clips["c"], id: "d" },
      } as TimelineState["clips"],
    }));
    const { assets: _assets, ...without } = state;
    expect(danglingAt(without, ["assets", "a"])).toEqual([
      "timelines/main/clips/c -> assets/a",
      "timelines/main/clips/d -> assets/a",
    ]);
  });

  it("is about the state it is asked about, also when that is another one", () => {
    const { state } = project();
    const { assets: _assets, ...without } = state;
    const stillThere = {
      ...without,
      timelines: { main: { ...state.timelines["main"], clips: {} } },
    };
    expect(danglingAt(without, ["assets", "a"])).toHaveLength(1);
    expect(danglingAt(stillThere as ProjectState, ["assets", "a"])).toEqual([]);
  });

  it("is not about an asset nobody uses", () => {
    const { state } = project();
    expect(danglingAt(state, ["assets", "b"])).toEqual([]);
  });

  it("is a clip whose track went away", () => {
    const { state, timeline, track } = project();
    const gone = {
      ...state,
      timelines: { main: { ...timeline, tracks: {} } },
    };
    const link = `timelines/main/clips/c -> timelines/main/tracks/${track}`;
    expect(danglingAt(gone, ["timelines", "main", "tracks", track])).toEqual([link]);
    expect(danglingAt(gone, CLIP)).toEqual([link]);
    expect(danglingAt(gone, [...CLIP, "track"])).toEqual([link]);
  });

  it("is a clip on a track of the wrong kind, which no file can hold", () => {
    const { state, track } = project((timeline) => withSource(timeline, { kind: "audio" }));
    const wrong = `timelines/main/clips/c -> timelines/main/tracks/${track} of another kind`;
    expect(danglingAt(state, CLIP)).toEqual([wrong]);
    expect(danglingAt(state, [...CLIP, "track"])).toEqual([wrong]);
    expect(danglingAt(state, [...CLIP, "source"])).toEqual([wrong]);
  });

  it("is not about the fields of a clip that point at nothing", () => {
    const { state, timeline } = project();
    const gone = { ...state, timelines: { main: { ...timeline, tracks: {} } } };
    expect(danglingAt(gone, [...CLIP, "start"])).toEqual([]);
    expect(danglingAt(gone, [...CLIP, "properties", "opacity"])).toEqual([]);
  });

  it("is a scene, a sound or a timeline that went away", () => {
    for (const [source, target] of [
      [{ kind: "scene", scene: "s" }, ["scenes", "s"]],
      [{ kind: "sound", sound: "s" }, ["sounds", "s"]],
      [{ kind: "timeline", timeline: "t" }, ["timelines", "t"]],
    ] as const) {
      const { state } = project((timeline) => withSource(timeline, source));
      const link = `timelines/main/clips/c -> ${target.join("/")}`;
      expect(danglingAt(state, target)).toEqual([link]);
      expect(danglingAt(state, CLIP)).toContain(link);
    }
  });

  it("goes by the kind of a source, because a plugin can name its fields anything", () => {
    const source = { kind: "my.plugin", media: { asset: "gone" }, scene: "gone" };
    const { state } = project((timeline) => withSource(timeline, source));
    expect(danglingAt(state, CLIP)).toEqual([]);
    expect(danglingAt(state, ["assets", "gone"])).toEqual([]);
  });

  it("is not about media from a library", () => {
    const source = { kind: "image", media: { library: "l", path: "a.png" } };
    const { state } = project((timeline) => withSource(timeline, source));
    expect(danglingAt(state, CLIP)).toEqual([]);
  });

  it("is a transition without its clips or track", () => {
    const transition = {
      id: "t",
      type: "core.fade",
      from: "c",
      to: "e",
      duration: "1",
      track: "k",
    };
    const { state, track } = project(() => ({
      transitions: { t: transition } as unknown as TimelineState["transitions"],
    }));
    const path = ["timelines", "main", "transitions", "t"];
    const from = "timelines/main/transitions/t";
    expect(danglingAt(state, path)).toEqual([
      `${from} -> timelines/main/clips/e`,
      `${from} -> timelines/main/tracks/k`,
    ]);
    expect(danglingAt(state, [...path, "to"])).toHaveLength(2);
    expect(danglingAt(state, ["timelines", "main", "clips", "e"])).toEqual([
      `${from} -> timelines/main/clips/e`,
    ]);
    expect(danglingAt(state, ["timelines", "main", "tracks", "k"])).toEqual([
      `${from} -> timelines/main/tracks/k`,
    ]);
    expect(danglingAt(state, ["timelines", "main", "tracks", track])).toEqual([]);
  });

  it("is nothing for a transition that is gone", () => {
    const { state } = project();
    expect(danglingAt(state, ["timelines", "main", "transitions", "t"])).toEqual([]);
  });

  it("is a timeline without sections", () => {
    const { state } = project(() => ({ sections: {} }));
    expect(danglingAt(state, ["timelines", "main", "sections", "s"])).toEqual([
      "timelines/main -> a section",
    ]);
    const { state: other, timeline } = project();
    const [section] = Object.keys(timeline.sections);
    expect(danglingAt(other, ["timelines", "main", "sections", section as string])).toEqual([]);
  });

  describe("in what a version changes", () => {
    const changed = (asset: string) =>
      ({
        overrides: {
          v: {
            scope: { language: "en" },
            clips: { c: { source: { value: { kind: "image", media: { asset } } } } },
          },
        },
      }) as unknown as Partial<TimelineState>;
    const version = ["timelines", "main", "overrides", "v"];
    const link = `timelines/main/overrides/v/clips/c -> assets/gone`;

    it("is a source that went away", () => {
      const { state } = project(() => changed("gone"));
      expect(danglingAt(state, ["assets", "gone"])).toEqual([link]);
      expect(danglingAt(state, version)).toEqual([link]);
      expect(danglingAt(state, [...version, "clips", "c"])).toEqual([link]);
      expect(danglingAt(state, [...version, "clips", "c", "source"])).toEqual([link]);
      expect(danglingAt(state, ["timelines", "main"])).toEqual([link]);
    });

    it("is not about the rest of it", () => {
      const { state } = project(() => changed("gone"));
      expect(danglingAt(state, [...version, "clips", "other"])).toEqual([]);
      expect(danglingAt(state, [...version, "clips", "c", "start"])).toEqual([]);
      expect(danglingAt(state, [...version, "clips", "c", "properties", "opacity"])).toEqual([]);
      expect(danglingAt(state, ["timelines", "main", "overrides", "none"])).toEqual([]);
    });
  });

  it("is nothing for a timeline that is not there", () => {
    const { state } = project();
    expect(danglingAt(state, ["timelines", "none"])).toEqual([]);
    expect(danglingAt(state, ["timelines", "none", "clips", "c"])).toEqual([]);
  });

  it("is nothing for what cannot point anywhere", () => {
    const { state } = project();
    expect(danglingAt(state, ["manifest", "name"])).toEqual([]);
    expect(danglingAt(state, ["notes", "n"])).toEqual([]);
    expect(danglingAt(state, ["timelines", "main", "markers", "m"])).toEqual([]);
    expect(danglingAt(state, ["scenes", "s", "name"])).toEqual([]);
  });

  it("copes with a clip that has holes while updates are missing", () => {
    const { state } = project((timeline) => withSource(timeline, undefined));
    expect(danglingAt(state, CLIP)).toEqual([]);
    expect(danglingAt(state, ["assets", "a"])).toEqual([]);
  });
});
