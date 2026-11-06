import { describe, expect, it } from "vitest";
import { WheelInterpreter, type WheelInput } from "./wheel.ts";

const notch = (time: number, extra: Partial<WheelInput> = {}): WheelInput => ({
  deltaX: 0,
  deltaY: 100,
  lines: false,
  wheelDelta: -120,
  ctrl: false,
  alt: false,
  shift: false,
  time,
  ...extra,
});

const fingers = (time: number, deltaX: number, deltaY: number, extra = {}): WheelInput =>
  notch(time, { deltaX, deltaY, wheelDelta: -3 * deltaY - 1, ...extra });

describe("a mouse wheel", () => {
  it("goes along the timeline", () => {
    expect(new WheelInterpreter().read(notch(0))).toEqual({ kind: "scroll", dx: 100, dy: 0 });
  });

  it("goes up and down with Shift, also the way Windows reports it", () => {
    const shifted = notch(0, { shift: true, deltaX: 100, deltaY: 0 });
    expect(new WheelInterpreter().read(shifted)).toEqual({ kind: "scroll", dx: 0, dy: 100 });
  });

  it("zooms with Ctrl or Alt, and the rows with Shift as well", () => {
    expect(new WheelInterpreter().read(notch(0, { ctrl: true })).kind).toBe("zoom");
    expect(new WheelInterpreter().read(notch(0, { alt: true })).kind).toBe("zoom");
    const rows = notch(0, { ctrl: true, shift: true });
    expect(new WheelInterpreter().read(rows).kind).toBe("zoomRows");
  });

  it("counts lines as a mouse", () => {
    const lines = notch(0, { lines: true, deltaY: 3, wheelDelta: 0 });
    expect(new WheelInterpreter().read(lines)).toEqual({ kind: "scroll", dx: 48, dy: 0 });
  });
});

describe("two fingers on a trackpad", () => {
  it("move the view the way they go", () => {
    const up = new WheelInterpreter().read(fingers(0, 0, 7));
    expect(up).toEqual({ kind: "scroll", dx: 0, dy: 7 });
    const along = new WheelInterpreter().read(fingers(0, 7, 1));
    expect(along).toEqual({ kind: "scroll", dx: 7, dy: 0 });
  });

  it("stay on the axis they started on until they pause", () => {
    const wheel = new WheelInterpreter();
    wheel.read(fingers(0, 9, 1));
    expect(wheel.read(fingers(16, 3, 8))).toEqual({ kind: "scroll", dx: 3, dy: 0 });
    expect(wheel.read(fingers(500, 3, 8))).toEqual({ kind: "scroll", dx: 0, dy: 8 });
  });

  it("do not turn into a mouse when a step looks like a notch", () => {
    const wheel = new WheelInterpreter();
    wheel.read(fingers(0, 0, 7));
    expect(wheel.read(notch(16, { deltaY: 40 }))).toEqual({ kind: "scroll", dx: 0, dy: 40 });
  });

  it("zoom with a pinch, faster than a wheel does for the same distance", () => {
    const pinch = new WheelInterpreter().read(fingers(0, 0, -5, { ctrl: true }));
    expect(pinch.kind).toBe("zoom");
    expect(pinch.kind === "zoom" && pinch.factor).toBeCloseTo(Math.exp(0.05), 6);
  });

  it("change the height of rows with a pinch and Shift", () => {
    const pinch = fingers(0, 0, -5, { ctrl: true, shift: true });
    expect(new WheelInterpreter().read(pinch).kind).toBe("zoomRows");
  });
});

it("a mouse after a pause is a mouse again", () => {
  const wheel = new WheelInterpreter();
  wheel.read(fingers(0, 0, 7));
  expect(wheel.read(notch(1000))).toEqual({ kind: "scroll", dx: 100, dy: 0 });
});
