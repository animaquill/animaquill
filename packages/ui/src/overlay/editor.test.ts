import {
  describeClip,
  orderedTracks,
  sceneSourceOf,
  type PropertyEdit,
  type Registration,
} from "@animaquill/core";
import type { Animation } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import type { QualitySnapshot } from "../preview/quality.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { OverlayEditor, ROTATE_REACH, type Grip } from "./editor.ts";
import type { OverlayPointer } from "./gestures.ts";
import { SceneHandles } from "./scene-handles.ts";

interface Size {
  readonly width: number;
  readonly height: number;
}

const HD = { width: 1920, height: 1080 };

async function setup({
  trying = false,
  viewport = { width: 960, height: 540 } as Size,
  shown = HD as Size,
} = {}) {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("手柄");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: trying } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const commandFailed = vi.fn<(message: string) => void>();
  const timeline = new TimelineEditor(session, memoryWindow(), settings, { commandFailed });
  await timeline.load();
  timeline.setViewport(1000, 400);
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
  const writer = new PropertyWriter(session, timeline, trials, {
    commandFailed,
    comparing: vi.fn(),
  });
  let quality: QualitySnapshot = { choice: "full", scale: 1, size: { shown, full: HD } };
  const qualityListeners = new Set<() => void>();
  const sizes = {
    getSnapshot: () => quality,
    subscribe: (listener: () => void) => {
      qualityListeners.add(listener);
      return () => qualityListeners.delete(listener);
    },
  };
  const setShown = (size: Size) => {
    quality = { ...quality, size: { shown: size, full: HD } };
    for (const listener of qualityListeners) listener();
  };
  const handles = new SceneHandles();
  let registration: Registration | undefined;
  const registrations = {
    registrationOf: () => registration,
    subscribe: () => () => {},
    getVersion: () => 0,
  };
  const overlay = new OverlayEditor({
    session,
    timeline,
    properties: writer,
    trials,
    quality: sizes,
    handles,
    registrations,
    describe: (clip) => describeClip(store.getState(), clip, registrations),
  });
  overlay.setViewport(viewport.width, viewport.height);

  const main = () => {
    const found = store.getState().timelines["main"];
    if (!found) throw new Error("no timeline");
    return found;
  };
  const video = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(result.error.message);
    return result;
  };
  const addClip = (
    id: string,
    extra: object = {},
    source: object = { kind: "color", color: "#112233" },
  ) => {
    const clip = { id, start: "0", duration: "4", source, ...extra };
    run("clip.add", { timeline: "main", track: video, clip });
    timeline.selectOnly(id);
  };
  const edit = (...edits: PropertyEdit[]) => run("property.edit", { timeline: "main", edits });
  const set = (clip: string, values: Readonly<Record<string, number>>) =>
    edit(
      ...Object.entries(values).map(([path, value]): PropertyEdit => ({
        owner: { clip },
        path,
        op: "set",
        value,
      })),
    );
  const property = (clip: string, path: string) => main().clips[clip]?.properties?.[path];
  const grips = () => overlay.getSnapshot().scene.grips;
  const grip = (id: string): Grip => {
    const found = grips().find((one) => one.id === id);
    if (!found)
      throw new Error(
        `no ${id} in ${grips()
          .map((one) => one.id)
          .join(", ")}`,
      );
    return found;
  };
  const pointer = (x: number, y: number, extra: Partial<OverlayPointer> = {}): OverlayPointer => ({
    x,
    y,
    shift: false,
    alt: false,
    ...extra,
  });
  const drag = (from: OverlayPointer, ...to: OverlayPointer[]) => {
    overlay.press(from);
    for (const place of to) overlay.drag(place);
    overlay.release(to.at(-1) ?? from);
  };
  const setRegistration = (next: Registration | undefined) => {
    registration = next;
  };
  return {
    session,
    store,
    timeline,
    trials,
    writer,
    overlay,
    handles,
    main,
    video,
    run,
    addClip,
    edit,
    set,
    property,
    grips,
    grip,
    pointer,
    drag,
    setShown,
    setRegistration,
  };
}

const expectAt = (found: { readonly x: number; readonly y: number }, x: number, y: number) => {
  expect(found.x).toBeCloseTo(x, 6);
  expect(found.y).toBeCloseTo(y, 6);
};

