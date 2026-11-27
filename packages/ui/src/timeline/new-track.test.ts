import type { TimelineState } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { buildModel } from "./model.ts";
import { besideBefore, newTrackNumber, sideOf } from "./new-track.ts";

const color = { kind: "color", color: "#000000" };

/** Tracks in this order in the project, and a clip on a track `gone` that is not there any more. */
function model(tracks: readonly (readonly [string, "video" | "audio" | "caption"])[]) {
  const state = {
    name: "主线",
    sections: { s: { id: "s", duration: "10", order: 0 } },
    tracks: Object.fromEntries(tracks.map(([id, kind], order) => [id, { id, kind, order }])),
    clips: { lost: { id: "lost", track: "gone", start: "0", duration: "1", source: color } },
    markers: {},
    overrides: {},
  } as unknown as TimelineState;
  return buildModel("main", state, "30");
}

const rowOf = (built: ReturnType<typeof model>, id: string) => {
  const row = built.rows.find((each) => each.id === id);
  if (!row) throw new Error("no row");
  return row;
};

describe("where a new track goes next to a row", () => {
  const built = model([
    ["v1", "video"],
    ["a1", "audio"],
    ["v2", "video"],
    ["c1", "caption"],
    ["a2", "audio"],
  ]);

  it("goes after a picture in the project to show above it, and in front of it to show below", () => {
    expect(besideBefore(built, rowOf(built, "v1"), "above")).toBe("a1");
    expect(besideBefore(built, rowOf(built, "v1"), "below")).toBe("v1");
    expect(besideBefore(built, rowOf(built, "v2"), "above")).toBe("c1");
    expect(besideBefore(built, rowOf(built, "c1"), "above")).toBe("a2");
    expect(besideBefore(built, rowOf(built, "c1"), "below")).toBe("c1");
  });

  it("goes the other way round for sound, which shows in the order of the project", () => {
    expect(besideBefore(built, rowOf(built, "a1"), "above")).toBe("a1");
    expect(besideBefore(built, rowOf(built, "a1"), "below")).toBe("v2");
    // The last track of all: the new one goes at the end.
    expect(besideBefore(built, rowOf(built, "a2"), "below")).toBeUndefined();
  });

  it("goes outermost next to a track that is gone", () => {
    const row = rowOf(built, "gone");
    expect(row.gone).toBe(true);
    // A picture: after the last picture, which shows on top of them.
    expect(besideBefore(built, row, "above")).toBe("c1");
    expect(besideBefore(built, row, "below")).toBe("c1");
  });

  it("numbers the new track among those of its kind by where it goes", () => {
    expect(newTrackNumber(built, "video", "v1")).toBe(1);
    expect(newTrackNumber(built, "video", "a1")).toBe(2);
    expect(newTrackNumber(built, "video", undefined)).toBe(3);
    expect(newTrackNumber(built, "audio", "a1")).toBe(1);
  });

  it("is above in the upper half of a row and below in the lower one", () => {
    const row = { top: 100, height: 40 };
    expect(sideOf(row, 100)).toBe("above");
    expect(sideOf(row, 119)).toBe("above");
    expect(sideOf(row, 120)).toBe("below");
    expect(sideOf(row, 139)).toBe("below");
  });
});
