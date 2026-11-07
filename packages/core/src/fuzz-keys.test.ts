import {
  Animation as AnimationSchema,
  add,
  compare,
  formatTime,
  parseTime,
  type Animation,
  type Key,
  type PropertyValue,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  MAX_SPLIT_Y,
  MIN_SPLIT_Y,
  compileChannel,
  sample,
  secondsOf,
  type Channel,
} from "./curve.ts";
import { EASES, FUZZ, HOLD, randomFrom, type Random } from "./fuzz-support.ts";
import { applyEdit, type KeyEase } from "./property-edit.ts";

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("keys that move, seed %i", FUZZ, (seed) => {
  const moments = (count: number, random: Random) =>
    Array.from({ length: count }, () => `${random.int(40)}/${1 + random.int(4)}`);

  const randomKeys = (random: Random): Animation => {
    const seen = new Set<string>();
    const keys: Key[] = [];
    for (const time of moments(2 + random.int(10), random)) {
      const canonical = formatTime(parseTime(time));
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      keys.push({ time: canonical, value: keys.length, ...(random.chance(0.3) ? HOLD : {}) });
    }
    return {
      keys: keys.toSorted((a, b) => compare(parseTime(a.time), parseTime(b.time))),
    };
  };

  it("leaves them in order, each moment once, and each key with what it had", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 500; round += 1) {
      const before = randomKeys(random);
      const chosen = before.keys.filter(() => random.chance(0.4));
      if (chosen.length === 0) continue;
      const by = parseTime(`${random.int(20) - 10}/${1 + random.int(3)}`);
      const moves = chosen.map(({ time }) => ({
        from: time,
        to: formatTime(add(parseTime(time), by)),
      }));
      if (moves.some(({ to }) => to.startsWith("-"))) continue;
      const after = applyEdit(before, { op: "moveKey", moves }) as Animation;
      expect(AnimationSchema.safeParse(after).success).toBe(true);

      // What moved is there, by value, and what it landed on is what went.
      const landed = new Set(moves.map(({ to }) => to));
      const stayed = before.keys.filter((key) => !chosen.includes(key) && !landed.has(key.time));
      expect(after.keys).toHaveLength(chosen.length + stayed.length);
      for (const [index, key] of chosen.entries()) {
        const moved = after.keys.find(({ time }) => time === moves[index]?.to);
        expect(moved).toEqual({ ...key, time: moves[index]?.to });
      }
      for (const key of stayed) expect(after.keys).toContain(key);

      // All of it by the same time and back again comes to the same, as nothing got replaced.
      if (chosen.length !== before.keys.length) continue;
      const back = moves.map(({ from, to }) => ({ from: to, to: from }));
      expect(applyEdit(after, { op: "moveKey", moves: back })).toEqual(before);
    }
  });

  it("how keys go on stays valid, whatever order it gets set in", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 500; round += 1) {
      let value: PropertyValue = randomKeys(random);
      for (let step = 0; step < 6; step += 1) {
        const { keys } = value as Animation;
        const times = keys.filter(() => random.chance(0.5)).map(({ time }) => time);
        if (times.length === 0) continue;
        const ease = random.pick(EASES) as KeyEase;
        value = applyEdit(value, { op: "setInterp", times, ease }) as PropertyValue;
        expect(AnimationSchema.safeParse(value).success).toBe(true);
        for (const time of times) {
          const key = (value as Animation).keys.find((one) => one.time === time);
          expect(key?.interp ?? "linear").toBe(ease.interp);
        }
      }
    }
  });

  /** A handle as people write it, with a few digits. Beyond a reach of 1 it goes past what cuts allow. */
  const randomHandle = (random: Random, reach: number): [number, number] => [
    random.int(101) / 100,
    ((random.int(300) - 100) * reach) / 100,
  ];

  /** A stretch of a bezier from 0 to 100. */
  const randomStretch = (random: Random, reach: number): Animation => ({
    keys: [
      { time: "0", value: 0, interp: "bezier", out: randomHandle(random, reach) },
      { time: "4", value: 100, in: randomHandle(random, reach) },
    ],
  });

  /** A key somewhere in it: with what the curve shows there, as the diamond does, or with any value. */
  const randomKey = (random: Random, channel: Channel) => {
    const time = `${1 + random.int(399)}/100`;
    const there = sample(channel, secondsOf(time)) as number;
    const value = random.chance(0.5) ? there : random.int(4000) / 10 - 150;
    return { time, there, value };
  };

  /** The handles of keys, in the order they come. */
  const handlesOf = ({ keys }: Animation) => keys.flatMap((key) => [key.in, key.out]);

  it("a key that goes in keeps the curve or leaves the keys around it, and never swings far", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 400; round += 1) {
      const before = randomStretch(random, random.chance(0.5) ? 1 : 3);
      const channel = compileChannel(before, "number");
      if (!channel) throw new Error("no channel");
      const { time, there, value } = randomKey(random, channel);
      const after = applyEdit(before, { op: "setKey", time, value }) as Animation;
      expect(AnimationSchema.safeParse(after).success).toBe(true);
      const split = compileChannel(after, "number");
      if (!split) throw new Error("no channel");
      expect(sample(split, secondsOf(time))).toBeCloseTo(value, 6);
      const [first, added, last] = after.keys as [Key, Key, Key];
      if (added.interp !== "bezier") {
        // What could not keep its shape leaves the others as they were, and is a linear key.
        expect(first).toEqual(before.keys[0]);
        expect(last).toEqual(before.keys[1]);
        expect(added).toEqual({ time, value });
        continue;
      }
      // Whatever value went in, nothing it wrote reaches further than easing does.
      for (const handle of [first.out, added.in, added.out, last.in]) {
        const [x, y] = handle ?? [1, 1];
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(MIN_SPLIT_Y);
        expect(y).toBeLessThanOrEqual(MAX_SPLIT_Y);
      }
      if (value !== there) continue;
      for (const clock of [0.2, 1, 1.9, 2.1, 3, 3.8]) {
        expect(sample(split, clock)).toBeCloseTo(sample(channel, clock) as number, 5);
      }
    }
  });

  it("a key that goes in and comes out again leaves what was there, digit for digit", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 400; round += 1) {
      const before = randomStretch(random, random.chance(0.5) ? 1 : 3);
      const channel = compileChannel(before, "number");
      if (!channel) throw new Error("no channel");
      const { time, value } = randomKey(random, channel);
      const op = random.chance(0.5) ? "setKey" : "write";
      const added = applyEdit(before, { op, time, value });
      expect(applyEdit(added, { op: "removeKey", time })).toEqual(before);
    }
  });

  /** Three keys that go in one after the other, with what was there or with anything. */
  const threeIn = (random: Random) => {
    const before = randomStretch(random, 1);
    const steps: { time: string; value: PropertyValue }[] = [];
    let value: PropertyValue = before;
    for (let step = 0; step < 3; step += 1) {
      const channel = compileChannel(value, "number");
      if (!channel) throw new Error("no channel");
      const key = randomKey(random, channel);
      if ((value as Animation).keys.some(({ time }) => time === key.time)) continue;
      value = applyEdit(value, { op: "setKey", time: key.time, value: key.value }) as PropertyValue;
      steps.push({ time: key.time, value });
    }
    return { before, steps, value };
  };

  /** Keys that are the same, with handles that floats cannot tell apart. */
  const expectSameKeys = (found: PropertyValue | undefined, wanted: PropertyValue) => {
    const keys = (found as Animation).keys;
    expect(keys.map(({ time, value, interp }) => ({ time, value, interp }))).toEqual(
      (wanted as Animation).keys.map(({ time, value, interp }) => ({ time, value, interp })),
    );
    const handles = handlesOf(wanted as Animation);
    for (const [index, handle] of handlesOf(found as Animation).entries()) {
      const other = handles[index];
      expect(handle === undefined).toBe(other === undefined);
      for (const [axis, number] of (handle ?? []).entries()) {
        expect(number).toBeCloseTo(other?.[axis] as number, 7);
      }
    }
  };

  it("keys that went in come out again the other way around, and leave what was there", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 200; round += 1) {
      const { before, steps } = threeIn(random);
      let value = steps.at(-1)?.value ?? before;
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const earlier = index === 0 ? before : (steps[index - 1] as (typeof steps)[number]).value;
        value = applyEdit(value, {
          op: "removeKey",
          time: (steps[index] as (typeof steps)[number]).time,
        }) as PropertyValue;
        // What a cut wrote keeps all of its digits, which come back as close as a join tidies.
        expectSameKeys(value, earlier);
      }
      // What people wrote comes back digit for digit.
      expect(value).toEqual(before);
    }
  });

  it("keys that went in come out in any order, and leave nothing that swings far", () => {
    const random = randomFrom(seed);
    for (let round = 0; round < 200; round += 1) {
      const { before, steps, value: all } = threeIn(random);
      const changed = new Set(handlesOf(before).map((handle) => JSON.stringify(handle)));
      let value = all;
      for (const { time } of steps.toSorted(() => (random.chance(0.5) ? 1 : -1))) {
        value = applyEdit(value, { op: "removeKey", time }) as PropertyValue;
        expect(AnimationSchema.safeParse(value).success).toBe(true);
        for (const handle of handlesOf(value as Animation)) {
          if (handle === undefined || changed.has(JSON.stringify(handle))) continue;
          expect(handle[1]).toBeGreaterThanOrEqual(MIN_SPLIT_Y);
          expect(handle[1]).toBeLessThanOrEqual(MAX_SPLIT_Y);
        }
      }
      expect((value as Animation).keys.map(({ time }) => time)).toEqual(["0", "4"]);
    }
  });
});
