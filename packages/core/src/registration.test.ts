import { describe, expect, it } from "vitest";
import {
  REGISTRATION_LIMITS,
  isIdPart,
  isObjectId,
  isSceneOwned,
  readElement,
  readObject,
  readRegistration,
  readValue,
  type RegistrationProblem,
} from "./registration.ts";

const read = (objects: readonly unknown[], elements: readonly unknown[] = [], complete = true) => {
  const result = readRegistration({ objects, elements, complete });
  if (!result) throw new Error("no registration");
  return result;
};

const ARM = {
  id: "arm",
  name: "手臂",
  properties: [
    { path: "x", type: "number", unit: "world", default: 0, group: "position" },
    { path: "rotation", type: "angle", default: 0, min: -180, max: 180 },
    { path: "tint", type: "color", default: "#FFFFFF" },
  ],
};

describe("ids", () => {
  it.each(["arm", "arm_l", "Arm-2", "9"])("%s is one", (id) => {
    expect(isIdPart(id)).toBe(true);
  });

  it.each([
    "",
    "_arm",
    "-arm",
    "手臂",
    "arm.l",
    "a b",
    "__proto__",
    "constructor",
    "prototype",
    "x".repeat(65),
    42,
    undefined,
  ])("%j is none", (id) => {
    expect(isIdPart(id)).toBe(false);
  });

  it("of objects can have parts, each of them an id", () => {
    expect(isObjectId("rig.arm_l")).toBe(true);
    expect(isObjectId("rig..arm")).toBe(false);
    expect(isObjectId("rig.constructor")).toBe(false);
    expect(isObjectId(Array.from({ length: 17 }, () => "a").join("."))).toBe(false);
  });

  it("tell what a scene works out from what the compositor does", () => {
    expect(isSceneOwned("param.title")).toBe(true);
    expect(isSceneOwned("element.logo.x")).toBe(true);
    expect(isSceneOwned("object.arm.x")).toBe(true);
    expect(isSceneOwned("transform.x")).toBe(false);
    expect(isSceneOwned("objects.x")).toBe(false);
  });
});

