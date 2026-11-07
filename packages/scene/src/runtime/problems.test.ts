import { describe, expect, it } from "vitest";
import type { ScriptSource } from "../loader/project.ts";
import type { SceneProblem } from "../protocol.ts";
import { placeOf, ProblemLog, readStack } from "./problems.ts";

const sources = new Map<string, ScriptSource>([
  ["blob:null/a", { path: "scenes/a/a.js", shift: 0 }],
  ["blob:null/b", { path: "scenes/a/b.js", shift: 20 }],
]);

describe("placeOf", () => {
  it("names the file of a blob", () => {
    expect(placeOf("blob:null/a", 3, 7, sources)).toEqual({
      file: "scenes/a/a.js",
      line: 3,
      column: 7,
    });
  });

  it("takes out what went in front of the first line", () => {
    expect(placeOf("blob:null/b", 1, 27, sources)?.column).toBe(7);
    expect(placeOf("blob:null/b", 2, 27, sources)?.column).toBe(27);
    expect(placeOf("blob:null/b", 1, 3, sources)?.column).toBe(1);
  });

  it("knows only what it knows", () => {
    expect(placeOf("blob:null/runtime", 1, 1, sources)).toBeUndefined();
    expect(placeOf(undefined, 1, 1, sources)).toBeUndefined();
  });
});

describe("readStack", () => {
  it("speaks of files, and leaves the runtime out", () => {
    const stack = [
      "Error: boom",
      "    at inner (blob:null/b:1:30)",
      "    at blob:null/a:7:5",
      "    at SceneClock.call (blob:null/runtime:99:3)",
      "    at async run (blob:null/runtime:12:1)",
    ].join("\n");
    expect(readStack(stack, sources)).toEqual({
      stack: ["Error: boom", "    at inner (scenes/a/b.js:1:10)", "    at scenes/a/a.js:7:5"].join(
        "\n",
      ),
      top: { file: "scenes/a/b.js", line: 1, column: 10 },
    });
  });

  it("finds no place in a stack that has none of the project in it", () => {
    expect(readStack("Error: boom\n    at blob:null/runtime:1:1", sources)).toEqual({
      stack: "Error: boom",
    });
  });
});

describe("ProblemLog", () => {
  function setup() {
    const sent: SceneProblem[] = [];
    const log = new ProblemLog(
      (problem) => sent.push(problem),
      () => 12,
    );
    log.sources = sources;
    return { log, sent };
  }

  it("says which frame it happened on", () => {
    const { log, sent } = setup();
    log.report({ kind: "api", code: "top-layer" });
    expect(sent).toEqual([{ kind: "api", code: "top-layer", frame: 12 }]);
  });

  it("reports the same thing once", () => {
    const { log, sent } = setup();
    for (let round = 0; round < 10; round += 1) {
      log.report({ kind: "error", message: "again", file: "a.js", line: 1 });
    }
    log.report({ kind: "error", message: "again", file: "a.js", line: 2 });
    expect(sent).toHaveLength(2);
  });

  it("stops at some point, whatever the differences", () => {
    const { log, sent } = setup();
    for (let round = 0; round < 500; round += 1) {
      log.report({ kind: "error", message: `number ${round}` });
    }
    expect(sent).toHaveLength(100);
  });

  it("keeps what project code writes down to a size that fits a message", () => {
    const { log, sent } = setup();
    const error = new Error("x".repeat(1000000));
    error.stack = `Error: ${"y".repeat(1000000)}\n    at blob:null/a:5:9`;
    log.thrown("error", error);
    log.report({ kind: "resource", target: "z".repeat(1000000) });
    expect(JSON.stringify(sent).length).toBeLessThan(20000);
  });

  it("holds back what the sandbox stopped until the page is there", () => {
    const { log, sent } = setup();
    log.report({ kind: "blocked", target: "http://scene/a.png" });
    log.report({ kind: "blocked", target: "http://elsewhere/b.png" });
    log.report({ kind: "error", message: "not this" });
    expect(sent.map(({ kind }) => kind)).toEqual(["error"]);
    log.release(new Set(["http://scene/a.png"]));
    expect(sent.map(({ target }) => target)).toEqual([undefined, "http://elsewhere/b.png"]);
    log.report({ kind: "blocked", target: "http://elsewhere/c.png" });
    expect(sent.at(-1)?.target).toBe("http://elsewhere/c.png");
  });

  it("holds back what did not load in the same way, because the same mix-up causes that", () => {
    const { log, sent } = setup();
    log.report({ kind: "resource", target: "http://scene/a.png" });
    log.report({ kind: "resource", target: "http://scene/b.png" });
    expect(sent).toEqual([]);
    log.release(new Set(["http://scene/a.png"]));
    expect(sent.map(({ target }) => target)).toEqual(["http://scene/b.png"]);
  });

  it("finds the place of what was thrown", () => {
    const { log, sent } = setup();
    const error = new TypeError("no");
    error.stack = "TypeError: no\n    at blob:null/a:5:9";
    log.thrown("error", error);
    expect(sent).toEqual([
      {
        kind: "error",
        message: "TypeError: no",
        file: "scenes/a/a.js",
        line: 5,
        column: 9,
        stack: "TypeError: no\n    at scenes/a/a.js:5:9",
        frame: 12,
      },
    ]);
  });

  it("takes anything that can be thrown", () => {
    const { log, sent } = setup();
    log.thrown("rejection", "a string");
    log.thrown("rejection", 42);
    log.thrown("rejection", undefined);
    log.thrown("rejection", { an: "object" });
    expect(sent.map(({ message }) => message)).toEqual([
      "a string",
      "42",
      "undefined",
      "[object Object]",
    ]);
  });

  it("finds the place in a stack that came as text, as it does out of a worker", () => {
    const { log, sent } = setup();
    log.thrown("error", "Uncaught Error: Error: no\n    at blob:null/a:5:9");
    expect(sent[0]).toMatchObject({
      message: "Uncaught Error: Error: no",
      file: "scenes/a/a.js",
      line: 5,
      column: 9,
    });
  });

  it("falls back on the place the browser gave", () => {
    const { log, sent } = setup();
    log.thrown("error", "a string", { file: "a.js", line: 3, column: 1 });
    expect(sent[0]).toMatchObject({ file: "a.js", line: 3, column: 1 });
  });
});