describe("where the handles are", () => {
  it("are where the compositor draws the clip, whatever the quality", async () => {
    const { addClip, grip, setShown } = await setup();
    addClip("c");
    expectAt(grip("c scale nw").at, 0, 0);
    expectAt(grip("c scale se").at, 960, 540);
    expectAt(grip("c anchor").at, 480, 270);
    for (const shown of [
      { width: 960, height: 540 },
      { width: 480, height: 270 },
    ]) {
      setShown(shown);
      expectAt(grip("c scale nw").at, 0, 0);
      expectAt(grip("c scale e").at, 960, 270);
      expectAt(grip("c anchor").at, 480, 270);
    }
  });

  it("keep to the middle of a frame that has more room than the full resolution", async () => {
    const { addClip, grip } = await setup({ viewport: { width: 2400, height: 1400 } });
    addClip("c");
    expectAt(grip("c scale nw").at, 240, 160);
    expectAt(grip("c scale se").at, 2160, 1240);
  });

  it("keep to a frame of another shape than the picture", async () => {
    const { addClip, grip } = await setup({ viewport: { width: 800, height: 900 } });
    addClip("c");
    expectAt(grip("c scale nw").at, 0, 225);
    expectAt(grip("c scale se").at, 800, 675);
  });

  it("turn, scale and move with the clip, around its anchor", async () => {
    const { addClip, set, grip } = await setup();
    addClip("c");
    set("c", { "transform.rotation": 90, "transform.scale": 0.5, "transform.x": 100 });
    // The top left corner: half as far from the anchor, turned clockwise, and moved.
    expectAt(grip("c scale nw").at, 665, 30);
    expectAt(grip("c anchor").at, 530, 270);
    set("c", { "transform.anchorX": 0, "transform.anchorY": 0 });
    expectAt(grip("c scale nw").at, 530, 270);
    expectAt(grip("c anchor").at, 530, 270);
  });

  it("put the rotate handle above the box, or inside it where there is no room", async () => {
    const { addClip, set, grip } = await setup();
    addClip("c");
    expectAt(grip("c rotate").at, 480, ROTATE_REACH);
    set("c", { "transform.scale": 0.5 });
    expectAt(grip("c rotate").at, 480, 135 - ROTATE_REACH);
  });

  it("are not there while it plays, outside the clip, or with more than one clip selected", async () => {
    const { addClip, overlay, timeline, grips } = await setup();
    addClip("c");
    expect(grips().length).toBeGreaterThan(0);
    timeline.togglePlayback();
    expect(overlay.getSnapshot().scene.grips).toEqual([]);
    timeline.pause();
    timeline.seek(Math.round(5 * (timeline.model?.rate.fps ?? 30)));
    expect(grips()).toEqual([]);
    timeline.seek(0);
    addClip("later", { start: "5" });
    timeline.selectAll();
    expect(grips()).toEqual([]);
  });

  it("only show the box of a locked clip, and change nothing", async () => {
    const { addClip, run, video, overlay, grips, drag, pointer, property } = await setup();
    addClip("c");
    run("track.update", { timeline: "main", track: video, changes: { locked: true } });
    expect(grips()).toEqual([]);
    expect(overlay.getSnapshot().scene.marks).toContainEqual(
      expect.objectContaining({ kind: "outline", style: "locked" }),
    );
    drag(pointer(700, 400), pointer(800, 450));
    expect(property("c", "transform.x")).toBeUndefined();
  });
});

