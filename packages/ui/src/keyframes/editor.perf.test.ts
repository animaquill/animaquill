import type { PropertyEdit } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { KeyframeEditor } from "./editor.ts";
import { KeySelection } from "./selection.ts";

const CLIPS = 5000;
const KEYS = 5;

const keysOf = (first: number) => ({
  keys: Array.from({ length: KEYS }, (_, index) => ({
    time: String(index / KEYS),
    value: first + index,
  })),
});

async function big() {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("大项目");
  const store = session.store;
  if (!store) throw new Error("no project");
  // Going through 5000 commands is not what is being measured.
  const path = "timelines/main/timeline.json";
  const file = JSON.parse(store.exportFiles().files.get(path) as string) as {
    tracks: { kind: string; clips: unknown[] }[];
    sections: { duration: string }[];
  };
  const track = file.tracks.find(({ kind }) => kind === "video");
  const section = file.sections[0];
  if (!track || !section) throw new Error("no room for clips");
  section.duration = String(CLIPS);
  track.clips = Array.from({ length: CLIPS }, (_, index) => ({
    id: `c${index}`,
    start: String(index),
    duration: "1",
    source: { kind: "color", color: "#336699" },
    properties: { "transform.x": keysOf(index), "transform.y": keysOf(-index) },
  }));
  const imported = store.importFile(path, JSON.stringify(file));
  if (!imported.ok) throw new Error(imported.error.message);
  const settings = {
    load: async () => undefined,
    save: async () => {},
    listen: () => () => {},
  };
  const memory = memoryWindow();
  const timeline = new TimelineEditor(session, memory, settings, { commandFailed: vi.fn() });
  timeline.setViewport(1000, 400);
  const trials = new TrialSession(session, timeline, new MemoryTrials(), settings, {
    commandFailed: vi.fn(),
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
  await trials.settle();
  const writer = new PropertyWriter(session, timeline, trials, {
    commandFailed: vi.fn(),
    comparing: vi.fn(),
  });
  const t = ((key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key) as never;
  const keyframes = new KeyframeEditor(session, timeline, trials, writer, memory, settings, t, {
    pasteTooEarly: vi.fn(),
    pasteNowhere: vi.fn(),
    comparing: vi.fn(),
    locked: vi.fn(),
    notShown: vi.fn(),
    gone: vi.fn(),
  });
  keyframes.panel.setViewport(1000, 600);
  return { store, timeline, keyframes, writer, trials };
}

/**
 * Limits are many times what it takes, so that a busy machine does not fail this. Going through all
 * clips for each clip takes minutes, and that is what this is here to catch.
 */
const timed = (name: string, run: () => void, limit: number) => {
  const started = performance.now();
  run();
  expect(performance.now() - started, name).toBeLessThan(limit);
};

/** The numbers of the browser test need a browser. This is what does not. */
describe("5000 clips with 50000 keys", { timeout: 60_000 }, () => {
  it("lists and works on all of it without stopping", async () => {
    const { keyframes, timeline, trials } = await big();
    const { panel } = keyframes;
    timed("listing all clips", () => keyframes.setRange("all"), 4000);
    expect(panel.lanes.length).toBeGreaterThan(CLIPS);
    timed("again, with the same clips", () => keyframes.setRange("here"), 1000);
    timed(
      "100 frames of moving the playhead by hand",
      () => {
        for (let frame = 0; frame < 100; frame += 1) timeline.seek(3000 + frame * 30);
      },
      2000,
    );
    timed("only what has keys", () => keyframes.setRange("keyed"), 5000);
    keyframes.setRange("all");
    timed("looking for a name", () => keyframes.setQuery("transform.x"), 5000);
    expect(panel.lanes.length).toBeGreaterThan(CLIPS * 2);

    // Rows of numbers draw their curves and handles from what is on screen only, also with every
    // key of them selected: close enough that keys have room for handles, and one row taller.
    panel.selectAll();
    expect(keyframes.selection.size).toBe(CLIPS * KEYS);
    panel.zoomAround(0, 600);
    const row = panel.lanes.find(({ node }) => node.kind === "property");
    if (!row?.box || row.node.kind !== "property") throw new Error("no row");
    keyframes.toggleTall(row.box.id, row.node.spec.path);
    let handles = 0;
    timed(
      "handles and keys of what shows, 200 times while scrolling down",
      () => {
        for (let step = 0; step < 200; step += 1) {
          panel.setScroll(0, step * 4);
          handles = Math.max(handles, panel.visibleHandles().length);
          panel.visibleKeys(200);
        }
      },
      2000,
    );
    expect(handles).toBeGreaterThan(0);
    // Further on, none of the rows on screen have keys on screen.
    panel.setScroll(panel.pixelsPerSecond * 3000, 0);
    timed("handles with nothing on screen", () => panel.visibleHandles(), 50);
    expect(panel.visibleHandles()).toEqual([]);
    keyframes.toggleTall(row.box.id, row.node.spec.path);
    panel.zoomToFit();
    keyframes.setQuery("");

    timed("selecting everything", () => panel.selectAll(), 5000);
    expect(keyframes.selection.size).toBe(CLIPS * KEYS * 2);
    timed("copying all of it", () => keyframes.copySelected(), 5000);
    timed("nudging all of it", () => keyframes.nudge(1), 30_000);
    expect(trials.getSnapshot().count).toBe(CLIPS * 2);
    timed("taking that back", () => trials.undo(), 10_000);
  });

  it("keys go to the playhead without going through every selected clip for each of them", async () => {
    const { store, keyframes, timeline } = await big();
    const owner = { clip: "c0" };
    const keys = Array.from({ length: 5000 }, (_, index) => ({
      time: String(index / 10),
      value: index,
    }));
    const edit: PropertyEdit = { owner, path: "transform.rotation", op: "set", value: { keys } };
    store.execute({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    keyframes.select(
      KeySelection.of(keys.map(({ time }) => ({ clip: "c0", path: "transform.rotation", time }))),
    );
    keyframes.copySelected();
    timeline.selectAll();
    timeline.seek(30 * 30);
    // Going through the 5000 selected clips for each key took 59 seconds.
    timed("pasting 5000 keys with 5000 clips selected", () => keyframes.paste(), 5000);
    const box = timeline.model?.boxes.get("c0");
    if (!box) throw new Error("no clip");
    const value = keyframes.shown(box.clip).properties?.["transform.rotation"] as {
      keys: unknown[];
    };
    expect(value.keys.length).toBeGreaterThan(5000);
  });

  it("tells keys that are tried from the others without going through all of them", async () => {
    const { store, keyframes, timeline, writer } = await big();
    const owner = { clip: "c0" };
    const keys = Array.from({ length: 100_000 }, (_, index) => ({
      time: String(index / 1000),
      value: index,
    }));
    const edit: PropertyEdit = { owner, path: "transform.rotation", op: "set", value: { keys } };
    store.execute({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    const moves = [{ from: "0", to: "0.0005" }];
    writer.commit([{ owner, path: "transform.rotation", op: "moveKey", moves }]);
    keyframes.setRange("all");
    keyframes.toggleOpen("c0");
    timeline.seek(0);
    const { panel } = keyframes;
    panel.zoomAround(0, 400);
    // Near the last of them, which is where looking through them from the first takes longest.
    panel.setScroll(98 * panel.pixelsPerSecond, panel.scrollY);
    let found = 0;
    // Looking through all of them for each key on screen took seconds for this.
    timed(
      "the keys on screen, 20 times",
      () => {
        for (let round = 0; round < 20; round += 1) found = panel.visibleKeys(200).length;
      },
      1000,
    );
    expect(found).toBeGreaterThan(100);
  });

  it("a box of keys across thousands of clips does not list everything again with each step", async () => {
    const { keyframes, timeline } = await big();
    keyframes.setRange("all");
    // Keys select their clips. Listing all of them again for that took 4 seconds for this.
    timed(
      "50 steps of a box that grows",
      () => {
        for (let step = 1; step <= 50; step += 1) {
          const clips = Array.from({ length: step * 100 }, (_, index) => `c${index}`);
          keyframes.select(
            KeySelection.of(clips.map((clip) => ({ clip, path: "transform.x", time: "0" }))),
          );
        }
      },
      2000,
    );
    expect(timeline.getSnapshot().selection.size).toBe(CLIPS);
  });

  it("a key among thousands moves without going through the rest", async () => {
    const { store, keyframes, writer } = await big();
    const owner = { clip: "c0" };
    const keys = Array.from({ length: 20_000 }, (_, index) => ({
      time: String(index / 10 + 10),
      value: index,
    }));
    const edit: PropertyEdit = { owner, path: "transform.rotation", op: "set", value: { keys } };
    store.execute({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    const moves = [{ from: "10", to: "10.05" }];
    timed(
      "one key of 20000 in a preview",
      () => writer.preview([{ owner, path: "transform.rotation", op: "moveKey", moves }]),
      1000,
    );
    expect(keyframes.selection.size).toBe(0);
    writer.cancel();
  });
});
