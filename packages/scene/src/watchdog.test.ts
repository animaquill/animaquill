import { describe, expect, it } from "vitest";
import {
  Strikes,
  THROTTLED_ANSWER_MS,
  Watchdog,
  WATCHDOG_RULES,
  type WatchdogRules,
  type WatchdogVerdict,
} from "./watchdog.ts";

const { limitMs, pingEveryMs, seekLimitMs, seekStallMs, maxCheckGapMs } = WATCHDOG_RULES;
const TICK = 100;

/** A dog with a page that checks on it as it should, and answers every ping unless told not to. */
function setup(phase?: "loading" | "running") {
  const dog = new Watchdog(0);
  if (phase === "running") dog.enter("loading");
  if (phase) dog.enter(phase);
  let now = 0;
  let nonce = 1000;
  const verdicts: WatchdogVerdict[] = [];
  /** Lets time pass. `answer` says whether pings get answered. */
  const pass = (ms: number, { answer = true, visible = true } = {}) => {
    for (const end = now + ms; now < end;) {
      now += TICK;
      const verdict = dog.check(now, visible);
      verdicts.push(verdict);
      if (verdict === "ping") {
        nonce += 1;
        dog.pinged(nonce);
        if (answer) dog.answered(nonce);
      }
    }
    return verdicts.at(-1);
  };
  return {
    dog,
    pass,
    verdicts,
    skip: (ms: number) => {
      now += ms;
    },
    time: () => now,
    lastNonce: () => nonce,
  };
}

const lands = (verdicts: readonly WatchdogVerdict[], verdict: WatchdogVerdict) =>
  verdicts.includes(verdict);

describe("the rules", () => {
  it("wait longer than a throttled frame can take to answer", () => {
    for (const limit of Object.values(limitMs)) {
      expect(limit).toBeGreaterThan(THROTTLED_ANSWER_MS);
    }
    expect(THROTTLED_ANSWER_MS).toBe(2000);
  });

  it("refuse a limit that would take a hidden frame for a hung one", () => {
    const rules: WatchdogRules = {
      ...WATCHDOG_RULES,
      limitMs: { ...limitMs, running: 2000 },
    };
    expect(() => new Watchdog(0, rules)).toThrow();
  });

  it("let a throttled timer pass as a page that stands still", () => {
    expect(maxCheckGapMs).toBeLessThan(1000);
  });
});

