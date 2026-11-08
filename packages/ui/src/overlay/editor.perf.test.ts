import { describeClip, orderedTracks } from "@animaquill/core";
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
import { OverlayEditor } from "./editor.ts";
import { SceneHandles } from "./scene-handles.ts";

const KEYS = 20000;
const HD = { width: 1920, height: 1080 };

async function manyKeys() {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("很多关键帧");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: false } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const timeline = new TimelineEditor(session, memoryWindow(), settings, {
    commandFailed: vi.fn(),
  });
  await timeline.load();
  const messages = Object.fromEntries(
    [
      "commandFailed",
      "overwrote",
      "discarded",
      "setAside",
      "back",
      "asideDropped",
      "unsure",
      "restored",
      "dropped",
      "readFailed",
      "keepFailed",
      "keepRecovered",
    ].map((name) => [name, vi.fn()]),
  );
  const trials = new TrialSession(
    session,
    timeline,
    new MemoryTrials(),
    settings,
    messages as never,
  );
  await trials.load();
  await trials.settle();
  const writer = new PropertyWriter(session, timeline, trials, {
    commandFailed: vi.fn(),
    comparing: vi.fn(),
  });
  const registrations = {
    registrationOf: () => undefined,
    subscribe: () => () => {},
    getVersion: () => 0,
  };
  const overlay = new OverlayEditor({
    session,
    timeline,
    properties: writer,
    trials,
    quality: {
      getSnapshot: () => ({ choice: "full", scale: 1, size: { shown: HD, full: HD } }),
      subscribe: () => () => {},
    },
    handles: new SceneHandles(),
    registrations,
    describe: (clip) => describeClip(store.getState(), clip, registrations),
    messages: { gone: vi.fn() },
  });
  overlay.setViewport(960, 540);
  const main = store.getState().timelines["main"];
  const track = main && orderedTracks(main).find(({ kind }) => kind === "video")?.id;
  const keys = Array.from({ length: KEYS }, (_, index) => ({
    time: String(index),
    value: (index % 100) * 3,
  }));
  const clip = {
    id: "c",
    start: "0",
    duration: String(KEYS),
    source: { kind: "color", color: "#123" },
  };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  store.execute({
    type: "property.edit",
    params: {
      timeline: "main",
      edits: [{ owner: { clip: "c" }, path: "transform.x", op: "set", value: { keys } }],
    },
  });
  timeline.selectOnly("c");
  return overlay;
}

describe("a clip with 20000 keys on its position", () => {
  it("shows its handles and follows a drag without taking long", async () => {
    const overlay = await manyKeys();
    const started = performance.now();
    overlay.getSnapshot();
    const first = performance.now() - started;
    const pointer = (x: number) => ({ x, y: 400, shift: false, alt: false });
    overlay.press(pointer(700));
    const moving = performance.now();
    for (let step = 1; step <= 10; step += 1) {
      overlay.drag(pointer(700 + step * 5));
      overlay.getSnapshot();
    }
    const perStep = (performance.now() - moving) / 10;
    overlay.cancel();
    expect(first).toBeLessThan(200);
    expect(perStep).toBeLessThan(50);
  });
});