describe("dragging", () => {
  it("the box moves the clip, and only shows that until letting go", async () => {
    const { addClip, overlay, writer, property, pointer, store } = await setup();
    addClip("c");
    overlay.press(pointer(700, 400));
    overlay.drag(pointer(730, 410));
    overlay.drag(pointer(750, 420));
    expect(property("c", "transform.x")).toBeUndefined();
    expect(writer.getPreviewed().get("c")?.get("transform.x")).toBe(100);
    overlay.release(pointer(750, 420));
    expect(property("c", "transform.x")).toBe(100);
    expect(property("c", "transform.y")).toBe(40);
    expect(writer.getPreviewed().size).toBe(0);
    store.undo();
    expect(property("c", "transform.x")).toBeUndefined();
    expect(property("c", "transform.y")).toBeUndefined();
  });

  it("with Shift keeps to the direction it went further in", async () => {
    const { addClip, drag, pointer, property } = await setup();
    addClip("c");
    drag(pointer(700, 400), pointer(750, 420, { shift: true }));
    expect(property("c", "transform.x")).toBe(100);
    expect(property("c", "transform.y")).toBe(0);
  });

  it("writes nothing for a click, or for a drag that ends where it started", async () => {
    const { addClip, drag, pointer, property, store } = await setup();
    addClip("c");
    drag(pointer(700, 400), pointer(702, 401));
    drag(pointer(700, 400), pointer(760, 400), pointer(700, 400));
    expect(property("c", "transform.x")).toBeUndefined();
    store.undo();
    expect(store.getState().timelines["main"]?.clips["c"]).toBeUndefined();
  });

  it("Escape takes it all back", async () => {
    const { addClip, overlay, writer, pointer, property } = await setup();
    addClip("c");
    overlay.press(pointer(700, 400));
    overlay.drag(pointer(760, 400));
    expect(writer.getPreviewed().size).toBe(1);
    overlay.cancel();
    expect(writer.getPreviewed().size).toBe(0);
    overlay.release(pointer(760, 400));
    expect(property("c", "transform.x")).toBeUndefined();
  });

  it("stops when the playhead moves away under it", async () => {
    const { addClip, overlay, writer, pointer, property, timeline } = await setup();
    addClip("c");
    overlay.press(pointer(700, 400));
    overlay.drag(pointer(760, 400));
    timeline.seek(10);
    expect(writer.getPreviewed().size).toBe(0);
    overlay.release(pointer(760, 400));
    expect(property("c", "transform.x")).toBeUndefined();
  });

  it("goes into what is being tried, as one step", async () => {
    const { addClip, drag, pointer, property, trials, writer } = await setup({ trying: true });
    addClip("c");
    drag(pointer(700, 400), pointer(720, 400), pointer(750, 400));
    expect(property("c", "transform.x")).toBeUndefined();
    expect(trials.getSnapshot().count).toBe(2);
    expect(writer.getPreviewed().get("c")?.get("transform.x")).toBe(100);
    trials.undo();
    expect(writer.getPreviewed().size).toBe(0);
  });

  it("a scale handle scales around the anchor", async () => {
    const { addClip, drag, pointer, property, grip } = await setup();
    addClip("c");
    drag(pointer(960, 270), pointer(720, 270));
    expect(property("c", "transform.scale")).toBe(0.5);
    // A corner goes by how far along its diagonal the pointer got, wherever it is beside it.
    const corner = grip("c scale se").at;
    expectAt(corner, 720, 405);
    drag(pointer(corner.x, corner.y), pointer(573, 385.5));
    expect(property("c", "transform.scale")).toBeCloseTo(0.25, 6);
  });

  it("the rotate handle turns around the anchor, and by steps with Shift", async () => {
    const { addClip, drag, pointer, property } = await setup();
    addClip("c");
    const reach = 270 - ROTATE_REACH;
    drag(
      pointer(480, ROTATE_REACH),
      pointer(480 + reach * Math.SQRT1_2, 270 - reach * Math.SQRT1_2),
      pointer(480 + reach, 270),
    );
    expect(property("c", "transform.rotation")).toBeCloseTo(90, 6);
  });

  it("goes round more than once", async () => {
    const { addClip, overlay, pointer, property } = await setup();
    addClip("c");
    const reach = 270 - ROTATE_REACH;
    overlay.press(pointer(480, ROTATE_REACH));
    for (let step = 1; step <= 12; step += 1) {
      const angle = -Math.PI / 2 + (step * Math.PI) / 3;
      overlay.drag(pointer(480 + reach * Math.cos(angle), 270 + reach * Math.sin(angle)));
    }
    overlay.release(pointer(480, ROTATE_REACH));
    expect(property("c", "transform.rotation")).toBeCloseTo(720, 6);
  });

  it("with Shift turns in steps of 15 degrees", async () => {
    const { addClip, drag, pointer, property } = await setup();
    addClip("c");
    const reach = 270 - ROTATE_REACH;
    const angle = -Math.PI / 2 + (50 * Math.PI) / 180;
    drag(
      pointer(480, ROTATE_REACH),
      pointer(480 + reach * Math.cos(angle), 270 + reach * Math.sin(angle), { shift: true }),
    );
    expect(property("c", "transform.rotation")).toBe(45);
  });
});