describe("a registration", () => {
  it("keeps what makes sense, as new data", () => {
    const given = structuredClone(ARM);
    const { registration, problems } = read([given]);
    expect(problems).toEqual([]);
    expect(registration.complete).toBe(true);
    const [object] = registration.objects;
    expect(object).toEqual({
      id: "arm",
      name: "手臂",
      properties: [
        { path: "x", type: "number", unit: "world", default: 0, group: "position" },
        { path: "rotation", type: "angle", default: 0, min: -180, max: 180 },
        { path: "tint", type: "color", default: "#ffffff" },
      ],
    });
    expect(object).not.toBe(given);
    expect(object?.properties[0]).not.toBe(given.properties[0]);
  });

  it("is no registration without lists", () => {
    expect(readRegistration(undefined)).toBeUndefined();
    expect(readRegistration({ objects: {}, elements: [] })).toBeUndefined();
    expect(readRegistration("objects")).toBeUndefined();
  });

  it("is only complete when it says so in so many words", () => {
    expect(readRegistration({ objects: [], elements: [], complete: "yes" })?.registration).toEqual({
      objects: [],
      elements: [],
      complete: false,
    });
  });

  it("gives a default to what has none, for code to read", () => {
    const { registration } = read([
      {
        id: "a",
        properties: [
          { path: "n", type: "number" },
          { path: "on", type: "boolean" },
          { path: "c", type: "color" },
          { path: "p", type: "vec3" },
          { path: "mode", type: "choice", options: ["a", "b"] },
        ],
      },
    ]);
    expect(registration.objects[0]?.properties.map((spec) => spec.default)).toEqual([
      0,
      false,
      "#000000",
      [0, 0, 0],
      "a",
    ]);
  });

  it("names the parts of a vector, unless it says otherwise", () => {
    const { registration } = read([
      {
        id: "a",
        properties: [
          { path: "p", type: "vec2" },
          { path: "q", type: "vec2", components: ["u", "v"] },
          { path: "r", type: "vec2", components: ["one"] },
        ],
      },
    ]);
    expect(registration.objects[0]?.properties.map((spec) => spec.components)).toEqual([
      ["x", "y"],
      ["u", "v"],
      ["x", "y"],
    ]);
  });

  it("leaves out a property it cannot make sense of, and keeps the rest of the object", () => {
    const { registration, problems } = read([
      {
        id: "a",
        properties: [
          { path: "ok", type: "number" },
          { path: "bad", type: "quaternion" },
          { path: "a.b", type: "number" },
          { path: "__proto__", type: "number" },
          { path: "mode", type: "choice" },
          { path: "ok", type: "boolean" },
        ],
      },
    ]);
    expect(registration.objects[0]?.properties.map(({ path }) => path)).toEqual(["ok"]);
    expect(problems.map(({ code }) => code)).toEqual([
      "object-property",
      "object-property",
      "object-property",
      "object-property",
      "object-property-twice",
    ]);
  });

  it("takes a default that is not of the type for nothing, and says so", () => {
    const { registration, problems } = read([
      {
        id: "a",
        properties: [
          { path: "n", type: "number", default: "12" },
          { path: "c", type: "color", default: "red" },
          { path: "v", type: "vec2", default: [1, Number.POSITIVE_INFINITY] },
          { path: "m", type: "choice", options: ["a"], default: "b" },
        ],
      },
    ]);
    expect(registration.objects[0]?.properties.map((spec) => spec.default)).toEqual([
      0,
      "#000000",
      [0, 0],
      "a",
    ]);
    expect(problems.every(({ code }) => code === "object-default")).toBe(true);
    expect(problems).toHaveLength(4);
  });

  it("leaves out ranges that go the wrong way", () => {
    const { registration, problems } = read([
      { id: "a", properties: [{ path: "n", type: "number", min: 10, max: 1, softMin: 0 }] },
    ]);
    expect(registration.objects[0]?.properties[0]).toEqual({
      path: "n",
      type: "number",
      default: 0,
      softMin: 0,
    });
    expect(problems).toEqual([{ code: "object-range", target: "a.n" }]);
  });

  it("leaves out an object without an id that could ever be found again", () => {
    const { registration, problems } = read([
      { id: "手臂", properties: [] },
      { properties: [] },
      { id: "ok", properties: [] },
    ]);
    expect(registration.objects.map(({ id }) => id)).toEqual(["ok"]);
    expect(problems).toEqual([{ code: "object-id", target: "手臂" }, { code: "object-id" }]);
  });

  it("goes by the first of two objects with one id", () => {
    const { registration, problems } = read([
      { id: "a", name: "first", properties: [] },
      { id: "a", name: "second", properties: [] },
    ]);
    expect(registration.objects.map(({ name }) => name)).toEqual(["first"]);
    expect(problems).toEqual([{ code: "object-twice", target: "a" }]);
  });

  it("keeps what places an object, as far as it makes sense", () => {
    const { registration, problems } = read([
      {
        id: "rig.arm_l",
        parent: "rig",
        spans: [
          [0, 2],
          [3, 1],
          [4, 5],
        ],
        presence: "visible",
        aliases: ["arm", "arm", "rig.arm_l", "手"],
        properties: [{ path: "visible", type: "boolean", default: true }],
      },
      { id: "self", parent: "self", presence: "nothing", properties: [] },
    ]);
    const [bone, self] = registration.objects;
    expect(bone).toMatchObject({
      parent: "rig",
      spans: [
        [0, 2],
        [4, 5],
      ],
      presence: "visible",
      aliases: ["arm"],
    });
    expect(self?.parent).toBeUndefined();
    expect(self?.presence).toBeUndefined();
    expect(problems.map(({ code }) => code).toSorted()).toEqual(
      ["object-alias", "object-parent", "object-presence", "object-spans"].toSorted(),
    );
  });

  it("only says what an object is there by when that is a switch or a number", () => {
    const { registration } = read([
      { id: "a", presence: "name", properties: [{ path: "name", type: "text" }] },
    ]);
    expect(registration.objects[0]?.presence).toBeUndefined();
  });

  it("cuts names down to what anybody reads", () => {
    const { registration } = read([
      {
        id: "a",
        name: "名".repeat(10000),
        properties: [{ path: "x", type: "number", group: "  " }],
      },
    ]);
    expect(registration.objects[0]?.name).toHaveLength(REGISTRATION_LIMITS.text);
    expect(registration.objects[0]?.properties[0]?.group).toBeUndefined();
  });

  it("ignores what it does not know, such as functions that were left out on the way", () => {
    const { registration } = read([
      { id: "a", type: "aq.bone", bounds: "x", properties: [{ path: "x", type: "number", y: 1 }] },
    ]);
    expect(registration.objects[0]).toEqual({
      id: "a",
      properties: [{ path: "x", type: "number", default: 0 }],
    });
  });
});

