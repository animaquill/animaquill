import { describe, expect, it } from "vitest";
import { fillRandom, randomUuid, seededRandom, seedOfFrame } from "./random.ts";

describe("seededRandom", () => {
  it("gives the same numbers for the same seed, forever", () => {
    const random = seededRandom(1);
    // Stored numbers: this may never change, or finished scenes would look different.
    expect([random(), random(), random()]).toEqual([
      0.11025513336062431, 0.9230146396439523, 0.5345051249023527,
    ]);
    const first = seededRandom(42);
    const second = seededRandom(42);
    for (let index = 0; index < 1000; index += 1) expect(first()).toBe(second());
  });

  it("gives other numbers for another seed", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("stays between 0 and 1 and spreads evenly", () => {
    const random = seededRandom(7);
    const buckets = Array.from({ length: 10 }, () => 0);
    let lowest = 1;
    let highest = 0;
    for (let index = 0; index < 100000; index += 1) {
      const value = random();
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
      const bucket = Math.floor(value * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThan(1);
    for (const count of buckets) expect(Math.abs(count - 10000)).toBeLessThan(500);
  });
});

describe("seedOfFrame", () => {
  it("gives every frame a seed of its own, the same each time", () => {
    const seeds = Array.from({ length: 1000 }, (_, frame) => seedOfFrame(1, frame));
    expect(new Set(seeds).size).toBe(1000);
    expect(seedOfFrame(1, 500)).toBe(seeds[500]);
  });

  it("depends on the seed of the scene", () => {
    expect(seedOfFrame(1, 500)).not.toBe(seedOfFrame(2, 500));
  });
});

describe("what looks like the crypto interface", () => {
  it("fills any typed array, whatever its window into the buffer", () => {
    const buffer = new ArrayBuffer(16);
    const view = new Uint32Array(buffer, 4, 2);
    expect(fillRandom(seededRandom(1), view)).toBe(view);
    expect(view.every((value) => value !== 0)).toBe(true);
    expect(new Uint32Array(buffer)[0]).toBe(0);
    expect(new Uint32Array(buffer)[3]).toBe(0);
  });

  it("makes a UUID of the right form, the same each time", () => {
    const uuid = randomUuid(seededRandom(1), fillRandom);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUuid(seededRandom(1), fillRandom)).toBe(uuid);
  });
});
