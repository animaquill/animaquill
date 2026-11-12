import { compileChannel } from "../curve.ts";
import { entryOf, type ClipState, type ProjectState } from "../model.ts";
import type { ClipDescription } from "../objects.ts";
import { clipNodeOf, type ClipChild } from "../property-tree.ts";
import { isIdPart, isSceneOwned, type RegistrationProblem } from "../registration.ts";
import { effectiveProperties } from "../render-plan.ts";
import { sceneSourceOf } from "../scene-plan.ts";
import { withId, type ProjectProblem } from "./model.ts";

export interface PropertyInputs {
  /** What a clip has to describe it, with what the code of its scene registered here. */
  readonly describe: (clip: ClipState) => ClipDescription | undefined;
  /** What did not make sense in what a state of a scene registered. */
  readonly registered?: (revision: string) => readonly RegistrationProblem[];
}

/** The codes of problems of properties. */
export const PROPERTY_CODES = [
  "property-orphan",
  "property-orphan-element",
  "property-renamed",
  "property-mismatch",
  "scene-param-id",
  "scene-registration",
] as const;

/** More than anybody reads. A project of thousands of clips should not slow down for this. */
const MAX_PROPERTY_PROBLEMS = 300;

function orphanPaths(children: readonly ClipChild[]): readonly string[] {
  const group = children.find((child) => child.kind === "object" && child.orphans);
  return group?.kind === "object"
    ? group.children.flatMap((child) => (child.kind === "property" ? [child.spec.path] : []))
    : [];
}

/** Properties a clip describes, with what they are. */
const describedSpecs = (described: ClipDescription) =>
  described.objects.flatMap(({ properties }) => properties);

/**
 * What is wrong with what clips hold for their scenes: keys that nothing describes any more, keys
 * under a path that a property went by before, values of the wrong type, and what code registered
 * that made no sense. Each says where it is, and what fixes it when something does.
 */
export function propertyProblems(
  state: ProjectState,
  timeline: string,
  inputs: PropertyInputs,
): readonly ProjectProblem[] {
  const problems: ProjectProblem[] = [];
  const clips = Object.values(entryOf(state.timelines, timeline)?.clips ?? {});
  const scenes = new Set<string>();
  for (const clip of clips) {
    if (problems.length >= MAX_PROPERTY_PROBLEMS) break;
    const { source } = clip;
    if (source.kind !== "scene" || typeof source.scene !== "string") continue;
    const described = inputs.describe(clip);
    if (!described) continue;
    const subject = { kind: "clip", id: clip.id, timeline } as const;
    const warn = (code: string, params: Record<string, string>, place?: string) =>
      problems.push(
        withId({
          source: "properties",
          severity: "warning",
          code,
          params,
          subject,
          ...(place !== undefined && { place }),
        }),
      );
    for (const path of orphanPaths(clipNodeOf(clip, described).children)) {
      if (!isSceneOwned(path)) continue;
      // Code can make an element at any moment, so one that is not there is not known to be gone.
      const code = path.startsWith("element.") ? "property-orphan-element" : "property-orphan";
      warn(code, { path }, path);
    }
    for (const { from, to } of described.renames ?? []) {
      const renames = [{ owner: { clip: clip.id }, from, to }];
      problems.push(
        withId({
          source: "properties",
          severity: "warning",
          code: "property-renamed",
          params: { from, to },
          subject,
          place: from,
          fix: { type: "property.rename", params: { timeline, renames } },
        }),
      );
    }
    const properties = effectiveProperties(clip);
    for (const spec of describedSpecs(described)) {
      if (!isSceneOwned(spec.path)) continue;
      const stored = entryOf(properties, spec.path);
      if (stored === undefined || compileChannel(stored, spec.type) !== undefined) continue;
      warn("property-mismatch", { path: spec.path, type: spec.type }, spec.path);
    }
    if (scenes.has(source.scene)) continue;
    scenes.add(source.scene);
    const scene = { kind: "scene", id: source.scene } as const;
    for (const param of entryOf(state.scenes, source.scene)?.params ?? []) {
      if (isIdPart(param.id)) continue;
      const params = { id: param.id, name: param.name };
      problems.push(
        withId({
          source: "properties",
          severity: "warning",
          code: "scene-param-id",
          params,
          subject: scene,
        }),
      );
    }
    const revision = sceneSourceOf(state, source.scene)?.revision;
    for (const { code, target = "" } of revision ? (inputs.registered?.(revision) ?? []) : []) {
      problems.push(
        withId({
          source: "properties",
          severity: "warning",
          code: "scene-registration",
          params: { problem: code, target },
          subject: scene,
        }),
      );
    }
  }
  return problems.slice(0, MAX_PROPERTY_PROBLEMS);
}
