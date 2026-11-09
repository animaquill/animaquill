import { describe, expect, it } from "vitest";
import { WheelInterpreter, looksLikeNotch, type WheelInput } from "./wheel.ts";

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

describe("a mouse wheel over the headers", () => {
  const headers = (input: WheelInput) => new WheelInterpreter().read(input, undefined, "headers");

  it("goes up and down, and along with Shift", () => {
    expect(headers(notch(0))).toEqual({ kind: "scroll", dx: 0, dy: 100 });
    const shifted = notch(0, { shift: true, deltaX: 100, deltaY: 0 });
    expect(headers(shifted)).toEqual({ kind: "scroll", dx: 100, dy: 0 });
  });

  it("changes the height of rows with Ctrl or ⌘, with Shift or without", () => {
    expect(headers(notch(0, { ctrl: true })).kind).toBe("zoomRows");
    expect(headers(notch(0, { ctrl: true, shift: true })).kind).toBe("zoomRows");
  });
});

describe("what a notch looks like", () => {
  const plain = {
    deltaX: 0,
    deltaY: 0,
    lines: false,
    wheelDelta: 0,
    ctrl: false,
    alt: false,
    shift: false,
    time: 0,
  };
  it.each([
    ["counted in lines", { lines: true, deltaY: 3 }, true],
    ["a multiple of 120 in the old value", { deltaY: 53, wheelDelta: -120 }, true],
    ["a whole step of 100 without the old value", { deltaY: 100 }, true],
    ["both axes at once", { deltaX: 4, deltaY: 100, wheelDelta: -120 }, false],
    ["a small step", { deltaY: 7, wheelDelta: -21 }, false],
    ["a step that is not whole", { deltaY: 41.5 }, false],
    ["a small whole step without the old value", { deltaY: 12 }, false],
  ])("is %s: %s", (_, input, wanted) => {
    expect(looksLikeNotch({ ...plain, ...input })).toBe(wanted);
  });

  it("goes by what people said they use, before what the steps look like", () => {
    const wheel = new WheelInterpreter();
    expect(wheel.read(fingers(0, 0, 7), "mouse")).toEqual({ kind: "scroll", dx: 7, dy: 0 });
    expect(wheel.read(notch(500), "trackpad")).toEqual({ kind: "scroll", dx: 0, dy: 100 });
  });
});

describe("two fingers on a trackpad", () => {
  it("move the view the way they go, both ways at once", () => {
    const up = new WheelInterpreter().read(fingers(0, 0, 7));
    expect(up).toEqual({ kind: "scroll", dx: 0, dy: 7 });
    const slanted = new WheelInterpreter().read(fingers(0, 7, 1));
    expect(slanted).toEqual({ kind: "scroll", dx: 7, dy: 1 });
  });

  it("change direction as they go, without a pause and without keeping to an axis", () => {
    const wheel = new WheelInterpreter();
    wheel.read(fingers(0, 9, 1));
    expect(wheel.read(fingers(16, 3, 8))).toEqual({ kind: "scroll", dx: 3, dy: 8 });
    expect(wheel.read(fingers(32, -4, -6))).toEqual({ kind: "scroll", dx: -4, dy: -6 });
  });

  it("do the same over the headers", () => {
    const over = new WheelInterpreter().read(fingers(0, 5, 3), undefined, "headers");
    expect(over).toEqual({ kind: "scroll", dx: 5, dy: 3 });
    const pinch = new WheelInterpreter().read(
      fingers(0, 0, -5, { ctrl: true }),
      undefined,
      "headers",
    );
    expect(pinch.kind).toBe("zoomRows");
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

it("does what people said when they said what they use", () => {
  expect(new WheelInterpreter().read(fingers(0, 0, 7), "mouse")).toEqual({
    kind: "scroll",
    dx: 7,
    dy: 0,
  });
  expect(new WheelInterpreter().read(notch(0), "trackpad")).toEqual({
    kind: "scroll",
    dx: 0,
    dy: 100,
  });
});
