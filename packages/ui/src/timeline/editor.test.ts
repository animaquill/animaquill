import { ProjectStore, clipEnd, effectsOf, orderedTracks, type ClipState } from "@animaquill/core";
import { formatTime, parseTime, toSeconds } from "@animaquill/schema";
import type { SettingsStore } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { ActionRegistry } from "../workbench/actions.ts";
import { registerTimelineActions } from "./actions.ts";
import { FLASH_MS, RULER_HEIGHT, TimelineEditor, type TransitionChoice } from "./editor.ts";
import { frameAt } from "./frames.ts";
import { builtInPick, greysOut, type TransitionPick } from "./transition-place.ts";
import type { Pointer } from "./gestures.ts";
import { sceneTemplate } from "./scene-template.ts";

const WIDTH = 1000;
const HEIGHT = 400;

async function setup(memory = memoryWindow(), { sized = true } = {}) {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("时间轴");
  const store = session.store;
  if (!store) throw new Error("no project");
  const commandFailed = vi.fn<(message: string) => void>();
  const saved = new Map<string, unknown>();
  let fromOtherWindow: (value: unknown) => void = () => {};
  const settings: SettingsStore = {
    load: async (key) => saved.get(key),
    save: async (key, value) => void saved.set(key, value),
    listen: (_, listener) => {
      fromOtherWindow = listener;
      return () => {};
    },
  };
  const joinsRemoved = vi.fn<(count: number) => void>();
  const editor = new TimelineEditor(session, memory, settings, { commandFailed, joinsRemoved });
  await editor.load();
  if (sized) editor.setViewport(WIDTH, HEIGHT);

  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const video = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const audio = orderedTracks(main()).find(({ kind }) => kind === "audio")?.id as string;

  const addClip = (
    id: string,
    start: number | string,
    duration: number | string,
    track = video,
    extra = {},
  ) => {
    const source =
      track === audio
        ? { kind: "audio", media: { asset: "a" } }
        : { kind: "color", color: "#112233" };
    const result = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        clip: { id, start: String(start), duration: String(duration), source, ...extra },
      },
    });
    if (!result.ok) throw new Error(result.error.message);
  };

  const rowY = (track: string) => {
    const row = editor.model?.rows.find(({ id }) => id === track);
    if (!row) throw new Error("no row");
    return RULER_HEIGHT - editor.scrollY + row.top + row.height / 2;
  };
  const at = (seconds: number, track = video, keys: Partial<Pointer> = {}): Pointer => ({
    x: editor.xAt(seconds),
    y: rowY(track),
    shift: false,
    alt: false,
    mod: false,
    ...keys,
  });
  const onRuler = (seconds: number, keys: Partial<Pointer> = {}): Pointer => ({
    ...at(seconds),
    y: RULER_HEIGHT / 2,
    ...keys,
  });
  /** A real drag, with the steps the mouse would report. */
  const drag = (from: Pointer, to: Pointer) => {
    editor.press(from);
    editor.drag({ ...from, x: from.x + (to.x - from.x) / 2, y: from.y + (to.y - from.y) / 2 });
    editor.drag(to);
    editor.release(to);
  };
  const clip = (id: string) => main().clips[id] as ClipState;
  const selection = () => [...editor.getSnapshot().selection].toSorted();

  return {
    session,
    store,
    editor,
    video,
    audio,
    commandFailed,
    joinsRemoved,
    memory,
    saved,
    settings,
    saveInOtherWindow: (value: unknown) => fromOtherWindow(value),
    main,
    addClip,
    at,
    onRuler,
    drag,
    clip,
    selection,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the view", () => {
  it("starts with the whole timeline in view", async () => {
    const { editor } = await setup();
    expect(editor.xAt(10)).toBeGreaterThan(WIDTH * 0.9);
    expect(editor.xAt(10)).toBeLessThanOrEqual(WIDTH);
    expect(editor.scrollX).toBe(0);
  });

  it("zooms around the point under the mouse", async () => {
    const { editor } = await setup();
    const moment = editor.timeAt(600);
    editor.zoomAround(600, 4);
    expect(editor.timeAt(600)).toBeCloseTo(moment, 6);
    expect(editor.pixelsPerSecond).toBeGreaterThan(300);
  });

  it("stops zooming in at a wide frame, and out at the whole timeline", async () => {
    const { editor } = await setup();
    editor.zoomAround(0, 1e9);
    expect(editor.pixelsPerSecond).toBe(30 * 240);
    editor.zoomAround(0, 1e-9);
    expect(editor.pixelsPerSecond * 10).toBeCloseTo(WIDTH * 0.8, 6);
  });

  it("does not scroll past the start or the content", async () => {
    const { editor } = await setup();
    editor.zoomAround(0, 4);
    editor.setScroll(-100, -100);
    expect(editor.scrollX).toBe(0);
    expect(editor.scrollY).toBe(0);
    editor.setScroll(1e9, 1e9);
    expect(editor.scrollX).toBe(editor.contentWidth - WIDTH);
    expect(editor.scrollY).toBe(editor.contentHeight - HEIGHT);
  });

  it("leaves room after the end to put things", async () => {
    const { editor } = await setup();
    expect(editor.contentWidth).toBeGreaterThan(12 * editor.pixelsPerSecond);
  });

  it("fits again on request, and goes back when asked again", async () => {
    const { editor } = await setup();
    editor.zoomAround(500, 8);
    editor.setScroll(300, 0);
    const zoom = editor.pixelsPerSecond;
    editor.zoomToFit();
    expect(editor.xAt(10)).toBeLessThanOrEqual(WIDTH);
    expect(editor.scrollX).toBe(0);
    editor.zoomToFit();
    expect(editor.pixelsPerSecond).toBe(zoom);
    expect(editor.scrollX).toBe(300);
    editor.zoomToFit();
    expect(editor.scrollX).toBe(0);
  });

  it("does not go back to an old view after people moved on from the whole timeline", async () => {
    const { editor } = await setup();
    editor.zoomAround(500, 8);
    editor.zoomToFit();
    editor.zoomAround(500, 2);
    const zoom = editor.pixelsPerSecond;
    editor.zoomToFit();
    editor.zoomToFit();
    expect(editor.pixelsPerSecond).toBe(zoom);
  });

  it("stays put when everything already shows", async () => {
    const { editor } = await setup();
    const zoom = editor.pixelsPerSecond;
    editor.zoomToFit();
    editor.zoomToFit();
    expect(editor.pixelsPerSecond).toBe(zoom);
  });

  it("gives a slider level from 0 to 1 and takes it back", async () => {
    const { editor } = await setup();
    editor.setZoomLevel(1);
    expect(editor.zoomLevel).toBeCloseTo(1, 6);
    editor.setZoomLevel(0);
    expect(editor.zoomLevel).toBeCloseTo(0, 6);
    editor.setZoomLevel(0.5);
    expect(editor.zoomLevel).toBeCloseTo(0.5, 6);
  });

  it("waits with zooming until it has a size, and then shows everything", async () => {
    const { editor } = await setup(undefined, { sized: false });
    editor.zoomIn();
    editor.zoomOut();
    editor.zoomToFit();
    editor.zoomAround(0, 2);
    expect(editor.pixelsPerSecond).toBe(0);
    expect(editor.zoomLevel).toBe(0);
    editor.setViewport(WIDTH, HEIGHT);
    expect(editor.scrollX).toBe(0);
    expect(editor.xAt(10)).toBeGreaterThan(WIDTH * 0.9);
  });

  it("gives a valid zoom level for a timeline of a single frame", async () => {
    const { editor, store, main } = await setup();
    const [section] = Object.keys(main().sections);
    store.execute({
      type: "section.update",
      params: { timeline: "main", section, duration: "1/30" },
    });
    editor.zoomToFit();
    expect(Number.isFinite(editor.zoomLevel)).toBe(true);
  });

  it("copes with a timeline shown before it has a size", async () => {
    const { editor } = await setup();
    editor.setViewport(0, 0);
    editor.setViewport(WIDTH, HEIGHT);
    expect(Number.isFinite(editor.xAt(10))).toBe(true);
  });
});

describe("the playhead", () => {
  it("jumps to where the ruler is pressed, on a frame", async () => {
    const { editor, onRuler } = await setup();
    editor.press(onRuler(2.01));
    editor.release(onRuler(2.01));
    expect(editor.frame).toBe(60);
  });

  it("follows the mouse through every frame, without sticking to clips", async () => {
    const { editor, onRuler, addClip } = await setup();
    addClip("a", 2, 2);
    editor.press(onRuler(1));
    editor.drag(onRuler(2.02));
    expect(editor.frame).toBe(61);
    editor.release(onRuler(2.02));
  });

  it("sticks to clips with Shift held", async () => {
    const { editor, onRuler, addClip } = await setup();
    addClip("a", 2, 2);
    editor.press(onRuler(1));
    editor.drag(onRuler(2.02, { shift: true }));
    expect(editor.frame).toBe(60);
    editor.release(onRuler(2.02, { shift: true }));
  });

  it("goes back to where it was on Escape", async () => {
    const { editor, onRuler } = await setup();
    editor.seek(30);
    editor.press(onRuler(5));
    expect(editor.cancelDrag()).toBe(true);
    expect(editor.frame).toBe(30);
  });

  it("stays on the timeline", async () => {
    const { editor } = await setup();
    editor.seek(-5);
    expect(editor.frame).toBe(0);
    editor.seek(1e6);
    expect(editor.frame).toBe(300);
  });

  it("comes along when the timeline gets shorter", async () => {
    const { editor, store, main } = await setup();
    editor.seekToEnd();
    const [section] = Object.keys(main().sections);
    store.execute({ type: "section.update", params: { timeline: "main", section, duration: "4" } });
    expect(editor.frame).toBe(120);
  });

  it("steps by frames, and keeps itself in view", async () => {
    const { editor } = await setup();
    editor.zoomAround(0, 30);
    editor.seek(0);
    for (let step = 0; step < 200; step++) editor.stepFrames(1);
    expect(editor.frame).toBe(200);
    const x = editor.xAt(200 / 30);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(WIDTH);
  });

  it("goes to both ends", async () => {
    const { editor } = await setup();
    editor.seekToEnd();
    expect(editor.frame).toBe(300);
    editor.seekToStart();
    expect(editor.frame).toBe(0);
  });

  it("jumps from edit to edit", async () => {
    const { editor, addClip } = await setup();
    addClip("a", 2, 1);
    addClip("b", 4, 1);
    const stops = [];
    for (let jump = 0; jump < 6; jump++) {
      editor.jumpToEdit(1);
      stops.push(editor.frame);
    }
    expect(stops).toEqual([60, 90, 120, 150, 300, 300]);
    editor.jumpToEdit(-1);
    expect(editor.frame).toBe(150);
  });
});

describe("selecting", () => {
  it("selects a clip by clicking it", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 2);
    editor.press(at(2));
    editor.release(at(2));
    expect(selection()).toEqual(["a"]);
  });

  it("adds and removes with Shift or Ctrl", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 2);
    addClip("b", 4, 2);
    const click = (pointer: Pointer) => {
      editor.press(pointer);
      editor.release(pointer);
    };
    click(at(2));
    click(at(5, undefined, { shift: true }));
    expect(selection()).toEqual(["a", "b"]);
    click(at(2, undefined, { mod: true }));
    expect(selection()).toEqual(["b"]);
  });

  it("clears the selection when clicking next to a clip", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 2);
    editor.press(at(2));
    editor.release(at(2));
    editor.press(at(8));
    editor.release(at(8));
    expect(selection()).toEqual([]);
  });

  it("keeps a group for dragging, and picks one clip of it on a plain click", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 2);
    addClip("b", 4, 2);
    editor.selectAll();
    editor.press(at(2));
    expect(selection()).toEqual(["a", "b"]);
    editor.release(at(2));
    expect(selection()).toEqual(["a"]);
  });

  it("selects with a box, across tracks", async () => {
    const { addClip, at, drag, selection, audio } = await setup();
    addClip("a", 1, 2);
    addClip("b", 4, 2);
    addClip("c", 1, 2, audio);
    addClip("d", 8, 1);
    drag(at(0.5), at(5, audio));
    expect(selection()).toEqual(["a", "b", "c"]);
  });

  it("adds to the selection with a box and Shift", async () => {
    const { editor, addClip, at, drag, selection } = await setup();
    addClip("a", 1, 1);
    addClip("b", 4, 1);
    editor.press(at(1.5));
    editor.release(at(1.5));
    drag(at(3, undefined, { shift: true }), at(6, undefined, { shift: true }));
    expect(selection()).toEqual(["a", "b"]);
  });

  it("starts a box below the last track too", async () => {
    const { editor, addClip, at, drag, selection, audio } = await setup();
    addClip("a", 1, 2);
    const below = { ...at(0.5, audio), y: HEIGHT - 10 };
    expect(editor.hitAt(below).kind).toBe("empty");
    drag(below, at(1.5));
    expect(selection()).toEqual(["a"]);
  });

  it("shows the box while it is being drawn, and not after", async () => {
    const { editor, at } = await setup();
    editor.press(at(1));
    editor.drag(at(3));
    expect(editor.preview?.marquee).toBeDefined();
    editor.release(at(3));
    expect(editor.preview).toBeUndefined();
  });

  it("puts the selection back on Escape, also after a plain box", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 1);
    addClip("b", 4, 1);
    editor.press(at(1.5));
    editor.release(at(1.5));
    editor.press(at(3));
    editor.drag(at(6));
    expect(selection()).toEqual(["b"]);
    editor.cancelDrag();
    expect(selection()).toEqual(["a"]);
  });

  it("does not bring a clip back into the selection that went away during the box", async () => {
    const { editor, addClip, at, store, selection } = await setup();
    addClip("a", 1, 1);
    addClip("b", 4, 1);
    editor.press(at(4.5));
    editor.release(at(4.5));
    const shift = { shift: true };
    editor.press(at(3, undefined, shift));
    editor.drag(at(3.5, undefined, shift));
    expect(selection()).toEqual(["b"]);
    store.undo();
    editor.drag(at(3.6, undefined, shift));
    expect(selection()).toEqual([]);
    editor.release(at(3.6, undefined, shift));
    editor.deleteSelection();
    expect(editor.model?.boxes.size).toBe(1);
  });

  it("puts the selection back on Escape", async () => {
    const { editor, addClip, at, selection } = await setup();
    addClip("a", 1, 1);
    addClip("b", 4, 1);
    editor.press(at(1.5));
    editor.release(at(1.5));
    editor.press(at(3, undefined, { shift: true }));
    editor.drag(at(6, undefined, { shift: true }));
    expect(selection()).toEqual(["a", "b"]);
    editor.cancelDrag();
    expect(selection()).toEqual(["a"]);
  });

  it("forgets a clip that is gone", async () => {
    const { editor, addClip, store, selection } = await setup();
    addClip("a", 1, 1);
    editor.selectAll();
    store.undo();
    expect(selection()).toEqual([]);
  });

  it("selects everything, and nothing", async () => {
    const { editor, addClip, selection } = await setup();
    addClip("a", 1, 1);
    addClip("b", 3, 1);
    editor.selectAll();
    expect(selection()).toEqual(["a", "b"]);
    editor.clearSelection();
    expect(selection()).toEqual([]);
  });
});

