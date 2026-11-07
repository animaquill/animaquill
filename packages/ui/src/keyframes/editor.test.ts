import { orderedTracks, type PropertyEdit } from "@animaquill/core";
import { formatTime, parseTime, type Animation } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { RULER_HEIGHT, TimelineEditor } from "../timeline/editor.ts";
import type { Pointer } from "../timeline/gestures.ts";
import { TouchController } from "../timeline/touch.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ActionRegistry } from "../workbench/actions.ts";
import { registerTimelineActions } from "../timeline/actions.ts";
import { ProjectSession } from "../workbench/session.ts";
import { registerKeyframeActions } from "./actions.ts";
import { KeyframeEditor } from "./editor.ts";
import { LANE_HEIGHT, type Lane } from "./lanes.ts";
import { KeySelection, type KeyRef } from "./selection.ts";

const WIDTH = 1000;
const HEIGHT = 600;

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as never;

async function setup({ trying = true, memory = memoryWindow() } = {}) {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("关键帧");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: trying } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const commandFailed = vi.fn<(message: string) => void>();
  const timeline = new TimelineEditor(session, memory, settings, { commandFailed });
  await timeline.load();
  timeline.setViewport(WIDTH, 400);
  const trials = new TrialSession(session, timeline, new MemoryTrials(), settings, {
    commandFailed,
    overwrote: vi.fn(),
    discarded: vi.fn(),
    setAside: vi.fn(),
    back: vi.fn(),
    asideDropped: vi.fn(),
    unsure: vi.fn(),
    restored: vi.fn(),
    dropped: vi.fn(),
    readFailed: vi.fn(),
    keepFailed: vi.fn(),
    keepRecovered: vi.fn(),
  });
  await trials.load();
  await trials.settle();
  const writer = new PropertyWriter(session, timeline, trials, { commandFailed });
  const pasteTooEarly = vi.fn();
  const pasteNowhere = vi.fn();
  const comparing = vi.fn();
  const locked = vi.fn();
  const notShown = vi.fn();
  const open = () =>
    new KeyframeEditor(session, timeline, trials, writer, memory, settings, t, {
      pasteTooEarly,
      pasteNowhere,
      comparing,
      locked,
      notShown,
    });
  const keyframes = open();
  const { panel } = keyframes;
  panel.setViewport(WIDTH, HEIGHT);

  const main = () => {
    const found = store.getState().timelines["main"];
    if (!found) throw new Error("no timeline");
    return found;
  };
  const video = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;

  const addClip = (id: string, start: number, duration: number, extra: object = {}) => {
    const source = { kind: "color", color: "#112233" };
    const clip = { id, start: String(start), duration: String(duration), source, ...extra };
    const result = store.execute({
      type: "clip.add",
      params: { timeline: "main", track: video, clip },
    });
    if (!result.ok) throw new Error(result.error.message);
  };
  const edit = (...edits: PropertyEdit[]) => {
    const result = store.execute({ type: "property.edit", params: { timeline: "main", edits } });
    if (!result.ok) throw new Error(result.error.message);
  };
  const keys = (clip: string, path: string, ...moments: (number | string)[]) => {
    edit(
      ...moments.map((time, index): PropertyEdit => ({
        owner: { clip },
        path,
        op: "setKey",
        time: String(time),
        value: index * 10,
      })),
    );
  };

  /** Goes to all properties of a clip. */
  const openUp = (clip: string, ...groups: string[]) => {
    if (!keyframes.isOpen(node(clip))) keyframes.toggleOpen(clip);
    for (const group of groups) {
      const id = `${clip}/group:${group}`;
      if (!panel.lanes.find((lane) => lane.id === id)?.open) keyframes.toggleOpen(id);
    }
  };
  const node = (id: string) => {
    const lane = panel.lanes.find((one) => one.id === id);
    if (!lane) throw new Error(`no lane ${id}`);
    return lane.node;
  };
  const lane = (id: string) => {
    const found = panel.lanes.find((one) => one.id === id);
    if (!found) {
      throw new Error(`no lane ${id} in ${panel.lanes.map((one) => one.id).join(", ")}`);
    }
    return found;
  };
  const at = (seconds: number, id: string, extra: Partial<Pointer> = {}): Pointer => ({
    x: panel.xAt(seconds),
    y: panel.screenY(lane(id).top) + LANE_HEIGHT / 2,
    shift: false,
    alt: false,
    mod: false,
    ...extra,
  });
  const drag = (from: Pointer, to: Pointer) => {
    panel.press(from);
    panel.drag({ ...from, x: from.x + (to.x - from.x) / 2, y: from.y + (to.y - from.y) / 2 });
    panel.drag(to);
    panel.release(to);
  };
  const click = (pointer: Pointer) => {
    panel.press(pointer);
    panel.release(pointer);
  };
  /** What people see of a property, in seconds on the clock of the clip. */
  const shownTimes = (clip: string, path: string) => {
    const box = timeline.model?.boxes.get(clip);
    if (!box) throw new Error("no clip");
    const value = keyframes.shown(box.clip).properties?.[path] as Animation | undefined;
    return value?.keys.map(({ time }) => time) ?? [];
  };
  const savedTimes = (clip: string, path: string) => {
    const value = main().clips[clip]?.properties?.[path] as Animation | undefined;
    return value?.keys.map(({ time }) => time) ?? [];
  };
  const selected = () =>
    [...keyframes.selection].map(({ clip, path, time }) => `${clip} ${path} ${time}`).toSorted();
  const clipIds = () =>
    panel.lanes.filter(({ node: { kind } }) => kind === "clip").map(({ id }) => id);

  return {
    session,
    store,
    timeline,
    trials,
    writer,
    keyframes,
    panel,
    video,
    memory,
    commandFailed,
    pasteTooEarly,
    pasteNowhere,
    comparing,
    locked,
    notShown,
    main,
    addClip,
    edit,
    keys,
    open: openUp,
    reopen: open,
    lane,
    at,
    drag,
    click,
    shownTimes,
    savedTimes,
    selected,
    clipIds,
  };
}

const X = "transform.x";
const Y = "transform.y";
const laneOf = (clip: string, path: string) => `${clip}/${path}`;

