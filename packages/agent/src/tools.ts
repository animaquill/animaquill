import {
  COMMANDS,
  aiTask,
  clipEnd,
  clipFileOf,
  clipStart,
  effectsOf,
  entryOf,
  orderedSections,
  orderedTracks,
  projectFrameRate,
  timelineLength,
  type ClipState,
  type CommandDefinition,
  type ProjectState,
  type ProjectStore,
  type TimelineState,
} from "@animaquill/core";
import { Time, compare, formatTime, parseTime } from "@animaquill/schema";
import { z } from "zod";
import type { ToolSpec } from "./pi.ts";

/**
 * What AI can do in the browser: every command people can give it, which change the project the way
 * people do, and tools that read. They are plain objects here, see `ToolSpec`, so that they can be
 * tested without any service.
 */

/** Services only take names of `[a-zA-Z0-9_-]`, and commands have dots. */
export const toolName = (command: string): string => command.replaceAll(".", "_");

/** What the editor shows of a window right now, which AI can ask about. */
export interface SelectionFacts {
  readonly timeline: string | undefined;
  /** In seconds, as times in the project are written. */
  readonly playhead: string | undefined;
  readonly clips: readonly string[];
  /** A transition at the edge of a clip, or a join between two. */
  readonly transition?:
    { readonly clip: string; readonly edge: "enter" | "exit" } | { readonly join: string };
}

export interface ToolContext {
  readonly store: () => ProjectStore | undefined;
  /** The task whose changes these are: they can be taken back together, see `undoOrigin`. */
  readonly task: string;
  readonly selection: () => SelectionFacts | undefined;
  /**
   * The revision of the project AI knows: what people changed after it is theirs, and a command
   * that would change it again is refused. Undefined does not check.
   */
  readonly seen: () => number | undefined;
  /** After each tool, which is what AI knows from then on. */
  readonly saw: (revision: number) => void;
}

/** How much of the project a tool answers with at most, so that one answer does not fill AI up. */
export const MAX_TOOL_TEXT = 40_000;
const DEFAULT_CLIP_LIMIT = 200;
const MAX_FILE_CHUNK = 20_000;

