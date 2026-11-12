import {
  USER,
  cloudSeqOf,
  type ChangeRecord,
  entryOf,
  objectKey,
  objectOfPath,
  pathOfObject,
  type ObjectRef,
  type ProjectState,
  type ProjectStore,
} from "@animaquill/core";
import type { CallerState } from "./caller.ts";
import type { TextTable } from "./texts/index.ts";
import type { ToolHost, ToolResult } from "./types.ts";

/** How long one result may be, in characters: about 10 000 tokens, which leaves room in small models. */
export const MAX_RESULT = 40_000;
/** How long a name is shown, in characters. */
const MAX_NAME = 40;
/** How many objects the line about the changes of others names. */
const MAX_OTHERS = 5;

/** A name as results show it: quoted as JSON, cut short when it is long. */
export function quoted(name: string): string {
  const short = [...name].length > MAX_NAME ? `${[...name].slice(0, MAX_NAME).join("")}…` : name;
  return JSON.stringify(short);
}

/** An id and, where it has one, its name. */
export const named = (id: string, name: string | undefined): string =>
  name === undefined || name === "" ? id : `${id} ${quoted(name)}`;

/** The name of an object in the project, where it has one. */
export function nameOf(state: ProjectState, ref: ObjectRef): string | undefined {
  const timeline = ref.timeline === undefined ? undefined : entryOf(state.timelines, ref.timeline);
  switch (ref.kind) {
    case "clip":
      return timeline && entryOf(timeline.clips, ref.id)?.name;
    case "track":
      return timeline && entryOf(timeline.tracks, ref.id)?.name;
    case "section":
      return timeline && entryOf(timeline.sections, ref.id)?.name;
    case "marker":
      return timeline && entryOf(timeline.markers, ref.id)?.name;
    case "timeline":
      return entryOf(state.timelines, ref.id)?.name;
    case "scene":
      return entryOf(state.scenes, ref.id)?.name;
    case "sound":
      return entryOf(state.sounds, ref.id)?.name;
    case "asset":
      return entryOf(state.assets, ref.id)?.name;
    default:
      return undefined;
  }
}

/** An object as results name it: its kind where the id does not say it, its id, its name. */
export function objectText(state: ProjectState, ref: ObjectRef): string {
  if (ref.kind === "project") return "the project settings";
  const kind = ["clip", "track", "section"].includes(ref.kind) ? "" : `${ref.kind} `;
  return `${kind}${named(ref.id, nameOf(state, ref))}`;
}

/**
 * Who made a change and how, in words that go before what it changed: "the user changed". What took
 * changes back is people's doing, whoever made the changes.
 */
export function whoMade(change: Pick<ChangeRecord, "origin" | "takesBack">, own = false): string {
  const { origin, takesBack } = change;
  if (takesBack !== undefined) {
    const whose = own
      ? "your earlier changes of"
      : origin.startsWith("ai:")
        ? "changes of another AI task to"
        : "changes of";
    return `the user ${takesBack === "undo" ? "undid" : "redid"} ${whose}`;
  }
  if (origin === USER) return "the user changed";
  if (origin.startsWith("ai:")) return "another AI task changed";
  if (origin.startsWith("folder:")) return "the files in the project folder changed";
  if (cloudSeqOf(origin) !== undefined) return "another device changed";
  return "another window changed";
}

/** What of an object a path is about, as the parameters of operations name it: `start`, `properties.opacity`. */
export function fieldOf(path: readonly string[], ref: ObjectRef): string | undefined {
  const at = path.indexOf(ref.id);
  const rest = at < 0 ? [] : path.slice(at + 1);
  const [first, second] = rest;
  if (first === undefined) return undefined;
  return (first === "properties" || first === "effects") && second !== undefined
    ? `${first}.${second}`
    : first;
}

/** Whether an object is in the project. */
export function existsIn(state: ProjectState, ref: ObjectRef): boolean {
  let node: unknown = state;
  for (const key of pathOfObject(ref)) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== undefined;
}

/** Whether a change was the caller's own: of this conversation, as any of its tasks. */
export const isOwnOf =
  (call: Call) =>
  (origin: string): boolean =>
    origin === call.host.origin() || call.caller.own.has(origin);

