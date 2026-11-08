import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { ProjectState, TimelineState } from "./model.ts";
import type { Patch } from "./patch.ts";
import { danglingAt, isInUse, touchesLockedTrack } from "./references.ts";
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

describe("what counts as in use", () => {
  const changed = {
    overrides: {
      v: {
        scope: { language: "en" },
        clips: { c: { source: { value: { kind: "image", media: { asset: "b" } } } } },
      },
    },
  } as unknown as Partial<TimelineState>;

  it("is what clips use", () => {
    const { state } = project();
    expect(isInUse(state, ["assets", "a"])).toBe(true);
    expect(isInUse(state, ["assets", "b"])).toBe(false);
  });

  it("is also what a version uses", () => {
    const { state } = project(() => changed);
    expect(isInUse(state, ["assets", "b"])).toBe(true);
  });
});

describe("what reaches a locked track", () => {
  const LOCKED = "k";
  const OPEN = "m";
  const transition = { id: "t", type: "dissolve", duration: "1", track: LOCKED };
  const setUp = () => {
    const { state, timeline, track } = project(({ tracks }) => {
      const [first] = Object.values(tracks);
      return {
        tracks: {
          [LOCKED]: { ...first, id: LOCKED, locked: true },
          [OPEN]: { ...first, id: OPEN },
        },
        transitions: { t: transition, u: { ...transition, id: "u", track: OPEN } },
      } as unknown as Partial<TimelineState>;
    });
    void timeline;
    void track;
    const main = state.timelines["main"] as TimelineState;
    const on = (track2: string) => ({ ...main.clips["c"], track: track2 });
    const timelines = {
      main: {
        ...main,
        clips: { c: on(LOCKED), d: { ...on(OPEN), id: "d" } },
        overrides: {
          v: { clips: { c: { hidden: { value: true } }, d: { hidden: { value: true } } } },
        },
      },
    };
    return { ...state, timelines } as unknown as ProjectState;
  };
  const path = (...rest: readonly string[]) => ["timelines", "main", ...rest];
  const deleting = (...rest: readonly string[]): Patch => ({ op: "delete", path: path(...rest) });
  const setting = (value: unknown, ...rest: readonly string[]): Patch => ({
    op: "set",
    path: path(...rest),
    value,
  });

  it("is a clip on it, and whatever is in that clip", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, deleting("clips", "c"))).toBe(true);
    expect(touchesLockedTrack(state, setting("1", "clips", "c", "start"))).toBe(true);
    expect(touchesLockedTrack(state, setting(1, "clips", "c", "properties", "opacity"))).toBe(true);
    expect(touchesLockedTrack(state, deleting("clips", "d"))).toBe(false);
    expect(touchesLockedTrack(state, setting("1", "clips", "d", "start"))).toBe(false);
  });

  it("is a clip that would end up on it", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, setting({ track: LOCKED }, "clips", "e"))).toBe(true);
    expect(touchesLockedTrack(state, setting({ track: OPEN }, "clips", "e"))).toBe(false);
    expect(touchesLockedTrack(state, setting(LOCKED, "clips", "d", "track"))).toBe(true);
    expect(touchesLockedTrack(state, setting(OPEN, "clips", "d", "track"))).toBe(false);
    expect(touchesLockedTrack(state, setting(LOCKED, "clips", "d", "name"))).toBe(false);
  });

  it("is a transition on it, or one that would end up on it", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, deleting("transitions", "t"))).toBe(true);
    expect(touchesLockedTrack(state, deleting("transitions", "t", "from"))).toBe(true);
    expect(touchesLockedTrack(state, deleting("transitions", "u"))).toBe(false);
    expect(touchesLockedTrack(state, setting({ track: LOCKED }, "transitions", "w"))).toBe(true);
    expect(touchesLockedTrack(state, setting({ track: OPEN }, "transitions", "w"))).toBe(false);
  });

  it("is the track going away, not what is written on it", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, deleting("tracks", LOCKED))).toBe(true);
    expect(touchesLockedTrack(state, deleting("tracks", OPEN))).toBe(false);
    expect(touchesLockedTrack(state, setting(false, "tracks", LOCKED, "locked"))).toBe(false);
    expect(touchesLockedTrack(state, setting("名字", "tracks", LOCKED, "name"))).toBe(false);
    expect(touchesLockedTrack(state, setting({ locked: true }, "tracks", "new"))).toBe(false);
  });

  it("is what a version changes about a clip on it", () => {
    const state = setUp();
    const hidden = ["overrides", "v", "clips"];
    expect(touchesLockedTrack(state, deleting(...hidden, "c"))).toBe(true);
    expect(touchesLockedTrack(state, deleting(...hidden, "c", "hidden"))).toBe(true);
    expect(touchesLockedTrack(state, deleting(...hidden, "d"))).toBe(false);
    expect(touchesLockedTrack(state, deleting("overrides", "v", "scope"))).toBe(false);
    expect(touchesLockedTrack(state, deleting("overrides", "v", "sections", "c"))).toBe(false);
  });

  it("is a whole timeline with such a track", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, { op: "delete", path: path() })).toBe(true);
    const { state: open } = project();
    expect(touchesLockedTrack(open, { op: "delete", path: path() })).toBe(false);
  });

  it("is an asset that a clip on it shows, unless it only says who made it", () => {
    const state = setUp();
    const asset = (value?: object): Patch =>
      value === undefined
        ? { op: "delete", path: ["assets", "a"] }
        : { op: "set", path: ["assets", "a"], value };
    expect(touchesLockedTrack(state, asset())).toBe(true);
    expect(touchesLockedTrack(state, asset({ ...ASSET, path: "assets/b.png" }))).toBe(true);
    expect(touchesLockedTrack(state, asset({ ...ASSET, hash: "sha256-b" }))).toBe(true);
    expect(touchesLockedTrack(state, asset({ ...ASSET, name: "图", credit: "某人" }))).toBe(false);
    expect(touchesLockedTrack(state, { op: "delete", path: ["assets", "b"] })).toBe(false);
    // With nothing on the locked track that shows it, the asset is free.
    const { state: open } = project();
    expect(touchesLockedTrack(open, asset())).toBe(false);
  });

  it("is what a version shows there, or what the code there asks for", () => {
    const state = setUp();
    const main = state.timelines["main"] as TimelineState;
    const source = { value: { kind: "image", media: { asset: "b" } } };
    const versions = { v: { clips: { c: { source } } } };
    const assets = { a: ASSET, b: { ...ASSET, path: "assets/b.png" } };
    const withVersion = {
      ...state,
      assets,
      timelines: { main: { ...main, overrides: versions } },
    } as unknown as ProjectState;
    expect(touchesLockedTrack(withVersion, { op: "delete", path: ["assets", "b"] })).toBe(true);
    const scene = { name: "场景", entry: "index.html", runtime: 1 };
    const showing = { ...main.clips["c"], source: { kind: "scene", scene: "s" } };
    const withScene = {
      ...state,
      assets,
      scenes: { s: scene },
      files: { "scenes/s/index.html": `<script>aq.asset("b")</script>` },
      timelines: { main: { ...main, clips: { ...main.clips, c: showing } } },
    } as unknown as ProjectState;
    expect(touchesLockedTrack(withScene, { op: "delete", path: ["assets", "b"] })).toBe(true);
    expect(touchesLockedTrack(withScene, { op: "delete", path: ["assets", "a"] })).toBe(false);
  });

  it("is a library that a clip on it takes something from", () => {
    const state = setUp();
    const main = state.timelines["main"] as TimelineState;
    const fromLibrary = {
      ...main.clips["c"],
      source: { kind: "image", media: { library: "lib", path: "logo.png" } },
    };
    const pinned = { commit: "aaaaaaa", integrity: "sha256-a" };
    const withLibrary = {
      ...state,
      lock: { libraries: { lib: pinned } },
      timelines: { main: { ...main, clips: { ...main.clips, c: fromLibrary } } },
    } as unknown as ProjectState;
    const lock = (libraries: object): Patch => ({
      op: "set",
      path: ["lock"],
      value: { libraries },
    });
    const other = { commit: "bbbbbbb", integrity: "sha256-b" };
    expect(touchesLockedTrack(withLibrary, lock({ lib: other }))).toBe(true);
    expect(touchesLockedTrack(withLibrary, lock({}))).toBe(true);
    expect(touchesLockedTrack(withLibrary, lock({ lib: pinned, more: other }))).toBe(false);
  });

  it("is nothing elsewhere", () => {
    const state = setUp();
    expect(touchesLockedTrack(state, { op: "set", path: ["manifest", "name"], value: "x" })).toBe(
      false,
    );
    expect(
      touchesLockedTrack(state, { op: "delete", path: ["timelines", "none", "clips", "c"] }),
    ).toBe(false);
    expect(touchesLockedTrack(state, deleting("markers", "m"))).toBe(false);
    expect(touchesLockedTrack(state, deleting("sections", "s"))).toBe(false);
  });
});
