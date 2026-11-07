import { ProjectStore, describeClip, orderedTracks, sceneSourceOf } from "@animaquill/core";
import type { ClipState, Registration, RegistrationProblem } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { propertyProblems } from "./problems.ts";

/** Says what it was asked to say, so that what is said can be told apart. */
const t = ((key: string, words: Record<string, unknown> = {}) => {
  const { interpolation: _interpolation, ...rest } = words;
  return `${key} ${JSON.stringify(rest)}`;
}) as unknown as TFunction;

function setup(properties: object, params?: readonly object[]) {
  const store = ProjectStore.create(createProject({ name: "问题" }));
  const run = (type: string, given: object) => {
    const result = store.execute({ type, params: given });
    if (!result.ok) throw new Error(result.error.message);
  };
  const scene = { name: "场景", entry: "index.html", runtime: 1, ...(params && { params }) };
  run("scene.add", { id: "a", scene, files: { "index.html": "<p>a</p>" } });
  const main = store.getState().timelines["main"];
  const track = orderedTracks(main as never).find(({ kind }) => kind === "video")?.id;
  run("clip.add", {
    timeline: "main",
    track,
    clip: { id: "c", start: "0", duration: "5", source: { kind: "scene", scene: "a" }, properties },
  });
  const renames: string[] = [];
  const problemsFor = (registration?: Registration, registered: RegistrationProblem[] = []) => {
    const state = store.getState();
    const revision = sceneSourceOf(state, "a")?.revision;
    const registry = {
      registrationOf: (asked: string) => (asked === revision ? registration : undefined),
    };
    return propertyProblems(
      state,
      "main",
      {
        describe: (clip: ClipState) => describeClip(state, clip, registry),
        registered: (asked) => (asked === revision ? registered : []),
        clipName: () => "片段",
        rename: (clip, from, to) => renames.push(`${clip} ${from} ${to}`),
      },
      t,
    );
  };
  return { problemsFor, renames };
}

const keys = { keys: [{ time: "0", value: 1 }] };
const registration = (objects: Registration["objects"], complete = true): Registration => ({
  objects,
  elements: [],
  complete,
});

describe("problems of what clips hold for their scenes", () => {
  it("say which keys lost their object, once the code got through", () => {
    const { problemsFor } = setup({ "object.arm.x": keys, "transform.x": keys });
    expect(problemsFor()).toEqual([]);
    expect(problemsFor(registration([], false))).toEqual([]);
    const problems = problemsFor(registration([]));
    expect(problems).toEqual([
      {
        severity: "warning",
        text: 'problems.properties.orphan {"path":"object.arm.x"}',
        origin: "片段",
        target: { clip: "c", path: "object.arm.x" },
        place: "object.arm.x",
      },
    ]);
  });

  it("say where keys are under a path of before, and move them as one step", () => {
    const { problemsFor, renames } = setup({ "object.arm.angle": keys });
    const arm = {
      id: "arm",
      properties: [{ path: "rotation", type: "angle", aliases: ["angle"] }],
    };
    const [problem] = problemsFor(registration([arm as never]));
    expect(problem?.text).toBe(
      'problems.properties.renamed {"from":"object.arm.angle","to":"object.arm.rotation"}',
    );
    problem?.action?.run();
    expect(renames).toEqual(["c object.arm.angle object.arm.rotation"]);
  });

  it("say what holds a value of another type", () => {
    const { problemsFor } = setup({ "object.arm.x": "far" });
    const arm = { id: "arm", properties: [{ path: "x", type: "number", default: 0 }] };
    const [problem] = problemsFor(registration([arm as never]));
    expect(problem?.text).toContain("problems.properties.mismatch");
    expect(problem?.text).toContain("object.arm.x");
  });

  it("say which parameters no clip can give a value", () => {
    const { problemsFor } = setup({}, [{ id: "标题", name: "标题", type: "text" }]);
    expect(problemsFor().map(({ text }) => text)).toEqual([
      'problems.properties.param {"name":"标题"}',
    ]);
  });

  it("say what made no sense in what the code registered", () => {
    const { problemsFor } = setup({});
    const problems = problemsFor(registration([]), [{ code: "object-id", target: "手" }]);
    expect(problems.map(({ text }) => text)).toEqual([
      'scene.problems.codes.object-id {"target":"手"}',
    ]);
  });
});
