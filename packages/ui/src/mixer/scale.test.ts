import { describe, expect, it } from "vitest";
import { UNITY_HEIGHT, heightOfVolume } from "../properties/sound-scale.ts";
import { MASTER_LEFT, MASTER_RIGHT, MixLevels } from "./levels.ts";
import {
  CLIPPING,
  FALL_PER_SECOND,
  METER_FLOOR,
  faderAfterDrag,
  faderOfVolume,
  faderText,
  knobAngle,
  levelText,
  meterAfter,
  meterHeight,
  meterZone,
  panAfterDrag,
  stuckFader,
  stuckPan,
  volumeOfFader,
} from "./scale.ts";

const TRAVEL = 200;

describe("the fader", () => {
  it("has the scale of the volume line, and reads back what it shows", () => {
    for (const decibels of [-96, -40, -20, -6, -0.5, 0, 3, 12, 24]) {
      expect(faderOfVolume(decibels)).toBe(heightOfVolume(decibels));
      expect(volumeOfFader(faderOfVolume(decibels))).toBeCloseTo(decibels, 6);
    }
    expect(faderOfVolume(0)).toBe(UNITY_HEIGHT);
    expect(faderOfVolume(-96)).toBe(0);
    expect(faderOfVolume(24)).toBe(1);
    // A hand sets tenths of a decibel, and −∞ at the bottom.
    expect(volumeOfFader(0.5)).toBe(Number(volumeOfFader(0.5).toFixed(1)));
    expect(volumeOfFader(0)).toBe(-96);
  });

  it("goes up as the pointer goes up, as far as it goes, and a tenth as far with Shift", () => {
    const start = faderOfVolume(-12);
    expect(faderAfterDrag(start, -20, TRAVEL, false)).toBeCloseTo(start + 0.1, 9);
    expect(faderAfterDrag(start, -20, TRAVEL, true)).toBeCloseTo(start + 0.01, 9);
    expect(faderAfterDrag(start, 1000, TRAVEL, false)).toBe(0);
    expect(faderAfterDrag(start, -1000, TRAVEL, false)).toBe(1);
  });

  it("sticks at 0 dB within a few pixels, unless Shift sets it exactly", () => {
    const near = UNITY_HEIGHT + 3 / TRAVEL;
    expect(stuckFader(near, TRAVEL, false)).toBe(UNITY_HEIGHT);
    expect(volumeOfFader(stuckFader(near, TRAVEL, false))).toBe(0);
    expect(stuckFader(near, TRAVEL, true)).toBe(near);
    expect(stuckFader(UNITY_HEIGHT + 6 / TRAVEL, TRAVEL, false)).toBe(UNITY_HEIGHT + 6 / TRAVEL);
  });

  it("writes its number as the strip reads it", () => {
    expect(faderText(-3)).toBe("−3.0");
    expect(faderText(0)).toBe("0.0");
    expect(faderText(-0.04)).toBe("0.0");
    expect(faderText(2.5)).toBe("+2.5");
    expect(faderText(-96)).toBe("−∞");
  });
});

describe("the pan knob", () => {
  it("turns right going up and left going down, a tenth as far with Shift", () => {
    expect(panAfterDrag(0, -50, false)).toBeCloseTo(0.5, 9);
    expect(panAfterDrag(0, 50, false)).toBeCloseTo(-0.5, 9);
    expect(panAfterDrag(0, -50, true)).toBeCloseTo(0.05, 9);
    expect(panAfterDrag(0.5, -1000, false)).toBe(1);
    expect(panAfterDrag(-0.5, 1000, false)).toBe(-1);
  });

  it("sticks in the middle and goes by hundredths", () => {
    expect(stuckPan(0.02, false)).toBe(0);
    expect(stuckPan(0.02, true)).toBe(0.02);
    expect(stuckPan(0.256, false)).toBe(0.26);
  });

  it("points straight up in the middle and to either side at the ends", () => {
    expect(knobAngle(0)).toBe(0);
    expect(knobAngle(-1)).toBe(-135);
    expect(knobAngle(1)).toBe(135);
    expect(knobAngle(0.5)).toBe(67.5);
  });
});

