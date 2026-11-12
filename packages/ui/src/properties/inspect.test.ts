import {
  ProjectStore,
  Trial,
  buildRenderPlan,
  orderedTracks,
  type CommandCall,
} from "@animaquill/core";
import { createProject, type PropertyValue } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { buildModel, type TimelineModel } from "../timeline/model.ts";
import {
  inspect,
  keyEdit,
  writeEdit,
  type Inspection,
  type PropertyRow,
  type TrialView,
} from "./inspect.ts";

const red = { kind: "color", color: "#ff0000" };

function setup(fps = "30") {
  const format = { id: "f", name: "画幅", width: 1920, height: 1080, fps };
  const store = ProjectStore.create(createProject({ name: "属性", format }));
  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const audio = orderedTracks(main()).find(({ kind }) => kind === "audio")?.id as string;
  const run = (call: CommandCall) => {
    const result = store.execute(call);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  };
  const add = (id: string, extra: object = {}, on = track) =>
    run({
      type: "clip.add",
      params: {
        timeline: "main",
        track: on,
        id,
        start: "0",
        duration: "10",
        source: red,
        ...extra,
      },
    });
  const model = (): TimelineModel => buildModel("main", main(), fps);
  const look = (selection: readonly string[], frame: number, trial?: TrialView) =>
    inspect(store.getState(), model(), new Set(selection), frame, trial);
  const clipView = (id: string, frame: number, trial?: TrialView) => {
    const inspection = look([id], frame, trial);
    if (inspection.kind !== "clip") throw new Error(`nothing to see: ${inspection.kind}`);
    return inspection;
  };
  const row = (id: string, frame: number, path: string, trial?: TrialView): PropertyRow => {
    const found = clipView(id, frame, trial).objects[0]?.rows.find(
      ({ spec }) => spec.path === path,
    );
    if (!found) throw new Error(`no row: ${path}`);
    return found;
  };
  return { store, run, add, look, clipView, row, track, audio };
}

const keys = (...times: readonly string[]): PropertyValue => ({
  keys: times.map((time, index) => ({ time, value: index * 100 })),
});

describe("what the tab is about", () => {
  it("is nothing without a selection", () => {
    expect(setup().look([], 0).kind).toBe("nothing");
  });

  it("is the clip that is selected", () => {
    const { add, look } = setup();
    add("c");
    expect(look(["c"], 0)).toMatchObject({ kind: "clip", box: { id: "c" } });
  });

  it("has nothing to show for a clip without a picture", () => {
    const { add, look, audio, store } = setup();
    store.execute({
      type: "asset.add",
      params: {
        id: "a",
        asset: { kind: "audio", path: "assets/a.wav", storage: "local", hash: "sha256-a" },
      },
    });
    add("sound", { source: { kind: "audio", media: { asset: "a" } } }, audio);
    expect(look(["sound"], 0).kind).toBe("no-properties");
  });

  it("the sound of a video does not get in the way of its picture", () => {
    const { add, look, audio, store } = setup();
    store.execute({
      type: "asset.add",
      params: {
        id: "a",
        asset: { kind: "video", path: "assets/a.mp4", storage: "local", hash: "sha256-a" },
      },
    });
    const media = { asset: "a" };
    add("picture", { source: { kind: "video", media }, link: "l" });
    add("sound", { source: { kind: "audio", media }, link: "l" }, audio);
    expect(look(["sound", "picture"], 0)).toMatchObject({ kind: "clip", box: { id: "picture" } });
  });

  it("does one clip at a time", () => {
    const { add, look } = setup();
    add("a");
    add("b", { start: "20" });
    expect(look(["a", "b"], 0)).toEqual({ kind: "several", count: 2 });
  });

  it("forgets a clip that is gone", () => {
    expect(setup().look(["gone"], 0).kind).toBe("no-properties");
  });
});

