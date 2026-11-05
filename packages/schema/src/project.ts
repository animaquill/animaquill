import { z } from "zod";
import {
  Assets,
  Libraries,
  LibrariesLock,
  Locale,
  Notes,
  ProjectManifest,
  SceneManifest,
  SoundManifest,
} from "./documents.ts";
import { stringifyDocument } from "./json.ts";
import { checkProject } from "./check.ts";
import { CURRENT_FORMAT_VERSION } from "./version.ts";
import { Overrides, Timeline } from "./timeline.ts";

/** The content of a project folder: paths relative to its root, with the text of each file. */
export type ProjectFiles = ReadonlyMap<string, string>;

export interface Problem {
  /** An error means the file cannot be used. A warning goes to the problems tab. */
  readonly severity: "error" | "warning";
  /** A stable name, for tools. */
  readonly code: string;
  readonly file: string;
  /** Where in the file, such as tracks.0.clips.3.start. */
  readonly path?: string;
  readonly message: string;
}

export interface TimelineFiles {
  /** Missing while timeline.json is broken. */
  readonly document?: Timeline;
  /** By file name without .json. */
  readonly overrides: ReadonlyMap<string, Overrides>;
}

/**
 * A project in memory. Documents that are missing or broken are undefined, and only what is here
 * gets written back: a file nobody could read must not be replaced with something empty.
 */
export interface Project {
  readonly manifest: ProjectManifest;
  readonly assets?: Assets;
  readonly libraries?: Libraries;
  readonly lock?: LibrariesLock;
  readonly notes?: Notes;
  readonly timelines: ReadonlyMap<string, TimelineFiles>;
  readonly scenes: ReadonlyMap<string, SceneManifest>;
  readonly sounds: ReadonlyMap<string, SoundManifest>;
  readonly locales: ReadonlyMap<string, Locale>;
}

export const MANIFEST_FILE = "animaquill.json";

const DOCUMENTS: readonly (readonly [RegExp, z.ZodType])[] = [
  [/^animaquill\.json$/, ProjectManifest],
  [/^assets\.json$/, Assets],
  [/^libraries\.json$/, Libraries],
  [/^libraries\.lock\.json$/, LibrariesLock],
  [/^notes\.json$/, Notes],
  [/^timelines\/[^/]+\/timeline\.json$/, Timeline],
  [/^timelines\/[^/]+\/overrides\/[^/]+\.json$/, Overrides],
  [/^scenes\/[^/]+\/scene\.json$/, SceneManifest],
  [/^sounds\/[^/]+\/sound\.json$/, SoundManifest],
  [/^locales\/[^/]+\.json$/, Locale],
];

/** The schema of a file, or undefined for a file the format does not define. */
export function documentSchema(path: string): z.ZodType | undefined {
  return DOCUMENTS.find(([pattern]) => pattern.test(path))?.[1];
}

export interface ParsedDocument<T> {
  readonly value?: T;
  readonly problems: readonly Problem[];
}

/** Checks one file. This is what a change to a file goes through before it can enter a project. */
export function parseDocument<T>(
  path: string,
  text: string,
  schema: z.ZodType<T>,
): ParsedDocument<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = `不是有效的 JSON：${(error as Error).message}`;
    return { problems: [{ severity: "error", code: "invalid-json", file: path, message }] };
  }
  const result = schema.safeParse(data);
  if (result.success) return { value: result.data, problems: [] };
  const problems = result.error.issues.map((issue): Problem => ({
    severity: "error",
    code: "invalid-document",
    file: path,
    path: issue.path.join("."),
    message: issue.message,
  }));
  return { problems };
}

export interface ReadResult {
  /** Missing only when animaquill.json cannot be used, or the format does not match. */
  readonly project?: Project;
  readonly problems: readonly Problem[];
}

