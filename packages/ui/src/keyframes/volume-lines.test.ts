import { orderedTracks, type CommandFailure } from "@animaquill/core";
import type { Animation, PropertyValue } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import {
  heightOfVolume,
  roundedVolume,
  volumeOfHeight,
  UNITY_HEIGHT,
} from "../properties/sound-scale.ts";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { registerTimelineActions } from "../timeline/actions.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import type { Pointer } from "../timeline/gestures.ts";
import {
  VOLUME_LINE_MIN_HEIGHT,
  keptVolume,
  lineHitAt,
  volumeAtY,
  volumeLineOf,
  yOfVolume,
} from "../timeline/volume-line.ts";
import { ActionRegistry } from "../workbench/actions.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { registerKeyframeActions } from "./actions.ts";
import { KeyframeEditor } from "./editor.ts";

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as never;

/** A project with a clip of sound, `c`, from 1 s to 5 s on the timeline, its file from 0.5 s. */
async function setup(properties: Record<string, PropertyValue> = {}) {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("音量线");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: false } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const memory = memoryWindow();
  const commandFailed = vi.fn<(failure: CommandFailure) => void>();
  const timeline = new TimelineEditor(session, memory, settings, { commandFailed });
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
  const keyframes = new KeyframeEditor(session, timeline, trials, writer, memory, settings, t, {
    pasteTooEarly: vi.fn(),
    pasteNowhere: vi.fn(),
    comparing: vi.fn(),
    locked: vi.fn(),
    notShown: vi.fn(),
    gone: vi.fn(),
  });
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  };
  const main = () => store.getState().timelines["main"];
  const audio = orderedTracks(main() as never).find(({ kind }) => kind === "audio")?.id as string;
  run("asset.add", {
    id: "tone",
    asset: { kind: "audio", path: "assets/tone.wav", storage: "local", hash: "sha256-tone" },
  });
  run("clip.add", {
    timeline: "main",
    track: audio,
    id: "c",
    start: "1",
    duration: "4",
    offset: "1/2",
    source: { kind: "audio", media: { asset: "tone" } },
    properties,
  });
  const lines = keyframes.volumeLines;
  const row = () => timeline.model?.rows.find(({ id }) => id === audio);
  const box = () => timeline.model?.boxes.get("c");
  const area = () => lines.areaOf(row() as never);
  /** Where the line is at a moment of the timeline. */
  const onLine = (seconds: number, extra: Partial<Pointer> = {}): Pointer => {
    const line = lines.lineOf(box() as never);
    const clock = seconds - 1 + 0.5;
    return {
      x: timeline.xAt(seconds),
      y: yOfVolume(area(), line.at(clock)),
      shift: false,
      alt: false,
      mod: false,
      ...extra,
    };
  };
  const drag = (from: Pointer, to: Pointer) => {
    timeline.press(from);
    timeline.drag({ ...from, y: (from.y + to.y) / 2, x: (from.x + to.x) / 2 });
    timeline.drag(to);
    timeline.release(to);
  };
  const click = (pointer: Pointer) => {
    timeline.press(pointer);
    timeline.release(pointer);
  };
  const volume = () => main()?.clips["c"]?.properties?.["audio.volume"];
  const keysOf = () => (volume() as Animation | undefined)?.keys ?? [];
  const actions = new ActionRegistry();
  registerTimelineActions(actions, timeline, keyframes.inTimeline);
  registerKeyframeActions(actions, keyframes, timeline, writer);
  const act = (id: string) => {
    const action = actions.get(id);
    if (!action) throw new Error(`no action ${id}`);
    if (action.enabled?.() !== false) action.run();
  };
  return {
    store,
    timeline,
    writer,
    keyframes,
    lines,
    box,
    row,
    area,
    onLine,
    drag,
    click,
    volume,
    keysOf,
    act,
  };
}

const keyed = (...pairs: (readonly [string, number])[]) => ({
  keys: pairs.map(([time, value]) => ({ time, value })),
});

describe("the height of a volume", () => {
  it("has 0 dB a third from the top, +24 dB at the top and silence at the bottom", () => {
    expect(heightOfVolume(0)).toBe(UNITY_HEIGHT);
    expect(heightOfVolume(24)).toBe(1);
    expect(heightOfVolume(30)).toBe(1);
    expect(heightOfVolume(-96)).toBe(0);
    expect(heightOfVolume(-200)).toBe(0);
    expect(heightOfVolume(12)).toBeCloseTo(UNITY_HEIGHT + 1 / 6, 12);
  });

  it("goes down as the volume does, and back again exactly", () => {
    let last = Number.POSITIVE_INFINITY;
    for (const decibels of [24, 12, 6, 0, -3, -6, -12, -20, -40, -60, -90]) {
      const height = heightOfVolume(decibels);
      expect(height).toBeLessThan(last);
      last = height;
      expect(volumeOfHeight(height)).toBeCloseTo(decibels, 9);
    }
    expect(volumeOfHeight(0)).toBe(-96);
  });

  it("is as high on a clip: the top is +24 dB and the bottom silence", () => {
    const area = { top: 100, height: 60 };
    expect(volumeAtY(area, yOfVolume(area, -6))).toBeCloseTo(-6, 9);
    expect(yOfVolume(area, 24)).toBeLessThan(yOfVolume(area, 0));
    expect(roundedVolume(volumeAtY(area, 1000))).toBe(-96);
    expect(volumeAtY(area, 0)).toBe(24);
  });
});

