import { formatTime } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  formatTimecode,
  frameAt,
  frameRate,
  frameSeconds,
  frameTime,
  parseTimecode,
} from "./frames.ts";

describe("frames", () => {
  it("rounds to the nearest frame", () => {
    const rate = frameRate("30");
    expect(frameAt(1, rate)).toBe(30);
    expect(frameAt(1.016, rate)).toBe(30);
    expect(frameAt(1.018, rate)).toBe(31);
  });

  it("gives exact times, also where a float would not", () => {
    expect(formatTime(frameTime(1, frameRate("30000/1001")))).toBe("1001/30000");
    expect(formatTime(frameTime(30, frameRate("30")))).toBe("1");
    expect(formatTime(frameTime(1, frameRate("30")))).toBe("1/30");
  });

  it("goes back and forth without drifting", () => {
    const rate = frameRate("30000/1001");
    for (const frame of [0, 1, 29, 30, 1799, 107_892]) {
      expect(frameAt(frameSeconds(frame, rate), rate)).toBe(frame);
    }
  });
});

describe("timecode", () => {
  it.each([
    [0, "30", "00:00:00:00"],
    [29, "30", "00:00:00:29"],
    [30, "30", "00:00:01:00"],
    [1800, "30", "00:01:00:00"],
    [108_000, "30", "01:00:00:00"],
    [59, "60", "00:00:00:59"],
    [24, "24", "00:00:01:00"],
    [30, "30000/1001", "00:00:01:00"],
  ])("frame %i at %s is %s", (frame, fps, text) => {
    expect(formatTimecode(frame, frameRate(fps))).toBe(text);
  });
});

describe("typing a time", () => {
  it.each([
    ["00:00:01:15", 45],
    ["1:15", 45],
    ["01:00:00:00", 108_000],
    ["5", 150],
    ["2.5", 75],
    [" 3 ", 90],
  ])("%s is frame %i", (text, frame) => {
    expect(parseTimecode(text, frameRate("30"))).toBe(frame);
  });

  it.each(["", "abc", "1:2:3:4:5", "1:", "-1"])("%s is no time", (text) => {
    expect(parseTimecode(text, frameRate("30"))).toBeUndefined();
  });

  it("reads back what it writes", () => {
    const rate = frameRate("30000/1001");
    expect(parseTimecode(formatTimecode(1234, rate), rate)).toBe(1234);
  });
});
