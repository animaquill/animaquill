import { describe, expect, it } from "vitest";
import { HOWTO_PAGES, TYPE_PAGES } from "./guide/pages.ts";
import { HAS_CHINESE } from "./issues.ts";
import { AI_OPERATIONS, fieldsOf, operationsParameter } from "./schema.ts";
import { ADVICE, COMMAND, DIRECTIVE_PHRASES, toolsOn } from "./test-support.ts";

type Node = Record<string, unknown>;

/** The text of a page, without the revision line and the topic line before it. */
async function page(topic: string): Promise<string> {
  const { call } = toolsOn();
  const result = await call("aq_guide", { topic });
  expect(result.isError, `${topic}: ${result.text}`).toBe(false);
  return result.text.split("\n").slice(2).join("\n");
}

/** The names of the fields of a shared type, through lists, choices and the types it holds. */
function fieldNames(node: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) fieldNames(item, names);
    return names;
  }
  if (typeof node !== "object" || node === null) return names;
  const schema = node as Node;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [name, inner] of Object.entries(value)) {
        names.add(name);
        fieldNames(inner, names);
      }
    } else if (key === "items" || key === "anyOf" || key === "oneOf") {
      fieldNames(value, names);
    }
  }
  return names;
}

/** What the words of a page say, as sentences: without list marks, headings and batches. */
const prose = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.startsWith('[{"op":'))
    .map((line) => line.replace(/^\s*(?:- |# )/, ""))
    .join("\n");

describe("the manual", () => {
  it("has a page for every operation, with every parameter and field, and why it fails", async () => {
    for (const op of AI_OPERATIONS) {
      const text = await page(`ops/${op.name}`);
      for (const { path } of fieldsOf(op.name)) {
        const line = text.split("\n").find((each) => each.trimStart().startsWith(`- ${path} (`));
        expect(line, `${op.name} ${path}`).toBeDefined();
        // Every one has words of its own, not only a type.
        expect(line, `${op.name} ${path}`).toMatch(/\): \S/);
      }
      expect(text, op.name).toContain("Errors of its own");
      expect(text, op.name).toMatch(/Examples[^\n]*\n- \S/);
    }
  });

  it("has a page for every type that operations share, which names every field of it", async () => {
    const defs = (operationsParameter() as Node).$defs as Record<string, Node>;
    for (const [name, schema] of Object.entries(defs)) {
      const text = await page(`types/${name}`);
      for (const field of fieldNames(schema)) {
        expect(text, `${name}.${field}`).toMatch(new RegExp(`\\b${field}\\b`));
      }
    }
  });

  it("says what is so, in English, in the pages it has of its own", async () => {
    const { call } = toolsOn();
    const contents = (await call("aq_guide")).text;
    const topics = contents
      .split("\n")
      .map((line) => line.split(" ")[0] ?? "")
      .filter((topic) => /^(ops|types|howto)\//.test(topic));
    expect(topics.length).toBe(AI_OPERATIONS.length + TYPE_PAGES.length + HOWTO_PAGES.length);
    const found: string[] = [];
    for (const topic of topics) {
      const text = prose(await page(topic));
      if (HAS_CHINESE.test(text)) found.push(`${topic}: Chinese`);
      if (/\b(IMPORTANT|MUST|NEVER|ALWAYS|CRITICAL)\b/.test(text)) found.push(`${topic}: capitals`);
      for (const phrase of [...DIRECTIVE_PHRASES, ...ADVICE, COMMAND]) {
        const match = phrase.exec(text);
        if (match)
          found.push(
            `${topic}: ${String(phrase)} at "${text.slice(match.index, match.index + 60)}"`,
          );
      }
    }
    const english = contents
      .split("\n")
      .filter(
        (line) => !/^(format|scene-runtime)\//.test(line) && !line.startsWith("The project format"),
      )
      .join("\n");
    for (const phrase of [...DIRECTIVE_PHRASES, ...ADVICE, COMMAND]) {
      if (phrase.test(prose(english))) found.push(`contents: ${String(phrase)}`);
    }
    expect(found).toEqual([]);
  });

  it("finds a page by any type it is about, and pages by their titles first", async () => {
    expect(await page("types/Key")).toBe(await page("types/PropertyValue"));
    const { call } = toolsOn();
    const found = (await call("aq_guide", { query: "keyframe" })).text.split("\n").slice(1);
    expect(found[0]).toMatch(/^howto\/keyframes: /);
    expect(found.join("\n")).toContain("format/时间轴");
    const missing = await call("aq_guide", { topic: "types/Keys" });
    expect(missing.text).toMatch(
      /^error not-found: no topic "types\/Keys"\. Similar: [^\n]*types\/Key/,
    );
  });

  it("gives a table of contents that one result holds", async () => {
    const { call } = toolsOn();
    const contents = (await call("aq_guide")).text;
    expect(contents.length).toBeLessThan(12_000);
    expect(contents).not.toContain("more lines left out");
  });
});
