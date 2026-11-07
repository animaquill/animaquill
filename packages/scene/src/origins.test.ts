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
    const second = pool.take() as string;
    pool.give(second);
    expect(pool.take()).toBe(second);
  });

  it("does not put a new scene on the origin of the old one", () => {
    const pool = new OriginPool([a, b, c], box);
    const old = pool.take();
    for (let round = 0; round < 10; round += 1) {
      const next = pool.take(old) as string;
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

  it("never hands out an origin that retired, also not when that is free", () => {
    const pool = new OriginPool([a, b, c], box);
    const hung = pool.take() as string;
    pool.retire(hung);
    pool.give(hung);
    for (let round = 0; round < 10; round += 1) {
      const next = pool.take() as string;
      expect(next).not.toBe(hung);
      pool.give(next);
    }
  });

  it("keeps it out when it was given back first, which is how a frame goes", () => {
    const pool = new OriginPool([a, b], box);
    pool.give(pool.take() as string);
    pool.retire(a);
    expect([pool.take(), pool.take()]).toEqual([b, b]);
  });

  it("shares what is left rather than come back to a retired origin", () => {
    const pool = new OriginPool([a, b], box);
    pool.retire(a);
    expect(pool.take(b)).toBe(b);
    expect(pool.take()).toBe(b);
  });

  it("has nothing to hand out when all of them retired, whatever it is asked", () => {
    const pool = new OriginPool([a, b], box);
    pool.retire(a);
    pool.retire(b);
    expect(pool.take()).toBeUndefined();
    expect(pool.take(a)).toBeUndefined();
  });

  it("says so once, for whoever makes the next pool", () => {
    const retired: string[] = [];
    const pool = new OriginPool([a, b], box, { onRetire: (origin) => retired.push(origin) });
    pool.retire(a);
    pool.retire(a);
    expect(retired).toEqual([a]);
  });

  it("starts from what a pool before it knew, without saying that again", () => {
    const retired: string[] = [];
    const pool = new OriginPool([a, b], box, {
      retired: [a],
      onRetire: (origin) => retired.push(origin),
    });
    pool.retire(a);
    expect([pool.take(), pool.take()]).toEqual([b, b]);
    expect(retired).toEqual([]);
  });

  it("keeps its count when something is given back twice", () => {
    const pool = new OriginPool([a, b], box);
    const first = pool.take() as string;
    pool.give(first);
    pool.give(first);
    pool.give("https://nothing.test");
    expect([pool.take(), pool.take()].toSorted()).toEqual([a, b]);
  });
});
