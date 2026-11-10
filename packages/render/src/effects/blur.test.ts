import { afterAll, describe, expect, it, vi } from "vitest";
import type { EffectFrame } from "./code.ts";

/**
 * The blur: how large the picture with its repeated edge is, and what it draws, with canvases that
 * write down what happens to them. What the pictures look like is for the browser tests.
 */

type Call = { readonly canvas: number; readonly name: string; readonly args: readonly unknown[] };
let calls: Call[] = [];
let made = 0;

class FakeCanvas {
  width: number;
  height: number;
  readonly id = made++;
  readonly #context: Record<string, unknown>;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push({ canvas: this.id, name, args });
    const state: Record<string, unknown> = { filter: "none" };
    this.#context = new Proxy(state, {
      get: (target, key: string) => (key in target ? target[key] : record(key)),
      set: (target, key: string, value) => {
        target[key] = value;
        if (key === "filter") calls.push({ canvas: this.id, name: "filter", args: [value] });
        return true;
      },
    });
  }
  getContext() {
    return this.#context;
  }
}

vi.stubGlobal("OffscreenCanvas", FakeCanvas);
afterAll(() => vi.unstubAllGlobals());

const { default: blur, extendedBlur } = await import("./blur.ts");

function frame(values: Record<string, unknown>, width = 100, height = 50) {
  const canvas = new FakeCanvas(width, height) as unknown as OffscreenCanvas;
  let draw: ((frame: EffectFrame) => void) | undefined;
  blur({ canvas, render: (given) => (draw = given) });
  const input = new FakeCanvas(width, height) as unknown as OffscreenCanvas;
  calls = [];
  draw?.({ input, values, width, height, canvas, time: 0, pixelRatio: 2 });
  return { output: (canvas as unknown as FakeCanvas).id, input };
}

const draws = (on: number) =>
  calls.filter(({ canvas, name }) => canvas === on && name === "drawImage");

describe("the blur", () => {
  it("has a border as wide as the blur reaches, at full size unless that is far larger", () => {
    expect(extendedBlur(1920, 1080, 20)).toEqual({
      pad: 61,
      scale: 1,
      width: 2042,
      height: 1202,
    });
    // Ten times as wide on a small clip: the picture is drawn smaller, within what it may have.
    const wide = extendedBlur(400, 300, 400);
    expect(wide.scale).toBeLessThan(1);
    expect(wide.width * wide.height).toBeLessThanOrEqual((1 << 22) * 1.01);
    expect(wide.width).toBe(Math.ceil((400 + 2 * wide.pad) * wide.scale));
    const huge = extendedBlur(3840, 2160, 2000);
    expect(huge.width * huge.height).toBeLessThanOrEqual(2 * 3840 * 2160 * 1.01);
  });

  it("repeats the edge pixels around the picture and blurs that, where the box is", () => {
    const { output, input } = frame({ radius: 10 });
    const border = draws(output + 2);
    // The picture, four sides from rows and columns of one pixel, four corners from one pixel.
    expect(border.map(({ args }) => args.slice(1))).toEqual([
      [61, 61],
      [0, 0, 1, 50, 0, 61, 61, 50],
      [99, 0, 1, 50, 161, 61, 61, 50],
      [0, 0, 100, 1, 61, 0, 100, 61],
      [0, 49, 100, 1, 61, 111, 100, 61],
      [0, 0, 1, 1, 0, 0, 61, 61],
      [99, 0, 1, 1, 161, 0, 61, 61],
      [0, 49, 1, 1, 0, 111, 61, 61],
      [99, 49, 1, 1, 161, 111, 61, 61],
    ]);
    expect(border.every(({ args }) => args[0] === input)).toBe(true);
    const filters = calls.filter(({ canvas, name }) => canvas === output && name === "filter");
    expect(filters.map(({ args }) => args[0])).toContain("blur(20px)");
    expect(draws(output).map(({ args }) => args.slice(1))).toEqual([[-61, -61]]);
  });

  it("blurs the picture as it is when the edge is transparent, and copies it with no radius", () => {
    for (const values of [{ radius: 10, edge: "transparent" }, { radius: 0 }]) {
      const { output, input } = frame(values);
      expect(calls.filter(({ name }) => name === "drawImage")).toEqual([
        { canvas: output, name: "drawImage", args: [input, 0, 0] },
      ]);
    }
  });
});