describe("moving", () => {
  it("does not move on a click", async () => {
    const { editor, addClip, at, clip, store } = await setup();
    addClip("a", 2, 2);
    const revision = store.revision;
    editor.press(at(3));
    editor.release(at(3));
    expect(clip("a").start).toBe("2");
    expect(store.revision).toBe(revision);
  });

  it("does not move when the hand shakes a little", async () => {
    const { editor, addClip, at, clip } = await setup();
    addClip("a", 2, 2);
    const press = at(3);
    editor.press(press);
    editor.drag({ ...press, x: press.x + 2 });
    editor.release({ ...press, x: press.x + 2 });
    expect(clip("a").start).toBe("2");
  });

  it("does not touch the project until the drag ends", async () => {
    const { editor, addClip, at, clip, store } = await setup();
    addClip("a", 2, 2);
    const revision = store.revision;
    editor.press(at(3));
    editor.drag(at(6));
    expect(clip("a").start).toBe("2");
    expect(store.revision).toBe(revision);
    expect(editor.preview?.clips?.get("a")?.start).toBeCloseTo(5, 1);
    editor.release(at(6));
    expect(store.revision).toBe(revision + 1);
  });

  it("lands on a frame", async () => {
    const { addClip, at, clip, drag, editor } = await setup();
    editor.toggleSnapping();
    addClip("a", 2, 2);
    drag(at(3), at(5.51));
    expect(clip("a").start).toBe("4.5");
  });

  it("keeps the point it was grabbed at under the mouse", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 2, 2);
    drag(at(3.5), at(6.5));
    expect(clip("a").start).toBe("5");
  });

  it("stays exact where a frame has no finite decimal", async () => {
    const { addClip, at, clip, drag, editor } = await setup();
    editor.toggleSnapping();
    addClip("a", 0, 2);
    drag(at(1), at(2.034));
    expect(clip("a").start).toBe("31/30");
  });

  it("is one step to undo", async () => {
    const { addClip, at, clip, drag, store } = await setup();
    addClip("a", 2, 2);
    drag(at(3), at(6));
    store.undo();
    expect(clip("a").start).toBe("2");
    store.redo();
    expect(clip("a").start).toBe("5");
  });

  it("writes nothing when the clip ends up where it was", async () => {
    const { addClip, at, drag, store } = await setup();
    addClip("a", 2, 2);
    const revision = store.revision;
    drag(at(3), at(3.001));
    expect(store.revision).toBe(revision);
  });

  it("stops at the start of the timeline", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 2, 2);
    const from = at(3);
    drag(from, { ...from, x: from.x - 5000 });
    expect(clip("a").start).toBe("0");
  });

  it("stops a group when its first clip gets to the start", async () => {
    const { editor, addClip, at, clip, drag } = await setup();
    addClip("a", 1, 1);
    addClip("b", 4, 1);
    editor.selectAll();
    const from = at(4.5);
    drag(from, { ...from, x: from.x - 5000 });
    expect(clip("a").start).toBe("0");
    expect(clip("b").start).toBe("3");
  });

  it("leaves everything as it was on Escape", async () => {
    const { editor, addClip, at, clip, store } = await setup();
    addClip("a", 2, 2);
    const revision = store.revision;
    editor.press(at(3));
    editor.drag(at(6));
    expect(editor.cancelDrag()).toBe(true);
    expect(editor.preview).toBeUndefined();
    editor.release(at(6));
    expect(clip("a").start).toBe("2");
    expect(store.revision).toBe(revision);
  });

  it("forgets a drag when the panel goes behind another tab", async () => {
    const { editor, addClip, at, clip } = await setup();
    addClip("a", 2, 2);
    editor.press(at(3));
    editor.drag(at(6));
    editor.setViewport(0, 0);
    expect(editor.isDragging).toBe(false);
    expect(editor.preview).toBeUndefined();
    editor.setViewport(WIDTH, HEIGHT);
    editor.release(at(9));
    expect(clip("a").start).toBe("2");
  });

  it("does not finish an old drag with a new press", async () => {
    const { editor, addClip, at, clip } = await setup();
    addClip("a", 2, 2);
    editor.press(at(3));
    editor.drag(at(6));
    editor.press(at(8));
    expect(editor.preview).toBeUndefined();
    editor.release(at(8));
    expect(clip("a").start).toBe("2");
  });

  it("gives up when the clip goes away during the drag", async () => {
    const { editor, addClip, at, store, commandFailed } = await setup();
    addClip("a", 2, 2);
    editor.press(at(3));
    editor.drag(at(6));
    store.undo();
    expect(editor.preview).toBeUndefined();
    expect(editor.isDragging).toBe(false);
    editor.release(at(6));
    expect(commandFailed).not.toHaveBeenCalled();
  });

  describe("snapping", () => {
    it("sticks the start to the end of another clip, exactly", async () => {
      const { addClip, at, clip, drag } = await setup();
      addClip("a", 1, "1001/300");
      addClip("b", 6, 1);
      const end = 1 + 1001 / 300;
      const from = at(6.5);
      drag(from, { ...from, x: at(end + 0.5).x + 3 });
      expect(clip("b").start).toBe(formatTime(clipEnd(clip("a"))));
    });

    it("sticks the end too", async () => {
      const { addClip, at, clip, drag } = await setup();
      addClip("a", 6, 1);
      addClip("b", 1, 2);
      const from = at(1.5);
      drag(from, { ...from, x: at(4.5).x + 4 });
      expect(clip("b").start).toBe("4");
    });

    it("sticks to the playhead and the ends of the timeline", async () => {
      const { editor, addClip, at, clip, drag } = await setup();
      addClip("a", 1, 2);
      editor.seek(150);
      const from = at(1.5);
      drag(from, { ...from, x: at(5.5).x + 3 });
      expect(clip("a").start).toBe("5");
      const again = at(5.5);
      drag(again, { ...again, x: at(8.5).x + 3 });
      expect(clip("a").start).toBe("8");
    });

    it("shows a line where it snapped", async () => {
      const { editor, addClip, at } = await setup();
      addClip("a", 1, 2);
      addClip("b", 6, 1);
      editor.press(at(6.5));
      editor.drag(at(3.51));
      expect(editor.preview?.snap).toBe(3);
      editor.release(at(3.51));
    });

    it("shows the line at the end of the clip when that is what snapped", async () => {
      const { editor, addClip, at } = await setup();
      addClip("a", 6, 1);
      addClip("b", 1, 2);
      editor.press(at(1.5));
      editor.drag(at(4.51));
      expect(editor.preview?.snap).toBe(6);
      editor.release(at(4.51));
    });

    it("lets go with Alt held", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      addClip("a", 1, 2);
      addClip("b", 6, 1);
      const from = at(6.5);
      const to = { ...at(3.55), alt: true };
      drag(from, to);
      expect(clip("b").start).not.toBe("3");
      expect(editor.preview).toBeUndefined();
    });

    it("can be turned off", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      editor.toggleSnapping();
      addClip("a", 1, 2);
      addClip("b", 6, 1);
      drag(at(6.5), at(3.55));
      expect(clip("b").start).not.toBe("3");
    });

    it("reaches further when zoomed out, and the same on the screen", async () => {
      const { editor, addClip, at, clip, drag } = await setup();
      addClip("a", 1, 2);
      addClip("b", 6, 1);
      editor.zoomAround(0, 8);
      const from = at(6.5);
      drag(from, { ...from, x: at(3.5).x + 20 });
      expect(clip("b").start).not.toBe("3");
    });
  });

  describe("across tracks", () => {
    const withSecondTrack = async () => {
      const context = await setup();
      context.store.execute({
        type: "track.add",
        params: { timeline: "main", id: "upper", kind: "video" },
      });
      return context;
    };

    it("moves to another track of its kind", async () => {
      const { addClip, at, clip, drag } = await withSecondTrack();
      addClip("a", 2, 2);
      drag(at(3), at(3, "upper"));
      expect(clip("a").track).toBe("upper");
      expect(clip("a").start).toBe("2");
    });

    it("does not go to a track of another kind", async () => {
      const { addClip, at, clip, drag, audio, video } = await setup();
      addClip("a", 2, 2);
      drag(at(3), at(6, audio));
      expect(clip("a").track).toBe(video);
      expect(clip("a").start).toBe("5");
    });

    it("does not go to a locked track, and still moves along its own", async () => {
      const { addClip, at, clip, drag, editor, video, commandFailed } = await withSecondTrack();
      addClip("a", 2, 2);
      editor.updateTrack("upper", { locked: true });
      drag(at(3), at(6, "upper"));
      expect(clip("a").track).toBe(video);
      expect(clip("a").start).toBe("5");
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("leaves selected clips of a locked track behind", async () => {
      const { editor, addClip, at, clip, drag, commandFailed } = await withSecondTrack();
      addClip("a", 1, 1);
      addClip("b", 1, 1, "upper");
      editor.selectAll();
      editor.updateTrack("upper", { locked: true });
      drag(at(1.5), at(3.5));
      expect(clip("a").start).toBe("3");
      expect(clip("b").start).toBe("1");
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("moves clips of several tracks together, keeping the distance between them", async () => {
      const { editor, addClip, at, clip, drag, video } = await withSecondTrack();
      addClip("a", 1, 1);
      addClip("b", 3, 1, "upper");
      editor.selectAll();
      drag(at(1.5), at(2.5));
      expect(clip("a").start).toBe("2");
      expect(clip("b").start).toBe("4");
      expect(clip("a").track).toBe(video);
      expect(clip("b").track).toBe("upper");
    });

    it("does not let a group fall off the last track", async () => {
      const { editor, addClip, at, clip, drag, video } = await withSecondTrack();
      addClip("a", 1, 1);
      addClip("b", 3, 1, "upper");
      editor.selectAll();
      drag(at(1.5), at(1.5, "upper"));
      expect(clip("a").track).toBe(video);
      expect(clip("b").track).toBe("upper");
    });

    it("moves a picture and a sound together, each on its own kind of track", async () => {
      const { editor, addClip, at, clip, drag, audio } = await withSecondTrack();
      addClip("a", 1, 1);
      addClip("s", 1, 1, audio);
      editor.selectAll();
      drag(at(1.5), at(2.5, "upper"));
      expect(clip("a").track).toBe("upper");
      expect(clip("s").track).toBe(audio);
      expect(clip("s").start).toBe("2");
    });
  });

  describe("onto other clips, with overwriting on", () => {
    it("shows what would be overwritten", async () => {
      const { editor, addClip, at } = await setup();
      editor.toggleOverwriting();
      addClip("a", 0, 5);
      addClip("b", 7, 2);
      editor.press(at(8));
      editor.drag(at(5));
      const covered = editor.preview?.covered ?? [];
      expect(covered).toHaveLength(1);
      expect(covered[0]?.from).toBeCloseTo(4, 1);
      expect(covered[0]?.to).toBeCloseTo(5, 1);
      editor.release(at(5));
    });

    it("overwrites when dropped, in one step", async () => {
      const { addClip, at, clip, drag, store, editor } = await setup();
      editor.toggleOverwriting();
      addClip("a", 0, 5);
      addClip("b", 7, 2);
      drag(at(8), at(5));
      expect(clip("a").duration).toBe("4");
      store.undo();
      expect(clip("a").duration).toBe("5");
      expect(clip("b").start).toBe("7");
    });

    it("does not count the clips that move along", async () => {
      const { editor, addClip, at, clip, drag } = await setup();
      editor.toggleOverwriting();
      addClip("a", 1, 2);
      addClip("b", 3, 2);
      editor.selectAll();
      editor.press(at(2));
      editor.drag(at(2.5));
      expect(editor.preview?.covered).toEqual([]);
      editor.release(at(2.5));
      drag(at(3), at(3));
      expect(clip("a").duration).toBe("2");
      expect(clip("b").duration).toBe("2");
    });
  });

  describe("onto other clips, as it is by default", () => {
    it("leaves them alone and goes to the nearest free place, touching exactly", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      editor.toggleSnapping();
      addClip("a", 0, "1001/300");
      addClip("b", 7, 1);
      drag(at(7.5), at(2));
      expect(clip("a").duration).toBe("1001/300");
      expect(clip("b").start).toBe("1001/300");
    });

    it("goes to the other side when that is closer", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      editor.toggleSnapping();
      addClip("a", 3, 2);
      addClip("b", 7, 1);
      drag(at(7.5), at(3.2));
      expect(clip("b").start).toBe("2");
      expect(clip("a").start).toBe("3");
    });

    it("does not go in front of the start of the timeline", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      editor.toggleSnapping();
      addClip("a", 0, 5);
      addClip("b", 7, 3);
      drag(at(8.5), at(1.7));
      expect(clip("b").start).toBe("5");
    });

    it("jumps over a gap that is too small", async () => {
      const { addClip, at, clip, drag, editor } = await setup();
      editor.toggleSnapping();
      addClip("a", 0, 2);
      addClip("c", 3, 2);
      addClip("b", 8, 2);
      drag(at(9), at(2.5));
      expect(clip("b").start).toBe("5");
      expect(clip("c").start).toBe("3");
    });

    it("finds a place for a whole group", async () => {
      const { editor, addClip, at, clip, drag, audio } = await setup();
      editor.toggleSnapping();
      addClip("a", 6, 1);
      addClip("s", 8, 1, audio);
      addClip("blocker", 1, 2, audio);
      editor.selectOnly("a");
      editor.press(at(8.5, audio, { shift: true }));
      editor.release(at(8.5, audio, { shift: true }));
      expect([...editor.getSnapshot().selection].toSorted()).toEqual(["a", "s"]);
      drag(at(6.5), at(1.5));
      // The sound would land on the blocker, so the whole group stops behind it.
      expect(clip("s").start).toBe("3");
      expect(clip("a").start).toBe("1");
    });

    it("shows where it would land, and marks nothing as covered", async () => {
      const { editor, addClip, at } = await setup();
      editor.toggleSnapping();
      addClip("a", 0, 5);
      addClip("b", 7, 1);
      editor.press(at(7.5));
      editor.drag(at(4.5));
      expect(editor.preview?.clips?.get("b")?.start).toBe(5);
      expect(editor.preview?.covered).toEqual([]);
      expect(editor.preview?.snap).toBe(5);
      editor.release(at(4.5));
    });

    it("works on another track too", async () => {
      const { addClip, at, clip, drag, editor, store } = await setup();
      editor.toggleSnapping();
      store.execute({
        type: "track.add",
        params: { timeline: "main", id: "upper", kind: "video" },
      });
      addClip("a", 0, 5, "upper");
      addClip("b", 7, 1);
      drag(at(7.5), at(4.5, "upper"));
      expect(clip("b").track).toBe("upper");
      expect(clip("b").start).toBe("5");
    });
  });

  describe("back to where it came from", () => {
    it("sticks there, and that takes the move back", async () => {
      const { editor, addClip, at, store, clip } = await setup();
      addClip("a", 2, 2);
      const revision = store.revision;
      const from = at(3);
      editor.press(from);
      editor.drag(at(6));
      const back = { ...from, x: from.x + 6 };
      editor.drag(back);
      expect(editor.preview?.snap).toBe(2);
      editor.release(back);
      expect(store.revision).toBe(revision);
      expect(clip("a").start).toBe("2");
      expect(store.canUndo).toBe(true);
    });

    it("works for an edge as well", async () => {
      const { editor, addClip, at, store } = await setup();
      addClip("a", 2.01, 2);
      const revision = store.revision;
      const press = { ...at(4.01), x: at(4.01).x - 1 };
      editor.press(press);
      editor.drag({ ...press, x: press.x - 60 });
      editor.drag({ ...press, x: press.x + 5 });
      editor.release({ ...press, x: press.x + 5 });
      expect(store.revision).toBe(revision);
    });

    it("needs snapping", async () => {
      const { editor, addClip, at, clip, drag } = await setup();
      editor.toggleSnapping();
      addClip("a", 2, 2);
      const from = at(3);
      drag(from, { ...from, x: from.x + 6 });
      expect(clip("a").start).not.toBe("2");
    });
  });

  describe("with Ctrl held", () => {
    const ctrl = { mod: true };

    it("leaves the clip where it is and makes a copy, which gets selected", async () => {
      const { addClip, at, clip, drag, main, selection, store } = await setup();
      addClip("a", 1, 2, undefined, { name: "原来的" });
      drag(at(2, undefined, ctrl), at(6, undefined, ctrl));
      expect(clip("a").start).toBe("1");
      const copy = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(copy?.start).toBe("5");
      expect(copy?.name).toBe("原来的");
      expect(selection()).toEqual([copy?.id]);
      store.undo();
      expect(Object.keys(main().clips)).toEqual(["a"]);
    });

    it("shows the copy, and the clip stays bright", async () => {
      const { editor, addClip, at } = await setup();
      addClip("a", 1, 2);
      editor.press(at(2, undefined, ctrl));
      editor.drag(at(6, undefined, ctrl));
      expect(editor.preview?.copying).toBe(true);
      editor.cancelDrag();
    });

    it("does not land on the clip it came from", async () => {
      const { addClip, at, drag, main } = await setup();
      addClip("a", 1, 2);
      drag(at(2, undefined, ctrl), at(2.3, undefined, ctrl));
      const copy = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(copy?.start).toBe("3");
    });

    it("copies a group, and copies that were linked stay linked to each other", async () => {
      const { editor, addClip, at, drag, main, audio } = await setup();
      addClip("a", 1, 1, undefined, { link: "pair" });
      addClip("b", 1, 1, audio, { link: "pair" });
      editor.selectAll();
      drag(at(1.5, undefined, ctrl), at(5.5, undefined, ctrl));
      const copies = Object.values(main().clips).filter(({ id }) => !["a", "b"].includes(id));
      expect(copies).toHaveLength(2);
      expect(copies[0]?.link).toBe(copies[1]?.link);
      expect(copies[0]?.link).not.toBe("pair");
    });

    it("still adds to the selection on a click, and takes away from it", async () => {
      const { editor, addClip, at, selection } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      const click = (pointer: Pointer) => {
        editor.press(pointer);
        editor.release(pointer);
      };
      click(at(1.5));
      click(at(3.5, undefined, ctrl));
      expect(selection()).toEqual(["a", "b"]);
      click(at(1.5, undefined, ctrl));
      expect(selection()).toEqual(["b"]);
    });
  });

  it("makes the timeline longer when dropped past the end", async () => {
    const { addClip, at, clip, drag, editor, main } = await setup();
    addClip("a", 8, 2);
    const from = at(9);
    drag(from, { ...from, x: at(14).x });
    expect(clip("a").start).toBe("13");
    expect(Object.values(main().sections)[0]?.duration).toBe("15");
    expect(editor.model?.duration).toBe(15);
  });

  it("stays where it is when something is dropped past the end", async () => {
    const { editor, addClip, at } = await setup();
    addClip("a", 8, 2);
    editor.zoomAround(0, 4);
    editor.setScroll(1e9, 0);
    const from = at(9);
    editor.press({ ...from, x: 10 });
    const far = { ...from, x: WIDTH - 10 };
    editor.drag(far);
    for (let step = 0; step < 30; step++) editor.scrollDuringDrag(far, 100, 0);
    const scrolled = editor.scrollX;
    editor.release(far);
    expect(editor.scrollX).toBe(scrolled);
  });

  it("leaves room to scroll while something is dragged past the end", async () => {
    const { editor, addClip, at } = await setup();
    addClip("a", 8, 2);
    const before = editor.contentWidth;
    const from = at(9);
    editor.press(from);
    editor.drag({ ...from, x: at(30).x });
    expect(editor.contentWidth).toBeGreaterThan(before);
    editor.release({ ...from, x: at(30).x });
  });

  it("keeps a drag going while the view scrolls", async () => {
    const { editor, addClip, at, clip } = await setup();
    addClip("a", 1, 1);
    editor.zoomAround(0, 2);
    const press = at(1.5);
    editor.press(press);
    const edge = { ...press, x: WIDTH - 1 };
    editor.drag(edge);
    const before = editor.preview?.clips?.get("a")?.start as number;
    editor.scrollDuringDrag(edge, 100, 0);
    expect(editor.preview?.clips?.get("a")?.start).toBeGreaterThan(before);
    editor.release(edge);
    expect(Number(clip("a").start)).toBeCloseTo(editor.timeAt(WIDTH - 1) - 0.5, 1);
  });

  it("scrolls through the rows for a clip, and not for the playhead", async () => {
    const { editor, addClip, at, onRuler, store } = await setup();
    for (let index = 0; index < 12; index++) {
      store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } });
    }
    addClip("a", 1, 1);
    editor.setScroll(0, 100);
    const press = onRuler(1);
    editor.press(press);
    editor.scrollDuringDrag(press, 0, -50);
    expect(editor.scrollY).toBe(100);
    editor.release(press);
    const grab = at(1.5);
    editor.press(grab);
    editor.drag({ ...grab, y: grab.y - 20 });
    editor.scrollDuringDrag({ ...grab, y: grab.y - 20 }, 0, -50);
    expect(editor.scrollY).toBe(50);
    editor.cancelDrag();
  });

  it("does not move a clip on a locked track", async () => {
    const { editor, addClip, at, clip, drag, video, selection } = await setup();
    addClip("a", 2, 2);
    editor.updateTrack(video, { locked: true });
    drag(at(3), at(6));
    expect(clip("a").start).toBe("2");
    expect(selection()).toEqual([]);
  });

  it("says so when another window changed something it cannot work with", async () => {
    const { editor, addClip, at, store, commandFailed } = await setup();
    addClip("a", 2, 2);
    editor.press(at(3));
    editor.drag(at(6));
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
    editor.release(at(6));
    expect(commandFailed).toHaveBeenCalledOnce();
  });
});

