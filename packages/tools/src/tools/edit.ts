import {
  OPERATIONS,
  entryOf,
  objectKey,
  objectOfPath,
  operationOf,
  problemDelta,
  staticProblems,
  type ChangeRecord,
  type CommandFailure,
  type ObjectRef,
  type Operation,
  type ProjectState,
  type Revision,
} from "@animaquill/core";
import { z } from "zod";
import { changeLine, describeChanges, type ObjectChange } from "../changes.ts";
import {
  answer,
  existsIn,
  failed,
  fieldOf,
  isOwnOf,
  objectText,
  whoMade,
  type Call,
} from "../context.ts";
import { failureWords, operationFailureText } from "../failures-en.ts";
import { issueLine } from "../issues.ts";
import { problemLines } from "../problems-en.ts";
import { AI_OPERATIONS, MAX_OPERATIONS, operationsParameter, signatureOf } from "../schema.ts";
import { didYouMean, mostLike } from "../similar.ts";
import { PARAM, editExamples, operationExamples, textOf, type TextTable } from "../texts/index.ts";
import { schemaOf, type ToolDefinition } from "../tool.ts";
import type { ToolResult } from "../types.ts";

/** How many changed objects a result lists, and how many new and resolved problems. */
const MAX_CHANGED = 20;
const MAX_PROBLEMS = 10;
const MAX_ISSUES = 5;

const EditParams = z.strictObject({
  operations: z.array(z.record(z.string(), z.unknown())),
  summary: z.string().max(120).optional().describe(PARAM),
  dry_run: z.boolean().optional().describe(PARAM),
  base_revision: z.string().optional().describe(PARAM),
  request_id: z.string().max(64).optional().describe(PARAM),
});

type EditArgs = z.output<typeof EditParams>;

/** One operation as an example, as the parameters of aq_edit take it. */
const exampleOf = (texts: TextTable, name: string): string => {
  const params = operationExamples(texts, name)[0]?.params ?? {};
  return JSON.stringify({ op: name, ...params });
};

/** Why an operation is not one AI can use, and what to use instead. */
function notForAi(name: string, where: string): ToolResult | undefined {
  const op = operationOf(name);
  if (!op || op.ai === "yes") return undefined;
  const { no, instead } = op.ai;
  const use = instead ? ` ${instead} does it for AI.` : "";
  const error = (code: string, words: string) =>
    failed(`error ${code} in ${where}: ${words} Nothing was written.`);
  if (no === "human") {
    return error("not-allowed", `only the user can do ${name}.`);
  }
  if (no === "file-tools") {
    return error(
      "unknown-operation",
      `${name} is not an operation here; change code with aq_file_edit or aq_file_write.`,
    );
  }
  if (no === "needs-file") {
    return error("not-allowed", `${name} needs a file that only the user can pick.`);
  }
  return error("unknown-operation", `${name} is not an operation here.${use}`);
}

const AI_NAMES = AI_OPERATIONS.map(({ name }) => name);

/** Every operation of a batch against its schema, all the faults at once, before anything runs. */
function checkOperations(args: EditArgs, texts: TextTable): ToolResult | undefined {
  const { operations } = args;
  if (operations.length === 0) {
    return failed(
      "error invalid-params\n  operations: has to have at least one operation\nnothing was written",
    );
  }
  if (operations.length > MAX_OPERATIONS) {
    return failed(
      `error too-many-operations: ${operations.length} operations; one batch takes at most ${MAX_OPERATIONS}. Send them in several batches. Nothing was written.`,
    );
  }
  const faults: { index: number; name: string; lines: string[] }[] = [];
  let count = 0;
  for (const [index, operation] of operations.entries()) {
    if (count >= MAX_ISSUES) break;
    const { op, ...params } = operation;
    const where = `operations[${index}]`;
    if (typeof op !== "string") {
      faults.push({
        index,
        name: "?",
        lines: [`${where}.op: missing; every operation names its op, such as "clip.add"`],
      });
      count += 1;
      continue;
    }
    const refused = notForAi(op, where);
    if (refused) return refused;
    const definition = operationOf(op);
    if (!definition || definition.ai !== "yes") {
      const similar = mostLike(op, AI_NAMES);
      const meant = didYouMean(op, AI_NAMES);
      const hint = meant
        ? ` Did you mean "${meant}"?`
        : similar.length > 0
          ? ` Similar: ${similar.join(", ")}.`
          : "";
      return failed(
        `error unknown-operation in ${where}: there is no operation ${JSON.stringify(op)}.${hint} The description of aq_edit lists them. Nothing was written.`,
      );
    }
    const lines: string[] = [];
    for (const hidden of definition.hiddenParams ?? []) {
      if (!hasPath(params, hidden.name)) continue;
      if (hidden.why === "human") {
        return failed(
          `error not-allowed in ${where} (${op}): only the user can use the parameter ${hidden.name}; leave it out. Nothing was written.`,
        );
      }
      lines.push(
        `${hidden.name}: not a parameter of ${op} here${hidden.instead ? `; ${hidden.instead} takes it` : ""}`,
      );
    }
    const parsed = definition.params.safeParse(params);
    if (!parsed.success) {
      const hidden = (definition.hiddenParams ?? []).map(({ name }) => name);
      for (const issue of parsed.error.issues) {
        lines.push(issueLine(issue, definition.params as z.ZodType, params, "", hidden));
      }
    }
    if (lines.length > 0) {
      faults.push({ index, name: op, lines: lines.slice(0, MAX_ISSUES - count) });
      count += lines.length;
    }
  }
  if (faults.length === 0) return undefined;
  const text = faults.flatMap(({ index, name, lines }) => [
    `error invalid-params in operations[${index}] (${name})`,
    ...lines.map((line) => `  ${line}`),
    ...(name === "?" ? [] : [`shape: ${signatureOf(name)}`, `example: ${exampleOf(texts, name)}`]),
  ]);
  return failed([...text, "nothing was written"].join("\n"));
}

