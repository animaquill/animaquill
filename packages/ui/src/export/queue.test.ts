import { describe, expect, it } from "vitest";
import { ExportQueue, Pace, statusAfterReload, type QueueEntry } from "./queue.ts";

const entry = (id: string, order: number, changes: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  project: "p",
  name: `${id}.mp4`,
  status: "waiting",
  order,
  done: 0,
  total: 100,
  ...changes,
});

describe("the line of exports", () => {
  it("is in the order people asked, whatever order the entries came in", () => {
    const queue = new ExportQueue();
    queue.put(entry("c", 3));
    queue.put(entry("a", 1));
    queue.put(entry("b", 2));
    expect(queue.getSnapshot().map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(queue.next()?.id).toBe("a");
  });

  it("runs one at a time: while one runs, none is next", () => {
    const queue = new ExportQueue();
    queue.put(entry("a", 1, { status: "running" }));
    queue.put(entry("b", 2));
    expect(queue.next()).toBeUndefined();
    queue.update("a", { status: "done" });
    expect(queue.next()?.id).toBe("b");
  });

  it("passes over what is paused, failed or cannot go now, without being held up by it", () => {
    const queue = new ExportQueue();
    queue.put(entry("a", 1, { status: "paused" }));
    queue.put(entry("b", 2, { status: "failed" }));
    queue.put(entry("c", 3, { project: "closed" }));
    queue.put(entry("d", 4));
    expect(queue.next(({ project }) => project === "p")?.id).toBe("d");
  });

  it("puts one that goes on again back where it was, in front of those that came later", () => {
    const queue = new ExportQueue();
    queue.put(entry("a", 1, { status: "running" }));
    queue.put(entry("b", 2, { status: "paused" }));
    queue.put(entry("c", 3));
    expect(queue.ahead("c")).toBe(1);
    queue.update("b", { status: "waiting" });
    expect(queue.ahead("b")).toBe(1);
    expect(queue.ahead("c")).toBe(2);
    queue.update("a", { status: "done" });
    expect(queue.next()?.id).toBe("b");
  });

  it("does not count what came from before a reload as in line, until people say so", () => {
    const queue = new ExportQueue();
    queue.put(entry("a", 1, { restored: true }));
    queue.put(entry("b", 2));
    expect(queue.waiting()).toBe(1);
    expect(queue.ahead("b")).toBe(0);
  });

  it("gives every new one a place after all others, also after those of a page before", () => {
    const queue = new ExportQueue();
    queue.put(entry("old", 5_000));
    expect(queue.nextOrder(1_000)).toBe(5_001);
    expect(queue.nextOrder(1_000)).toBe(5_002);
    expect(queue.nextOrder(9_000)).toBe(9_000);
  });

  it("says only what is true now of an entry", () => {
    const queue = new ExportQueue();
    queue.put(entry("a", 1, { status: "failed", failure: "没有素材" }));
    queue.update("a", { status: "waiting", failure: undefined });
    expect(queue.get("a")).not.toHaveProperty("failure");
  });

  it("takes one that was running when the page went for interrupted, and keeps the others", () => {
    expect(statusAfterReload({ status: "running", order: 1 })).toBe("interrupted");
    expect(statusAfterReload(undefined)).toBe("interrupted");
    expect(statusAfterReload({ status: "waiting", order: 1 })).toBe("waiting");
    expect(statusAfterReload({ status: "paused", order: 1 })).toBe("paused");
    expect(statusAfterReload({ status: "failed", order: 1 })).toBe("failed");
  });
});

describe("how long the rest of an export takes", () => {
  it("goes by how fast the frames went", () => {
    const pace = new Pace(0, 0);
    expect(pace.remainingMs(1000, 5, 100, 10)).toBeUndefined();
    expect(pace.remainingMs(1000, 10, 100, 10)).toBe(9000);
  });

  it("leaves out what it waited for, which says nothing about how fast it goes", () => {
    const pace = new Pace(0, 0);
    pace.wait("sound", true, 500);
    // Waiting for a minute, and two things at once count once.
    pace.wait("media", true, 10_000);
    pace.wait("sound", false, 30_000);
    expect(pace.waiting).toBe(true);
    pace.wait("media", false, 60_500);
    expect(pace.waiting).toBe(false);
    expect(pace.remainingMs(61_000, 10, 100, 10)).toBe(9000);
  });

  it("does not count a wait that is still going on either", () => {
    const pace = new Pace(0, 0);
    pace.wait("hidden", true, 1000);
    expect(pace.remainingMs(100_000, 10, 100, 10)).toBe(9000);
  });

  it("starts over after a pause", () => {
    const pace = new Pace(0, 0);
    pace.restart(50_000, 40);
    expect(pace.remainingMs(52_000, 60, 100, 10)).toBe(4000);
  });
});
