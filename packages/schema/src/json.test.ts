import { describe, expect, it } from "vitest";
import { stringifyDocument } from "./json.ts";

describe("stringifyDocument", () => {
  it("ends with one newline", () => {
    expect(stringifyDocument({ a: 1 })).toBe('{ "a": 1 }\n');
  });

  it("keeps a keyframe on one line, so that a change is one line in a diff", () => {
    const text = stringifyDocument({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
        { time: "1", value: 1 },
      ],
    });
    expect(text).toBe(
      [
        "{",
        '  "keys": [',
        '    { "time": "0", "value": 0, "interp": "bezier", "out": [0.42, 0] },',
        '    { "time": "1", "value": 1 }',
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("breaks what does not fit on a line", () => {
    const long = { text: "x".repeat(120), other: 1 };
    expect(stringifyDocument(long)).toContain('\n  "other": 1\n');
  });

  it("spreads out objects that contain objects", () => {
    expect(stringifyDocument({ a: { b: { c: 1 } } })).toBe(
      ["{", '  "a": {', '    "b": { "c": 1 }', "  }", "}", ""].join("\n"),
    );
  });

  it("writes empty containers compactly", () => {
    expect(stringifyDocument({ a: [], b: {}, c: { d: [] } })).toContain('"a": []');
  });

  it("keeps Chinese readable", () => {
    expect(stringifyDocument({ name: "原子" })).toContain("原子");
  });

  it("drops undefined values", () => {
    expect(stringifyDocument({ a: undefined, b: 1 })).toBe('{ "b": 1 }\n');
  });

  it("gives the same text for the same content", () => {
    const value = { a: [1, 2, { b: "c" }], d: "e" };
    expect(stringifyDocument(value)).toBe(stringifyDocument(JSON.parse(stringifyDocument(value))));
  });

  it("escapes what JSON has to escape", () => {
    const value = { text: 'quote " and\nnewline' };
    expect(JSON.parse(stringifyDocument(value))).toEqual(value);
  });
});
