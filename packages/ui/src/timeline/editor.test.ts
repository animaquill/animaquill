import { ProjectStore, clipEnd, orderedTracks, type ClipState } from "@animaquill/core";
import { formatTime } from "@animaquill/schema";
import type { SettingsStore } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { RULER_HEIGHT, TimelineEditor } from "./editor.ts";
import type { Pointer } from "./gestures.ts";

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
  const editor = new TimelineEditor(session, memory, settings, { commandFailed });
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

  it("fits again on request", async () => {
    const { editor } = await setup();
    editor.zoomAround(500, 8);
    editor.zoomToFit();
    expect(editor.xAt(10)).toBeLessThanOrEqual(WIDTH);
    expect(editor.scrollX).toBe(0);
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
    const { editor, addClip, at, store, video, commandFailed } = await setup();
    addClip("a", 2, 2);
    editor.press(at(3));
    editor.drag(at(6));
    store.execute({
      type: "track.update",
      params: { timeline: "main", track: video, changes: { locked: true } },
    });
    editor.release(at(6));
    expect(commandFailed).toHaveBeenCalledOnce();
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

  it("has nothing to delete without a selection", async () => {
    const { editor, addClip, store } = await setup();
    addClip("a", 1, 1);
    const revision = store.revision;
    editor.deleteSelection();
    expect(store.revision).toBe(revision);
  });

  it("cuts everything at the playhead when nothing there is selected", async () => {
    const { editor, addClip, main, audio } = await setup();
    addClip("a", 0, 4);
    addClip("b", 0, 4, audio);
    editor.seek(60);
    editor.splitAtPlayhead();
    expect(Object.keys(main().clips)).toHaveLength(4);
  });

  it("cuts only what is selected when something at the playhead is", async () => {
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
      expect(editor.frame).toBe(240);
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

    it("cuts, and undo takes each step back", async () => {
      const { editor, addClip, main, store } = await setup();
      addClip("a", 1, 1);
      editor.selectAll();
      editor.cutSelection();
      expect(Object.keys(main().clips)).toEqual([]);
      expect(editor.hasClipboard).toBe(true);
      editor.paste();
      expect(Object.keys(main().clips)).toHaveLength(1);
      store.undo();
      expect(Object.keys(main().clips)).toEqual([]);
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
    it("cannot be selected in any way", async () => {
      const { editor, addClip, at, drag, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      drag(at(0.5), at(5, audio));
      expect(selection()).toEqual(["b"]);
      editor.selectAll();
      expect(selection()).toEqual(["b"]);
      editor.clearSelection();
      editor.press(at(2));
      editor.release(at(2));
      expect(selection()).toEqual([]);
    });

    it("drop out of the selection when they get locked", async () => {
      const { editor, addClip, selection, video } = await setup();
      addClip("a", 1, 2);
      editor.selectAll();
      editor.updateTrack(video, { locked: true });
      expect(selection()).toEqual([]);
    });

    it("start a box when pressed on", async () => {
      const { editor, addClip, at, drag, selection, video, audio } = await setup();
      addClip("a", 1, 2);
      addClip("b", 1, 2, audio);
      editor.updateTrack(video, { locked: true });
      drag(at(2), at(2.5, audio));
      expect(selection()).toEqual(["b"]);
    });
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
    const { editor, addClip, video, commandFailed } = await setup();
    addClip("a", 1, 1);
    editor.updateTrack(video, { locked: true });
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