/** As JSON, and shortened with a word about it when it is too long. */
function answer(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}…（太长，后面省略了。请缩小范围再读。）`;
}

function storeOf(context: ToolContext): ProjectStore {
  const store = context.store();
  if (!store) throw new Error("no-project: 现在没有打开的项目");
  return store;
}

/** The command's parameters as JSON Schema, without what only people may use. */
export function parametersOf(command: CommandDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(command.params, {
    target: "draft-2020-12",
    io: "input",
    // Refinements have no JSON Schema form. The store checks them anyway.
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as string[] | undefined;
  for (const key of command.userOnlyParams ?? []) {
    delete properties?.[key];
    if (required) schema.required = required.filter((name) => name !== key);
  }
  return schema;
}

/** The commands AI may give, as tools. What only people can do is not among them. */
export function commandTools(context: ToolContext): ToolSpec[] {
  return COMMANDS.filter((command) => !command.userOnly).map((command) => ({
    name: toolName(command.type),
    label: command.type,
    description: command.description,
    parameters: parametersOf(command),
    run: async (args) => {
      const store = storeOf(context);
      // Parameters only people may use are not there for AI, also when it writes them anyway.
      const params = { ...args };
      for (const key of command.userOnlyParams ?? []) delete params[key];
      const base = context.seen();
      const result = store.execute(
        { type: command.type, params },
        { origin: aiTask(context.task), ...(base !== undefined && { baseRevision: base }) },
      );
      if (!result.ok) {
        const { code, message, conflicts } = result.error;
        const where = conflicts?.length
          ? `（${conflicts.map((path) => path.join("/")).join("，")}）`
          : "";
        const reread = code === "conflict" ? "用户刚改过这些内容，先重新读取再决定。" : "";
        throw new Error(`${code}: ${message}${where}${reread}`);
      }
      context.saw(store.revision);
      return answer({ ok: true, revision: result.revision, result: result.results[0] ?? null });
    },
  }));
}

const nameOf = (clip: ClipState) => clip.name;

function sourceOf(clip: ClipState): Record<string, unknown> {
  return { ...(clip.source as Record<string, unknown>) };
}

/** A clip in a few words: enough to find it and to know what it is. */
function clipLine(clip: ClipState) {
  const effects = effectsOf(clip).map(({ id, type }) => ({ id, type }));
  const properties = Object.keys(clip.properties ?? {});
  return {
    id: clip.id,
    ...(nameOf(clip) !== undefined && { name: nameOf(clip) }),
    track: clip.track,
    start: clip.start,
    duration: clip.duration,
    end: formatTime(clipEnd(clip)),
    source: sourceOf(clip),
    ...(clip.offset !== undefined && { offset: clip.offset }),
    ...(clip.link !== undefined && { link: clip.link }),
    ...(clip.hidden && { hidden: true }),
    ...(clip.enter && { enter: clip.enter.type ?? clip.enter.transition ?? "?" }),
    ...(clip.exit && { exit: clip.exit.type ?? clip.exit.transition ?? "?" }),
    ...(effects.length > 0 && { effects }),
    ...(properties.length > 0 && { properties }),
  };
}

/** A clip as the project format writes it, with everything. */
const clipDetails = (clip: ClipState) => ({ ...clipFileOf(clip), track: clip.track });

function timelineOf(state: ProjectState, id: string | undefined): [string, TimelineState] {
  const wanted = id ?? state.manifest.timelines[0];
  const timeline = wanted === undefined ? undefined : entryOf(state.timelines, wanted);
  if (wanted === undefined || !timeline) throw new Error(`not-found: 没有这个时间轴：${id ?? ""}`);
  return [wanted, timeline];
}

function overviewOf(state: ProjectState, revision: number) {
  const { manifest } = state;
  const timelines = manifest.timelines.flatMap((id) => {
    const timeline = entryOf(state.timelines, id);
    if (!timeline) return [];
    return [
      {
        id,
        name: timeline.name,
        length: formatTime(timelineLength(timeline)),
        tracks: orderedTracks(timeline).map(({ id: track, kind, name }) => ({
          id: track,
          kind,
          ...(name !== undefined && { name }),
        })),
        clips: Object.keys(timeline.clips).length,
      },
    ];
  });
  const assets = Object.entries(state.assets ?? {}).map(([id, asset]) => ({
    id,
    ...(asset.name !== undefined && { name: asset.name }),
    kind: asset.kind,
    path: asset.path,
    ...(asset.info?.duration !== undefined && { duration: asset.info.duration }),
    ...(asset.info?.width !== undefined && { size: `${asset.info.width}x${asset.info.height}` }),
  }));
  const scripts = (
    map: Readonly<Record<string, { readonly name?: string; readonly entry: string }>>,
  ) =>
    Object.entries(map).map(([id, item]) => ({
      id,
      ...(item.name !== undefined && { name: item.name }),
      entry: item.entry,
    }));
  const files = Object.keys(state.files).toSorted();
  return {
    revision,
    name: manifest.name,
    fps: projectFrameRate(manifest),
    formats: manifest.formats,
    timelines,
    assets,
    scenes: scripts(state.scenes as never),
    sounds: scripts(state.sounds as never),
    files: files.slice(0, 500),
    ...(files.length > 500 && { moreFiles: files.length - 500 }),
    ...(manifest.tags?.some((tag) => tag.locked) && { locked: true }),
  };
}

const TimelineRead = z.strictObject({
  timeline: z.string().optional(),
  from: Time.optional(),
  to: Time.optional(),
  tracks: z.array(z.string()).optional(),
  clips: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});

function timelineSummary(
  state: ProjectState,
  args: z.output<typeof TimelineRead>,
  revision: number,
) {
  const [id, timeline] = timelineOf(state, args.timeline);
  if (args.clips) {
    const clips = args.clips.map((clip) => {
      const found = entryOf(timeline.clips, clip);
      return found ? clipDetails(found) : { id: clip, missing: true };
    });
    return { revision, timeline: id, clips };
  }
  const from = args.from === undefined ? undefined : parseTime(args.from);
  const to = args.to === undefined ? undefined : parseTime(args.to);
  const tracks = new Set(args.tracks ?? orderedTracks(timeline).map((track) => track.id));
  const limit = args.limit ?? DEFAULT_CLIP_LIMIT;
  const inRange = Object.values(timeline.clips)
    .filter((clip) => tracks.has(clip.track))
    .filter((clip) => from === undefined || compare(clipEnd(clip), from) > 0)
    .filter((clip) => to === undefined || compare(clipStart(clip), to) < 0)
    .toSorted((a, b) => compare(clipStart(a), clipStart(b)));
  return {
    revision,
    timeline: id,
    name: timeline.name,
    length: formatTime(timelineLength(timeline)),
    sections: orderedSections(timeline).map(({ id: section, name, duration }) => ({
      id: section,
      ...(name !== undefined && { name }),
      duration,
    })),
    tracks: orderedTracks(timeline)
      .filter((track) => tracks.has(track.id))
      .map(({ order: _order, ...track }) => track),
    clips: inRange.slice(0, limit).map(clipLine),
    ...(inRange.length > limit && { moreClips: inRange.length - limit }),
    joins: Object.values(timeline.joins ?? {}),
    markers: Object.values(timeline.markers),
    ...(Object.keys(timeline.overrides).length > 0 && {
      versions: Object.keys(timeline.overrides),
    }),
  };
}

const FileRead = z.strictObject({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(MAX_FILE_CHUNK).optional(),
});

/** Parameters of a tool, as AI sees them. */
const schemaOf = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
};

/** Checks what AI wrote, as the commands do: what does not fit says why. */
function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`invalid-params: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
}

