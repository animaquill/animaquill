/**
 * The properties of clips and tracks that the editor itself knows. Positions and sizes are
 * fractions of the picture, so the same values make sense in every format.
 */
export interface PropertySpec {
  readonly type: "number" | "text" | "choice" | "boolean";
  readonly min?: number;
  readonly max?: number;
  /** For choices. */
  readonly options?: readonly string[];
}

const fraction = { type: "number", min: 0, max: 1 } as const;
const number = { type: "number" } as const;

export const BUILT_IN_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  "transform.x": number,
  "transform.y": number,
  "transform.width": number,
  "transform.height": number,
  "transform.anchorX": number,
  "transform.anchorY": number,
  "transform.scale": number,
  "transform.rotation": number,
  opacity: fraction,
  fit: { type: "choice", options: ["cover", "contain", "fixed"] },
  blend: {
    type: "choice",
    options: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add"],
  },
  "crop.left": fraction,
  "crop.top": fraction,
  "crop.right": fraction,
  "crop.bottom": fraction,
  /** Playback speed: 2 is twice as fast. Keys on it make a speed ramp. */
  "time.speed": { type: "number", min: 0 },
  /** In decibels: 0 leaves the sound as it is. */
  "audio.volume": { type: "number", max: 24 },
  "audio.pan": { type: "number", min: -1, max: 1 },
  /** In semitones. */
  "audio.pitch": number,
  "audio.preservePitch": { type: "boolean" },
};

/** Properties that are not built in but come from the content of a clip. */
export const OPEN_PROPERTY_PREFIXES = ["param.", "object.", "element.", "caption."] as const;

export const isKnownProperty = (path: string): boolean =>
  path in BUILT_IN_PROPERTIES || OPEN_PROPERTY_PREFIXES.some((prefix) => path.startsWith(prefix));

/** What is wrong with a plain value of a built-in property, or undefined when it is fine. */
export function propertyValueProblem(path: string, value: unknown): string | undefined {
  const spec = BUILT_IN_PROPERTIES[path];
  if (!spec) return undefined;
  switch (spec.type) {
    case "number":
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
  }
}