describe("what a row shows", () => {
  it("follows the description, in its order", () => {
    const { add, clipView } = setup();
    add("c");
    const rows = clipView("c", 0).objects[0]?.rows.map(({ spec }) => spec.path);
    expect(rows?.slice(0, 3)).toEqual(["transform.x", "transform.y", "transform.width"]);
    expect(rows?.at(-1)).toBe("fit");
  });

  it("is the default of what has no value", () => {
    const { add, row } = setup();
    add("c");
    expect(row("c", 0, "transform.scale")).toMatchObject({
      value: 1,
      stored: undefined,
      animated: false,
      keyTime: undefined,
      automatic: false,
    });
  });

  it("is the value of what has one", () => {
    const { add, row } = setup();
    add("c", { properties: { "transform.x": 12 } });
    expect(row("c", 0, "transform.x")).toMatchObject({ value: 12, stored: 12, animated: false });
  });

  it("is where the keys are at the playhead", () => {
    const { add, row } = setup();
    add("c", { properties: { "transform.x": keys("0", "2") } });
    expect(row("c", 30, "transform.x").value).toBeCloseTo(50, 9);
    expect(row("c", 30, "transform.x")).toMatchObject({ animated: true, keyTime: undefined });
  });

  it("goes by the clock of the clip", () => {
    const { add, row } = setup();
    add("c", { start: "5", offset: "1", properties: { "transform.x": keys("1", "3") } });
    expect(row("c", 150, "transform.x")).toMatchObject({ value: 0, keyTime: "1" });
    expect(row("c", 180, "transform.x").value).toBeCloseTo(50, 9);
  });

  it("knows a size that follows the stage", () => {
    const { add, row } = setup();
    add("c");
    expect(row("c", 0, "transform.width")).toMatchObject({ value: 1920, automatic: true });
    expect(row("c", 0, "transform.height")).toMatchObject({ value: 1080, automatic: true });
  });

  it("knows a size that follows the other side", () => {
    const { add, row } = setup();
    add("c", { properties: { "transform.width": 960 } });
    expect(row("c", 0, "transform.width")).toMatchObject({ value: 960, automatic: false });
    expect(row("c", 0, "transform.height")).toMatchObject({ value: 540, automatic: true });
  });

  it("knows a size that follows the media", () => {
    const { add, row, store } = setup();
    const info = { width: 640, height: 480 };
    store.execute({
      type: "asset.add",
      params: {
        id: "a",
        asset: { kind: "image", path: "assets/a.png", storage: "local", hash: "sha256-a", info },
      },
    });
    add("c", { source: { kind: "image", media: { asset: "a" } }, properties: { fit: "fixed" } });
    expect(row("c", 0, "transform.width").value).toBe(640);
    expect(row("c", 0, "transform.height").value).toBe(480);
  });
});