describe("the volume line on a clip of sound", () => {
  it("is nowhere on a clip that is too low", () => {
    const line = volumeLineOf(-6);
    const view = { xAt: (s: number) => s * 100, timeAt: (x: number) => x / 100 };
    const box = { id: "c", clip: {} as never, start: 0, end: 4, offset: 0 };
    const low = { top: 0, height: VOLUME_LINE_MIN_HEIGHT - 1 };
    const pointAt = { x: 100, y: yOfVolume(low, -6) };
    expect(lineHitAt(view, box, low, line, pointAt)).toBeUndefined();
    const high = { top: 0, height: VOLUME_LINE_MIN_HEIGHT };
    expect(lineHitAt(view, box, high, line, { x: 100, y: yOfVolume(high, -6) })?.kind).toBe("line");
    const drawn = { fill: 0 };
    const context = new Proxy(
      {},
      { get: (_, name) => (name === "stroke" ? () => (drawn.fill += 1) : () => {}) },
    ) as CanvasRenderingContext2D;
    return setup().then(({ lines, box: of }) => {
      const clip = of();
      if (!clip) throw new Error("no clip");
      const area = { left: 0, top: 0, width: 400, height: VOLUME_LINE_MIN_HEIGHT - 1 };
      lines.paint(context, clip, clip, area, "#fff", { background: "#000" } as never);
      expect(drawn.fill).toBe(0);
      lines.paint(context, clip, clip, { ...area, height: 40 }, "#fff", {
        background: "#000",
        selected: "#00f",
      } as never);
      expect(drawn.fill).toBeGreaterThan(0);
    });
  });

  it("sets the volume of the clip when dragged up or down, as one step", async () => {
    const { onLine, drag, volume, area, store, timeline } = await setup();
    const from = onLine(3);
    expect(timeline.hover(from)).toBe("ns-resize");
    const to = { ...from, y: from.y + 15 };
    drag(from, to);
    const wanted = keptVolume(volumeAtY(area(), to.y));
    expect(wanted).toBeLessThan(0);
    expect(volume()).toBe(wanted);
    expect(store.undo().ok).toBe(true);
    expect(volume()).toBeUndefined();
  });

  it("puts a key where Ctrl is clicked on it, and the sound stays as it was", async () => {
    // From 0 dB at 1 s on the clock to −20 dB at 3 s: at 2 s halfway in decibels.
    const { onLine, click, keysOf, lines, box, keyframes } = await setup({
      "audio.volume": keyed(["1", 0], ["3", -20]),
    });
    const before = lines.savedLineOf(box() as never);
    const samples = [0.6, 1.4, 2, 2.6, 3.4].map((clock) => before.at(clock));
    // 2.5 s on the timeline is 2 s on the clock of the clip.
    click(onLine(2.5, { mod: true }));
    expect(keysOf().map(({ time, value }) => [time, value])).toEqual([
      ["1", 0],
      ["2", -10],
      ["3", -20],
    ]);
    const after = lines.savedLineOf(box() as never);
    for (const [index, clock] of [0.6, 1.4, 2, 2.6, 3.4].entries()) {
      expect(after.at(clock)).toBeCloseTo(samples[index] as number, 9);
    }
    expect([...keyframes.selection].map(({ time }) => time)).toEqual(["2"]);
  });

  it("takes both keys along when the line between them is dragged", async () => {
    const { onLine, drag, keysOf, timeline, store } = await setup({
      "audio.volume": keyed(["0.5", 0], ["2", -6], ["4", -12]),
    });
    // 4 s on the timeline is 3.5 s on the clock: between the keys at 2 and 4.
    const from = onLine(4);
    expect(timeline.hover(from)).toBe("ns-resize");
    drag(from, { ...from, y: from.y + 12 });
    const [first, second, third] = keysOf().map(({ value }) => value as number);
    expect(first).toBe(0);
    expect(second).toBeLessThan(-6);
    expect((third as number) - (second as number)).toBeCloseTo(-6, 6);
    // The drag went through several places: one step back is where it started.
    expect(store.undo().ok).toBe(true);
    expect(keysOf().map(({ value }) => value)).toEqual([0, -6, -12]);
  });

  it("moves a key up and down, and Delete takes a selected one away", async () => {
    const { onLine, drag, click, keysOf, act, store } = await setup({
      "audio.volume": keyed(["0.5", 0], ["2.5", -12]),
    });
    // The key at 2.5 on the clock is at 3 s on the timeline.
    const key = onLine(3);
    drag(key, { ...key, y: key.y - 20 });
    const moved = keysOf()[1];
    expect(moved?.time).toBe("2.5");
    expect(moved?.value as number).toBeGreaterThan(-12);
    click(onLine(3));
    act("timeline.delete");
    expect(keysOf().map(({ time }) => time)).toEqual(["0.5"]);
    // The clip is still there.
    expect(store.getState().timelines["main"]?.clips["c"]).toBeDefined();
  });

  it("writes keys with automatic keys on, from the first frame of the clip to the playhead", async () => {
    const { onLine, drag, keysOf, writer, timeline } = await setup({ "audio.volume": -6 });
    writer.setRecording(true);
    // The playhead at 3 s, which is 2.5 s on the clock of the clip.
    timeline.seek(90);
    const from = onLine(2);
    drag(from, { ...from, y: from.y - 15 });
    const keys = keysOf();
    expect(keys.map(({ time }) => time)).toEqual(["0.5", "2.5"]);
    expect(keys[0]?.value).toBe(-6);
    expect(keys[1]?.value as number).toBeGreaterThan(-6);
  });

  it("leaves the clip to the clip at its edges, and to Ctrl elsewhere", async () => {
    const { timeline, onLine } = await setup();
    const atStart = { ...onLine(1), x: timeline.xAt(1) + 1 };
    expect(timeline.hover(atStart)).toBe("ew-resize");
    const away = { ...onLine(3), y: onLine(3).y + 20 };
    expect(timeline.hover(away)).toBe("default");
    expect(timeline.hover(onLine(3, { mod: true }))).toBe("copy");
  });
});
