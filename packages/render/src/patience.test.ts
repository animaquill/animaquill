import { describe, expect, it } from "vitest";
import { GiveUpTimer, SECOND_CHANCE_MS, SETTLE_MS, type Wait } from "./patience.ts";

/** A clock that only moves when the test says so. */
function setup(found = true) {
  let now = 0;
  let pending: { at: number; run: () => void }[] = [];
  const wait: Wait = (milliseconds, run) => {
    const entry = { at: now + milliseconds, run };
    pending.push(entry);
    return () => {
      pending = pending.filter((candidate) => candidate !== entry);
    };
  };
  const state = { givenUp: 0, found };
  const timer = new GiveUpTimer(wait, () => {
    if (state.found) state.givenUp += 1;
    return state.found;
  });
  const pass = (milliseconds: number) => {
    now += milliseconds;
    const due = pending.filter(({ at }) => at <= now);
    pending = pending.filter(({ at }) => at > now);
    for (const { run } of due) run();
  };
  return { timer, pass, state };
}

describe("giving up a read", () => {
  it("waits while the playhead keeps moving, however long that takes", () => {
    const { timer, pass, state } = setup();
    for (let move = 0; move < 1000; move += 1) {
      timer.jumped();
      pass(SETTLE_MS - 1);
    }
    expect(state.givenUp).toBe(0);
  });

  it("happens soon after the playhead comes to rest", () => {
    const { timer, pass, state } = setup();
    timer.jumped();
    pass(SETTLE_MS);
    expect(state.givenUp).toBe(1);
  });

  it("happens once for a rest", () => {
    const { timer, pass, state } = setup();
    timer.jumped();
    pass(SECOND_CHANCE_MS * 10);
    expect(state.givenUp).toBe(1);
  });

  it("lets the next read finish when slow steps look like rests", () => {
    const { timer, pass, state } = setup();
    for (let step = 0; step < 100; step += 1) {
      timer.jumped();
      pass(SETTLE_MS + 100);
    }
    expect(state.givenUp).toBe(1);
  });

  it("still gets past a read that never finishes", () => {
    const { timer, pass, state } = setup();
    timer.jumped();
    pass(SETTLE_MS);
    timer.jumped();
    pass(SECOND_CHANCE_MS);
    timer.jumped();
    pass(SECOND_CHANCE_MS);
    expect(state.givenUp).toBe(3);
  });

  it("is quick again once a frame came", () => {
    const { timer, pass, state } = setup();
    timer.jumped();
    pass(SETTLE_MS);
    timer.drew();
    timer.jumped();
    pass(SETTLE_MS);
    expect(state.givenUp).toBe(2);
  });

  it("stays quick when there was nothing to give up", () => {
    const { timer, pass, state } = setup(false);
    timer.jumped();
    pass(SETTLE_MS);
    state.found = true;
    timer.jumped();
    pass(SETTLE_MS);
    expect(state.givenUp).toBe(1);
  });
});
