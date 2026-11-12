import {
  ExtensionName,
  Id,
  PropertyValue,
  Time,
  ZERO,
  compare,
  parseTime,
  effectOfPath,
  effectPath,
  findEffect,
  isAnimation,
  newId,
  parameterOf,
  specValueIssue,
  type EffectSpec,
} from "@animaquill/schema";
import { z } from "zod";
import { clipPath, dropEffects, timelineOf } from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import { effectsOf, entryOf, type ClipState, type EffectState } from "./model.ts";

/**
 * The commands of the effects of a clip: putting one on, taking it away, moving it in the list and
 * turning it off. What an effect takes are properties of the clip, `effect.<id>.<parameter>`, which
 * `property.edit` changes like any other, with keys. An effect sits flat in its clip, one field at
 * a time (see structure.ts), so two people can do all of this to one clip at the same time.
 */

const effectsPath = (timeline: string, clip: string) => [...clipPath(timeline, clip), "effects"];

function clipOf(draft: Draft, timeline: string, id: string): ClipState {
  return entryOf(timelineOf(draft, timeline).clips, id) ?? fail("not-found", { kind: "clip", id });
}

/** A whole effect of a clip, see `EffectState`. */
function effectOf(clip: ClipState, id: string): EffectState {
  const effect = entryOf(clip.effects, id);
  return effect && typeof effect.type === "string"
    ? effect
    : fail("not-found", { kind: "effect", id, clip: clip.id });
}

/** Only pictures have effects so far: sound gets its own with the mixer. */
function checkPicture(draft: Draft, timeline: string, clip: ClipState): void {
  const track = entryOf(timelineOf(draft, timeline).tracks, clip.track);
  if (track && track.kind !== "video")
    fail("wrong-track", { trackKind: track.kind, holds: "effect" });
}

/** What an effect is, for one that people or AI put somewhere: it has to be one this editor has. */
function specOf(type: string): EffectSpec {
  const found = findEffect(type, "picture");
  return found.kind === "built-in"
    ? found.spec
    : fail("not-found", { kind: "effect", id: type, why: found.why });
}

/** Whether a value is one that a parameter of an effect can take, plain or as keys. */
export function checkParameter(spec: EffectSpec, parameter: string, value: PropertyValue): void {
  const described =
    parameterOf(spec, parameter) ?? fail("not-found", { kind: "parameter", id: parameter });
  if (isAnimation(value) && described.animatable === false) {
    fail("not-animatable", { path: parameter });
  }
  const values = isAnimation(value) ? value.keys.map((key) => key.value) : [value];
  for (const item of values) {
    const issue = specValueIssue(described, item, parameter);
    if (issue) fail("invalid-value", issue);
  }
}

/**
 * Whether a property of a clip can take a value, when it is about one of its effects: the effect
 * has to be there and have that parameter. What is about none passes, and so does taking anything
 * away, which is the way out of bad data.
 */
export function checkEffectWrite(clip: ClipState, path: string, value: PropertyValue): void {
  const of = effectOfPath(path);
  if (!of) return;
  const { type } = effectOf(clip, of.effect);
  const found = findEffect(type as string, "picture");
  // What this editor does not know, it cannot check. It stays as the file has it.
  if (found.kind === "built-in") checkParameter(found.spec, of.parameter, value);
}

/** A number for an effect that goes at an index of the list, without renumbering the others. */
function orderAt(clip: ClipState, index: number | undefined, moving?: string): number {
  const others = effectsOf(clip)
    .filter(({ id }) => id !== moving)
    .map(({ id }) => entryOf(clip.effects, id)?.order ?? 0);
  const at = index === undefined ? others.length : Math.min(index, others.length);
  const before = others[at - 1];
  const after = others[at];
  if (after === undefined) return (before ?? -1) + 1;
  return before === undefined ? after - 1 : (before + after) / 2;
}

/** Puts an effect on a clip, last unless it says where, with what its parameters start with. */
export const EffectAdd = z.strictObject({
  timeline: Id,
  clip: Id,
  /** Without it the editor makes one. */
  id: Id.optional(),
  type: ExtensionName,
  enabled: z.boolean().optional(),
  /** Where it goes in the list, from 0. Without it, after the others. */
  index: z.number().int().min(0).optional(),
  /** What its parameters start with, by parameter, plain or with keys. The rest have defaults. */
  values: z.record(z.string(), PropertyValue).optional(),
  /**
   * When it works, in seconds from the start of the clip, within the clip. Without `start` it
   * works from the start of the clip, without `end` up to its end, as long as the clip is.
   */
  start: Time.optional(),
  end: Time.optional(),
});

