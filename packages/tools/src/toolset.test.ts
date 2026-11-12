import { readFileSync } from "node:fs";
import { createProject } from "@animaquill/schema";
import { ProjectStore, aiTask } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { PROJECT_FORMAT, SCENE_RUNTIME } from "./guide/texts.ts";
import { HAS_CHINESE } from "./issues.ts";
import { PROBLEM_TEXTS, STATIC_PROBLEM_CODES } from "./problems-en.ts";
import { AI_OPERATIONS } from "./schema.ts";
import { DIRECTIVE_OVERRIDES, DIRECTIVE_TEXTS } from "./texts/eval/directive.ts";
import { DEFAULT_TEXTS, editExamples, operationExamples } from "./texts/index.ts";
import { ADVICE, DIRECTIVE_PHRASES, openSample, testHost, toolsOn } from "./test-support.ts";
import { TOOLSET_VERSION } from "./toolset.ts";
import type { Tool } from "./types.ts";

/**
 * How many characters the list of tools takes, as services get it: names, descriptions and the
 * schemas of parameters. Measured 52 874 (2026-11-12, toolset 2026.2; 2026.1 took 54 191); the 48 tools before took
 * 67 322. It is a ceiling, so that the list does not grow unnoticed.
 */
const MOST_CHARACTERS = 55_000;

const listOf = (tools: Iterable<Tool>) =>
  [...tools].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

type Node = Record<string, unknown>;

/** Every place in a schema, with its JSON pointer. */
function* walk(node: unknown, pointer = "#"): Generator<[string, Node]> {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walk(item, `${pointer}/${index}`);
    return;
  }
  yield [pointer, node as Node];
  for (const [key, item] of Object.entries(node)) yield* walk(item, `${pointer}/${key}`);
}

function resolve(root: unknown, ref: string): unknown {
  let node = root;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    node = (node as Node | undefined)?.[part];
  }
  return node;
}

/** The text of a result, without the epoch of the revision, which is new for every store. */
const plain = (text: string) => text.replace(/^rev [a-z0-9]+:/, "rev <epoch>:");

