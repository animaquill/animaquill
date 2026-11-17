import { compileChannel, sample, springOf, springProgress } from "@animaquill/core";
import { STEP_PRESETS, type Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNING,
  EASE_CHOICES,
  easeOf,
  presetOf,
  progressOf,
  springFor,
  springFrom,
  tuningOf,
  tuningOfSpring,
  type EaseTuning,
} from "./easing.ts";
import { KEY_EASED, KEY_HOLD, keyTableOf } from "./tables.ts";

/** A key with an ease, as setInterp writes it. */
function keyWith(tuned: Parameters<typeof easeOf>[0], tuning?: EaseTuning): Key {
  const { interp, ...rest } = easeOf(tuned, tuning) as { interp: Key["interp"] };
  return { time: "0", value: 0, interp, ...rest };
}

/** The same random numbers every run. */
function randomFrom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe("the presets people pick from", () => {
  it("are ten, the ones that were there first", () => {
    expect(EASE_CHOICES).toEqual([
      "linear",
      "hold",
      "easeIn",
      "easeOut",
      "easeInOut",
      "overshoot",
      "elastic",
      "bounce",
      "steps",
      "spring",
    ]);
  });

  it("are known by interp and name, whichever way they go", () => {
    const next: Key = { time: "1", value: 1 };
    for (const direction of ["in", "out", "inOut"] as const) {
      const tuning = { ...DEFAULT_TUNING, direction };
      for (const preset of ["elastic", "bounce"] as const) {
        const key = keyWith(preset, tuning);
        expect(presetOf(key, next)).toBe(preset);
        expect(tuningOf(key).direction).toBe(direction);
      }
    }
    for (const jump of ["start", "end"] as const) {
      const key = keyWith("steps", { ...DEFAULT_TUNING, jump, steps: 7 });
      expect(presetOf(key, next)).toBe("steps");
      expect(tuningOf(key)).toMatchObject({ jump, steps: 7 });
    }
    expect(presetOf(keyWith("spring"), next)).toBe("spring");
    expect(presetOf(keyWith("spring"), undefined)).toBe("spring");
  });

  it("are written as the project format has them, with only what is not its default", () => {
    expect(easeOf("elastic")).toEqual({ interp: "preset", preset: "elasticOut" });
    const tuned = { ...DEFAULT_TUNING, direction: "inOut", amplitude: 1.5 } as const;
    expect(easeOf("elastic", tuned)).toEqual({
      interp: "preset",
      preset: "elasticInOut",
      presetParams: { amplitude: 1.5 },
    });
    expect(easeOf("bounce", { ...DEFAULT_TUNING, direction: "in" })).toEqual({
      interp: "preset",
      preset: "bounceIn",
    });
    expect(easeOf("steps")).toEqual({
      interp: "preset",
      preset: "stepsEnd",
      presetParams: { steps: 4 },
    });
    expect(easeOf("spring").interp).toBe("spring");
  });

  it("are not what cannot be worked out: an unknown name, steps without steps, a broken spring", () => {
    const next: Key = { time: "1", value: 1 };
    expect(presetOf({ time: "0", value: 0, interp: "preset", preset: "wobble" }, next)).toBe(
      undefined,
    );
    expect(presetOf({ time: "0", value: 0, interp: "preset", preset: "stepsEnd" }, next)).toBe(
      undefined,
    );
    const broken = { stiffness: 1e300, damping: 1, mass: 1e-300 };
    expect(presetOf({ time: "0", value: 0, interp: "spring", spring: broken }, next)).toBe(
      undefined,
    );
  });

  it("are round for what eases and square for steps, as hold is", () => {
    const keys: Key[] = [
      keyWith("elastic"),
      { ...keyWith("bounce"), time: "1" },
      { ...keyWith("spring"), time: "2" },
      { ...keyWith("steps"), time: "3" },
      { ...keyWith("steps", { ...DEFAULT_TUNING, jump: "start" }), time: "4" },
      { time: "5", value: 1 },
    ];
    expect([...keyTableOf({ keys }).marks]).toEqual([
      KEY_EASED,
      KEY_EASED,
      KEY_EASED,
      KEY_HOLD,
      KEY_HOLD,
      0,
    ]);
    expect(STEP_PRESETS.size).toBe(2);
  });
});

describe("a spring of bounce and swing", () => {
  it("comes back the same from the three numbers it is saved as", () => {
    const random = randomFrom(7);
    for (let round = 0; round < 2000; round += 1) {
      const bounce = random();
      const swing = 0.01 + random() * 60;
      const back = tuningOfSpring(springFrom(bounce, swing));
      expect(Math.abs((back?.bounce ?? Infinity) - bounce)).toBeLessThan(1e-9);
      expect(Math.abs((back?.swing ?? Infinity) - swing) / swing).toBeLessThan(1e-9);
    }
  });

  it("reads a spring with a mass of its own as the same motion", () => {
    const back = tuningOfSpring({ stiffness: 400, damping: 16, mass: 4 });
    const [omega, zeta] = springOf({ stiffness: 400, damping: 16, mass: 4 }) ?? [];
    expect(back?.swing).toBeCloseTo((2 * Math.PI) / (omega as number), 12);
    expect(back?.bounce).toBeCloseTo(1 - (zeta as number), 12);
  });

  it("is at rest by the next key when people choose it, however long the stretch is", () => {
    for (const length of [1 / 60, 0.1, 1, 2.5, 7, 30]) {
      const spring = springFrom(DEFAULT_TUNING.bounce, springFor(length).swing);
      const [omega, zeta] = springOf(spring) ?? [Number.NaN, Number.NaN];
      // Right where the next key is, where it would jump.
      expect(Math.abs(1 - springProgress(omega, zeta, length))).toBeLessThan(0.001);
      // And it does bounce on the way, which the curve of the row shows as the stretch has it.
      const channel = compileChannel(
        {
          keys: [
            { time: "0", value: 0, interp: "spring", spring },
            { time: String(length), value: 1 },
          ],
        },
        "number",
      );
      if (!channel) throw new Error("no channel");
      const highest = Math.max(
        ...Array.from(
          { length: 200 },
          (_, step) => sample(channel, (length * step) / 200) as number,
        ),
      );
      expect(highest).toBeGreaterThan(1.05);
    }
  });
});

describe("the small curves", () => {
  it("go as the project format works it out", () => {
    expect(progressOf(easeOf("linear"), 0.3)).toBeCloseTo(0.3, 12);
    expect(progressOf(easeOf("hold"), 0.99)).toBe(0);
    const steps = easeOf("steps");
    expect([0.1, 0.3, 0.6, 0.9].map((share) => progressOf(steps, share))).toEqual([
      0, 0.25, 0.5, 0.75,
    ]);
    const bounceIn = easeOf("bounce", { ...DEFAULT_TUNING, direction: "in" });
    const bounceOut = easeOf("bounce");
    // In is Out played backwards.
    for (const share of [0.1, 0.4, 0.7]) {
      expect(progressOf(bounceIn, share)).toBeCloseTo(1 - progressOf(bounceOut, 1 - share), 12);
    }
  });
});
