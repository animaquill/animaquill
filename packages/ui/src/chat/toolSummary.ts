import type { ToolCallEntry, ToolEntry } from "@animaquill/agent";

/**
 * What a call of a tool did, in one line for people, by tool: what it read, what it changed, what it
 * found. Never cut from the JSON of its arguments, which people do not read. What it changed in the
 * project is the card of changes, not this line.
 */

/** Words by a key made at run time, which the types of the keys cannot follow. */
export type Say = (key: string, options?: Readonly<Record<string, unknown>>) => string;

/** What the project calls its objects, for a line about a call. */
export interface Names {
  /** The name of a timeline, of the main one without an id. */
  timeline(id: string | undefined): string | undefined;
  /** The name of an object by its id, of whatever kind it is, where it has one. */
  object(id: string, timeline: string | undefined): string | undefined;
}

const NO_NAMES: Names = { timeline: () => undefined, object: () => undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** How many objects the line names before it says how many more. */
const NAMED = 2;
/** How long a quoted part of a line may be. */
const QUOTED = 40;

const cut = (value: string, most = QUOTED) =>
  [...value].length > most ? `${[...value].slice(0, most).join("")}…` : value;

/** A time of the tools, seconds as a number, as people read it: 0:00, 1:20.5. */
export function timeText(value: unknown): string | undefined {
  const raw = text(value) ?? (typeof value === "number" ? String(value) : undefined);
  if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw)) return raw;
  const seconds = Number(raw);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.round((rest - whole) * 10);
  const tail = tenths > 0 && tenths < 10 ? `.${tenths}` : "";
  return `${minutes}:${String(whole).padStart(2, "0")}${tail}`;
}

/** The last part of a path: what people call a file. */
const fileName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** Lines a call added and took away in files, as its result told. */
function linesOf(result: ToolEntry | undefined): { added: number; removed: number } | undefined {
  const changes = result?.data?.changes;
  if (!Array.isArray(changes)) return undefined;
  let added = 0;
  let removed = 0;
  let any = false;
  for (const change of changes) {
    if (!isRecord(change) || !isRecord(change.lines)) continue;
    any = true;
    added += Number(change.lines.added) || 0;
    removed += Number(change.lines.removed) || 0;
  }
  return any ? { added, removed } : undefined;
}

/** The first sentence of a text, for a line. */
function firstSentence(value: string): string {
  const end = /[。？！?!.]\s|[。？！?!]/u.exec(value);
  return cut(end ? value.slice(0, end.index + end[0].trimEnd().length) : value, 60);
}

/** The line of a call after the name of its tool: empty where the name says all. */
export function toolSummary(
  say: Say,
  call: ToolCallEntry,
  result: ToolEntry | undefined,
  names: Names = NO_NAMES,
): string {
  const args = call.args;
  switch (call.name) {
    case "aq_edit": {
      const operations = Array.isArray(args.operations) ? args.operations.length : 0;
      const parts = [
        ...(args.dry_run === true ? [say("chat.toolSummary.dryRun")] : []),
        ...(text(args.summary) ? [cut(text(args.summary) as string, 60)] : []),
        say("chat.toolSummary.ops", { count: operations }),
      ];
      return parts.join(" · ");
    }
    case "aq_timeline_read": {
      const timeline = text(args.timeline);
      const name = names.timeline(timeline) ?? timeline ?? say("chat.toolSummary.mainTimeline");
      const from = timeText(args.from);
      const to = timeText(args.to);
      const range =
        from !== undefined || to !== undefined
          ? say("chat.toolSummary.range", {
              from: from ?? "0:00",
              to: to ?? say("chat.toolSummary.end"),
            })
          : undefined;
      const tracks = Array.isArray(args.tracks) ? args.tracks.length : 0;
      return [
        `${name}${range ? ` ${range}` : ""}`,
        ...(tracks > 0 ? [say("chat.toolSummary.tracks", { count: tracks })] : []),
        ...(text(args.cursor) ? [say("chat.toolSummary.nextPage")] : []),
      ].join(" · ");
    }
    case "aq_object_read": {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
      const timeline = text(args.timeline);
      const shown = ids.slice(0, NAMED).map((id) => {
        const name = names.object(id, timeline);
        return name ? `「${cut(name)}」` : id;
      });
      const more = ids.length > NAMED ? [say("chat.toolSummary.more", { count: ids.length })] : [];
      return [shown.join("、"), ...more].join(" ");
    }
    case "aq_search": {
      const query = text(args.query);
      const kinds = Array.isArray(args.kinds)
        ? args.kinds.filter((kind) => typeof kind === "string")
        : [];
      return [
        ...(query ? [`「${cut(query)}」`] : []),
        ...kinds.map((kind) => say(`chat.kinds.${kind}`, { defaultValue: kind })),
      ].join(" · ");
    }
    case "aq_file_read":
      return text(args.path) ? fileName(text(args.path) as string) : "";
    case "aq_file_edit":
    case "aq_file_write": {
      const path = text(args.path);
      const lines = linesOf(result);
      return [
        ...(path ? [fileName(path)] : []),
        ...(lines ? [say("chat.toolSummary.lines", lines)] : []),
      ].join(" ");
    }
    case "aq_check_run": {
      if (!result) return "";
      const problems = result.data?.problems;
      if (!result.ok || !Array.isArray(problems)) return "";
      return problems.length === 0
        ? say("chat.toolSummary.passed")
        : say("chat.toolSummary.problems", { count: problems.length });
    }
    case "aq_propose": {
      const question = text(args.question);
      return question ? firstSentence(question) : "";
    }
    case "aq_guide": {
      const topic = text(args.topic) ?? text(args.query);
      return topic ? cut(topic) : "";
    }
    default:
      // aq_project_status, aq_selection_read and the tools before these: the name says it.
      return "";
  }
}

/** One argument of a call, as a line of "name: value". */
export interface ArgField {
  readonly key: string;
  readonly value: string;
  /** It has lines of its own, which show as a block. */
  readonly multiline: boolean;
}

/** What an item of a list of arguments is about: its operation and the object it works on. */
function itemText(item: unknown): string {
  if (!isRecord(item)) return String(item);
  const op = text(item.op);
  const object = [
    "id",
    "clip",
    "track",
    "marker",
    "section",
    "scene",
    "sound",
    "asset",
    "path",
    "name",
    "label",
  ]
    .map((key) => item[key])
    .find((value) => typeof value === "string" && value !== "") as string | undefined;
  const head = [op, object].filter(Boolean).join(" ");
  if (head) return head;
  return cut(JSON.stringify(item), 80);
}

/**
 * The arguments of a call as lines: each one by its name, a list one item a line (an operation by
 * its name and its object), and what is nested as short JSON. Not the whole JSON, which people do
 * not read.
 */
export function argFields(args: Readonly<Record<string, unknown>>): readonly ArgField[] {
  return Object.entries(args).map(([key, value]) => {
    if (Array.isArray(value)) {
      const lines = value.map(itemText);
      return { key, value: lines.join("\n"), multiline: lines.length > 1 };
    }
    if (isRecord(value)) return { key, value: cut(JSON.stringify(value), 200), multiline: false };
    const shown = value === null ? "null" : String(value);
    return { key, value: shown, multiline: shown.includes("\n") };
  });
}

/** The code of the error a tool gave, from the first words of its result. */
export const toolErrorCode = (result: ToolEntry): string | undefined =>
  result.ok ? undefined : (/^error ([a-z][a-z-]*)/.exec(result.text)?.[1] ?? undefined);
