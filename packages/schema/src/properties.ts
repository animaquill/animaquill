import type { Animation, PropertyValue, Value } from "./values.ts";

/** What a value holds, which decides how it is checked, animated and edited. */
export type ValueType = "number" | "angle" | "text" | "choice" | "boolean" | "asset";

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
  blend: {
    type: "choice",
    default: "normal",
    options: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add"],
  },
  /** Shares of the media. */
  "crop.left": { ...ratio, default: 0 },
  "crop.top": { ...ratio, default: 0 },
  "crop.right": { ...ratio, default: 0 },
  "crop.bottom": { ...ratio, default: 0 },
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

/** Properties that are not built in but come from the content of a clip. */
export const OPEN_PROPERTY_PREFIXES = ["param.", "object.", "element.", "caption."] as const;

export const isKnownProperty = (path: string): boolean =>
  Object.hasOwn(BUILT_IN_PROPERTIES, path) ||
  OPEN_PROPERTY_PREFIXES.some((prefix) => path.startsWith(prefix));

/** What is wrong with a plain value of a built-in property, or undefined when it is fine. */
export function propertyValueProblem(path: string, value: unknown): string | undefined {
  if (!Object.hasOwn(BUILT_IN_PROPERTIES, path)) return undefined;
  const spec = BUILT_IN_PROPERTIES[path] as PropertySpec;
  switch (spec.type) {
    case "number":
    case "angle":
      if (typeof value !== "number") return `${path} 要写成数字`;
      if (spec.min !== undefined && value < spec.min) return `${path} 不能小于 ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `${path} 不能大于 ${spec.max}`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} 要写成 true 或 false`;
    case "choice":
      return spec.options?.includes(value as string)
        ? undefined
        : `${path} 只能是：${spec.options?.join("、")}`;
    case "text":
      return typeof value === "string" ? undefined : `${path} 要写成文字`;
    case "asset":
      return typeof value === "object" && !Array.isArray(value)
        ? undefined
        : `${path} 要写成素材引用`;
  }
}
