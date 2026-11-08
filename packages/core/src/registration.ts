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
   * The code got through everything that registers without an error, and all of it fits. Only then
   * is a channel that nothing registered one that lost its object: an error halfway through, or a
   * frame that did not run yet, would leave out what comes after it.
   */
  readonly complete: boolean;
  /**
   * The parameters code read before it was done registering, with what the clip held for each of
   * them then, as JSON: `null` when it held nothing. What code registers can depend on them, so this
   * is only all there is for a clip that holds the same.
   */
  readonly params: Readonly<Record<string, string>>;
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
  /** Two parts of a vector with one name. */
  | "object-components"
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
  name: 200,
  /** What a default of `text` can be. */
  textValue: 10000,
  /** What a default of `numbers` can have. */
  numbers: 4096,
  unit: 16,
  /** Paths a property can find keys under from before, all its aliases and those of its object. */
  aliasPaths: 16,
  /** Parameters a registration can go by, and how much of them as JSON. */
  params: 64,
  paramsText: 64 * 1024,
  /**
   * How long a registration is as JSON, which is how it travels. 10000 properties with the usual
   * fields take about 900000 characters, so this leaves room for long names.
   */
  text: 1_500_000,
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

/**
 * Where the keys of a property of code can be from before, in the order they count: under its own
 * aliases, then under the ids its object went by. Ids that other objects have now are not its own
 * any more. There are only so many, so that aliases cannot make a description grow without end.
 */
export function aliasPathsOf(
  object: Pick<ObjectDescriptor, "id" | "aliases">,
  spec: Pick<PropertySpec, "path" | "aliases">,
  taken?: ReadonlySet<string>,
): readonly string[] {
  const own = spec.aliases ?? [];
  const paths: string[] = [];
  const add = (path: string) => {
    if (paths.length < REGISTRATION_LIMITS.aliasPaths && !paths.includes(path)) paths.push(path);
  };
  for (const alias of own) add(objectPath(object.id, alias));
  for (const was of object.aliases ?? []) {
    if (taken?.has(was)) continue;
    add(objectPath(was, spec.path));
    for (const alias of own) add(objectPath(was, alias));
  }
  return paths;
}

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
function textOf(value: unknown, limit: number = REGISTRATION_LIMITS.name): string | undefined {
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
      return numbersIn(value);
    }
  }
}

/**
 * Every place of a list, holes included: `every` and `map` go past those, and a list with a hole is
 * no list of numbers.
 */
function numbersIn(list: readonly unknown[]): number[] | undefined {
  const numbers: number[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index];
    if (!finite(value)) return undefined;
    numbers.push(value);
  }
  return numbers;
}

function readOptions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: string[] = [];
  for (const option of value.slice(0, REGISTRATION_LIMITS.options)) {
    const text = typeof option === "string" ? option.slice(0, REGISTRATION_LIMITS.name) : undefined;
    if (text !== undefined && text !== "" && !options.includes(text)) options.push(text);
  }
  return options.length > 0 ? options : undefined;
}

/** The names of the parts of a vector: as many as it has, each one of its own, or the usual ones. */
function readComponents(
  type: ValueType,
  value: unknown,
  report: () => void,
): readonly string[] | undefined {
  const length = VECTOR_LENGTHS[type];
  if (length === undefined) return undefined;
  const usual = VECTOR_COMPONENTS.slice(0, length);
  if (value === undefined) return usual;
  const names: string[] = [];
  if (Array.isArray(value) && value.length === length) {
    // A loop and not `map`, which goes past holes.
    for (let index = 0; index < length; index += 1) {
      const name = textOf(value[index], 16);
      if (name === undefined || names.includes(name)) break;
      names.push(name);
    }
  }
  if (names.length === length) return names;
  report();
  return usual;
}

/** What a parameter of `scene.json` can be: the schema only says that it is some value. */
interface DeclaredParam {
  readonly type: string;
  readonly default?: unknown;
  readonly options?: readonly string[] | undefined;
}