describe("the meters", () => {
  it("go from −60 dBFS at the bottom to full scale at the top", () => {
    expect(meterHeight(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterHeight(-70)).toBe(0);
    expect(meterHeight(METER_FLOOR)).toBe(0);
    expect(meterHeight(-30)).toBe(0.5);
    expect(meterHeight(0)).toBe(1);
    expect(meterHeight(3)).toBe(1);
  });

  it("are green, then yellow from −18 dBFS, then red from −6 dBFS", () => {
    expect(meterZone(-40)).toBe("low");
    expect(meterZone(-18.1)).toBe("low");
    expect(meterZone(-18)).toBe("mid");
    expect(meterZone(-6.1)).toBe("mid");
    expect(meterZone(-6)).toBe("high");
    expect(meterZone(0)).toBe("high");
    // The colours of the meter change where the zones do (MixerPanel.module.css).
    expect(meterHeight(-18)).toBeCloseTo(0.7, 9);
    expect(meterHeight(-6)).toBeCloseTo(0.9, 9);
  });

  it("jump up to a peak and fall back slowly", () => {
    expect(meterAfter(-40, -10, 0.03)).toBe(-10);
    expect(meterAfter(-10, -60, 0.5)).toBe(-10 - FALL_PER_SECOND * 0.5);
    expect(meterAfter(-59, Number.NEGATIVE_INFINITY, 1)).toBe(METER_FLOOR);
  });

  it("show loudness and peaks as numbers", () => {
    expect(levelText(-14.24)).toBe("−14.2");
    expect(levelText(undefined)).toBe("−∞");
    expect(levelText(Number.NEGATIVE_INFINITY)).toBe("−∞");
  });
});

describe("what the meters show", () => {
  const levels = (peaks: readonly number[], extra = {}) => ({
    tracks: ["a", "b"],
    peaks,
    left: 0.5,
    right: 0.25,
    truePeak: 0.6,
    shortTerm: -20,
    ...extra,
  });

  it("follows the audio thread, and drops to the bottom when playing stops", () => {
    const shown = new MixLevels();
    shown.receive(levels([0.5, 0]), 0);
    expect(shown.shownOf("a")).toBeCloseTo(-6.02, 2);
    expect(shown.shownOf("b")).toBe(METER_FLOOR);
    expect(shown.shownOf(MASTER_LEFT)).toBeCloseTo(-6.02, 2);
    expect(shown.shownOf(MASTER_RIGHT)).toBeCloseTo(-12.04, 2);
    expect(shown.shortTerm).toBe(-20);
    expect(shown.playing).toBe(true);
    // Quieter: it falls back at its pace.
    shown.receive(levels([0.01, 0]), 100);
    expect(shown.shownOf("a")).toBeCloseTo(-6.02 - FALL_PER_SECOND * 0.1, 2);
    shown.receive(undefined, 200);
    expect(shown.shownOf("a")).toBe(METER_FLOOR);
    expect(shown.shownOf(MASTER_LEFT)).toBe(METER_FLOOR);
    expect(shown.shortTerm).toBeUndefined();
    expect(shown.playing).toBe(false);
  });

  it("keeps a clip light on, and the largest true peak, until they are clicked", () => {
    const shown = new MixLevels();
    shown.receive(levels([CLIPPING, 0.999], { left: 1.2 }), 0);
    expect(shown.isClipped("a")).toBe(true);
    expect(shown.isClipped("b")).toBe(false);
    expect(shown.isClipped(MASTER_LEFT)).toBe(true);
    expect(shown.isClipped(MASTER_RIGHT)).toBe(false);
    expect(shown.truePeak).toBeCloseTo(20 * Math.log10(0.6), 9);
    shown.receive(levels([0.1, 0.1], { truePeak: 0.1 }), 33);
    shown.receive(undefined, 66);
    expect(shown.isClipped("a")).toBe(true);
    expect(shown.truePeak).toBeCloseTo(20 * Math.log10(0.6), 9);
    shown.resetClip("a");
    expect(shown.isClipped("a")).toBe(false);
    shown.resetTruePeak();
    expect(shown.truePeak).toBe(Number.NEGATIVE_INFINITY);
  });
});