describe("transitions at the edges of clips", () => {
  /** Near the top of a track, where the blocks of transitions and their handles are. */
  const near = (editor: TimelineEditor, pointer: Pointer, track: string, by = 0): Pointer => {
    const row = editor.model?.rows.find(({ id }) => id === track);
    if (!row) throw new Error("no row");
    return { ...pointer, x: pointer.x + by, y: RULER_HEIGHT - editor.scrollY + row.top + 4 };
  };
  const seconds = (time: string | undefined) =>
    time === undefined ? 0 : toSeconds(parseTime(time));
  const exactly = (length: number) => parseTime(String(length));
  const fade = (duration: string) => ({ type: "fade", duration });
  const clicker = (editor: TimelineEditor) => (pointer: Pointer) => {
    editor.press(pointer);
    editor.release(pointer);
  };

  it("have handles at the top corners where each ends, and the edges keep the rest", async () => {
    const { editor, addClip, at, video } = await setup();
    addClip("a", 2, 4, video, { exit: fade("1") });
    addClip("b", 7, 2, video, { enter: fade("0.5") });
    const handleAt = (pointer: Pointer) => {
      const found = editor.hitAt(pointer);
      return found.kind === "clip" ? found.handle : "none";
    };
    // Only an edge with a transition has one: they come from the transitions tab.
    expect(handleAt(near(editor, at(2), video, 2))).toBeUndefined();
    expect(handleAt(near(editor, at(7.5), video))).toBe("enter");
    expect(handleAt(near(editor, at(5), video))).toBe("exit");
    expect(handleAt(near(editor, at(6), video, -2))).toBeUndefined();
    expect(handleAt(at(2))).toBeUndefined();
    expect(editor.hover(near(editor, at(7.5), video))).toBe("col-resize");
    const lower = editor.hitAt({ ...at(2), x: at(2).x + 2 });
    expect(lower.kind === "clip" && lower.edge).toBe("start");
    const block = editor.hitAt(near(editor, at(5.5), video));
    expect(block.kind === "clip" && block.transition).toBe("exit");
  });

  it("change how long they are by their handle, by frames, in one step of undo, and select it", async () => {
    const { editor, store, addClip, at, clip, drag, selection, video } = await setup();
    addClip("a", 2, 4, video, { enter: fade("0.5"), exit: fade("0.5") });
    const from = near(editor, at(2.5), video);
    editor.press(from);
    editor.drag(near(editor, at(2.8), video));
    editor.drag(near(editor, at(3), video));
    expect(editor.preview?.transition).toEqual({ clip: "a", edge: "enter", seconds: 1 });
    expect(clip("a").enter).toEqual(fade("0.5"));
    editor.release(near(editor, at(3), video));
    expect(editor.preview).toBeUndefined();
    expect(clip("a").enter).toEqual(fade("1"));
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "enter" });
    expect(selection()).toEqual([]);
    drag(near(editor, at(5.5), video), near(editor, at(4.5), video));
    expect(seconds(clip("a").exit?.duration)).toBe(1.5);
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "exit" });
    store.undo();
    expect(clip("a").exit).toEqual(fade("0.5"));
    expect(seconds(clip("a").enter?.duration)).toBe(1);
    store.undo();
    expect(clip("a").enter).toEqual(fade("0.5"));
  });

  it("keep how they go when their handle is dragged", async () => {
    const { editor, addClip, at, clip, drag, video } = await setup();
    const curve = [0.42, 0, 0.58, 1];
    addClip("a", 2, 4, video, { enter: { ...fade("1"), curve } });
    drag(near(editor, at(3), video), near(editor, at(3.5), video));
    expect(clip("a").enter).toEqual({ ...fade("1.5"), curve });
  });

  it("stop at the other one, and back at the edge there is none", async () => {
    const { editor, addClip, at, clip, drag, video } = await setup();
    addClip("a", 2, 4, video, { enter: fade("0.5"), exit: fade("3") });
    drag(near(editor, at(2.5), video), near(editor, at(5.5), video));
    expect(seconds(clip("a").enter?.duration)).toBe(1);
    drag(near(editor, at(3), video), near(editor, at(1), video));
    expect(clip("a").enter).toBeUndefined();
    expect(clip("a").exit).toEqual(fade("3"));
  });

  it("are not offered on a locked track, nor on sound, which has none yet", async () => {
    const { editor, addClip, at, clip, video, audio, commandFailed } = await setup();
    addClip("a", 2, 4);
    addClip("s", 2, 4, audio);
    const top = near(editor, at(2), audio, 2);
    const onSound = editor.hitAt(top);
    expect(onSound.kind === "clip" && onSound.handle).toBeUndefined();
    expect(editor.setTransitionLength("s", "enter", exactly(1))).toBe(false);
    expect(commandFailed).toHaveBeenCalledWith("这一版的编辑器还不能播放声音的入转场");
    expect(clip("s").enter).toBeUndefined();
    editor.updateTrack(video, { locked: true });
    const locked = editor.hitAt(near(editor, at(2), video, 2));
    expect(locked.kind === "clip" && locked.handle).toBeUndefined();
    expect(editor.setTransitionLength("a", "enter", exactly(1))).toBe(false);
    expect(clip("a").enter).toBeUndefined();
  });

  it("can be said in numbers, as far as the other one lets them go", async () => {
    const { editor, store, addClip, clip } = await setup();
    addClip("a", 2, 4, undefined, { enter: fade("1") });
    expect(editor.setTransitionLength("a", "exit", exactly(9))).toBe(true);
    expect(clip("a").exit).toEqual(fade("3"));
    // The same again changes nothing, and leaves nothing to undo.
    expect(editor.setTransitionLength("a", "exit", exactly(3))).toBe(false);
    expect(editor.setTransitionLength("a", "enter", exactly(0))).toBe(true);
    expect(clip("a").enter).toBeUndefined();
    store.undo();
    expect(clip("a").enter).toEqual(fade("1"));
  });

  it("are selected with a click on their block, instead of clips, and Delete takes one away", async () => {
    const { editor, store, addClip, at, clip, selection, video } = await setup();
    const click = clicker(editor);
    addClip("a", 2, 4, video, { enter: fade("1"), exit: fade("1") });
    click(at(4));
    expect(selection()).toEqual(["a"]);
    click(near(editor, at(2.4), video));
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "enter" });
    expect(selection()).toEqual([]);
    expect(editor.canChangeSelection).toBe(true);
    editor.deleteSelection();
    expect(clip("a").enter).toBeUndefined();
    expect(clip("a").exit).toEqual(fade("1"));
    expect(clip("a")).toBeDefined();
    expect(editor.getSnapshot().transition).toBeUndefined();
    store.undo();
    expect(clip("a").enter).toEqual(fade("1"));
    click(near(editor, at(5.6), video));
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "exit" });
    click(at(4));
    expect(editor.getSnapshot().transition).toBeUndefined();
    expect(selection()).toEqual(["a"]);
  });

  it("move their clip when dragged by their block, and a copy of it with the key held", async () => {
    const { editor, addClip, at, clip, drag, main, video, selection } = await setup();
    addClip("a", 2, 4, video, { enter: fade("2") });
    const block = (time: number) => near(editor, at(time), video, 0);
    // Below the reach of the handles, in the band of the block.
    const inBlock = (time: number) => ({ ...block(time), y: block(time).y + 9 });
    expect(editor.hitAt(inBlock(3))).toMatchObject({ kind: "clip", transition: "enter" });
    editor.selectTransition("a", "enter");
    editor.press(inBlock(3));
    editor.drag({ ...inBlock(4), x: (inBlock(3).x + inBlock(5).x) / 2 });
    expect(editor.preview?.marquee).toBeUndefined();
    editor.drag(inBlock(5));
    editor.release(inBlock(5));
    expect(clip("a").start).toBe("4");
    expect(clip("a").enter).toEqual(fade("2"));
    expect(selection()).toEqual(["a"]);
    drag(inBlock(5), { ...inBlock(9), mod: true });
    expect(clip("a").start).toBe("4");
    const copies = Object.values(main().clips).filter(({ id }) => id !== "a");
    expect(copies.map(({ start, enter }) => [start, enter])).toEqual([["8", fade("2")]]);
  });

  it("are chosen with a click on their block without the clip coming in between", async () => {
    const { editor, addClip, at, video } = await setup();
    addClip("a", 2, 4, video, { enter: fade("2") });
    const point = near(editor, at(3), video, 0);
    const inBlock = { ...point, y: point.y + 9 };
    editor.selectTransition("a", "enter");
    const seen: (TransitionChoice | undefined)[] = [];
    const stop = editor.subscribe(() => seen.push(editor.getSnapshot().transition));
    editor.press(inBlock);
    editor.release(inBlock);
    stop();
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "enter" });
    expect(
      seen.every((choice) => choice !== undefined && "clip" in choice && choice.clip === "a"),
    ).toBe(true);
  });

  it("cannot be cut or copied: Delete takes one away, and copies go with clips", async () => {
    const { editor, addClip, video } = await setup();
    addClip("a", 2, 4, video, { enter: fade("1") });
    const actions = new ActionRegistry();
    const noKeys = {
      hasSelection: false,
      canChangeSelection: false,
      hasClipboard: false,
      nudge: () => {},
      deleteSelected: () => {},
      copySelected: () => {},
      cutSelected: () => {},
      paste: () => {},
    };
    registerTimelineActions(actions, editor, noKeys);
    const enabled = (id: string) => actions.get(`timeline.${id}`)?.enabled?.() !== false;
    editor.selectTransition("a", "enter");
    expect(editor.canChangeSelection).toBe(true);
    expect(editor.canCut).toBe(false);
    expect([enabled("cut"), enabled("copy"), enabled("delete")]).toEqual([false, false, true]);
    editor.selectOnly("a");
    expect(editor.canCut).toBe(true);
    expect([enabled("cut"), enabled("copy"), enabled("delete")]).toEqual([true, true, true]);
  });

  it("keep their handles for a finger once a pulled fade is what is selected", async () => {
    const { editor, addClip, at, video } = await setup();
    addClip("a", 2, 4, video, { enter: fade("1") });
    const handle = near(editor, at(3), video);
    editor.selectOnly("a");
    expect(editor.touchAt(handle)).toBe("grab");
    editor.selectTransition("a", "enter");
    expect(editor.touchAt(handle)).toBe("grab");
    // The middle of the clip is still for scrolling, as long as the clip itself is not selected.
    expect(editor.touchAt(at(4))).toBe("plain");
  });

  it("on a locked track can be looked at, not changed", async () => {
    const { editor, addClip, at, clip, video } = await setup();
    const click = clicker(editor);
    addClip("a", 2, 4, video, { enter: fade("1") });
    editor.updateTrack(video, { locked: true });
    click(near(editor, at(2.5), video));
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "enter" });
    expect(editor.canChangeSelection).toBe(false);
    editor.deleteSelection();
    expect(clip("a").enter).toEqual(fade("1"));
  });

  it("are no longer selected once their clip is gone", async () => {
    const { editor, store, addClip } = await setup();
    addClip("a", 2, 4, undefined, { enter: fade("1") });
    editor.selectTransition("a", "enter");
    expect(editor.getSnapshot().transition).toEqual({ clip: "a", edge: "enter" });
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a"] } });
    expect(editor.getSnapshot().transition).toBeUndefined();
    editor.selectTransition("a", "exit");
    expect(editor.getSnapshot().transition).toBeUndefined();
  });
});

