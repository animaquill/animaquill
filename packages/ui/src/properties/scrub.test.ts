import { BUILT_IN_PROPERTIES, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { formatNumber, parseNumber, scrubbed } from "./scrub.ts";

const spec = (path: string) => BUILT_IN_PROPERTIES[path] as PropertySpec;
const x = spec("transform.x");
const rotation = spec("transform.rotation");
const opacity = spec("opacity");
const anchor = spec("transform.anchorX");
const width = spec("transform.width");
const scale = spec("transform.scale");

const plain = { shift: false, alt: false };

describe("showing a number", () => {
  it.each([
    [x, 0, "0"],
    [x, -120.5, "-120.5"],
    [x, 1 / 3, "0.33"],
    [x, 100, "100"],
    [rotation, 720, "720°"],
    [rotation, 12.345, "12.35°"],
    [opacity, 1, "100%"],
    [opacity, 0.5, "50%"],
    [opacity, 0.12345, "12.35%"],
    [scale, 1.5, "150%"],
    [anchor, 0.5, "50%"],
  ])("%#", (property, value, text) => {
    expect(formatNumber(value, property)).toBe(text);
  });
});

describe("typing a number", () => {
  it.each([
    [x, "120", 120],
    [x, " -40.5 ", -40.5],
    [x, "１２．５", 12.5],
    [x, "−30", -30],
    [x, "1e3", 1000],
    [rotation, "45°", 45],
    [rotation, "45", 45],
    [opacity, "50", 0.5],
    [opacity, "50%", 0.5],
    [opacity, "37.5 %", 0.375],
    [scale, "200", 2],
  ])("%#", (property, text, value) => {
    expect(parseNumber(text, property)).toBe(value);
  });

  it.each(["", "   ", "很多", "12px", "1,5", "NaN", "Infinity"])("%j is no number", (text) => {
    expect(parseNumber(text, x)).toBeUndefined();
  });

  it("takes what is too much as the limit", () => {
    expect(parseNumber("150", opacity)).toBe(1);
    expect(parseNumber("-10", opacity)).toBe(0);
    expect(parseNumber("-10", width)).toBe(0);
  });

  it("goes beyond what is only a suggestion", () => {
    expect(parseNumber("150", anchor)).toBe(1.5);
  });

  it("keeps float noise out of the project", () => {
    expect(parseNumber("33.3", opacity)).toBe(0.333);
    expect(parseNumber("7", opacity)).toBe(0.07);
  });
});

describe("dragging a number", () => {
  it.each([
    ["a world unit for a pixel", x, 10, 20, 30],
    ["a degree for a pixel", rotation, 0, -45, -45],
    ["a percent for a pixel", opacity, 0.5, -20, 0.3],
    ["a percent of size for a pixel", scale, 1, 50, 1.5],
  ])("%s", (_, property, start, pixels, value) => {
    expect(scrubbed(property, start, pixels, plain)).toBeCloseTo(value, 9);
  });

  it("goes faster with Shift and finer with Alt", () => {
    expect(scrubbed(x, 0, 5, { shift: true, alt: false })).toBe(50);
    expect(scrubbed(x, 0, 5, { shift: false, alt: true })).toBe(0.5);
  });

  it("has a step for something without a unit too", () => {
    const pan = spec("audio.pan");
    expect(scrubbed(pan, 0, 10, plain)).toBeCloseTo(0.1, 9);
  });

  it("stops at the limits", () => {
    expect(scrubbed(opacity, 0.9, 50, plain)).toBe(1);
    expect(scrubbed(opacity, 0.1, -50, plain)).toBe(0);
    expect(scrubbed(width, 10, -50, plain)).toBe(0);
  });

  it("stops at what is suggested", () => {
    expect(scrubbed(anchor, 0.9, 50, plain)).toBe(1);
    expect(scrubbed(anchor, 0.1, -50, plain)).toBe(0);
  });

  it("does not throw a value back that somebody typed outside of the suggestion", () => {
    expect(scrubbed(anchor, 1.5, 0, plain)).toBe(1.5);
    expect(scrubbed(anchor, 1.5, -10, plain)).toBeCloseTo(1.4, 9);
    expect(scrubbed(anchor, -0.5, 10, plain)).toBeCloseTo(-0.4, 9);
  });

  it("keeps float noise out of the project", () => {
    expect(scrubbed(opacity, 0.1, 20, plain)).toBe(0.3);
  });
});
