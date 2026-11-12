import type { ChatEntry, ToolEntry } from "@animaquill/agent";
import type { ObjectKind } from "@animaquill/core";
import { WRITE_TOOLS, type OtherChange } from "@animaquill/tools";

/** What a turn did to one object, as the tools tell it (`ObjectChange` of `@animaquill/tools`). */
export interface TurnChange {
  readonly key: string;
  readonly kind: ObjectKind;
  readonly id: string;
  readonly timeline?: string;
  readonly name?: string;
  readonly change: "added" | "removed" | "changed";
  readonly fields: readonly {
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
  }[];
  readonly lines?: { readonly added: number; readonly removed: number };
}

/** What one task did: the changes of all its tools as one, and what AI said each batch does. */
export interface TurnSummary {
  readonly changes: readonly TurnChange[];
  /** The `summary` AI gave each batch, in order. */
  readonly said: readonly string[];
  /** Whether the tools of this task told what they changed: older ones did not. */
  readonly told: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keyOf = (kind: string, id: string, timeline: unknown) =>
  typeof timeline === "string" ? `${kind}\n${timeline}\n${id}` : `${kind}\n${id}`;

interface Building {
  kind: ObjectKind;
  id: string;
  timeline?: string;
  name?: string;
  change: TurnChange["change"];
  fields: Map<string, { before?: string; after?: string }>;
  lines?: { added: number; removed: number };
  /** It was not there before the turn. */
  new: boolean;
}

/**
 * What one task changed, from what its tools said: each field from what it was before the first
 * change of the turn to what it is after the last one, and an object that the turn made and took
 * away again not at all. Dry runs changed nothing.
 */
export function summaryOf(entries: readonly ChatEntry[]): TurnSummary {
  const objects = new Map<string, Building>();
  const said: string[] = [];
  let told = false;
  for (const entry of entries) {
    if (entry.role !== "tool" || !entry.ok || !WRITE_TOOLS.has(entry.name)) continue;
    const data = (entry as ToolEntry).data;
    if (!isRecord(data) || data.dryRun === true || !Array.isArray(data.changes)) continue;
    told = true;
    if (typeof data.summary === "string" && data.summary.trim() !== "")
      said.push(data.summary.trim());
    for (const raw of data.changes) {
      if (!isRecord(raw) || typeof raw.kind !== "string" || typeof raw.id !== "string") continue;
      const change = raw.change;
      if (change !== "added" && change !== "removed" && change !== "changed") continue;
      const key = keyOf(raw.kind, raw.id, raw.timeline);
      const known = objects.get(key);
      const object: Building = known ?? {
        kind: raw.kind as ObjectKind,
        id: raw.id,
        ...(typeof raw.timeline === "string" && { timeline: raw.timeline }),
        change,
        fields: new Map(),
        new: change === "added",
      };
      objects.set(key, object);
      if (typeof raw.name === "string") object.name = raw.name;
      // Made in this turn stays made, and what is there again after it went was only changed.
      if (known)
        object.change = change === "removed" ? "removed" : object.new ? "added" : "changed";
      for (const field of Array.isArray(raw.fields) ? raw.fields : []) {
        if (!isRecord(field) || typeof field.path !== "string") continue;
        const before = typeof field.before === "string" ? field.before : undefined;
        const after = typeof field.after === "string" ? field.after : undefined;
        const kept = object.fields.get(field.path);
        // The value before the turn is what the first change found.
        const first = kept ? kept.before : before;
        object.fields.set(field.path, {
          ...(first !== undefined && { before: first }),
          ...(after !== undefined && { after }),
        });
      }
      if (isRecord(raw.lines)) {
        const added = Number(raw.lines.added) || 0;
        const removed = Number(raw.lines.removed) || 0;
        object.lines = {
          added: (object.lines?.added ?? 0) + added,
          removed: (object.lines?.removed ?? 0) + removed,
        };
      }
    }
  }
  const changes: TurnChange[] = [];
  for (const [key, object] of objects) {
    if (object.new && object.change === "removed") continue;
    changes.push({
      key,
      kind: object.kind,
      id: object.id,
      ...(object.timeline !== undefined && { timeline: object.timeline }),
      ...(object.name !== undefined && { name: object.name }),
      change: object.change,
      fields: [...object.fields].map(([path, values]) => ({ path, ...values })),
      ...(object.lines && { lines: object.lines }),
    });
  }
  return { changes, said, told };
}

/** The clips a task changed or made, for the timeline to mark. */
export const clipsOf = (summary: TurnSummary): ReadonlySet<string> =>
  new Set(
    summary.changes
      .filter(({ kind, change }) => kind === "clip" && change !== "removed")
      .map(({ id }) => id),
  );

/** An object that people or others changed while a task ran, as the tools told AI of it. */
export interface OtherRow {
  readonly key: string;
  readonly change: OtherChange;
  /** AI changed the same fields of it after it heard: what people did is not what is there now. */
  readonly overwritten: boolean;
}

/** What others changed while a task ran: people in this window, and anywhere else. */
export interface OthersOfTurn {
  readonly mine: readonly OtherRow[];
  readonly elsewhere: readonly OtherRow[];
}

const MINE = new Set(["user", "undo", "redo"]);

const isOther = (value: unknown): value is OtherChange =>
  isRecord(value) &&
  typeof value.who === "string" &&
  typeof value.kind === "string" &&
  typeof value.id === "string" &&
  Array.isArray(value.fields);

/** Whether two fields of an object meet: the same, or one under the other. */
const meets = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * What others changed while a task ran, from what its tools told AI (`others` of their data), and
 * whether a later change of AI in the task wrote the same fields again. Each object once, as last
 * told.
 */
export function othersOfTurn(entries: readonly ChatEntry[]): OthersOfTurn {
  const rows = new Map<string, { change: OtherChange; at: number }>();
  const tools = entries.filter((entry): entry is ToolEntry => entry.role === "tool");
  tools.forEach((entry, index) => {
    const others = entry.data?.others;
    if (!Array.isArray(others)) return;
    for (const change of others.filter(isOther)) {
      const key = keyOf(change.kind, change.id, change.timeline);
      const known = rows.get(key);
      const fields = [...new Set([...(known?.change.fields ?? []), ...change.fields])];
      rows.set(key, { change: { ...change, fields }, at: index });
    }
  });
  const mine: OtherRow[] = [];
  const elsewhere: OtherRow[] = [];
  for (const [key, { change, at }] of rows) {
    const later = summaryOf(tools.slice(at + 1));
    const again = later.changes.find((each) => each.key === key);
    const overwritten =
      again !== undefined &&
      (again.change === "removed" ||
        change.fields.length === 0 ||
        again.fields.some(({ path }) => change.fields.some((field) => meets(path, field))));
    (MINE.has(change.who) ? mine : elsewhere).push({ key, change, overwritten });
  }
  return { mine, elsewhere };
}

/** How the problems of the project changed with a task, and what its last check found. */
export interface ProblemsOfTurn {
  readonly added: number;
  readonly resolved: number;
  /** How many problems the last aq_check_run of the task listed, where it ran. */
  readonly checked: number | undefined;
}

export function problemsOfTurn(entries: readonly ChatEntry[]): ProblemsOfTurn {
  let added = 0;
  let resolved = 0;
  let checked: number | undefined;
  for (const entry of entries) {
    if (entry.role !== "tool" || !entry.ok) continue;
    const problems = entry.data?.problems;
    if (entry.name === "aq_check_run" && Array.isArray(problems)) checked = problems.length;
    else if (isRecord(problems)) {
      added += Number(problems.added) || 0;
      resolved += Number(problems.resolved) || 0;
    }
  }
  return { added, resolved, checked };
}
