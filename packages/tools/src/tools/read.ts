import {
  clipEnd,
  clipFileOf,
  clipStart,
  describeClip,
  entryOf,
  isDocument,
  orderedSections,
  orderedTracks,
  projectFrameRate,
  timelineLength,
  type ClipState,
  type ObjectRef,
  type ProjectState,
  type TimelineState,
} from "@animaquill/core";
import { Time, compare, formatTime, parseTime } from "@animaquill/schema";
import { z } from "zod";
import { answer, failed, MAX_RESULT, named, quoted, type Call } from "../context.ts";
import {
  assetLine,
  clipLine,
  codeLine,
  sectionsLine,
  sourceText,
  transitionText,
} from "../lines.ts";
import { offsetOf, paged } from "../page.ts";
import { mostLike } from "../similar.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";
import type { ToolResult } from "../types.ts";

/** How many scenes, sounds and assets the overview lists of each. */
const MAX_LISTED = 30;

/** A hash of a text, to tell later whether a file changed since it was read. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Records what was read, at the revision now, in an overview or whole: the conflict checks of later
 * changes go by it.
 */
export function sawAll(
  call: Call,
  refs: Iterable<ObjectRef>,
  depth: "overview" | "full" = "overview",
): void {
  const revision = call.store.revisionId;
  for (const ref of refs) call.caller.saw(ref, revision, depth);
  call.caller.read(revision);
}

/** How long a line of a file comes in a result, in characters. */
const MAX_LINE = 2000;

/** How many joins and markers a timeline lists; the rest are for aq_search. */
const MAX_SMALL = 50;

/** A list in one line, cut after some entries with a word on where the rest are. */
function listLine(title: string, entries: readonly string[]): string {
  const shown = entries.slice(0, MAX_LISTED);
  const more =
    entries.length > MAX_LISTED ? ` | and ${entries.length - MAX_LISTED} more (aq_search)` : "";
  return `${title} (${entries.length}): ${shown.join(" | ") || "none"}${more}`;
}

const timelineOf = (state: ProjectState, id: string | undefined) => {
  const wanted = id ?? state.manifest.timelines[0];
  const timeline = wanted === undefined ? undefined : entryOf(state.timelines, wanted);
  return wanted !== undefined && timeline ? ([wanted, timeline] as const) : undefined;
};

const noTimeline = (state: ProjectState, id: string | undefined): ToolResult => {
  const similar = mostLike(id ?? "", Object.keys(state.timelines));
  const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
  return failed(`error not-found: no timeline ${JSON.stringify(id ?? "")}${hint}`);
};

const StatusParams = z.strictObject({});

export const projectStatus: ToolDefinition<z.output<typeof StatusParams>> = {
  name: "aq_project_status",
  title: "Project overview",
  params: StatusParams,
  run: (call) => {
    const { store, host } = call;
    const state = store.getState();
    const { manifest } = state;
    const formats = manifest.formats.map(({ id, width, height }) => `${id}(${width}x${height})`);
    const languages = manifest.languages.map(({ id }) => id);
    const locked = manifest.tags?.some((tag) => tag.locked) === true;
    const editable = store.readOnly
      ? "editable=no reason=read-only"
      : locked
        ? "editable=no reason=locked"
        : "editable=yes";
    const timelines = manifest.timelines.flatMap((id) => {
      const timeline = entryOf(state.timelines, id);
      if (!timeline) return [];
      const tracks = Object.keys(timeline.tracks).length;
      const clips = Object.keys(timeline.clips).length;
      return [
        `${named(id, timeline.name)} 0..${formatTime(timelineLength(timeline))} tracks=${tracks} clips=${clips}`,
      ];
    });
    const scenes = Object.entries(state.scenes).map(([id, scene]) => codeLine(id, scene));
    const sounds = Object.entries(state.sounds).map(([id, sound]) => codeLine(id, sound));
    const assets = Object.entries(state.assets ?? {}).map(([id, asset]) => assetLine(id, asset));
    const code = Object.keys(state.files)
      .filter((path) => path.startsWith("code/"))
      .toSorted();
    const problems = host.problems().all();
    const errors = problems.filter(({ severity }) => severity === "error").length;
    const warnings = problems.filter(({ severity }) => severity === "warning").length;
    sawAll(call, [
      { kind: "project", id: "project" },
      ...manifest.timelines.map((id) => ({ kind: "timeline", id }) as const),
      ...Object.keys(state.scenes).map((id) => ({ kind: "scene", id }) as const),
      ...Object.keys(state.sounds).map((id) => ({ kind: "sound", id }) as const),
      ...Object.keys(state.assets ?? {}).map((id) => ({ kind: "asset", id }) as const),
    ]);
    return answer(call, [
      `project ${quoted(manifest.name)} fps=${projectFrameRate(manifest)} formats=${formats.join(" ")} languages=${languages.join(" ")}`,
      editable,
      `timelines (${timelines.length}): ${timelines.join(" | ")}`,
      listLine("scenes", scenes),
      listLine("sounds", sounds),
      listLine("assets", assets),
      listLine("code files", code),
      `problems: ${errors} errors, ${warnings} warnings (aq_check_run lists them)`,
    ]);
  },
};

