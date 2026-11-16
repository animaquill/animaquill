import { z } from "zod";
import type { CallerState } from "./caller.ts";
import { withoutAddresses } from "./address.ts";
import { Approvals, allowedStore, previewStore, type Approval } from "./approve.ts";
import { failed, othersOf, type Call } from "./context.ts";
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
const NOT_RUN_DECLINED =
  "error not-run: the user did not allow an earlier change in this answer, so this one was not run and not shown to them. Nothing was written.";

/** What a change answers that the user saw and did not allow (S-D4). */
export const DECLINED =
  "error declined: the user was shown this change and did not allow it. Nothing was written, and no later change of this answer runs.";
/** What a change answers that waited for the user while the task stopped. */
export const STOPPED =
  "error stopped: the task stopped while this change waited for the user. Nothing was written.";
const CLOSED =
  "error no-project: the project this change was for is no longer open. Nothing was written.";
/** The line after an error of a change the user allowed, where the project changed meanwhile. */
const CHANGED_MEANWHILE =
  "the project changed while this change waited for the user, and the change was checked again against what the user saw.";

/**
 * What every tool that changes the project answers while people asked for a plan first, whatever
 * its parameters: nothing was written, and it is no failure (nothing after it is held back).
 */
export const PLAN_FIRST =
  'error plan-first: the user asked for a plan first, so nothing in this turn changes the project. Nothing was written. Reading and looking work as always; the plan goes to the user with aq_propose kind "plan".';

/** A result with more data for people, which never goes to the model. */
const withData = (result: ToolResult, data: Readonly<Record<string, unknown>>): ToolResult => ({
  ...result,
  data: { ...result.data, ...data },
});

/**
 * A tool as hosts use it: parameters checked, the project there, the line about others added. For a
 * tool that writes, the gates, in this order: "先出方案" (`ToolHost.planFirst`), before anything;
 * parameters; a result kept by `request_id`; what holds back changes in this answer; and where people
 * want to be asked (`ToolHost.approve`), a preview, their answer, and only then the write, of what
 * they saw, against the project as it was then. `approvals` is what people allowed in this run.
 */