/** Tools that only read. They change nothing, so they need no checking against what people did. */
export function readTools(context: ToolContext): ToolSpec[] {
  const read = <T>(work: (state: ProjectState, revision: number) => T) => {
    const store = storeOf(context);
    const revision = store.revision;
    const result = work(store.getState(), revision);
    context.saw(revision);
    return answer(result);
  };
  return [
    {
      name: "project_overview",
      label: "读项目结构",
      description:
        "读项目的结构：名字、帧率、画面格式、时间轴和它们的轨道、素材、场景、声音和代码文件的列表。改项目之前先读这个。",
      parameters: schemaOf(z.strictObject({})),
      run: async () => read((state, revision) => overviewOf(state, revision)),
    },
    {
      name: "timeline_read",
      label: "读时间轴",
      description:
        "读一条时间轴的摘要：段落、轨道、片段（按开始时间排序，带开头、时长、内容、转场、效果和属性名）、衔接转场和标记。可以按时间范围（from、to，单位秒）和轨道缩小；给 clips 时改为读这些片段的全部内容，包括属性的值和关键帧。不写 timeline 时读第一条时间轴。",
      parameters: schemaOf(TimelineRead),
      run: async (args) => {
        const parsed = parse(TimelineRead, args);
        return read((state, revision) => timelineSummary(state, parsed, revision));
      },
    },
    {
      name: "selection_read",
      label: "读选中内容",
      description:
        "读用户现在在编辑器里选中的内容：时间轴、播放头的位置（秒）、选中的片段的全部内容、选中的转场或衔接转场。用户说“这个”“这里”时先读这个。",
      parameters: schemaOf(z.strictObject({})),
      run: async () =>
        read((state, revision) => {
          const facts = context.selection();
          if (!facts?.timeline) return { revision, timeline: null, clips: [] };
          const timeline = entryOf(state.timelines, facts.timeline);
          const clips = facts.clips.flatMap((id) => {
            const clip = timeline && entryOf(timeline.clips, id);
            return clip ? [clipDetails(clip)] : [];
          });
          return {
            revision,
            timeline: facts.timeline,
            playhead: facts.playhead ?? null,
            clips,
            ...(facts.transition && { transition: facts.transition }),
          };
        }),
    },
    {
      name: "file_read",
      label: "读文件",
      description:
        "读项目里的一个代码文件（场景、声音或共用代码），路径和项目结构里的一样。长文件分段读：offset 是从第几个字符开始，length 是读多少个字符。",
      parameters: schemaOf(FileRead),
      run: async (args) => {
        const { path, offset = 0, length = MAX_FILE_CHUNK } = parse(FileRead, args);
        return read((state, revision) => {
          const text = entryOf(state.files, path);
          if (text === undefined) throw new Error(`not-found: 没有这个文件：${path}`);
          const part = text.slice(offset, offset + length);
          return {
            revision,
            path,
            length: text.length,
            offset,
            text: part,
            ...(offset + part.length < text.length && { more: text.length - offset - part.length }),
          };
        });
      },
    },
  ];
}

/** Everything AI can use in the browser: reading first, then the commands. */
export const allTools = (context: ToolContext): ToolSpec[] => [
  ...readTools(context),
  ...commandTools(context),
];
