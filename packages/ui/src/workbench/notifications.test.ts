import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifications } from "./notifications.ts";

describe("notifications", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("go by themselves, and stay when they must", () => {
    const list = new Notifications();
    list.push("goes");
    list.push("stays", { stays: true });
    vi.advanceTimersByTime(10_000);
    expect(list.getSnapshot().map(({ message }) => message)).toEqual(["stays"]);
  });

  it("wait while someone reads them, and go a few seconds after", () => {
    const list = new Notifications();
    const id = list.push("reading");
    list.hold(id);
    vi.advanceTimersByTime(60_000);
    expect(list.getSnapshot()).toHaveLength(1);
    list.release(id);
    vi.advanceTimersByTime(3_000);
    expect(list.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    expect(list.getSnapshot()).toHaveLength(0);
  });

  it("that stay are not given a time by being touched", () => {
    const list = new Notifications();
    const id = list.push("stays", { stays: true });
    list.hold(id);
    list.release(id);
    vi.advanceTimersByTime(60_000);
    expect(list.getSnapshot()).toHaveLength(1);
  });
});
