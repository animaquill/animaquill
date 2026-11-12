import { createProject, type Project, type SceneManifest, type Timeline } from "@animaquill/schema";
import type { ProjectState } from "../model.ts";
import { ProjectStore } from "../store.ts";

/** Only for tests: a project with these tracks on its timeline, read the way any project is read. */
export interface Setup {
  readonly tracks: Timeline["tracks"];
  readonly mix?: Timeline["mix"];
  readonly assets?: NonNullable<Project["assets"]>["assets"];
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly formats?: Project["manifest"]["formats"];
  readonly scenes?: Readonly<Record<string, SceneManifest>>;
  /** Files of code, by their path in the project. */
  readonly files?: Readonly<Record<string, string>>;
}

export function stateOf(setup: Setup): ProjectState {
  return storeOf(setup).getState();
}

export function storeOf({
  tracks,
  mix,
  assets,
  overrides = {},
  formats,
  scenes = {},
  files = {},
}: Setup): ProjectStore {
  const created = createProject({ name: "问题" });
  const document: Timeline = {
    name: "主线",
    sections: [{ id: "section", duration: "60" }],
    tracks,
    ...(mix && { mix }),
  };
  const project: Project = {
    ...created,
    manifest: { ...created.manifest, ...(formats && { formats }) },
    ...(assets && { assets: { assets } }),
    scenes: new Map(Object.entries(scenes)),
    timelines: new Map([
      ["main", { document, overrides: new Map(Object.entries(overrides) as never) }],
    ]),
  };
  return ProjectStore.create(project, files);
}

export const video = (clips: readonly object[], more: object = {}) =>
  ({ id: "v", kind: "video", clips, ...more }) as never;
export const audio = (clips: readonly object[], more: object = {}, id = "a") =>
  ({ id, kind: "audio", clips, ...more }) as never;
export const captions = (clips: readonly object[], more: object = {}) =>
  ({ id: "c", kind: "caption", clips, ...more }) as never;

export const clip = (id: string, source: object, more: object = {}) => ({
  id,
  start: "0",
  duration: "5",
  source,
  ...more,
});
export const color = (id: string, more: object = {}) =>
  clip(id, { kind: "color", color: "#ff0000" }, more);
export const tone = (id: string, more: object = {}) =>
  clip(id, { kind: "audio", media: { asset: "tone" } }, more);

export const TONE = {
  tone: {
    kind: "audio" as const,
    path: "assets/tone.wav",
    storage: "git" as const,
    info: { duration: "10" },
  },
};
