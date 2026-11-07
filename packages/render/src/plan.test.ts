import type { RenderLayer, RenderPlan } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { withChannels } from "./plan.ts";

const layer = (id: string, channels: RenderLayer["channels"]): RenderLayer => ({
  id,
  start: 0,
  end: 1,
  offset: 0,
  source: { kind: "color", color: "#000000" },
  fit: "contain",
  fades: { in: 0, out: 0 },
  channels,
});

const x = { kind: "still", value: 1 } as const;
const y = { kind: "still", value: 2 } as const;
const moved = { kind: "still", value: 3 } as const;

const plan: RenderPlan = {
  width: 1920,
  height: 1080,
  stage: { width: 1920, height: 1080 },
  camera: {},
  background: "#000000",
  layers: [layer("a", { "transform.x": x, "transform.y": y }), layer("b", { "transform.x": x })],
};

describe("new curves on a layer", () => {
  it("change what was said and leave the rest", () => {
    const { layers } = withChannels(plan, "a", { channels: { "transform.x": moved } });
    expect(layers[0]?.channels).toEqual({ "transform.x": moved, "transform.y": y });
  });

  it("do not touch the other layers", () => {
    const { layers } = withChannels(plan, "a", { channels: { "transform.x": moved } });
    expect(layers[1]).toBe(plan.layers[1]);
  });

  it("can add a property", () => {
    const { layers } = withChannels(plan, "b", { channels: { opacity: moved } });
    expect(layers[1]?.channels).toEqual({ "transform.x": x, opacity: moved });
  });

  it("can take one away, so that the layer goes back to the default", () => {
    const { layers } = withChannels(plan, "a", { channels: { "transform.x": null } });
    expect(layers[0]?.channels).toEqual({ "transform.y": y });
  });

  it("leave a plan alone that has no such layer, which is how a clip that left looks", () => {
    expect(withChannels(plan, "gone", { channels: { opacity: moved } }).layers).toEqual(
      plan.layers,
    );
  });

  it("leave the plan they came from as it was", () => {
    withChannels(plan, "a", { channels: { "transform.x": moved } });
    expect(plan.layers[0]?.channels["transform.x"]).toBe(x);
  });

  it("can come with another way of fitting the media, which is no curve", () => {
    const { layers } = withChannels(plan, "a", { channels: {}, fit: "cover" });
    expect(layers[0]?.fit).toBe("cover");
    expect(layers[0]?.channels).toEqual(plan.layers[0]?.channels);
  });

  it("leave the way of fitting alone when they say nothing about it", () => {
    const { layers } = withChannels(plan, "a", { channels: { opacity: moved } });
    expect(layers[0]?.fit).toBe("contain");
  });
});