describe("the anchor", () => {
  it("moves without moving the picture: the position goes along", async () => {
    const { addClip, set, drag, pointer, property, grip } = await setup();
    addClip("c");
    set("c", { "transform.scale": 0.5, "transform.rotation": 30 });
    const corners = ["nw", "ne", "se", "sw"].map((side) => grip(`c scale ${side}`).at);
    drag(pointer(480, 270), pointer(530, 250, { alt: true }));
    expect(property("c", "transform.anchorX")).not.toBe(0.5);
    // As close as the six digits that get written of a share of the box.
    ["nw", "ne", "se", "sw"].forEach((side, index) => {
      const before = corners[index] as { x: number; y: number };
      const after = grip(`c scale ${side}`).at;
      expect(after.x).toBeCloseTo(before.x, 2);
      expect(after.y).toBeCloseTo(before.y, 2);
    });
    expectAt(grip("c anchor").at, 530, 250);
    expect(property("c", "transform.x")).toBeCloseTo(100, 6);
    expect(property("c", "transform.y")).toBeCloseTo(-40, 6);
  });

  it("stops at corners, middles of sides and the middle, unless Alt says not to", async () => {
    const { addClip, set, drag, pointer, property } = await setup();
    addClip("c");
    set("c", { "transform.scale": 0.5 });
    drag(pointer(480, 270), pointer(243, 138));
    expect(property("c", "transform.anchorX")).toBe(0);
    expect(property("c", "transform.anchorY")).toBe(0);
    expect(property("c", "transform.x")).toBe(-480);
    expect(property("c", "transform.y")).toBe(-270);
    drag(pointer(240, 135), pointer(475, 266, { alt: true }));
    expect(property("c", "transform.anchorX")).not.toBe(0.5);
  });

  it("moves every key of a position without keys on the anchor, so the path goes along", async () => {
    const { addClip, edit, drag, pointer, property } = await setup();
    addClip("c");
    edit(
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "0", value: 0 },
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "2", value: 100 },
    );
    drag(pointer(480, 270), pointer(380, 270, { alt: true }));
    const keys = (property("c", "transform.x") as Animation).keys;
    expect(keys.map(({ time, value }) => [time, value])).toEqual([
      ["0", -200],
      ["2", -100],
    ]);
    expect(property("c", "transform.anchorX")).toBeCloseTo(0.5 - 200 / 1920, 6);
  });

  it("writes keys at the playhead where the anchor has keys of its own", async () => {
    const { addClip, edit, drag, pointer, property, timeline } = await setup();
    addClip("c");
    edit(
      { owner: { clip: "c" }, path: "transform.anchorX", op: "setKey", time: "0", value: 0.5 },
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "0", value: 0 },
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "2", value: 100 },
    );
    timeline.seek(30);
    // At 1 second x is 50, which is 25 pixels to the right.
    drag(pointer(505, 270), pointer(405, 270, { alt: true }));
    const anchor = (property("c", "transform.anchorX") as Animation).keys;
    expect(anchor.map(({ time }) => time)).toEqual(["0", "1"]);
    const x = (property("c", "transform.x") as Animation).keys;
    expect(x.map(({ time, value }) => [time, value])).toEqual([
      ["0", 0],
      ["1", -150],
      ["2", 100],
    ]);
  });
});

describe("the path of the position", () => {
  it("shows where keys take the anchor, and a key goes where it is dragged", async () => {
    const { addClip, edit, drag, pointer, property, grip, grips, overlay } = await setup();
    addClip("c");
    edit(
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "0", value: -400 },
      { owner: { clip: "c" }, path: "transform.x", op: "setKey", time: "2", value: 400 },
    );
    expect(overlay.getSnapshot().scene.marks).toContainEqual(
      expect.objectContaining({ kind: "path" }),
    );
    expect(grips().filter(({ role }) => role === "key")).toHaveLength(2);
    const last = grip("c key 2").at;
    expectAt(last, 680, 270);
    // Y has no keys, and writing it would move all of the path.
    drag(pointer(last.x, last.y), pointer(last.x - 50, last.y + 30));
    const keys = (property("c", "transform.x") as Animation).keys;
    expect(keys.map(({ value }) => value)).toEqual([-400, 300]);
    expect(property("c", "transform.y")).toBeUndefined();
  });

  it("is not there without keys on the position", async () => {
    const { addClip, set, overlay } = await setup();
    addClip("c");
    set("c", { "transform.x": 10 });
    expect(overlay.getSnapshot().scene.marks.some(({ kind }) => kind === "path")).toBe(false);
  });
});

describe("selecting on the picture", () => {
  it("a click on a clip selects it, and one on nothing selects nothing", async () => {
    const { addClip, set, overlay, pointer, timeline } = await setup();
    addClip("c");
    set("c", { "transform.scale": 0.5 });
    overlay.press(pointer(10, 10));
    overlay.release(pointer(10, 10));
    expect(timeline.getSnapshot().selection.size).toBe(0);
    overlay.press(pointer(400, 250));
    overlay.release(pointer(400, 250));
    expect([...timeline.getSnapshot().selection]).toEqual(["c"]);
  });

  it("picks the clip in front, and drags it right away", async () => {
    const { addClip, run, main, drag, pointer, property, timeline } = await setup();
    addClip("back");
    run("track.add", { timeline: "main", kind: "video", id: "upper" });
    const clip = {
      id: "front",
      start: "0",
      duration: "4",
      source: { kind: "color", color: "#ffffff" },
    };
    run("clip.add", { timeline: "main", track: "upper", clip });
    expect(main().clips["front"]).toBeDefined();
    timeline.clearSelection();
    drag(pointer(700, 400), pointer(750, 400));
    expect([...timeline.getSnapshot().selection]).toEqual(["front"]);
    expect(property("front", "transform.x")).toBe(100);
    expect(property("back", "transform.x")).toBeUndefined();
  });
});