/** When an effect works, checked against its clip: within it, and starting before it ends. */
function checkRange(clip: ClipState, start: string | undefined, end: string | undefined): void {
  const length = parseTime(clip.duration);
  const from = start === undefined ? ZERO : parseTime(start);
  const to = end === undefined ? length : parseTime(end);
  if (compare(to, length) > 0 || compare(from, length) > 0) {
    fail("invalid-value", { rule: "effect-outside" });
  }
  if (compare(from, to) >= 0) fail("invalid-value", { rule: "effect-backwards" });
}

export function addEffect(draft: Draft, params: z.output<typeof EffectAdd>): { id: string } {
  const { timeline, type, enabled, index, values, start, end } = params;
  const clip = clipOf(draft, timeline, params.clip);
  checkPicture(draft, timeline, clip);
  const spec = specOf(type);
  checkRange(clip, start, end);
  const id = params.id ?? newId("fx");
  if (entryOf(clip.effects, id)) fail("id-taken", { kind: "effect", id, by: "effect" });
  for (const [parameter, value] of Object.entries(values ?? {})) {
    checkParameter(spec, parameter, value);
  }
  const effect: EffectState = {
    type,
    ...(enabled === false ? { enabled } : {}),
    order: orderAt(clip, index),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
  draft.set([...effectsPath(timeline, clip.id), id], effect);
  for (const [parameter, value] of Object.entries(values ?? {})) {
    draft.set([...clipPath(timeline, clip.id), "properties", effectPath(id, parameter)], value);
  }
  return { id };
}

/** Takes effects off a clip, with all they took, also in versions. */
export const EffectRemove = z.strictObject({
  timeline: Id,
  clip: Id,
  effects: z.array(Id).min(1),
});

export function removeEffects(draft: Draft, params: z.output<typeof EffectRemove>): void {
  const { timeline } = params;
  const clip = clipOf(draft, timeline, params.clip);
  // What only some of is there goes too: that is no effect, see `EffectState`.
  for (const id of params.effects) {
    if (!entryOf(clip.effects, id)) fail("not-found", { kind: "effect", id, clip: clip.id });
  }
  dropEffects(draft, timeline, clip, params.effects);
}

/** Moves an effect to another place in the list of its clip, which changes what it works on. */
export const EffectMove = z.strictObject({
  timeline: Id,
  clip: Id,
  effect: Id,
  /** Where it goes, from 0, in the list without it. */
  index: z.number().int().min(0),
});

export function moveEffect(draft: Draft, params: z.output<typeof EffectMove>): void {
  const { timeline, index } = params;
  const clip = clipOf(draft, timeline, params.clip);
  effectOf(clip, params.effect);
  const list = effectsOf(clip);
  if (list.findIndex(({ id }) => id === params.effect) === index) return;
  draft.set(
    [...effectsPath(timeline, clip.id), params.effect, "order"],
    orderAt(clip, index, params.effect),
  );
}

/**
 * Turns an effect on or off, and changes when it works. Off, it does nothing, and keeps its place
 * and its values. `start` and `end` are from the start of the clip, within it; null takes one away,
 * which is the start or the end of the clip, as long as it is. What is left out stays as it is.
 */
export const EffectUpdate = z
  .strictObject({
    timeline: Id,
    clip: Id,
    effect: Id,
    enabled: z.boolean().optional(),
    start: Time.nullable().optional(),
    end: Time.nullable().optional(),
  })
  .refine(
    ({ enabled, start, end }) => enabled !== undefined || start !== undefined || end !== undefined,
    "要写 enabled、start 或 end",
  );

export function updateEffect(draft: Draft, params: z.output<typeof EffectUpdate>): void {
  const { timeline, enabled } = params;
  const clip = clipOf(draft, timeline, params.clip);
  const effect = effectOf(clip, params.effect);
  const path = [...effectsPath(timeline, clip.id), params.effect];
  const range = {
    start: params.start === undefined ? effect.start : (params.start ?? undefined),
    end: params.end === undefined ? effect.end : (params.end ?? undefined),
  };
  if (params.start !== undefined || params.end !== undefined) {
    checkRange(clip, range.start, range.end);
  }
  for (const field of ["start", "end"] as const) {
    const value = range[field];
    if (value === effect[field]) continue;
    if (value === undefined) draft.delete([...path, field]);
    else draft.set([...path, field], value);
  }
  if (enabled === undefined || (effect.enabled !== false) === enabled) return;
  // On is what an effect is without saying so.
  if (enabled) draft.delete([...path, "enabled"]);
  else draft.set([...path, "enabled"], false);
}
