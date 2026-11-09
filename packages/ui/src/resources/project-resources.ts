import type { ProjectState } from "@animaquill/core";
import type { Asset, SceneManifest, SoundManifest } from "@animaquill/schema";
import type { Resource } from "./resources.ts";

/** What the tabs know of each resource of the project they list. */
export type ProjectItem =
  | { readonly kind: "asset"; readonly id: string; readonly asset: Asset }
  | { readonly kind: "scene"; readonly id: string; readonly scene: SceneManifest }
  | { readonly kind: "sound"; readonly id: string; readonly sound: SoundManifest };

/**
 * The types of the resources of a project, in the order people see them, see docs/design/libraries.md,
 * "分类": pictures, sound, fonts, scene templates, and sound that code makes. Other files last.
 */
export const PROJECT_TYPES: readonly string[] = [
  "media.video",
  "media.image",
  "media.audio",
  "font",
  "scene",
  "sound",
  "file",
];

/** Those that the assets tab lists: what can be found and used from it. */
export const ASSETS_TAB_TYPES: ReadonlySet<string> = new Set(PROJECT_TYPES.slice(0, -1));

export const typeOfAsset = (asset: Asset): string =>
  asset.kind === "video" || asset.kind === "image" || asset.kind === "audio"
    ? `media.${asset.kind}`
    : asset.kind === "font"
      ? "font"
      : "file";

/**
 * A resource of the project by what it is: unique among all resources, and the same from one session
 * to the next. Which project it is in is part of it, so that what was used in one project does not
 * show up as used in another that has an asset of the same id.
 */
export const projectResourceId = (project: string, kind: ProjectItem["kind"], id: string) =>
  `project:${project}:${kind}:${id}`;

/** What a file is called where it has no name of its own. */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Everything the project has that can be used again, as resources. */
export function projectResources(
  state: ProjectState,
  project: string,
): readonly Resource<ProjectItem>[] {
  const source = { kind: "project" } as const;
  const assets = Object.entries(state.assets ?? {}).map(([id, asset]): Resource<ProjectItem> => ({
    id: projectResourceId(project, "asset", id),
    source,
    type: typeOfAsset(asset),
    name: asset.name ?? fileName(asset.path),
    tags: asset.tags ?? [],
    keywords: [asset.path, id],
    data: { kind: "asset", id, asset },
  }));
  const scenes = Object.entries(state.scenes).map(([id, scene]): Resource<ProjectItem> => ({
    id: projectResourceId(project, "scene", id),
    source,
    type: "scene",
    name: scene.name,
    tags: scene.tags ?? [],
    keywords: [id, ...(scene.description === undefined ? [] : [scene.description])],
    data: { kind: "scene", id, scene },
  }));
  const sounds = Object.entries(state.sounds).map(([id, sound]): Resource<ProjectItem> => ({
    id: projectResourceId(project, "sound", id),
    source,
    type: "sound",
    name: sound.name,
    tags: sound.tags ?? [],
    keywords: [id, ...(sound.description === undefined ? [] : [sound.description])],
    data: { kind: "sound", id, sound },
  }));
  return [...assets, ...scenes, ...sounds];
}

/** What a resource of the project is, from its id, or undefined for one of somewhere else. */
export function parseProjectResourceId(
  id: string,
):
  | { readonly project: string; readonly kind: ProjectItem["kind"]; readonly id: string }
  | undefined {
  const match = /^project:([^:]+):(asset|scene|sound):(.+)$/.exec(id);
  if (!match) return undefined;
  const [, project = "", kind, item = ""] = match;
  return { project, kind: kind as ProjectItem["kind"], id: item };
}

/** Splits what people typed as tags: by 、, commas and spaces, each once. */
export const parseTags = (text: string): readonly string[] => [
  ...new Set(
    text
      .split(/[、,，;；\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];