const ARM: Registration = {
  objects: [
    {
      id: "arm",
      name: "手臂",
      properties: [
        { path: "x", type: "number", default: 0 },
        { path: "turn", type: "angle", default: 0 },
        { path: "tint", type: "color", default: "#ffffff" },
      ],
    },
  ],
  elements: [],
  complete: true,
};

async function withScene() {
  const context = await setup();
  context.run("scene.add", {
    id: "s",
    scene: { name: "场景", entry: "index.html", runtime: 1 },
    files: { "index.html": "<p>场景</p>" },
  });
  context.addClip("c", {}, { kind: "scene", scene: "s" });
  context.setRegistration(ARM);
  const revision = sceneSourceOf(context.store.getState(), "s")?.revision as string;
  // That is what asks the scene: it only answers then.
  context.overlay.getSnapshot();
  return { ...context, revision };
}

describe("handles of code objects", () => {
  const raw = [
    {
      object: "arm",
      bounds: [-50, -50, 100, 100],
      handles: [
        { kind: "move", id: "tip", at: [0, 0], bind: { x: "x" } },
        { kind: "rotate", id: "spin", at: [0, 0], radius: 100, bind: "turn" },
        { kind: "move", id: "sneaky", at: [100, 0], bind: { x: "transform.x" } },
        { kind: "rotate", id: "paint", at: [0, 0], radius: 50, bind: "tint" },
      ],
    },
    { object: "leg", handles: [{ kind: "move", id: "m", at: [0, 0], bind: { x: "x" } }] },
  ];

  it("are only asked of the scene of the selected clip, while nothing plays", async () => {
    const { handles, overlay, timeline } = await withScene();
    overlay.getSnapshot();
    expect(handles.wanted).toBe("c");
    timeline.togglePlayback();
    overlay.getSnapshot();
    expect(handles.wanted).toBeUndefined();
    timeline.pause();
    timeline.clearSelection();
    overlay.getSnapshot();
    expect(handles.wanted).toBeUndefined();
  });

  it("only bind numbers of their own object, and show on top of the clip", async () => {
    const { handles, revision, grips, grip } = await withScene();
    handles.note("c", revision, 0, raw);
    const ids = grips().map(({ id }) => id);
    expect(ids).toContain("c object arm tip");
    expect(ids).toContain("c object arm spin");
    expect(ids.filter((id) => id.includes("object"))).toHaveLength(2);
    expect(ids.at(-1)).toBe("c object arm spin");
    // The middle of the scene is the middle of its box.
    expectAt(grip("c object arm tip").at, 480, 270);
    expectAt(grip("c object arm spin").at, 530, 270);
  });

  it("change what they bind on the clip, and nothing else", async () => {
    const { handles, revision, drag, pointer, property } = await withScene();
    handles.note("c", revision, 0, raw);
    drag(pointer(480, 270), pointer(520, 280));
    expect(property("c", "object.arm.x")).toBe(80);
    expect(property("c", "transform.x")).toBeUndefined();
  });

  it("turn what a rotate handle binds by how far it went around", async () => {
    const { handles, revision, drag, pointer, property } = await withScene();
    handles.note("c", revision, 0, raw);
    drag(
      pointer(530, 270),
      pointer(480 + 50 * Math.SQRT1_2, 270 + 50 * Math.SQRT1_2),
      pointer(480, 320),
    );
    expect(property("c", "object.arm.turn")).toBeCloseTo(90, 6);
  });

  it("are only there for the frame and the state of the scene they were said of", async () => {
    const { handles, revision, grips } = await withScene();
    const objectGrips = () => grips().filter(({ role }) => role === "object");
    handles.note("c", revision, 3, raw);
    expect(objectGrips()).toEqual([]);
    handles.note("c", "another", 0, raw);
    expect(objectGrips()).toEqual([]);
    handles.note("c", revision, 0, raw);
    expect(objectGrips()).toHaveLength(2);
  });

  it("are not there before the scene registered its objects", async () => {
    const { handles, revision, grips, setRegistration } = await withScene();
    setRegistration(undefined);
    handles.note("c", revision, 0, raw);
    expect(grips().filter(({ role }) => role === "object")).toEqual([]);
  });
});