function hasPath(params: Readonly<Record<string, unknown>>, name: string): boolean {
  let node: unknown = params;
  for (const key of name.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== undefined;
}

/** What objects of a kind are most like an id that is not there. */
function similarTo(
  state: ProjectState,
  kind: string,
  id: string,
  timeline: string | undefined,
): readonly string[] {
  const on = timeline === undefined ? undefined : entryOf(state.timelines, timeline);
  type Named = Readonly<Record<string, { readonly name?: string | undefined }>>;
  const maps: Readonly<Record<string, Named | undefined>> = {
    clip: on?.clips as Named | undefined,
    track: on?.tracks as Named | undefined,
    section: on?.sections as Named | undefined,
    marker: on?.markers as Named | undefined,
    join: on?.joins as Named | undefined,
    timeline: state.timelines as Named,
    scene: state.scenes as Named,
    sound: state.sounds as Named,
    asset: state.assets as Named | undefined,
  };
  const map = maps[kind];
  if (kind === "file") return mostLike(id, Object.keys(state.files));
  if (!map) return [];
  return mostLike(id, Object.keys(map)).map((each) => {
    const name = map[each]?.name;
    return name === undefined ? each : `${each} ${JSON.stringify(name)}`;
  });
}

/** Who changed what since the caller read it, for an error of conflict. */
/** Whether a path written by one change and a path of another meet: the same, or one under the other. */
const meet = (a: readonly string[], b: readonly string[]) => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return false;
  return true;
};

/** Whether a change is somebody else's: not of this conversation, or people taking one back. */
const byOthers = (call: Call) => {
  const own = isOwnOf(call);
  return (change: ChangeRecord) => change.takesBack !== undefined || !own(change.origin);
};

/** Who changed what since the caller read it, for an error of conflict: only what they did change. */
function conflictText(call: Call, failure: CommandFailure, bases: Bases): string {
  const state = call.store.getState();
  const others = byOthers(call);
  const own = isOwnOf(call);
  const byObject = new Map<string, { ref: ObjectRef; fields: Set<string>; who: Set<string> }>();
  for (const path of failure.conflicts ?? []) {
    const ref = objectOfPath(path);
    const key = objectKey(ref);
    const entry = byObject.get(key) ?? { ref, fields: new Set<string>(), who: new Set<string>() };
    byObject.set(key, entry);
    const field = fieldOf(path, ref);
    if (field !== undefined) entry.fields.add(field);
    const since = bases.of(path);
    for (const change of (since === undefined ? undefined : call.store.changesSince(since)) ?? []) {
      if (!others(change)) continue;
      if (change.paths.some((written) => meet(written, path))) {
        entry.who.add(whoMade(change, own(change.origin)));
      }
    }
  }
  const parts = [...byObject.values()].map(({ ref, fields, who }) => {
    const list = fields.size > 0 ? ` (${[...fields].join(", ")})` : "";
    return `${[...who].join(" and ") || "someone else changed"} ${objectText(state, ref)}${list}`;
  });
  return `error conflict: ${parts.join("; ")} after you last read it\nnothing was written`;
}

