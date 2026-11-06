import { describe, expect, it, vi } from "vitest";
import { DiagnosticsRecorder } from "./recorder.ts";

const create = () =>
  new DiagnosticsRecorder(
    "1",
    () => () => {},
    () => ({}),
  );

const started = () => {
  const recorder = create();
  recorder.start();
  return recorder;
};

describe("recording", () => {
  it("keeps nothing unless it was asked to", () => {
    const recorder = create();
    recorder.note("play");
    recorder.noteFrame(5, {}, true);
    recorder.start();
    expect(recorder.finish({}).events).toEqual([]);
  });

  it("says whether it is on", () => {
    const recorder = started();
    expect(recorder.getRecording()).toBe(true);
    recorder.finish({});
    expect(recorder.getRecording()).toBe(false);
    expect(recorder.getSnapshot().status).toBe("finished");
  });

  it("counts every frame, and lists only the slow ones", () => {
    const recorder = started();
    recorder.noteFrame(5, {}, false);
    recorder.noteFrame(12, {}, false);
    recorder.noteFrame(120, { cold: 1 }, true);
    recorder.noteFrame(5000, {}, true);
    const report = recorder.finish({});
    expect(report.frameTimes).toEqual({ "<=8": 1, "<=16": 1, "<=250": 1, more: 1 });
    expect(report.events.filter(({ kind }) => kind === "frame")).toHaveLength(2);
  });

  it("stops at a limit and says how much it left out", () => {
    const recorder = started();
    for (let index = 0; index < 6010; index += 1) recorder.note("x");
    const report = recorder.finish({});
    expect(report.events.length).toBeLessThanOrEqual(6000);
    expect(report.dropped).toBeGreaterThanOrEqual(10);
  });

  it("keeps the report for people to look at, until they decide", () => {
    const recorder = started();
    recorder.noteFrame(90, { cold: 2 }, true);
    const report = recorder.finish({});
    expect(recorder.getSnapshot().report).toBe(report);
    expect(recorder.getSnapshot().counts).toMatchObject({ slowFrames: 1, cold: 2 });
    recorder.markSent("abc");
    expect(recorder.getSnapshot().sentId).toBe("abc");
    recorder.discard();
    expect(recorder.getSnapshot().report).toBeUndefined();
  });

  it("shows the newest first, and leaves memory to its own number", () => {
    const recorder = started();
    recorder.note("gap", { ms: 50 });
    recorder.note("memory", { mb: 300 });
    recorder.note("longtask", { ms: 80 });
    recorder.finish({});
    const { recent, memoryMb } = recorder.getSnapshot();
    expect(recent.map(({ kind }) => kind)).toEqual(["longtask", "gap"]);
    expect(memoryMb).toBe(300);
  });

  it("forgets everything when discarded", () => {
    const recorder = started();
    recorder.note("x");
    recorder.discard();
    expect(recorder.getRecording()).toBe(false);
    recorder.start();
    expect(recorder.finish({}).events).toEqual([]);
  });

  it("starts over each time", () => {
    const recorder = started();
    recorder.note("x");
    recorder.finish({});
    recorder.start();
    recorder.note("y");
    expect(recorder.finish({}).events.map(({ kind }) => kind)).toEqual(["y"]);
  });

  it("stops watching the page when it ends", () => {
    const stop = vi.fn();
    const recorder = new DiagnosticsRecorder(
      "1",
      () => stop,
      () => ({}),
    );
    recorder.start();
    recorder.finish({});
    expect(stop).toHaveBeenCalledOnce();
  });
});
