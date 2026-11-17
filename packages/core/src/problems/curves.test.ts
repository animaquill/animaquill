import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import type { ClipDescription } from "../objects.ts";
import { ProjectStore } from "../store.ts";
import { CURVE_CODES, curveProblems } from "./curves.ts";
import { staticProblems } from "./static.ts";
import { audio, clip, color, stateOf, video, type Setup } from "./test-support.ts";

const ramp = (first: object, more: object = {}) => ({
  keys: [
    { time: "0", value: 0, ...first },
    { time: "1", value: 10 },
  ],
  ...more,
});

const noise = { modifiers: [{ type: "noise", amount: 2, seed: 1 }] };

/** Each problem in a line: code, what it is about, its parameters, and what it does to an export. */
const said = (setup: Setup, describeClip?: Parameters<typeof curveProblems>[1]) =>
  curveProblems(stateOf(setup), describeClip).map(
    ({ code, subject, params, place, affectsOutput }) =>
      [
        code,
        subject?.id,
        place,
        JSON.stringify(Object.fromEntries(Object.entries(params).toSorted())),
        affectsOutput ?? "-",
      ].join(" "),
  );

describe("problems of keys", () => {
  it("lists a preset that is not in the table, which goes linearly and makes the export differ", () => {
    const properties = {
      "transform.x": ramp({ interp: "preset", preset: "wobble" }),
      "transform.y": ramp({ interp: "preset", preset: "bounceOut" }),
      "transform.scale": ramp({
        interp: "preset",
        preset: "elasticOut",
        presetParams: { period: 1 },
      }),
    };
    expect(said({ tracks: [video([color("c", { properties })])] })).toEqual([
      'unknown-ease-preset c transform.x {"path":"transform.x","preset":"wobble"} picture',
    ]);
  });

  it("lists steps without a number and values out of range apart from a name it does not know", () => {
    const properties = {
      "transform.x": ramp({ interp: "preset", preset: "stepsEnd" }),
      "transform.y": ramp({ interp: "preset", preset: "elasticOut", presetParams: { period: 0 } }),
      "transform.scale": ramp({
        interp: "spring",
        spring: { stiffness: 1e300, damping: 1, mass: 1e-300 },
      }),
    };
    expect(said({ tracks: [video([color("c", { properties })])] })).toEqual([
      'ease-params-invalid c transform.x {"interp":"preset","path":"transform.x","reason":"steps"} picture',
      'ease-params-invalid c transform.y {"interp":"preset","path":"transform.y","reason":"params"} picture',
      'ease-params-invalid c transform.scale {"interp":"spring","path":"transform.scale","reason":"params"} picture',
    ]);
  });

  it("does not list a preset on the last key, where it does nothing", () => {
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 1, interp: "preset", preset: "wobble" },
      ],
    };
    expect(said({ tracks: [video([color("c", { properties: { opacity: keys } })])] })).toEqual([]);
  });

  it("does not make an export stop for what nobody sees", () => {
    const properties = { "transform.x": ramp({ interp: "preset", preset: "wobble" }) };
    expect(said({ tracks: [video([color("c", { properties })], { hidden: true })] })).toEqual([
      'unknown-ease-preset c transform.x {"path":"transform.x","preset":"wobble"} -',
    ]);
  });

  it("lists noise on what cannot shake, and not on numbers, angles and effects", () => {
    const properties = {
      blend: { keys: [{ time: "0", value: "screen" }], ...noise },
      "transform.rotation": ramp({}, noise),
      "effect.b.radius": ramp({}, noise),
    };
    const effects = [{ id: "b", type: "blur" }];
    expect(said({ tracks: [video([color("c", { properties, effects })])] })).toEqual([
      'noise-not-applicable c blend {"path":"blend","type":"choice"} -',
    ]);
  });

  it("goes by what a scene describes, and leaves its properties alone without it", () => {
    const properties = {
      "param.tint": { keys: [{ time: "0", value: "#ff0000" }], ...noise },
      "param.size": ramp({}, noise),
    };
    const setup: Setup = {
      tracks: [video([clip("s", { kind: "scene", scene: "title" }, { properties })])],
      scenes: { title: { name: "标题", entry: "index.html", runtime: 1 } },
      files: { "scenes/title/index.html": "<p></p>" },
    };
    const described: ClipDescription = {
      objects: [
        {
          id: "params",
          type: "scene.params",
          properties: [
            { path: "param.tint", type: "color", default: "#000000" },
            { path: "param.size", type: "number", default: 1 },
          ],
        },
      ],
    };
    expect(said(setup)).toEqual([]);
    expect(said(setup, () => described)).toEqual([
      'noise-not-applicable s param.tint {"path":"param.tint","type":"color"} -',
    ]);
  });

  it("leaves sound and speed alone, whose keys are another problem", () => {
    const properties = {
      "audio.volume": ramp({ interp: "preset", preset: "wobble" }),
      "time.speed": ramp({ interp: "preset", preset: "wobble" }),
    };
    expect(said({ tracks: [video([]), audio([color("t", { properties })])] })).toEqual([]);
  });

  it("are among the problems of a project, and the example has none of them", () => {
    const state = ProjectStore.open(loadFixture("v1")).store?.getState();
    if (!state) throw new Error("The example did not open");
    const codes = new Set<string>(CURVE_CODES);
    expect(staticProblems(state).filter(({ code }) => codes.has(code))).toEqual([]);
    const properties = { "transform.x": ramp({ interp: "preset", preset: "wobble" }) };
    const listed = staticProblems(stateOf({ tracks: [video([color("c", { properties })])] }));
    expect(listed.map(({ code, source }) => `${source} ${code}`)).toContain(
      "properties unknown-ease-preset",
    );
  });
});
