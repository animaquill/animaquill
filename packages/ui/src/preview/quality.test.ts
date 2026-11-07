import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import type { FrameRateReading, FrameRateSnapshot, PreviewFrameRate } from "./frame-rate.ts";
import { AUTO_RULES, AutoQuality, PreviewQuality } from "./quality.ts";

const at = (painted: number, fps = 60): FrameRateReading => ({
  painted,
  fps,
  dropped: Math.max(fps - painted, 0),
  short: painted < fps * 0.9,
});
const slow = at(40);
const smooth = at(60);
const almost = at(56);

/** What the scale was after each of these readings. */
function scales(auto: AutoQuality, readings: readonly (FrameRateReading | undefined)[]) {
  return readings.map((reading) => {
    auto.note(reading);
    return auto.scale;
  });
}

const times = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

describe("the automatic quality", () => {
  it("starts sharp and goes down a step once it falls behind for more than a moment", () => {
    const auto = new AutoQuality();
    expect(auto.scale).toBe(1);
    expect(scales(auto, [slow])).toEqual([1]);
    expect(scales(auto, [slow])).toEqual([0.5]);
  });

  it("takes one bad second for a hiccup", () => {
    const auto = new AutoQuality();
    expect(scales(auto, [slow, smooth, slow, smooth, slow])).toEqual(times(5, 1));
  });

  it("gives a change time to show what it does, before the next", () => {
    const auto = new AutoQuality();
    const steps = scales(auto, [slow, slow, ...times(AUTO_RULES.settle, slow), slow, slow]);
    expect(steps).toEqual([1, 0.5, 0.5, 0.5, 0.5, 0.25]);
  });

  it("goes no lower than a quarter", () => {
    const auto = new AutoQuality();
    expect(scales(auto, times(30, slow)).at(-1)).toBe(0.25);
  });

  it("goes back up only after keeping up for a while, and only with room to spare", () => {
    const auto = new AutoQuality();
    scales(auto, [slow, slow, ...times(AUTO_RULES.settle, smooth)]);
    expect(auto.scale).toBe(0.5);
    // Just about keeping up says there is no room for more.
    expect(scales(auto, times(20, almost)).at(-1)).toBe(0.5);
    const steps = scales(auto, times(AUTO_RULES.upAfter, smooth));
    expect(steps.at(-2)).toBe(0.5);
    expect(steps.at(-1)).toBe(1);
  });

  it("waits longer each time a step up fails, so it does not go back and forth", () => {
    const auto = new AutoQuality();
    const down = [slow, slow, ...times(AUTO_RULES.settle, smooth)];
    scales(auto, down);
    let wait: number = AUTO_RULES.upAfter;
    for (let round = 0; round < 3; round += 1) {
      // Not up any earlier than it has to wait now.
      expect(scales(auto, times(wait - 1, smooth)).at(-1)).toBe(0.5);
      expect(scales(auto, [smooth])).toEqual([1]);
      // Too much: it falls behind again soon after.
      scales(auto, [...times(AUTO_RULES.settle, smooth), slow, slow]);
      expect(auto.scale).toBe(0.5);
      scales(auto, times(AUTO_RULES.settle, smooth));
      wait *= 2;
    }
    let ups = 0;
    let last = auto.scale;
    for (const scale of scales(auto, times(100, smooth))) {
      if (scale > last) ups += 1;
      last = scale;
    }
    expect(ups).toBe(1);
  });

  it("forgets about failed tries once a step up lasted", () => {
    const auto = new AutoQuality();
    const down = [slow, slow, ...times(AUTO_RULES.settle, smooth)];
    scales(auto, down);
    scales(auto, times(AUTO_RULES.upAfter, smooth));
    scales(auto, [...times(AUTO_RULES.settle, smooth), slow, slow]);
    // That one failed, so the next try waits twice as long, and lasts.
    scales(auto, times(AUTO_RULES.settle + AUTO_RULES.upAfter * 2, smooth));
    expect(auto.scale).toBe(1);
    scales(auto, times(AUTO_RULES.lasts, smooth));
    // Falling behind much later is another story, and the wait is short again.
    scales(auto, [slow, slow, ...times(AUTO_RULES.settle, smooth)]);
    expect(auto.scale).toBe(0.5);
    expect(scales(auto, times(AUTO_RULES.upAfter, smooth)).at(-1)).toBe(1);
  });

  it("starts the streaks over when playing starts again", () => {
    const auto = new AutoQuality();
    expect(scales(auto, [slow, undefined, slow])).toEqual([1, 1, 1]);
  });
});