describe("a registration that is too large", () => {
  const problemsOf = (problems: readonly RegistrationProblem[]) =>
    problems.map(({ code, target }) => `${code} ${target ?? ""}`);

  it("keeps the first objects that fit", () => {
    const objects = Array.from({ length: REGISTRATION_LIMITS.objects + 50 }, (_, index) => ({
      id: `o${index}`,
      properties: [],
    }));
    const { registration, problems } = read(objects);
    expect(registration.objects).toHaveLength(REGISTRATION_LIMITS.objects);
    expect(registration.objects.at(-1)?.id).toBe(`o${REGISTRATION_LIMITS.objects - 1}`);
    expect(problemsOf(problems)).toEqual(["object-too-many objects"]);
  });

  it("keeps the first properties of an object that fit", () => {
    const properties = Array.from({ length: 1000 }, (_, index) => ({
      path: `p${index}`,
      type: "number",
    }));
    const { registration, problems } = read([{ id: "a", properties }]);
    expect(registration.objects[0]?.properties).toHaveLength(
      REGISTRATION_LIMITS.propertiesPerObject,
    );
    expect(problemsOf(problems)).toEqual(["object-too-many a"]);
  });

  it("stops where all objects together have too many properties", () => {
    const properties = Array.from({ length: REGISTRATION_LIMITS.propertiesPerObject }, (_, i) => ({
      path: `p${i}`,
      type: "number",
    }));
    const count = Math.ceil(REGISTRATION_LIMITS.properties / properties.length) + 2;
    const objects = Array.from({ length: count }, (_, index) => ({ id: `o${index}`, properties }));
    const { registration, problems } = read(objects);
    const total = registration.objects.reduce((sum, { properties: own }) => sum + own.length, 0);
    expect(total).toBe(REGISTRATION_LIMITS.properties);
    expect(problemsOf(problems)).toContain("object-too-many properties");
  });

  it("does not take longer for a list that goes on and on", () => {
    // One object over and over, as a list of them would be: what costs is going through it.
    const entry = { id: "a", properties: [] };
    const huge = Array.from({ length: 5_000_000 }, () => entry);
    const started = performance.now();
    const { registration } = read(huge);
    expect(registration.objects).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("says each problem once, and not more than a page of them", () => {
    const objects = Array.from({ length: 500 }, (_, index) => ({ id: `bad id ${index}` }));
    const { problems } = read(objects);
    expect(problems.length).toBeLessThanOrEqual(100);
  });

  it("does not grow by numbers that a list of them could have", () => {
    const { registration, problems } = read([
      {
        id: "a",
        properties: [
          {
            path: "many",
            type: "numbers",
            default: Array.from({ length: REGISTRATION_LIMITS.numbers + 1 }, () => 0),
          },
          { path: "words", type: "text", default: "x".repeat(REGISTRATION_LIMITS.textValue + 1) },
        ],
      },
    ]);
    expect(registration.objects[0]?.properties.map((spec) => spec.default)).toEqual([[], ""]);
    expect(problems).toHaveLength(2);
  });
});

describe("what comes from where nothing is to be trusted", () => {
  it("has no say about what objects are made of", () => {
    const evil = JSON.parse(
      '{"id":"a","__proto__":{"polluted":true},"properties":[{"path":"x","type":"number","__proto__":{"default":5}}]}',
    );
    const { registration } = read([evil]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(registration.objects[0]?.properties[0]?.default).toBe(0);
    expect(Object.getPrototypeOf(registration.objects[0])).toBe(Object.prototype);
  });

  it("does not take a value for one of another kind", () => {
    expect(readValue("number", Number.NaN)).toBeUndefined();
    expect(readValue("boolean", "true")).toBeUndefined();
    expect(readValue("asset", { asset: "../x" })).toBeUndefined();
    expect(readValue("asset", { asset: "logo", extra: 1 })).toEqual({ asset: "logo" });
    expect(readValue("vec4", [1, 2, 3, "4"])).toBeUndefined();
  });

  it("reads an object the way the runtime does, with every problem said", () => {
    const said: string[] = [];
    const object = readObject({ id: "a", properties: "nope" }, (code, target) =>
      said.push(`${code} ${target}`),
    );
    expect(object).toEqual({ id: "a", properties: [] });
    expect(said).toEqual([]);
  });
});

describe("elements", () => {
  it("are found by an id that a path can hold, with what they start out with", () => {
    expect(
      readElement({ id: "logo", kind: "html", start: { opacity: 0.5, color: "#FF0000" } }),
    ).toEqual({ id: "logo", kind: "html", start: { opacity: 0.5, color: "#ff0000" } });
    expect(
      readElement({ id: "dot", kind: "svg", start: { color: "#ff0000", fill: "#00ff00" } }),
    ).toEqual({ id: "dot", kind: "svg", start: { fill: "#00ff00" } });
  });

  it("only start with values that a property can have", () => {
    expect(readElement({ id: "a", kind: "html", start: { opacity: 2, color: "red" } })).toEqual({
      id: "a",
      kind: "html",
    });
  });

  it.each([
    { id: "a.b", kind: "html" },
    { id: "a", kind: "canvas" },
    { id: "constructor", kind: "html" },
  ])("are not there as %j", (element) => {
    expect(readElement(element)).toBeUndefined();
  });

  it("only count once, and only as many as there is room for", () => {
    const elements = Array.from({ length: REGISTRATION_LIMITS.elements + 10 }, (_, index) => ({
      id: `e${index}`,
      kind: "html",
    }));
    const { registration, problems } = read([], [{ id: "e0", kind: "svg" }, ...elements]);
    expect(registration.elements).toHaveLength(REGISTRATION_LIMITS.elements - 1);
    expect(registration.elements[0]).toEqual({ id: "e0", kind: "svg" });
    expect(problems).toEqual([{ code: "object-too-many", target: "elements" }]);
  });
});
