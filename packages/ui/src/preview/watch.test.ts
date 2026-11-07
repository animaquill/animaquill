import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSITOR_RULES, CompositorWatch } from "./watch.ts";

function setup() {
  const pings: number[] = [];
  const silent = vi.fn();
  const watch = new CompositorWatch((nonce) => pings.push(nonce), silent);
  return { watch, pings, silent };
}

const visibility = { visibilityState: "visible" };

beforeEach(() => {
  vi.useFakeTimers();
  visibility.visibilityState = "visible";
  vi.stubGlobal("document", visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watching the compositor", () => {
  it("gives a page that loads time, for a slow network", () => {
    const { silent } = setup();
    vi.advanceTimersByTime(COMPOSITOR_RULES.limitMs.hello - 1000);
    expect(silent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("asks a running one whether it is there, and is happy with an answer", () => {
    const { watch, pings, silent } = setup();
    watch.ready();
    for (let round = 0; round < 200; round += 1) {
      vi.advanceTimersByTime(200);
      for (const nonce of pings.splice(0)) watch.pong(nonce);
    }
    expect(silent).not.toHaveBeenCalled();
    watch.dispose();
  });

  it("notices one that stopped answering, once", () => {
    const { watch, silent } = setup();
    watch.ready();
    vi.advanceTimersByTime(COMPOSITOR_RULES.limitMs.running + 1000);
    expect(silent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("an answer to nothing does not count", () => {
    const { watch, silent } = setup();
    watch.ready();
    for (let round = 0; round < 100; round += 1) {
      vi.advanceTimersByTime(200);
      watch.pong(12345);
    }
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("does not count while the page is hidden, when the browser holds everything back", () => {
    const { watch, silent } = setup();
    watch.ready();
    visibility.visibilityState = "hidden";
    vi.advanceTimersByTime(60000);
    expect(silent).not.toHaveBeenCalled();
    watch.dispose();
  });

  it("stops when it is told to", () => {
    const { watch, silent } = setup();
    watch.dispose();
    vi.advanceTimersByTime(120000);
    expect(silent).not.toHaveBeenCalled();
  });
});
