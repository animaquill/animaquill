import {
  COLOR_PATTERN,
  ELEMENT_PROPERTIES,
  VECTOR_COMPONENTS,
  VECTOR_LENGTHS,
  type ObjectDescriptor,
  type PropertySpec,
  type ValueType,
} from "@animaquill/schema/properties";
import type { Value } from "@animaquill/schema";
import { accepts } from "./curve.ts";

/**
 * What the code of a scene says about itself when it runs: the objects it registered with
 * `aq.object`, and the elements of its page that have a stable id. It comes out of a sandbox, so
 * everything here is read as data that can be anything, and only what makes sense gets through,
 * cut down to a size the editor can handle. The scene runtime reads its own registrations the same
 * way, so that people hear about a mistake where they made it. Nothing here may bring in Yjs or Zod:
 * the scene runtime loads this.
 */

/** An element of the page of a scene that has a stable id. */
export interface SceneElement {
  readonly id: string;
  readonly kind: "html" | "svg";
  /** What the page gives it to start with, for what has no fixed default, such as its color. */
  readonly start?: Readonly<Record<string, Value>>;
}

export interface Registration {
  /** What `aq.object` registered, in order. Property paths are within their object. */
  readonly objects: readonly ObjectDescriptor[];
  readonly elements: readonly SceneElement[];
  /**
   * The scene got through loading without an error. Only then is a channel that nothing registered
   * one that lost its object: an error halfway through would leave everything after it out.
   */
  readonly complete: boolean;
}

/** Each of these is a code of a problem of the scene too, so they say what they are about. */
export type RegistrationProblemCode =
  /** An id of an object that is no id. */
  | "object-id"
  /** A second object with an id that is there already. The first one counts. */
  | "object-twice"
  | "object-parent"
  | "object-spans"
  | "object-presence"
  | "object-alias"
  /** A property that is not there: its name, its type or its options make no sense. */
  | "object-property"
  | "object-default"
  | "object-range"
  | "object-property-twice"
  /** More than there is room for. What came first stays. */
  | "object-too-many";

export interface RegistrationProblem {
  readonly code: RegistrationProblemCode;
  /** What it is about: an id, or an object and a property, as `arm.rotation`. */
  readonly target?: string;
}

/**
 * How much a scene can register. A skeleton of 300 bones with 4 properties each is 1200 of them,
 * and more than this would only slow the list down: it comes from code nobody has to trust.
 */
export const REGISTRATION_LIMITS = {
  objects: 2000,
  properties: 10000,
  propertiesPerObject: 256,
  elements: 1000,
  spans: 64,
  aliases: 16,
  options: 100,
  /** Parts of an id, as in `rig.arm_l`, and how long one is. */
  idParts: 16,
  idPart: 64,
  /** Names and groups, which only show. */
  text: 200,
  /** What a default of `text` can be. */
  textValue: 10000,
  /** What a default of `numbers` can have. */
  numbers: 4096,
  unit: 16,
} as const;

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Names that mean something to a JavaScript object: the content of a project is not trusted. */
const RESERVED = new Set(["constructor", "prototype"]);

/** One part of a path: what an id can be. */
export const isIdPart = (text: unknown): text is string =>
  typeof text === "string" &&
  text.length <= REGISTRATION_LIMITS.idPart &&
  ID_PART.test(text) &&
  !RESERVED.has(text);

/** An id of an object, which can have parts: `rig.arm_l` is a bone of a skeleton. */
export function isObjectId(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const { idParts, idPart } = REGISTRATION_LIMITS;
  if (text.length > idParts * (idPart + 1)) return false;
  const parts = text.split(".");
  return parts.length <= idParts && parts.every(isIdPart);
}

/** The paths of what scenes say about themselves. Nothing else in a clip starts like these. */
export const objectPath = (object: string, property: string) => `object.${object}.${property}`;
export const elementPath = (element: string, property: string) => `element.${element}.${property}`;
export const paramPath = (param: string) => `param.${param}`;

