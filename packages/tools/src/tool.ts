import { z } from "zod";
import type { CallerState } from "./caller.ts";
import { failed, othersLine, type Call } from "./context.ts";
import { issueLine } from "./issues.ts";
import type { DetailLimits } from "./packs/detail.ts";
import { PARAM, textOf, type TextTable } from "./texts/index.ts";
import type { JsonSchema, Tool, ToolAnnotations, ToolHost, ToolResult } from "./types.ts";

/** How many things wrong with parameters one error lists. */
const MAX_ISSUES = 5;

/**
 * What every tool is and does, before the common part around it. What it says, its description and
 * the words for its parameters (`.describe(PARAM)`), comes from the table of texts, see `TextTable`.
 */
export interface ToolDefinition<P> {
  readonly name: string;
  readonly title: string;
  readonly params: z.ZodType<P>;
  /** Its description, where it is more than the text `tools.<name>.description`. */
  readonly describe?: (texts: TextTable) => string;
  /** The schema of parameters as the model sees it, where it is not the one zod makes. */
  readonly inputSchema?: (texts: TextTable) => JsonSchema;
  /** It changes the project: one failure holds back the changes after it in the same answer. */
  readonly writes?: boolean;
  /** More checks of parameters than the schema has, as the lines of an error. */
  readonly check?: (args: P, texts: TextTable) => ToolResult | undefined;
  run(call: Call, args: P): ToolResult | Promise<ToolResult>;
}

type Node = Record<string, unknown>;

/**
 * Puts in the words for each parameter, by its path below `at`: `tools.aq_file_edit.params.edits.
 * old_text`. Lists and choices are no step of the path.
 */
export function withTexts(node: unknown, texts: TextTable, at: string, path: string[] = []): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) withTexts(item, texts, at, path);
    return;
  }
  const schema = node as Node;
  if (schema.description === PARAM) schema.description = textOf(texts, `${at}.${path.join(".")}`);
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [name, inner] of Object.entries(value))
        withTexts(inner, texts, at, [...path, name]);
    } else if (key === "items" || key === "anyOf" || key === "oneOf") {
      withTexts(value, texts, at, path);
    }
  }
}

/** The paths of the parameters of a tool that have words, as `withTexts` puts them in. */
export function paramPaths(params: z.ZodType): readonly string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }
    const schema = node as Node;
    if (schema.description === PARAM) found.push(path.join("."));
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [name, inner] of Object.entries(value)) walk(inner, [...path, name]);
      } else if (key === "items" || key === "anyOf" || key === "oneOf") {
        walk(value, path);
      }
    }
  };
  walk(z.toJSONSchema(params, { target: "draft-2020-12", io: "input" }), []);
  return found;
}

/**
 * The most each parameter of a tool takes, by its path as `paramPaths` has it: its maximum, or how
 * many items or characters at most. What `{max}` stands for in its words.
 */
export function paramMaxima(params: z.ZodType): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }
    const schema = node as Node;
    const most = schema.maximum ?? schema.maxItems ?? schema.maxLength;
    if (schema.description === PARAM && typeof most === "number") found.set(path.join("."), most);
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [name, inner] of Object.entries(value)) walk(inner, [...path, name]);
      } else if (key === "items" || key === "anyOf" || key === "oneOf") {
        walk(value, path);
      }
    }
  };
  walk(z.toJSONSchema(params, { target: "draft-2020-12", io: "input" }), []);
  return found;
}

/** The parameters of a tool, as JSON Schema with a description for each of them. */
export function schemaOf(params: z.ZodType, texts: TextTable, tool: string): JsonSchema {
  const schema = z.toJSONSchema(params, { target: "draft-2020-12", io: "input" }) as Node;
  delete schema.$schema;
  withTexts(schema, texts, `tools.${tool}.params`);
  return schema;
}

/** The lines of an error about parameters that do not fit. */
export function paramsError(error: z.ZodError, schema: z.ZodType, input: unknown): ToolResult {
  const lines = error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `  ${issueLine(issue, schema, input)}`);
  const more =
    error.issues.length > MAX_ISSUES ? [`  and ${error.issues.length - MAX_ISSUES} more`] : [];
  const hint =
    typeof input === "object" &&
    input !== null &&
    typeof (input as Record<string, unknown>).operations === "string"
      ? ["  pass operations as a JSON array, not a string"]
      : [];
  return failed(
    ["error invalid-params", ...lines, ...more, ...hint, "nothing was written"].join("\n"),
  );
}

