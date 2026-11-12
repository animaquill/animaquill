import { describe, expect, it } from "vitest";
import { followsAfterScroll, showsToLatest } from "./scroll.ts";

describe("following the newest", () => {
  it("lets go when people scroll up, and takes up again near the bottom", () => {
    // 1000 of content in a view of 400: the bottom is at 600.
    expect(followsAfterScroll(true, 600, 550, 400, 1000)).toBe(false);
    expect(followsAfterScroll(false, 300, 400, 400, 1000)).toBe(false);
    expect(followsAfterScroll(false, 400, 520, 400, 1000)).toBe(true);
    expect(followsAfterScroll(false, 100, 600, 400, 1000)).toBe(true);
  });

  it("offers to go to the newest only when there is more below", () => {
    expect(showsToLatest(0, 400, 300)).toBe(false);
    expect(showsToLatest(600, 400, 1000)).toBe(false);
    expect(showsToLatest(200, 400, 1000)).toBe(true);
  });
});