/** The default of a parameter, as far as it is a value of its type. */
export function paramDefault(param: DeclaredParam): Value | undefined {
  if (param.default === undefined || !VALUE_TYPES.has(param.type)) return undefined;
  // Words can also be a reference to the string tables of the project.
  const { default: given } = param;
  if (param.type === "text" && typeof field(given, "string") === "string") {
    return { string: field(given, "string") as string };
  }
  return readValue(param.type as ValueType, given, param.options);
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
  const components = readComponents(valueType, field(raw, "components"), () =>
    report("object-components", where),
  );
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
    report("object-id", typeof id === "string" ? id.slice(0, REGISTRATION_LIMITS.name) : undefined);
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
  // An alias that is a path of the object itself would read the keys of another property.
  for (const [index, spec] of properties.entries()) {
    const own = spec.aliases?.filter((alias) => !paths.has(alias));
    if (!spec.aliases || own?.length === spec.aliases.length) continue;
    report("object-alias", `${id}.${spec.path}`);
    const { aliases: _aliases, ...rest } = spec;
    properties[index] = (own && own.length > 0 ? { ...rest, aliases: own } : rest) as PropertySpec;
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

const PARAM_PATH = /^param\.([^.]+)$/;

/**
 * The parameters a registration went by, as JSON. They only serve to compare with what a clip holds,
 * so nothing else is read of them. What does not make sense takes away the right to say that the
 * registration is all there is, because there is no telling which clips it goes for.
 */
function readParams(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const params: Record<string, string> = {};
  let size = 0;
  let count = 0;
  for (const [path, value] of Object.entries(raw)) {
    count += 1;
    if (count > REGISTRATION_LIMITS.params || !isIdPart(PARAM_PATH.exec(path)?.[1]))
      return undefined;
    let text: string | undefined;
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      return undefined;
    }
    size += path.length + (text?.length ?? 0);
    if (text === undefined || size > REGISTRATION_LIMITS.paramsText) return undefined;
    params[path] = text;
  }
  return params;
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
  // Whatever got left out may be what a key is about, so nothing can be said about what is missing.
  let cut = false;
  const cutting: Report = (code, target) => {
    if (code === "object-too-many") cut = true;
    report(code, target);
  };
  if (objects.length > maxObjects) cutting("object-too-many", "objects");
  for (const entry of objects.slice(0, maxObjects)) {
    if (room <= 0) {
      cutting("object-too-many", "properties");
      break;
    }
    const object = readObject(entry, cutting, room);
    if (!object) continue;
    if (ids.has(object.id)) {
      report("object-twice", object.id);
      continue;
    }
    ids.add(object.id);
    room -= object.properties.length;
    read.push(object);
  }
  withoutTakenAliases(read, ids, report);
  const found: SceneElement[] = [];
  const elementIds = new Set<string>();
  if (elements.length > maxElements) cutting("object-too-many", "elements");
  for (const entry of elements.slice(0, maxElements)) {
    const element = readElement(entry);
    if (!element || elementIds.has(element.id)) continue;
    elementIds.add(element.id);
    found.push(element);
  }
  const params = readParams(field(raw, "params"));
  const complete = field(raw, "complete") === true && !cut && params !== undefined;
  return {
    registration: { objects: read, elements: found, complete, params: params ?? {} },
    problems,
  };
}

/**
 * An object cannot have gone by the id of another one that is there: the keys under it belong to
 * that one. Such an alias is left out, and people hear about it.
 */
function withoutTakenAliases(
  objects: ObjectDescriptor[],
  ids: ReadonlySet<string>,
  report: Report,
): void {
  for (const [index, object] of objects.entries()) {
    const { aliases } = object;
    const free = aliases?.filter((alias) => !ids.has(alias));
    if (!aliases || free?.length === aliases.length) continue;
    report("object-alias", object.id);
    const { aliases: _aliases, ...rest } = object;
    objects[index] = free && free.length > 0 ? { ...rest, aliases: free } : rest;
  }
}

/**
 * A registration the way it travels, as JSON: that is what keeps what a message weighs close to
 * what it holds. Undefined for what is too long, or no registration.
 */
export function readRegistrationText(text: unknown): ReadRegistration | undefined {
  if (typeof text !== "string" || text.length > REGISTRATION_LIMITS.text) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return readRegistration(raw);
}
