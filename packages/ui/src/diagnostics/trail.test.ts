import { describe, expect, it } from "vitest";
import { TRAIL_LIMIT, Trail } from "./trail.ts";

const clock = () => {
  let now = 0;
  return { now: () => now, at: (ms: number) => (now = ms) };
};

describe("the black box", () => {
  it("keeps the last 200, oldest first", () => {
    const trail = new Trail();
    for (let index = 0; index < TRAIL_LIMIT + 50; index++) trail.add("action", { index });
    const entries = trail.entries();
    expect(TRAIL_LIMIT).toBe(200);
    expect(entries).toHaveLength(TRAIL_LIMIT);
    expect(entries[0]?.["index"]).toBe(50);
    expect(entries.at(-1)?.["index"]).toBe(TRAIL_LIMIT + 49);
  });

  it("says when, what and the names it was given", () => {
    const time = clock();
    const trail = new Trail(10, time.now);
    time.at(1234.4);
    trail.add("command", { name: "clip.move", ok: true, by: "user" });
    expect(trail.entries()).toEqual([
      { t: 1234, kind: "command", name: "clip.move", ok: true, by: "user" },
    ]);
  });

  it("takes in names and numbers only, never what people wrote", () => {
    const trail = new Trail();
    trail.add("panel", {
      id: "timeline",
      name: "我的项目",
      file: "scenes/intro.html",
      code: "document.body.innerHTML = 1",
      size: Number.NaN,
    });
    trail.add("我的项目");
    expect(trail.entries()).toEqual([
      {
        t: expect.any(Number),
        kind: "panel",
        id: "timeline",
        name: "?",
        file: "?",
        code: "?",
        size: "NaN",
      },
    ]);
  });

  it("puts a drag of the playhead in one line", () => {
    const time = clock();
    const trail = new Trail(10, time.now);
    for (let frame = 0; frame < 30; frame++) {
      time.at(frame * 16);
      trail.add("seek", { frame }, true);
    }
    expect(trail.entries()).toEqual([{ t: 464, kind: "seek", frame: 29, times: 30 }]);
  });

  it("keeps apart what only looks alike", () => {
    const time = clock();
    const trail = new Trail(10, time.now);
    trail.add("action", { id: "edit.undo" }, true);
    trail.add("action", { id: "edit.redo" }, true);
    trail.add("action", { id: "edit.redo" }, true);
    time.at(5000);
    trail.add("action", { id: "edit.redo" }, true);
    trail.add("action", { id: "edit.redo" });
    expect(trail.entries().map(({ id, times }) => [id, times])).toEqual([
      ["edit.undo", undefined],
      ["edit.redo", 2],
      ["edit.redo", undefined],
      ["edit.redo", undefined],
    ]);
  });

  it("hands out a copy", () => {
    const trail = new Trail();
    const before = trail.entries();
    trail.add("play");
    expect(before).toEqual([]);
  });
});