/** Everything a tool works with during one call. */
export interface Call {
  readonly host: ToolHost;
  readonly caller: CallerState;
  readonly store: ProjectStore;
  /** The words of the tools, where a result uses them, such as an example after an error. */
  readonly texts: TextTable;
  /** The tool that runs, by name. */
  readonly tool: string;
}

/**
 * What others changed since the last call of this caller, as one line that only says what happened:
 * who, which objects, which of their fields. What to do about it is for the system prompt to say.
 */
export function othersLine(call: Call): string | undefined {
  const { caller, store } = call;
  const since = caller.lastCall;
  if (since === undefined) return undefined;
  if (store.revisionOf(since) === undefined) {
    return "others: the project was reopened since your last call, so what you read before may be out of date.";
  }
  const changes = store.changesSince(since);
  if (!changes) {
    return "others: there were more changes by others since your last call than the tools keep track of.";
  }
  const state = store.getState();
  const own = isOwnOf(call);
  const byWho = new Map<
    string,
    Map<string, { ref: ObjectRef; fields: Set<string>; gone: boolean }>
  >();
  for (const change of changes) {
    const mine = own(change.origin);
    if (mine && change.takesBack === undefined) continue;
    const who = whoMade(change, mine);
    const objects = byWho.get(who) ?? new Map();
    byWho.set(who, objects);
    for (const path of change.paths) {
      const ref = objectOfPath(path);
      const key = objectKey(ref);
      const known = objects.get(key) ?? { ref, fields: new Set<string>(), gone: false };
      objects.set(key, known);
      const field = fieldOf(path, ref);
      if (field !== undefined && ref.kind !== "file") known.fields.add(field);
    }
  }
  if (byWho.size === 0) return undefined;
  let left = MAX_OTHERS;
  let more = 0;
  const parts = [...byWho].map(([who, objects]) => {
    const said = [...objects.values()].flatMap(({ ref, fields }) => {
      if (left <= 0) {
        more += 1;
        return [];
      }
      left -= 1;
      if (!existsIn(state, ref)) return [`${objectText(state, ref)} (removed)`];
      const list = fields.size > 0 ? ` (${[...fields].slice(0, 4).join(", ")})` : "";
      return [`${objectText(state, ref)}${list}`];
    });
    return said.length > 0 ? `${who} ${said.join(", ")}` : `${who} more`;
  });
  return `others: since your last call ${parts.join("; ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/** Lines as one text, cut at a whole line when too long, with a word on what was left out. */
const TOO_LONG = `one result holds at most ${MAX_RESULT.toLocaleString("en")} characters`;

/** What makes a result of a tool smaller, by tool, for what a result has to leave out. */
const NARROWER: Readonly<Record<string, string>> = {
  aq_timeline_read: "limit, from and to, or tracks give a smaller one",
  aq_object_read: "fields or fewer ids give a smaller one",
  aq_search: "limit, kinds or query give a smaller one",
  aq_check_run: "limit, severity or subject give a smaller one",
};

/** What a result left out, and what makes it smaller where the tool has a way. */
export const leftOut = (tool: string, left: number): string =>
  `${left} more lines left out: ${TOO_LONG}${NARROWER[tool] ? `; ${NARROWER[tool]}` : ""}.`;

export function fitted(lines: readonly string[], more?: (left: number) => string): string {
  let length = 0;
  for (let index = 0; index < lines.length; index += 1) {
    length += (lines[index] as string).length + 1;
    if (length > MAX_RESULT - 200) {
      const left = lines.length - index;
      const tail = more ? more(left) : `${left} more lines left out: ${TOO_LONG}.`;
      return [...lines.slice(0, index), tail].join("\n");
    }
  }
  return lines.join("\n");
}

/** A result of a call that worked: the revision first, the line about others last. */
export function answer(
  call: Call,
  lines: readonly string[],
  data?: Readonly<Record<string, unknown>>,
  others?: string,
): ToolResult {
  const text = fitted(
    [`rev ${call.store.revisionId}`, ...lines, ...(others ? [others] : [])],
    (left) => leftOut(call.tool, left),
  );
  return { text, isError: false, ...(data && { data }) };
}

/** A result of a call that did not work. */
export const failed = (text: string, data?: Readonly<Record<string, unknown>>): ToolResult => ({
  text,
  isError: true,
  ...(data && { data }),
});
