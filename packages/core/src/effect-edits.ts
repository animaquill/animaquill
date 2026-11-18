import {
  BUILT_IN_EFFECTS,
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
  type EffectMedia,
  type EffectSpec,
} from "@animaquill/schema";
import { z } from "zod";
import { clipPath, dropEffects, timelineOf } from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import {
  effectsOf,
  entryOf,
  type ClipEffect,
  type ClipState,
  type EffectState,
  type TimelineState,
} from "./model.ts";

/**
 * The commands of effects: putting one on, taking it away, moving it in the list and turning it
 * off, on a clip, a track of sound or the master. What an effect takes are properties of what it is
 * on, `effect.<id>.<parameter>`, which `property.edit` changes like any other, with keys. An effect
 * of a clip sits flat in its clip, one field at a time (see structure.ts), so two people can do all
 * of this to one clip at the same time; a track and the master keep theirs as one list, as files do,
 * so two people changing the list of one track at the same time keep one of the two lists.
 */

const effectsPath = (timeline: string, clip: string) => [...clipPath(timeline, clip), "effects"];
const trackPath = (timeline: string, track: string) => ["timelines", timeline, "tracks", track];
const mixPath = (timeline: string) => ["timelines", timeline, "mix"];

type Mix = NonNullable<TimelineState["mix"]>;
type Master = NonNullable<Mix["master"]>;
type Properties = Readonly<Record<string, PropertyValue>>;

/**
 * Where an effect is, or goes: on a clip, on a track of sound, or on the master of the timeline.
 * Exactly one of them.
 */
export const EffectTarget = {
  clip: Id.optional(),
  /** A track of sound: its effects work on all of it, before its volume. */
  track: Id.optional(),
  /** The master of the timeline: its effects work on everything, before the safe limiter. */
  master: z.literal(true).optional(),
};

const ONE_TARGET = "要写 clip、track 或 master 其中一个";

const oneTarget = (params: {
  clip?: string | undefined;
  track?: string | undefined;
  master?: true | undefined;
}) =>
  [params.clip, params.track, params.master].filter((value) => value !== undefined).length === 1;

/**
 * What has effects: a clip, whose effects sit flat (see structure.ts), or a track of sound or the
 * master, which keep theirs as one list, as files do. Their parameters are properties of it either
 * way, `effect.<id>.<parameter>`.
 */
interface Host {
  readonly kind: "clip" | "track" | "master";
  /** What it says in failures: the clip, the track or "master". */
  readonly id: string;
  readonly media: EffectMedia;
  readonly effects: readonly ClipEffect[];
  readonly properties: Properties | undefined;
  readonly clip?: ClipState;
}

function clipOf(draft: Draft, timeline: string, id: string): ClipState {
  return entryOf(timelineOf(draft, timeline).clips, id) ?? fail("not-found", { kind: "clip", id });
}

/** What effects a clip takes: those of sound on tracks of sound, those of pictures elsewhere. */
function clipMedia(draft: Draft, timeline: string, clip: ClipState): EffectMedia {
  const track = entryOf(timelineOf(draft, timeline).tracks, clip.track);
  return track?.kind === "audio" ? "sound" : "picture";
}

function hostOf(
  draft: Draft,
  timeline: string,
  target: { clip?: string | undefined; track?: string | undefined; master?: true | undefined },
): Host {
  const state = timelineOf(draft, timeline);
  if (target.clip !== undefined) {
    const clip = clipOf(draft, timeline, target.clip);
    return {
      kind: "clip",
      id: clip.id,
      media: clipMedia(draft, timeline, clip),
      effects: effectsOf(clip),
      properties: clip.properties,
      clip,
    };
  }
  if (target.track !== undefined) {
    const track =
      entryOf(state.tracks, target.track) ?? fail("not-found", { kind: "track", id: target.track });
    if (track.kind !== "audio") fail("wrong-track", { trackKind: track.kind, holds: "effect" });
    return {
      kind: "track",
      id: track.id,
      media: "sound",
      effects: track.kind === "audio" ? (track.effects ?? []) : [],
      properties: track.kind === "audio" ? track.properties : undefined,
    };
  }
  const master = state.mix?.master;
  return {
    kind: "master",
    id: "master",
    media: "sound",
    effects: master?.effects ?? [],
    properties: master?.properties,
  };
}

/** A whole effect of what has it. */
function effectIn(host: Host, id: string): ClipEffect {
  return (
    host.effects.find((effect) => effect.id === id) ??
    fail("not-found", { kind: "effect", id, ...(host.kind === "clip" && { clip: host.id }) })
  );
}

/**
 * Writes a list of effects and parameters of a track or the master: the list is one value, as in
 * files. `properties` are the changes to its properties, undefined for those that go.
 */