/** The text of a batch that failed, with what helps to fix it. */
function failureOf(call: Call, args: EditArgs, failure: CommandFailure, bases: Bases): ToolResult {
  const names = args.operations.map(({ op }) => String(op));
  if (failure.code === "conflict") return failed(conflictText(call, failure, bases));
  if (failure.code === "stale-revision" && bases.unread.size > 0) {
    const state = call.store.getState();
    const objects = [...bases.unread.values()].slice(0, 5).map((ref) => {
      const on = ref.timeline === undefined ? "" : ` (timeline ${ref.timeline})`;
      return `${objectText(state, ref)}${on}`;
    });
    const more = bases.unread.size > 5 ? ` and ${bases.unread.size - 5} more` : "";
    return failed(
      `error not-read: you have not read ${objects.join(", ")}${more} in this conversation, so the tools cannot tell whether the user changed it since; what aq_object_read or aq_timeline_read shows counts as read. Nothing was written.`,
    );
  }
  if (failure.code === "stale-revision") {
    return failed(`error stale-revision: ${failureWords(failure)} Nothing was written.`);
  }
  if (failure.index === undefined) {
    return failed(`error ${failure.code}: ${failureWords(failure)} Nothing was written.`);
  }
  const lines = [operationFailureText(failure, names)];
  if (failure.code === "not-found") {
    const { kind, id } = failure.params as { kind: string; id: string };
    const timeline = args.operations[failure.index]?.timeline;
    const similar = similarTo(
      call.store.getState(),
      kind,
      id,
      typeof timeline === "string" ? timeline : undefined,
    );
    if (similar.length > 0)
      lines[0] = lines[0]?.replace("\n", `\nsimilar: ${similar.join(" | ")}\n`) ?? "";
  }
  const name = names[failure.index] ?? "";
  if (failure.code === "invalid-params" && operationOf(name)) {
    lines.push(`shape: ${signatureOf(name)}`, `example: ${exampleOf(call.texts, name)}`);
  }
  return failed(lines.join("\n"));
}

const operationsWord = (count: number) => `${count} operation${count === 1 ? "" : "s"}`;

/** A revision that no store has: what a path of an object nobody read gets, see `Bases`. */
const UNREAD = "unread:0";

/** Fields of an object that only reading it whole shows: values of properties, keys, effects, params. */
const DETAIL: Readonly<Record<string, ReadonlySet<string>>> = {
  clip: new Set(["properties", "effects"]),
  scene: new Set(["params", "presets"]),
  sound: new Set(["params", "outputs"]),
};

/** The base of each path that a batch writes, and the objects it found unread. */
interface Bases {
  readonly of: (path: readonly string[]) => Revision | undefined;
  readonly unread: Map<string, ObjectRef>;
}

/**
 * The base of each path that a batch writes: when the caller last read its object, or what it last
 * read at all for an object it never read. What only reading it whole shows goes by the last whole
 * read, where there was one; the rest by the latest read of either kind. An object that was there
 * before and that nothing was read of gets `UNREAD`, which is refused. A revision the caller gives
 * only makes this earlier, never later: it cannot let through what the tools would refuse.
 */
function basesOf(call: Call, args: EditArgs, before: ProjectState): Bases {
  const { caller, store } = call;
  const unread = new Map<string, ObjectRef>();
  const count = (revision: Revision) => store.revisionOf(revision);
  /** The earlier of two revisions; one that is no revision of this store wins, to be refused. */
  const earlier = (a: Revision, b: Revision) => {
    const [x, y] = [count(a), count(b)];
    if (x === undefined) return a;
    if (y === undefined) return b;
    return x <= y ? a : b;
  };
  const later = (a: Revision | undefined, b: Revision | undefined) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    const [x, y] = [count(a), count(b)];
    if (x === undefined || y === undefined) return x === undefined ? a : b;
    return x >= y ? a : b;
  };
  const of = (path: readonly string[]): Revision | undefined => {
    const ref = objectOfPath(path);
    const { overview, full } = caller.seenOf(ref);
    const field = fieldOf(path, ref)?.split(".")[0];
    const detail = field !== undefined && DETAIL[ref.kind]?.has(field) === true;
    const recorded = (detail ? (full ?? overview) : later(overview, full)) ?? caller.lastRead;
    if (recorded === undefined) {
      if (!existsIn(before, ref)) return undefined;
      unread.set(objectKey(ref), ref);
      return UNREAD;
    }
    return args.base_revision === undefined ? recorded : earlier(args.base_revision, recorded);
  };
  return { of, unread };
}

/**
 * The objects a batch wrote, as read at the new revision: those that nobody else changed since the
 * caller last read them, and those it made, each for the kind of reading it had. What somebody else
 * changed in the meantime stays as read before, so that a later change of it is checked against
 * what the caller really saw.
 */
