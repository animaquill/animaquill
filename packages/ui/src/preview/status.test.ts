import type { SceneProblem } from "@animaquill/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewStatus, type PreviewMessages } from "./status.ts";

function setup() {
  const problem = vi.fn<PreviewMessages["problem"]>();
  const stopped = vi.fn<PreviewMessages["stopped"]>();
  const restarted = vi.fn();
  const status = new PreviewStatus({ problem, stopped, revisions: () => {}, restarted });
  const emitted = vi.fn();
  status.subscribe(emitted);
  return { status, problem, stopped, restarted, emitted };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("origins where something hung", () => {
  it("are remembered, once each", () => {
    const { status } = setup();
    status.noteRetired("https://a.example");
    status.noteRetired("https://b.example");
    status.noteRetired("https://a.example");
    expect(status.retiredOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("are not forgotten by anything that starts a compositor again", () => {
    const { status } = setup();
    status.noteRetired("https://a.example");
    status.hung();
    status.restart();
    status.restart({ runScenes: false });
    status.forgetScenes();
    expect(status.retiredOrigins).toEqual(["https://a.example"]);
  });
});

describe("a compositor that hangs", () => {
  it("that never came up is not started again, because that would not come up either", () => {
    const { status, restarted } = setup();
    status.hung("hello");
    expect(status.getSnapshot()).toMatchObject({ compositor: "unreachable", generation: 0 });
    expect(restarted).not.toHaveBeenCalled();
    status.restart();
    expect(status.getSnapshot()).toMatchObject({ compositor: "running", generation: 1 });
  });

  it("gets a new frame, and people hear about it", () => {
    const { status, restarted } = setup();
    status.hung();
    expect(status.getSnapshot()).toMatchObject({ compositor: "restarting", generation: 1 });
    expect(restarted).toHaveBeenCalledTimes(1);
  });

  it("is fine again when it answers", () => {
    const { status } = setup();
    status.hung();
    status.worked();
    expect(status.getSnapshot().compositor).toBe("running");
  });

  it("stays off after three times in a row, whatever it says in between", () => {
    const { status, restarted } = setup();
    status.hung();
    status.worked();
    status.hung();
    status.worked();
    status.hung();
    expect(status.getSnapshot()).toMatchObject({ compositor: "stopped", generation: 2 });
    expect(restarted).toHaveBeenCalledTimes(2);
  });

  it("gets a clean slate after it worked for a while", () => {
    const { status } = setup();
    status.hung();
    status.hung();
    vi.advanceTimersByTime(60000);
    status.worked();
    status.hung();
    expect(status.getSnapshot().compositor).toBe("restarting");
  });

  it("starts again when somebody asks, and counts from the start", () => {
    const { status } = setup();
    status.hung();
    status.hung();
    status.hung();
    status.restart();
    expect(status.getSnapshot()).toMatchObject({ compositor: "running", generation: 3 });
    status.hung();
    expect(status.getSnapshot().compositor).toBe("restarting");
  });

  it("can go on without scenes, and come back to them", () => {
    const { status } = setup();
    status.restart({ runScenes: false });
    expect(status.getSnapshot().runScenes).toBe(false);
    status.hung();
    expect(status.getSnapshot().runScenes).toBe(false);
    status.restart({ runScenes: true });
    expect(status.getSnapshot().runScenes).toBe(true);
  });

  it("forgets what it knew of scenes", () => {
    const { status } = setup();
    status.noteScene("a", { state: "stopped", reason: "flood" });
    status.hung();
    expect(status.getSnapshot().scenes.size).toBe(0);
  });
});

describe("how scenes are doing", () => {
  it("only keeps what is worth saying", () => {
    const { status } = setup();
    status.noteScene("a", { state: "opening" });
    status.noteScene("a", { state: "ready" });
    expect(status.getSnapshot().scenes.size).toBe(0);
    status.noteScene("a", { state: "stopped", reason: "silent" });
    expect(status.getSnapshot().scenes.get("a")).toMatchObject({ state: "stopped" });
    status.noteScene("a", { state: "closed" });
    expect(status.getSnapshot().scenes.size).toBe(0);
  });

  it("says nothing when nothing changed", () => {
    const { status, emitted } = setup();
    status.noteScene("a", { state: "ready" });
    status.forgetScenes();
    expect(emitted).not.toHaveBeenCalled();
  });

  const said: SceneProblem = { kind: "error", message: "oops", frame: 1 };
  const firsts = (problem: ReturnType<typeof setup>["problem"]) =>
    problem.mock.calls.map(([, , , first]) => first);

  it("passes on all problems, and says which one is the first of a state of a scene", () => {
    const { status, problem } = setup();
    for (let count = 0; count < 3; count += 1) status.noteProblem("a", "1", said);
    expect(firsts(problem)).toEqual([true, false, false]);
  });

  it("counts a new state of a scene as new, which no opening says", () => {
    const { status, problem } = setup();
    status.noteProblem("a", "1", said);
    status.noteProblem("a", "2", said);
    expect(firsts(problem)).toEqual([true, true]);
  });

  it("keeps count by clip, and starts over when a scene starts over", () => {
    const { status, problem } = setup();
    status.noteProblem("a", "1", said);
    status.noteProblem("b", "1", said);
    status.noteProblem("a", "1", said);
    status.noteScene("a", { state: "opening" });
    status.noteProblem("a", "1", said);
    expect(firsts(problem)).toEqual([true, true, false, true]);
  });

  it("says which scenes stopped, and when that is over", () => {
    const { status, stopped } = setup();
    const failed = { state: "stopped", reason: "silent" } as const;
    status.noteScene("a", failed);
    status.noteScene("a", { state: "ready" });
    expect(stopped.mock.calls).toEqual([
      ["a", failed],
      ["a", undefined],
    ]);
  });
});