/** What a scene works out by itself, as opposed to the compositor: see `RenderLayer.content`. */
export const SCENE_PREFIXES = ["param.", "element.", "object."] as const;
export const isSceneOwned = (path: string): boolean =>
  SCENE_PREFIXES.some((prefix) => path.startsWith(prefix));

/** Paths that only code can describe, which an error halfway through can leave undescribed. */
export const isRegistered = (path: string): boolean =>
  path.startsWith("element.") || path.startsWith("object.");

const VALUE_TYPES: ReadonlySet<string> = new Set<ValueType>([
  "number",
  "angle",
  "text",
  "choice",
  "boolean",
  "asset",
  "color",
  "vec2",
  "vec3",
  "vec4",
  "numbers",
]);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, name: string): unknown =>
  isPlainObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Text that only shows, cut down to what anybody reads. */
function textOf(value: unknown, limit: number = REGISTRATION_LIMITS.text): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.slice(0, limit * 2).trim();
  return trimmed === "" ? undefined : trimmed.slice(0, limit);
}

/** What a value of a type is when nobody said: nothing, as far as that goes. */
export function zeroOf(type: ValueType, options?: readonly string[]): Value | undefined {
  switch (type) {
    case "number":
    case "angle":
      return 0;
    case "boolean":
      return false;
    case "text":
      return "";
    case "choice":
      return options?.[0];
    case "color":
      return "#000000";
    case "vec2":
    case "vec3":
    case "vec4":
      return Array.from({ length: VECTOR_LENGTHS[type] as number }, () => 0);
    case "numbers":
      return [];
    case "asset":
      return undefined;
  }
}

/**
 * A value of a type, out of anything, as a copy that owes nothing to where it came from. Undefined
 * when it is no such value.
 */
export function readValue(
  type: ValueType,
  value: unknown,
  options?: readonly string[],
): Value | undefined {
  switch (type) {
    case "number":
    case "angle":
      return finite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "text":
      return typeof value === "string" && value.length <= REGISTRATION_LIMITS.textValue
        ? value
        : undefined;
    case "choice":
      return typeof value === "string" && options?.includes(value) === true ? value : undefined;
    case "color":
      return typeof value === "string" && COLOR_PATTERN.test(value)
        ? value.toLowerCase()
        : undefined;
    case "asset": {
      const asset = field(value, "asset");
      return isIdPart(asset) ? { asset } : undefined;
    }
    case "vec2":
    case "vec3":
    case "vec4":
    case "numbers": {
      if (!Array.isArray(value) || value.length > REGISTRATION_LIMITS.numbers) return undefined;
      const length = VECTOR_LENGTHS[type];
      if (length !== undefined && value.length !== length) return undefined;
      return value.every(finite) ? [...value] : undefined;
    }
  }
}

function readOptions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: string[] = [];
  for (const option of value.slice(0, REGISTRATION_LIMITS.options)) {
    const text = typeof option === "string" ? option.slice(0, REGISTRATION_LIMITS.text) : undefined;
    if (text !== undefined && text !== "" && !options.includes(text)) options.push(text);
  }
  return options.length > 0 ? options : undefined;
}

function readComponents(type: ValueType, value: unknown): readonly string[] | undefined {
  const length = VECTOR_LENGTHS[type];
  if (length === undefined) return undefined;
  const given = Array.isArray(value) && value.length === length ? value.map((v) => textOf(v)) : [];
  const names = given.length === length && given.every((name) => name !== undefined);
  return names ? (given as string[]) : VECTOR_COMPONENTS.slice(0, length);
}

/** Ids a property or an object went by before. Only those that could be ids count. */
function readAliases(
  value: unknown,
  own: string,
  isValid: (text: unknown) => text is string,
  report: () => void,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    report();
    return undefined;
  }
  const aliases: string[] = [];
  for (const alias of value.slice(0, REGISTRATION_LIMITS.aliases + 1)) {
    if (!isValid(alias) || alias === own || aliases.length >= REGISTRATION_LIMITS.aliases) {
      report();
      continue;
    }
    if (!aliases.includes(alias)) aliases.push(alias);
  }
  return aliases.length > 0 ? aliases : undefined;
}

