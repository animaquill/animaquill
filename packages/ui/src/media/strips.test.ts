import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripMaker } from "./strips.ts";

type Listener = (event: unknown) => void;

let listeners: Listener[] = [];
let frame: { contentWindow: { postMessage: () => void } } & Record<string, unknown>;

beforeEach(() => {
  listeners = [];
  frame = { contentWindow: { postMessage: vi.fn() }, setAttribute: vi.fn() };
  vi.stubGlobal("addEventListener", (_: string, listener: Listener) => listeners.push(listener));
  vi.stubGlobal("removeEventListener", (_: string, listener: Listener) => {
    listeners = listeners.filter((known) => known !== listener);
  });
  vi.stubGlobal("document", { createElement: () => frame, body: { append: () => {} } });
});

afterEach(() => vi.unstubAllGlobals());

/** A message that goes off when somebody looks at what is in it. */
function trap(source: unknown, data: unknown) {
  let reads = 0;
  const event = {
    source,
    get data() {
      reads += 1;
      return data;
    },
  };
  return { event, reads: () => reads };
}

const say = (event: unknown) => {
  for (const listener of listeners) listener(event);
};

describe("a strip maker waiting for its compositor", () => {
  it("leaves what comes from anybody else unread, because reading builds a message", async () => {
    void new StripMaker("/compositor.html").make(new Blob([]), 8);
    const { event, reads } = trap({}, { type: "ready" });
    say(event);
    expect(reads()).toBe(0);
    expect(listeners).toHaveLength(1);
  });

  it("goes on when its compositor said hello", async () => {
    const maker = new StripMaker("/compositor.html");
    const made = maker.make(new Blob([]), 8);
    say({ source: frame.contentWindow, data: { type: "ready" } });
    await vi.waitFor(() => expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(1));
    const { event, reads } = trap({}, { type: "strip", request: 1, image: undefined });
    say(event);
    expect(reads()).toBe(0);
    say({ source: frame.contentWindow, data: { type: "strip", request: 1, image: undefined } });
    expect(await made).toBeUndefined();
  });
});
