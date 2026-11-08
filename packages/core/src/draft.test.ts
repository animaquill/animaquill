import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { Draft, type Step } from "./draft.ts";
import { getIn } from "./patch.ts";
import { ProjectStore } from "./store.ts";

const clipPath = ["timelines", "main", "clips", "c"];

function draft(properties?: object) {
  const store = ProjectStore.create(createProject({ name: "草稿" }));
  const track = Object.values(store.getState().timelines["main"]?.tracks ?? {})[0]?.id;
  const clip = {
    id: "c",
    start: "0",
    duration: "1",
    source: { kind: "color", color: "#000000" },
    ...(properties ? { properties } : {}),
  };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  return new Draft(store.getState(), "user");
}

describe("planning a change", () => {
  it("does not record taking away what is not there", () => {
    const plan = draft();
    plan.delete([...clipPath, "name"]);
    plan.delete([...clipPath, "properties", "opacity"]);
    plan.delete([...clipPath, "properties"]);
    expect(plan.steps).toEqual([]);
  });

  it("does not record a level without entries, which is the same as none", () => {
    const plan = draft();
    plan.set([...clipPath, "properties"], {});
    expect(plan.steps).toEqual([]);
  });

  it("takes a value the way the document will hold it", () => {
    const plan = draft();
    plan.set(["timelines", "main", "clips", "e"], { id: "e", name: undefined, properties: {} });
    expect(plan.steps[0]?.patch).toEqual({
      op: "set",
      path: ["timelines", "main", "clips", "e"],
      value: { id: "e" },
    });
  });

  it("writes a level one entry at a time, because that is how it is taken back", () => {
    const plan = draft({ opacity: 0.5, "transform.x": 1 });
    plan.set([...clipPath, "properties"], { opacity: 0.25, "transform.y": 2 });
    expect(plan.steps.map(({ patch }) => [patch.op, patch.path.at(-1)])).toEqual([
      ["delete", "transform.x"],
      ["set", "opacity"],
      ["set", "transform.y"],
    ]);
  });

  it("takes a level away one entry at a time", () => {
    const plan = draft({ opacity: 0.5, "transform.x": 1 });
    plan.delete([...clipPath, "properties"]);
    expect(plan.steps.map(({ patch }) => [patch.op, patch.path.at(-1)])).toEqual([
      ["delete", "opacity"],
      ["delete", "transform.x"],
    ]);
    expect(getIn(plan.state, [...clipPath, "properties"])).toBeUndefined();
  });

  it("finds the same when a level is replaced", () => {
    const plan = draft({ opacity: 0.5 });
    plan.replace([...clipPath, "properties"], {});
    expect(plan.steps.map(({ patch }) => patch.path.at(-1))).toEqual(["opacity"]);
  });

  it("the last entry takes its level along", () => {
    const plan = draft({ opacity: 0.5 });
    plan.delete([...clipPath, "properties", "opacity"]);
    expect(plan.state.timelines["main"]?.clips["c"]).not.toHaveProperty("properties");
  });

  it("writes a new version one value at a time, however far down they are", () => {
    const plan = draft();
    const version = ["timelines", "main", "overrides", "language.fr"];
    plan.set(version, {
      scope: { language: "fr" },
      sections: {},
      clips: { c: { hidden: { value: true }, properties: { opacity: { value: 0.5 } } } },
    });
    expect(plan.steps.map(({ patch }) => [patch.op, patch.path.slice(3).join("/")])).toEqual([
      ["set", "language.fr/scope"],
      ["set", "language.fr/clips/c/hidden"],
      ["set", "language.fr/clips/c/properties/opacity"],
    ]);
    plan.delete([...version, "clips", "c"]);
    expect(plan.steps.slice(3).map(({ patch }) => [patch.op, patch.path.at(-1)])).toEqual([
      ["delete", "hidden"],
      ["delete", "opacity"],
    ]);
    expect(getIn(plan.state, version)).toEqual({ scope: { language: "fr" } });
  });

  it("writes the strings of a language one at a time", () => {
    const plan = draft();
    plan.set(["locales", "fr"], { "intro.title": { text: "Atome" }, empty: undefined });
    expect(plan.steps.map(({ patch }) => patch.path)).toEqual([["locales", "fr", "intro.title"]]);
  });
});

describe("taking a step back", () => {
  const name = [...clipPath, "name"];

  /** Plans on top of an earlier plan, as a second change would. */
  const next = (plan: Draft, origin = "user") => new Draft(plan.state, origin, plan.written);

  it("puts back what it replaced", () => {
    const first = draft();
    first.set(name, "一");
    const [step] = first.steps;
    const second = next(first);
    expect(second.takeBack(step as Step)).toBe(true);
    expect(getIn(second.state, name)).toBeUndefined();
  });

  it("does not happen once somebody else wrote there, also with the same value", () => {
    const first = draft();
    first.set(name, "一");
    const [step] = first.steps;
    const second = next(first, "ai:other");
    second.set(name, "一");
    const third = next(second);
    expect(third.takeBack(step as Step)).toBe(false);
    expect(third.steps).toEqual([]);
    expect(getIn(third.state, name)).toBe("一");
  });

  it("hands the path back to what it replaced", () => {
    const first = draft();
    first.set(name, "一");
    const second = next(first);
    second.set(name, "二");
    const [one] = first.steps;
    const [two] = second.steps;
    const third = next(second);
    expect(third.takeBack(one as Step)).toBe(false);
    expect(third.takeBack(two as Step)).toBe(true);
    expect(third.takeBack(one as Step)).toBe(true);
    expect(getIn(third.state, name)).toBeUndefined();
  });

  it("can be done again with what it leaves", () => {
    const first = draft();
    first.set(name, "一");
    const second = next(first);
    second.takeBack(first.steps[0] as Step);
    const third = next(second);
    expect(third.takeBack(second.steps[0] as Step)).toBe(true);
    expect(getIn(third.state, name)).toBe("一");
    const fourth = next(third);
    expect(fourth.takeBack(third.steps[0] as Step)).toBe(true);
    expect(getIn(fourth.state, name)).toBeUndefined();
  });

  it("cannot be done again in something that was replaced in the meantime", () => {
    const first = draft();
    first.set(name, "一");
    const second = next(first);
    second.takeBack(first.steps[0] as Step);
    const third = next(second, "ai:other");
    third.delete(clipPath);
    const fourth = next(third);
    expect(fourth.takeBack(second.steps[0] as Step)).toBe(false);
    expect(getIn(fourth.state, clipPath)).toBeUndefined();
  });

  it("leaves what is above it as it found it", () => {
    const first = draft();
    first.set(["timelines", "main", "clips", "e"], { id: "e" });
    const second = next(first);
    second.set(["timelines", "main", "clips", "e", "name"], "一");
    const third = next(second);
    expect(third.takeBack(first.steps[0] as Step)).toBe(false);
    expect(third.takeBack(second.steps[0] as Step)).toBe(true);
    expect(third.takeBack(first.steps[0] as Step)).toBe(true);
    expect(getIn(third.state, ["timelines", "main", "clips", "e"])).toBeUndefined();
  });
});
