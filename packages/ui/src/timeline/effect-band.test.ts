import { clipStateOf } from "@animaquill/core";
import type { Clip } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { effectBandOf } from "./effect-band.ts";

const clip = (effects: Clip["effects"]) =>
  clipStateOf(
    {
      id: "c",
      start: "10",
      duration: "4",
      source: { kind: "color", color: "#000000" },
      ...(effects && { effects }),
    } as Clip,
    "v",
  );

describe("the band of a clip with effects", () => {
  it("is nothing without effects, and all of the clip for one that says no time", () => {
    expect(effectBandOf(clip(undefined))).toBeUndefined();
    expect(effectBandOf(clip([{ id: "a", type: "blur" }]))).toEqual({
      spans: [[0, 4]],
      types: ["blur"],
      off: false,
    });
  });

  it("covers where any that is on works, as one band, with each kind once", () => {
    const band = effectBandOf(
      clip([
        { id: "a", type: "brightness", start: "0.5", end: "1.5" },
        { id: "b", type: "blur", start: "1", end: "2" },
        { id: "c", type: "blur", start: "3" },
        { id: "d", type: "crop", enabled: false },
        { id: "e", type: "contrast", start: "2", end: "2" },
      ]),
    );
    expect(band).toEqual({
      spans: [
        [0.5, 2],
        [3, 4],
      ],
      types: ["brightness", "blur"],
      off: false,
    });
  });

  it("shows where they would work, dimmed, when all are off", () => {
    const band = effectBandOf(clip([{ id: "a", type: "blur", end: "1", enabled: false }]));
    expect(band).toEqual({ spans: [[0, 1]], types: ["blur"], off: true });
  });
});