describe("transitions from their tab", () => {
  const pick = (type: string) => builtInPick(type) as TransitionPick;
  const fade = pick("fade");
  const push = pick("push");

  /** a and b one after the other, c alone, and a sound under them. */
  async function clips() {
    const context = await setup();
    const { addClip, video, audio } = context;
    addClip("a", 2, 3, video);
    addClip("b", 5, 3, video);
    addClip("c", 10, 3, video);
    addClip("s", 2, 3, audio);
    return context;
  }

  it("go where they are dropped: the first third comes in, the last goes out, the middle takes none", async () => {
    const { editor, at, main, store, audio } = await clips();
    expect(editor.transitionDropAt(at(10.5), fade)).toMatchObject({ kind: "edge", edge: "enter" });
    expect(editor.transitionDropAt(at(11.5), fade)).toBeUndefined();
    expect(editor.transitionDropAt(at(12.5), fade)).toMatchObject({ kind: "edge", edge: "exit" });
    // Sound takes none yet, and what does not take it lights nothing up.
    expect(editor.showTransitionDrop(at(2.5, audio), fade)).toBe(false);
    expect(editor.preview).toBeUndefined();
    expect(editor.showTransitionDrop(at(11.5), fade)).toBe(false);
    expect(editor.preview).toBeUndefined();
    expect(editor.showTransitionDrop(at(10.5), fade)).toBe(true);
    // What it would take of the clip lights up: as long as it comes, from the start.
    expect(editor.preview?.transitionDrop).toMatchObject({ start: 10, end: 10.5 });
    expect(editor.dropTransition(at(10.5), push)).toBe(true);
    expect(editor.preview).toBeUndefined();
    expect(main().clips["c"]?.enter).toEqual({ type: "push", duration: "0.5" });
    expect(editor.getSnapshot().transition).toEqual({ clip: "c", edge: "enter" });
    expect(editor.dropTransition(at(12.8), fade)).toBe(true);
    expect(main().clips["c"]?.exit).toEqual({ type: "fade", duration: "0.5" });
    store.undo();
    expect(main().clips["c"]?.exit).toBeUndefined();
    expect(main().clips["c"]?.enter).toBeDefined();
  });

  it("take the place of one where they are dropped on it, as long as it is, going as they go", async () => {
    const { editor, at, main, store, video, addClip } = await setup();
    const curve = [0.42, 0, 1, 1];
    addClip("a", 2, 6, video, { enter: { type: "fade", duration: "2.5", curve } });
    // On the block, past the first third.
    expect(editor.transitionDropAt(at(4.2), push)).toMatchObject({
      edge: "enter",
      replacing: true,
    });
    expect(editor.dropTransition(at(4.2), push)).toBe(true);
    expect(main().clips["a"]?.enter).toEqual({ type: "push", duration: "2.5" });
    addClip("b", 8, 2, video);
    store.execute({
      type: "join.add",
      params: { timeline: "main", id: "j", from: "a", to: "b", type: "fade", duration: "1", curve },
    });
    expect(editor.transitionDropAt(at(8.3), push)).toMatchObject({
      kind: "join",
      join: { id: "j" },
    });
    expect(editor.dropTransition(at(8.3), push)).toBe(true);
    expect(main().joins?.["j"]?.transition).toEqual({ type: "push", duration: "1" });
    expect(editor.getSnapshot().transition).toEqual({ join: "j" });
  });

  it("do not go at an edge that a join has, nor where there is no room", async () => {
    const { editor, at, store, addClip, video } = await setup();
    addClip("a", 2, 3, video);
    addClip("b", 5, 3, video);
    addClip("c", 10, 3, video, { exit: { type: "fade", duration: "3" } });
    store.execute({
      type: "join.add",
      params: { timeline: "main", id: "j", from: "a", to: "b", type: "fade", duration: "0.2" },
    });
    // b comes in by the join, so another one at its start would do nothing.
    expect(editor.transitionDropAt(at(5.6), fade)).toBeUndefined();
    // Nor at the end of a, where the same join is.
    expect(editor.transitionDropAt(at(4.95), fade)).toMatchObject({
      kind: "join",
      join: { id: "j" },
    });
    expect(editor.transitionDropAt(at(4.4), fade)).toBeUndefined();
    // The fade at the end of c takes all of it: what is dropped at its start takes its place.
    expect(editor.transitionDropAt(at(10.2), fade)).toMatchObject({
      edge: "exit",
      replacing: true,
    });
  });

  it("go on a selected clip: one that comes in at its start, one that goes out at its end", async () => {
    const { editor, main, store } = await clips();
    editor.selectOnly("c");
    expect(editor.attachContext).toMatchObject({ kind: "clips", pairs: [] });
    expect(editor.attachProblem("enter", fade)).toBeUndefined();
    // One between two clips is never greyed out: a click says how it goes.
    expect(editor.attachProblem("join", fade)).toBe("joinHow");
    expect(greysOut(editor.attachProblem("join", fade))).toBe(false);
    expect(editor.attachTransition(fade, "join")).toBeUndefined();
    expect(editor.attachTransition(push, "enter")).toBeDefined();
    const pushed = { type: "push", duration: "0.5" };
    expect(main().clips["c"]?.enter).toEqual(pushed);
    expect(main().clips["c"]).not.toHaveProperty("exit");
    expect(editor.attachTransition(push, "exit")).toBeDefined();
    expect(main().clips["c"]?.exit).toEqual(pushed);
    // The clip stays selected, so another click puts another one in their place.
    expect([...editor.getSnapshot().selection]).toEqual(["c"]);
    expect(editor.attachTransition(fade, "exit")).toBeDefined();
    expect(main().clips["c"]?.exit).toEqual({ type: "fade", duration: "0.5" });
    store.undo();
    expect(main().clips["c"]?.exit).toEqual(pushed);
    store.undo();
    store.undo();
    expect(main().clips["c"]).not.toHaveProperty("enter");
    expect(main().clips["c"]).not.toHaveProperty("exit");
  });

  it("go on each of several clips, and between those that touch, in one step", async () => {
    const { editor, main, store } = await clips();
    editor.selectOnly("a");
    editor.addToSelection("b");
    editor.addToSelection("c");
    expect(editor.attachContext).toMatchObject({ kind: "clips" });
    expect(editor.attachTransition(fade, "enter")).toEqual({ edges: 3, joins: 0, replaced: false });
    expect(editor.flashOf("edges", "b:enter")).toBe(1);
    expect(editor.flashesOn("b")).toBe(true);
    for (const id of ["a", "b", "c"]) {
      expect(main().clips[id]?.enter).toEqual({ type: "fade", duration: "0.5" });
    }
    store.undo();
    expect(main().clips["b"]).not.toHaveProperty("enter");
    expect(editor.attachTransition(push, "join")).toMatchObject({ edges: 0, joins: 1 });
    const joins = Object.values(main().joins ?? {});
    expect(editor.flashOf("joins", Object.keys(main().joins ?? {})[0] ?? "")).toBe(1);
    expect(joins.map(({ from, to, transition }) => [from, to, transition])).toEqual([
      ["a", "b", { type: "push", duration: "0.5" }],
    ]);
    store.undo();
    expect(main()).not.toHaveProperty("joins");
  });

  it("take the place of a selected one, in its place, or say why they cannot", async () => {
    const { editor, main, addClip, video } = await setup();
    addClip("a", 2, 4, video, { enter: { type: "fade", duration: "1.5", curve: [0.42, 0, 1, 1] } });
    editor.selectTransition("a", "enter");
    expect(editor.attachProblem("exit", fade)).toBe("chosenEnter");
    expect(editor.attachProblem("join", fade)).toBe("joinHow");
    expect(editor.attachTransition(push, "enter")).toBeDefined();
    // In the place of another, it keeps the length and goes with its own defaults.
    expect(main().clips["a"]?.enter).toEqual({ type: "push", duration: "1.5" });
    // The same one again changes nothing.
    expect(editor.attachTransition(push, "enter")).toBeUndefined();
    editor.updateTrack(video, { locked: true });
    expect(editor.attachProblem("enter", fade)).toBe("locked");
    expect(editor.attachTransition(fade, "enter")).toBeUndefined();
  });

  it("say why they cannot go on what is selected", async () => {
    const { editor, video } = await clips();
    expect(editor.attachProblem("enter", fade)).toBe("nothing");
    expect(editor.attachProblem("join", fade)).toBe("joinHow");
    editor.selectOnly("s");
    expect(editor.attachProblem("enter", fade)).toBe("sound");
    editor.updateTrack(video, { locked: true });
    editor.selectOnly("a");
    expect(editor.attachProblem("enter", fade)).toBe("locked");
  });
});

describe("joins", () => {
  /** Near the top of a track, where the blocks of transitions are. */
  const top = (editor: TimelineEditor, pointer: Pointer, track: string, by = 0): Pointer => {
    const row = editor.model?.rows.find(({ id }) => id === track);
    if (!row) throw new Error("no row");
    return { ...pointer, x: pointer.x + by, y: RULER_HEIGHT - editor.scrollY + row.top + 4 };
  };

  /** Clips a and b one after the other, and c after a gap. */
  async function joined() {
    const context = await setup();
    const { addClip, video, editor, at } = context;
    addClip("a", 2, 3, video);
    addClip("b", 5, 3, video);
    addClip("c", 9, 1, video);
    const dissolve = builtInPick("fade") as TransitionPick;
    /** A dissolve dropped on the cut between a and b, as from the transitions tab. */
    const addJoin = () => editor.dropTransition(at(5), dissolve);
    return { ...context, addJoin };
  }

  it("go on the cut between two clips when dropped there, in one step, and get selected", async () => {
    const { editor, at, store, main, addJoin } = await joined();
    const dissolve = builtInPick("fade") as TransitionPick;
    // Where the two clips meet, and nowhere else.
    expect(editor.transitionDropAt(at(5), dissolve)).toMatchObject({
      kind: "join",
      from: { id: "a" },
      to: { id: "b" },
    });
    expect(editor.transitionDropAt(at(4.98), dissolve)).toMatchObject({ kind: "join" });
    expect(editor.transitionDropAt(at(3.5), dissolve)).toBeUndefined();
    expect(editor.transitionDropAt(at(8.5), dissolve)).toBeUndefined();
    expect(addJoin()).toBe(true);
    const [id] = Object.keys(main().joins ?? {});
    expect(main().joins?.[id as string]?.transition).toEqual({ type: "fade", duration: "0.5" });
    expect(editor.getSnapshot().transition).toEqual({ join: id });
    store.undo();
    expect(main()).not.toHaveProperty("joins");
    expect(editor.getSnapshot().transition).toBeUndefined();
  });

  it("are blocks across their cut: a click selects one, its edges change how long it is", async () => {
    const { editor, at, video, store, main } = await joined();
    store.execute({
      type: "join.add",
      params: { timeline: "main", id: "j", from: "a", to: "b", type: "fade", duration: "1" },
    });
    const hit = editor.hitAt(top(editor, at(5.2), video));
    expect(hit.kind === "join" && hit.join.id).toBe("j");
    expect(hit.kind === "join" && hit.edge).toBeUndefined();
    // Below the block the clips are as they were.
    expect(editor.hitAt(at(5.2)).kind).toBe("clip");
    editor.press(top(editor, at(5.2), video));
    editor.release(top(editor, at(5.2), video));
    expect(editor.getSnapshot().transition).toEqual({ join: "j" });
    const edge = editor.hitAt(top(editor, at(5.5), video));
    expect(edge.kind === "join" && edge.edge).toBe("end");
    expect(editor.hover(top(editor, at(5.5), video))).toBe("col-resize");
    // In the middle of its cut, both edges go: a second to the right is two seconds long.
    editor.press(top(editor, at(5.5), video));
    editor.drag(top(editor, at(5.8), video));
    editor.drag(top(editor, at(6), video));
    expect(editor.preview?.join).toEqual({ id: "j", start: 4, end: 6 });
    expect(main().joins?.["j"]?.transition?.duration).toBe("1");
    editor.release(top(editor, at(6), video));
    expect(main().joins?.["j"]?.transition?.duration).toBe("2");
    store.undo();
    expect(main().joins?.["j"]?.transition?.duration).toBe("1");
  });

  it("go no further than the clips on their sides leave room for, and go when made nothing", async () => {
    const { editor, at, video, main, addJoin } = await joined();
    addJoin();
    const id = Object.keys(main().joins ?? {})[0] as string;
    editor.press(top(editor, at(5.25), video));
    editor.drag(top(editor, at(7), video));
    editor.drag(top(editor, at(9.5), video));
    // Half of it after the cut, and three seconds of b: six seconds at most.
    expect(editor.preview?.join).toEqual({ id, start: 2, end: 8 });
    editor.release(top(editor, at(9.5), video));
    expect(main().joins?.[id]?.transition?.duration).toBe("6");
    editor.press(top(editor, at(8), video));
    editor.drag(top(editor, at(6), video));
    editor.drag(top(editor, at(4), video));
    editor.release(top(editor, at(4), video));
    expect(main()).not.toHaveProperty("joins");
  });

  it("are taken away with Delete, and changed to another one in one step", async () => {
    const { editor, main, store, addJoin } = await joined();
    addJoin();
    const id = Object.keys(main().joins ?? {})[0] as string;
    expect(editor.updateJoin(id, { type: "push", values: { direction: "up" } })).toBe(true);
    expect(main().joins?.[id]?.transition).toEqual({
      type: "push",
      values: { direction: "up" },
      duration: "0.5",
    });
    expect(editor.updateJoin(id, { type: "fade" })).toBe(true);
    expect(main().joins?.[id]?.transition).toEqual({ type: "fade", duration: "0.5" });
    expect(editor.canChangeSelection).toBe(true);
    editor.deleteSelection();
    expect(main()).not.toHaveProperty("joins");
    store.undo();
    expect(main().joins?.[id]).toBeDefined();
  });

  it("go when a clip of them moves away, which people hear about, and come back with undo", async () => {
    const { at, store, main, drag, joinsRemoved, addJoin } = await joined();
    addJoin();
    drag(at(6.5), at(7.5));
    expect(main().clips["b"]?.start).toBe("6");
    expect(main()).not.toHaveProperty("joins");
    expect(joinsRemoved).toHaveBeenCalledWith(1);
    store.undo();
    expect(Object.keys(main().joins ?? {})).toHaveLength(1);
    expect(main().clips["b"]?.start).toBe("5");
  });

  it("come along with copies of both of their clips, with ids of their own", async () => {
    const { editor, main, store, at, video } = await joined();
    store.execute({
      type: "join.add",
      params: {
        timeline: "main",
        id: "j",
        from: "a",
        to: "b",
        type: "wipe",
        values: { direction: "up" },
      },
    });
    editor.selectOnly("a");
    editor.addToSelection("b");
    editor.copySelection();
    // At the end of the timeline, which is where the playhead goes no further.
    editor.seekToEnd();
    editor.paste();
    const joins = Object.entries(main().joins ?? {});
    expect(joins).toHaveLength(2);
    const [, copy] = joins.find(([id]) => id !== "j") ?? [];
    expect(copy?.transition).toEqual({
      type: "wipe",
      values: { direction: "up" },
      duration: "0.5",
    });
    expect(copy?.from).not.toBe("a");
    expect(main().clips[copy?.from as string]?.start).toBe("10");
    expect(main().clips[copy?.to as string]?.start).toBe("13");
    store.undo();
    expect(Object.keys(main().joins ?? {})).toEqual(["j"]);
    // A copy of one of them goes without it.
    editor.selectOnly("b");
    editor.copySelection();
    editor.paste();
    expect(Object.keys(main().joins ?? {})).toEqual(["j"]);
    void at;
    void video;
  });

  it("are pasted as they were copied, also when their clips went away since", async () => {
    const { editor, main, store, addClip, video } = await setup();
    addClip("a", 2, 3, video);
    addClip("b", 5, 3, video);
    store.execute({
      type: "join.add",
      params: {
        timeline: "main",
        id: "j",
        from: "a",
        to: "b",
        type: "wipe",
        values: { direction: "up" },
      },
    });
    editor.selectOnly("a");
    editor.addToSelection("b");
    editor.copySelection();
    // Later changes are not what was copied, and nor is the join going with its clips.
    store.execute({
      type: "join.update",
      params: { timeline: "main", join: "j", changes: { type: "fade" } },
    });
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["a", "b"] } });
    expect(main()).not.toHaveProperty("joins");
    editor.seekToEnd();
    editor.paste();
    const pasted = Object.values(main().joins ?? {});
    expect(pasted).toHaveLength(1);
    expect(pasted[0]?.transition).toEqual({
      type: "wipe",
      values: { direction: "up" },
      duration: "0.5",
    });
    const [from, to] = [pasted[0]?.from as string, pasted[0]?.to as string];
    // At the end of the timeline, next to each other as they were.
    expect(main().clips[from]?.start).toBe("10");
    expect(main().clips[to]?.start).toBe("13");
  });

  it("are pasted shorter where their copies leave less room, and never stop the paste", async () => {
    const { editor, main, store, addClip, video, commandFailed } = await setup();
    addClip("z", 0, 2, video);
    // a comes in over 1.5 s, which does nothing while the join from z is at its start.
    addClip("a", 2, 2, video, { enter: { type: "fade", duration: "1.5" } });
    addClip("b", 4, 2, video);
    const run = (type: string, params: object) => {
      const result = store.execute({ type, params: { timeline: "main", ...params } });
      if (!result.ok) throw new Error(result.error.message);
    };
    run("join.add", {
      id: "j0",
      from: "z",
      to: "a",
      type: "fade",
      duration: "0.2",
      align: "after",
    });
    run("join.add", { id: "j1", from: "a", to: "b", type: "fade", duration: "2" });
    editor.selectOnly("a");
    editor.addToSelection("b");
    editor.copySelection();
    editor.seekToEnd();
    editor.paste();
    expect(commandFailed).not.toHaveBeenCalled();
    expect(Object.keys(main().clips)).toHaveLength(5);
    const copy = Object.entries(main().joins ?? {}).find(([id]) => id !== "j0" && id !== "j1");
    // Without the join at its start, the copy of a comes in over 1.5 s of its 2: half a second is
    // left for the half of the join before the cut, which stays in the middle of it.
    expect(copy?.[1].transition).toEqual({ type: "fade", duration: "1" });
  });

  it("leave the handles of the edges of their clips to themselves", async () => {
    const { editor, at, video, store } = await joined();
    store.execute({
      type: "join.add",
      params: { timeline: "main", id: "j", from: "a", to: "b", type: "fade", duration: "0.2" },
    });
    // At the cut, a press on the top changes the join, not what the clips have at their edges.
    const hit = editor.hitAt(top(editor, at(5), video, 1));
    expect(hit.kind).toBe("join");
    store.execute({
      type: "clip.setTransition",
      params: { timeline: "main", clip: "a", enter: { type: "fade", duration: "0.5" } },
    });
    const corner = editor.hitAt(top(editor, at(2.5), video));
    expect(corner.kind === "clip" && corner.handle).toBe("enter");
  });
});

