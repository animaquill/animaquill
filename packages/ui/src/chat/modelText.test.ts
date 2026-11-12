import { describe, expect, it } from "vitest";
import { contextLabel, initialOf, priceLabel } from "./modelText.ts";

describe("what the settings write of models", () => {
  it("is short", () => {
    expect(contextLabel(200_000)).toBe("200k");
    expect(contextLabel(1_000_000)).toBe("1M");
    expect(contextLabel(1_050_000)).toBe("1.05M");
    expect(contextLabel(131_072)).toBe("131.1k");
    expect(contextLabel(512)).toBe("512");
    expect(contextLabel(undefined)).toBeUndefined();
    expect(priceLabel(5)).toBe("5");
    expect(priceLabel(0.25)).toBe("0.25");
    expect(priceLabel(1.3216)).toBe("1.32");
    expect(priceLabel(150)).toBe("150");
    expect(initialOf("通义千问")).toBe("通");
    expect(initialOf("anthropic")).toBe("A");
    expect(initialOf(" ")).toBe("?");
  });
});
