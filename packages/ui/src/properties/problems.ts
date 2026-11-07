import {
  clipNodeOf,
  compileChannel,
  effectiveProperties,
  entryOf,
  isIdPart,
  isSceneOwned,
  sceneSourceOf,
  type ClipChild,
  type ClipDescription,
  type ClipState,
  type ProjectState,
  type RegistrationProblem,
} from "@animaquill/core";
import type { TFunction } from "i18next";
import type { ListedProblem } from "../problems/list.ts";

/** A problem of a property, before it gets an id. */
export type PropertyProblem = Omit<ListedProblem, "id">;

export interface PropertyProblemSources {
  readonly describe: (clip: ClipState) => ClipDescription | undefined;
  /** What did not make sense in what a state of a scene registered. */
  readonly registered: (revision: string) => readonly RegistrationProblem[];
  readonly clipName: (clip: ClipState) => string;
  /** Moves keys from where they are to where a property is, as one step. */
  readonly rename: (clip: string, from: string, to: string) => void;
}

/** More than anybody reads. A project of thousands of clips should not slow down for this. */
const MAX_PROBLEMS = 300;

const words = (fields: Readonly<Record<string, string>>) => ({
  ...fields,
  // Paths and names from a project are text, whatever they look like.
  interpolation: { escapeValue: false },
});

function orphanPaths(children: readonly ClipChild[]): readonly string[] {
  const group = children.find((child) => child.kind === "object" && child.orphans);
  return group?.kind === "object"
    ? group.children.flatMap((child) => (child.kind === "property" ? [child.spec.path] : []))
    : [];
}

/** Properties a clip describes, with what they are. */
function describedSpecs(described: ClipDescription) {
  return described.objects.flatMap(({ properties }) => properties);
}

/**
 * What is wrong with what clips hold for their scenes: keys that nothing describes any more, keys
 * under a path that a property went by before, values of the wrong type, and what code registered
 * that made no sense. Each of them says where it is, and what to do when there is something.
 */
export function propertyProblems(
  state: ProjectState,
  timeline: string,
  sources: PropertyProblemSources,
  t: TFunction,
): readonly PropertyProblem[] {
  const problems: PropertyProblem[] = [];
  const clips = Object.values(entryOf(state.timelines, timeline)?.clips ?? {});
  const scenes = new Set<string>();
  for (const clip of clips) {
    if (problems.length >= MAX_PROBLEMS) break;
    const { source } = clip;
    if (source.kind !== "scene" || typeof source.scene !== "string") continue;
    const origin = sources.clipName(clip);
    const described = sources.describe(clip);
    if (!described) continue;
    const target = (path: string) => ({ target: { clip: clip.id, path }, place: path });
    for (const path of orphanPaths(clipNodeOf(clip, described).children)) {
      if (!isSceneOwned(path)) continue;
      const text = t("problems.properties.orphan", words({ path }));
      problems.push({ severity: "warning", text, origin, ...target(path) });
    }
    for (const { from, to } of described.renames ?? []) {
      const text = t("problems.properties.renamed", words({ from, to }));
      const label = t("problems.properties.migrate");
      const action = { label, run: () => sources.rename(clip.id, from, to) };
      problems.push({ severity: "warning", text, origin, ...target(from), action });
    }
    const properties = effectiveProperties(clip);
    for (const spec of describedSpecs(described)) {
      if (!isSceneOwned(spec.path)) continue;
      const stored = entryOf(properties, spec.path);
      if (stored === undefined || compileChannel(stored, spec.type) !== undefined) continue;
      const type = t(`problems.properties.types.${spec.type}`);
      const text = t("problems.properties.mismatch", words({ path: spec.path, type }));
      problems.push({ severity: "warning", text, origin, ...target(spec.path) });
    }
    if (scenes.has(source.scene)) continue;
    scenes.add(source.scene);
    for (const param of entryOf(state.scenes, source.scene)?.params ?? []) {
      if (isIdPart(param.id)) continue;
      const text = t("problems.properties.param", words({ name: param.name }));
      problems.push({ severity: "warning", text, origin });
    }
    const revision = sceneSourceOf(state, source.scene)?.revision;
    for (const { code, target: about = "" } of revision ? sources.registered(revision) : []) {
      const text = t(`scene.problems.codes.${code}`, words({ target: about }));
      problems.push({ severity: "warning", text, origin });
    }
  }
  return problems.slice(0, MAX_PROBLEMS);
}
