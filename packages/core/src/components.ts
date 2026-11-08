import {
  VECTOR_COMPONENTS,
  VECTOR_LENGTHS,
  isAnimation,
  type Animation,
  type Key,
  type PropertySpec,
  type PropertyValue,
  type Value,
} from "@animaquill/schema";

/**
 * The parts of a vector, each as a number of its own. A vector is one channel: all of its parts
 * share one set of keys, with one way of easing from each key to the next, and the handles of a key
 * are a share of the way from one value to the next, so they are the same for every part. A part
 * is a view of that channel: its keys are the keys of the vector at the same times, with the same
 * easing, and the number of that part as their value. What changes about a part goes back into the
 * vector, where only that one number is different.
 */

/** What the parts of a vector are called: as its description says, or else x, y, z and w. */
export function componentsOf(spec: Pick<PropertySpec, "type" | "components">): readonly string[] {
  const length = VECTOR_LENGTHS[spec.type];
  if (spec.components) return spec.components;
  return length === undefined ? [] : VECTOR_COMPONENTS.slice(0, length);
}

const partSpecs = new WeakMap<PropertySpec, PropertySpec>();

/**
 * A part of a vector as a property of its own: a number in the same units and range. The same
 * object for the same vector, as controls like it.
 */
export function componentSpecOf(spec: PropertySpec): PropertySpec {
  const known = partSpecs.get(spec);
  if (known) return known;
  const { path, unit, min, max, softMin, softMax } = spec;
  const part: PropertySpec = {
    path,
    type: "number",
    ...(unit === undefined ? {} : { unit }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(softMin === undefined ? {} : { softMin }),
    ...(softMax === undefined ? {} : { softMax }),
  };
  partSpecs.set(spec, part);
  return part;
}

const partOf = (value: Value | undefined, index: number): number | undefined => {
  const part = Array.isArray(value) ? (value as readonly unknown[])[index] : undefined;
  return typeof part === "number" && Number.isFinite(part) ? part : undefined;
};

/** Worked out once for the keys of a vector, because a screen of rows asks with every frame. */
const projected = new WeakMap<readonly Key[], (readonly Key[] | null)[]>();

/**
 * The keys of one part of a vector: the same keys with the number of that part as their value.
 * Undefined when one of them has no such number, which a hand-written project can have.
 */
export function componentKeys(keys: readonly Key[], index: number): readonly Key[] | undefined {
  let byIndex = projected.get(keys);
  if (!byIndex) projected.set(keys, (byIndex = []));
  const known = byIndex[index];
  if (known !== undefined) return known ?? undefined;
  let found: Key[] | null = [];
  for (const key of keys) {
    const value = partOf(key.value, index);
    if (value === undefined) {
      found = null;
      break;
    }
    found.push({ ...key, value });
  }
  byIndex[index] = found;
  return found ?? undefined;
}

const animations = new WeakMap<Animation, (Animation | null)[]>();

/**
 * One part of a vector, as a value of its own: a number, or keys of a number at the times of the
 * keys of the vector. The same object for the same keys, so that what is worked out from it once
 * stays. Undefined for what is not a vector with that part.
 */
export function componentOf(
  value: PropertyValue | undefined,
  index: number,
): PropertyValue | undefined {
  if (value === undefined) return undefined;
  if (!isAnimation(value)) return partOf(value, index);
  let byIndex = animations.get(value);
  if (!byIndex) animations.set(value, (byIndex = []));
  const known = byIndex[index];
  if (known !== undefined) return known ?? undefined;
  const keys = componentKeys(value.keys, index);
  // Nothing changes keys in place: a change is a new list.
  const found = keys ? { ...value, keys: keys as Key[] } : null;
  byIndex[index] = found;
  return found ?? undefined;
}

/** A vector with one number changed, and the others as they are. */
export function withComponent(vector: Value, index: number, part: number): Value {
  if (!Array.isArray(vector)) return vector;
  return (vector as readonly number[]).map((value, at) => (at === index ? part : value));
}

/**
 * A key of a vector with what changed about the key of one of its parts: where it is, how it eases
 * and its handles go for all of the parts, and the number only for that part.
 */
export function keyWithComponent(vectorKey: Key, partKey: Key, index: number): Key {
  const part = typeof partKey.value === "number" ? partKey.value : partOf(vectorKey.value, index);
  const value = part === undefined ? vectorKey.value : withComponent(vectorKey.value, index, part);
  return { ...partKey, value };
}
