import { describe, expect, it } from "vitest";
import { OriginPool } from "./origins.ts";

const a = "https://a.test";
const b = "https://b.test";
const c = "https://c.test";
const box = "https://box.test";

describe("OriginPool", () => {
  it("gives every scene its own origin as long as there are enough", () => {
    const pool = new OriginPool([a, b, c], box);
    expect([pool.take(), pool.take(), pool.take()].toSorted()).toEqual([a, b, c]);
  });

  it("only shares when there are more scenes than origins, and then evenly", () => {
    const pool = new OriginPool([a, b], box);
    const taken = [pool.take(), pool.take(), pool.take(), pool.take()];
    expect(taken.filter((origin) => origin === a)).toHaveLength(2);
    expect(taken.filter((origin) => origin === b)).toHaveLength(2);
  });

  it("goes back to an origin that became free", () => {
    const pool = new OriginPool([a, b], box);
    pool.take();
    const second = pool.take();
    pool.give(second);
    expect(pool.take()).toBe(second);
  });

  it("does not put a new scene on the origin of the old one", () => {
    const pool = new OriginPool([a, b, c], box);
    const old = pool.take();
    for (let round = 0; round < 10; round += 1) {
      const next = pool.take(old);
      expect(next).not.toBe(old);
      pool.give(next);
    }
  });

  it("avoids that even when the origin would be free", () => {
    const pool = new OriginPool([a, b], box);
    expect(pool.take(a)).toBe(b);
    expect(pool.take(a)).toBe(b);
  });

  it("takes the only origin there is, rather than none", () => {
    const pool = new OriginPool([a], box);
    expect(pool.take(a)).toBe(a);
  });

  it("refuses to run scenes on the compositor's origin", () => {
    expect(() => new OriginPool([a, box], box)).toThrow();
  });

  it("refuses to work without origins", () => {
    expect(() => new OriginPool([], box)).toThrow();
  });

  it("keeps its count when something is given back twice", () => {
    const pool = new OriginPool([a, b], box);
    const first = pool.take();
    pool.give(first);
    pool.give(first);
    pool.give("https://nothing.test");
    expect([pool.take(), pool.take()].toSorted()).toEqual([a, b]);
  });
});