function setup(saved?: unknown) {
  const emitter = new Emitter();
  let snapshot: FrameRateSnapshot = { state: "paused" };
  const meter = {
    subscribe: emitter.subscribe,
    getSnapshot: () => snapshot,
  } as unknown as PreviewFrameRate;
  const read = (reading: FrameRateReading) => {
    snapshot = { state: "playing", reading };
    emitter.emit();
  };
  const values = new Map<string, unknown>(saved ? [["previewQuality", saved]] : []);
  let elsewhere: (value: unknown) => void = () => {};
  const settings = {
    values,
    load: (key: string) => Promise.resolve(values.get(key)),
    save: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    listen: (_key: string, listener: (value: unknown) => void) => {
      elsewhere = listener;
      return () => {};
    },
  };
  const quality = new PreviewQuality(settings, meter);
  return { quality, read, settings, fromElsewhere: (value: unknown) => elsewhere(value) };
}

describe("the quality people chose", () => {
  it("is automatic until somebody chooses", async () => {
    const { quality, read } = setup();
    await quality.load();
    expect(quality.getSnapshot()).toMatchObject({ choice: "auto", scale: 1 });
    read(slow);
    read(slow);
    expect(quality.getSnapshot().scale).toBe(0.5);
  });

  it("stays where it was put, whatever the frame rate", async () => {
    const { quality, read, settings } = setup();
    await quality.load();
    quality.choose("quarter");
    expect(quality.getSnapshot()).toMatchObject({ choice: "quarter", scale: 0.25 });
    expect(settings.values.get("previewQuality")).toEqual({ version: 1, choice: "quarter" });
    for (const reading of times(20, smooth)) read(reading);
    expect(quality.getSnapshot().scale).toBe(0.25);
    quality.choose("full");
    for (const reading of times(20, slow)) read(reading);
    expect(quality.getSnapshot().scale).toBe(1);
  });

  it("comes back the way it was saved, and follows other windows", async () => {
    const { quality, fromElsewhere } = setup({ version: 1, choice: "half" });
    await quality.load();
    expect(quality.getSnapshot()).toMatchObject({ choice: "half", scale: 0.5 });
    fromElsewhere({ version: 1, choice: "full" });
    expect(quality.getSnapshot().scale).toBe(1);
    fromElsewhere({ version: 1, choice: "sharpest" });
    expect(quality.getSnapshot().scale).toBe(1);
  });

  it("ignores what it cannot read", async () => {
    const { quality } = setup({ version: 9, choice: "quarter" });
    await quality.load();
    expect(quality.getSnapshot()).toMatchObject({ choice: "auto", scale: 1 });
  });

  it("says what the preview draws, and nothing once it is gone", () => {
    const { quality } = setup();
    const heard = vi.fn();
    quality.subscribe(heard);
    const size = { shown: { width: 960, height: 540 }, full: { width: 1920, height: 1080 } };
    quality.noteSize(size);
    quality.noteSize({ shown: { width: 960, height: 540 }, full: { width: 1920, height: 1080 } });
    expect(heard).toHaveBeenCalledTimes(1);
    quality.noteSize(undefined);
    expect(quality.getSnapshot().size).toBeUndefined();
  });
});