describe("trimming", () => {
  const edge = (pointer: Pointer, by: number): Pointer => ({ ...pointer, x: pointer.x + by });

  it("grabs the edges of a clip, and the middle stays for moving", async () => {
    const { editor, addClip, at } = await setup();
    addClip("a", 2, 4);
    const hit = (pointer: Pointer) => {
      const found = editor.hitAt(pointer);
      return found.kind === "clip" ? found.edge : "none";
    };
    expect(hit(edge(at(2), 2))).toBe("start");
    expect(hit(edge(at(6), -2))).toBe("end");
    expect(hit(at(4))).toBeUndefined();
    expect(editor.hover(edge(at(2), 2))).toBe("ew-resize");
    expect(editor.hover(at(4))).toBe("default");
  });

  it("keeps a way to move a clip that is short on screen", async () => {
    const { editor, addClip, at } = await setup();
    addClip("a", 2, 0.1);
    const found = editor.hitAt(at(2.05));
    expect(found.kind === "clip" && found.edge).toBeUndefined();
  });

  it("does not offer the edges of a locked clip", async () => {
    const { editor, addClip, at, video } = await setup();
    addClip("a", 2, 4);
    editor.updateTrack(video, { locked: true });
    const found = editor.hitAt(edge(at(2), 2));
    expect(found.kind === "clip" && found.edge).toBeUndefined();
  });

  it("moves the end", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 2, 4);
    drag(edge(at(6), -1), at(5));
    expect(clip("a").duration).toBe("3");
  });

  it("moves the start, and the content stays in place", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 2, 4);
    drag(edge(at(2), 1), at(3));
    expect(clip("a").start).toBe("3");
    expect(clip("a").duration).toBe("3");
    expect(clip("a").offset).toBe("1");
  });

  it("selects the clip it trims", async () => {
    const { addClip, at, drag, selection } = await setup();
    addClip("a", 2, 4);
    drag(edge(at(6), -1), at(5));
    expect(selection()).toEqual(["a"]);
  });

  it("shows the change without touching the project", async () => {
    const { editor, addClip, at, store } = await setup();
    addClip("a", 2, 4);
    const revision = store.revision;
    editor.press(edge(at(6), -1));
    editor.drag(at(5));
    expect(store.revision).toBe(revision);
    expect(editor.preview?.clips?.get("a")?.end).toBeCloseTo(5, 1);
    editor.release(at(5));
  });

  it("does not go below one frame", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 2, 4);
    drag(edge(at(6), -1), at(1));
    expect(clip("a").duration).toBe("1/30");
    addClip("b", 7, 2);
    drag(edge(at(7), 1), at(9.5));
    expect(clip("b").duration).toBe("1/30");
    expect(clip("b").start).toBe("269/30");
  });

  it("stops at the neighbours, touching them exactly", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 1, "1001/300");
    addClip("b", 5, 2);
    addClip("c", 8, 1);
    drag(edge(at(7), -1), at(9));
    expect(clip("b").duration).toBe("3");
    const left = edge(at(5), 1);
    drag(left, { ...left, x: 0 });
    expect(clip("b").start).toBe(formatTime(clipEnd(clip("a"))));
  });

  it("sticks to the playhead", async () => {
    const { editor, addClip, at, clip, drag } = await setup();
    addClip("a", 1, 2);
    editor.seek(150);
    drag(edge(at(3), -1), edge(at(5), 3));
    expect(clip("a").duration).toBe("4");
  });

  it("changes nothing on a click, even next to something it could snap to", async () => {
    const { editor, addClip, at, clip, store } = await setup();
    addClip("a", 1, 2);
    addClip("b", 3.05, 2);
    addClip("c", "6.0123", 1);
    const revision = store.revision;
    for (const pointer of [edge(at(3.05), 2), edge(at(6.0123), 2), edge(at(3), -2)]) {
      editor.press(pointer);
      editor.release(pointer);
    }
    expect(store.revision).toBe(revision);
    expect(clip("b").start).toBe("3.05");
    expect(clip("c").start).toBe("6.0123");
  });

  it("gets a clip longer past the end, and the timeline with it", async () => {
    const { addClip, at, clip, drag, editor } = await setup();
    addClip("a", 8, 2);
    const from = edge(at(10), -1);
    drag(from, { ...from, x: at(13).x });
    expect(clip("a").duration).toBe("5");
    expect(editor.model?.duration).toBe(13);
  });

  it("brings back what was trimmed, up to the beginning of the content", async () => {
    const { addClip, at, clip, drag, audio } = await setup();
    addClip("a", 4, 2, audio, { offset: "1" });
    const left = edge(at(4, audio), 1);
    drag(left, { ...left, x: 0 });
    expect(clip("a").start).toBe("3");
    expect(clip("a").duration).toBe("3");
    expect(clip("a").offset).toBeUndefined();
  });

  it("lets a colour grow forward as far as it likes", async () => {
    const { addClip, at, clip, drag } = await setup();
    addClip("a", 4, 2);
    const left = edge(at(4), 1);
    drag(left, { ...left, x: 0 });
    expect(clip("a").start).toBe("0");
    expect(clip("a").duration).toBe("6");
  });

  it("is one step to undo, and Escape leaves no trace", async () => {
    const { editor, addClip, at, clip, drag, store } = await setup();
    addClip("a", 2, 4);
    drag(edge(at(2), 1), at(3));
    store.undo();
    expect(clip("a").start).toBe("2");
    editor.press(edge(at(2), 1));
    editor.drag(at(3));
    editor.cancelDrag();
    expect(clip("a").start).toBe("2");
    expect(editor.preview).toBeUndefined();
  });

  it("writes nothing when the edge stays where it was", async () => {
    const { addClip, at, drag, store } = await setup();
    addClip("a", 2, 4);
    const revision = store.revision;
    const from = edge(at(6), -1);
    drag(from, from);
    expect(store.revision).toBe(revision);
  });
});

describe("the razor", () => {
  it("cuts where it clicks, on a frame", async () => {
    const { editor, addClip, at, main, drag } = await setup();
    addClip("a", 2, 4);
    editor.setTool("razor");
    drag(at(3.51), at(3.51));
    const clips = Object.values(main().clips);
    expect(clips).toHaveLength(2);
    const lengths = clips.map(({ duration }) => duration);
    expect(lengths).toContain("1.5");
  });

  it("shows where it would cut", async () => {
    const { editor, addClip, at } = await setup();
    addClip("a", 2, 4);
    editor.setTool("razor");
    expect(editor.hover(at(4))).toBe("crosshair");
    expect(editor.razorAt).toBeCloseTo(4, 1);
    editor.hover(at(8));
    expect(editor.razorAt).toBeUndefined();
  });

  it("sticks to the playhead", async () => {
    const { editor, addClip, at, main, drag } = await setup();
    addClip("a", 2, 4);
    editor.seek(90);
    editor.setTool("razor");
    drag(at(3.03), at(3.03));
    const ends = Object.values(main().clips).map(({ start }) => start);
    expect(ends).toContain("3");
  });

  it("does nothing at the edge of a clip", async () => {
    const { editor, addClip, at, main, drag } = await setup();
    addClip("a", 2, 4);
    editor.setTool("razor");
    drag(at(2), at(2));
    expect(Object.keys(main().clips)).toHaveLength(1);
  });

  it("cuts every track with Shift, in one step, leaving locked ones alone", async () => {
    const { editor, addClip, at, main, drag, audio, store } = await setup();
    store.execute({
      type: "track.add",
      params: { timeline: "main", id: "upper", kind: "video" },
    });
    addClip("a", 2, 4);
    addClip("b", 2, 4, audio);
    addClip("c", 2, 4, "upper");
    editor.updateTrack("upper", { locked: true });
    editor.setTool("razor");
    const pointer = at(4, undefined, { shift: true });
    drag(pointer, pointer);
    expect(Object.keys(main().clips)).toHaveLength(5);
    store.undo();
    expect(Object.keys(main().clips)).toHaveLength(3);
  });

  it("does not cut a linked pair twice", async () => {
    const { editor, addClip, at, main, drag, audio } = await setup();
    addClip("a", 2, 4, undefined, { link: "together" });
    addClip("b", 2, 4, audio, { link: "together" });
    editor.setTool("razor");
    const pointer = at(4, undefined, { shift: true });
    drag(pointer, pointer);
    expect(Object.keys(main().clips)).toHaveLength(4);
  });

  it("leaves a linked clip on a locked track whole, also at the playhead", async () => {
    const { editor, addClip, at, main, drag, audio, store } = await setup();
    addClip("a", 2, 4, undefined, { link: "together" });
    addClip("b", 2, 4, audio, { link: "together" });
    editor.updateTrack(audio, { locked: true });
    editor.setTool("razor");
    drag(at(4), at(4));
    expect(Object.keys(main().clips)).toHaveLength(3);
    expect(main().clips["b"]).toMatchObject({ duration: "4", link: "together" });
    store.undo();
    editor.setTool("select");
    editor.selectOnly("a");
    editor.seek(120);
    editor.splitAtPlayhead();
    expect(Object.keys(main().clips)).toHaveLength(3);
    expect(main().clips["b"]?.duration).toBe("4");
  });

  it("goes back to selecting, and keeps out of the way of the ruler", async () => {
    const { editor, addClip, onRuler, at } = await setup();
    addClip("a", 2, 4);
    editor.setTool("razor");
    editor.press(onRuler(4));
    editor.release(onRuler(4));
    expect(editor.frame).toBe(120);
    editor.setTool("select");
    expect(editor.razorAt).toBeUndefined();
    expect(editor.hover(at(4))).toBe("default");
  });
});

describe("the end of the timeline", () => {
  it("can be dragged", async () => {
    const { editor, onRuler, main } = await setup();
    const press = onRuler(10);
    expect(editor.hitAt(press).kind).toBe("end");
    editor.press(press);
    editor.drag(onRuler(6));
    expect(editor.preview?.end).toBeCloseTo(6, 1);
    expect(editor.visibleDuration).toBeCloseTo(6, 1);
    editor.release(onRuler(6));
    expect(Object.values(main().sections)[0]?.duration).toBe("6");
  });

  it("stays where it is on a click, also off the frame grid", async () => {
    const { editor, store, onRuler, main } = await setup();
    editor.toggleSnapping();
    const [section] = Object.keys(main().sections);
    store.execute({
      type: "section.update",
      params: { timeline: "main", section, duration: "9.0123" },
    });
    const revision = store.revision;
    const press = onRuler(9.0123);
    expect(editor.hitAt(press).kind).toBe("end");
    editor.press(press);
    editor.release(press);
    expect(store.revision).toBe(revision);
    expect(Object.values(main().sections)[0]?.duration).toBe("9.0123");
  });

  it("stops at the last clip", async () => {
    const { editor, addClip, onRuler } = await setup();
    addClip("a", 2, 2);
    editor.press(onRuler(10));
    editor.drag(onRuler(1));
    editor.release(onRuler(1));
    expect(editor.model?.duration).toBe(4);
  });

  it("changes only the last section", async () => {
    const { editor, store, onRuler, main } = await setup();
    store.execute({
      type: "section.add",
      params: { timeline: "main", id: "second", duration: "4" },
    });
    editor.zoomToFit();
    editor.press(onRuler(14));
    editor.drag(onRuler(12));
    editor.release(onRuler(12));
    expect(main().sections["second"]?.duration).toBe("2");
    editor.press(onRuler(12));
    editor.drag(onRuler(3));
    editor.release(onRuler(3));
    expect(main().sections["second"]?.duration).toBe("1/30");
  });

  it("is one step to undo, and Escape leaves no trace", async () => {
    const { editor, onRuler, store } = await setup();
    editor.press(onRuler(10));
    editor.drag(onRuler(6));
    editor.release(onRuler(6));
    store.undo();
    expect(editor.model?.duration).toBe(10);
    editor.press(onRuler(10));
    editor.drag(onRuler(6));
    editor.cancelDrag();
    expect(editor.model?.duration).toBe(10);
  });
});

