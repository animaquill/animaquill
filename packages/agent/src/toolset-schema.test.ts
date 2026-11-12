import { ProblemSet, ProjectStore, aiTask } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { createToolset } from "@animaquill/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTask, type Endpoint, type ToolSpec } from "./pi.ts";
import type { Protocol } from "./services.ts";

/**
 * The tools of @animaquill/tools, as pi sends them to each kind of service: whatever pi keeps of a
 * schema, every reference in it still finds what it points at. pi 1.5.0 gives Anthropic only `type`,
 * `properties` and `required` of the top of a schema, which is why the types that operations share
 * sit in `$defs` of `operations` itself.
 */

type Node = Record<string, unknown>;

function* refs(node: unknown): Generator<string> {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* refs(item);
    return;
  }
  for (const [key, item] of Object.entries(node)) {
    if (key === "$ref" && typeof item === "string") yield item;
    else yield* refs(item);
  }
}

function resolves(root: unknown, ref: string): boolean {
  let node = root;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Node)[part];
  }
  return node !== undefined;
}

/** Where a request of each protocol keeps the schema of each tool. */
function schemasOf(protocol: Protocol, body: Node): readonly [string, Node][] {
  const tools = (body.tools ?? []) as Node[];
  return tools.map((tool) => {
    if (protocol === "anthropic-messages") return [String(tool.name), tool.input_schema as Node];
    if (protocol === "openai-responses") return [String(tool.name), tool.parameters as Node];
    const fn = tool.function as Node;
    return [String(fn.name), fn.parameters as Node];
  });
}

const ENDPOINTS: readonly Endpoint[] = [
  {
    service: "anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    catalog: "anthropic",
  },
  {
    service: "openai",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    catalog: "openai",
  },
  {
    service: "deepseek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    catalog: "deepseek",
  },
];

describe("the tools as pi sends them", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ENDPOINTS.map((endpoint) => [endpoint.protocol, endpoint] as const))(
    "to %s keep every reference",
    async (protocol, endpoint) => {
      const store = ProjectStore.create(createProject({ name: "工具" }));
      const tools = createToolset({
        store: () => store,
        origin: () => aiTask("t"),
        problems: () => new ProblemSet(),
      });
      const specs: ToolSpec[] = tools.map((tool) => ({
        name: tool.name,
        label: tool.title,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
        run: async () => "",
      }));
      const bodies: Node[] = [];
      vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Node);
        return new Response("{}", { status: 500 });
      });
      await runTask({
        endpoint,
        key: async () => "sk-test-0123456789abcdef",
        system: "test",
        tools: specs,
        history: [],
        prompt: "go",
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      const body = bodies[0];
      expect(body, "a request went out").toBeDefined();
      const schemas = schemasOf(protocol, body as Node);
      expect(schemas.map(([name]) => name)).toContain("aq_edit");
      let checked = 0;
      for (const [name, schema] of schemas) {
        for (const ref of refs(schema)) {
          expect(resolves(schema, ref), `${name}: ${ref}`).toBe(true);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(10);
    },
  );
});