export function makeTool<P>(
  definition: ToolDefinition<P>,
  host: ToolHost,
  caller: CallerState,
  texts: TextTable,
  limits: DetailLimits,
  approvals: Approvals = new Approvals(),
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
    // A link of the editor pasted as it is (aq://object/…, aq://time?…) stands for its id or time.
    const parsed = params.safeParse(withoutAddresses(args ?? {}));
    if (!parsed.success) return { ok: false, error: paramsError(parsed.error, params, args) };
    const extra = definition.check?.(parsed.data, texts);
    return extra ? { ok: false, error: extra } : { ok: true, value: parsed.data };
  };
  // The one gate of "plan first": before parameters, before results kept by request_id, before
  // anything that writes. Changes are kept from the project, not from the list of tools.
  const blocked = (): ToolResult | undefined =>
    writes && host.planFirst?.() === true ? failed(PLAN_FIRST) : undefined;
  /** What holds back a change in this answer: a question asked, a change not allowed or failed. */
  const heldBack = (): ToolResult | undefined => {
    if (caller.answer.proposed) return failed(NOT_RUN_WAITING);
    if (caller.answer.declined) return withData(failed(NOT_RUN_DECLINED), { afterDeclined: true });
    if (caller.answer.failedWrite) return failed(NOT_RUN_FAILED);
    return undefined;
  };
  /**
   * A change people are asked about (S-D4), once those asked before it are done: the preview, on a
   * store that writes nothing; people's answer; and the write, on a store that writes only what the
   * preview found, against its revision. `untried`: nothing was tried, as people did not allow it,
   * never answered, or it was held back or had no project: no failure, and no result to give again.
   */
  const allowed = async (
    call: Call,
    args: P,
    ask: (request: Parameters<NonNullable<ToolHost["approve"]>>[0]) => Promise<Approval>,
  ): Promise<{ readonly result: ToolResult; readonly untried?: true }> => {
    // What came of the changes asked before it, while it waited its turn.
    const held = heldBack();
    if (held) return { result: held, untried: true };
    const { store } = call;
    if (host.store() !== store) return { result: failed(CLOSED), untried: true };
    if (approvals.all) {
      const result = await definition.run(call, args);
      return { result: result.isError ? result : withData(result, { approved: "earlier" }) };
    }
    const revision = store.revisionId;
    const before = store.getState();
    const preview = previewStore(store);
    const tried = await definition.run({ ...call, store: preview.store, preview: true }, args);
    // What fails as a preview fails written too: people are not asked about it.
    if (tried.isError) return { result: tried };
    const allowedHere = { ...call, store: allowedStore(store, revision, preview.found) };
    const last = preview.found.at(-1);
    // Nothing to change: nothing to ask, and what is written is still nothing, or it fails.
    if (last === undefined || preview.found.every(({ patches }) => patches.length === 0)) {
      return { result: await definition.run(allowedHere, args) };
    }
    const summary = (args as { readonly summary?: unknown }).summary;
    const changes = Array.isArray(tried.data?.changes) ? tried.data.changes : [];
    let answer: Approval;
    try {
      answer = await ask({
        tool: name,
        ...(typeof summary === "string" && summary.trim() !== "" && { summary: summary.trim() }),
        changes,
        before,
        after: last.state,
        revision,
      });
    } catch {
      answer = "stopped";
    }
    if (answer === "stopped") return { result: failed(STOPPED), untried: true };
    if (answer !== "once" && answer !== "task") {
      caller.hold("declined");
      return { result: withData(failed(DECLINED), { declined: true }), untried: true };
    }
    if (host.store() !== store) return { result: failed(CLOSED), untried: true };
    if (answer === "task") approvals.allowAll();
    const result = await definition.run(allowedHere, args);
    if (!result.isError) return { result: withData(result, { approved: answer }) };
    if (store.revisionId === revision) return { result };
    const told = { ...result, text: `${result.text}\n${CHANGED_MEANWHILE}` };
    return { result: withData(told, { changedWhileAsked: true }) };
  };
  return {
    name,
    title,
    description,
    inputSchema,
    annotations,
    validate: (args) => {
      caller.answerIs(host.answer?.());
      const gate = blocked();
      if (gate) return gate;
      const parsed = parse(args);
      if (parsed.ok) return undefined;
      // The call came from the model and goes no further: a failed change holds back the rest.
      if (writes) caller.hold("failed");
      return parsed.error;
    },
    run: async (args) => {
      caller.answerIs(host.answer?.());
      const gate = blocked();
      if (gate) return gate;
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
        const held = heldBack();
        if (held) return held;
      }
      if (writes) caller.own.add(host.origin());
      const call: Call = { host, caller, store, texts, tool: name, limits };
      // Read once for the call: people may turn it on or off meanwhile, for the next call.
      const ask = writes && rest.dry_run !== true ? host.approve : undefined;
      // What others did is told up to the revision it was told at, not the one after the call: a
      // change that lands while a call waits, or while other calls run beside it, as read-only
      // calls may, is told by the next call instead of never. Of calls that end in another order
      // than they began, the later revision stays, so that nothing is told twice.
      const at = store.revisionId;
      caller.keepState(at, store.getState());
      const others = othersOf(call);
      const asked = ask
        ? await approvals.inTurn(() => allowed(call, parsed.value, ask))
        : { result: await definition.run(call, parsed.value) };
      const { result } = asked;
      caller.keepState(store.revisionId, store.getState());
      const last = caller.lastCall === undefined ? undefined : store.revisionOf(caller.lastCall);
      const now = store.revisionOf(at);
      if (last === undefined || now === undefined || now >= last) caller.lastCall = at;
      if (writes && result.isError && !asked.untried) caller.hold("failed");
      // What others changed goes to the model as a line, and to people as data with the result.
      const told = others.line ? { ...result, text: `${result.text}\n${others.line}` } : result;
      const done =
        others.changes.length > 0
          ? { ...told, data: { ...told.data, others: others.changes } }
          : told;
      // What people did not allow, or never answered, is no result to give again: nothing was tried.
      if (writes && request !== undefined && !asked.untried) {
        caller.keepResult(request, key, done);
      }
      return done;
    },
  };
}
