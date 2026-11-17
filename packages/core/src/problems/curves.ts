import {
  BUILT_IN_PROPERTIES,
  builtInEffect,
  effectOfPath,
  isAnimation,
  parameterOf,
  type Animation,
  type ValueType,
} from "@animaquill/schema";
import { canMix, canShake, knowsPreset } from "../curve.ts";
import { effectsOf, type ClipState, type ProjectState } from "../model.ts";
import type { ClipDescription } from "../objects.ts";
import { effectiveProperties } from "../render-plan.ts";
import { withId, type ProjectProblem } from "./model.ts";
import { outputsOf } from "./unsupported.ts";

/**
 * What keys say that makes no difference to how they are worked out: a preset this editor does not
 * know goes linearly, and shaking does nothing to a value that is not a number.
 */
export const CURVE_CODES = ["unknown-ease-preset", "noise-not-applicable"] as const;

/** Properties whose keys this editor does not apply yet, see `unsupported.ts`. */
const NOT_APPLIED = ["audio.", "time."];

/** More than anybody reads. A project of thousands of clips should not slow down for this. */
const MAX_CURVE_PROBLEMS = 300;

/** What a property of a clip holds, as far as that is known without running its scene. */
function typeOf(
  clip: ClipState,
  path: string,
  described: ClipDescription | undefined,
): ValueType | undefined {
  if (Object.hasOwn(BUILT_IN_PROPERTIES, path)) return BUILT_IN_PROPERTIES[path]?.type;
  const of = effectOfPath(path);
  if (of) {
    const effect = effectsOf(clip).find(({ id }) => id === of.effect);
    const spec = effect?.type === undefined ? undefined : builtInEffect(effect.type);
    return spec && parameterOf(spec, of.parameter)?.type;
  }
  for (const { properties } of described?.objects ?? []) {
    const spec = properties.find((property) => property.path === path);
    if (spec) return spec.type;
  }
  return undefined;
}

/** The name of the first preset that is not known, in a stretch that it would ease. */
function unknownPreset(animation: Animation): string | undefined {
  const { keys } = animation;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (key?.interp === "preset" && !knowsPreset(key)) return key.preset ?? "";
  }
  return undefined;
}

/**
 * Keys of clips that say something this editor cannot do or that does nothing, property by
 * property. Types come from the format and the effects, and from what scenes describe when that is
 * given: without it, shaking on what a scene has is not looked at.
 */
export function curveProblems(
  state: ProjectState,
  describe?: (clip: ClipState) => ClipDescription | undefined,
): readonly ProjectProblem[] {
  const problems: ProjectProblem[] = [];
  for (const [timelineId, timeline] of Object.entries(state.timelines)) {
    const { partOf } = outputsOf(timeline);
    for (const clip of Object.values(timeline.clips)) {
      if (problems.length >= MAX_CURVE_PROBLEMS) return problems;
      const subject = { kind: "clip", id: clip.id, timeline: timelineId } as const;
      let described: ClipDescription | undefined;
      let looked = false;
      const typeAt = (path: string) => {
        if (!looked && clip.source.kind === "scene") described = describe?.(clip);
        looked = true;
        return typeOf(clip, path, described);
      };
      for (const [path, value] of Object.entries(effectiveProperties(clip))) {
        // Keys of sound and of speed are not applied yet: that is a problem of its own.
        if (!isAnimation(value) || NOT_APPLIED.some((prefix) => path.startsWith(prefix))) continue;
        const preset = unknownPreset(value);
        const shakes = (value.modifiers ?? []).some(({ type }) => type === "noise");
        if (preset === undefined && !shakes) continue;
        const type = typeAt(path);
        if (preset !== undefined && (type === undefined || canMix(type))) {
          const part = partOf(clip);
          problems.push(
            withId({
              source: "properties",
              severity: "warning",
              code: "unknown-ease-preset",
              params: { path, preset },
              subject,
              place: path,
              ...(part && { affectsOutput: part }),
            }),
          );
        }
        if (shakes && type !== undefined && !canShake(type)) {
          problems.push(
            withId({
              source: "properties",
              severity: "warning",
              code: "noise-not-applicable",
              params: { path, type },
              subject,
              place: path,
            }),
          );
        }
      }
    }
  }
  return problems.slice(0, MAX_CURVE_PROBLEMS);
}
