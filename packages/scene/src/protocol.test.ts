import { describe, expect, it } from "vitest";
import { readFromScene } from "./protocol.ts";

const problem = { kind: "error", message: "boom", file: "a.js", line: 3, column: 7, frame: 12 };

describe("readFromScene", () => {
  it.each([
    [{ type: "hello", runtime: 1, capture: true }],
    [{ type: "ready", width: 1920, height: 1080 }],
    [{ type: "failed", message: "no" }],
    [{ type: "seeked", request: 3, frame: 7, stateful: false }],
    [{ type: "needs-replay", request: 3, frame: 7 }],
    [{ type: "position", frame: 7 }],
    [{ type: "progress", frame: 7 }],
    [{ type: "problem", problem }],
    [{ type: "pong", nonce: 9 }],
  ])("takes %j", (message) => {
    expect(readFromScene(message)).toEqual(message);
  });

  it.each([
    [undefined],
    [null],
    ["hello"],
    [7],
    [[]],
    [{}],
    [{ type: "nothing" }],
    [{ type: "constructor" }],
    [{ type: "hello" }],
    [{ type: "hello", runtime: "1" }],
    [{ type: "ready", width: Number.NaN, height: 1 }],
    [{ type: "seeked", request: 1.5, frame: 1 }],
    [{ type: "seeked", request: 1, frame: Number.POSITIVE_INFINITY }],
    [{ type: "needs-replay", request: 1 }],
    [{ type: "position", frame: "7" }],
    [{ type: "position", frame: -5 }],
    [{ type: "progress", frame: -1 }],
    [{ type: "seeked", request: -1, frame: 1 }],
    [{ type: "seeked", request: 1, frame: -9 }],
    [{ type: "needs-replay", request: 1, frame: -9 }],
    [{ type: "pong", nonce: -1 }],
    [{ type: "problem", problem: { ...problem, frame: -1 } }],
    [{ type: "problem", problem: "boom" }],
    [{ type: "problem", problem: { ...problem, kind: "anything" } }],
    [{ type: "problem", problem: { ...problem, frame: undefined } }],
    [{ type: "pong" }],
  ])("drops %j", (message) => {
    expect(readFromScene(message)).toBeUndefined();
  });

  it("drops a place that cannot be one", () => {
    const read = readFromScene({ type: "problem", problem: { ...problem, line: -7, column: -2 } });
    const { line: _, column: __, ...rest } = problem;
    expect(read).toEqual({ type: "problem", problem: rest });
  });

  it("keeps only what it knows", () => {
    const read = readFromScene({ type: "pong", nonce: 1, extra: {}, code: "x" });
    expect(read).toEqual({ type: "pong", nonce: 1 });
    const message = { type: "problem", problem: { ...problem, extra: 1, line: "3" } };
    const { line: _, ...rest } = problem;
    expect(readFromScene(message)).toEqual({ type: "problem", problem: rest });
  });

  it("does not let a scene send a novel", () => {
    const long = "x".repeat(1_000_000);
    const read = readFromScene({
      type: "problem",
      problem: { ...problem, message: long, stack: long, target: long, file: long, code: long },
    });
    expect(JSON.stringify(read).length).toBeLessThan(20000);
    const failed = readFromScene({ type: "failed", message: long });
    expect(JSON.stringify(failed).length).toBeLessThan(3000);
  });

  it("does not take what a scene claims as a capability", () => {
    expect(readFromScene({ type: "hello", runtime: 1, capture: "yes" })).toEqual({
      type: "hello",
      runtime: 1,
      capture: false,
    });
  });
});