const TimelineParams = z.strictObject({
  timeline: z.string().optional().describe(PARAM),
  from: Time.describe(PARAM).optional(),
  to: Time.describe(PARAM).optional(),
  tracks: z.array(z.string()).optional().describe(PARAM),
  limit: z.number().int().min(1).max(500).optional().describe(PARAM),
  cursor: z.string().optional().describe(PARAM),
});

/** The tracks of a timeline in one line, the one at the back of the picture first. */
function tracksLine(timeline: TimelineState): string {
  const tracks = orderedTracks(timeline).map((head) => {
    const track = head as typeof head &
      Readonly<
        Record<"role", string | undefined> &
          Record<"hidden" | "muted" | "solo", boolean | undefined>
      >;
    const flags = [
      ...(track.role !== undefined ? [`role=${track.role}`] : []),
      ...(track.hidden ? ["hidden"] : []),
      ...(track.muted ? ["muted"] : []),
      ...(track.solo ? ["solo"] : []),
      ...(track.locked ? ["locked"] : []),
    ];
    return [named(track.id, track.name), track.kind, ...flags].join(" ");
  });
  return `tracks (back of the picture first): ${tracks.join(" | ")}`;
}

export const timelineRead: ToolDefinition<z.output<typeof TimelineParams>> = {
  name: "aq_timeline_read",
  title: "Read a timeline",
  params: TimelineParams,
  run: (call, args) => {
    const state = call.store.getState();
    const found = timelineOf(state, args.timeline);
    if (!found) return noTimeline(state, args.timeline);
    const [id, timeline] = found;
    const offset = offsetOf(call, "aq_timeline_read", args);
    if (typeof offset !== "number") return offset;
    const from = args.from === undefined ? undefined : parseTime(args.from);
    const to = args.to === undefined ? undefined : parseTime(args.to);
    const tracks = args.tracks && new Set(args.tracks);
    const clips = Object.values(timeline.clips)
      .filter((clip) => !tracks || tracks.has(clip.track))
      .filter((clip) => from === undefined || compare(safeEnd(clip), from) > 0)
      .filter((clip) => to === undefined || compare(clipStart(clip), to) < 0)
      .toSorted((a, b) => compare(clipStart(a), clipStart(b)) || a.id.localeCompare(b.id));
    const limit = args.limit ?? 200;
    const joins = Object.entries(timeline.joins ?? {});
    const markers = Object.values(timeline.markers).toSorted((a, b) =>
      compare(parseTime(a.time), parseTime(b.time)),
    );
    const listed = (count: number, kind: string) =>
      count > MAX_SMALL ? ` | and ${count - MAX_SMALL} more (aq_search kinds ["${kind}"])` : "";
    const joinsLine = joins
      .slice(0, MAX_SMALL)
      .map(
        ([join, { from: before, to: after, transition }]) =>
          `${join} ${String(before)}>${String(after)} ${transitionText(transition)}`,
      )
      .join(" | ");
    const markersLine = markers
      .slice(0, MAX_SMALL)
      .map((marker) => `${named(marker.id, marker.name)} ${marker.time}`)
      .join(" | ");
    const versions = Object.keys(timeline.overrides);
    sawAll(call, [
      { kind: "timeline", id },
      ...Object.keys(timeline.tracks).map(
        (track) => ({ kind: "track", id: track, timeline: id }) as const,
      ),
      ...Object.keys(timeline.sections).map(
        (section) => ({ kind: "section", id: section, timeline: id }) as const,
      ),
      ...joins
        .slice(0, MAX_SMALL)
        .map(([join]) => ({ kind: "join", id: join, timeline: id }) as const),
      ...markers
        .slice(0, MAX_SMALL)
        .map((marker) => ({ kind: "marker", id: marker.id, timeline: id }) as const),
    ]);
    return paged(call, "aq_timeline_read", args, {
      head: [
        `timeline ${named(id, timeline.name)} 0..${formatTime(timelineLength(timeline))}`,
        sectionsLine(timeline),
        tracksLine(timeline),
      ],
      items: clips.map(clipLine),
      offset,
      limit,
      title: (first, last, total) => `clips ${first}-${last} of ${total}, by start:`,
      tail: [
        ...(clips.length === 0 ? ["clips: none here"] : []),
        ...(joins.length > 0 ? [`joins: ${joinsLine}${listed(joins.length, "join")}`] : []),
        ...(markers.length > 0
          ? [`markers: ${markersLine}${listed(markers.length, "marker")}`]
          : []),
        ...(versions.length > 0 ? [`versions with overrides: ${versions.join(", ")}`] : []),
      ],
      // Only the clips the result shows are read.
      shown: (first, end) =>
        sawAll(
          call,
          clips
            .slice(first, end)
            .map((clip) => ({ kind: "clip", id: clip.id, timeline: id }) as const),
        ),
    });
  },
};

