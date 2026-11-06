import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { Draft } from "./draft.ts";
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
    expect(plan.steps[0]?.patch).toMatchObject({ op: "set", value: { id: "e" } });
    expect(plan.steps[0]?.after).toEqual({ id: "e" });
  });

  it("remembers what each step left, also when a path is written twice", () => {
    const plan = draft();
    plan.set([...clipPath, "name"], "一");
    plan.set([...clipPath, "name"], "二");
    plan.delete([...clipPath, "name"]);
    expect(plan.steps.map(({ after }) => after)).toEqual(["一", "二", undefined]);
  });

  it("knows the owner of a level that has no entries yet", () => {
    const plan = draft();
    expect(plan.hasParent([...clipPath, "properties", "opacity"])).toBe(true);
    expect(plan.hasParent(["timelines", "main", "clips", "e", "properties", "opacity"])).toBe(
      false,
    );
    expect(plan.hasParent(["assets", "a"])).toBe(true);
  });

  it("the last entry takes its level along", () => {
    const plan = draft({ opacity: 0.5 });
    plan.delete([...clipPath, "properties", "opacity"]);
    expect(plan.state.timelines["main"]?.clips["c"]).not.toHaveProperty("properties");
  });
});
