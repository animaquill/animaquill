import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, Shuttle, rateText, type ShuttleTarget } from "./shuttle.ts";

function setup() {
  const steps: number[] = [];
  const target = {
    playingRate: undefined as number | undefined,
    play(rate: number) {
      target.playingRate = rate;
    },
    pause() {
      target.playingRate = undefined;
    },
    stepFrames(count: number) {
      steps.push(count);
    },
  } satisfies ShuttleTarget;
  return { target, steps, shuttle: new Shuttle(target) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("J, K and L", () => {
  it("doubles the speed with every press of L, up to eight times", () => {
    const { target, shuttle } = setup();
    const rates = [];
    for (let press = 0; press < 5; press++) {
      shuttle.forward();
      shuttle.forwardUp();
      rates.push(target.playingRate);
    }
    expect(rates).toEqual([1, 2, 4, 8, 8]);
  });

  it("does the same backwards with J", () => {
    const { target, shuttle } = setup();
    const rates = [];
    for (let press = 0; press < 5; press++) {
      shuttle.backward();
      shuttle.backwardUp();
      rates.push(target.playingRate);
    }
    expect(rates).toEqual([-1, -2, -4, -8, -8]);
  });

  it("goes back to normal speed the other way, as Premiere does", () => {
    const { target, shuttle } = setup();
    shuttle.forward();
    shuttle.forward();
    shuttle.forward();
    expect(target.playingRate).toBe(4);
    shuttle.backward();
    expect(target.playingRate).toBe(-1);
    shuttle.backward();
    expect(target.playingRate).toBe(-2);
    shuttle.forward();
    expect(target.playingRate).toBe(1);
  });

  it("starts at normal speed after playing as space plays", () => {
    const { target, shuttle } = setup();
    target.play(1);
    shuttle.forward();
    expect(target.playingRate).toBe(2);
  });

  it("stops with K", () => {
    const { target, shuttle } = setup();
    shuttle.forward();
    shuttle.forward();
    shuttle.stop();
    expect(target.playingRate).toBeUndefined();
    shuttle.stopUp();
    shuttle.forward();
    expect(target.playingRate).toBe(1);
  });

  it("moves one frame for a tap of L or J with K held", () => {
    const { target, steps, shuttle } = setup();
    shuttle.stop();
    shuttle.forward();
    shuttle.forwardUp();
    shuttle.forward();
    shuttle.forwardUp();
    shuttle.backward();
    shuttle.backwardUp();
    vi.advanceTimersByTime(HOLD_MS * 4);
    expect(steps).toEqual([1, 1, -1]);
    expect(target.playingRate).toBeUndefined();
  });

  it("plays at a quarter of the speed while L or J is held with K, and stops when it comes up", () => {
    const { target, steps, shuttle } = setup();
    shuttle.stop();
    shuttle.forward();
    vi.advanceTimersByTime(HOLD_MS);
    expect(steps).toEqual([1]);
    expect(target.playingRate).toBe(0.25);
    shuttle.forwardUp();
    expect(target.playingRate).toBeUndefined();

    shuttle.backward();
    vi.advanceTimersByTime(HOLD_MS);
    expect(target.playingRate).toBe(-0.25);
    // K coming up first ends it just as well.
    shuttle.stopUp();
    expect(target.playingRate).toBeUndefined();
    vi.advanceTimersByTime(HOLD_MS * 4);
    expect(target.playingRate).toBeUndefined();
  });

  it("does not play slowly once K came up before the hold was long enough", () => {
    const { target, shuttle } = setup();
    shuttle.stop();
    shuttle.forward();
    shuttle.stopUp();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(target.playingRate).toBeUndefined();
  });

  it("says how fast, and nothing about the direction forwards", () => {
    expect([2, 8, -1, -4, 0.25, -0.25].map(rateText)).toEqual([
      "2×",
      "8×",
      "−1×",
      "−4×",
      "1/4×",
      "−1/4×",
    ]);
  });
});
