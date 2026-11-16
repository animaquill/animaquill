import { describe, expect, it } from "vitest";
import { readableOn } from "./paint.ts";

describe("words and waveforms on a clip", () => {
  it("are in whichever of black and white stands out more on its colour", () => {
    // The colours of new clips: pictures, sound, captions, and those people get to choose from.
    expect(readableOn("#3f6fb5")).toBe("#ffffff");
    expect(readableOn("#3f9a7a")).toBe("#000000");
    expect(readableOn("#a8873f")).toBe("#000000");
    expect(readableOn("#8f5fb5")).toBe("#ffffff");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
  });
});
