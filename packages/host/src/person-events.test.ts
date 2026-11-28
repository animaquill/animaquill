import { describe, expect, test, vi } from "vitest";
import { browserPersonEvents, type EventSourceLike } from "./person-events.ts";

/** An `EventSource` the test speaks for. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  readonly #listeners = new Map<string, ((event?: { data?: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event?: { data?: unknown }) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, readyState = this.readyState, data?: string) {
    this.readyState = readyState;
    for (const listener of this.#listeners.get(type) ?? [])
      listener(data === undefined ? undefined : { data });
  }
}

describe("what changed of the person's list, as the platform says it", () => {
  test("tells each change, once more as the stream comes again, and whether it is there", () => {
    vi.useFakeTimers();
    try {
      const opened: FakeSource[] = [];
      const events = browserPersonEvents({
        url: "/api/me/events",
        open: (url) => {
          expect(url).toBe("/api/me/events");
          const source = new FakeSource();
          opened.push(source);
          return source;
        },
        againMs: 1000,
      });
      const changed: number[] = [];
      const live: boolean[] = [];
      const stop = events.watch(
        () => changed.push(1),
        (now) => live.push(now),
      );
      const [first] = opened;
      first!.emit("ready", 1);
      first!.emit("message");
      expect(changed).toHaveLength(2);
      expect(live).toEqual([true]);
      // It broke: the browser comes again by itself, and tells what was missed as it does.
      first!.emit("error", 0);
      expect(live).toEqual([true, false]);
      first!.emit("ready", 1);
      expect(changed).toHaveLength(3);
      // The platform said no: tried again after a while, with a stream of its own.
      first!.emit("error", 2);
      expect(first!.closed).toBe(true);
      expect(opened).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(opened).toHaveLength(2);
      // The old one says nothing any more.
      first!.emit("message");
      expect(changed).toHaveLength(3);
      opened[1]!.emit("ready", 1);
      expect(changed).toHaveLength(4);
      stop();
      expect(opened[1]!.closed).toBe(true);
      opened[1]!.emit("error", 2);
      vi.advanceTimersByTime(5000);
      expect(opened).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("one stream for all that watch: each hears what the person's conversations say, and a late one that it is there", async () => {
    const opened: FakeSource[] = [];
    const events = browserPersonEvents({
      url: "/api/me/events",
      open: () => {
        const source = new FakeSource();
        opened.push(source);
        return source;
      },
    });
    const first: unknown[] = [];
    const stopFirst = events.watch(
      () => {},
      undefined,
      (data) => first.push(data),
    );
    opened[0]!.emit("ready", 1);
    const second: unknown[] = [];
    const live: boolean[] = [];
    let read = 0;
    const stopSecond = events.watch(
      () => read++,
      (now) => live.push(now),
      (data) => second.push(data),
    );
    await Promise.resolve();
    expect(opened).toHaveLength(1);
    expect(live).toEqual([true]);
    expect(read).toBe(1);
    opened[0]!.emit("agents", 1, JSON.stringify({ p: "p1", k: "mail", to: "chat-b" }));
    // What cannot be read, or says nothing, is heard by none.
    opened[0]!.emit("agents", 1, "{not json");
    opened[0]!.emit("agents", 1);
    expect(first).toEqual([{ p: "p1", k: "mail", to: "chat-b" }]);
    expect(second).toEqual(first);
    stopFirst();
    expect(opened[0]!.closed).toBe(false);
    stopSecond();
    expect(opened[0]!.closed).toBe(true);
  });
});
