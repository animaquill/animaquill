import { describe, expect, it, vi } from "vitest";
import { problemDelta, problemId, withId, type ProblemFields } from "./model.ts";
import { ProblemSet } from "./set.ts";
import { staticProblems } from "./static.ts";
import { TONE, audio, color, stateOf, tone, video } from "./test-support.ts";

const threw = (detail: string, line?: number): ProblemFields => ({
  source: "runtime",
  severity: "error",
  code: "scene-error",
  params: {},
  subject: { kind: "scene", id: "a" },
  file: "scenes/a/index.html",
  detail,
  ...(line !== undefined && { line }),
});

describe("the id of a problem", () => {
  it("is the same for the same problem, from two calculations", () => {
    const state = () =>
      stateOf({
        tracks: [
          video([color("idea", { draft: true })]),
          audio([tone("t", { loop: true, duration: "20" })]),
        ],
        assets: TONE,
      });
    const first = staticProblems(state()).map(({ id }) => id);
    expect(first).toHaveLength(2);
    expect(staticProblems(state()).map(({ id }) => id)).toEqual(first);
  });

  it("tells problems apart by what and where, and not by how bad they are", () => {
    expect(problemId(threw("坏了", 3))).toBe(problemId(threw("坏了", 3)));
    expect(problemId(threw("坏了", 3))).not.toBe(problemId(threw("坏了", 4)));
    expect(problemId(threw("坏了"))).not.toBe(problemId(threw("别的")));
    expect(problemId({ ...threw("坏了"), severity: "warning" })).toBe(problemId(threw("坏了")));
    expect(problemId({ ...threw("坏了"), params: { a: 1, b: "2" } })).toBe(
      problemId({ ...threw("坏了"), params: { b: "2", a: 1 } }),
    );
    expect(problemId(threw("坏了"))).toMatch(/^scene-error-[0-9a-z]+$/);
  });
});

describe("what changed between two lists of problems", () => {
  it("is what came and what went, by id", () => {
    const [a, b, c] = ["一", "二", "三"].map((text) => withId(threw(text)));
    if (!a || !b || !c) throw new Error("No problems");
    const { added, resolved } = problemDelta([a, b], [{ ...b }, c]);
    expect(added).toEqual([c]);
    expect(resolved).toEqual([a]);
    expect(problemDelta([a], [a])).toEqual({ added: [], resolved: [] });
  });
});

describe("the problems of a project", () => {
  it("has what the project tells and what the host reports, each once, files first", () => {
    const set = new ProblemSet({ reports: ["runtime"] });
    set.update(stateOf({ tracks: [video([color("idea", { draft: true })])] }));
    set.report("runtime", "scenes", [withId(threw("坏了", 3)), withId(threw("坏了", 3))]);
    expect(set.all().map(({ code }) => code)).toEqual(["scene-error", "unsupported-draft"]);
    expect(set.sources()).toEqual(["unsupported", "runtime"]);
  });

  it("replaces what a source said of one thing, and nothing else", () => {
    const set = new ProblemSet();
    set.report("editor", "a.js", [withId(threw("语法"))]);
    set.report("editor", "b.js", [withId(threw("别的"))]);
    set.report("editor", "a.js", []);
    expect(set.all().map(({ detail }) => detail)).toEqual(["别的"]);
  });

  it("tells nobody when nothing changed", () => {
    const set = new ProblemSet();
    const state = stateOf({ tracks: [video([color("idea", { draft: true })])] });
    set.update(state);
    set.report("editor", "a.js", [withId(threw("语法"))]);
    const heard = vi.fn();
    set.subscribe(heard);
    set.update(state);
    set.report("editor", "a.js", [withId(threw("语法"))]);
    set.report("editor", "b.js", []);
    expect(heard).not.toHaveBeenCalled();
    set.update(stateOf({ tracks: [video([color("idea")])] }));
    expect(heard).toHaveBeenCalledOnce();
    expect(set.all().map(({ detail }) => detail)).toEqual(["语法"]);
  });

  it("hears of what an export would do otherwise, also when the problem stays", () => {
    const set = new ProblemSet();
    set.update(stateOf({ tracks: [video([color("idea", { draft: true })])] }));
    const heard = vi.fn();
    set.subscribe(heard);
    set.update(stateOf({ tracks: [video([color("idea", { draft: true, hidden: true })])] }));
    expect(heard).toHaveBeenCalledOnce();
    expect(set.all()[0]?.affectsOutput).toBeUndefined();
  });

  it("starts over with another project", () => {
    const set = new ProblemSet();
    set.report("import", "all", [withId(threw("没带来"))]);
    set.update(stateOf({ tracks: [video([color("idea", { draft: true })])] }));
    set.clear();
    expect(set.all()).toEqual([]);
  });

  it("has a limit, because a project can say anything", () => {
    const set = new ProblemSet();
    set.report(
      "runtime",
      "scenes",
      Array.from({ length: 600 }, (_, index) => withId(threw(`第 ${index} 个`))),
    );
    expect(set.all()).toHaveLength(500);
  });
});
