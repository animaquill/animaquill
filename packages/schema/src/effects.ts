import type { PropertySpec } from "./properties.ts";

/**
 * Effects, apart from how files write them (see timeline.ts). An effect works on the picture of one
 * clip, in its clip box, before the box goes where its transform says: see the project format. A
 * clip has a list of them, which work one after the other, and each can be turned off. What an
 * effect takes are properties of the clip, `effect.<id>.<parameter>`, so they have keys like any
 * other property. Plain data, so nothing here may bring in Zod.
 */

/** What an effect works on. Only pictures so far: effects of sound come with the mixer. */
export type EffectMedia = "picture" | "sound";

/**
 * What kind of thing an effect does, which is how the effects tab groups them: colors, blur, the
 * shape of the picture.
 */
export type EffectCategory = "color" | "blur" | "shape";

export const EFFECT_CATEGORIES: readonly EffectCategory[] = ["color", "blur", "shape"];

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
