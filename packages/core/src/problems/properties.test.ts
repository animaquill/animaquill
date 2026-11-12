import { describe, expect, it } from "vitest";
import type { ClipState } from "../model.ts";
import { describeClip } from "../objects.ts";
import type { Registration, RegistrationProblem } from "../registration.ts";
import { sceneSourceOf } from "../scene-plan.ts";
import { propertyProblems } from "./properties.ts";
import { clip, storeOf, video } from "./test-support.ts";

/** What used to be worked out in the interface, with the same cases: see ui/src/properties. */
function setup(properties: object, params?: readonly object[]) {
  const store = storeOf({
    tracks: [video([clip("c", { kind: "scene", scene: "a" }, { properties })])],
    scenes: {
      a: { name: "场景", entry: "index.html", runtime: 1, ...(params && { params }) } as never,
    },
    files: { "scenes/a/index.html": "<p>a</p>" },
  });
  const problemsFor = (
    registration?: Registration,
    registered: RegistrationProblem[] = [],
    exact = true,
  ) => {
    const state = store.getState();
    const revision = sceneSourceOf(state, "a")?.revision;
    const registry = {
      registrationOf: (asked: string) =>
        asked === revision && registration ? { registration, exact } : undefined,
    };
    return propertyProblems(state, "main", {
      describe: (each: ClipState) => describeClip(state, each, registry),
      registered: (asked) => (asked === revision ? registered : []),
    });
  };
  return { problemsFor, store };
}

const said = (problems: ReturnType<ReturnType<typeof setup>["problemsFor"]>) =>
  problems.map(({ code, params }) => `${code} ${JSON.stringify(params)}`);

const keys = { keys: [{ time: "0", value: 1 }] };
const registration = (objects: Registration["objects"], complete = true): Registration => ({
  objects,
  elements: [],
  complete,
  params: {},
});

describe("problems of what clips hold for their scenes", () => {
  it("say which keys lost their object, once the code got through", () => {
    const { problemsFor } = setup({ "object.arm.x": keys, "transform.x": keys });
    expect(problemsFor()).toEqual([]);
    expect(problemsFor(registration([], false))).toEqual([]);
    const [problem, ...rest] = problemsFor(registration([]));
    expect(rest).toEqual([]);
    expect(problem).toMatchObject({
      source: "properties",
      severity: "warning",
      code: "property-orphan",
      params: { path: "object.arm.x" },
      subject: { kind: "clip", id: "c", timeline: "main" },
      place: "object.arm.x",
    });
  });

  it("say of an element that is not there that it connects once it is, and nothing of deleting", () => {
    const { problemsFor } = setup({ "element.logo.opacity": keys });
    expect(problemsFor(registration([], false))).toEqual([]);
    expect(said(problemsFor(registration([])))).toEqual([
      'property-orphan-element {"path":"element.logo.opacity"}',
    ]);
  });

  it("say nothing of keys while it is not known that code registered all of it for the clip", () => {
    const { problemsFor } = setup({ "object.arm.x": keys });
    const leg = { id: "leg", properties: [{ path: "x", type: "number", default: 0 }] };
    // All that code registered, for other values of the parameters of the scene.
    expect(problemsFor(registration([leg as never]), [], false)).toEqual([]);
    expect(problemsFor(registration([leg as never]))).toHaveLength(1);
  });

  it("say where keys are under a path of before, with the step that moves them", () => {
    const { problemsFor, store } = setup({ "object.arm.angle": keys });
    const arm = {
      id: "arm",
      properties: [{ path: "rotation", type: "angle", aliases: ["angle"] }],
    };
    const [problem] = problemsFor(registration([arm as never]));
    expect(said(problem ? [problem] : [])).toEqual([
      'property-renamed {"from":"object.arm.angle","to":"object.arm.rotation"}',
    ]);
    expect(problem?.fix?.type).toBe("property.rename");
    const result = store.execute(problem?.fix as never);
    expect(result.ok).toBe(true);
    const properties = store.getState().timelines["main"]?.clips["c"]?.properties ?? {};
    expect(Object.keys(properties)).toEqual(["object.arm.rotation"]);
    expect(problemsFor(registration([arm as never]))).toEqual([]);
  });

  it("say what holds a value of another type", () => {
    const { problemsFor } = setup({ "object.arm.x": "far" });
    const arm = { id: "arm", properties: [{ path: "x", type: "number", default: 0 }] };
    expect(said(problemsFor(registration([arm as never])))).toEqual([
      'property-mismatch {"path":"object.arm.x","type":"number"}',
    ]);
  });

  it("say which parameters no clip can give a value, of the scene", () => {
    const { problemsFor } = setup({}, [{ id: "标题", name: "标题", type: "text" }]);
    const problems = problemsFor();
    expect(said(problems)).toEqual(['scene-param-id {"id":"标题","name":"标题"}']);
    expect(problems[0]?.subject).toEqual({ kind: "scene", id: "a" });
  });

  it("say what made no sense in what the code registered", () => {
    const { problemsFor } = setup({});
    const problems = problemsFor(registration([]), [{ code: "object-id", target: "手" }]);
    expect(said(problems)).toEqual(['scene-registration {"problem":"object-id","target":"手"}']);
  });

  it("are the same problems, with the same ids, however often they are worked out", () => {
    const { problemsFor } = setup({ "object.arm.x": keys, "element.logo.opacity": keys });
    const ids = () => problemsFor(registration([])).map(({ id }) => id);
    expect(ids()).toHaveLength(2);
    expect(ids()).toEqual(ids());
    expect(new Set(ids()).size).toBe(2);
  });
});