/** The text of a call that was not run, because of what came before it in the same answer. */
const NOT_RUN_FAILED =
  "error not-run: an earlier change in this answer failed, so this one was not run; the same call in a later answer runs. Nothing was written.";
const NOT_RUN_WAITING =
  "error not-run: this answer asked the user a question, so this change was not run; the turn is waiting for the user.";

/** A tool as hosts use it: parameters checked, the project there, the line about others added. */
export function makeTool<P>(
  definition: ToolDefinition<P>,
  host: ToolHost,
  caller: CallerState,
  texts: TextTable,
  limits: DetailLimits,
): Tool {
  const { name, title, params, writes = false } = definition;
  const description = definition.describe?.(texts) ?? textOf(texts, `tools.${name}.description`);
  const inputSchema = definition.inputSchema?.(texts) ?? schemaOf(params, texts, name);
  const annotations: ToolAnnotations = {
    title,
    readOnlyHint: !writes,
    // Every change is on record and can be taken back as a whole, removals too: none of them
    // is destructive. Sent again, a change can do it twice, such as a clip without an id:
    // request_id is for that.
    ...(writes && { destructiveHint: false, idempotentHint: false }),
    openWorldHint: false,
  };
  const parse = (args: unknown): { ok: true; value: P } | { ok: false; error: ToolResult } => {
    const parsed = params.safeParse(args ?? {});
    if (!parsed.success) return { ok: false, error: paramsError(parsed.error, params, args) };
    const extra = definition.check?.(parsed.data, texts);
    return extra ? { ok: false, error: extra } : { ok: true, value: parsed.data };
  };
  return {
    name,
    title,
    description,
    inputSchema,
    annotations,
    validate: (args) => {
      caller.answerIs(host.answer?.());
      const parsed = parse(args);
      if (parsed.ok) return undefined;
      // The call came from the model and goes no further: a failed change holds back the rest.
      if (writes) caller.hold("failed");
      return parsed.error;
    },
    run: async (args) => {
      caller.answerIs(host.answer?.());
      const parsed = parse(args);
      if (!parsed.ok) {
        if (writes) caller.hold("failed");
        return parsed.error;
      }
      const store = host.store();
      if (!store) return failed("error no-project: no project is open.");
      const { request_id: given, ...rest } = parsed.value as {
        readonly request_id?: string;
        readonly dry_run?: boolean;
      };
      // A dry run writes nothing: there is nothing to keep from doing twice.
      const request = rest.dry_run === true ? undefined : given;
      const key = JSON.stringify(rest);
      if (writes) {
        if (request !== undefined) {
          const known = caller.resultOf(request, key);
          if (known === "other") {
            return failed(
              `error invalid-params: request_id ${JSON.stringify(request)} was used for a different call in this conversation; a new request_id runs a new call. Nothing was written.`,
            );
          }
          if (known) return known;
        }
        if (caller.answer.proposed) return failed(NOT_RUN_WAITING);
        if (caller.answer.failedWrite) return failed(NOT_RUN_FAILED);
      }
      if (writes) caller.own.add(host.origin());
      const call: Call = { host, caller, store, texts, tool: name, limits };
      // What others did is told up to the revision it was told at, not the one after the call: a
      // change that lands while a call waits, or while other calls run beside it, as read-only
      // calls may, is told by the next call instead of never. Of calls that end in another order
      // than they began, the later revision stays, so that nothing is told twice.
      const at = store.revisionId;
      const others = othersLine(call);
      const result = await definition.run(call, parsed.value);
      const last = caller.lastCall === undefined ? undefined : store.revisionOf(caller.lastCall);
      const now = store.revisionOf(at);
      if (last === undefined || now === undefined || now >= last) caller.lastCall = at;
      if (writes && result.isError) caller.hold("failed");
      const done = others ? { ...result, text: `${result.text}\n${others}` } : result;
      if (writes && request !== undefined) caller.keepResult(request, key, done);
      return done;
    },
  };
}
