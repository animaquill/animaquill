import { describe, expect, it } from "vitest";
import { textKeys } from "./text-keys.ts";
import { DEFAULT_TEXTS, type TextTable } from "./texts/index.ts";
import { testHost, toolsOn } from "./test-support.ts";
import { createToolset } from "./toolset.ts";
import { CallerState } from "./caller.ts";

const listOf = (texts?: TextTable) =>
  createToolset(testHost(), new CallerState(), texts).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

describe("the table of texts", () => {
  it("has every key the tools need, and no key they do not have", () => {
    const keys = new Map(textKeys().map((key) => [key.key, key]));
    const missing = [...keys.values()]
      .filter(({ key, required }) => required && DEFAULT_TEXTS[key] === undefined)
      .map(({ key }) => key);
    expect(missing).toEqual([]);
    const unknown = Object.keys(DEFAULT_TEXTS).filter((key) => !keys.has(key));
    expect(unknown).toEqual([]);
    const wrongKind = Object.entries(DEFAULT_TEXTS)
      .filter(([key, value]) => (keys.get(key)?.kind === "examples") !== Array.isArray(value))
      .map(([key]) => key);
    expect(wrongKind).toEqual([]);
  });

  it("is where the tools take their words from, and only their words", () => {
    const texts: TextTable = {
      ...DEFAULT_TEXTS,
      "tools.aq_search.description": "Find things.",
      "tools.aq_file_edit.params.edits.old_text": "The text to replace.",
      "ops.clip.move.summary": "move clips",
      "params.clip": "The clip.",
      "types.Key": "A keyframe.",
      "edit.examples": [[{ op: "project.rename", name: "x" }]],
    };
    const before = listOf();
    const after = listOf(texts);
    const json = JSON.stringify(after);
    expect(json).toContain("Find things.");
    expect(json).toContain("The text to replace.");
    expect(json).toContain(
      "clip.move {timeline, clips:[{clip, start?, track?}], overlap?} — move clips",
    );
    expect(json).toContain("The clip.");
    expect(json).toContain("A keyframe.");
    expect(json).toContain('[{\\"op\\":\\"project.rename\\",\\"name\\":\\"x\\"}]');
    // The names, the order and the structure stay.
    expect(after.map(({ name }) => name)).toEqual(before.map(({ name }) => name));
    const strip = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value), (key, inner: unknown) =>
        key === "description" ? undefined : inner,
      );
    expect(strip(after.map(({ inputSchema }) => inputSchema))).toEqual(
      strip(before.map(({ inputSchema }) => inputSchema)),
    );
    // The default table still gives what it gave.
    expect(listOf()).toEqual(before);
  });

  it("gives an example after an error from the table of the tools", async () => {
    const texts: TextTable = {
      ...DEFAULT_TEXTS,
      "ops.clip.move.examples": [{ title: "Move", params: { timeline: "main", clips: [] } }],
    };
    const { call } = toolsOn(testHost(), new CallerState(), texts);
    const result = await call("aq_edit", { operations: [{ op: "clip.move", timeline: 3 }] });
    expect(result.text).toContain('example: {"op":"clip.move","timeline":"main","clips":[]}');
  });
});
