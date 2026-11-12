import type { Animation, PropertyValue, Value } from "./values.ts";

/**
 * What a value holds, which decides how it is checked, animated and edited. A color is `#rrggbb` or
 * `#rrggbbaa`. The vectors and `numbers` are lists of numbers: a vector has as many as it says, and
 * `numbers` any number of them.
 */
export type ValueType =
  | "number"
  | "angle"
  | "text"
  | "choice"
  | "boolean"
  | "asset"
  | "color"
  | "vec2"
  | "vec3"
  | "vec4"
  | "numbers";

/** How many numbers a vector has. */
export const VECTOR_LENGTHS: Readonly<Partial<Record<ValueType, number>>> = {
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

/** What the parts of a vector are called when its description does not say. */
export const VECTOR_COMPONENTS: readonly string[] = ["x", "y", "z", "w"];

/** `#rrggbb` or `#rrggbbaa`, the way colors are written everywhere in a project. */
export const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * One property that can take a value or keys. This is plain data, so that it can cross a sandbox and
 * be handed to an AI tool as it is. Built-in properties, effects, scene parameters and code objects
 * all describe themselves this way.
 */
export interface PropertySpec {
  /** Stable within its object, and free of display names. */
  readonly path: string;
  readonly type: ValueType;
  /**
   * What a clip without this property uses. Missing where nothing fixed can stand in: a clip box
   * without a size follows the stage or its media.
   */
  readonly default?: Value;
  readonly min?: number;
  readonly max?: number;
  /** The range a control suggests while dragging. Not a check. */
  readonly softMin?: number;
  readonly softMax?: number;
  /** For showing and converting: world, deg, ratio, db, semitone, m. */
  readonly unit?: string;
  /** For choices. */
  readonly options?: readonly string[];
  /** False for what cannot have keys, such as a parameter that rebuilds the content. */
  readonly animatable?: boolean;
  /** Built-in properties find their name in the interface texts by path. */
  readonly name?: string;
  /** One level of grouping within an object. Deeper levels are child objects. */
  readonly group?: string;
  /** The name of every component of a vector. */
  readonly components?: readonly string[];
  /** Paths this property went by before. */
  readonly aliases?: readonly string[];
}

/** A set of properties inside something that stores curves, such as the transform of a clip. */
export interface ObjectDescriptor {
  /** Stable within its owner. The hierarchy is not part of it, so a new parent changes no path. */
  readonly id: string;
  readonly name?: string;
  /** A built-in kind of object brings its own properties and handles. */
  readonly type?: string;
  /** Only decides the place in the property tree. */
  readonly parent?: string;
  /** Ids this object went by before, so that the keys of a renamed object still count. */
  readonly aliases?: readonly string[];
  /** When it exists, in seconds on the clock of the clip. Missing means as long as the clip. */
  readonly spans?: readonly (readonly [number, number])[];
  /** A property that says whether it exists right now. */
  readonly presence?: string;
  /** In the order of the property tree. */
  readonly properties: readonly PropertySpec[];
}

type Described = Omit<PropertySpec, "path">;

const ratio = { type: "number", min: 0, max: 1, unit: "ratio" } as const;
const world = { type: "number", unit: "world" } as const;
const anchor = { type: "number", unit: "ratio", default: 0.5, softMin: 0, softMax: 1 } as const;
const size = { ...world, min: 0 } as const;

const DESCRIBED: Readonly<Record<string, Described>> = {
  /** Where the anchor is in the world: 0, 0 is the middle of the stage, and y goes down. */
  "transform.x": { ...world, default: 0, group: "position" },
  "transform.y": { ...world, default: 0, group: "position" },
  /** The size of the clip box. Without one the box follows the stage or the media. */
  "transform.width": { ...size, group: "size" },
  "transform.height": { ...size, group: "size" },
  /** Which point of the box sits at x and y, as a share of the box. */
  "transform.anchorX": { ...anchor, group: "anchor" },
  "transform.anchorY": { ...anchor, group: "anchor" },
  "transform.scale": { type: "number", unit: "ratio", default: 1 },
  /** Clockwise, and it does not wrap around: 720 is two turns. */
  "transform.rotation": { type: "angle", unit: "deg", default: 0 },
  opacity: { ...ratio, default: 1 },
  /** Decides how a clip box comes about, which is not something to change halfway through. */
  fit: {
    type: "choice",
    default: "contain",
    options: ["cover", "contain", "fixed"],
    animatable: false,
  },
  /** How the picture of the clip goes onto what is below it, see the project format. */
  blend: {
    type: "choice",
    default: "normal",
    options: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add"],
  },
  /** Playback speed: 2 is twice as fast. Keys on it make a speed ramp. */
  "time.speed": { type: "number", default: 1, min: 0 },
  /** 0 leaves the sound as it is. */
  "audio.volume": { type: "number", unit: "db", default: 0, max: 24 },
  "audio.pan": { type: "number", default: 0, min: -1, max: 1 },
  "audio.pitch": { type: "number", unit: "semitone", default: 0 },
  "audio.preservePitch": { type: "boolean", default: false },
};

/** The properties of clips and tracks that the editor itself knows, by path. */
export const BUILT_IN_PROPERTIES: Readonly<Record<string, PropertySpec>> = Object.fromEntries(
  Object.entries(DESCRIBED).map(([path, spec]) => [path, { path, ...spec }]),
);

/** Whether a property changes over time. A list of numbers is a value, and it has `keys` too. */
export const isAnimation = (value: PropertyValue): value is Animation =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "keys" in value;

/** Whether a property holds keys that its kind cannot have. */
export const cannotHaveKeys = (path: string, value: PropertyValue): boolean =>
  isAnimation(value) &&
  Object.hasOwn(BUILT_IN_PROPERTIES, path) &&
  BUILT_IN_PROPERTIES[path]?.animatable === false;

/** Only what the compositor really does belongs here: a control without an effect helps nobody. */
const VISUAL_PATHS = [
  "transform.x",
  "transform.y",
  "transform.width",
  "transform.height",
  "transform.anchorX",
  "transform.anchorY",
  "transform.scale",
  "transform.rotation",
  "opacity",
  "blend",
  "fit",
];

/** Where a clip with a picture sits in the world and how it shows. */
export const CLIP_VISUAL: ObjectDescriptor = {
  id: "visual",
  type: "clip.visual",
  properties: VISUAL_PATHS.map((path) => BUILT_IN_PROPERTIES[path] as PropertySpec),
};

/** A scene is laid out for its box, whatever size that is, so nothing has to fit in it. */
export const SCENE_VISUAL: ObjectDescriptor = {
  ...CLIP_VISUAL,
  properties: CLIP_VISUAL.properties.filter(({ path }) => path !== "fit"),
};

/**
 * What a clip made by code sounds like. Only the volume does anything yet, and it has one value for
 * a whole clip: keys on sound come later.
 */
export const CLIP_SOUND: ObjectDescriptor = {
  id: "sound",
  type: "clip.sound",
  properties: [{ ...(BUILT_IN_PROPERTIES["audio.volume"] as PropertySpec), animatable: false }],
};

/**
 * What an element of a scene with a stable id offers, by `element.<id>.<path>`. Without a value the
 * element stays as its page has it, so colors have no default: the scene says what it starts with.
 * The position moves the element from where its page puts it, and turning and scaling go around the
 * middle of it.
 */
const ELEMENT_DESCRIBED: Readonly<Record<string, Described>> = {
  x: { ...world, default: 0, group: "position" },
  y: { ...world, default: 0, group: "position" },
  scale: { type: "number", unit: "ratio", default: 1 },
  rotation: { type: "angle", unit: "deg", default: 0 },
  opacity: { ...ratio, default: 1 },
  /** How far it gets blurred, in world units. */
  blur: { ...world, default: 0, min: 0 },
  color: { type: "color" },
  background: { type: "color" },
  fill: { type: "color" },
  stroke: { type: "color" },
};

const elementSpecs = (paths: readonly string[]): readonly PropertySpec[] =>
  paths.map((path) => ({ path, ...(ELEMENT_DESCRIBED[path] as Described) }));

/** What HTML and SVG elements offer, with paths of their own: see `ELEMENT_DESCRIBED`. */
export const ELEMENT_PROPERTIES: Readonly<Record<"html" | "svg", readonly PropertySpec[]>> = {
  html: elementSpecs(["x", "y", "scale", "rotation", "opacity", "blur", "color", "background"]),
  svg: elementSpecs(["x", "y", "scale", "rotation", "opacity", "fill", "stroke"]),
};

/**
 * Properties that are not built in but come from the content of a clip, or from its effects: those
 * of an effect are `effect.<id>.<parameter>`, see effects.ts.
 */
export const OPEN_PROPERTY_PREFIXES = [
  "param.",
  "object.",
  "element.",
  "caption.",
  "effect.",
] as const;

/**
 * Built-in properties that the format had once and has no more: cropping is an effect now. A file
 * that still has them opens without them, see the project format.
 */
export const RETIRED_PROPERTIES: readonly string[] = [
  "crop.left",
  "crop.top",
  "crop.right",
  "crop.bottom",
];

export const isKnownProperty = (path: string): boolean =>
  Object.hasOwn(BUILT_IN_PROPERTIES, path) ||
  OPEN_PROPERTY_PREFIXES.some((prefix) => path.startsWith(prefix));

/** What is wrong with a plain value of a built-in property, or undefined when it is fine. */
export function propertyValueProblem(path: string, value: unknown): string | undefined {
  if (!Object.hasOwn(BUILT_IN_PROPERTIES, path)) return undefined;
  return specValueProblem(BUILT_IN_PROPERTIES[path] as PropertySpec, value, path);
}

/**
 * What is wrong with a plain value for a description, said about `path`: what it has to be, as data,
 * so that whoever tells about it says it in their own words. See `describeValueIssue`.
 */
export type ValueIssue =
  | {
      readonly rule: "type";
      readonly path: string;
      readonly expects: "number" | "boolean" | "text" | "asset" | "color" | "numbers";
      /** How many numbers, for vectors. */
      readonly length?: number;
    }
  | { readonly rule: "min"; readonly path: string; readonly min: number }
  | { readonly rule: "max"; readonly path: string; readonly max: number }
  | { readonly rule: "choice"; readonly path: string; readonly options: readonly string[] };

/** What is wrong with a plain value for a description, said about `path`, or undefined. */
export function specValueIssue(
  spec: PropertySpec,
  value: unknown,
  path = spec.path,
): ValueIssue | undefined {
  switch (spec.type) {
    case "number":
    case "angle":
      if (typeof value !== "number") return { rule: "type", path, expects: "number" };
      if (spec.min !== undefined && value < spec.min) return { rule: "min", path, min: spec.min };
      if (spec.max !== undefined && value > spec.max) return { rule: "max", path, max: spec.max };
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : { rule: "type", path, expects: "boolean" };
    case "choice":
      return spec.options?.includes(value as string)
        ? undefined
        : { rule: "choice", path, options: spec.options ?? [] };
    case "text":
      return typeof value === "string" ? undefined : { rule: "type", path, expects: "text" };
    case "asset":
      return typeof value === "object" && !Array.isArray(value)
        ? undefined
        : { rule: "type", path, expects: "asset" };
    case "color":
      return typeof value === "string" && COLOR_PATTERN.test(value)
        ? undefined
        : { rule: "type", path, expects: "color" };
    case "vec2":
    case "vec3":
    case "vec4":
    case "numbers": {
      const length = VECTOR_LENGTHS[spec.type];
      const fits = Array.isArray(value) && (length === undefined || value.length === length);
      if (fits) return undefined;
      return { rule: "type", path, expects: "numbers", ...(length !== undefined && { length }) };
    }
  }
}

/** A value issue in words, for the problems of a project. */
export function describeValueIssue(issue: ValueIssue): string {
  const { path } = issue;
  switch (issue.rule) {
    case "min":
      return `${path} 不能小于 ${issue.min}`;
    case "max":
      return `${path} 不能大于 ${issue.max}`;
    case "choice":
      return `${path} 只能是：${issue.options.join("、")}`;
    case "type":
      switch (issue.expects) {
        case "number":
          return `${path} 要写成数字`;
        case "boolean":
          return `${path} 要写成 true 或 false`;
        case "text":
          return `${path} 要写成文字`;
        case "asset":
          return `${path} 要写成素材引用`;
        case "color":
          return `${path} 要写成 #rrggbb 或 #rrggbbaa`;
        case "numbers":
          return `${path} 要写成 ${issue.length ?? "一组"} 个数字`;
      }
  }
}

/** What is wrong with a plain value for a description, said about `path`, in words, or undefined. */
export function specValueProblem(
  spec: PropertySpec,
  value: unknown,
  path = spec.path,
): string | undefined {
  const issue = specValueIssue(spec, value, path);
  return issue && describeValueIssue(issue);
}
