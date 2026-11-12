import { isAnimation } from "@animaquill/schema";
import {
  entryOf,
  objectKey,
  objectOfPath,
  type ObjectKind,
  type ObjectRef,
  type ProjectState,
} from "@animaquill/core";
import { fieldOf, nameOf, objectText } from "./context.ts";
import { clipLine, transitionText } from "./lines.ts";

/** What a batch did to one object, for the summary of a turn and for AI. */
export interface ObjectChange {
  readonly kind: ObjectKind;
  readonly id: string;
  readonly timeline?: string;
  readonly name?: string;
  readonly change: "added" | "removed" | "changed";
  /** Short texts, at most 40 characters each. */
  readonly fields?: readonly {
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
  }[];
  /** For files. */
  readonly lines?: { readonly added: number; readonly removed: number };
}

const MAX_TEXT = 40;

/** Where an object sits in the state. */
export function pathOfObject(ref: ObjectRef): readonly string[] {
  const { kind, id, timeline = "" } = ref;
  switch (kind) {
    case "project":
      return ["manifest"];
    case "timeline":
      return ["timelines", id];
    case "scene":
      return ["scenes", id];
    case "sound":
      return ["sounds", id];
    case "asset":
      return ["assets", id];
    case "file":
      return ["files", id];
    default:
      return ["timelines", timeline, `${kind}s`, id];
  }
}

function valueAt(state: ProjectState, path: readonly string[]): unknown {
  let node: unknown = state;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;
    node = Object.hasOwn(record, key) ? record[key] : undefined;
  }
  return node;
}

/** A value in a few characters. */
export function shortText(value: unknown, field = ""): string {
  if (value === undefined) return "none";
  if (field === "enter" || field === "exit") return transitionText(value as never);
  if (typeof value === "object" && value !== null && isAnimation(value as never)) {
    return `animated (${(value as { keys: unknown[] }).keys.length} keys)`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [...text].length > MAX_TEXT ? `${[...text].slice(0, MAX_TEXT - 1).join("")}…` : text;
}

/** How many lines came and went between two texts, as a diff counts them. */
function lineChanges(before: string, after: string) {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { added, removed };
}

/** What patches did to the objects they touched, before against after. */
export function describeChanges(
  before: ProjectState,
  after: ProjectState,
  paths: readonly (readonly string[])[],
): readonly ObjectChange[] {
  const touched = new Map<string, { ref: ObjectRef; fields: Set<string> }>();
  for (const path of paths) {
    const ref = objectOfPath(path);
    const key = objectKey(ref);
    const known = touched.get(key) ?? { ref, fields: new Set<string>() };
    touched.set(key, known);
    const field = fieldOf(path, ref);
    if (field !== undefined) known.fields.add(field);
  }
  return [...touched.values()].map(({ ref, fields }) => {
    const at = pathOfObject(ref);
    const was = valueAt(before, at);
    const is = valueAt(after, at);
    const name = nameOf(after, ref) ?? nameOf(before, ref);
    const base = {
      kind: ref.kind,
      id: ref.id,
      ...(ref.timeline !== undefined && { timeline: ref.timeline }),
      ...(name !== undefined && { name }),
    };
    if (ref.kind === "file") {
      const lines = lineChanges(
        typeof was === "string" ? was : "",
        typeof is === "string" ? is : "",
      );
      const change = was === undefined ? "added" : is === undefined ? "removed" : "changed";
      return { ...base, change, lines };
    }
    if (was === undefined && is !== undefined) return { ...base, change: "added" };
    if (is === undefined) return { ...base, change: "removed" };
    const changed = [...fields].toSorted().map((field) => {
      const where =
        field.includes(".") && /^(properties|effects)\./.test(field)
          ? [...at, field.slice(0, field.indexOf(".")), field.slice(field.indexOf(".") + 1)]
          : [...at, field];
      return {
        path: field,
        before: shortText(valueAt(before, where), field),
        after: shortText(valueAt(after, where), field),
      };
    });
    return { ...base, change: "changed", fields: changed };
  });
}

/** One change as one line for AI. */
export function changeLine(state: ProjectState, change: ObjectChange): string {
  const ref: ObjectRef = {
    kind: change.kind,
    id: change.id,
    ...(change.timeline !== undefined && { timeline: change.timeline }),
  };
  const who = change.kind === "file" ? `file ${change.id}` : objectText(state, ref);
  if (change.lines) {
    const what = change.change === "changed" ? "" : `${change.change} `;
    return `${who}: ${what}+${change.lines.added} -${change.lines.removed} lines`;
  }
  if (change.change === "added" && change.kind === "clip") {
    const timeline = entryOf(state.timelines, change.timeline ?? "");
    const clip = timeline && entryOf(timeline.clips, change.id);
    if (clip) return `${who}: added, ${clipLine(clip).slice(clip.id.length).trim()}`;
  }
  if (change.change !== "changed") return `${who}: ${change.change}`;
  const fields = (change.fields ?? []).map(
    ({ path, before, after }) => `${path} ${before}→${after}`,
  );
  return `${who}: ${fields.join("; ")}`;
}
