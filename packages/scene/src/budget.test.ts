import { describe, expect, it } from "vitest";
import { MESSAGE_RULES, MessageBudget, TokenBucket, weightOf } from "./budget.ts";

describe("TokenBucket", () => {
  it("allows a burst and then says no", () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(1, 0))).toEqual([true, true, true, false]);
  });

  it("fills up again at its rate, and no further than it holds", () => {
    const bucket = new TokenBucket(3, 2, 0);
    for (let round = 0; round < 3; round += 1) bucket.take(1, 0);
    expect(bucket.take(1, 400)).toBe(false);
    expect(bucket.take(1, 500)).toBe(true);
    expect(bucket.take(1, 500)).toBe(false);
    const results = [1, 2, 3, 4].map(() => bucket.take(1, 100000));
    expect(results).toEqual([true, true, true, false]);
  });

  it("does not charge for what it refused", () => {
    const bucket = new TokenBucket(5, 1, 0);
    expect(bucket.take(6, 0)).toBe(false);
    expect(bucket.take(5, 0)).toBe(true);
  });

  it("takes a clock that goes back without giving anything away", () => {
    const bucket = new TokenBucket(1, 1000, 100);
    bucket.take(1, 100);
    expect(bucket.take(1, 0)).toBe(false);
  });
});

describe("weightOf", () => {
  const big = 1000000;

  it("counts what messages are made of", () => {
    expect(weightOf("a".repeat(100), big)).toBeGreaterThanOrEqual(200);
    expect(weightOf({ a: "b".repeat(100) }, big)).toBeGreaterThanOrEqual(200);
    expect(weightOf([["c".repeat(100)]], big)).toBeGreaterThanOrEqual(200);
    expect(weightOf(new ArrayBuffer(1000), big)).toBeGreaterThanOrEqual(1000);
    expect(weightOf(new Uint32Array(1000), big)).toBeGreaterThanOrEqual(4000);
    expect(weightOf(new Blob(["x".repeat(1000)]), big)).toBeGreaterThanOrEqual(1000);
    expect(weightOf(new Map([["a", "b".repeat(100)]]), big)).toBeGreaterThanOrEqual(200);
    expect(weightOf(new Set(["b".repeat(100)]), big)).toBeGreaterThanOrEqual(200);
  });

  it("counts long keys too", () => {
    expect(weightOf({ ["k".repeat(1000)]: 1 }, big)).toBeGreaterThanOrEqual(2000);
  });

  it("gets to the limit without going through everything", () => {
    let reads = 0;
    const wide = new Proxy(
      Array.from({ length: 1000000 }, () => 0),
      {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(weightOf(wide, 1000)).toBeGreaterThan(1000);
    expect(reads).toBeLessThan(1000);
  });

  it("does not go in circles", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(weightOf(loop, 1000)).toBeGreaterThan(1000);
    const list = new Map<string, unknown>();
    list.set("self", list);
    expect(weightOf(list, 1000)).toBeGreaterThan(1000);
  });

  it("does not fall over deep structures", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100000; level += 1) deep = [deep];
    expect(weightOf(deep, 1000)).toBeGreaterThan(1000);
  });

  it("weighs next to nothing for what the protocol sends", () => {
    expect(weightOf({ type: "pong", nonce: 1 }, big)).toBeLessThan(500);
    expect(weightOf(undefined, big)).toBeGreaterThan(0);
  });
});

describe("MessageBudget", () => {
  const rules = {
    burstMessages: 10,
    messagesPerSecond: 5,
    maxMessageBytes: 1000,
    burstBytes: 3000,
    bytesPerSecond: 1000,
  };

  it("lets ordinary traffic through for as long as it goes on", () => {
    const budget = new MessageBudget(0);
    for (let at = 0; at < 600000; at += 16) {
      expect(budget.admit(at)).toBe("ok");
      expect(budget.weigh({ type: "position", frame: at }, at)).toBe("ok");
    }
  });

  it("calls too many messages a flood before anything looks at them", () => {
    const budget = new MessageBudget(0, rules);
    for (let count = 0; count < 10; count += 1) expect(budget.admit(0)).toBe("ok");
    expect(budget.admit(0)).toBe("flood");
  });

  it("forgives a burst after a while", () => {
    const budget = new MessageBudget(0, rules);
    for (let count = 0; count < 10; count += 1) budget.admit(0);
    expect(budget.admit(1000)).toBe("ok");
  });

  it("stops one big message at once, with everything still left", () => {
    const budget = new MessageBudget(0, rules);
    expect(budget.admit(0)).toBe("ok");
    expect(budget.weigh({ pad: "x".repeat(600) }, 0)).toBe("oversized");
  });

  it("counts what many medium messages add up to", () => {
    const budget = new MessageBudget(0, rules);
    const verdicts = [1, 2, 3, 4].map(() => budget.weigh({ pad: "x".repeat(400) }, 0));
    expect(verdicts.at(-1)).toBe("flood");
    expect(verdicts[0]).toBe("ok");
  });

  it("keeps each sender's account apart", () => {
    const noisy = new MessageBudget(0, rules);
    const quiet = new MessageBudget(0, rules);
    for (let count = 0; count < 100; count += 1) noisy.admit(0);
    expect(noisy.admit(0)).toBe("flood");
    expect(quiet.admit(0)).toBe("ok");
  });

  it("has room for everything the protocol can say in a burst", () => {
    const problem = {
      type: "problem",
      problem: {
        kind: "error",
        frame: 0,
        message: "m".repeat(2000),
        stack: "s".repeat(4000),
        target: "t".repeat(2000),
        file: "f".repeat(2000),
        code: "c".repeat(2000),
      },
    };
    expect(weightOf(problem, Number.MAX_SAFE_INTEGER)).toBeLessThan(MESSAGE_RULES.maxMessageBytes);
    const budget = new MessageBudget(0);
    for (let count = 0; count < 100; count += 1) {
      expect(budget.admit(0)).toBe("ok");
      expect(budget.weigh(problem, 0)).toBe("ok");
    }
  });
});
