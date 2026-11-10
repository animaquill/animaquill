import { describe, expect, it } from "vitest";
import { cleanMessage } from "./privacy.ts";

describe("messages", () => {
  it("costs little with many names, most of which could not be left anyway", () => {
    const secrets = new Set(
      Array.from({ length: 20_000 }, (_, index) => `素材 ${index} Clip number ${index}`),
    );
    const started = performance.now();
    for (let index = 0; index < 100; index++)
      cleanMessage(`e.at is not a function ${index}`, secrets);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
