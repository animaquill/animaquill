import { EFFECT_OBJECT_TYPES } from "@animaquill/core";
import type { ObjectDescriptor, PropertySpec } from "@animaquill/schema";

/**
 * The groups of the properties tab that fold up, one title each: "变换", "不透明度", "速度",
 * "声音", the master, every other object by itself (a scene has its parameters and elements), and
 * every effect (see `effectSectionId`). What a clip of pictures has is split as Premiere has it:
 * where it is and how big, and how it shows on what is below. No DOM.
 */
export type SectionKind = "transform" | "opacity" | "speed" | "sound" | "master" | "object";

export interface PropertySection {
  /** Stable for clips of one kind, which is what folding up is remembered by. */
  readonly id: string;
  readonly kind: SectionKind;
  /** What it shows: the object, with only the properties of this group. */
  readonly object: ObjectDescriptor;
}

/** Which group of a clip's own picture a property goes in, by its path. */
function pictureGroupOf(path: string): "transform" | "opacity" | "speed" | undefined {
  if (path.startsWith("transform.") || path === "fit") return "transform";
  if (path === "opacity" || path === "blend") return "opacity";
  if (path === "time.speed" || path === "audio.pitch" || path === "audio.preservePitch")
    return "speed";
  return undefined;
}

const PICTURE_GROUPS = ["transform", "opacity", "speed"] as const;

/** An effect folds up by its type: the same for every clip of a kind that has one. */
export const effectSectionId = (type: string): string => `effect:${type}`;

/** Whether an object holds effects, or is one: those show in the list of effects. */
export const isEffectObject = (object: ObjectDescriptor): boolean =>
  object.type === EFFECT_OBJECT_TYPES.effects ||
  object.type?.startsWith(EFFECT_OBJECT_TYPES.prefix) === true;

/** The groups of what a clip has, apart from its effects, in the order they show. */
export function sectionsOf(objects: readonly ObjectDescriptor[]): readonly PropertySection[] {
  return objects.flatMap(sectionsOfObject);
}

const ofObject = new WeakMap<ObjectDescriptor, readonly PropertySection[]>();

/**
 * The groups of one object, the same objects for as long as it is the same: each row follows the
 * playhead, and a group that is new on every frame would draw all of its rows again.
 */
function sectionsOfObject(object: ObjectDescriptor): readonly PropertySection[] {
  const known = ofObject.get(object);
  if (known) return known;
  if (object.properties.length === 0 || isEffectObject(object)) return [];
  const sections: PropertySection[] = [];
  if (object.type === "clip.visual") {
    const rest: PropertySpec[] = [];
    const grouped = new Map<string, PropertySpec[]>();
    for (const spec of object.properties) {
      const group = pictureGroupOf(spec.path);
      if (group === undefined) rest.push(spec);
      else grouped.set(group, [...(grouped.get(group) ?? []), spec]);
    }
    for (const group of PICTURE_GROUPS) {
      const properties = grouped.get(group);
      if (properties) sections.push({ id: group, kind: group, object: { ...object, properties } });
    }
    // What nothing here knows, such as what a project writes itself, stays with its object.
    if (rest.length > 0) {
      sections.push({
        id: `object:${object.id}`,
        kind: "object",
        object: { ...object, properties: rest },
      });
    }
  } else if (object.type === "clip.sound") {
    sections.push({ id: "sound", kind: "sound", object });
  } else if (object.type === "mix.master") {
    sections.push({ id: "master", kind: "master", object });
  } else {
    sections.push({ id: `object:${object.id}`, kind: "object", object });
  }
  ofObject.set(object, sections);
  return sections;
}
