import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { fuzzFolder } from "./fuzz-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a project folder that the editor, other programs and the browser change at random", () => {
  it.each(Array.from({ length: 30 }, (_, index) => index + 1))(
    "loses nothing, takes nothing in twice, and ends up as the project: seed %i",
    async (seed) => {
      await fuzzFolder(seed);
    },
  );
});
