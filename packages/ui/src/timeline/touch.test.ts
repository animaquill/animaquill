import { orderedTracks } from "@animaquill/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { RULER_HEIGHT, TimelineEditor } from "./editor.ts";
import { TouchController } from "./touch.ts";

async function setup() {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("触屏");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async () => undefined,
    save: async () => {},
    listen: () => () => {},
  };
  const editor = new TimelineEditor(session, memoryWindow(), settings, {
    commandFailed: vi.fn(),
  });
  editor.setViewport(1000, 400);
  editor.setTouchInput(true);
  const main = () => store.getState().timelines["main"];
  const video = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id as string;
  for (let index = 0; index < 12; index++) {
    store.execute({ type: "track.add", params: { timeline: "main", kind: "audio" } });
  }
  store.execute({
    type: "clip.add",
    params: {
      timeline: "main",
      track: video,
      clip: { id: "a", start: "2", duration: "2", source: { kind: "color", color: "#112233" } },
    },
  });
  editor.zoomAround(0, 2);
  const openMenu = vi.fn();
  const frames: (() => void)[] = [];
  const touch = new TouchController(editor, {
    later(run, milliseconds) {
      const timer = setTimeout(run, milliseconds);
      return () => clearTimeout(timer);
    },
    nextFrame(run) {
      frames.push(run);
      return () => {};
    },
    now: () => Date.now(),
    openMenu,
    held: () => {},
  });
  const row = editor.model?.rows.find(({ id }) => id === video);
  const y = RULER_HEIGHT + (row?.top ?? 0) + 20;
  const onClip = () => editor.xAt(3);
  const clip = () => main()?.clips["a"];
  return { editor, touch, store, y, onClip, clip, openMenu, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const selection = (editor: TimelineEditor) => [...editor.getSnapshot().selection];

describe("one finger", () => {
  it("selects a clip with a tap", async () => {
    const { editor, touch, onClip, y } = await setup();
    touch.down(1, onClip(), y);
    touch.up(1);
    expect(selection(editor)).toEqual(["a"]);
  });

  it("clears the selection with a tap next to a clip", async () => {
    const { editor, touch, y } = await setup();
    editor.selectAll();
    touch.down(1, editor.xAt(8), y);
    touch.up(1);
    expect(selection(editor)).toEqual([]);
  });

  it("moves the view, also when it starts on a clip that is not selected", async () => {
    const { editor, touch, onClip, y, clip } = await setup();
    const x = onClip();
    const before = editor.scrollX;
    touch.down(1, x, y);
    touch.move(1, x - 100, y);
    touch.up(1);
    expect(editor.scrollX).toBeGreaterThan(before);
    expect(clip()?.start).toBe("2");
    expect(selection(editor)).toEqual([]);
  });

  describe("on a locked track", () => {
    const locked = async () => {
      const context = await setup();
      const { editor, store } = context;
      const track = store.getState().timelines["main"]?.clips["a"]?.track as string;
      editor.updateTrack(track, { locked: true });
      return context;
    };

    it("selects the clip with a tap", async () => {
      const { editor, touch, onClip, y } = await locked();
      touch.down(1, onClip(), y);
      touch.up(1);
      expect(selection(editor)).toEqual(["a"]);
    });

    it("selects the clip with a long press", async () => {
      const { editor, touch, onClip, y } = await locked();
      touch.down(1, onClip(), y);
      vi.advanceTimersByTime(1000);
      expect(selection(editor)).toEqual(["a"]);
      touch.up(1);
    });

    it("moves the view, and not the clip, also when it is selected", async () => {
      const { editor, touch, onClip, y, clip } = await locked();
      const x = onClip();
      touch.down(1, x, y);
      touch.up(1);
      const before = editor.scrollX;
      touch.down(1, x, y);
      touch.move(1, x - 100, y);
      touch.up(1);
      expect(editor.scrollX).toBeGreaterThan(before);
      expect(clip()?.start).toBe("2");
      expect(selection(editor)).toEqual(["a"]);
    });
  });

  it("stays on one axis during a swipe", async () => {
    const { editor, touch, y } = await setup();
    touch.down(1, 500, y);
    touch.move(1, 400, y);
    touch.move(1, 300, y - 80);
    expect(editor.scrollY).toBe(0);
    touch.up(1);
  });

  it("goes up and down through the tracks", async () => {
    const { editor, touch } = await setup();
    touch.down(1, 500, 300);
    touch.move(1, 500, 200);
    touch.up(1);
    expect(editor.scrollY).toBe(100);
  });

  it("lets a swipe glide on, and a new touch stops it", async () => {
    const { editor, touch, y, frames } = await setup();
    touch.down(1, 500, y);
    vi.advanceTimersByTime(16);
    touch.move(1, 460, y);
    vi.advanceTimersByTime(16);
    touch.move(1, 420, y);
    touch.up(1);
    const after = editor.scrollX;
    frames.shift()?.();
    expect(editor.scrollX).toBeGreaterThan(after);
  });

  it("draws a box after a long press on an empty place", async () => {
    const { editor, touch, y } = await setup();
    const from = editor.xAt(1);
    touch.down(1, from, y);
    vi.advanceTimersByTime(500);
    touch.move(1, editor.xAt(3), y + 10);
    touch.move(1, editor.xAt(3.5), y + 12);
    touch.up(1);
    expect(selection(editor)).toEqual(["a"]);
  });

  it("adds and takes away with taps when multiple selection is on", async () => {
    const { editor, touch, onClip, y } = await setup();
    editor.toggleMultiSelecting();
    touch.down(1, onClip(), y);
    touch.up(1);
    expect(selection(editor)).toEqual(["a"]);
    touch.down(1, onClip(), y);
    touch.up(1);
    expect(selection(editor)).toEqual([]);
  });

  it("moves a clip that is selected, right away", async () => {
    const { editor, touch, onClip, y, clip } = await setup();
    editor.selectOnly("a");
    const x = onClip();
    touch.down(1, x, y);
    touch.move(1, x + 100, y);
    touch.move(1, x + 200, y);
    touch.up(1);
    expect(clip()?.start).not.toBe("2");
  });

  it("reaches further for the edge of a selected clip, and trims it", async () => {
    const { editor, touch, y, clip } = await setup();
    editor.selectOnly("a");
    const x = editor.xAt(4) - 12;
    touch.down(1, x, y);
    touch.move(1, x - 100, y);
    touch.up(1);
    expect(clip()?.start).toBe("2");
    expect(clip()?.duration).not.toBe("2");
  });

  it("scrubs on the ruler", async () => {
    const { editor, touch } = await setup();
    touch.down(1, 300, 10);
    touch.move(1, 400, 10);
    touch.up(1);
    expect(editor.frame).toBe(Math.round(editor.timeAt(400) * 30));
  });

  it("cuts with a tap when the razor is out", async () => {
    const { editor, touch, onClip, y, store } = await setup();
    editor.setTool("razor");
    touch.down(1, onClip(), y);
    touch.up(1);
    expect(Object.keys(store.getState().timelines["main"]?.clips ?? {})).toHaveLength(2);
  });
});

describe("a long press", () => {
  it("picks up a clip that is not selected", async () => {
    const { editor, touch, onClip, y, clip } = await setup();
    const x = onClip();
    touch.down(1, x, y);
    vi.advanceTimersByTime(500);
    expect(selection(editor)).toEqual(["a"]);
    touch.move(1, x + 100, y);
    touch.move(1, x + 200, y);
    touch.up(1);
    expect(clip()?.start).not.toBe("2");
  });

  it("moves a clip that is selected as well", async () => {
    const { editor, touch, onClip, y, clip, openMenu } = await setup();
    editor.selectOnly("a");
    const x = onClip();
    touch.down(1, x, y);
    vi.advanceTimersByTime(500);
    touch.move(1, x + 100, y);
    touch.move(1, x + 200, y);
    touch.up(1);
    expect(clip()?.start).not.toBe("2");
    expect(openMenu).not.toHaveBeenCalled();
  });

  it("opens the menu of a selected clip when the finger stays", async () => {
    const { editor, touch, onClip, y, openMenu } = await setup();
    editor.selectOnly("a");
    touch.down(1, onClip(), y);
    vi.advanceTimersByTime(500);
    expect(openMenu).not.toHaveBeenCalled();
    touch.up(1);
    expect(openMenu).toHaveBeenCalledOnce();
  });

  it("opens the menu of the clip when the finger stays", async () => {
    const { touch, onClip, y, openMenu, clip } = await setup();
    touch.down(1, onClip(), y);
    vi.advanceTimersByTime(500);
    touch.up(1);
    expect(openMenu).toHaveBeenCalledOnce();
    expect(clip()?.start).toBe("2");
  });

  it("opens a menu next to clips", async () => {
    const { editor, touch, y, openMenu } = await setup();
    editor.selectOnly("a");
    touch.down(1, editor.xAt(8), y);
    vi.advanceTimersByTime(500);
    touch.up(1);
    expect(openMenu).toHaveBeenCalledOnce();
    expect(selection(editor)).toEqual(["a"]);
  });

  it("does not happen once the finger moved", async () => {
    const { touch, onClip, y, openMenu } = await setup();
    const x = onClip();
    touch.down(1, x, y);
    touch.move(1, x + 50, y);
    vi.advanceTimersByTime(500);
    touch.up(1);
    expect(openMenu).not.toHaveBeenCalled();
  });
});

describe("two fingers", () => {
  it("zoom along the timeline when they spread sideways", async () => {
    const { editor, touch } = await setup();
    const zoom = editor.pixelsPerSecond;
    touch.down(1, 400, 200);
    touch.down(2, 500, 200);
    touch.move(2, 600, 200);
    touch.up(1);
    touch.up(2);
    expect(editor.pixelsPerSecond).toBeGreaterThan(zoom * 1.5);
  });

  it("change the height of tracks when they spread up and down", async () => {
    const { editor, touch } = await setup();
    const zoom = editor.pixelsPerSecond;
    touch.down(1, 400, 150);
    touch.down(2, 400, 200);
    touch.move(2, 400, 250);
    touch.up(1);
    touch.up(2);
    expect(editor.rowScale).toBeGreaterThan(1.5);
    expect(editor.pixelsPerSecond).toBe(zoom);
  });

  it("take over from a finger that had not started anything", async () => {
    const { editor, touch, onClip, y, openMenu } = await setup();
    touch.down(1, onClip(), y);
    touch.down(2, onClip() + 100, y);
    vi.advanceTimersByTime(500);
    touch.up(1);
    touch.up(2);
    expect(openMenu).not.toHaveBeenCalled();
    expect(selection(editor)).toEqual([]);
  });

  it("leave a clip that is on the move alone", async () => {
    const { editor, touch, onClip, y, clip } = await setup();
    editor.selectOnly("a");
    const x = onClip();
    touch.down(1, x, y);
    touch.move(1, x + 200, y);
    touch.down(2, 100, 300);
    touch.up(2);
    touch.up(1);
    expect(clip()?.start).not.toBe("2");
  });

  it("do not count as a tap when they leave one by one", async () => {
    const { editor, touch, onClip, y } = await setup();
    touch.down(1, onClip(), y);
    touch.down(2, onClip() + 80, y);
    touch.up(2);
    touch.up(1);
    expect(selection(editor)).toEqual([]);
  });
});

it("gives up when the browser takes the touch away", async () => {
  const { editor, touch, onClip, y, clip } = await setup();
  editor.selectOnly("a");
  const x = onClip();
  touch.down(1, x, y);
  touch.move(1, x + 200, y);
  touch.cancel(1);
  expect(editor.isDragging).toBe(false);
  expect(clip()?.start).toBe("2");
});
