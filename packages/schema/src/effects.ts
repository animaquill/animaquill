import type { PropertySpec } from "./properties.ts";

/**
 * Effects, apart from how files write them (see timeline.ts). An effect works on the picture of one
 * clip, in its clip box, before the box goes where its transform says: see the project format. A
 * clip has a list of them, which work one after the other, and each can be turned off. What an
 * effect takes are properties of the clip, `effect.<id>.<parameter>`, so they have keys like any
 * other property. Plain data, so nothing here may bring in Zod.
 */

/** What an effect works on: the picture of a clip, or sound (of a clip, a track or the master). */
export type EffectMedia = "picture" | "sound";

/**
 * What kind of thing an effect does, which is how the effects tabs group them: colors, blur, the
 * shape of the picture; for sound the balance of frequencies, dynamics and space.
 */
export type EffectCategory = "color" | "blur" | "shape" | "eq" | "dynamics" | "space";

export const EFFECT_CATEGORIES: readonly EffectCategory[] = [
  "color",
  "blur",
  "shape",
  "eq",
  "dynamics",
  "space",
];

/**
 * What an effect that comes with the editor is, as a description says it for any other. Each of
 * its parameters has a default that leaves the picture as it is, so that an effect does nothing
 * until somebody changes it.
 */
export interface EffectSpec {
  readonly media: readonly EffectMedia[];
  readonly category: EffectCategory;
  /** Its parameters, with paths of their own: the clip has them under `effect.<id>.`. */
  readonly properties: readonly PropertySpec[];
}

/** A share that goes either way: −1 is all the way down, 0 changes nothing. */
const amount = (path: string, max = 1): PropertySpec => ({
  path,
  type: "number",
  unit: "ratio",
  default: 0,
  min: -1,
  max,
  softMin: -1,
  softMax: 1,
});

/** How much of a side goes, as a share of the clip box. */
const side = (path: string): PropertySpec => ({
  path,
  type: "number",
  unit: "ratio",
  default: 0,
  min: 0,
  max: 1,
});

/** A number of sound with its unit, range and default. */
const tone = (
  path: string,
  unit: string,
  min: number,
  max: number,
  fallback: number,
  more: Partial<PropertySpec> = {},
): PropertySpec => ({ path, type: "number", unit, min, max, default: fallback, ...more });

/** A switch that turns a part of an effect on, which is no thing to change halfway through. */
const toggle = (path: string, group: string): PropertySpec => ({
  path,
  type: "boolean",
  default: false,
  animatable: false,
  group,
});

/** How steep a filter cuts: 12 or 24 dB an octave, one stage or two. */
const slope = (path: string, group: string): PropertySpec => ({
  path,
  type: "choice",
  default: "12",
  options: ["12", "24"],
  animatable: false,
  group,
});

/** A band of the equalizer that boosts or cuts around a frequency. */
const peak = (band: string, frequency: number): PropertySpec[] => [
  tone(`${band}.freq`, "hz", 20, 20_000, frequency, { group: band }),
  tone(`${band}.gain`, "db", -24, 24, 0, { group: band }),
  tone(`${band}.q`, "count", 0.1, 18, 1, { group: band, unit: "q" }),
];

/**
 * The effects of sound that come with the editor. What each does is part of the format, see the
 * project format ("声音效果"), sample by sample: the mix engine of `@animaquill/audio` is how it is
 * done. A sound effect never changes what it does once it is out: a better one gets a new name, so
 * that old projects sound as they did. Every default leaves the sound as it is.
 */
export const BUILT_IN_SOUND_EFFECTS: Readonly<Record<string, EffectSpec>> = {
  /** High pass, low shelf, three peaks, high shelf and low pass, one after the other. */
  eq: {
    media: ["sound"],
    category: "eq",
    properties: [
      toggle("hp.on", "hp"),
      tone("hp.freq", "hz", 20, 20_000, 80, { group: "hp" }),
      slope("hp.slope", "hp"),
      tone("low.freq", "hz", 20, 20_000, 100, { group: "low" }),
      tone("low.gain", "db", -24, 24, 0, { group: "low" }),
      ...peak("mid1", 250),
      ...peak("mid2", 1000),
      ...peak("mid3", 4000),
      tone("high.freq", "hz", 20, 20_000, 8000, { group: "high" }),
      tone("high.gain", "db", -24, 24, 0, { group: "high" }),
      toggle("lp.on", "lp"),
      tone("lp.freq", "hz", 20, 20_000, 18_000, { group: "lp" }),
      slope("lp.slope", "lp"),
    ],
  },
  /** Feed-forward, both sides by the louder one, with a soft knee. A ratio of 1 does nothing. */
  compressor: {
    media: ["sound"],
    category: "dynamics",
    properties: [
      tone("threshold", "db", -60, 0, 0),
      tone("ratio", "ratio", 1, 20, 1, { unit: "x" }),
      tone("attack", "ms", 0.1, 200, 10),
      tone("release", "ms", 10, 2000, 100),
      tone("knee", "db", 0, 24, 6),
      tone("makeup", "db", 0, 24, 0),
    ],
  },
  /** Keeps true peaks under a ceiling, looking 1.5 ms ahead. What stays under it is untouched. */
  limiter: {
    media: ["sound"],
    category: "dynamics",
    properties: [tone("ceiling", "dbtp", -12, 0, -1), tone("release", "ms", 10, 1000, 100)],
  },
  /** A feedback delay network of eight lines. With `mix` at 0 it does nothing. */
  reverb: {
    media: ["sound"],
    category: "space",
    properties: [
      tone("decay", "s", 0.1, 10, 1.5),
      tone("predelay", "ms", 0, 200, 10),
      tone("size", "ratio", 0, 1, 0.5),
      tone("damping", "hz", 1000, 20_000, 8000),
      tone("mix", "ratio", 0, 1, 0),
      tone("width", "ratio", 0, 1, 1),
    ],
  },
};