function formatVersionOf(files: ProjectFiles): number | undefined {
  try {
    const version = (JSON.parse(files.get(MANIFEST_FILE) ?? "") as { formatVersion?: unknown })
      .formatVersion;
    return typeof version === "number" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a project. One broken file costs that file, not the whole project. */
export function readProject(files: ProjectFiles): ReadResult {
  const manifestText = files.get(MANIFEST_FILE);
  if (manifestText === undefined) {
    const message = `这里不是项目：没有 ${MANIFEST_FILE}`;
    const problem: Problem = {
      severity: "error",
      code: "not-a-project",
      file: MANIFEST_FILE,
      message,
    };
    return { problems: [problem] };
  }

  const version = formatVersionOf(files);
  if (version !== undefined && version !== CURRENT_FORMAT_VERSION) {
    const newer = version > CURRENT_FORMAT_VERSION;
    const problem: Problem = {
      severity: "error",
      code: newer ? "format-too-new" : "format-needs-migration",
      file: MANIFEST_FILE,
      path: "formatVersion",
      message: newer
        ? `这个项目用的是更新的格式（版本 ${version}），请先更新 AnimaQuill`
        : `这个项目的格式（版本 ${version}）要先升级`,
    };
    return { problems: [problem] };
  }

  const problems: Problem[] = [];
  const read = <T>(path: string, schema: z.ZodType<T>): T | undefined => {
    const text = files.get(path);
    if (text === undefined) return undefined;
    const parsed = parseDocument(path, text, schema);
    problems.push(...parsed.problems);
    return parsed.value;
  };

  const manifest = read(MANIFEST_FILE, ProjectManifest);
  if (!manifest) return { problems };

  /** Names from paths become paths again when writing, so they must not lead anywhere else. */
  const isSafeName = (name: string | undefined) => name === undefined || !name.startsWith(".");

  const matches = (pattern: RegExp) =>
    [...files.keys()].flatMap((path) => {
      const match = pattern.exec(path);
      if (!match?.[1] || !isSafeName(match[1]) || !isSafeName(match[2])) return [];
      return [{ path, id: match[1], rest: match[2] }];
    });

  const collect = <T>(pattern: RegExp, schema: z.ZodType<T>) => {
    const items = new Map<string, T>();
    for (const { path, id } of matches(pattern)) {
      const value = read(path, schema);
      if (value) items.set(id, value);
    }
    return items;
  };

  const timelines = new Map<string, TimelineFiles>();
  const timelineIds = new Set([
    ...manifest.timelines,
    ...matches(/^timelines\/([^/]+)\/timeline\.json$/).map(({ id }) => id),
  ]);
  for (const id of timelineIds) {
    const document = read(`timelines/${id}/timeline.json`, Timeline);
    const overrides = new Map<string, Overrides>();
    for (const { path, id: owner, rest } of matches(
      /^timelines\/([^/]+)\/overrides\/([^/]+)\.json$/,
    )) {
      if (owner !== id || !rest) continue;
      const value = read(path, Overrides);
      if (value) overrides.set(rest, value);
    }
    timelines.set(id, { ...(document ? { document } : {}), overrides });
  }

  const optional = <K extends string, T>(key: K, value: T | undefined) =>
    (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

  const project: Project = {
    manifest,
    ...optional("assets", read("assets.json", Assets)),
    ...optional("libraries", read("libraries.json", Libraries)),
    ...optional("lock", read("libraries.lock.json", LibrariesLock)),
    ...optional("notes", read("notes.json", Notes)),
    timelines,
    scenes: collect(/^scenes\/([^/]+)\/scene\.json$/, SceneManifest),
    sounds: collect(/^sounds\/([^/]+)\/sound\.json$/, SoundManifest),
    locales: collect(/^locales\/([^/]+)\.json$/, Locale),
  };

  return { project, problems: [...problems, ...checkProject(project)] };
}

/** The files of a project, each in its one canonical form. */
export function writeProject(project: Project): Map<string, string> {
  const files = new Map<string, string>();
  const write = (path: string, document: unknown) => {
    if (document !== undefined) files.set(path, stringifyDocument(document));
  };
  write(MANIFEST_FILE, project.manifest);
  write("assets.json", project.assets);
  write("libraries.json", project.libraries);
  write("libraries.lock.json", project.lock);
  write("notes.json", project.notes);
  for (const [id, timeline] of project.timelines) {
    write(`timelines/${id}/timeline.json`, timeline.document);
    for (const [name, overrides] of timeline.overrides) {
      write(`timelines/${id}/overrides/${name}.json`, overrides);
    }
  }
  for (const [id, scene] of project.scenes) write(`scenes/${id}/scene.json`, scene);
  for (const [id, sound] of project.sounds) write(`sounds/${id}/sound.json`, sound);
  for (const [id, locale] of project.locales) write(`locales/${id}.json`, locale);
  return files;
}