function safeEnd(clip: ClipState) {
  try {
    return clipEnd(clip);
  } catch {
    return clipStart(clip);
  }
}

const ObjectParams = z.strictObject({
  ids: z.array(z.string()).min(1).max(20).describe(PARAM),
  timeline: z.string().optional().describe(PARAM),
  fields: z.array(z.string()).optional().describe(PARAM),
  response_format: z.enum(["detailed", "concise"]).optional().describe(PARAM),
});

/** An object found by id, with what results show of it. */
interface Found {
  readonly ref: ObjectRef;
  readonly head: string;
  readonly value: unknown;
  readonly clip?: ClipState;
}

/** Everything an id can be, on the timelines asked for. */
function findAll(state: ProjectState, id: string, only: string | undefined): readonly Found[] {
  if (id === "project") {
    return [{ ref: { kind: "project", id }, head: "project settings", value: state.manifest }];
  }
  const found: Found[] = [];
  const timeline = entryOf(state.timelines, id);
  if (timeline && only === undefined) {
    const { clips: _clips, overrides: _overrides, ...rest } = timeline;
    found.push({
      ref: { kind: "timeline", id },
      head: `timeline ${named(id, timeline.name)}`,
      value: rest,
    });
  }
  const scene = entryOf(state.scenes, id);
  if (scene)
    found.push({
      ref: { kind: "scene", id },
      head: `scene ${named(id, scene.name)}`,
      value: scene,
    });
  const sound = entryOf(state.sounds, id);
  if (sound)
    found.push({
      ref: { kind: "sound", id },
      head: `sound ${named(id, sound.name)}`,
      value: sound,
    });
  const asset = entryOf(state.assets, id);
  if (asset)
    found.push({
      ref: { kind: "asset", id },
      head: `asset ${named(id, asset.name)}`,
      value: asset,
    });
  for (const [key, each] of Object.entries(state.timelines)) {
    if (only !== undefined && key !== only) continue;
    const on = `timeline=${key}`;
    const clip = entryOf(each.clips, id);
    if (clip) {
      const head = `clip ${named(id, clip.name)} ${on} track=${clip.track} ${clip.start}..${formatTime(safeEnd(clip))}`;
      found.push({ ref: { kind: "clip", id, timeline: key }, head, value: clipFileOf(clip), clip });
    }
    const track = entryOf(each.tracks, id);
    if (track) {
      const { order: _order, ...value } = track;
      found.push({
        ref: { kind: "track", id, timeline: key },
        head: `track ${named(id, track.name)} ${on}`,
        value,
      });
    }
    const section = entryOf(each.sections, id);
    if (section) {
      const { order: _order, ...value } = section;
      found.push({
        ref: { kind: "section", id, timeline: key },
        head: `section ${named(id, section.name)} ${on}`,
        value,
      });
    }
    const join = entryOf(each.joins, id);
    if (join)
      found.push({
        ref: { kind: "join", id, timeline: key },
        head: `join ${id} ${on}`,
        value: { id, ...join },
      });
    const marker = entryOf(each.markers, id);
    if (marker)
      found.push({
        ref: { kind: "marker", id, timeline: key },
        head: `marker ${named(id, marker.name)} ${on}`,
        value: marker,
      });
  }
  return found;
}