type Report = (code: RegistrationProblemCode, target?: string) => void;

/** One property of an object: its path is within the object, one part long. */
function readProperty(raw: unknown, object: string, report: Report): PropertySpec | undefined {
  const path = field(raw, "path");
  const type = field(raw, "type");
  const where = `${object}.${typeof path === "string" ? path.slice(0, 64) : "?"}`;
  if (!isIdPart(path) || typeof type !== "string" || !VALUE_TYPES.has(type)) {
    report("object-property", where);
    return undefined;
  }
  const valueType = type as ValueType;
  const options = valueType === "choice" ? readOptions(field(raw, "options")) : undefined;
  if (valueType === "choice" && !options) {
    report("object-property", where);
    return undefined;
  }
  const given = field(raw, "default");
  let fallback = given === undefined ? undefined : readValue(valueType, given, options);
  if (given !== undefined && fallback === undefined) report("object-default", where);
  fallback ??= zeroOf(valueType, options);
  const spec: Record<string, unknown> = { path, type: valueType };
  if (fallback !== undefined) spec.default = fallback;
  for (const [low, high] of [
    ["min", "max"],
    ["softMin", "softMax"],
  ] as const) {
    const from = field(raw, low);
    const to = field(raw, high);
    const known = (value: unknown) => value === undefined || finite(value);
    if (!known(from) || !known(to) || (finite(from) && finite(to) && from > to)) {
      report("object-range", where);
      continue;
    }
    if (from !== undefined) spec[low] = from;
    if (to !== undefined) spec[high] = to;
  }
  const unit = field(raw, "unit");
  if (typeof unit === "string" && /^[A-Za-z%]+$/.test(unit) && unit.length <= 16) spec.unit = unit;
  if (options) spec.options = options;
  if (field(raw, "animatable") === false) spec.animatable = false;
  const name = textOf(field(raw, "name"));
  if (name !== undefined) spec.name = name;
  const group = textOf(field(raw, "group"), 64);
  if (group !== undefined) spec.group = group;
  const components = readComponents(valueType, field(raw, "components"));
  if (components) spec.components = components;
  const aliases = readAliases(field(raw, "aliases"), path, isIdPart, () =>
    report("object-alias", where),
  );
  if (aliases) spec.aliases = aliases;
  return spec as unknown as PropertySpec;
}

function readSpans(raw: unknown, id: string, report: Report) {
  if (raw === undefined) return undefined;
  const spans: (readonly [number, number])[] = [];
  const list = Array.isArray(raw) ? raw.slice(0, REGISTRATION_LIMITS.spans + 1) : [];
  if (!Array.isArray(raw) || raw.length > REGISTRATION_LIMITS.spans) report("object-spans", id);
  for (const span of list.slice(0, REGISTRATION_LIMITS.spans)) {
    const [from, to] = Array.isArray(span) && span.length === 2 ? span : [];
    if (finite(from) && finite(to) && from < to) spans.push([from, to]);
    else report("object-spans", id);
  }
  return spans.length > 0 ? spans : undefined;
}

/**
 * One object as `aq.object` registers it. Its properties are in order, and whatever does not make
 * sense about one of them takes that one out, not the object. Undefined for an object without a
 * proper id, which nothing could ever find again.
 */
