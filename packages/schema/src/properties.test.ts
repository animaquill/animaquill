import { describe, expect, it } from "vitest";
import { BUILT_IN_PROPERTIES, isKnownProperty, propertyValueProblem } from "./properties.ts";
import { Key, KnownProperties, PropertyPath } from "./values.ts";

describe("property paths", () => {
  it.each([
    "opacity",
    "transform.x",
    "param.title",
    "param.size-2",
    "object.arm.rotation",
    "object.rig.arm_l.rotation",
    "element.logo.opacity",
    "caption.size",
    "object.3d.x",
    "object.constructors.x",
  ])("takes %s", (path) => {
    expect(PropertyPath.safeParse(path).success).toBe(true);
  });

  it.each([
    ["a display name", "object.秤砣.x"],
    ["a space", "param.my title"],
    ["an empty part", "object..x"],
    ["a dot at the end", "param."],
    ["a dot at the start", ".x"],
    ["a part that starts with a symbol", "object._arm.x"],
    ["__proto__", "object.__proto__.x"],
    ["constructor in the middle", "object.constructor.x"],
    ["constructor at the end", "param.constructor"],
    ["prototype", "prototype.x"],
    ["a path through folders", "object/arm.x"],
    ["nothing", ""],
  ])("refuses %s", (_, path) => {
    expect(PropertyPath.safeParse(path).success).toBe(false);
  });

  it("does not take what every object inherits for a built-in property", () => {
    expect(isKnownProperty("toString")).toBe(false);
    expect(isKnownProperty("hasOwnProperty")).toBe(false);
    expect(KnownProperties.safeParse({ toString: 1 }).success).toBe(false);
  });
});

describe("bezier handles", () => {
  const key = (out: readonly number[]) => ({ time: "0", value: 0, interp: "bezier", out });

  it.each([[[0, 0]], [[1, 1]], [[0.42, 3]], [[0.42, -2]]])("takes %j", (out) => {
    expect(Key.safeParse(key(out)).success).toBe(true);
  });

  it.each([[[-0.1, 0]], [[1.1, 0]]])("refuses %j, which would run back in time", (out) => {
    expect(Key.safeParse(key(out)).success).toBe(false);
    expect(Key.safeParse({ time: "0", value: 0, in: out }).success).toBe(false);
  });
});

describe("built-in properties", () => {
  const specs = Object.entries(BUILT_IN_PROPERTIES);

  it.each(specs)("%s has a path a project can store", (path, spec) => {
    expect(spec.path).toBe(path);
    expect(PropertyPath.safeParse(path).success).toBe(true);
  });

  it.each(specs)("the default of %s is a value it accepts", (path, spec) => {
    if (spec.default !== undefined)
      expect(propertyValueProblem(path, spec.default)).toBeUndefined();
  });

  it("states what the coordinates mean", () => {
    const of = (path: string) => BUILT_IN_PROPERTIES[path];
    expect(of("transform.x")).toMatchObject({ unit: "world", default: 0 });
    expect(of("transform.y")).toMatchObject({ unit: "world", default: 0 });
    expect(of("transform.width")).toMatchObject({ unit: "world", min: 0 });
    expect(of("transform.height")).toMatchObject({ unit: "world", min: 0 });
    expect(of("transform.scale")).toMatchObject({ default: 1 });
    expect(of("transform.anchorX")).toMatchObject({ unit: "ratio", default: 0.5 });
    expect(of("transform.anchorY")).toMatchObject({ unit: "ratio", default: 0.5 });
    expect(of("transform.rotation")).toMatchObject({ type: "angle", unit: "deg", default: 0 });
  });

  it("leaves the size of a clip box open, because it follows the stage or the media", () => {
    expect(BUILT_IN_PROPERTIES["transform.width"]?.default).toBeUndefined();
    expect(BUILT_IN_PROPERTIES["transform.height"]?.default).toBeUndefined();
  });

  it("takes world units far outside of what a share could be", () => {
    expect(propertyValueProblem("transform.x", -1920)).toBeUndefined();
    expect(propertyValueProblem("transform.width", 3840)).toBeUndefined();
    expect(propertyValueProblem("transform.rotation", 720)).toBeUndefined();
  });

  it.each(["transform.width", "transform.height"])("refuses a negative %s", (path) => {
    expect(propertyValueProblem(path, -1)).toBeDefined();
    expect(propertyValueProblem(path, 0)).toBeUndefined();
  });
});
