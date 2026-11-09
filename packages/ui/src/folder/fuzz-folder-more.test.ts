import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { fuzzFolder } from "./fuzz-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** More seeds, in a file of their own so that they run at the same time as the others. */
describe("a project folder that the editor, other programs and the browser change at random", () => {
  it.each(Array.from({ length: 15 }, (_, index) => index + 16))(
    "loses nothing, takes nothing in twice, and ends up as the project: seed %i",
    async (seed) => {
      await fuzzFolder(seed);
    },
    60_000,
  );
});