describe("Watchdog", () => {
  describe("before it runs", () => {
    it("waits for the hello, and not for ever", () => {
      const { dog, pass, verdicts } = setup();
      expect(dog.phase).toBe("hello");
      pass(limitMs.hello);
      expect(lands(verdicts, "silent")).toBe(false);
      expect(pass(TICK)).toBe("silent");
    });

    it("does not ask a scene that cannot answer yet", () => {
      const { pass, verdicts } = setup("loading");
      pass(pingEveryMs * 3);
      expect(lands(verdicts, "ping")).toBe(false);
    });

    it("gives loading its own patience, from its start", () => {
      const { dog, pass, verdicts } = setup();
      pass(4000);
      dog.enter("loading");
      pass(limitMs.loading);
      expect(lands(verdicts, "silent")).toBe(false);
      expect(pass(TICK)).toBe("silent");
    });

    it("does not let anything but getting ready extend that", () => {
      const { dog, pass } = setup("loading");
      // Whatever a page says while it loads, this is the only way to get on.
      for (let round = 0; round < 1000; round += 1) dog.answered(round);
      expect(pass(limitMs.loading + TICK)).toBe("silent");
    });
  });

  describe("while it runs", () => {
    it("asks regularly, and no more often", () => {
      const { pass, verdicts } = setup("running");
      pass(5000);
      expect(verdicts.filter((verdict) => verdict === "ping")).toHaveLength(5000 / pingEveryMs);
    });

    it("is happy as long as pings get answered", () => {
      const { pass, verdicts } = setup("running");
      pass(120000);
      expect(lands(verdicts, "silent")).toBe(false);
    });

    it("calls a silent scene silent once the limit has passed, and not before", () => {
      const { pass, verdicts } = setup("running");
      pass(limitMs.running, { answer: false });
      expect(lands(verdicts, "silent")).toBe(false);
      expect(pass(TICK, { answer: false })).toBe("silent");
    });

    it("goes quiet when it stops answering for longer than a throttled frame takes", () => {
      const { dog, pass } = setup("running");
      pass(THROTTLED_ANSWER_MS, { answer: false });
      expect(dog.isQuiet).toBe(false);
      pass(TICK, { answer: false });
      expect(dog.isQuiet).toBe(true);
    });

    it("is not quiet any more after an answer", () => {
      const { dog, pass } = setup("running");
      pass(THROTTLED_ANSWER_MS + TICK, { answer: false });
      pass(pingEveryMs);
      expect(dog.isQuiet).toBe(false);
    });

    it("is not quiet for time nobody could have heard anything", () => {
      const { dog, pass } = setup("running");
      pass(THROTTLED_ANSWER_MS * 2, { answer: false, visible: false });
      expect(dog.isQuiet).toBe(false);
    });

    it("takes no answer but one to a ping that went out", () => {
      const { dog, pass, verdicts } = setup("running");
      for (let round = 0; round < 100; round += 1) {
        pass(limitMs.running / 100, { answer: false });
        expect(dog.answered(round)).toBe(false);
      }
      pass(TICK * 2, { answer: false });
      expect(lands(verdicts, "silent")).toBe(true);
    });

    it("does not take the same answer twice", () => {
      const { dog, pass, lastNonce, verdicts } = setup("running");
      pass(pingEveryMs);
      const nonce = lastNonce();
      for (let round = 0; round < 100; round += 1) {
        pass(limitMs.running / 100, { answer: false });
        dog.answered(nonce);
      }
      pass(TICK * 2, { answer: false });
      expect(lands(verdicts, "silent")).toBe(true);
    });

    it("takes the answer to an earlier ping, which may just be late", () => {
      const { dog, pass, lastNonce } = setup("running");
      pass(pingEveryMs, { answer: false });
      const early = lastNonce();
      pass(pingEveryMs, { answer: false });
      expect(dog.answered(early)).toBe(true);
    });
  });

  describe("while it seeks", () => {
    it("says what it is doing", () => {
      const { dog } = setup("running");
      expect(dog.phase).toBe("running");
      dog.seeking(100);
      expect(dog.phase).toBe("seeking");
      expect(dog.target).toBe(100);
      dog.settled();
      expect(dog.phase).toBe("running");
      expect(dog.target).toBeUndefined();
    });

    it("calls a scene stuck that answers and gets nowhere", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      pass(seekStallMs);
      expect(lands(verdicts, "stuck")).toBe(false);
      expect(pass(TICK)).toBe("stuck");
    });

    it("is happy as long as it gets further", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(1000);
      for (let frame = 1; frame <= 100; frame += 1) {
        pass(seekStallMs / 5);
        dog.progressed(frame);
      }
      expect(lands(verdicts, "stuck")).toBe(false);
    });

    it("does not take standing still for progress", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      dog.progressed(50);
      for (let round = 0; round < 12; round += 1) {
        pass(seekStallMs / 10);
        dog.progressed(50);
        dog.progressed(49);
      }
      expect(lands(verdicts, "stuck")).toBe(true);
    });

    it("does not take a claim past the target for progress", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      for (let round = 0; round < 12; round += 1) {
        pass(seekStallMs / 10);
        dog.progressed(1000 + round);
      }
      expect(lands(verdicts, "stuck")).toBe(true);
    });

    it("gives up in the end, however small the steps", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(Number.MAX_SAFE_INTEGER);
      for (let frame = 1; frame * (seekStallMs / 2) <= seekLimitMs + seekStallMs; frame += 1) {
        pass(seekStallMs / 2);
        dog.progressed(frame);
      }
      expect(lands(verdicts, "stuck")).toBe(true);
    });

    it("gives a new target time of its own, and keeps the limit of the whole thing", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      pass(seekStallMs - TICK);
      dog.seeking(200);
      pass(seekStallMs - TICK);
      expect(lands(verdicts, "stuck")).toBe(false);
    });

    it("goes on watching for silence meanwhile", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      pass(limitMs.running + TICK, { answer: false });
      expect(lands(verdicts, "silent")).toBe(true);
    });

    it("has nothing against a scene that got there", () => {
      const { dog, pass, verdicts } = setup("running");
      dog.seeking(100);
      dog.settled();
      pass(seekStallMs * 2);
      expect(lands(verdicts, "stuck")).toBe(false);
    });
  });

  describe("what does not count", () => {
    it("does not count time in which the page could not be seen", () => {
      const { pass, verdicts } = setup("running");
      pass(limitMs.running - TICK, { answer: false });
      pass(600000, { answer: false, visible: false });
      expect(lands(verdicts, "silent")).toBe(false);
      pass(TICK, { answer: false });
      expect(lands(verdicts, "silent")).toBe(false);
      pass(TICK * 2, { answer: false });
      expect(lands(verdicts, "silent")).toBe(true);
    });

    it("does not need a check at every moment of that", () => {
      const { pass, skip, verdicts } = setup("running");
      pass(TICK, { visible: false });
      skip(60000);
      pass(TICK, { answer: false });
      expect(lands(verdicts, "silent")).toBe(false);
    });

    it("does not ask while hidden", () => {
      const { pass, verdicts } = setup("running");
      pass(pingEveryMs * 10, { visible: false });
      expect(lands(verdicts, "ping")).toBe(false);
    });

    it("does not count the time the page itself stood still", () => {
      const { pass, skip, verdicts } = setup("running");
      pass(TICK);
      skip(limitMs.running * 10);
      pass(TICK * 3, { answer: false });
      expect(lands(verdicts, "silent")).toBe(false);
    });

    it("sees a laptop lid the same way, in every phase", () => {
      for (const phase of [undefined, "loading", "running"] as const) {
        const { dog, pass, skip, verdicts } = setup(phase);
        if (phase === "running") dog.seeking(10);
        pass(TICK);
        skip(3600000);
        pass(TICK * 3);
        expect(lands(verdicts, "silent")).toBe(false);
        expect(lands(verdicts, "stuck")).toBe(false);
      }
    });

    it("does not count a timer that only runs once a second", () => {
      const dog = new Watchdog(0);
      dog.enter("loading");
      dog.enter("running");
      const verdicts: WatchdogVerdict[] = [];
      for (let now = 1000; now <= 120000; now += 1000) verdicts.push(dog.check(now, true));
      expect(lands(verdicts, "silent")).toBe(false);
    });

    it("finds a real hang after all of that", () => {
      const { pass, skip, verdicts } = setup("running");
      skip(100000);
      pass(limitMs.running + TICK * 2, { answer: false });
      expect(lands(verdicts, "silent")).toBe(true);
    });
  });
});

