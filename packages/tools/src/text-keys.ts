import { GENERAL_FAILURES } from "@animaquill/core";
import { LOOSE, AI_OPERATIONS, SHARED_TYPES, fieldsOf, operationsParameter } from "./schema.ts";
import { DEFAULT_TEXTS, SYSTEM_PARTS } from "./texts/index.ts";
import { paramPaths } from "./tool.ts";
import { DEFINITIONS } from "./toolset.ts";

/**
 * A key of the table of texts: what it holds, and whether the table has to have it. The table has
 * what describes the tools and what the system prompt says, which a model pack may change. What
 * tools give back (results, errors, problems) is not in it and no pack changes it: results hold
 * what the model copies back into parameters, such as `track=` and the ids of lines, and their
 * words are part of the contract of the tools. Results that say something else, to compare with a
 * real model, are for an evaluation of its own.
 */
export interface TextKey {
  readonly key: string;
  readonly kind: "text" | "examples";
  /** Every table has it; the rest only where something needs words of its own. */
  readonly required: boolean;
}

type Node = Record<string, unknown>;

/**
 * Every key a table of texts can have, from the tools as they are: a model pack can only change
 * what is here, and the default table has every key that is required.
 */
export function textKeys(): readonly TextKey[] {
  const keys: TextKey[] = [];
  const add = (key: string, kind: TextKey["kind"] = "text", required = true) =>
    keys.push({ key, kind, required });
  for (const part of SYSTEM_PARTS) add(`system.${part}`);
  for (const { name, params } of DEFINITIONS) {
    add(`tools.${name}.description`);
    for (const path of paramPaths(params)) add(`tools.${name}.params.${path}`);
  }
  add("tools.aq_edit.params.operations");
  add("edit.list");
  add("edit.operationsHeading");
  add("edit.examplesHeading");
  add("edit.examples", "examples");
  const schema = operationsParameter(DEFAULT_TEXTS) as Node;
  const branches = (schema.items as { anyOf: Node[] }).anyOf;
  const names = new Set<string>();
  for (const [index, op] of AI_OPERATIONS.entries()) {
    add(`ops.${op.name}.summary`);
    add(`ops.${op.name}.description`);
    add(`ops.${op.name}.examples`, "examples");
    // What the page of the operation in the manual says of each error of its own.
    const general: ReadonlySet<string> = new Set(GENERAL_FAILURES);
    for (const code of op.failures) if (!general.has(code)) add(`ops.${op.name}.errors.${code}`);
    for (const { path } of fieldsOf(op.name)) add(`ops.${op.name}.fields.${path}`, "text", false);
    const properties = Object.keys((branches[index]?.properties ?? {}) as Node).filter(
      (name) => name !== "op",
    );
    const loose = LOOSE[op.name] ?? [];
    for (const name of properties) {
      names.add(name);
      add(`ops.${op.name}.params.${name}`, "text", loose.includes(name));
    }
  }
  for (const name of [...names].toSorted()) add(`params.${name}`, "text", false);
  for (const name of SHARED_TYPES) add(`types.${name}`);
  return keys;
}