describe("changing the project from the keyboard and menus", () => {
  it("deletes what is selected, in one step", async () => {
    const { editor, addClip, main, store } = await setup();
    addClip("a", 1, 1);
    addClip("b", 3, 1);
    editor.selectAll();
    editor.deleteSelection();
    expect(Object.keys(main().clips)).toEqual([]);
    store.undo();
    expect(Object.keys(main().clips)).toHaveLength(2);
  });

  it("leaves locked clips alone when deleting", async () => {
    const { editor, addClip, main, audio, commandFailed } = await setup();
    addClip("a", 1, 1);
    addClip("b", 1, 1, audio);
    editor.updateTrack(audio, { locked: true });
    editor.selectAll();
    editor.deleteSelection();
    expect(Object.keys(main().clips)).toEqual(["b"]);
    expect(commandFailed).not.toHaveBeenCalled();
  });

  it("does not take a locked track away", async () => {
    const { editor, addClip, main, audio } = await setup();
    addClip("b", 1, 1, audio);
    editor.updateTrack(audio, { locked: true });
    editor.removeTrack(audio);
    expect(main().tracks[audio]).toBeDefined();
    expect(Object.keys(main().clips)).toEqual(["b"]);
  });

  it("has nothing to delete without a selection", async () => {
    const { editor, addClip, store } = await setup();
    addClip("a", 1, 1);
    const revision = store.revision;
    editor.deleteSelection();
    expect(store.revision).toBe(revision);
  });

  it("does not cut anything until something is selected", async () => {
    const { editor, addClip, main, audio, store } = await setup();
    addClip("a", 0, 4);
    addClip("b", 0, 4, audio);
    editor.seek(60);
    const revision = store.revision;
    expect(editor.canSplit).toBe(false);
    editor.splitAtPlayhead();
    expect(store.revision).toBe(revision);
    expect(Object.keys(main().clips)).toHaveLength(2);
  });

  it("cuts only what is selected", async () => {
    const { editor, addClip, main, audio, at } = await setup();
    addClip("a", 0, 4);
    addClip("b", 0, 4, audio);
    editor.press(at(3));
    editor.release(at(3));
    editor.seek(60);
    editor.splitAtPlayhead();
    expect(Object.keys(main().clips)).toHaveLength(3);
  });

  it("does nothing when the playhead is on an edge or over nothing", async () => {
    const { editor, addClip, store } = await setup();
    addClip("a", 2, 2);
    editor.selectAll();
    const revision = store.revision;
    for (const frame of [0, 60, 120, 200]) {
      editor.seek(frame);
      expect(editor.canSplit).toBe(false);
      editor.splitAtPlayhead();
    }
    expect(store.revision).toBe(revision);
    editor.seek(90);
    expect(editor.canSplit).toBe(true);
  });

  describe("adding a colour", () => {
    it("goes to the playhead on the first track, and the playhead moves past it", async () => {
      const { editor, main, video, selection } = await setup();
      editor.seek(30);
      editor.addColorClip();
      const [added] = Object.values(main().clips);
      expect(added?.track).toBe(video);
      expect(added?.start).toBe("1");
      expect(added?.duration).toBe("5");
      expect(editor.frame).toBe(180);
      expect(selection()).toEqual([added?.id]);
    });

    it("makes a row of clips when repeated", async () => {
      const { editor, main } = await setup();
      editor.addColorClip();
      editor.addColorClip();
      editor.addColorClip();
      const starts = Object.values(main().clips).map(({ start }) => start);
      expect(starts.toSorted()).toEqual(["0", "10", "5"]);
      expect(editor.model?.duration).toBe(15);
    });

    it("uses different colours", async () => {
      const { editor, main } = await setup();
      editor.addColorClip();
      editor.addColorClip();
      const colors = Object.values(main().clips).map(({ source }) => JSON.stringify(source));
      expect(new Set(colors).size).toBe(2);
    });

    it("gets shorter to fit a gap, overwriting nothing", async () => {
      const { editor, addClip, main } = await setup();
      addClip("a", 2, 2);
      editor.addColorClip();
      const added = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(added?.duration).toBe("2");
      expect(main().clips["a"]?.duration).toBe("2");
    });

    it("goes to a new track when there is no room at the playhead", async () => {
      const { editor, addClip, main, video } = await setup();
      addClip("a", 0, 5);
      editor.addColorClip();
      const added = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(added?.track).not.toBe(video);
      expect(main().tracks[added?.track as string]?.kind).toBe("video");
    });

    it("skips a locked track", async () => {
      const { editor, main, video } = await setup();
      editor.updateTrack(video, { locked: true });
      editor.addColorClip();
      const [added] = Object.values(main().clips);
      expect(added?.track).not.toBe(video);
    });

    it("is one step to undo, new track and all", async () => {
      const { editor, addClip, main, store } = await setup();
      addClip("a", 0, 5);
      const tracks = Object.keys(main().tracks).length;
      editor.addColorClip();
      store.undo();
      expect(Object.keys(main().tracks)).toHaveLength(tracks);
      expect(Object.keys(main().clips)).toEqual(["a"]);
    });

    it("goes where it was asked to, in the gap that is there", async () => {
      const { editor, addClip, main, video } = await setup();
      addClip("a", 3, 2);
      const row = editor.model?.rows.find(({ id }) => id === video);
      if (!row) throw new Error("no row");
      editor.addColorClip({ row, seconds: 1 });
      const added = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(added?.start).toBe("1");
      expect(added?.duration).toBe("2");
    });
  });

  describe("at the edges of clips, where floats and exact times disagree", () => {
    it("does not try to cut a clip at its very end", async () => {
      const { editor, addClip, main, audio, commandFailed } = await setup();
      addClip("a", "1/30", "31/30");
      addClip("long", 0, 10, audio);
      editor.selectAll();
      editor.seek(32);
      editor.splitAtPlayhead();
      expect(commandFailed).not.toHaveBeenCalled();
      expect(Object.keys(main().clips)).toHaveLength(3);
      expect(main().clips["a"]?.duration).toBe("31/30");
    });

    it("cuts clips added one after the other at any frame", async () => {
      const { editor, commandFailed, store } = await setup();
      for (let frame = 1; frame < 150; frame += 7) {
        editor.seek(frame);
        editor.addColorClip();
        editor.seek(frame + 1);
        editor.splitAtPlayhead();
        editor.seek(frame + 2);
        editor.splitAtPlayhead();
        for (let step = 0; step < 3; step++) store.undo();
      }
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("the razor does the same", async () => {
      const { editor, addClip, main, audio, commandFailed, onRuler, at, drag } = await setup();
      addClip("a", "1/30", "31/30");
      addClip("long", 0, 10, audio);
      editor.zoomAround(0, 8);
      editor.seek(32);
      editor.setTool("razor");
      const moment = at(32 / 30, undefined, { shift: true });
      drag(moment, moment);
      expect(commandFailed).not.toHaveBeenCalled();
      expect(main().clips["a"]?.duration).toBe("31/30");
      expect(onRuler(0)).toBeDefined();
    });

    it("finds room right after a clip at any frame", async () => {
      const { editor, main, video, store } = await setup();
      for (let frame = 1; frame < 200; frame += 3) {
        editor.seek(frame);
        editor.addColorClip();
        editor.addColorClip();
        expect(Object.keys(main().tracks)).toHaveLength(2);
        expect(Object.values(main().clips).every(({ track }) => track === video)).toBe(true);
        store.undo();
        store.undo();
      }
    });
  });

  describe("at a rate like 29.97", () => {
    const ntsc = async () => {
      const context = await setup();
      context.store.execute({ type: "project.setFrameRate", params: { fps: "30000/1001" } });
      return context;
    };

    it("notices that the rate changed", async () => {
      const { editor } = await ntsc();
      expect(editor.model?.rate.nominal).toBe(30);
      expect(editor.model?.fps).toBe("30000/1001");
    });

    it("gives a new clip a whole number of frames", async () => {
      const { editor, main } = await ntsc();
      editor.addColorClip();
      const [added] = Object.values(main().clips);
      expect(added?.duration).toBe("5.005");
      editor.addColorClip();
      const starts = Object.values(main().clips).map(({ start }) => start);
      expect(starts).toContain("5.005");
    });
  });

  describe("clips left behind on a track somebody removed", () => {
    const withLeftBehind = async () => {
      const context = await setup();
      const { store, video } = context;
      const other = ProjectStore.fromUpdates([store.encodeState()]).store;
      if (!other) throw new Error("no copy");
      other.execute({
        type: "track.add",
        params: { timeline: "main", id: "doomed", kind: "video" },
      });
      store.applyUpdates([other.encodeState()]);
      other.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track: "doomed",
          clip: {
            id: "late",
            start: "20",
            duration: "1",
            source: { kind: "color", color: "#112233" },
          },
        },
      });
      store.execute({ type: "track.remove", params: { timeline: "main", track: "doomed" } });
      store.applyUpdates([other.encodeState()]);
      return { ...context, video };
    };

    it("get a row of their own, so that they can be seen", async () => {
      const { editor } = await withLeftBehind();
      const row = editor.model?.rowOfClip.get("late");
      expect(row?.gone).toBe(true);
      expect(editor.model?.rows.filter(({ gone }) => gone)).toHaveLength(1);
    });

    it("can be deleted along with everything else", async () => {
      const { editor, commandFailed, addClip, main } = await withLeftBehind();
      addClip("a", 1, 1);
      editor.selectAll();
      editor.deleteSelection();
      expect(commandFailed).not.toHaveBeenCalled();
      expect(Object.keys(main().clips)).toEqual([]);
      expect(editor.model?.rows.some(({ gone }) => gone)).toBe(false);
    });

    it("can be dragged to a real track", async () => {
      const { editor, at, clip, video, drag, commandFailed } = await withLeftBehind();
      editor.zoomToFit();
      drag(at(20.5, "doomed"), at(20.5, video));
      expect(commandFailed).not.toHaveBeenCalled();
      expect(clip("late").track).toBe(video);
    });

    it("do not take other clips or new ones", async () => {
      const { editor, addClip, at, clip, video, drag, commandFailed, main } =
        await withLeftBehind();
      addClip("a", 0, 5);
      drag(at(1.5), at(1.5, "doomed"));
      expect(clip("a").track).toBe(video);
      editor.seek(0);
      editor.addColorClip();
      const added = Object.values(main().clips).find(({ id }) => !["a", "late"].includes(id));
      expect(added?.track).not.toBe("doomed");
      expect(commandFailed).not.toHaveBeenCalled();
    });
  });

  describe("copy and paste", () => {
    it("puts copies at the playhead, as far apart as they were", async () => {
      const { editor, addClip, main, selection } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      editor.selectAll();
      editor.copySelection();
      editor.seek(150);
      editor.paste();
      const copies = Object.values(main().clips).filter(({ id }) => !["a", "b"].includes(id));
      expect(copies.map(({ start }) => start).toSorted()).toEqual(["5", "7"]);
      expect(selection().toSorted()).toEqual(copies.map(({ id }) => id).toSorted());
      expect(editor.frame).toBe(150);
    });

    it("goes after what is there, unless overwriting is on", async () => {
      const { editor, addClip, main, at } = await setup();
      addClip("a", 0, 2);
      addClip("b", 4, 2);
      editor.press(at(1));
      editor.release(at(1));
      editor.copySelection();
      editor.seek(150);
      editor.paste();
      let copy = Object.values(main().clips).find(({ id }) => !["a", "b"].includes(id));
      expect(copy?.start).toBe("6");
      editor.toggleOverwriting();
      editor.seek(150);
      editor.paste();
      expect(main().clips["b"]?.duration).toBe("1");
      copy = Object.values(main().clips).find(({ start }) => start === "5");
      expect(copy).toBeDefined();
    });

    it("keeps what was cut until it is pasted, which is one step to undo", async () => {
      const { editor, addClip, main, store } = await setup();
      addClip("a", 1, 1);
      editor.selectAll();
      const revision = store.revision;
      editor.cutSelection();
      expect(store.revision).toBe(revision);
      expect(main().clips["a"]).toBeDefined();
      expect([...editor.getSnapshot().cut]).toEqual(["a"]);
      editor.seek(150);
      editor.paste();
      expect(main().clips["a"]).toBeUndefined();
      expect(Object.values(main().clips).map(({ start }) => start)).toEqual(["5"]);
      expect(editor.getSnapshot().cut.size).toBe(0);
      store.undo();
      expect(Object.keys(main().clips)).toEqual(["a"]);
    });

    it("says that what was cut goes on as the clip it became, and what was copied does not", async () => {
      const { editor, addClip, main, store } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      const moves: unknown[] = [];
      store.subscribe(() => moves.push(...(store.change?.facts ?? [])));
      editor.selectAll();
      editor.copySelection();
      editor.seek(150);
      editor.paste();
      expect(moves).toEqual([]);

      editor.seek(0);
      editor.selectOnly("a");
      editor.cutSelection();
      editor.seek(300);
      editor.paste();
      const [added] = Object.values(main().clips).filter(({ start }) => start === "10");
      expect(moves).toEqual([{ kind: "moved", from: "a", to: added?.id }]);
    });

    it("can paste what was cut onto its own place", async () => {
      const { editor, addClip, main } = await setup();
      addClip("a", 1, 2);
      editor.selectAll();
      editor.cutSelection();
      editor.seek(45);
      editor.paste();
      expect(Object.values(main().clips).map(({ start }) => start)).toEqual(["1.5"]);
    });

    it("can take a cut back, and then there is nothing to paste", async () => {
      const { editor, addClip, main } = await setup();
      addClip("a", 1, 1);
      editor.selectAll();
      editor.cutSelection();
      expect(editor.cancelCut()).toBe(true);
      expect(editor.cancelCut()).toBe(false);
      expect(editor.hasClipboard).toBe(false);
      editor.paste();
      expect(Object.keys(main().clips)).toEqual(["a"]);
    });

    it("forgets a cut when something else gets copied", async () => {
      const { editor, addClip, main, at } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      editor.selectOnly("a");
      editor.cutSelection();
      editor.selectOnly("b");
      editor.copySelection();
      expect(editor.getSnapshot().cut.size).toBe(0);
      editor.seek(150);
      editor.paste();
      expect(main().clips["a"]).toBeDefined();
      expect(at(0)).toBeDefined();
    });

    it("forgets a clip that is gone from what was cut", async () => {
      const { editor, addClip, store } = await setup();
      addClip("a", 1, 1);
      editor.selectAll();
      editor.cutSelection();
      store.undo();
      expect(editor.getSnapshot().cut.size).toBe(0);
    });

    it("goes to another track when its own is locked, and to a new one when none is left", async () => {
      const { editor, addClip, main, video, commandFailed } = await setup();
      addClip("a", 1, 1);
      editor.selectAll();
      editor.copySelection();
      editor.updateTrack(video, { locked: true });
      editor.paste();
      const copy = Object.values(main().clips).find(({ id }) => id !== "a");
      expect(copy?.track).not.toBe(video);
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("has nothing to paste at first", async () => {
      const { editor, store } = await setup();
      const revision = store.revision;
      expect(editor.hasClipboard).toBe(false);
      editor.paste();
      expect(store.revision).toBe(revision);
    });
  });

  describe("locked tracks", () => {
    const click = (editor: TimelineEditor, pointer: Pointer) => {
      editor.press(pointer);
      editor.release(pointer);
    };

    it("show what is on them: a click selects the clip, a click next to it does not", async () => {
      const { editor, addClip, at, selection, video } = await setup();
      addClip("a", 1, 2);
      editor.updateTrack(video, { locked: true });
      click(editor, at(2));
      expect(selection()).toEqual(["a"]);
      click(editor, at(5));
      expect(selection()).toEqual([]);
    });

    it("go in and out of a selection with Shift, like any clip", async () => {
      const { editor, addClip, at, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      click(editor, at(2, audio));
      click(editor, at(2, video, { shift: true }));
      expect(selection()).toEqual(["a", "b"]);
      click(editor, at(2, video, { shift: true }));
      expect(selection()).toEqual(["b"]);
    });

    it("stay out of what gets selected all at once", async () => {
      const { editor, addClip, at, drag, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      drag(at(0.5), at(5, audio));
      expect(selection()).toEqual(["b"]);
      editor.selectAll();
      expect(selection()).toEqual(["b"]);
    });

    it("stay selected when they get locked", async () => {
      const { editor, addClip, selection, video } = await setup();
      addClip("a", 1, 2);
      editor.selectAll();
      editor.updateTrack(video, { locked: true });
      expect(selection()).toEqual(["a"]);
    });

    it("start a box when pressed on", async () => {
      const { editor, addClip, at, drag, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      drag(at(2), at(2.5, audio));
      expect(selection()).toEqual(["b"]);
    });

    it("leave the selection alone until it is clear what a press means", async () => {
      const { editor, addClip, at, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      click(editor, at(2, audio));
      editor.press(at(2));
      expect(selection()).toEqual(["b"]);
      editor.release(at(2));
      expect(selection()).toEqual(["a"]);
    });

    it("go back to what was selected when a box from them is cancelled", async () => {
      const { editor, addClip, at, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      click(editor, at(2, audio));
      editor.press(at(2));
      editor.drag(at(2.5, audio));
      editor.cancelDrag();
      expect(selection()).toEqual(["b"]);
    });

    it("cannot be moved, trimmed, cut or deleted while selected", async () => {
      const { editor, store, addClip, at, drag, clip, selection, video, commandFailed } =
        await setup();
      addClip("a", 1, 2);
      editor.selectAll();
      editor.seek(frameAt(2, editor.model?.rate as never));
      editor.updateTrack(video, { locked: true });
      const { revision } = store;

      expect(editor.canChangeSelection).toBe(false);
      expect(editor.canSplit).toBe(false);
      editor.deleteSelection();
      editor.splitAtPlayhead();
      editor.cutSelection();
      expect(editor.getSnapshot().cut.size).toBe(0);
      expect(editor.hasClipboard).toBe(false);
      expect(selection()).toEqual(["a"]);

      drag(at(2), at(4));
      drag(at(1), at(1.5));
      drag(at(3), at(3.5));
      expect(store.revision).toBe(revision);
      expect(clip("a").start).toBe("1");
      expect(clip("a").duration).toBe("2");
      expect(commandFailed).not.toHaveBeenCalled();
    });

    /** One clip that is free and one that is locked, both selected. */
    const withBoth = async () => {
      const context = await setup();
      const { editor, addClip, at, video, audio } = context;
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(audio, { locked: true });
      click(editor, at(2, video));
      click(editor, at(2, audio, { shift: true }));
      expect(context.selection()).toEqual(["a", "b"]);
      return context;
    };

    it("stay behind when the rest of a selection goes", async () => {
      const { editor, main, commandFailed } = await withBoth();
      expect(editor.canChangeSelection).toBe(true);
      editor.deleteSelection();
      expect(Object.keys(main().clips)).toEqual(["b"]);
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("stay behind when the rest of a selection is cut and pasted", async () => {
      const { editor, main, clip, commandFailed } = await withBoth();
      editor.cutSelection();
      expect([...editor.getSnapshot().cut]).toEqual(["a"]);
      editor.seek(frameAt(5, editor.model?.rate as never));
      editor.paste();
      expect(Object.keys(main().clips)).toHaveLength(2);
      expect(clip("b").start).toBe("1");
      expect(main().clips["a"]).toBeUndefined();
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("stay whole when the rest of a selection is split", async () => {
      const { editor, main, clip, commandFailed } = await withBoth();
      editor.seek(frameAt(2, editor.model?.rate as never));
      expect(editor.canSplit).toBe(true);
      editor.splitAtPlayhead();
      expect(Object.keys(main().clips)).toHaveLength(3);
      expect(clip("b").duration).toBe("2");
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("can be copied, because that leaves them as they are", async () => {
      const { editor, addClip, at, main, video, audio, commandFailed } = await setup();
      addClip("a", 1, 2);
      editor.addTrack("video");
      editor.updateTrack(video, { locked: true });
      click(editor, at(2));
      editor.copySelection();
      editor.seek(frameAt(5, editor.model?.rate as never));
      editor.paste();
      const copies = Object.values(main().clips).filter(({ id }) => id !== "a");
      expect(copies).toHaveLength(1);
      expect(copies[0]?.track).not.toBe(video);
      expect(copies[0]?.track).not.toBe(audio);
      expect(commandFailed).not.toHaveBeenCalled();
    });

    it("are not part of what a cut waits to take away, once they get locked", async () => {
      const { editor, addClip, video, selection } = await setup();
      addClip("a", 1, 2);
      editor.selectAll();
      editor.cutSelection();
      editor.updateTrack(video, { locked: true });
      expect(editor.getSnapshot().cut.size).toBe(0);
      expect(selection()).toEqual(["a"]);
    });
  });

  describe("files", () => {
    const withAssets = async () => {
      const context = await setup();
      const add = (id: string, asset: object) =>
        context.store.execute({
          type: "asset.add",
          params: {
            id,
            asset: { path: `assets/${id}`, storage: "local", name: `${id} 文件`, ...asset },
          },
        });
      add("pic", { kind: "image" });
      add("song", { kind: "audio", info: { duration: "3.01" } });
      add("film", { kind: "video", info: { duration: "2", hasAudio: true } });
      add("mute", { kind: "video", info: { duration: "2" } });
      const clips = () => Object.values(context.main().clips);
      return { ...context, clips };
    };

    it("puts a picture on a video track, for a few seconds", async () => {
      const { editor, clips, video } = await withAssets();
      editor.addAsset("pic");
      expect(clips()[0]).toMatchObject({ track: video, duration: "5", name: "pic 文件" });
    });

    it("puts sound on an audio track, whole frames long", async () => {
      const { editor, clips, audio } = await withAssets();
      editor.addAsset("song");
      expect(clips()[0]?.track).toBe(audio);
      expect(clips()[0]?.duration).toBe("3");
    });

    it("makes two linked clips of a video with sound, in one step", async () => {
      const { editor, clips, store, selection } = await withAssets();
      editor.addAsset("film");
      expect(clips()).toHaveLength(2);
      expect(new Set(clips().map(({ link }) => link)).size).toBe(1);
      expect(
        clips()
          .map(({ source }) => source.kind)
          .toSorted(),
      ).toEqual(["audio", "video"]);
      expect(selection()).toHaveLength(2);
      store.undo();
      expect(clips()).toHaveLength(0);
    });

    it("makes one clip of a video without sound", async () => {
      const { editor, clips } = await withAssets();
      editor.addAsset("mute");
      expect(clips()).toHaveLength(1);
    });

    it("goes after what is there, on all its tracks, when it was dropped", async () => {
      const { editor, clips, addClip, audio } = await withAssets();
      addClip("x", 0, 4, audio);
      editor.addAsset("film", { lane: 0, seconds: 0 });
      const added = clips().filter(({ id }) => id !== "x");
      expect(added.map(({ start }) => start)).toEqual(["4", "4"]);
    });

    describe("with a click, right at the playhead", () => {
      const at = (editor: TimelineEditor, seconds: number) =>
        editor.seek(frameAt(seconds, editor.model?.rate as never));
      const added = (clips: () => ClipState[], ...old: string[]) =>
        clips().filter(({ id }) => !old.includes(id));

      it("goes on the track of the selected clip, when nothing is in the way there", async () => {
        const { editor, clips, store, addClip, selection } = await withAssets();
        store.execute({ type: "track.add", params: { timeline: "main", id: "up", kind: "video" } });
        addClip("x", 0, 1, "up");
        editor.selectOnly("x");
        at(editor, 3);
        editor.addAsset("pic");
        const [clip] = added(clips, "x");
        expect(clip).toMatchObject({ track: "up", start: "3" });
        expect(selection()).toEqual([clip?.id]);
      });

      it("goes on the first free track of the kind when that one is in the way", async () => {
        const { editor, clips, store, addClip, video } = await withAssets();
        store.execute({ type: "track.add", params: { timeline: "main", id: "up", kind: "video" } });
        addClip("x", 0, 4, "up");
        editor.selectOnly("x");
        at(editor, 2);
        editor.addAsset("pic");
        expect(added(clips, "x")[0]).toMatchObject({ track: video, start: "2" });
      });

      it("makes a track when every one of the kind is in the way, in one step", async () => {
        const { editor, clips, addClip, video, audio, main, store } = await withAssets();
        addClip("x", 0, 4);
        addClip("y", 3, 4, audio);
        const tracks = Object.keys(main().tracks).length;
        at(editor, 3);
        editor.addAsset("film");
        const both = added(clips, "x", "y");
        expect(both).toHaveLength(2);
        expect(both.map(({ start }) => start)).toEqual(["3", "3"]);
        expect(both.every(({ track }) => track !== video && track !== audio)).toBe(true);
        expect(Object.keys(main().tracks)).toHaveLength(tracks + 2);
        expect(main().clips["x"]?.duration).toBe("4");
        store.undo();
        expect(added(clips, "x", "y")).toEqual([]);
        expect(Object.keys(main().tracks)).toHaveLength(tracks);
      });

      it("fits right where a clip ends, and leaves locked tracks alone", async () => {
        const { editor, clips, store, addClip, video } = await withAssets();
        addClip("x", 0, 2);
        store.execute({ type: "track.add", params: { timeline: "main", id: "up", kind: "video" } });
        editor.updateTrack("up", { locked: true });
        editor.selectOnly("x");
        at(editor, 2);
        editor.addAsset("pic");
        expect(added(clips, "x")[0]).toMatchObject({ track: video, start: "2" });
        at(editor, 1);
        editor.addAsset("mute");
        const track = clips().find(({ start }) => start === "1")?.track;
        expect(track).not.toBe(video);
        expect(track).not.toBe("up");
      });
    });

    it("goes to the track it was dropped on, or else to one that can take it", async () => {
      const { editor, clips, store, audio, video } = await withAssets();
      store.execute({ type: "track.add", params: { timeline: "main", id: "up", kind: "video" } });
      const row = (id: string) => editor.model?.rows.find((item) => item.id === id);
      editor.addAsset("mute", { lane: (row("up")?.top ?? 0) + 2, seconds: 1 });
      expect(clips()[0]).toMatchObject({ track: "up", start: "1" });
      editor.addAsset("pic", { lane: (row(audio)?.top ?? 0) + 2, seconds: 6 });
      expect(clips().find(({ start }) => start === "6")?.track).toBe(video);
    });

    it("shows where a drop lands, snapped, and lands right there", async () => {
      const { editor, clips, addClip, at, audio, video } = await withAssets();
      addClip("x", 0, 4);
      const reach = editor.dropPlaceAt(at(1)).snap ?? 0;
      expect(reach).toBeGreaterThan(0);
      // A little after the end of x: the start snaps to it.
      const near = at(4 + reach / 2);
      editor.showDrop(near, { kind: "asset", id: "film" });
      const shown = editor.preview?.adding ?? [];
      expect(shown.map(({ kind, row, start, end }) => [kind, row, start, end])).toEqual([
        ["video", video, 4, 6],
        ["audio", audio, 4, 6],
      ]);
      expect(editor.preview?.snap).toBe(4);
      editor.showDrop(undefined);
      expect(editor.preview).toBeUndefined();
      editor.addAsset("film", editor.dropPlaceAt(near));
      expect(
        clips()
          .filter(({ id }) => id !== "x")
          .map(({ start, track }) => [start, track]),
      ).toEqual([
        ["4", video],
        ["4", audio],
      ]);
    });

    it("snaps its end too, and not with Alt, and says what it would overwrite", async () => {
      const { editor, addClip, at, video } = await withAssets();
      addClip("x", 4, 2);
      // A clip of two seconds ending a little before x: its end goes to the start of x.
      const reach = editor.dropPlaceAt(at(1)).snap ?? 0;
      editor.showDrop(at(2 - reach / 2), { kind: "asset", id: "mute" });
      expect(editor.preview?.adding?.[0]).toMatchObject({ row: video, start: 2, end: 4 });
      editor.showDrop(at(2 - reach / 2, video, { alt: true }), { kind: "asset", id: "mute" });
      expect(editor.preview?.adding?.[0]?.start).toBeLessThan(2);
      // Overwriting, it stays where it is, over what it would cover.
      if (!editor.getSnapshot().overwriting) editor.toggleOverwriting();
      editor.showDrop(at(5), { kind: "asset", id: "mute" });
      expect(editor.preview?.adding?.[0]).toMatchObject({ row: video, start: 5, end: 7 });
      expect(editor.preview?.covered?.map(({ from, to }) => [from, to])).toEqual([[5, 6]]);
      // Without one of its kind that can take it, a new track.
      editor.updateTrack(video, { locked: true });
      editor.showDrop(at(8), { kind: "asset", id: "mute" });
      expect(editor.preview?.adding?.[0]).toMatchObject({ kind: "video", row: undefined });
    });

    it("says where a click put it, lights it up and scrolls to it", async () => {
      const { editor, video } = await withAssets();
      vi.useFakeTimers();
      try {
        // Zoomed in on the start, the end of the timeline is far out of sight.
        for (let step = 0; step < 12; step++) editor.zoomAround(0, 2);
        editor.seek(frameAt(9, editor.model?.rate as never));
        editor.setScroll(0, 0);
        expect(editor.xAt(9)).toBeGreaterThan(editor.width);
        const added = editor.addAsset("pic");
        expect(added).toMatchObject({ start: 9, tracks: [{ kind: "video", number: 1 }] });
        const [clip = ""] = added?.clips ?? [];
        expect(editor.flashOf("clips", clip)).toBe(1);
        expect(editor.flashesOn(clip)).toBe(true);
        expect(editor.model?.rowOfClip.get(clip)?.id).toBe(video);
        // It is in the middle now, and the playhead stayed.
        expect(Math.abs(editor.xAt(11.5) - editor.width / 2)).toBeLessThan(2);
        expect(editor.frame).toBe(frameAt(9, editor.model?.rate as never));
        vi.advanceTimersByTime(FLASH_MS * 2);
        expect(editor.flashesOn(clip)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("makes a track when there is none", async () => {
      const { editor, clips, audio, main } = await withAssets();
      editor.removeTrack(audio);
      editor.addAsset("song");
      expect(main().tracks[clips()[0]?.track as string]?.kind).toBe("audio");
    });

    describe("a scene", () => {
      const withScenes = async () => {
        const context = await withAssets();
        const page = { "index.html": "<p>a</p>" };
        const scene = { name: "片头", entry: "index.html", runtime: 1 };
        context.store.execute({ type: "scene.add", params: { id: "s", scene, files: page } });
        return context;
      };

      it("goes on a video track at the playhead, with the name of the scene", async () => {
        const { editor, clips, video, selection } = await withScenes();
        editor.seek(30);
        editor.addScene("s");
        expect(clips()[0]).toMatchObject({
          track: video,
          start: "1",
          duration: "5",
          name: "片头",
          source: { kind: "scene", scene: "s" },
        });
        expect(selection()).toHaveLength(1);
      });

      it("goes on a free track at the playhead, and never over what is there", async () => {
        const { editor, clips, addClip, video, store } = await withScenes();
        addClip("x", 0, 2);
        editor.toggleOverwriting();
        editor.addScene("s");
        const scene = clips().find(({ id }) => id !== "x");
        expect(scene?.start).toBe("0");
        expect(scene?.track).not.toBe(video);
        expect(clips().find(({ id }) => id === "x")?.duration).toBe("2");
        store.undo();
        expect(clips()).toHaveLength(1);
      });

      it("a new one still goes after what is there", async () => {
        const { editor, clips, addClip } = await withScenes();
        addClip("x", 0, 2);
        editor.createScene();
        expect(clips().find(({ id }) => id !== "x")?.start).toBe("2");
      });

      it("goes to the track it was dropped on", async () => {
        const { editor, clips, store } = await withScenes();
        store.execute({ type: "track.add", params: { timeline: "main", id: "up", kind: "video" } });
        const row = editor.model?.rows.find((item) => item.id === "up");
        editor.addScene("s", { lane: (row?.top ?? 0) + 2, seconds: 1 });
        expect(clips()[0]).toMatchObject({ track: "up", start: "1" });
      });

      it("makes a track when there is none", async () => {
        const { editor, clips, video, main } = await withScenes();
        editor.removeTrack(video);
        editor.addScene("s");
        expect(main().tracks[clips()[0]?.track as string]?.kind).toBe("video");
      });

      it("does nothing for a scene that is not there", async () => {
        const { editor, clips } = await withScenes();
        editor.addScene("nope");
        expect(clips()).toEqual([]);
      });

      it("leaves a locked track alone", async () => {
        const { editor, clips, video, store, commandFailed, main } = await withScenes();
        store.execute({
          type: "track.update",
          params: { timeline: "main", track: video, changes: { locked: true } },
        });
        editor.addScene("s");
        expect(commandFailed).not.toHaveBeenCalled();
        expect(main().tracks[clips()[0]?.track as string]?.locked).toBeUndefined();
      });

      it("a new one comes with its files and a clip, in one step", async () => {
        const { editor, clips, store, selection } = await withAssets();
        editor.createScene();
        const clip = clips()[0] as ClipState;
        const id = clip.source["scene" as never] as string;
        expect(clip.name).toBe("Scene 1");
        const { scenes, files } = store.getState();
        expect(scenes[id]).toMatchObject({ name: "Scene 1", entry: "index.html", runtime: 1 });
        expect(files[`scenes/${id}/index.html`]).toContain("<h1>Scene 1</h1>");
        expect(files[`scenes/${id}/style.css`]).toContain("@keyframes");
        expect(selection()).toEqual([clip.id]);
        store.undo();
        expect(clips()).toEqual([]);
        expect(store.getState().scenes).toEqual({});
        expect(store.getState().files).toEqual({});
      });

      it("a new one gets the next number, in the words of the editor", async () => {
        const context = await withScenes();
        const { store, clips, main } = context;
        const words = { commandFailed: () => {}, sceneName: (n: number) => `场景 ${n}` };
        const session = { store, subscribe: () => () => {} } as never;
        const memory = { read: () => undefined, write: () => {} } as never;
        const settings = {
          load: async () => undefined,
          save: async () => {},
          listen: () => () => {},
        };
        const editor = new TimelineEditor(session, memory, settings as never, words);
        editor.createScene();
        expect(clips()[0]?.name).toBe("场景 2");
        expect(Object.keys(main().clips)).toHaveLength(1);
      });

      it("a name with something HTML means something by stays what it says", () => {
        const { files } = sceneTemplate("A & <B>");
        expect(files["index.html"]).toContain("<h1>A &amp; &lt;B></h1>");
      });

      it("the template is what commands take", async () => {
        const { store } = await withAssets();
        const params = { id: "t", ...sceneTemplate("模板") };
        expect(store.execute({ type: "scene.add", params }).ok).toBe(true);
      });
    });

    describe("once on the timeline", () => {
      const linked = async () => {
        const context = await withAssets();
        const { editor, clips, video } = context;
        editor.seek(30);
        editor.addAsset("film");
        editor.clearSelection();
        const picture = clips().find(({ track }) => track === video);
        const sound = clips().find(({ track }) => track !== video);
        if (!picture || !sound) throw new Error("no clips");
        return { ...context, picture: picture.id, sound: sound.id, soundTrack: sound.track };
      };

      it("select and move together", async () => {
        const { editor, at, drag, clip, sound, selection, picture } = await linked();
        editor.press(at(2));
        editor.release(at(2));
        expect(selection()).toEqual([picture, sound].toSorted());
        drag(at(2), at(4));
        expect(clip(sound).start).toBe("3");
        expect(clip(picture).start).toBe("3");
      });

      it("trim together", async () => {
        const { at, drag, clip, sound, picture } = await linked();
        const edge = { ...at(3), x: at(3).x - 2 };
        drag(edge, { ...at(2), x: at(2).x - 2 });
        expect(clip(picture).duration).toBe("1");
        expect(clip(sound).duration).toBe("1");
      });

      it("stop at the end of their content", async () => {
        const { at, drag, clip, picture, commandFailed } = await linked();
        const start = at(1);
        const inward = { ...at(3), x: at(3).x - 2 };
        drag(inward, at(2.5));
        drag({ ...at(2.5), x: at(2.5).x - 2 }, at(9));
        expect(clip(picture).duration).toBe("2");
        expect(commandFailed).not.toHaveBeenCalled();
        expect(start).toBeDefined();
      });

      it("go when one of them is deleted", async () => {
        const { editor, clips, picture } = await linked();
        editor.selectOnly(picture);
        editor.deleteSelection();
        expect(clips()).toHaveLength(0);
      });
    });
  });

  describe("multiple selection", () => {
    it("adds with a click, takes away with another, and an empty click changes nothing", async () => {
      const { editor, addClip, at, selection } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      editor.toggleMultiSelecting();
      const click = (pointer: Pointer) => {
        editor.press(pointer);
        editor.release(pointer);
      };
      click(at(1.5));
      click(at(3.5));
      expect(selection()).toEqual(["a", "b"]);
      click(at(8));
      expect(selection()).toEqual(["a", "b"]);
      click(at(1.5));
      expect(selection()).toEqual(["b"]);
    });

    it("still drags what is selected", async () => {
      const { editor, addClip, at, clip, drag } = await setup();
      addClip("a", 1, 1);
      addClip("b", 3, 1);
      editor.toggleMultiSelecting();
      editor.selectAll();
      drag(at(1.5), at(2.5));
      expect(clip("a").start).toBe("2");
      expect(clip("b").start).toBe("4");
    });
  });

  describe("playing", () => {
    it("moves the playhead with the clock, and stops at the end", async () => {
      const { editor } = await setup();
      editor.togglePlayback();
      editor.tick(1000);
      editor.tick(2000);
      expect(editor.frame).toBe(30);
      editor.tick(20_000);
      expect(editor.frame).toBe(300);
      expect(editor.getSnapshot().playing).toBe(false);
    });

    it("carries on from where people click", async () => {
      const { editor } = await setup();
      editor.togglePlayback();
      editor.tick(0);
      editor.seek(150);
      editor.tick(1000);
      editor.tick(2000);
      expect(editor.frame).toBe(180);
    });

    it("starts over from the end, and pauses", async () => {
      const { editor } = await setup();
      editor.seekToEnd();
      editor.togglePlayback();
      expect(editor.frame).toBe(0);
      editor.togglePlayback();
      editor.tick(5000);
      expect(editor.frame).toBe(0);
    });

    it("goes on when the timeline is not on screen", async () => {
      const { editor } = await setup();
      editor.togglePlayback();
      editor.setViewport(0, 0);
      expect(editor.getSnapshot().playing).toBe(true);
    });
  });

  describe("typing the end of the timeline", () => {
    it("moves it, and not in front of the last clip", async () => {
      const { editor, addClip } = await setup();
      addClip("a", 1, 2);
      editor.setEnd(600);
      expect(editor.model?.duration).toBe(20);
      editor.setEnd(30);
      expect(editor.model?.duration).toBe(3);
    });
  });

  it("keeps the width of the track headers within limits, and remembers it", async () => {
    const { editor, saved } = await setup();
    editor.setHeaderWidth(9999);
    expect(editor.getSnapshot().headerWidth).toBe(360);
    editor.setHeaderWidth(10);
    expect(editor.getSnapshot().headerWidth).toBe(96);
    editor.setHeaderWidth(200);
    editor.saveHeaderWidth();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.get("timeline")).toMatchObject({ headerWidth: 200 });
  });

  describe("how people like to work", () => {
    it("does not overwrite until told to, and remembers", async () => {
      const { editor, saved } = await setup();
      expect(editor.getSnapshot().overwriting).toBe(false);
      editor.toggleOverwriting();
      await vi.advanceTimersByTimeAsync(0);
      expect(saved.get("timeline")).toMatchObject({ overwriting: true, snapping: true });
    });

    it("comes back with what was saved, and ignores what it cannot read", async () => {
      const { editor, settings, saveInOtherWindow } = await setup();
      await settings.save("timeline", { version: 1, snapping: false, overwriting: true });
      await editor.load();
      expect(editor.getSnapshot()).toMatchObject({ snapping: false, overwriting: true });
      saveInOtherWindow({ version: 9 });
      expect(editor.getSnapshot().overwriting).toBe(true);
      saveInOtherWindow({ version: 1, snapping: true, overwriting: false });
      expect(editor.getSnapshot().overwriting).toBe(false);
    });
  });

  describe("the frame rate", () => {
    it("is the one of the project, not of a format", async () => {
      const { editor, store } = await setup();
      store.execute({ type: "project.setFrameRate", params: { fps: "24" } });
      expect(editor.model?.rate.fps).toBe(24);
      expect(store.getState().manifest.formats[0]?.fps).toBe("30");
    });

    it("keeps the playhead at the same moment when it changes", async () => {
      const { editor, store } = await setup();
      editor.seek(60);
      store.execute({ type: "project.setFrameRate", params: { fps: "24" } });
      expect(editor.frame).toBe(48);
    });

    it("leaves clips where they are, and new ones land on its frames", async () => {
      const { editor, addClip, at, clip, drag, store } = await setup();
      editor.toggleSnapping();
      addClip("a", 1, 2);
      store.execute({ type: "project.setFrameRate", params: { fps: "24" } });
      expect(clip("a").start).toBe("1");
      drag(at(2), at(3.02));
      expect(clip("a").start).toBe("2");
    });
  });

  describe("the height of rows", () => {
    it("grows and shrinks within limits", async () => {
      const { editor } = await setup();
      const before = editor.model?.rows[0]?.height as number;
      editor.rowsTaller();
      expect(editor.model?.rows[0]?.height).toBeGreaterThan(before);
      editor.zoomRowsAround(100, 100);
      expect(editor.rowScale).toBe(3);
      editor.zoomRowsAround(100, 0.001);
      expect(editor.rowScale).toBe(0.6);
    });

    it("keeps the row under the mouse in place", async () => {
      const { editor, store, audio } = await setup();
      for (let index = 0; index < 12; index++) {
        store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } });
      }
      editor.setScroll(0, 200);
      const row = () => editor.model?.rows.find(({ id }) => id === audio);
      const y = 300;
      const share = () => editor.laneAt(y) / (editor.model?.height as number);
      const before = share();
      editor.zoomRowsAround(y, 1.5);
      expect(share()).toBeCloseTo(before, 1);
      expect(row()).toBeDefined();
    });

    it("waits while a clip is being dragged", async () => {
      const { editor, addClip, at } = await setup();
      addClip("a", 1, 1);
      editor.press(at(1.5));
      editor.zoomRowsAround(100, 2);
      expect(editor.rowScale).toBe(1);
      editor.cancelDrag();
    });

    it("comes back after a reload", async () => {
      const memory = memoryWindow();
      const { editor, session, store } = await setup(memory);
      const id = store.getState().manifest.id;
      editor.rowsTaller();
      const scale = editor.rowScale;
      await session.close();
      await session.open(id);
      expect(editor.rowScale).toBe(scale);
    });

    it("tells when something snapped to the playhead", async () => {
      const { editor, addClip, at } = await setup();
      addClip("a", 1, 1);
      editor.seek(150);
      expect(editor.isSnappedToPlayhead).toBe(false);
      editor.press(at(1.5));
      editor.drag(at(5.53));
      expect(editor.preview?.snap).toBe(5);
      expect(editor.isSnappedToPlayhead).toBe(true);
      editor.cancelDrag();
    });
  });

  describe("the order of tracks", () => {
    const withTracks = async () => {
      const context = await setup();
      for (const id of ["v2", "v3"]) {
        context.store.execute({
          type: "track.add",
          params: { timeline: "main", id, kind: "video" },
        });
      }
      context.store.execute({
        type: "track.add",
        params: { timeline: "main", id: "a2", kind: "audio" },
      });
      const order = () => context.editor.model?.rows.map(({ id }) => id) ?? [];
      return { ...context, order };
    };

    it("changes by dragging, top to bottom as people see it", async () => {
      const { editor, order, video, store } = await withTracks();
      expect(order().slice(0, 3)).toEqual(["v3", "v2", video]);
      editor.moveTrack("v3", 2);
      expect(order().slice(0, 3)).toEqual(["v2", video, "v3"]);
      editor.moveTrack("v3", 0);
      expect(order().slice(0, 3)).toEqual(["v3", "v2", video]);
      editor.moveTrack(video, 1);
      expect(order().slice(0, 3)).toEqual(["v3", video, "v2"]);
      store.undo();
      expect(order().slice(0, 3)).toEqual(["v3", "v2", video]);
    });

    it("works for tracks that count downwards too", async () => {
      const { editor, order, audio } = await withTracks();
      expect(order().slice(3)).toEqual([audio, "a2"]);
      editor.moveTrack(audio, 1);
      expect(order().slice(3)).toEqual(["a2", audio]);
      editor.moveTrack(audio, 0);
      expect(order().slice(3)).toEqual([audio, "a2"]);
    });

    it("says where a dragged track would land", async () => {
      const { editor } = await withTracks();
      expect(editor.trackDrop("v3", 0).index).toBe(0);
      const rows = editor.model?.rows ?? [];
      const bottom = (rows[2]?.top ?? 0) + 40;
      expect(editor.trackDrop("v3", bottom).index).toBe(2);
      expect(editor.trackDrop("v3", 1000).index).toBe(2);
    });

    it("stays among tracks of its kind", async () => {
      const { editor, order, audio } = await withTracks();
      const before = order();
      editor.moveTrack(audio, 5);
      expect(order().filter((id) => id === audio || id === "a2")).toEqual(["a2", audio]);
      expect(order().slice(0, 3)).toEqual(before.slice(0, 3));
    });

    it("moves one place from the menu, and stops at the ends", async () => {
      const { editor, order, video } = await withTracks();
      editor.shiftTrack("v2", -1);
      expect(order().slice(0, 3)).toEqual(["v2", "v3", video]);
      editor.shiftTrack("v2", -1);
      expect(order().slice(0, 3)).toEqual(["v2", "v3", video]);
      editor.shiftTrack("v3", 1);
      expect(order().slice(0, 3)).toEqual(["v2", video, "v3"]);
    });

    it("writes nothing when a track stays where it is", async () => {
      const { editor, store } = await withTracks();
      const revision = store.revision;
      editor.moveTrack("v2", 1);
      expect(store.revision).toBe(revision);
    });
  });

  it("adds, changes and removes tracks", async () => {
    const { editor, main } = await setup();
    const before = Object.keys(main().tracks);
    editor.addTrack("caption");
    const added = Object.keys(main().tracks).find((id) => !before.includes(id)) as string;
    expect(main().tracks[added]?.kind).toBe("caption");
    expect(editor.model?.rows[0]?.id).toBe(added);
    editor.updateTrack(added, { name: "字幕" });
    expect(main().tracks[added]?.name).toBe("字幕");
    editor.removeTrack(added);
    expect(main().tracks[added]).toBeUndefined();
  });

  it("says so when a command fails", async () => {
    const { editor, addClip, video, commandFailed, store } = await setup();
    addClip("a", 1, 1);
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
    editor.removeTrack(video);
    expect(commandFailed).toHaveBeenCalledOnce();
  });
});

describe("what a window remembers", () => {
  const remembered = (memory: ReturnType<typeof memoryWindow>, id: string) =>
    JSON.parse(memory.read(`timeline.${id}`) ?? "{}") as { frame?: number };

  it("keeps the view a moment after it changes", async () => {
    const memory = memoryWindow();
    const { editor, store } = await setup(memory);
    editor.zoomAround(100, 3);
    editor.seek(45);
    await vi.advanceTimersByTimeAsync(1000);
    expect(remembered(memory, store.getState().manifest.id).frame).toBe(45);
  });

  it("does not wait when the page goes away", async () => {
    const memory = memoryWindow();
    const { editor, store } = await setup(memory);
    editor.seek(45);
    editor.flush();
    expect(remembered(memory, store.getState().manifest.id).frame).toBe(45);
  });

  it("opens with the view of that project", async () => {
    const memory = memoryWindow();
    const { editor, session, store } = await setup(memory);
    const id = store.getState().manifest.id;
    editor.zoomAround(100, 3);
    editor.seek(45);
    const zoom = editor.pixelsPerSecond;
    await session.close();
    await session.create("另一个");
    expect(editor.frame).toBe(0);
    await session.close();
    await session.open(id);
    expect(editor.frame).toBe(45);
    expect(editor.pixelsPerSecond).toBe(zoom);
  });

  it.each([
    ["no JSON", "{oops"],
    ["missing numbers", '{"frame":1}'],
    ["negative numbers", '{"pixelsPerSecond":-1,"scrollX":0,"scrollY":0,"frame":0}'],
  ])("ignores what it cannot use: %s", async (_, text) => {
    const memory = memoryWindow();
    const read = vi.spyOn(memory, "read").mockReturnValue(text);
    const { editor } = await setup(memory);
    expect(read).toHaveBeenCalled();
    expect(editor.pixelsPerSecond).toBeGreaterThan(0);
    expect(editor.frame).toBe(0);
  });
});

describe("without a project", () => {
  it("has nothing to show, and does not mind being asked", async () => {
    const { editor, session } = await setup();
    await session.close();
    expect(editor.model).toBeUndefined();
    editor.seek(10);
    editor.addColorClip();
    editor.deleteSelection();
    editor.splitAtPlayhead();
    editor.press({ x: 10, y: 10, shift: false, alt: false, mod: false });
    expect(editor.frame).toBe(0);
  });

  it("starts over with the next project", async () => {
    const { editor, session, addClip } = await setup();
    addClip("a", 1, 1);
    editor.selectAll();
    editor.seek(100);
    await session.close();
    await session.create("下一个");
    expect(editor.model?.boxes.size).toBe(0);
    expect(editor.getSnapshot().selection.size).toBe(0);
    expect(editor.frame).toBe(0);
  });
});

describe("telling the screen", () => {
  it("does not bother React with what only the canvas needs", async () => {
    const { editor } = await setup();
    const react = vi.fn<() => void>();
    const canvas = vi.fn<() => void>();
    editor.subscribe(react);
    editor.subscribeView(canvas);
    editor.setScroll(1, 0);
    editor.zoomAround(0, 2);
    editor.seek(10);
    expect(react).not.toHaveBeenCalled();
    expect(canvas).toHaveBeenCalledTimes(3);
  });

  it("keeps the snapshot while nothing it holds changes", async () => {
    const { editor } = await setup();
    const before = editor.getSnapshot();
    editor.setScroll(1, 0);
    editor.seek(10);
    expect(editor.getSnapshot()).toBe(before);
  });

  it("keeps the model when another part of the project changes", async () => {
    const { editor, store } = await setup();
    const before = editor.model;
    store.execute({ type: "project.rename", params: { name: "新名字" } });
    expect(editor.model).toBe(before);
  });
});

describe("effects from their tab", () => {
  /** a and b on the picture, a sound under them. */
  async function clips() {
    const context = await setup();
    const { addClip, video, audio } = context;
    addClip("a", 2, 3, video);
    addClip("b", 6, 3, video);
    addClip("s", 2, 3, audio);
    return context;
  }

  const listOf = (clip: ClipState | undefined) =>
    clip
      ? effectsOf(clip).map(({ type, enabled }) => (enabled === false ? `${type} off` : type))
      : [];

  it("go last on the clip they are dropped on, which lights up all of it, and not on sound", async () => {
    const { editor, at, main, audio } = await clips();
    expect(editor.showEffectDrop(at(2.5, audio))).toBe(false);
    expect(editor.preview).toBeUndefined();
    expect(editor.showEffectDrop(at(5.5))).toBe(false);
    expect(editor.showEffectDrop(at(3))).toBe(true);
    expect(editor.preview?.transitionDrop).toMatchObject({ start: 2, end: 5 });
    expect(editor.dropEffect(at(3), "blur")).toBe(true);
    expect(editor.dropEffect(at(4.9), "crop")).toBe(true);
    expect(editor.preview).toBeUndefined();
    expect(listOf(main().clips["a"])).toEqual(["blur", "crop"]);
    expect([...editor.getSnapshot().selection]).toEqual(["a"]);
  });

  it("go on every clip selected with a click, in one step, and say why where they cannot", async () => {
    const { editor, main, store } = await clips();
    expect(editor.effectProblem("blur")).toBe("nothing");
    editor.selectOnly("s");
    expect(editor.effectProblem("blur")).toBe("sound");
    editor.selectOnly("a");
    editor.addToSelection("b");
    editor.addToSelection("s");
    expect(editor.effectProblem("blur")).toBeUndefined();
    expect(editor.effectProblem("plugin.glow")).toBe("unknown");
    expect(editor.attachEffect("brightness")).toBe(2);
    expect(listOf(main().clips["a"])).toEqual(["brightness"]);
    expect(listOf(main().clips["b"])).toEqual(["brightness"]);
    store.undo();
    expect(listOf(main().clips["a"])).toEqual([]);
    expect(listOf(main().clips["b"])).toEqual([]);
  });

  it("go on once more with each click, and say where they went", async () => {
    const { editor, main, store } = await clips();
    vi.useFakeTimers();
    try {
      editor.selectOnly("a");
      editor.addToSelection("b");
      expect(editor.attachEffect("blur")).toBe(2);
      const first = editor.lastAdded;
      expect(editor.attachEffect("blur")).toBe(2);
      // The same effect again is one more, not nothing.
      expect(listOf(main().clips["a"])).toEqual(["blur", "blur"]);
      expect(listOf(main().clips["b"])).toEqual(["blur", "blur"]);
      // The list of each clip goes to the one that is new there.
      const added = editor.lastAdded;
      expect(added?.at).toBe((first?.at ?? 0) + 1);
      for (const clip of ["a", "b"]) {
        const ids = effectsOf(main().clips[clip] as ClipState).map(({ id }) => id);
        expect(added?.effects.get(clip)).toBe(ids[1]);
      }
      // The clips light up for a moment, and the light goes.
      expect(editor.flashOf("bands", "a")).toBe(1);
      expect(editor.flashOf("bands", "s")).toBe(0);
      vi.advanceTimersByTime(FLASH_MS / 2);
      expect(editor.flashOf("bands", "b")).toBeGreaterThan(0);
      expect(editor.flashOf("bands", "b")).toBeLessThan(1);
      vi.advanceTimersByTime(FLASH_MS);
      expect(editor.flashOf("bands", "b")).toBe(0);
      store.undo();
      expect(listOf(main().clips["a"])).toEqual(["blur"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("change when they work in one step, from the start of the clip, and the edges are its own", async () => {
    const { editor, main, store } = await clips();
    editor.selectOnly("a");
    editor.attachEffect("blur");
    const [blur] = effectsOf(main().clips["a"] as ClipState).map(({ id }) => id);
    const id = blur as string;
    const rangeOf = () => {
      const effect = effectsOf(main().clips["a"] as ClipState)[0];
      return [effect?.start, effect?.end];
    };
    expect(editor.setEffectRange("a", id, parseTime("0.5"), parseTime("2"))).toBe(true);
    expect(rangeOf()).toEqual(["0.5", "2"]);
    expect(editor.setEffectRange("a", id, parseTime("0.5"), parseTime("2"))).toBe(false);
    expect(editor.setEffectRange("a", id, undefined, parseTime("2"))).toBe(true);
    expect(rangeOf()).toEqual([undefined, "2"]);
    store.undo();
    store.undo();
    expect(rangeOf()).toEqual([undefined, undefined]);
  });

  it("move, turn off and go from the list of a clip, and not on a locked track", async () => {
    const { editor, main, store, video } = await clips();
    editor.selectOnly("a");
    editor.attachEffect("blur");
    editor.attachEffect("crop");
    const [blur, crop] = effectsOf(main().clips["a"] as ClipState).map(({ id }) => id);
    expect(editor.moveEffect("a", crop as string, 0)).toBe(true);
    expect(listOf(main().clips["a"])).toEqual(["crop", "blur"]);
    expect(editor.setEffectEnabled("a", blur as string, false)).toBe(true);
    expect(listOf(main().clips["a"])).toEqual(["crop", "blur off"]);
    store.execute({
      type: "track.update",
      params: { timeline: "main", track: video, changes: { locked: true } },
    });
    expect(editor.removeEffect("a", crop as string)).toBe(false);
    expect(editor.effectProblem("blur")).toBe("locked");
  });
});