/**
 * The effects that come with the editor, by name, which is what projects keep. What each of them
 * does to a picture is part of the format, see the project format. Their names, and those of their
 * parameters, come from the interface texts.
 */
export const BUILT_IN_EFFECTS: Readonly<Record<string, EffectSpec>> = {
  /** Multiplies the colors by 1 + brightness. */
  brightness: { media: ["picture"], category: "color", properties: [amount("brightness")] },
  /** Moves the colors away from the middle gray by 1 + contrast, or towards it. */
  contrast: { media: ["picture"], category: "color", properties: [amount("contrast", 3)] },
  /** 1 + saturation of the color, around its gray: −1 is gray, 1 twice as colorful. */
  saturation: { media: ["picture"], category: "color", properties: [amount("saturation", 3)] },
  /** Warmer towards 1, cooler towards −1; tint goes to magenta and towards −1 to green. */
  temperature: {
    media: ["picture"],
    category: "color",
    properties: [amount("temperature"), amount("tint")],
  },
  /**
   * A Gaussian blur, in world units of the clip box: a smaller clip gets less blurred. What is
   * outside the box is its edge pixels over again, so that a picture that fills the stage keeps its
   * edges, or transparent, which softens the edges of the box too. Which one is how the clip is
   * made, not something that changes halfway through, so it has no keys.
   */
  blur: {
    media: ["picture"],
    category: "blur",
    properties: [
      { path: "radius", type: "number", unit: "world", default: 0, min: 0, softMax: 100 },
      {
        path: "edge",
        type: "choice",
        default: "extend",
        options: ["extend", "transparent"],
        animatable: false,
      },
    ],
  },
  /** Takes shares of the clip box away at its sides, which become transparent. */
  crop: {
    media: ["picture"],
    category: "shape",
    properties: [side("left"), side("top"), side("right"), side("bottom")],
  },
  ...BUILT_IN_SOUND_EFFECTS,
};

/**
 * Rooms for the reverb, which people pick from and AI writes from: each sets these parameters at
 * once. Not part of the format: a project keeps the parameters, never the name of a preset.
 */
export const REVERB_PRESETS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  smallRoom: { decay: 0.4, predelay: 5, size: 0.2, damping: 9000, mix: 0.2 },
  room: { decay: 0.8, predelay: 10, size: 0.4, damping: 8000, mix: 0.25 },
  hall: { decay: 2.2, predelay: 25, size: 0.8, damping: 6000, mix: 0.3 },
  plate: { decay: 1.6, predelay: 0, size: 0.5, damping: 12_000, mix: 0.3 },
  church: { decay: 4.5, predelay: 40, size: 1, damping: 5000, mix: 0.35 },
};

/** The effects that come with the editor, in the order people see them. */
export const EFFECT_TYPES: readonly string[] = Object.keys(BUILT_IN_EFFECTS);

/** Where the properties of an effect are among those of its clip. */
export const EFFECT_PREFIX = "effect.";

/** Where a parameter of an effect is among the properties of its clip. */
export const effectPath = (effect: string, parameter: string): string =>
  `${EFFECT_PREFIX}${effect}.${parameter}`;

/** Which effect a property of a clip is about, and which of its parameters, if it is one. */
export function effectOfPath(
  path: string,
): { readonly effect: string; readonly parameter: string } | undefined {
  if (!path.startsWith(EFFECT_PREFIX)) return undefined;
  const rest = path.slice(EFFECT_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  return { effect: rest.slice(0, dot), parameter: rest.slice(dot + 1) };
}

/** An effect that comes with the editor, or nothing when there is none by that name. */
export const builtInEffect = (type: string): EffectSpec | undefined =>
  Object.hasOwn(BUILT_IN_EFFECTS, type) ? BUILT_IN_EFFECTS[type] : undefined;

/** Why there is no telling what an effect does. */
export type EffectMissing =
  | { readonly reason: "unknown"; readonly type: string }
  /** A name with a dot comes from a plugin, and none is installed. */
  | { readonly reason: "plugin"; readonly type: string }
  /** It is not for this, such as one for sound on a picture. */
  | { readonly reason: "media"; readonly type: string; readonly media: EffectMedia };

/** What an effect is, for what it works on, or why that cannot be told. */
export function findEffect(
  type: string,
  media: EffectMedia,
):
  | { readonly kind: "built-in"; readonly type: string; readonly spec: EffectSpec }
  | { readonly kind: "missing"; readonly why: EffectMissing } {
  if (type.includes(".")) return { kind: "missing", why: { reason: "plugin", type } };
  const spec = builtInEffect(type);
  if (!spec) return { kind: "missing", why: { reason: "unknown", type } };
  if (!spec.media.includes(media))
    return { kind: "missing", why: { reason: "media", type, media } };
  return { kind: "built-in", type, spec };
}

/** Why there is no telling what an effect does, in words. */
export function describeMissingEffect(why: EffectMissing): string {
  switch (why.reason) {
    case "unknown":
      return `没有这个效果：${why.type}`;
    case "plugin":
      return `没有安装提供这个效果的插件：${why.type}`;
    case "media":
      return `效果 ${why.type} 不能用在${why.media === "sound" ? "声音" : "画面"}上`;
  }
}

/** The parameter of an effect by its path within the effect. */
export const parameterOf = (spec: EffectSpec, parameter: string): PropertySpec | undefined =>
  spec.properties.find(({ path }) => path === parameter);