/** Every id the project has, for ids that are not there. */
function allIds(state: ProjectState): readonly string[] {
  const ids = new Set<string>([
    ...Object.keys(state.timelines),
    ...Object.keys(state.scenes),
    ...Object.keys(state.sounds),
    ...Object.keys(state.assets ?? {}),
  ]);
  for (const timeline of Object.values(state.timelines)) {
    for (const map of [
      timeline.clips,
      timeline.tracks,
      timeline.sections,
      timeline.markers,
      timeline.joins ?? {},
    ]) {
      for (const id of Object.keys(map)) ids.add(id);
    }
  }
  return [...ids];
}

/** A value at a dotted path, where property paths have dots of their own. */
function fieldAt(value: unknown, path: string): unknown {
  let node = value;
  let rest = path;
  while (rest !== "") {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, rest)) return record[rest];
    const dot = rest.indexOf(".");
    const head = dot < 0 ? rest : rest.slice(0, dot);
    node = record[head];
    rest = dot < 0 ? "" : rest.slice(dot + 1);
  }
  return node;
}

/** What a scene says a clip takes, one property per entry. */
function sceneProperties(call: Call, state: ProjectState, clip: ClipState): string {
  const description = call.host.describe?.(clip) ?? describeClip(state, clip, undefined);
  const specs = description.objects.flatMap((object) => object.properties);
  const shown = specs.slice(0, 60).map((spec) => {
    const range =
      spec.min !== undefined || spec.max !== undefined
        ? ` ${spec.min ?? ""}..${spec.max ?? ""}`
        : "";
    const options = spec.options ? ` ${spec.options.join("|")}` : "";
    const fallback = spec.default !== undefined ? ` default=${JSON.stringify(spec.default)}` : "";
    return `${spec.path} ${spec.type}${spec.unit ? ` ${spec.unit}` : ""}${range}${options}${fallback}`;
  });
  const ran =
    description.ran === "never"
      ? " (what the scene's code registers is known once the editor has run it)"
      : "";
  return `scene properties${ran}: ${shown.join(" | ") || "none"}`;
}

export const objectRead: ToolDefinition<z.output<typeof ObjectParams>> = {
  name: "aq_object_read",
  title: "Read objects",
  params: ObjectParams,
  run: (call, args) => {
    const state = call.store.getState();
    if (args.timeline !== undefined && !entryOf(state.timelines, args.timeline)) {
      return noTimeline(state, args.timeline);
    }
    const lines: string[] = [];
    const seen: ObjectRef[] = [];
    // Every field of an object, not some of them nor a summary, is reading it whole.
    const whole = args.fields === undefined && args.response_format !== "concise";
    for (const id of args.ids) {
      const found = findAll(state, id, args.timeline);
      if (found.length === 0) {
        const similar = mostLike(id, allIds(state));
        const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
        return failed(
          `error not-found: no object ${JSON.stringify(id)}${hint}\nnothing else was read`,
        );
      }
      const timelines = new Set(
        found.map(({ ref }) => ref.timeline).filter((each) => each !== undefined),
      );
      if (timelines.size > 1) {
        return failed(
          `error ambiguous-id: ${JSON.stringify(id)} is on several timelines: ${[...timelines].join(", ")}. Pass timeline.`,
        );
      }
      for (const each of found) {
        seen.push(each.ref);
        lines.push(each.head);
        const value = args.fields
          ? Object.fromEntries(args.fields.map((field) => [field, fieldAt(each.value, field)]))
          : each.value;
        const unset = (args.fields ?? []).filter(
          (field) => fieldAt(each.value, field) === undefined,
        );
        if (args.response_format === "concise") {
          const record = (value ?? {}) as Record<string, unknown>;
          const fields = Object.entries(record).map(([key, item]) =>
            typeof item === "object" && item !== null
              ? `${key}(${Object.keys(item).length})`
              : `${key}=${JSON.stringify(item)}`,
          );
          lines.push(`  ${fields.join(" ")}`);
        } else {
          lines.push(JSON.stringify(value));
        }
        if (unset.length > 0) lines.push(`  not set: ${unset.join(", ")}`);
        if (each.clip?.source.kind === "scene" && args.fields === undefined) {
          lines.push(sceneProperties(call, state, each.clip));
        }
      }
    }
    sawAll(call, seen, whole ? "full" : "overview");
    return answer(call, lines);
  },
};

