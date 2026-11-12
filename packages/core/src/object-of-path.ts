import type { Path } from "./structure.ts";

/**
 * What a change is about, as people and AI think of a project: a clip, a track, a file. Paths of
 * the document are finer than that, and change with how it is laid out, see structure.ts.
 */
export type ObjectKind =
  | "project"
  | "timeline"
  | "section"
  | "track"
  | "clip"
  | "join"
  | "marker"
  | "scene"
  | "sound"
  | "asset"
  | "file";

export interface ObjectRef {
  readonly kind: ObjectKind;
  /** Its id; the path for a file, "project" for the project. */
  readonly id: string;
  /** The timeline it is on, for what is on one. */
  readonly timeline?: string;
}

const PROJECT: ObjectRef = { kind: "project", id: "project" };

const ON_TIMELINE: Readonly<Record<string, ObjectKind>> = {
  sections: "section",
  tracks: "track",
  clips: "clip",
  joins: "join",
  markers: "marker",
};

/**
 * The object that a path of the project is part of, for telling what changed and what somebody
 * saw. What a clip has, its properties, effects and transitions, is the clip; what a version
 * changes of a clip is that clip too, and the rest of a version is its timeline. Whole lists, such
 * as all clips of a timeline, are the timeline; whatever is about all of the project is the project.
 */
export function objectOfPath(path: Path): ObjectRef {
  const [top, id, level, inner, kind, owner] = path;
  if (id === undefined) return PROJECT;
  switch (top) {
    case "assets":
    case "places":
      return { kind: "asset", id };
    case "scenes":
      return { kind: "scene", id };
    case "sounds":
      return { kind: "sound", id };
    case "files":
      return { kind: "file", id };
    case "timelines": {
      const timeline = { kind: "timeline", id } as const;
      if (level === undefined || inner === undefined) return timeline;
      if (level === "overrides") {
        return kind === "clips" && owner !== undefined
          ? { kind: "clip", id: owner, timeline: id }
          : timeline;
      }
      const found = Object.hasOwn(ON_TIMELINE, level) ? ON_TIMELINE[level] : undefined;
      return found ? { kind: found, id: inner, timeline: id } : timeline;
    }
    default:
      return PROJECT;
  }
}

/** Where an object itself is in the state: its record, which is there as long as it is. */
export function pathOfObject({ kind, id, timeline = "" }: ObjectRef): Path {
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

/** A key for an object, the same for the same object, whatever path it came from. */
export const objectKey = ({ kind, id, timeline }: ObjectRef): string =>
  timeline === undefined ? `${kind}\n${id}` : `${kind}\n${timeline}\n${id}`;