function writeList(
  draft: Draft,
  timeline: string,
  host: Host,
  effects: readonly ClipEffect[],
  properties: ReadonlyMap<string, PropertyValue | undefined> = new Map(),
): void {
  if (host.kind === "track") {
    const path = trackPath(timeline, host.id);
    if (effects.length === 0) draft.delete([...path, "effects"]);
    else draft.set([...path, "effects"], effects);
    for (const [property, value] of properties) {
      if (value === undefined) draft.delete([...path, "properties", property]);
      else draft.set([...path, "properties", property], value);
    }
    return;
  }
  updateMaster(draft, timeline, (master) => {
    const changed: Record<string, PropertyValue> = { ...master.properties };
    for (const [property, value] of properties) {
      if (value === undefined) delete changed[property];
      else changed[property] = value;
    }
    const { effects: _effects, properties: _properties, ...rest } = master;
    return {
      ...rest,
      ...(Object.keys(changed).length > 0 && { properties: sortedProperties(changed) }),
      ...(effects.length > 0 && { effects: [...effects] }),
    };
  });
}

const sortedProperties = (properties: Record<string, PropertyValue>) =>
  Object.fromEntries(
    Object.entries(properties).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * Changes the master of a timeline: the mix is one value, as in files, so it gets written whole.
 * A master with nothing in it goes, and a mix with nothing in it too.
 */
export function updateMaster(
  draft: Draft,
  timeline: string,
  change: (master: Master) => Master,
): void {
  const mix = timelineOf(draft, timeline).mix ?? {};
  const master = change(mix.master ?? {});
  const { master: _master, ...rest } = mix;
  const next: Mix = { ...rest, ...(Object.keys(master).length > 0 && { master }) };
  if (Object.keys(next).length === 0) draft.delete(mixPath(timeline));
  else draft.set(mixPath(timeline), next);
}

/** Whether an effect can go where it would: those of sound on sound, those of pictures on pictures. */
function checkMedia(host: Host, type: string): void {
  const found = findEffect(type, host.media);
  if (found.kind === "missing" && found.why.reason === "media") {
    if (host.kind === "clip") {
      fail("wrong-track", {
        trackKind: host.media === "sound" ? "audio" : "video",
        holds: "effect",
        media: host.media === "sound" ? "picture" : "sound",
      });
    }
    fail("wrong-target", {
      path: type,
      target: host.kind === "master" ? "master" : "track",
      ...(host.kind === "track" && { track: host.id, kind: "audio" }),
      takes: SOUND_EFFECT_TYPES,
    });
  }
}

/** The effects of sound, which is all that tracks and the master take. */
const SOUND_EFFECT_TYPES = Object.entries(BUILT_IN_EFFECTS)
  .filter(([, spec]) => spec.media.includes("sound"))
  .map(([type]) => type);

/** What an effect is, for one that people or AI put somewhere: it has to be one this editor has. */
function specOf(type: string, media: EffectMedia): EffectSpec {
  const found = findEffect(type, media);
  return found.kind === "built-in"
    ? found.spec
    : fail("not-found", { kind: "effect", id: type, why: found.why });
}

/** Only clips have a stretch that an effect works in: for the rest it would do nothing. */
function checkStretch(host: Host, start: unknown, end: unknown): void {
  if (host.kind === "clip") return;
  for (const [field, value] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (value !== undefined && value !== null) {
      fail("not-applicable", { field, target: host.kind });
    }
  }
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
export function checkEffectWrite(
  clip: ClipState,
  path: string,
  value: PropertyValue,
  media: EffectMedia = "picture",
): void {
  const of = effectOfPath(path);
  if (!of) return;
  const effect = entryOf(clip.effects, of.effect);
  if (!effect || typeof effect.type !== "string") {
    fail("not-found", { kind: "effect", id: of.effect, clip: clip.id });
  }
  checkListedWrite(effectsOf(clip), path, value, media, clip.id);
}

/**
 * The same for a track or the master, whose effects are a list: a parameter of one that is not
 * there is not found.
 */
export function checkListedWrite(
  effects: readonly ClipEffect[],
  path: string,
  value: PropertyValue,
  media: EffectMedia,
  clip?: string,
): void {
  const of = effectOfPath(path);
  if (!of) return;
  const effect =
    effects.find(({ id }) => id === of.effect) ??
    fail("not-found", { kind: "effect", id: of.effect, ...(clip !== undefined && { clip }) });
  const found = findEffect(effect.type, media);
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

/**
 * Puts an effect on a clip, a track of sound or the master, last unless it says where, with what its
 * parameters start with.
 */
export const EffectAdd = z
  .strictObject({
    timeline: Id,
    ...EffectTarget,
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
     * works from the start of the clip, without `end` up to its end, as long as the clip is. Only
     * clips have it.
     */
    start: Time.optional(),
    end: Time.optional(),
  })
  .refine(oneTarget, ONE_TARGET);

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

/** Where an effect goes in a list, from 0, within it. */
const placeIn = (length: number, index: number | undefined) =>
  index === undefined ? length : Math.min(index, length);

export function addEffect(draft: Draft, params: z.output<typeof EffectAdd>): { id: string } {
  const { timeline, type, enabled, index, values, start, end } = params;
  const host = hostOf(draft, timeline, params);
  checkMedia(host, type);
  const spec = specOf(type, host.media);
  checkStretch(host, start, end);
  if (host.clip) checkRange(host.clip, start, end);
  const id = params.id ?? newId("fx");
  if (host.effects.some((effect) => effect.id === id) || entryOf(host.clip?.effects, id)) {
    fail("id-taken", { kind: "effect", id, by: "effect" });
  }
  for (const [parameter, value] of Object.entries(values ?? {})) {
    checkParameter(spec, parameter, value);
  }
  const { clip } = host;
  if (clip) {
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
  const list = [...host.effects];
  list.splice(placeIn(list.length, index), 0, {
    id,
    type,
    ...(enabled === false ? { enabled } : {}),
  });
  const properties = new Map<string, PropertyValue | undefined>(
    Object.entries(values ?? {}).map(([parameter, value]) => [effectPath(id, parameter), value]),
  );
  writeList(draft, timeline, host, list, properties);
  return { id };
}

/** Takes effects off a clip, a track or the master, with all they took, also in versions. */
export const EffectRemove = z
  .strictObject({
    timeline: Id,
    ...EffectTarget,
    effects: z.array(Id).min(1),
  })
  .refine(oneTarget, ONE_TARGET);

export function removeEffects(draft: Draft, params: z.output<typeof EffectRemove>): void {
  const { timeline } = params;
  const host = hostOf(draft, timeline, params);
  const { clip } = host;
  if (clip) {
    // What only some of is there goes too: that is no effect, see `EffectState`.
    for (const id of params.effects) {
      if (!entryOf(clip.effects, id)) fail("not-found", { kind: "effect", id, clip: clip.id });
    }
    dropEffects(draft, timeline, clip, params.effects);
    return;
  }
  for (const id of params.effects) effectIn(host, id);
  const gone = new Set(params.effects);
  const properties = new Map<string, PropertyValue | undefined>();
  for (const path of Object.keys(host.properties ?? {})) {
    const of = effectOfPath(path);
    if (of && gone.has(of.effect)) properties.set(path, undefined);
  }
  writeList(
    draft,
    timeline,
    host,
    host.effects.filter(({ id }) => !gone.has(id)),
    properties,
  );
}

/** Moves an effect to another place in its list, which changes what it works on. */
export const EffectMove = z
  .strictObject({
    timeline: Id,
    ...EffectTarget,
    effect: Id,
    /** Where it goes, from 0, in the list without it. */
    index: z.number().int().min(0),
  })
  .refine(oneTarget, ONE_TARGET);

export function moveEffect(draft: Draft, params: z.output<typeof EffectMove>): void {
  const { timeline, index } = params;
  const host = hostOf(draft, timeline, params);
  const moving = effectIn(host, params.effect);
  if (host.effects.findIndex(({ id }) => id === params.effect) === index) return;
  const { clip } = host;
  if (clip) {
    draft.set(
      [...effectsPath(timeline, clip.id), params.effect, "order"],
      orderAt(clip, index, params.effect),
    );
    return;
  }
  const list = host.effects.filter(({ id }) => id !== params.effect);
  list.splice(placeIn(list.length, index), 0, moving);
  writeList(draft, timeline, host, list);
}

/**
 * Turns an effect on or off, and changes when it works. Off, it does nothing, and keeps its place
 * and its values. `start` and `end` are from the start of the clip, within it, and only clips have
 * them; null takes one away, which is the start or the end of the clip, as long as it is. What is
 * left out stays as it is.
 */
export const EffectUpdate = z
  .strictObject({
    timeline: Id,
    ...EffectTarget,
    effect: Id,
    enabled: z.boolean().optional(),
    start: Time.nullable().optional(),
    end: Time.nullable().optional(),
  })
  .refine(oneTarget, ONE_TARGET)
  .refine(
    ({ enabled, start, end }) => enabled !== undefined || start !== undefined || end !== undefined,
    "要写 enabled、start 或 end",
  );

export function updateEffect(draft: Draft, params: z.output<typeof EffectUpdate>): void {
  const { timeline, enabled } = params;
  const host = hostOf(draft, timeline, params);
  const effect = effectIn(host, params.effect);
  checkStretch(host, params.start, params.end);
  const { clip } = host;
  if (!clip) {
    if (enabled === undefined || (effect.enabled !== false) === enabled) return;
    const list = host.effects.map((each) => {
      if (each.id !== effect.id) return each;
      const { enabled: _enabled, ...rest } = each;
      // On is what an effect is without saying so.
      return enabled ? rest : { ...rest, enabled: false };
    });
    writeList(draft, timeline, host, list);
    return;
  }
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