describe("the toolset", () => {
  it("is twelve tools, in a fixed order", () => {
    const { tools } = toolsOn();
    expect([...tools.keys()]).toEqual([
      "aq_project_status",
      "aq_timeline_read",
      "aq_object_read",
      "aq_search",
      "aq_file_read",
      "aq_selection_read",
      "aq_guide",
      "aq_edit",
      "aq_file_edit",
      "aq_file_write",
      "aq_propose",
      "aq_check_run",
    ]);
  });

  it("as the comparison table has it, is toolset 2026.1 to the byte", async () => {
    const list = JSON.stringify(
      listOf(toolsOn(testHost(), undefined, DIRECTIVE_TEXTS).tools.values()),
      null,
      1,
    );
    expect(list).toBe(
      readFileSync(new URL("__snapshots__/toolset-2026.1.json", import.meta.url), "utf8"),
    );
  });

  it("is the same to the byte within a version, and no larger than it was", async () => {
    const { tools } = toolsOn();
    const list = JSON.stringify(listOf(tools.values()));
    expect(JSON.stringify(listOf(toolsOn().tools.values()))).toBe(list);
    expect(list.length).toBeLessThanOrEqual(MOST_CHARACTERS);
    await expect(JSON.stringify(listOf(tools.values()), null, 1)).toMatchFileSnapshot(
      `__snapshots__/toolset-${TOOLSET_VERSION}.json`,
    );
  });

  it("describes every parameter, also of every operation", () => {
    const missing: string[] = [];
    for (const tool of toolsOn().tools.values()) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Node>;
      for (const [name, schema] of Object.entries(properties)) {
        if (typeof schema.description !== "string") missing.push(`${tool.name}.${name}`);
      }
      if (tool.name !== "aq_edit") continue;
      const operations = properties.operations as Node;
      for (const branch of (operations.items as Node).anyOf as Node[]) {
        const op = ((branch.properties as Node).op as Node).const;
        for (const [name, schema] of Object.entries(branch.properties as Record<string, Node>)) {
          if (name !== "op" && typeof schema.description !== "string")
            missing.push(`${String(op)}.${name}`);
        }
      }
      for (const [name, schema] of Object.entries(operations.$defs as Record<string, Node>)) {
        if (typeof schema.description !== "string") missing.push(`$defs.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the types that operations share where every reference finds them", () => {
    for (const tool of toolsOn().tools.values()) {
      expect(tool.inputSchema.$defs, tool.name).toBeUndefined();
      for (const [pointer, node] of walk(tool.inputSchema)) {
        if (typeof node.$ref !== "string") continue;
        expect(node.$ref, pointer).toMatch(/^#\/properties\/operations\/\$defs\//);
        expect(resolve(tool.inputSchema, node.$ref), `${tool.name} ${pointer}`).toBeDefined();
      }
    }
  });

  it("speaks English to AI, plainly", () => {
    const list = JSON.stringify(listOf(toolsOn().tools.values()));
    expect(list).not.toMatch(HAS_CHINESE);
    expect(list).not.toMatch(/\b(IMPORTANT|MUST|NEVER|ALWAYS|CRITICAL)\b/);
    for (const code of STATIC_PROBLEM_CODES) {
      expect(PROBLEM_TEXTS[code], code).toBeDefined();
      expect(PROBLEM_TEXTS[code]?.({}) ?? "", code).not.toMatch(HAS_CHINESE);
      for (const advice of ADVICE)
        expect(PROBLEM_TEXTS[code]?.({}) ?? "", code).not.toMatch(advice);
    }
  });

  it("says what tools are and do, and does not tell AI when to call them", () => {
    // What tells a model what to do, or always to do it, makes new models call tools for that
    // even where they need not: the words of the tools only say what is so. How to work is for
    // the system prompt, once. Each of these phrases is a command in every context they can be in.
    const found = [...DIRECTIVE_PHRASES, ...ADVICE].flatMap((phrase) =>
      Object.entries(DEFAULT_TEXTS)
        .filter(([key, value]) => !key.startsWith("system.") && phrase.test(JSON.stringify(value)))
        .map(([key]) => `${key}: ${String(phrase)}`),
    );
    expect(found).toEqual([]);
    // The table they replaced had them, which the check finds.
    const before = DIRECTIVE_PHRASES.filter((phrase) =>
      Object.values(DIRECTIVE_OVERRIDES).some((value) => phrase.test(JSON.stringify(value))),
    );
    expect(before.length).toBeGreaterThan(5);
  });

  it("lists every operation AI can use in the description of aq_edit, and no other", () => {
    const description = toolsOn().tools.get("aq_edit")?.description ?? "";
    for (const op of AI_OPERATIONS) expect(description).toContain(`${op.name} {`);
    expect(description).not.toContain("clip.setProperty");
    expect(description).not.toContain("asset.add ");
  });

  it("has examples that fit and run on the sample project", () => {
    const store = openSample();
    const edit = toolsOn(testHost(store)).tools.get("aq_edit") as Tool;
    const batches = [
      ...AI_OPERATIONS.flatMap(({ name: op }) =>
        operationExamples(DEFAULT_TEXTS, op).map(({ params }) => [{ op, ...params }]),
      ),
      ...editExamples(DEFAULT_TEXTS),
    ];
    for (const operations of batches) {
      expect(edit.validate({ operations }), JSON.stringify(operations)).toBeUndefined();
      const calls = operations.map(({ op, ...params }) => ({ type: String(op), params }));
      const result = store.executeBatch(calls, { origin: aiTask("t"), dryRun: true });
      expect(result.ok, `${JSON.stringify(operations)} ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("gives the manual from the documents as they are", () => {
    const read = (name: string) =>
      readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8");
    // Run `pnpm --filter @animaquill/tools guide-texts` when one of them changed.
    expect(PROJECT_FORMAT).toBe(read("project-format.md"));
    expect(SCENE_RUNTIME).toBe(read("scene-runtime.md"));
  });
});

describe("results", () => {
  /** What AI reads of the sample project: the compact lines are its view of a project. */
  it.each([
    ["aq_project_status", {}],
    ["aq_timeline_read", {}],
    [
      "aq_object_read",
      { ids: ["clip_interview", "track_voice", "project"], response_format: "concise" },
    ],
    ["aq_search", { query: "logo" }],
    ["aq_check_run", { limit: 5 }],
    ["aq_guide", { topic: "ops/property.edit" }],
  ])("of %s read as they did", async (name, args) => {
    const { call } = toolsOn();
    const result = await call(name, args);
    expect(result.isError).toBe(false);
    expect(plain(result.text)).toMatchSnapshot();
  });

  it("go on with a cursor, which a change of the project makes out of date", async () => {
    const project = createProject({ name: "长" });
    const main = project.timelines.get("main")?.document as Node;
    const clips = Array.from({ length: 300 }, (_, index) => ({
      id: `c${index}`,
      start: String(index),
      duration: "1",
      source: { kind: "color", color: "#000000" },
    }));
    const store = ProjectStore.create({
      ...project,
      timelines: new Map([
        [
          "main",
          {
            document: { ...main, tracks: [{ id: "v", kind: "video", clips }] } as never,
            overrides: new Map(),
          },
        ],
      ]),
    });
    const { call, caller } = toolsOn(testHost(store));
    const first = await call("aq_timeline_read", { limit: 120 });
    expect(first.text).toContain("clips 1-120 of 300, by start:");
    expect(first.text).toContain('180 more: call again with cursor "c1"');
    const next = await call("aq_timeline_read", { limit: 120, cursor: "c1" });
    expect(next.text).toContain("clips 121-240 of 300");
    expect(next.text).toContain("c120 track=v 120..121");
    caller.beginAnswer();
    await call("aq_edit", { operations: [{ op: "project.rename", name: "改了" }] });
    const late = await call("aq_timeline_read", { limit: 120, cursor: "c2" });
    expect(late.text).toMatch(/^error cursor-expired/);
    const other = await call("aq_timeline_read", { limit: 50, cursor: "c1" });
    expect(other.text).toMatch(/^error cursor-expired/);
  });

  it("stay within 40 000 characters, cut at a line that says how to go on", async () => {
    const project = createProject({ name: "长" });
    const main = project.timelines.get("main")?.document as Node;
    const clips = Array.from({ length: 500 }, (_, index) => ({
      id: `c${index}`,
      name: "x".repeat(200),
      start: String(index),
      duration: "1",
      source: { kind: "color", color: "#000000" },
    }));
    const store = ProjectStore.create({
      ...project,
      timelines: new Map([
        [
          "main",
          {
            document: { ...main, tracks: [{ id: "v", kind: "video", clips }] } as never,
            overrides: new Map(),
          },
        ],
      ]),
    });
    const { call } = toolsOn(testHost(store));
    const result = await call("aq_timeline_read", { limit: 500 });
    expect(result.text.length).toBeLessThanOrEqual(40_000);
    expect(result.text).toMatch(/\d+ more: call again with cursor "c1"/);
  });

  it("say when there is no project, and check parameters before anything", async () => {
    const host = testHost();
    const { tools, call } = toolsOn(host);
    expect(tools.get("aq_timeline_read")?.validate({ limit: 0 })?.text).toMatch(
      /^error invalid-params/,
    );
    expect(tools.get("aq_timeline_read")?.validate({ limit: 5 })).toBeUndefined();
    host.open(undefined);
    expect((await call("aq_project_status")).text).toMatch(/^error no-project/);
  });
});