export function readObject(
  raw: unknown,
  report: Report,
  room: number = REGISTRATION_LIMITS.propertiesPerObject,
): ObjectDescriptor | undefined {
  const id = field(raw, "id");
  if (!isObjectId(id)) {
    report("object-id", typeof id === "string" ? id.slice(0, 200) : undefined);
    return undefined;
  }
  const given = field(raw, "properties");
  const list = Array.isArray(given) ? given : [];
  const limit = Math.min(REGISTRATION_LIMITS.propertiesPerObject, room);
  if (list.length > limit) report("object-too-many", id);
  const properties: PropertySpec[] = [];
  const paths = new Set<string>();
  for (const entry of list.slice(0, limit)) {
    const spec = readProperty(entry, id, report);
    if (!spec) continue;
    if (paths.has(spec.path)) {
      report("object-property-twice", `${id}.${spec.path}`);
      continue;
    }
    paths.add(spec.path);
    properties.push(spec);
  }
  const object: Record<string, unknown> = { id, properties };
  const name = textOf(field(raw, "name"));
  if (name !== undefined) object.name = name;
  const parent = field(raw, "parent");
  if (parent !== undefined) {
    if (isObjectId(parent) && parent !== id) object.parent = parent;
    else report("object-parent", id);
  }
  const spans = readSpans(field(raw, "spans"), id, report);
  if (spans) object.spans = spans;
  const presence = field(raw, "presence");
  if (presence !== undefined) {
    const spec = properties.find(({ path }) => path === presence);
    const says = spec?.type === "boolean" || spec?.type === "number";
    if (says) object.presence = presence;
    else report("object-presence", id);
  }
  const aliases = readAliases(field(raw, "aliases"), id, isObjectId, () =>
    report("object-alias", id),
  );
  if (aliases) object.aliases = aliases;
  return object as unknown as ObjectDescriptor;
}

/** One element, with what it starts out with where that is a value of the right type. */
export function readElement(raw: unknown): SceneElement | undefined {
  const id = field(raw, "id");
  const kind = field(raw, "kind");
  if (!isIdPart(id) || (kind !== "html" && kind !== "svg")) return undefined;
  const given = field(raw, "start");
  const start: Record<string, Value> = {};
  for (const spec of ELEMENT_PROPERTIES[kind]) {
    const value = readValue(spec.type, field(given, spec.path));
    const fits =
      value !== undefined &&
      accepts(spec.type, value) &&
      (typeof value !== "number" ||
        ((spec.min === undefined || value >= spec.min) &&
          (spec.max === undefined || value <= spec.max)));
    if (fits) start[spec.path] = value;
  }
  return Object.keys(start).length > 0 ? { id, kind, start } : { id, kind };
}

export interface ReadRegistration {
  readonly registration: Registration;
  readonly problems: readonly RegistrationProblem[];
}

/** The most problems one registration gets to report. Each one is said once anyway. */
const MAX_PROBLEMS = 100;

/**
 * Reads what a scene registered. What comes out is new data that only has what makes sense, and
 * every problem says what got left out. Undefined for what is no registration at all.
 */
export function readRegistration(raw: unknown): ReadRegistration | undefined {
  const objects = field(raw, "objects");
  const elements = field(raw, "elements");
  if (!Array.isArray(objects) || !Array.isArray(elements)) return undefined;
  const problems: RegistrationProblem[] = [];
  const seen = new Set<string>();
  const report: Report = (code, target) => {
    const key = `${code} ${target ?? ""}`;
    if (seen.has(key) || problems.length >= MAX_PROBLEMS) return;
    seen.add(key);
    problems.push(target === undefined ? { code } : { code, target });
  };
  const read: ObjectDescriptor[] = [];
  const ids = new Set<string>();
  let room: number = REGISTRATION_LIMITS.properties;
  const { objects: maxObjects, elements: maxElements } = REGISTRATION_LIMITS;
  if (objects.length > maxObjects) report("object-too-many", "objects");
  for (const entry of objects.slice(0, maxObjects)) {
    if (room <= 0) {
      report("object-too-many", "properties");
      break;
    }
    const object = readObject(entry, report, room);
    if (!object) continue;
    if (ids.has(object.id)) {
      report("object-twice", object.id);
      continue;
    }
    ids.add(object.id);
    room -= object.properties.length;
    read.push(object);
  }
  const found: SceneElement[] = [];
  const elementIds = new Set<string>();
  if (elements.length > maxElements) report("object-too-many", "elements");
  for (const entry of elements.slice(0, maxElements)) {
    const element = readElement(entry);
    if (!element || elementIds.has(element.id)) continue;
    elementIds.add(element.id);
    found.push(element);
  }
  const complete = field(raw, "complete") === true;
  return { registration: { objects: read, elements: found, complete }, problems };
}