describe("a frame that never answered yet", () => {
  it.each(["hello", "loading"] as const)("is not quiet while it is at %s", (phase) => {
    const { dog, pass } = setup(phase === "hello" ? undefined : phase);
    pass(limitMs[phase]);
    expect(dog.isQuiet).toBe(false);
  });
});

describe("Strikes", () => {
  it("gives up after hanging again and again", () => {
    const strikes = new Strikes(3, 1000);
    expect(strikes.hung(0)).toBe(true);
    expect(strikes.hung(1)).toBe(true);
    expect(strikes.hung(2)).toBe(false);
  });

  it("forgets when the scene has worked for a while", () => {
    const strikes = new Strikes(2, 1000);
    expect(strikes.hung(0)).toBe(true);
    strikes.worked(1000);
    expect(strikes.hung(1001)).toBe(true);
    expect(strikes.hung(1002)).toBe(false);
  });

  it("does not forget because of one answer right after", () => {
    const strikes = new Strikes(2, 1000);
    expect(strikes.hung(0)).toBe(true);
    strikes.worked(500);
    expect(strikes.hung(600)).toBe(false);
  });

  it("does not forgive a scene that answers and hangs, however often", () => {
    const strikes = new Strikes(3, 30000);
    const answers: boolean[] = [];
    for (let at = 0; at < 100000; at += 5000) {
      strikes.worked(at);
      answers.push(strikes.hung(at + 1));
    }
    expect(answers.slice(0, 3)).toEqual([true, true, false]);
  });

  it("works before anything went wrong", () => {
    const strikes = new Strikes(2, 1000);
    strikes.worked(0);
    expect(strikes.hung(1)).toBe(true);
  });
});