describe("what the list shows", () => {
  it("only lists what is at the playhead, and follows it", async () => {
    const { addClip, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    expect(clipIds()).toEqual(["a"]);
    timeline.seek(60);
    expect(clipIds()).toEqual(["b"]);
    timeline.seek(120);
    expect(clipIds()).toEqual([]);
  });

  it("stays as it is while playing and catches up when it stops", async () => {
    const { addClip, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    timeline.togglePlayback();
    timeline.tick(0);
    timeline.tick(3000);
    expect(timeline.frame).toBeGreaterThan(60);
    expect(clipIds()).toEqual(["a"]);
    timeline.pause();
    expect(clipIds()).toEqual(["b"]);
  });

  it("the whole list and what has keys are not about the moment", async () => {
    const { addClip, keys, keyframes, timeline, clipIds, open, panel } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    keys("b", X, 0, 1);
    keyframes.setRange("all");
    expect(clipIds()).toEqual(["a", "b"]);
    keyframes.setRange("keyed");
    expect(clipIds()).toEqual(["b"]);
    timeline.seek(0);
    expect(clipIds()).toEqual(["b"]);
    open("b", "position");
    expect(panel.lanes.map(({ id }) => id)).toEqual([
      expect.stringContaining("track:"),
      "b",
      "b/group:position",
      laneOf("b", X),
    ]);
  });

  it("what is selected on the timeline and what is pinned stay, wherever the playhead is", async () => {
    const { addClip, keyframes, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    addClip("c", 4, 2);
    timeline.selectOnly("b");
    keyframes.togglePin("c");
    expect(clipIds()).toEqual(["a", "b", "c"]);
    timeline.clearSelection();
    keyframes.togglePin("c");
    expect(clipIds()).toEqual(["a"]);
  });

  it("keys that nothing describes stay in the list, wherever the playhead is", async () => {
    const { addClip, keys, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    keys("b", "param.old", 0, 1);
    expect(clipIds()).toEqual(["a", "b"]);
    timeline.seek(240);
    expect(clipIds()).toEqual(["b"]);
  });

  it("clips come in the order of the timeline, whatever got them on the list", async () => {
    const { addClip, keyframes, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    addClip("c", 4, 2);
    timeline.seek(70);
    keyframes.togglePin("c");
    timeline.selectOnly("a");
    expect(clipIds()).toEqual(["a", "b", "c"]);
  });

  it("finds properties by name, and opens what they are in", async () => {
    const { addClip, keyframes, panel } = await setup();
    addClip("a", 0, 2);
    keyframes.setQuery("transform.y");
    expect(panel.lanes.map(({ id }) => id)).toEqual([
      expect.stringContaining("track:"),
      "a",
      "a/group:position",
      laneOf("a", Y),
    ]);
    keyframes.setQuery("nothing like it");
    expect(panel.lanes).toEqual([]);
    keyframes.setQuery("");
    expect(panel.lanes.map(({ id }) => id)).toEqual([expect.stringContaining("track:"), "a"]);
  });

  it("a property that only has keys in what is being tried counts as having keys", async () => {
    const { addClip, writer, keyframes, clipIds } = await setup();
    addClip("a", 0, 2);
    keyframes.setRange("keyed");
    expect(clipIds()).toEqual([]);
    writer.commit([{ owner: { clip: "a" }, path: X, op: "setKey", time: "1", value: 1 }]);
    expect(clipIds()).toEqual(["a"]);
  });

  it("does not bother behind another tab, and catches up when it shows", async () => {
    const { addClip, panel, timeline, clipIds } = await setup();
    addClip("a", 0, 2);
    addClip("b", 2, 2);
    panel.setViewport(0, 0);
    timeline.seek(60);
    expect(clipIds()).toEqual(["a"]);
    panel.setViewport(WIDTH, HEIGHT);
    expect(clipIds()).toEqual(["b"]);
  });

  it("remembers what people chose for this window, and not what they selected", async () => {
    const memory = memoryWindow();
    const first = await setup({ memory });
    first.addClip("a", 0, 2);
    first.keyframes.setRange("all");
    first.keyframes.togglePin("a");
    first.keyframes.toggleOpen("a");
    first.panel.zoomAround(100, 2);
    first.keyframes.flush();
    const id = first.store.getState().manifest.id;
    const saved = JSON.parse(memory.read(`keyframes.${id}`) as string) as Record<string, unknown>;
    expect(saved).toMatchObject({ range: "all", pinned: ["a"], toggled: ["a"] });
    expect(saved).toHaveProperty("view");
    expect(saved).not.toHaveProperty("selection");
  });

  it("comes back to it, also to its own view", async () => {
    const memory = memoryWindow();
    const first = await setup({ memory });
    const { keyframes, panel } = first;
    first.addClip("a", 0, 60);
    keyframes.setRange("keyed");
    keyframes.togglePin("a");
    keyframes.toggleOpen("a");
    keyframes.setCurveHeight("a/transform.x", 150);
    panel.zoomAround(100, 3);
    panel.rowsTaller();
    const seen = panel.pixelsPerSecond;
    const rows = panel.rowScale;
    first.timeline.setScroll(0, 0);
    keyframes.flush();

    const again = first.reopen();
    expect(again.getSnapshot()).toMatchObject({ range: "keyed" });
    expect(again.getSnapshot().pinned.has("a")).toBe(true);
    expect(again.curveHeightOf("a/transform.x")).toBe(150);
    again.panel.setViewport(WIDTH, HEIGHT);
    expect(again.panel.lanes.find(({ id }) => id === "a")?.open).toBe(true);
    expect(again.panel.pixelsPerSecond).toBe(seen);
    expect(again.panel.rowScale).toBe(rows);
    expect(rows).toBeGreaterThan(1);
  });

  it("forgets what it remembers of clips and tracks that are gone", async () => {
    const memory = memoryWindow();
    const first = await setup({ memory });
    const { addClip, keys, keyframes, store, timeline } = first;
    addClip("a", 0, 4);
    keys("a", X, 1);
    addClip("b", 4, 4);
    keys("b", X, 1);
    keyframes.toggleOpen("b");
    keyframes.togglePin("b");
    keyframes.setCurveHeight("b/transform.x", 120);
    const box = timeline.model?.boxes.get("b");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    keyframes.toggleOpen("a");
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["b"] } });
    keyframes.flush();
    const id = store.getState().manifest.id;
    const written = memory.read(`keyframes.${id}`) ?? "";
    expect(written).not.toContain('"b');
    expect(written).toContain('"a"');
    // What was written before the clip went is forgotten as well, when it is read again.
    const before = { toggled: ["a", "b"], pinned: ["b"], open: ["b"] };
    memory.write(`keyframes.${id}`, JSON.stringify(before));
    const again = first.reopen();
    expect([...again.getSnapshot().pinned]).toEqual([]);
    expect(again.inTimeline.opened).toEqual([]);
    expect(again.isOpen({ kind: "clip", id: "a" } as never)).toBe(true);
  });

  it("makes the best of what it remembers when that is damaged", async () => {
    const memory = memoryWindow();
    const { reopen, store } = await setup({ memory });
    const key = `keyframes.${store.getState().manifest.id}`;
    for (const broken of [
      "not json",
      "null",
      '{"range":"everything","pinned":5,"curves":[["a"],7]}',
      '{"view":{"pixelsPerSecond":-1,"scrollX":"a"},"rows":"tall"}',
      '{"rows":1e9}',
    ]) {
      memory.write(key, broken);
      const editor = reopen();
      expect(editor.getSnapshot().range).toBe("here");
      editor.panel.setViewport(WIDTH, HEIGHT);
      expect(editor.panel.pixelsPerSecond).toBeGreaterThan(0);
      expect(editor.panel.rowScale).toBeLessThanOrEqual(3);
      expect(editor.getSnapshot().pinned.size).toBe(0);
    }
  });
});

describe("selecting keys", () => {
  async function twoKeys() {
    const setting = await setup();
    setting.addClip("a", 0, 8);
    setting.keys("a", X, 1, 2);
    setting.keys("a", Y, 1, 3);
    setting.open("a", "position");
    return setting;
  }

  it("a click takes the one key, and a click next to it nothing", async () => {
    const { click, at, selected } = await twoKeys();
    click(at(1, laneOf("a", X)));
    expect(selected()).toEqual(["a transform.x 1"]);
    click(at(4, laneOf("a", X)));
    expect(selected()).toEqual([]);
  });

  it("Ctrl adds and takes away, and a click on a selected key leaves only that one", async () => {
    const { click, at, selected } = await twoKeys();
    click(at(1, laneOf("a", X)));
    click(at(2, laneOf("a", X), { mod: true }));
    expect(selected()).toEqual(["a transform.x 1", "a transform.x 2"]);
    click(at(2, laneOf("a", X), { mod: true }));
    expect(selected()).toEqual(["a transform.x 1"]);
    click(at(2, laneOf("a", X), { shift: true }));
    click(at(1, laneOf("a", X)));
    expect(selected()).toEqual(["a transform.x 1"]);
  });

  it("a box takes what is in it, and with Shift adds to what there is", async () => {
    const { panel, at, drag, selected } = await twoKeys();
    const from = at(0.5, laneOf("a", X));
    drag(from, { ...at(1.5, laneOf("a", Y)) });
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1"]);
    drag(at(2.5, laneOf("a", X), { shift: true }), at(3.5, laneOf("a", Y), { shift: true }));
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1", "a transform.y 3"]);
    drag(at(5, laneOf("a", X)), at(6, laneOf("a", Y)));
    expect(selected()).toEqual([]);
    expect(panel.isDragging).toBe(false);
  });

  it("Escape puts a box back the way it was", async () => {
    const { panel, keyframes, at, click, selected } = await twoKeys();
    click(at(1, laneOf("a", X)));
    const before = selected();
    panel.press(at(5, laneOf("a", X)));
    panel.drag(at(6, laneOf("a", Y)));
    expect(keyframes.preview?.marquee).toBeDefined();
    expect(panel.cancelDrag()).toBe(true);
    expect(selected()).toEqual(before);
    expect(keyframes.preview).toBeUndefined();
  });

  it("a box over a summary takes what is under it, also when it is closed", async () => {
    const { keyframes, at, drag, selected } = await twoKeys();
    keyframes.toggleOpen("a/group:position");
    drag(at(0.5, "a/group:position"), at(1.5, "a/group:position"));
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1"]);
  });

  it("selects a whole row, and all keys of a moment", async () => {
    const { panel, lane, at, selected } = await twoKeys();
    panel.selectLane(lane(laneOf("a", X)), false);
    expect(selected()).toEqual(["a transform.x 1", "a transform.x 2"]);
    const hit = panel.hitAt(at(1, laneOf("a", X)));
    if (hit.kind !== "key") throw new Error("no key");
    panel.selectColumn(hit, false);
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1"]);
    panel.selectLane(lane(laneOf("a", Y)), true);
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1", "a transform.y 3"]);
  });

  it("all keys of a moment are also the ones that are closed", async () => {
    const { panel, keyframes, at, selected } = await twoKeys();
    const hit = panel.hitAt(at(1, laneOf("a", X)));
    keyframes.toggleOpen("a");
    if (hit.kind !== "key") throw new Error("no key");
    panel.selectColumn(hit, false);
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1"]);
  });

  it("a box goes by the clock of the clip", async () => {
    const { addClip, keys, keyframes, open, at, drag, selected } = await twoKeys();
    addClip("late", 8, 4, { offset: "3" });
    keys("late", X, 3.2, 4, 6);
    keyframes.setRange("all");
    open("late", "position");
    // On the timeline these keys are at 8.2, 9 and 11.
    drag(at(8.5, laneOf("late", X)), at(9.5, laneOf("late", X)));
    expect(selected()).toEqual(["late transform.x 4"]);
  });

  it("a key that goes away stops being selected", async () => {
    const { store, click, at, selected, edit, trials } = await twoKeys();
    click(at(2, laneOf("a", X)));
    edit({ owner: { clip: "a" }, path: X, op: "removeKey", time: "2" });
    expect(selected()).toEqual([]);
    expect(store.canUndo).toBe(true);
    expect(trials.getSnapshot().count).toBe(0);
  });
});

describe("moving keys", () => {
  async function keyed({ trying = true } = {}) {
    const setting = await setup({ trying });
    setting.addClip("a", 0, 8);
    setting.keys("a", X, 1, 2);
    setting.open("a", "position");
    return setting;
  }

  it("a drag only shows, and letting go is one step of what is tried", async () => {
    const { panel, at, savedTimes, shownTimes, writer, trials, store } = await keyed();
    const { revision } = store;
    const from = at(2, laneOf("a", X));
    panel.press(from);
    panel.drag(at(3, laneOf("a", X)));
    panel.drag(at(4, laneOf("a", X)));
    expect(writer.getPreviewed().get("a")?.has(X)).toBe(true);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    panel.release(at(4, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["1", "4"]);
    expect(savedTimes("a", X)).toEqual(["1", "2"]);
    expect(store.revision).toBe(revision);
    expect(trials.getSnapshot().count).toBe(1);
    expect(trials.canUndo).toBe(true);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(trials.canUndo).toBe(false);
  });

  it("without trying it is one step of the project, and saving is one command either way", async () => {
    const direct = await keyed({ trying: false });
    direct.drag(direct.at(2, laneOf("a", X)), direct.at(3, laneOf("a", X)));
    expect(direct.savedTimes("a", X)).toEqual(["1", "3"]);
    direct.store.undo();
    expect(direct.savedTimes("a", X)).toEqual(["1", "2"]);

    const tried = await keyed();
    tried.drag(tried.at(2, laneOf("a", X)), tried.at(3, laneOf("a", X)));
    expect(tried.trials.save()).toBe(true);
    expect(tried.savedTimes("a", X)).toEqual(["1", "3"]);
    tried.store.undo();
    expect(tried.savedTimes("a", X)).toEqual(["1", "2"]);
  });

  it("what is selected goes along, as far apart as it was, and stays selected", async () => {
    const { click, at, drag, shownTimes, selected } = await keyed();
    click(at(1, laneOf("a", X)));
    click(at(2, laneOf("a", X), { mod: true }));
    drag(at(2, laneOf("a", X)), at(3, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
    expect(selected()).toEqual(["a transform.x 2", "a transform.x 3"]);
  });

  it("keys of several properties and clips go in one step", async () => {
    const setting = await keyed();
    const { addClip, keys, click, at, drag, trials, shownTimes, keyframes, open } = setting;
    addClip("b", 8, 2, { offset: "5" });
    keys("b", X, 6);
    keyframes.setRange("all");
    open("b", "position");
    click(at(1, laneOf("a", X)));
    click(at(9, laneOf("b", X), { mod: true }));
    drag(at(1, laneOf("a", X)), at(1.5, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["1.5", "2"]);
    expect(shownTimes("b", X)).toEqual(["6.5"]);
    expect(trials.getSnapshot().count).toBe(2);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(shownTimes("b", X)).toEqual(["6"]);
  });

  it("Escape leaves no trace, and neither does a click", async () => {
    const { panel, at, click, shownTimes, writer, trials, keyframes } = await keyed();
    panel.press(at(2, laneOf("a", X)));
    panel.drag(at(4, laneOf("a", X)));
    panel.cancelDrag();
    expect(writer.getPreviewed().get("a")?.has(X) ?? false).toBe(false);
    expect(keyframes.preview).toBeUndefined();
    click(at(2, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(trials.getSnapshot().count).toBe(0);
  });

  it("moving less than a few pixels is a click", async () => {
    const { panel, at, click, selected, shownTimes, trials } = await keyed();
    click(at(1, laneOf("a", X)));
    click(at(2, laneOf("a", X), { mod: true }));
    const from = at(2, laneOf("a", X));
    panel.press(from);
    panel.drag({ ...from, x: from.x + 3 });
    panel.release({ ...from, x: from.x + 3 });
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(trials.canUndo).toBe(false);
    expect(selected()).toEqual(["a transform.x 2"]);
  });

  it("back where it came from it sticks, and nothing happened", async () => {
    const { panel, at, trials, writer, keyframes } = await keyed();
    const from = at(2, laneOf("a", X));
    panel.press(from);
    panel.drag(at(3, laneOf("a", X)));
    panel.drag({ ...from, x: from.x + 3 });
    expect(keyframes.preview?.shift).toBe(0);
    panel.release({ ...from, x: from.x + 3 });
    expect(trials.canUndo).toBe(false);
    expect(writer.getPreviewed().get("a")?.has(X) ?? false).toBe(false);
  });

  it("lands on frames", async () => {
    const { panel, at, drag, shownTimes } = await keyed();
    const pixels = panel.pixelsPerSecond;
    const from = at(2, laneOf("a", X));
    // Between frames, and far from anything that it could stick to.
    const target = 5.01;
    drag(from, { ...from, x: from.x + (target - 2) * pixels, alt: false });
    expect(shownTimes("a", X)).toEqual(["1", "5"]);
  });

  it("sticks to the playhead, to other keys and to the edges of clips, exactly", async () => {
    const setting = await keyed();
    const { panel, keys, timeline, at, drag, shownTimes, open, trials } = setting;
    keys("a", Y, "10/3");
    open("a", "position");
    timeline.seek(107);
    const pixels = panel.pixelsPerSecond;
    const near = (seconds: number) => ({ x: panel.xAt(seconds) + 2, y: 0 });
    const from = at(2, laneOf("a", X));
    const go = (seconds: number) => drag(from, { ...from, x: near(seconds).x });
    go(107 / 30);
    expect(shownTimes("a", X)).toEqual(["1", "107/30"]);
    trials.undo();
    go(10 / 3);
    expect(shownTimes("a", X)).toEqual(["1", "10/3"]);
    trials.undo();
    go(8);
    expect(shownTimes("a", X)).toEqual(["1", "8"]);
    expect(pixels).toBeGreaterThan(0);
  });

  it("does not stick to keys of its own row, because landing there replaces them", async () => {
    const { panel, keys, at, keyframes, drag, shownTimes } = await keyed();
    keys("a", X, "4.5");
    const from = at(2, laneOf("a", X));
    const pointer = { ...from, x: panel.xAt(4.5) + 3 };
    panel.press(from);
    panel.drag(pointer);
    expect(keyframes.preview?.snap).toBeUndefined();
    panel.cancelDrag();
    drag(from, { ...from, x: panel.xAt(4.5) });
    expect(shownTimes("a", X)).toEqual(["1", "4.5"]);
  });

  it("Alt goes between frames and past what it would stick to", async () => {
    const { panel, keys, at, drag, shownTimes, open } = await keyed();
    keys("a", Y, 5);
    open("a", "position");
    const from = at(2, laneOf("a", X));
    const pointer = (seconds: number) => ({ ...from, x: panel.xAt(seconds), alt: true });
    drag({ ...from, alt: true }, pointer(5.011));
    const [, moved] = shownTimes("a", X);
    expect(Number(moved)).toBeCloseTo(5.011, 2);
    expect(Number(moved)).not.toBeCloseTo(5, 3);
    expect((Number(moved) * 30) % 1).not.toBe(0);
  });

  it("nothing goes before the clock of its clip starts, and the others stop with it", async () => {
    const { click, at, panel, drag, shownTimes, keyframes } = await keyed();
    click(at(1, laneOf("a", X)));
    click(at(2, laneOf("a", X), { mod: true }));
    const from = at(2, laneOf("a", X));
    drag(from, { ...from, x: panel.xAt(0) - 200 });
    expect(shownTimes("a", X)).toEqual(["0", "1"]);
    expect(keyframes.selection.size).toBe(2);
  });

  it("a clip that starts later has a clock that started before it", async () => {
    const { addClip, keys, keyframes, open, at, panel, drag, shownTimes } = await setup();
    addClip("late", 4, 4, { offset: "2" });
    keys("late", X, 3);
    keyframes.setRange("all");
    open("late", "position");
    // Key at 3 on the clock is 5 on the timeline, and the clock reads 0 at 2 on the timeline.
    const from = at(5, laneOf("late", X));
    drag(from, { ...from, x: panel.xAt(2) - 300 });
    expect(shownTimes("late", X)).toEqual(["0"]);
  });

  it("a key on a clip that was trimmed can be moved like any other", async () => {
    const { addClip, keys, keyframes, open, at, drag, shownTimes } = await setup();
    addClip("trimmed", 2, 2, { offset: "1" });
    keys("trimmed", X, 0);
    keyframes.setRange("all");
    open("trimmed", "position");
    drag(at(1, laneOf("trimmed", X)), at(3, laneOf("trimmed", X)));
    expect(shownTimes("trimmed", X)).toEqual(["2"]);
  });

  it("a clip that goes away takes the drag with it", async () => {
    const { panel, at, store, writer, keyframes } = await keyed();
    panel.press(at(2, laneOf("a", X)));
    panel.drag(at(3, laneOf("a", X)));
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a"] } });
    expect(panel.isDragging).toBe(false);
    expect(keyframes.preview).toBeUndefined();
    expect(writer.getPreviewed().size).toBe(0);
  });

  it("a locked key can be selected and copied, and a drag from it moves nothing", async () => {
    const { timeline, video, panel, at, click, drag, shownTimes, selected, keyframes } =
      await keyed();
    timeline.updateTrack(video, { locked: true });
    click(at(1, laneOf("a", X)));
    expect(selected()).toEqual(["a transform.x 1"]);
    expect(keyframes.hasMovableSelection).toBe(false);
    drag(at(1, laneOf("a", X)), at(3, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(panel.isDragging).toBe(false);
    keyframes.nudge(3);
    keyframes.deleteSelected();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
  });

  it("a box and selecting everything leave locked keys out", async () => {
    const { timeline, video, at, drag, panel, selected } = await keyed();
    panel.selectAll();
    expect(selected()).toHaveLength(2);
    timeline.updateTrack(video, { locked: true });
    drag(at(0.5, laneOf("a", X)), at(2.5, laneOf("a", X)));
    expect(selected()).toEqual([]);
    panel.selectAll();
    expect(selected()).toEqual([]);
  });

  it("nothing moves while people compare with what is saved", async () => {
    const { trials, at, drag, shownTimes, keyframes, click } = await keyed();
    drag(at(2, laneOf("a", X)), at(3, laneOf("a", X)));
    trials.toggleCompare();
    expect(keyframes.comparing).toBe(true);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    // A key that is there in both, so that only being compared can stop it.
    drag(at(1, laneOf("a", X)), at(1.5, laneOf("a", X)));
    click(at(1, laneOf("a", X)));
    keyframes.nudge(5);
    keyframes.deleteSelected();
    trials.toggleCompare();
    expect(shownTimes("a", X)).toEqual(["1", "3"]);
    click(at(3, laneOf("a", X)));
    expect(keyframes.selection.size).toBe(1);
  });
});

describe("a summary", () => {
  async function keyed() {
    const setting = await setup();
    setting.addClip("a", 0, 8);
    setting.keys("a", X, 1, 2);
    setting.keys("a", Y, 1, 3);
    setting.keys("a", "opacity", 3);
    setting.open("a", "position");
    return setting;
  }

  it("a press takes all that is below it at that moment", async () => {
    const { click, at, selected } = await keyed();
    click(at(1, "a"));
    expect(selected()).toEqual(["a transform.x 1", "a transform.y 1"]);
    click(at(3, "a/group:position"));
    expect(selected()).toEqual(["a transform.y 3"]);
  });

  it("dragging one takes what is below along, in one step", async () => {
    const { at, drag, shownTimes, trials } = await keyed();
    drag(at(1, "a/group:position"), at(1.5, "a/group:position"));
    expect(shownTimes("a", X)).toEqual(["1.5", "2"]);
    expect(shownTimes("a", Y)).toEqual(["1.5", "3"]);
    expect(shownTimes("a", "opacity")).toEqual(["3"]);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(shownTimes("a", Y)).toEqual(["1", "3"]);
  });

  it("a track takes all of its clips along, closed or not", async () => {
    const { addClip, keys, keyframes, at, drag, shownTimes, panel } = await keyed();
    addClip("b", 8, 4, { offset: "1" });
    keys("b", X, 2);
    keyframes.setRange("all");
    const track = panel.lanes[0] as Lane;
    expect(track.node.kind).toBe("track");
    drag(at(9, track.id), at(9.5, track.id));
    expect(shownTimes("b", X)).toEqual(["2.5"]);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
  });
});

describe("what else can be done to keys", () => {
  async function keyed() {
    const setting = await setup();
    setting.addClip("a", 0, 8);
    setting.keys("a", X, 1, 2);
    setting.open("a", "position");
    return setting;
  }

  it("the arrow keys go by frames, all of them or none", async () => {
    const { keyframes, click, at, shownTimes, trials, commandFailed } = await keyed();
    click(at(1, laneOf("a", X)));
    keyframes.nudge(1);
    expect(shownTimes("a", X)).toEqual(["31/30", "2"]);
    keyframes.nudge(-1);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    keyframes.nudge(-31);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
    expect(keyframes.selection.size).toBe(1);
    expect(commandFailed).not.toHaveBeenCalled();
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["31/30", "2"]);
  });

  it("deleting is one step, and the last key leaves its value", async () => {
    const { keyframes, click, at, shownTimes, trials, timeline } = await keyed();
    click(at(1, laneOf("a", X)));
    click(at(2, laneOf("a", X), { mod: true }));
    keyframes.deleteSelected();
    const box = timeline.model?.boxes.get("a");
    if (!box) throw new Error("no clip");
    expect(keyframes.shown(box.clip).properties?.[X]).toBe(10);
    expect(keyframes.selection.size).toBe(0);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
  });

  it("changes how keys go on, and tells which one it is", async () => {
    const { keyframes, click, at, trials, timeline } = await keyed();
    click(at(1, laneOf("a", X)));
    expect(keyframes.selectedPreset).toBe("linear");
    keyframes.setEase({ interp: "hold" });
    expect(keyframes.selectedPreset).toBe("hold");
    keyframes.setEase({ interp: "bezier", out: [0.42, 0], in: [0.58, 1] });
    expect(keyframes.selectedPreset).toBe("easeInOut");
    keyframes.setEase({ interp: "bezier", out: [0.1, 0.2], in: [0.3, 0.4] });
    expect(keyframes.selectedPreset).toBeUndefined();
    const box = timeline.model?.boxes.get("a");
    if (!box) throw new Error("no clip");
    const { keys } = (keyframes.shown(box.clip).properties ?? {})[X] as Animation;
    expect(keys[0]).toMatchObject({ interp: "bezier", out: [0.1, 0.2] });
    expect(keys[1]).toMatchObject({ in: [0.3, 0.4] });
    trials.undo();
    expect(keyframes.selectedPreset).toBe("easeInOut");
  });

  it("different keys have no one way of going on", async () => {
    const { keyframes, click, at } = await keyed();
    click(at(1, laneOf("a", X)));
    keyframes.setEase({ interp: "hold" });
    click(at(2, laneOf("a", X), { mod: true }));
    expect(keyframes.selectedPreset).toBeUndefined();
  });

  describe("copying", () => {
    it("comes back at the playhead, as far apart as it was, with how it goes on", async () => {
      const { keyframes, click, at, timeline, shownTimes, selected } = await keyed();
      click(at(1, laneOf("a", X)));
      keyframes.setEase({ interp: "hold" });
      click(at(2, laneOf("a", X), { mod: true }));
      keyframes.copySelected();
      timeline.seek(120);
      keyframes.paste();
      expect(shownTimes("a", X)).toEqual(["1", "2", "4", "5"]);
      expect(selected()).toEqual(["a transform.x 4", "a transform.x 5"]);
      const box = timeline.model?.boxes.get("a");
      if (!box) throw new Error("no clip");
      const { keys } = (keyframes.shown(box.clip).properties ?? {})[X] as Animation;
      expect(keys[2]).toMatchObject({ value: 0, interp: "hold" });
      expect(keys[3]).toMatchObject({ value: 10 });
      expect(timeline.frame).toBe(120);
    });

    it("goes by the earliest key, whichever got selected first", async () => {
      const { keyframes, click, at, timeline, shownTimes } = await keyed();
      click(at(2, laneOf("a", X)));
      click(at(1, laneOf("a", X), { mod: true }));
      keyframes.copySelected();
      timeline.seek(120);
      keyframes.paste();
      expect(shownTimes("a", X)).toEqual(["1", "2", "4", "5"]);
    });

    it("is one step, and takes the place of what is there", async () => {
      const { keyframes, click, at, timeline, shownTimes, trials } = await keyed();
      click(at(1, laneOf("a", X)));
      keyframes.copySelected();
      timeline.seek(60);
      keyframes.paste();
      expect(shownTimes("a", X)).toEqual(["1", "2"]);
      trials.undo();
      expect(trials.canUndo).toBe(false);
    });

    it("keeps moments of different properties and clips apart", async () => {
      const { addClip, keys, keyframes, open, click, at, timeline, shownTimes } = await keyed();
      addClip("b", 8, 4, { offset: "2" });
      keys("b", X, 2);
      keyframes.setRange("all");
      open("b", "position");
      click(at(2, laneOf("a", X)));
      click(at(8, laneOf("b", X), { mod: true }));
      keyframes.copySelected();
      timeline.seek(90);
      keyframes.paste();
      expect(shownTimes("a", X)).toEqual(["1", "2", "3"]);
      expect(shownTimes("b", X)).toEqual(["2", "3"]);
    });

    it("keys of one clip go to the clip that is selected, into the same property", async () => {
      const { addClip, keyframes, click, at, timeline, shownTimes, clipIds } = await keyed();
      addClip("b", 8, 4, { offset: "3" });
      click(at(1, laneOf("a", X)));
      click(at(2, laneOf("a", X), { mod: true }));
      keyframes.copySelected();
      timeline.selectOnly("b");
      timeline.seek(270);
      keyframes.paste();
      expect(clipIds()).toContain("b");
      expect(shownTimes("b", X)).toEqual(["4", "5"]);
      expect(shownTimes("a", X)).toEqual(["1", "2"]);
    });

    it("says so when it would not fit on the clock", async () => {
      const { addClip, keyframes, click, at, timeline, shownTimes, pasteTooEarly } = await keyed();
      addClip("b", 8, 4);
      click(at(1, laneOf("a", X)));
      keyframes.copySelected();
      timeline.selectOnly("b");
      timeline.seek(30);
      keyframes.paste();
      expect(pasteTooEarly).toHaveBeenCalledOnce();
      expect(shownTimes("b", X)).toEqual([]);
    });

    it("says so when the clip is gone or locked", async () => {
      const setting = await keyed();
      const { keyframes, click, at, timeline, video, pasteNowhere, shownTimes } = setting;
      click(at(1, laneOf("a", X)));
      keyframes.copySelected();
      timeline.updateTrack(video, { locked: true });
      timeline.seek(120);
      keyframes.paste();
      expect(pasteNowhere).toHaveBeenCalledOnce();
      expect(shownTimes("a", X)).toEqual(["1", "2"]);
    });

    it("forgets it with the project", async () => {
      const { keyframes, click, at, session } = await keyed();
      click(at(1, laneOf("a", X)));
      keyframes.copySelected();
      expect(keyframes.getSnapshot().hasClipboard).toBe(true);
      await session.close();
      expect(keyframes.getSnapshot().hasClipboard).toBe(false);
    });
  });
});

describe("a row with its curve", () => {
  it("opening it makes the lane taller, and pulling its edge changes that", async () => {
    const { addClip, keys, open, lane, keyframes, panel } = await setup();
    addClip("a", 0, 8);
    keys("a", X, 1, 2);
    open("a", "position");
    const id = laneOf("a", X);
    const closed = lane(id).height;
    keyframes.toggleOpen(id);
    const opened = lane(id).height;
    expect(opened).toBeGreaterThan(closed);
    const y = panel.screenY(lane(id).top) + opened - 2;
    const edge = { x: 100, y, shift: false, alt: false, mod: false };
    expect(panel.hover(edge)).toBe("ns-resize");
    panel.press(edge);
    panel.drag({ ...edge, y: y + 40 });
    expect(lane(id).height).toBe(opened + 40);
    panel.cancelDrag();
    expect(lane(id).height).toBe(opened);
    panel.press(edge);
    panel.drag({ ...edge, y: y + 1000 });
    panel.release({ ...edge, y: y + 1000 });
    const tallest = lane(id).height;
    expect(tallest).toBeLessThan(opened + 1000);
    expect(keyframes.curveHeightOf(id) + LANE_HEIGHT).toBe(tallest);
  });

  it("what comes below moves down", async () => {
    const { addClip, open, lane, keyframes } = await setup();
    addClip("a", 0, 8);
    open("a", "position");
    const before = lane(laneOf("a", Y)).top;
    keyframes.toggleOpen(laneOf("a", X));
    expect(lane(laneOf("a", Y)).top).toBeGreaterThan(before);
  });
});

describe("the view of the tab", () => {
  it("scrolls and zooms on its own, and the timeline on its own", async () => {
    const { addClip, timeline, panel } = await setup();
    addClip("a", 0, 60);
    const scale = timeline.pixelsPerSecond;
    panel.zoomAround(100, 2);
    panel.setScroll(300, 0);
    expect(timeline.pixelsPerSecond).toBe(scale);
    expect(timeline.scrollX).toBe(0);
    const own = { pixelsPerSecond: panel.pixelsPerSecond, scrollX: panel.scrollX };
    timeline.zoomAround(0, 4);
    timeline.setScroll(1000, 0);
    expect({ pixelsPerSecond: panel.pixelsPerSecond, scrollX: panel.scrollX }).toEqual(own);
  });

  it("follows the playhead, which is the one of the timeline", async () => {
    const { addClip, timeline, panel } = await setup();
    addClip("a", 0, 60);
    panel.zoomAround(0, 8);
    timeline.seek(timeline.model ? 50 * timeline.model.rate.fps : 0);
    const x = panel.xAt(50);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(WIDTH);
    // Out of sight, it waits until it shows again.
    panel.setViewport(0, 0);
    timeline.seek(0);
    panel.setViewport(WIDTH, HEIGHT);
    expect(panel.xAt(0)).toBeGreaterThanOrEqual(0);
    expect(panel.xAt(0)).toBeLessThanOrEqual(WIDTH);
  });

  it("the ruler moves the playhead under the mouse, whatever the timeline shows", async () => {
    const { addClip, timeline, panel } = await setup();
    addClip("a", 0, 60);
    // The timeline is narrow, or out of sight: neither moves what the tab shows.
    for (const width of [200, 0]) {
      timeline.setViewport(width, 400);
      panel.zoomToFit();
      const pointer = { x: 700, y: RULER_HEIGHT / 2, shift: false, alt: false, mod: false };
      panel.press(pointer);
      for (let step = 0; step < 5; step += 1) panel.drag(pointer);
      panel.release(pointer);
      expect(panel.xAt(timeline.frame / (timeline.model?.rate.fps ?? 30))).toBeCloseTo(700, -1);
    }
  });

  it("rows of keys get taller and shorter, and what is at the top stays there", async () => {
    const { addClip, keyframes, panel } = await setup();
    for (let index = 0; index < 60; index += 1) addClip(`c${index}`, index, 1);
    keyframes.setRange("all");
    const lane = panel.lanes[10];
    if (!lane) throw new Error("no lane");
    panel.setScroll(panel.scrollX, lane.top);
    panel.rowsTaller();
    const taller = panel.lanes.find(({ id }) => id === lane.id);
    expect(taller?.keyHeight).toBe(30);
    expect(taller?.top).toBe(panel.scrollY);
    for (let step = 0; step < 10; step += 1) panel.rowsShorter();
    expect(panel.lanes[0]?.keyHeight).toBe(20);
    for (let step = 0; step < 20; step += 1) panel.zoomRowsAround(RULER_HEIGHT, 2);
    expect(panel.lanes[0]?.keyHeight).toBe(72);
  });

  it("the moment under a zoom stays where it is on its own", async () => {
    const { addClip, panel } = await setup();
    addClip("a", 0, 60);
    const moment = panel.timeAt(300);
    panel.zoomAround(300, 3);
    expect(panel.timeAt(300)).toBeCloseTo(moment);
  });

  it("works before the timeline ever had a size", async () => {
    const session = await setup();
    const { addClip, panel, timeline } = session;
    addClip("a", 0, 10);
    expect(panel.pixelsPerSecond).toBeGreaterThan(0);
    expect(timeline.pixelsPerSecond).toBeGreaterThan(0);
  });

  it("scrolls through the lanes, not past them", async () => {
    const { addClip, keyframes, panel } = await setup();
    for (let index = 0; index < 60; index += 1) addClip(`c${index}`, index, 1);
    keyframes.setRange("all");
    panel.setScroll(panel.scrollX, 100_000);
    expect(panel.scrollY).toBe(panel.contentHeight - HEIGHT);
    panel.setScroll(panel.scrollX, -5);
    expect(panel.scrollY).toBe(0);
    keyframes.setRange("here");
    expect(panel.scrollY).toBe(0);
  });

  it("the ruler covers what scrolled under it: a click there reaches no key and no row", async () => {
    const { addClip, keys, open, panel, keyframes, timeline } = await setup();
    keyframes.setRange("all");
    for (let index = 0; index < 6; index += 1) {
      addClip(`c${index}`, index * 3, 3);
      keys(`c${index}`, X, 1, 2);
      open(`c${index}`, "position");
    }
    const lane = panel.lanes.find(({ id }) => id === "c2/transform.x");
    if (!lane) throw new Error("no lane");
    // That lane is right under the ruler now, with its key at 7 on the timeline.
    panel.setScroll(panel.scrollX, lane.top + 10);
    const onRuler = { x: panel.xAt(7), y: RULER_HEIGHT / 2, shift: false, alt: false, mod: false };
    expect(panel.hitAt(onRuler)).toEqual({ kind: "empty" });
    const box = timeline.model?.boxes.get("c2");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    expect(keyframes.inTimeline.hitAt(onRuler)).toEqual({ kind: "empty" });
  });

  it("the ruler moves the playhead", async () => {
    const { addClip, panel, timeline } = await setup();
    addClip("a", 0, 10);
    const pointer = { x: panel.xAt(2), y: RULER_HEIGHT / 2, shift: false, alt: false, mod: false };
    panel.press(pointer);
    panel.release(pointer);
    expect(timeline.frame).toBe(60);
  });

  it("lists the keys on screen, in their places, up to a limit", async () => {
    const { addClip, keys, keyframes, panel, open } = await setup();
    addClip("a", 0, 8);
    keys("a", X, 1, 2, 3);
    open("a", "position");
    const found = panel.visibleKeys(100);
    const inRow = found.filter(({ lane }) => lane.id === laneOf("a", X));
    expect(inRow.map(({ seconds }) => seconds)).toEqual([1, 2, 3]);
    expect(inRow[0]?.x).toBeCloseTo(panel.xAt(1));
    expect(panel.visibleKeys(2)).toHaveLength(2);
    keyframes.select(KeySelection.of([{ clip: "a", path: X, time: "2" }]));
    expect(panel.visibleKeys(100).filter(({ selected }) => selected).length).toBeGreaterThan(0);
  });
});

describe("what is tried on keys", () => {
  it("only keys that are not saved count as tried", async () => {
    const { addClip, keys, open, writer, keyframes, panel } = await setup();
    addClip("a", 0, 8);
    keys("a", X, 1, 2);
    open("a", "position");
    writer.commit([
      { owner: { clip: "a" }, path: X, op: "moveKey", moves: [{ from: "2", to: "3" }] },
    ]);
    const tried = (time: string): KeyRef => ({ clip: "a", path: X, time });
    expect(keyframes.isTriedKey(tried("3"))).toBe(true);
    expect(keyframes.isTriedKey(tried("1"))).toBe(false);
    const row = panel.visibleKeys(100).filter(({ lane }) => lane.id === laneOf("a", X));
    expect(row.map((key) => key.tried)).toEqual([false, true]);
  });

  it("is what people see while comparing: nothing is", async () => {
    const { addClip, keys, open, writer, keyframes, trials } = await setup();
    addClip("a", 0, 8);
    keys("a", X, 1, 2);
    open("a", "position");
    writer.commit([{ owner: { clip: "a" }, path: X, op: "setKey", time: "3", value: 3 }]);
    expect(keyframes.isTried("a", X)).toBe(true);
    trials.toggleCompare();
    expect(keyframes.isTried("a", X)).toBe(false);
  });
});

describe("keys on the timeline", () => {
  async function opened() {
    const setting = await setup();
    const { addClip, keys, keyframes, timeline } = setting;
    addClip("a", 1, 8);
    keys("a", X, 2, 3);
    const box = timeline.model?.boxes.get("a");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    const { inTimeline } = keyframes;
    const lane = (id: string) => {
      const found = inTimeline.lanes.find((one) => one.id === id);
      if (!found) throw new Error(`no lane ${id}`);
      return found;
    };
    const at = (seconds: number, id: string, extra: Partial<Pointer> = {}): Pointer => ({
      x: timeline.xAt(seconds),
      y: inTimeline.screenY(lane(id).top) + LANE_HEIGHT / 2,
      shift: false,
      alt: false,
      mod: false,
      ...extra,
    });
    return { ...setting, box, lane, at, inTimeline };
  }

  it("a clip has what it can animate, and something without any has nothing to open", async () => {
    const { keyframes, timeline, store, video } = await opened();
    const audio = orderedTracks(store.getState().timelines["main"] as never).find(
      ({ kind }) => kind === "audio",
    )?.id;
    store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: audio,
        clip: {
          id: "s",
          start: "0",
          duration: "1",
          source: { kind: "audio", media: { asset: "a" } },
        },
      },
    });
    const sound = timeline.model?.boxes.get("s");
    if (!sound) throw new Error("no clip");
    expect(keyframes.inTimeline.canOpen(sound)).toBe(false);
    expect(video).toBeDefined();
  });

  it("makes room under the track, and what comes after moves down", async () => {
    const { timeline, video, box, keyframes, inTimeline } = await opened();
    const rows = timeline.model?.rows ?? [];
    const row = rows.find(({ id }) => id === video);
    const last = inTimeline.lanes.at(-1) as Lane;
    expect(row?.below).toBe(last.top + last.height - (row?.top ?? 0) - (row?.height ?? 0));
    expect(rows[rows.indexOf(row as never) + 1]?.top).toBe(
      (row?.top ?? 0) + (row?.height ?? 0) + (row?.below ?? 0),
    );
    expect(timeline.model?.height).toBe((rows.at(-1)?.top ?? 0) + (rows.at(-1)?.height ?? 0));
    keyframes.inTimeline.toggle(box);
    expect(timeline.model?.rows.find(({ id }) => id === video)?.below).toBe(0);
    expect(inTimeline.lanes).toEqual([]);
  });

  it("the same rows as the tab, on the time of the timeline", async () => {
    const { keyframes, lane, at, timeline, shownTimes, trials } = await opened();
    keyframes.toggleOpen("a/group:position");
    // The clip starts at 1, so its key at 3 is at 4 on the timeline.
    const from = at(4, laneOf("a", X));
    expect(lane(laneOf("a", X)).depth).toBeGreaterThan(0);
    timeline.press(from);
    timeline.drag(at(4.5, laneOf("a", X)));
    timeline.drag(at(5, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
    timeline.release(at(5, laneOf("a", X)));
    expect(shownTimes("a", X)).toEqual(["2", "4"]);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
  });

  it("selecting a clip after a key lets go of the key", async () => {
    const { keyframes, at, timeline, selected, video } = await opened();
    keyframes.toggleOpen("a/group:position");
    const key = at(3, laneOf("a", X));
    timeline.press(key);
    timeline.release(key);
    expect(selected()).toHaveLength(1);
    const row = timeline.model?.rows.find(({ id }) => id === video);
    const onClip = { ...key, y: RULER_HEIGHT - timeline.scrollY + (row?.top ?? 0) + 30 };
    timeline.press(onClip);
    timeline.release(onClip);
    expect(selected()).toEqual([]);
    expect([...timeline.getSnapshot().selection]).toEqual(["a"]);
  });

  it("a drag there does not touch clips, and Escape takes it back", async () => {
    const { keyframes, at, timeline, shownTimes, main } = await opened();
    keyframes.toggleOpen("a/group:position");
    const before = main().clips["a"];
    timeline.press(at(3, laneOf("a", X)));
    timeline.drag(at(5, laneOf("a", X)));
    expect(timeline.cancelDrag()).toBe(true);
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
    expect(main().clips["a"]).toBe(before);
  });

  async function closedWithButton() {
    const setting = await opened();
    const { timeline, video, box, inTimeline } = setting;
    inTimeline.toggle(box);
    const row = timeline.model?.rows.find(({ id }) => id === video);
    const pointer = {
      x: Math.max(timeline.xAt(box.start), 0) + 12,
      y: RULER_HEIGHT - timeline.scrollY + (row?.top ?? 0) + 12,
      shift: false,
      alt: false,
      mod: false,
    };
    return { ...setting, pointer };
  }

  it("the button on a clip only shows on what is selected or open", async () => {
    const { timeline, box, inTimeline, pointer } = await closedWithButton();
    expect(timeline.hitAt(pointer)).not.toHaveProperty("expander");
    timeline.selectOnly("a");
    expect(timeline.hitAt(pointer)).toMatchObject({ kind: "clip", expander: true });
    timeline.clearSelection();
    inTimeline.toggle(box);
    expect(timeline.hitAt(pointer)).toMatchObject({ kind: "clip", expander: true });
    timeline.setTool("razor");
    expect(timeline.hitAt(pointer)).not.toHaveProperty("expander");
  });

  it("a click on it opens and closes the clip, and what is selected stays", async () => {
    const { timeline, box, inTimeline, keyframes, pointer } = await closedWithButton();
    timeline.selectOnly("a");
    timeline.press(pointer);
    timeline.release(pointer);
    expect(inTimeline.isOpen(box)).toBe(true);
    timeline.press(pointer);
    timeline.release(pointer);
    expect(inTimeline.isOpen(box)).toBe(false);
    expect([...timeline.getSnapshot().selection]).toEqual(["a"]);
    expect(keyframes.selection.size).toBe(0);
  });

  it("a drag from it still moves the clip", async () => {
    const { timeline, box, inTimeline, pointer, main } = await closedWithButton();
    timeline.selectOnly("a");
    timeline.press(pointer);
    timeline.drag({ ...pointer, x: pointer.x + 40 });
    timeline.release({ ...pointer, x: pointer.x + 80 });
    expect(inTimeline.isOpen(box)).toBe(false);
    expect(main().clips["a"]?.start).not.toBe("1");
  });

  it("a gone clip takes its rows along", async () => {
    const { store, inTimeline, timeline, video } = await opened();
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a"] } });
    expect(inTimeline.lanes).toEqual([]);
    expect(timeline.model?.rows.find(({ id }) => id === video)?.below).toBe(0);
  });

  it("the same selection as the tab", async () => {
    const { keyframes, at, timeline } = await opened();
    keyframes.toggleOpen("a/group:position");
    const key = at(3, laneOf("a", X));
    timeline.press(key);
    timeline.release(key);
    expect(keyframes.selection.has({ clip: "a", path: X, time: "2" })).toBe(true);
  });
});

describe("what the keys of the timeline are about", () => {
  /** Keys on X at 2 and 3 of a clip that starts at 1 and is open on the timeline, and a clip after it. */
  async function onTimeline() {
    const setting = await setup();
    const { addClip, keys, keyframes, timeline, main } = setting;
    addClip("a", 1, 8);
    keys("a", X, 2, 3);
    addClip("b", 10, 4);
    keys("b", X, 1, 2);
    const box = timeline.model?.boxes.get("a");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    keyframes.toggleOpen("a/group:position");
    const { inTimeline } = keyframes;
    /** A key on the timeline, by where it is on the timeline. */
    const keyAt = (seconds: number, id: string): Pointer => {
      const lane = inTimeline.lanes.find((one) => one.id === id);
      if (!lane) throw new Error(`no lane ${id}`);
      const y = inTimeline.screenY(lane.top) + LANE_HEIGHT / 2;
      return { x: timeline.xAt(seconds), y, shift: false, alt: false, mod: false };
    };
    const clickOn = (pointer: Pointer) => {
      timeline.press(pointer);
      timeline.release(pointer);
    };
    const actions = new ActionRegistry();
    registerTimelineActions(actions, timeline, inTimeline);
    registerKeyframeActions(actions, keyframes, timeline);
    /** What a key does: nothing at all while what it does cannot be done. */
    const press = (id: string) => {
      const action = actions.get(id);
      if (!action) throw new Error(`no action ${id}`);
      if (action.enabled?.() !== false) action.run();
    };
    const clips = () => Object.keys(main().clips).toSorted();
    const selectedClips = () => [...timeline.getSnapshot().selection].toSorted();
    return { ...setting, box, keyAt, clickOn, press, clips, selectedClips };
  }

  it("while comparing, Delete is about the selected key, says why it cannot go, and leaves the clip", async () => {
    const setting = await onTimeline();
    const { writer, trials, keyframes, keyAt, clickOn, press, clips, shownTimes, comparing } =
      setting;
    writer.commit([{ owner: { clip: "a" }, path: Y, op: "set", value: 5 }]);
    trials.toggleCompare();
    clickOn(keyAt(3, laneOf("a", X)));
    expect(keyframes.selection.size).toBe(1);
    press("timeline.delete");
    expect(clips()).toEqual(["a", "b"]);
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
    expect(comparing).toHaveBeenCalledOnce();
  });

  it("on a locked track, Delete is about the selected key, and no clip goes, wherever it is", async () => {
    const setting = await onTimeline();
    const { store, main, timeline, keyframes, video, press, clips, shownTimes, locked } = setting;
    store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } });
    const other = orderedTracks(main()).find(({ id, kind }) => kind === "video" && id !== video)
      ?.id as string;
    const source = { kind: "color", color: "#445566" };
    store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: other,
        clip: { id: "l", start: "1", duration: "8", source },
      },
    });
    setting.keys("l", X, 2);
    timeline.updateTrack(other, { locked: true });
    const box = timeline.model?.boxes.get("l");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    keyframes.toggleOpen("l/group:position");
    // Another clip was selected before the key of the locked one.
    timeline.selectOnly("b");
    setting.clickOn(setting.keyAt(3, laneOf("l", X)));
    expect(keyframes.selection.size).toBe(1);
    press("timeline.delete");
    expect(clips()).toEqual(["a", "b", "l"]);
    expect(shownTimes("l", X)).toEqual(["2"]);
    expect(locked).toHaveBeenCalledOnce();
  });

  it("selected keys select their clip, and selecting clips lets go of the keys", async () => {
    const { timeline, keyframes, keyAt, clickOn, press, clips, selectedClips } = await onTimeline();
    timeline.selectOnly("b");
    clickOn(keyAt(3, laneOf("a", X)));
    expect(selectedClips()).toEqual(["a"]);
    // Everything on the timeline is about clips, so Delete then takes the clips.
    press("timeline.selectAll");
    expect(keyframes.selection.size).toBe(0);
    expect(selectedClips()).toEqual(["a", "b"]);
    press("timeline.delete");
    expect(clips()).toEqual([]);
  });

  it("the keys of the timeline are only about the keys it shows", async () => {
    const setting = await onTimeline();
    const { keyframes, open, at, click, press, shownTimes, clips, notShown } = setting;
    keyframes.setRange("all");
    open("a", "position");
    open("b", "position");
    // A key of b, which is closed on the timeline, selected in the tab.
    click(at(11, laneOf("b", X)));
    for (const key of ["timeline.delete", "timeline.cut", "timeline.copy"]) press(key);
    expect(notShown).toHaveBeenCalledTimes(3);
    expect(keyframes.getSnapshot().hasClipboard).toBe(false);
    expect(shownTimes("b", X)).toEqual(["1", "2"]);
    expect(clips()).toEqual(["a", "b"]);
    // With a key that shows there as well, only that one goes.
    click(at(3, laneOf("a", X), { mod: true }));
    press("timeline.delete");
    expect(shownTimes("a", X)).toEqual(["3"]);
    expect(shownTimes("b", X)).toEqual(["1", "2"]);
    // The tab shows both, so its keys are about both.
    click(at(4, laneOf("a", X)));
    click(at(11, laneOf("b", X), { mod: true }));
    press("keyframes.delete");
    expect(shownTimes("b", X)).toEqual(["2"]);
  });

  it("the clipboard holds what was copied or cut last", async () => {
    const { timeline, keyframes, keyAt, clickOn, press, main, shownTimes } = await onTimeline();
    clickOn(keyAt(3, laneOf("a", X)));
    press("timeline.copy");
    expect(keyframes.getSnapshot().hasClipboard).toBe(true);
    // Clips that are cut after that are what a paste is about.
    timeline.selectOnly("b");
    press("timeline.cut");
    expect(keyframes.getSnapshot().hasClipboard).toBe(false);
    timeline.seek(12 * 30);
    press("timeline.paste");
    expect(main().clips["b"]).toBeUndefined();
    expect(Object.values(main().clips).map(({ start }) => start)).toContain("12");
    expect(shownTimes("a", X)).toEqual(["2", "3"]);

    // Clips copied from their menu, and keys after that: the keys go in.
    timeline.selectOnly("a");
    timeline.copySelection();
    clickOn(keyAt(3, laneOf("a", X)));
    press("timeline.copy");
    expect(timeline.hasClipboard).toBe(false);
    timeline.seek(6 * 30);
    const before = Object.keys(main().clips).length;
    press("timeline.paste");
    expect(Object.keys(main().clips)).toHaveLength(before);
    expect(shownTimes("a", X)).toEqual(["2", "3", "5"]);

    // Keys copied while clips wait to be moved: those stay where they are.
    timeline.selectOnly("a");
    press("timeline.cut");
    expect(timeline.getSnapshot().cut.size).toBe(1);
    clickOn(keyAt(3, laneOf("a", X)));
    press("timeline.copy");
    expect(timeline.getSnapshot().cut.size).toBe(0);
  });

  it("cutting keys takes them away in one step, and pastes them at the playhead", async () => {
    const { timeline, keyframes, keyAt, clickOn, press, clips, shownTimes, trials } =
      await onTimeline();
    clickOn(keyAt(3, laneOf("a", X)));
    press("timeline.cut");
    expect(shownTimes("a", X)).toEqual(["3"]);
    expect(clips()).toEqual(["a", "b"]);
    expect(keyframes.getSnapshot().hasClipboard).toBe(true);
    timeline.seek(6 * 30);
    press("timeline.paste");
    expect(shownTimes("a", X)).toEqual(["3", "5"]);
    trials.undo();
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
  });

  it("pasting while comparing says that nothing can change", async () => {
    const setting = await onTimeline();
    const { writer, trials, keyAt, clickOn, press, shownTimes, comparing, pasteNowhere } = setting;
    clickOn(keyAt(3, laneOf("a", X)));
    press("timeline.copy");
    writer.commit([{ owner: { clip: "a" }, path: Y, op: "set", value: 5 }]);
    trials.toggleCompare();
    setting.timeline.seek(6 * 30);
    press("timeline.paste");
    expect(comparing).toHaveBeenCalledOnce();
    expect(pasteNowhere).not.toHaveBeenCalled();
    trials.toggleCompare();
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
  });

  it("the Delete of the tab says why the selected keys cannot go", async () => {
    const setting = await onTimeline();
    const { writer, trials, keyAt, clickOn, press, shownTimes, comparing } = setting;
    clickOn(keyAt(3, laneOf("a", X)));
    writer.commit([{ owner: { clip: "a" }, path: Y, op: "set", value: 5 }]);
    trials.toggleCompare();
    press("keyframes.delete");
    expect(comparing).toHaveBeenCalledOnce();
    expect(shownTimes("a", X)).toEqual(["2", "3"]);
  });
});

describe("fingers", () => {
  const environment = {
    later: () => () => {},
    nextFrame: () => () => {},
    now: () => 0,
    openMenu: vi.fn(),
    held: vi.fn(),
  };

  async function keyed() {
    const setting = await setup();
    setting.addClip("a", 0, 8);
    setting.keys("a", X, 1, 2);
    setting.open("a", "position");
    return setting;
  }

  it("go by what they land on", async () => {
    const { panel, at, click } = await keyed();
    const key = at(1, laneOf("a", X));
    expect(panel.touchAt({ ...key, y: RULER_HEIGHT / 2 })).toBe("grab");
    expect(panel.touchAt(key)).toBe("plain");
    click(key);
    expect(panel.touchAt(key)).toBe("selected");
    expect(panel.touchAt(at(5, laneOf("a", X)))).toBe("plain");
  });

  it("a selected key goes along with a finger, in one step", async () => {
    const { panel, at, click, shownTimes, trials } = await keyed();
    click(at(1, laneOf("a", X)));
    const touch = new TouchController(panel, environment);
    const from = at(1, laneOf("a", X));
    const to = at(1.5, laneOf("a", X));
    touch.down(1, from.x, from.y);
    touch.move(1, to.x, to.y);
    touch.up(1);
    expect(shownTimes("a", X)).toEqual(["1.5", "2"]);
    trials.undo();
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
  });

  it("anywhere else a finger moves the view, and a key stays where it is", async () => {
    const { panel, at, shownTimes } = await keyed();
    panel.zoomAround(0, 4);
    panel.setScroll(100, 0);
    const touch = new TouchController(panel, environment);
    const from = at(2, laneOf("a", X));
    touch.down(1, from.x, from.y);
    touch.move(1, from.x + 50, from.y);
    touch.up(1);
    expect(panel.scrollX).toBe(50);
    expect(shownTimes("a", X)).toEqual(["1", "2"]);
  });

  it("a long press selects the key", async () => {
    const { panel, at, selected } = await keyed();
    panel.hold(at(1, laneOf("a", X)));
    expect(selected()).toEqual(["a transform.x 1"]);
  });

  it("reach further than a mouse", async () => {
    const { panel, at } = await keyed();
    const beside = { ...at(1, laneOf("a", X)) };
    beside.x += 11;
    expect(panel.hitAt(beside).kind).toBe("lane");
    panel.setTouchInput(true);
    expect(panel.hitAt(beside).kind).toBe("key");
  });

  it("the same goes for the rows of the timeline", async () => {
    const { timeline, keyframes, addClip, keys } = await setup();
    addClip("b", 0, 8);
    keys("b", X, 2);
    const box = timeline.model?.boxes.get("b");
    if (!box) throw new Error("no clip");
    const { inTimeline } = keyframes;
    inTimeline.toggle(box);
    keyframes.toggleOpen("b/group:position");
    const lane = inTimeline.lanes.find(({ id }) => id === laneOf("b", X));
    if (!lane) throw new Error("no lane");
    const key = {
      x: timeline.xAt(2) + 11,
      y: inTimeline.screenY(lane.top) + LANE_HEIGHT / 2,
      shift: false,
      alt: false,
      mod: false,
    };
    expect(inTimeline.hitAt(key).kind).toBe("lane");
    timeline.setTouchInput(true);
    expect(inTimeline.hitAt(key).kind).toBe("key");
    expect(timeline.touchAt(key)).toBe("plain");
    timeline.hold(key);
    expect(timeline.touchAt(key)).toBe("selected");
    expect(keyframes.selection.size).toBe(1);
  });

  it("a second finger is a hand resting on the screen while a key under a clip goes along", async () => {
    const { timeline, keyframes, addClip, keys, shownTimes } = await setup();
    addClip("b", 0, 8);
    keys("b", X, 2, 4);
    const box = timeline.model?.boxes.get("b");
    if (!box) throw new Error("no clip");
    keyframes.inTimeline.toggle(box);
    keyframes.toggleOpen("b/group:position");
    const lane = keyframes.inTimeline.lanes.find(({ id }) => id === laneOf("b", X));
    if (!lane) throw new Error("no lane");
    const y = keyframes.inTimeline.screenY(lane.top) + LANE_HEIGHT / 2;
    const x = timeline.xAt(2);
    timeline.setTouchInput(true);
    const touch = new TouchController(timeline, environment);
    touch.down(1, x, y);
    touch.up(1);
    expect(keyframes.selection.size).toBe(1);
    touch.down(1, x, y);
    touch.move(1, x + 20, y);
    touch.move(1, x + 40, y);
    expect(keyframes.preview).toBeDefined();
    touch.down(2, x + 300, y + 100);
    touch.move(1, timeline.xAt(3), y);
    touch.up(2);
    touch.up(1);
    expect(shownTimes("b", X)).toEqual(["3", "4"]);
  });

  it("with a finger, the start of a selected clip trims, and its button is past that", async () => {
    const { timeline, keyframes, addClip, keys, video } = await setup();
    addClip("b", 1, 8);
    keys("b", X, 2);
    timeline.selectOnly("b");
    timeline.setTouchInput(true);
    const box = timeline.model?.boxes.get("b");
    const row = timeline.model?.rows.find(({ id }) => id === video);
    if (!box || !row) throw new Error("no clip");
    const left = timeline.xAt(box.start);
    const y = RULER_HEIGHT - timeline.scrollY + row.top + 10;
    const edge = { x: left + 10, y, shift: false, alt: false, mod: false };
    expect(timeline.hitAt(edge)).toMatchObject({ kind: "clip", edge: "start" });
    const button = timeline.expanderAt(left, timeline.xAt(box.end) - left);
    if (button === undefined) throw new Error("no button");
    expect(timeline.hitAt({ ...edge, x: button + 4 })).toMatchObject({ expander: true });
    expect(keyframes.inTimeline.canOpen(box)).toBe(true);
  });
});

describe("spelling", () => {
  it("moves times that are not decimals", async () => {
    const { addClip, keys, open, at, drag, shownTimes, panel } = await setup();
    addClip("a", 0, 8);
    keys("a", X, "1/3");
    open("a", "position");
    drag(at(1 / 3, laneOf("a", X)), { ...at(1 / 3, laneOf("a", X)), x: panel.xAt(1) });
    expect(shownTimes("a", X)).toEqual(["1"]);
    expect(formatTime(parseTime("2/6"))).toBe("1/3");
  });
});