describe("the clock at the playhead", () => {
  it("is exact, also for a rate without a decimal form", () => {
    const { add, clipView } = setup("30000/1001");
    add("c", { start: "1001/30000", offset: "1001/15000" });
    // Six frames into a clip whose clock starts two frames in. No decimal can write that down.
    expect(clipView("c", 7).time).toBe("1001/3750");
  });

  it("is on a key that somebody else wrote there", () => {
    const { add, row } = setup("30000/1001");
    const seventh = { keys: [{ time: "7007/30000", value: 0.5 }] };
    add("c", { properties: { opacity: seventh } });
    expect(row("c", 7, "opacity").keyTime).toBe("7007/30000");
  });

  it("finds a key that was written there", () => {
    const { add, clipView, row, run } = setup("30000/1001");
    add("c");
    const { time } = clipView("c", 7);
    const edit = { owner: { clip: "c" }, path: "opacity", op: "setKey", time, value: 0.5 };
    run({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    expect(row("c", 7, "opacity").keyTime).toBe(time);
    expect(row("c", 6, "opacity").keyTime).toBeUndefined();
    expect(row("c", 8, "opacity").keyTime).toBeUndefined();
  });

  it("goes on being right far into a project", () => {
    const { add, clipView, row, run } = setup("30000/1001");
    add("c", { duration: "100000" });
    const frame = 2_000_001;
    const { time } = clipView("c", frame);
    const edit = { owner: { clip: "c" }, path: "opacity", op: "setKey", time, value: 0.5 };
    run({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    expect(row("c", frame, "opacity").keyTime).toBe(time);
  });
});

describe("when nothing can be changed", () => {
  const blockedAt = (inspection: Inspection) =>
    inspection.kind === "clip" ? inspection.blocked : "not a clip";

  it("is not the case on the clip, from its first frame to its last", () => {
    const { add, look } = setup();
    add("c", { start: "1", duration: "1" });
    expect(blockedAt(look(["c"], 30))).toBeUndefined();
    expect(blockedAt(look(["c"], 59))).toBeUndefined();
  });

  it("is before and after it, and the frame after the end is not in the clip", () => {
    const { add, look } = setup();
    add("c", { start: "1", duration: "1" });
    expect(blockedAt(look(["c"], 29))).toBe("outside");
    expect(blockedAt(look(["c"], 60))).toBe("outside");
  });

  it("is on a locked track", () => {
    const { add, look, run, track } = setup();
    add("c");
    run({
      type: "track.update",
      params: { timeline: "main", track, changes: { locked: true } },
    });
    expect(blockedAt(look(["c"], 0))).toBe("locked");
  });
});

describe("a key that is not on a frame", () => {
  const offGrid: PropertyValue = {
    keys: [
      { time: "0.342", value: 1 },
      { time: "2", value: 5 },
    ],
  };

  function clipWithKeys(extra: object = {}) {
    const context = setup();
    context.add("c", { properties: { "transform.x": offGrid }, ...extra });
    return context;
  }

  it("counts as being on the frame it falls in, and on no other", () => {
    const { row } = clipWithKeys();
    expect(row("c", 9, "transform.x").keyTime).toBeUndefined();
    expect(row("c", 10, "transform.x").keyTime).toBe("0.342");
    expect(row("c", 11, "transform.x").keyTime).toBeUndefined();
  });

  it("can be reached with the arrows from both sides", () => {
    const { row } = clipWithKeys();
    expect(row("c", 0, "transform.x").nextKey).toBe(10);
    expect(row("c", 30, "transform.x").previousKey).toBe(10);
  });

  it("the arrows go on from it", () => {
    const { row } = clipWithKeys();
    expect(row("c", 10, "transform.x")).toMatchObject({ previousKey: undefined, nextKey: 60 });
  });

  it("shows its own value on that frame, because that is what an edit changes", () => {
    const { add, row } = setup();
    const curve = {
      keys: [
        { time: "0", value: 0 },
        { time: "0.342", value: 100 },
        { time: "2", value: 5 },
      ],
    };
    add("c", { properties: { "transform.x": curve } });
    expect(row("c", 10, "transform.x").value).toBe(100);
    expect(row("c", 9, "transform.x").value).toBeLessThan(100);
  });

  it("gets changed and removed by what the frame offers, without a new key next to it", () => {
    const { row, run, store } = clipWithKeys();
    const time = row("c", 10, "transform.x").keyTime as string;
    const target = { owner: { clip: "c" }, path: "transform.x" };
    const write = { ...target, op: "write", time, value: 9 };
    run({ type: "property.edit", params: { timeline: "main", edits: [write] } });
    const stored = () =>
      store.getState().timelines["main"]?.clips["c"]?.properties?.["transform.x"];
    expect(stored()).toEqual({
      keys: [
        { time: "0.342", value: 9 },
        { time: "2", value: 5 },
      ],
    });
    const remove = { ...target, op: "removeKey", time };
    run({ type: "property.edit", params: { timeline: "main", edits: [remove] } });
    expect(stored()).toEqual({ keys: [{ time: "2", value: 5 }] });
  });

  it("the later of two in one frame comes next", () => {
    const { add, row } = setup();
    const curve = {
      keys: [
        { time: "1.001", value: 1 },
        { time: "1.002", value: 2 },
      ],
    };
    add("c", { properties: { "transform.x": curve } });
    expect(row("c", 30, "transform.x").keyTime).toBe("1.001");
  });

  it("is exact at a rate without a decimal form", () => {
    const { add, row } = setup("30000/1001");
    const curve = {
      keys: [
        { time: "1001/30000", value: 1 },
        { time: "0.0667", value: 2 },
      ],
    };
    add("c", { properties: { "transform.x": curve } });
    expect(row("c", 1, "transform.x").keyTime).toBe("1001/30000");
    // A little before frame 2, which starts at 0.06673...
    expect(row("c", 1, "transform.x").nextKey).toBeUndefined();
    expect(row("c", 2, "transform.x").keyTime).toBeUndefined();
  });

  describe("on a clip that starts between two frames", () => {
    const curve: PropertyValue = {
      keys: [
        { time: "0", value: 1 },
        { time: "2", value: 5 },
      ],
    };
    const late = () => {
      const context = setup();
      context.add("c", { start: "0.01", properties: { "transform.x": curve } });
      return context;
    };

    it("the arrows get to the first frame that shows the clip", () => {
      const { row, clipView } = late();
      const { previousKey } = row("c", 5, "transform.x");
      expect(previousKey).toBe(1);
      expect(clipView("c", previousKey as number).blocked).toBeUndefined();
      expect(clipView("c", 5).firstFrame).toBe(1);
    });

    it("that frame counts as being on a key from before it", () => {
      const { row } = late();
      expect(row("c", 1, "transform.x").keyTime).toBe("0");
      expect(row("c", 2, "transform.x").keyTime).toBeUndefined();
    });

    it("the frame before does not show it, and can do nothing", () => {
      const { clipView } = late();
      expect(clipView("c", 0).blocked).toBe("outside");
    });
  });

  it("does not count a key that was cut off behind the last frame", () => {
    const { add, row } = setup();
    const curve = {
      keys: [
        { time: "0", value: 1 },
        { time: "1.01", value: 2 },
      ],
    };
    add("c", { duration: "1.005", properties: { "transform.x": curve } });
    expect(row("c", 30, "transform.x").keyTime).toBeUndefined();
    expect(row("c", 0, "transform.x").nextKey).toBeUndefined();
  });
});

describe("a fit with keys, which only a hand-written project can have", () => {
  it("shows what the picture shows: the first one", () => {
    const { add, row, store } = setup();
    add("c");
    const main = store.getState().timelines["main"];
    const clip = main?.clips["c"];
    const curve = {
      keys: [
        { time: "0", value: "cover" },
        { time: "1", value: "fixed" },
      ],
    };
    const handWritten = { ...clip, properties: { fit: curve } } as NonNullable<typeof clip>;
    const state = {
      ...store.getState(),
      timelines: { main: { ...main, clips: { c: handWritten } } },
    } as ReturnType<typeof store.getState>;
    const model = buildModel("main", state.timelines["main"] as NonNullable<typeof main>, "30");
    const at = (frame: number) => {
      const inspection = inspect(state, model, new Set(["c"]), frame);
      if (inspection.kind !== "clip") throw new Error("no clip");
      return inspection.objects[0]?.rows.find(({ path }) => path === "fit");
    };
    expect(at(0)?.value).toBe("cover");
    expect(at(90)?.value).toBe("cover");
    expect(buildRenderPlan(state, "main")?.layers[0]?.fit).toBe("cover");
    expect(row("c", 0, "fit").value).toBe("contain");
  });
});

describe("what a control writes", () => {
  it("is a key at the playhead, or a value where there are none", () => {
    const { add, row, clipView } = setup();
    add("c");
    const { time } = clipView("c", 15);
    expect(writeEdit("c", row("c", 15, "transform.x"), time, 3)).toEqual({
      owner: { clip: "c" },
      path: "transform.x",
      op: "write",
      time: "0.5",
      value: 3,
    });
  });

  it("goes to the key of this frame, which does not have to be on the frame", () => {
    const { add, row, clipView } = setup();
    add("c", { properties: { "transform.x": { keys: [{ time: "0.342", value: 1 }] } } });
    const { time } = clipView("c", 10);
    expect(writeEdit("c", row("c", 10, "transform.x"), time, 3)).toMatchObject({ time: "0.342" });
  });

  it("replaces what cannot have keys, also where a hand-written project has some", () => {
    const { add, row, clipView } = setup();
    add("c");
    const { time } = clipView("c", 0);
    expect(writeEdit("c", row("c", 0, "fit"), time, "cover")).toEqual({
      owner: { clip: "c" },
      path: "fit",
      op: "set",
      value: "cover",
    });
  });
});

describe("what the diamond does", () => {
  it("writes a key with what is showing", () => {
    const { add, row, clipView } = setup();
    add("c", { properties: { opacity: 0.5 } });
    const { time } = clipView("c", 15);
    expect(keyEdit("c", row("c", 15, "opacity"), time)).toEqual({
      owner: { clip: "c" },
      path: "opacity",
      op: "setKey",
      time: "0.5",
      value: 0.5,
    });
  });

  it("writes what a clip box stands at, without a size of its own", () => {
    const { add, row, clipView } = setup();
    add("c");
    const { time } = clipView("c", 0);
    expect(keyEdit("c", row("c", 0, "transform.width"), time)).toMatchObject({ value: 1920 });
  });

  it("takes the key of this frame away, wherever in the frame it is", () => {
    const { add, row, clipView } = setup();
    add("c", { properties: { "transform.x": { keys: [{ time: "0.342", value: 1 }] } } });
    const { time } = clipView("c", 10);
    expect(keyEdit("c", row("c", 10, "transform.x"), time)).toEqual({
      owner: { clip: "c" },
      path: "transform.x",
      op: "removeKey",
      time: "0.342",
    });
  });
});

describe("getting to a clip", () => {
  it("is its first frame", () => {
    const { add, clipView } = setup();
    add("c", { start: "2" });
    expect(clipView("c", 0).firstFrame).toBe(60);
  });

  it("is the frame after its start, when it starts between two frames", () => {
    const { add, clipView } = setup();
    add("c", { start: "0.51" });
    expect(clipView("c", 0).firstFrame).toBe(16);
    add("d", { start: "20.49" });
    expect(clipView("d", 0).firstFrame).toBe(615);
  });
});

describe("going from key to key", () => {
  const onClip = (extra: object = {}) => {
    const context = setup();
    context.add("c", { start: "1", duration: "4", ...extra });
    return context;
  };

  it("finds the nearest key on both sides", () => {
    const { row } = onClip({ properties: { "transform.x": keys("0", "1", "3") } });
    expect(row("c", 45, "transform.x")).toMatchObject({ previousKey: 30, nextKey: 60 });
  });

  it("goes past a key under the playhead", () => {
    const { row } = onClip({ properties: { "transform.x": keys("0", "1", "2") } });
    expect(row("c", 60, "transform.x")).toMatchObject({
      previousKey: 30,
      nextKey: 90,
      keyTime: "1",
    });
  });

  it("has nowhere to go without keys, or with one under the playhead", () => {
    const { row } = onClip({ properties: { "transform.x": keys("1") } });
    expect(row("c", 30, "transform.y")).toMatchObject({
      previousKey: undefined,
      nextKey: undefined,
    });
    expect(row("c", 60, "transform.x")).toMatchObject({
      previousKey: undefined,
      nextKey: undefined,
    });
  });

  it("stays inside the clip, whatever was trimmed away", () => {
    const { row } = onClip({
      offset: "2",
      properties: { "transform.x": keys("0", "1", "3", "4", "9") },
    });
    // The clip shows its clock from 2 to 6, so only the keys at 3 and 4 are in it.
    expect(row("c", 60, "transform.x")).toMatchObject({ previousKey: undefined, nextKey: 90 });
    expect(row("c", 90, "transform.x")).toMatchObject({ previousKey: 60, nextKey: undefined });
  });

  it("gets into the clip from outside", () => {
    const { row } = onClip({ properties: { "transform.x": keys("1", "2") } });
    expect(row("c", 0, "transform.x")).toMatchObject({ previousKey: undefined, nextKey: 60 });
    expect(row("c", 200, "transform.x")).toMatchObject({ previousKey: 90, nextKey: undefined });
  });

  it("skips a key that is on the frame of the playhead without being exactly there", () => {
    const { row } = onClip({ properties: { "transform.x": keys("1", "1.001", "2") } });
    expect(row("c", 60, "transform.x")).toMatchObject({ nextKey: 90, keyTime: "1" });
  });
});

describe("what is being tried out", () => {
  const owner = { clip: "c" };

  function trying() {
    const context = setup();
    context.add("c");
    const look = new Trial(context.store, "main");
    return { ...context, look, view: { look } };
  }

  it("is what a row shows, and it says so", () => {
    const { row, look, view } = trying();
    look.write([{ owner, path: "transform.x", op: "set", value: 10 }]);
    expect(row("c", 0, "transform.x", view)).toMatchObject({ value: 10, tried: true });
    expect(row("c", 0, "transform.y", view).tried).toBe(false);
  });

  it("is left out without a look at it", () => {
    const { row, look } = trying();
    look.write([{ owner, path: "transform.x", op: "set", value: 10 }]);
    expect(row("c", 0, "transform.x")).toMatchObject({ value: 0, tried: false });
  });

  it("shows keys as keys, with the buttons going by them", () => {
    const { row, look, view } = trying();
    look.write([
      { owner, path: "transform.x", op: "setKey", time: "0", value: 1 },
      { owner, path: "transform.x", op: "setKey", time: "1", value: 2 },
    ]);
    expect(row("c", 0, "transform.x", view)).toMatchObject({
      animated: true,
      keyTime: "0",
      nextKey: 30,
    });
    expect(row("c", 15, "transform.x", view).value).toBe(1.5);
  });

  it("can have taken a property away", () => {
    const { row, run, look, view } = trying();
    run({
      type: "property.edit",
      params: {
        timeline: "main",
        edits: [{ owner, path: "transform.x", op: "set", value: 5 }],
      },
    });
    look.write([{ owner, path: "transform.x", op: "clear" }]);
    expect(row("c", 0, "transform.x", view)).toMatchObject({
      value: 0,
      stored: undefined,
      tried: true,
    });
  });

  it("goes into what follows from it, like a box that follows the media", () => {
    const { row, look, view } = trying();
    expect(row("c", 0, "transform.width", view).value).toBe(1920);
    look.write([{ owner, path: "transform.height", op: "set", value: 540 }]);
    expect(row("c", 0, "transform.width", view).value).toBe(1920 / 2);
  });

  it("marks what somebody else changed in the meantime", () => {
    const { row, run, look, view } = trying();
    look.write([{ owner, path: "transform.x", op: "set", value: 10 }]);
    expect(row("c", 0, "transform.x", view).changedElsewhere).toBe(false);
    run({
      type: "property.edit",
      params: {
        timeline: "main",
        edits: [{ owner, path: "transform.x", op: "set", value: 7 }],
      },
    });
    expect(row("c", 0, "transform.x", view)).toMatchObject({ value: 10, changedElsewhere: true });
  });

  it("makes way while comparing: what is saved shows, and nothing can be changed", () => {
    const { clipView, row, look } = trying();
    look.write([{ owner, path: "transform.x", op: "set", value: 10 }]);
    const comparing = { comparing: true };
    expect(row("c", 0, "transform.x", comparing)).toMatchObject({ value: 0, tried: false });
    expect(clipView("c", 0, comparing).blocked).toBe("comparing");
  });

  it("says what matters first when more than one thing is in the way", () => {
    const { clipView, add } = setup();
    add("c", { start: "5" });
    expect(clipView("c", 0).blocked).toBe("outside");
    expect(clipView("c", 0, { comparing: true }).blocked).toBe("comparing");
  });
});