function afterWrite(
  call: Call,
  paths: readonly (readonly string[])[],
  changes: readonly ObjectChange[],
): void {
  const { caller, store } = call;
  const others = byOthers(call);
  const revision = store.revisionId;
  const added = new Set(
    changes.filter(({ change }) => change === "added").map((change) => objectKey(change)),
  );
  const done = new Set<string>();
  const untouched = (key: string, since: Revision | undefined) => {
    const changesSince = since === undefined ? undefined : store.changesSince(since);
    return (
      changesSince !== undefined &&
      !changesSince.some(
        (change) =>
          others(change) &&
          change.paths.some((written) => objectKey(objectOfPath(written)) === key),
      )
    );
  };
  for (const path of paths) {
    const ref = objectOfPath(path);
    const key = objectKey(ref);
    if (done.has(key)) continue;
    done.add(key);
    if (added.has(key)) {
      caller.saw(ref, revision, "full");
      continue;
    }
    const { overview, full } = caller.seenOf(ref);
    if (full !== undefined && untouched(key, full)) caller.saw(ref, revision, "full");
    else if (untouched(key, overview ?? caller.lastRead)) caller.saw(ref, revision);
  }
}

/** The problems a batch brought and resolved, of those the project alone tells. */
function problemsLines(call: Call, before: ProjectState, after: ProjectState): readonly string[] {
  const inputs = call.host.problemInputs?.() ?? {};
  const { added, resolved } = problemDelta(
    staticProblems(before, inputs),
    staticProblems(after, inputs),
  );
  if (added.length === 0 && resolved.length === 0) return [];
  return [
    `problems: new ${added.length} | resolved ${resolved.length}`,
    ...added
      .slice(0, MAX_PROBLEMS)
      .flatMap((problem) =>
        problemLines(after, problem).map((line, index) => `  ${index === 0 ? "new " : ""}${line}`),
      ),
    ...resolved.slice(0, MAX_PROBLEMS).flatMap((problem) =>
      problemLines(before, problem)
        .slice(0, 1)
        .map((line) => `  resolved ${line}`),
    ),
  ];
}

/** The description of aq_edit: how it works, its operations and a few examples. */
function editDescription(texts: TextTable): string {
  const groups = new Map<string, string[]>();
  for (const op of AI_OPERATIONS) {
    const list = groups.get(op.group) ?? [];
    groups.set(op.group, list);
    list.push(`${signatureOf(op.name)} — ${textOf(texts, `ops.${op.name}.summary`)}`);
  }
  return [
    textOf(texts, "tools.aq_edit.description"),
    "",
    textOf(texts, "edit.operationsHeading"),
    ...[...groups.values()].flat(),
    "",
    textOf(texts, "edit.examplesHeading"),
    ...editExamples(texts).map((batch) => JSON.stringify(batch)),
  ].join("\n");
}

export const edit: ToolDefinition<EditArgs> = {
  name: "aq_edit",
  title: "Change the project",
  describe: editDescription,
  params: EditParams,
  inputSchema: (texts) => {
    const schema = schemaOf(EditParams, texts, "aq_edit");
    const properties = schema.properties as Record<string, unknown>;
    return { ...schema, properties: { ...properties, operations: operationsParameter(texts) } };
  },
  writes: true,
  check: checkOperations,
  run: (call, args) => {
    const { store, host } = call;
    const before = store.getState();
    const calls = args.operations.map(({ op, ...params }) => ({ type: String(op), params }));
    const bases = basesOf(call, args, before);
    const result = store.executeBatch(calls, {
      origin: host.origin(),
      baseRevision: bases.of,
      isOwn: isOwnOf(call),
      ...(args.dry_run && { dryRun: true }),
    });
    if (!result.ok) return failureOf(call, args, result.error, bases);
    const paths = result.patches.map(({ path }) => path);
    const changes = describeChanges(before, result.state, paths);
    if (!args.dry_run) afterWrite(call, paths, changes);
    const created = result.results.flatMap((value, index) => {
      const id = (value as { readonly id?: unknown } | undefined)?.id;
      return typeof id === "string" ? [`${id} (operations[${index}])`] : [];
    });
    const shown = changes
      .slice(0, MAX_CHANGED)
      .map((change) => `  ${changeLine(result.state, change)}`);
    const more =
      changes.length > MAX_CHANGED
        ? [`  and ${changes.length - MAX_CHANGED} more (aq_object_read)`]
        : [];
    const first = args.dry_run
      ? `dry run: nothing was written; ${operationsWord(calls.length)} would be one step`
      : changes.length === 0
        ? `done: ${operationsWord(calls.length)}, which changed nothing`
        : `done: ${operationsWord(calls.length)} as one step`;
    return answer(
      call,
      [
        first,
        ...(created.length > 0 ? [`created: ${created.join(" | ")}`] : []),
        ...(shown.length > 0 ? ["changed:", ...shown, ...more] : []),
        ...problemsLines(call, before, result.state),
      ],
      {
        changes,
        ...(args.summary !== undefined && { summary: args.summary }),
        ...(args.dry_run && { dryRun: true }),
      },
    );
  },
};

/** Every operation of the registry by name, also those AI cannot use, for words about them. */
export const ALL_OPERATIONS: readonly Operation[] = OPERATIONS as readonly Operation[];
