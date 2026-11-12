import { z } from "zod";
import type { CallerState } from "./caller.ts";
import { failed, othersLine, type Call } from "./context.ts";
import { issueLine } from "./issues.ts";
import type { JsonSchema, Tool, ToolAnnotations, ToolHost, ToolResult } from "./types.ts";

/** How many things wrong with parameters one error lists. */
const MAX_ISSUES = 5;

/** What every tool says about itself and does, before the common part around it. */
export interface ToolDefinition<P> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly params: z.ZodType<P>;
  /** The schema of parameters as the model sees it, where it is not the one zod makes. */
  readonly inputSchema?: JsonSchema;
  /** It changes the project: one failure holds back the changes after it in the same answer. */
  readonly writes?: boolean;
  /** More checks of parameters than the schema has, as the lines of an error. */
  readonly check?: (args: P) => ToolResult | undefined;
  run(call: Call, args: P): ToolResult | Promise<ToolResult>;
}

/** The parameters of a tool, as JSON Schema with a description for each of them. */
export function schemaOf(params: z.ZodType): JsonSchema {
  const schema = z.toJSONSchema(params, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

/** The lines of an error about parameters that do not fit. */
export function paramsError(error: z.ZodError, schema: z.ZodType, input: unknown): ToolResult {
  const lines = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `  ${issueLine(issue, schema, input)}`);
  const more =
    error.issues.length > MAX_ISSUES ? [`  and ${error.issues.length - MAX_ISSUES} more`] : [];
  return failed(["error invalid-params", ...lines, ...more, "nothing was done"].join("\n"));
}

/** The text of a call that was not run, because of what came before it in the same answer. */
const NOT_RUN_FAILED =
  "error not-run: an earlier change in this answer failed, so this one was not run; nothing was written. Read the error above and send it again if it still fits.";
const NOT_RUN_WAITING =
  "error not-run: this answer asked the user a question, so this change was not run; the turn is waiting for the user.";

/** A tool as hosts use it: parameters checked, the project there, the line about others added. */
export function makeTool<P>(
  definition: ToolDefinition<P>,
  host: ToolHost,
  caller: CallerState,
): Tool {
  const { name, title, description, params, writes = false } = definition;
  const inputSchema = definition.inputSchema ?? schemaOf(params);
  const annotations: ToolAnnotations = {
    title,
    readOnlyHint: !writes,
    ...(writes && { destructiveHint: true, idempotentHint: true }),
    openWorldHint: false,
  };
  const parse = (args: unknown): { ok: true; value: P } | { ok: false; error: ToolResult } => {
    const parsed = params.safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: paramsError(parsed.error, params, args) };
    const extra = definition.check?.(parsed.data);
    return extra ? { ok: false, error: extra } : { ok: true, value: parsed.data };
  };
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    annotations,
    validate: (args) => {
      const parsed = parse(args);
      return parsed.ok ? undefined : parsed.error;
    },
    run: async (args) => {
      const parsed = parse(args);
      if (!parsed.ok) {
        if (writes) caller.answer.failedWrite = true;
        return parsed.error;
      }
      const store = host.store();
      if (!store) return failed("error no-project: no project is open. Ask the user to open one.");
      const request = (parsed.value as { readonly request_id?: string }).request_id;
      if (writes) {
        if (request !== undefined) {
          const known = caller.resultOf(request);
          if (known) return known;
        }
        if (caller.answer.proposed) return failed(NOT_RUN_WAITING);
        if (caller.answer.failedWrite) return failed(NOT_RUN_FAILED);
      }
      const call: Call = { host, caller, store };
      const others = othersLine(call);
      const result = await definition.run(call, parsed.value);
      caller.lastCall = store.revisionId;
      if (writes && result.isError) caller.answer.failedWrite = true;
      const done = others ? { ...result, text: `${result.text}\n${others}` } : result;
      if (writes && request !== undefined) caller.keepResult(request, done);
      return done;
    },
  };
}