const KINDS = [
  "clip",
  "track",
  "section",
  "marker",
  "join",
  "scene",
  "sound",
  "asset",
  "file",
  "text",
] as const;

const SearchParams = z.strictObject({
  query: z.string().optional().describe(PARAM),
  kinds: z.array(z.enum(KINDS)).optional().describe(PARAM),
  timeline: z.string().optional().describe(PARAM),
  limit: z.number().int().min(1).max(200).optional().describe(PARAM),
  cursor: z.string().optional().describe(PARAM),
});

export const search: ToolDefinition<z.output<typeof SearchParams>> = {
  name: "aq_search",
  title: "Find objects",
  params: SearchParams,
  run: (call, args) => {
    const state = call.store.getState();
    if (args.timeline !== undefined && !entryOf(state.timelines, args.timeline)) {
      return noTimeline(state, args.timeline);
    }
    const offset = offsetOf(call, "aq_search", args);
    if (typeof offset !== "number") return offset;
    const query = (args.query ?? "").toLowerCase();
    const kinds = new Set<string>(args.kinds ?? KINDS.filter((kind) => kind !== "text"));
    const fits = (...texts: (string | undefined)[]) =>
      query === "" || texts.some((text) => text?.toLowerCase().includes(query));
    const items: string[] = [];
    /** What each item is, where it is a clip, to record the clips the result shows. */
    const refs: (ObjectRef | undefined)[] = [];
    for (const [id, timeline] of Object.entries(state.timelines)) {
      if (args.timeline !== undefined && id !== args.timeline) continue;
      const on = `timeline=${id}`;
      if (kinds.has("clip")) {
        for (const clip of Object.values(timeline.clips).toSorted((a, b) =>
          compare(clipStart(a), clipStart(b)),
        )) {
          if (!fits(clip.id, clip.name, sourceText(clip.source))) continue;
          items.push(`clip ${on} ${clipLine(clip)}`);
          refs[items.length - 1] = { kind: "clip", id: clip.id, timeline: id };
        }
      }
      if (kinds.has("track")) {
        for (const track of orderedTracks(timeline)) {
          if (fits(track.id, track.name))
            items.push(`track ${on} ${named(track.id, track.name)} ${track.kind}`);
        }
      }
      if (kinds.has("section")) {
        for (const section of orderedSections(timeline)) {
          if (fits(section.id, section.name))
            items.push(
              `section ${on} ${named(section.id, section.name)} duration=${section.duration}`,
            );
        }
      }
      if (kinds.has("marker")) {
        for (const marker of Object.values(timeline.markers)) {
          if (fits(marker.id, marker.name, marker.note))
            items.push(`marker ${on} ${named(marker.id, marker.name)} ${marker.time}`);
        }
      }
      if (kinds.has("join")) {
        for (const [join, value] of Object.entries(timeline.joins ?? {})) {
          if (fits(join, value.from, value.to))
            items.push(
              `join ${on} ${join} ${String(value.from)}>${String(value.to)} ${transitionText(value.transition)}`,
            );
        }
      }
    }
    if (kinds.has("scene")) {
      for (const [id, scene] of Object.entries(state.scenes))
        if (fits(id, scene.name)) items.push(`scene ${codeLine(id, scene)}`);
    }
    if (kinds.has("sound")) {
      for (const [id, sound] of Object.entries(state.sounds))
        if (fits(id, sound.name)) items.push(`sound ${codeLine(id, sound)}`);
    }
    if (kinds.has("asset")) {
      for (const [id, asset] of Object.entries(state.assets ?? {})) {
        if (fits(id, asset.name, asset.path)) items.push(`asset ${assetLine(id, asset)}`);
      }
    }
    if (kinds.has("file")) {
      for (const path of Object.keys(state.files).toSorted())
        if (fits(path)) items.push(`file ${path}`);
    }
    if (kinds.has("text") && query !== "") {
      for (const path of Object.keys(state.files).toSorted()) {
        const lines = (state.files[path] ?? "").split("\n");
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query))
            items.push(`text ${path}:${index + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
    }
    return paged(call, "aq_search", args, {
      head: items.length === 0 ? ["found nothing"] : [],
      items,
      offset,
      limit: args.limit ?? 50,
      title: (first, last, total) => `found ${first}-${last} of ${total}:`,
      shown: (first, end) =>
        sawAll(
          call,
          refs.slice(first, end).filter((ref) => ref !== undefined),
        ),
    });
  },
};

const FileReadParams = z.strictObject({
  path: z.string().describe(PARAM),
  offset: z.number().int().min(1).optional().describe(PARAM),
  limit: z.number().int().min(1).max(2000).optional().describe(PARAM),
});

/** Whether a path is a document of the project or a file of an asset: not code to read here. */
export function isNoCodeFile(state: ProjectState, path: string): boolean {
  return isDocument(path) || Object.values(state.assets ?? {}).some((asset) => asset.path === path);
}

export const fileRead: ToolDefinition<z.output<typeof FileReadParams>> = {
  name: "aq_file_read",
  title: "Read a code file",
  params: FileReadParams,
  run: (call, args) => {
    const state = call.store.getState();
    const text = entryOf(state.files, args.path);
    if (text === undefined) {
      if (isNoCodeFile(state, args.path)) {
        return failed(
          `error not-a-code-file: ${args.path} is a document of the project or a file of an asset, not code; documents are in aq_object_read.`,
        );
      }
      const similar = mostLike(args.path, Object.keys(state.files));
      const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
      return failed(`error not-found: no code file ${JSON.stringify(args.path)}${hint}`);
    }
    const crlf = text.includes("\r\n");
    const lines = text.split("\n").map((line) => (crlf ? line.replace(/\r$/, "") : line));
    const first = Math.min(args.offset ?? 1, Math.max(lines.length, 1));
    const wanted = Math.min(lines.length, first - 1 + (args.limit ?? 2000));
    // As many lines as fit in one result; a line too long for that comes cut, and is not read.
    const numbered: string[] = [];
    const cut: number[] = [];
    let room = MAX_RESULT - 500;
    let last = first - 1;
    for (let number = first; number <= wanted; number += 1) {
      const line = lines[number - 1] ?? "";
      const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
      const entry = `${String(number).padStart(6)}→${shown}`;
      if (room - entry.length - 1 < 0 && numbered.length > 0) break;
      room -= entry.length + 1;
      numbered.push(entry);
      if (line.length > MAX_LINE) cut.push(number);
      last = number;
    }
    const revision = call.store.revisionId;
    const whole = cut.length === 0 ? ([first, last] as const) : undefined;
    call.caller.readFile(args.path, revision, textHash(text), lines.length, whole);
    call.caller.saw({ kind: "file", id: args.path }, revision);
    const notes = [
      ...cut.map(
        (number) =>
          `line ${number} is ${(lines[number - 1] ?? "").length} characters long; it is cut after ${MAX_LINE}`,
      ),
      ...(last < lines.length
        ? [`${lines.length - last} more lines: call again with offset ${last + 1}`]
        : []),
    ];
    const endings = crlf ? " (Windows line endings)" : "";
    return answer(call, [
      `file ${args.path} lines ${first}-${last} of ${lines.length}${endings}`,
      ...numbered,
      ...notes,
    ]);
  },
};

const SelectionParams = z.strictObject({});

export const selectionRead: ToolDefinition<z.output<typeof SelectionParams>> = {
  name: "aq_selection_read",
  title: "What the user selected",
  params: SelectionParams,
  run: (call) => {
    const facts = call.host.selection?.();
    if (!facts) return answer(call, ["there is no editor here, so nothing is selected"]);
    if (facts.hidden) return answer(call, ["the user did not share the selection"]);
    const state = call.store.getState();
    const timeline =
      facts.timeline === undefined ? undefined : entryOf(state.timelines, facts.timeline);
    const clips = facts.clips.flatMap((id) => {
      const clip = timeline && entryOf(timeline.clips, id);
      return clip ? [clipLine(clip)] : [];
    });
    const transition = facts.transition
      ? "join" in facts.transition
        ? `join ${facts.transition.join}`
        : `${facts.transition.clip} ${facts.transition.edge}`
      : undefined;
    if (facts.timeline !== undefined) {
      sawAll(
        call,
        facts.clips.map((id) => ({ kind: "clip", id, timeline: facts.timeline }) as ObjectRef),
      );
    }
    return answer(call, [
      "values right now in the editor",
      `timeline=${facts.timeline ?? "none"} playhead=${facts.playhead ?? "none"} version=${facts.version ?? "master"}`,
      `selected clips (${clips.length}): ${clips.join(" | ") || "none"}`,
      ...(transition ? [`selected transition: ${transition}`] : []),
    ]);
  },
};
