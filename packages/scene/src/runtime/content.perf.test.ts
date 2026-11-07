import { describe, expect, it } from "vitest";
import { ClipValues, CodeObjects } from "./content.ts";

/**
 * The animation model guessed that 1200 channels take less than a millisecond a frame: a skeleton
 * of 300 bones with 4 properties each. This measures it, on the clock of the scene, frame by frame,
 * the way playing goes through them.
 */
describe("a skeleton of 300 bones", () => {
  it("works out all of its 1200 channels in a fraction of a frame", () => {
    const keys = (offset: number) => ({
      keys: Array.from({ length: 12 }, (_, index) => ({
        time: String(index),
        value: index * 10 + offset,
        interp: "bezier",
        out: [0.42, 0],
        in: [0.58, 1],
      })),
    });
    const values: Record<string, unknown> = {};
    const bones = Array.from({ length: 300 }, (_, index) => `rig.bone${index}`);
    for (const [index, bone] of bones.entries()) {
      for (const property of ["x", "y", "rotation", "scale"]) {
        values[`object.${bone}.${property}`] = keys(index);
      }
    }
    const clip = new ClipValues(values);
    let now = 0;
    const objects = new CodeObjects(
      clip,
      () => now,
      () => {},
    );
    const handles = bones.map((bone) =>
      objects.register(
        bone,
        { properties: { x: 0, y: 0, rotation: { type: "angle", default: 0 }, scale: 1 } },
        () => {},
      ),
    );
    const frames = 600;
    let sum = 0;
    // Once to prepare the curves, which happens when they arrive, and not with every frame.
    for (const handle of handles) sum += handle.at(0).x as number;
    const started = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      now = frame / 60;
      for (const handle of handles) sum += handle.at().rotation as number;
    }
    const perFrame = (performance.now() - started) / frames;
    console.log(`1200 channels: ${perFrame.toFixed(3)} ms a frame`);
    expect(sum).toBeGreaterThan(0);
    expect(perFrame).toBeLessThan(2);
  });
});
