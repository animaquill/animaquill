import { specValueProblem, type PropertySpec } from "./properties.ts";
import {
  ZERO,
  add,
  compare,
  multiply,
  parseTime,
  rational,
  subtract,
  type Rational,
} from "./time.ts";
import type { Value } from "./values.ts";

/**
 * Transitions, apart from how files write them (see timeline.ts). A transition goes from one side
 * to the other over a while: from nothing to a clip at its start, from the clip to nothing at its
 * end, or from one clip to the next on the cut between them. Fading in and out is one of them. The
 * rules here are shared by the checks of a project, the commands and the render plan, so that they
 * all say the same about a transition. Plain data, so nothing here may bring in Zod.
 */

/** Where a transition is: at the start of a clip, at its end, or on the cut between two clips. */
export type TransitionUse = "enter" | "exit" | "join";

export const TRANSITION_USES: readonly TransitionUse[] = ["enter", "exit", "join"];

/** What a transition changes. */
export type TransitionMedia = "picture" | "sound";

/** How a transition gets along over its time, as in CSS `cubic-bezier()`: x1, y1, x2, y2. */
export type SpeedCurve = readonly [x1: number, y1: number, x2: number, y2: number];

/** How far up and down the y of a speed curve goes, either way. Its x is within 0 and 1. */
export const SPEED_CURVE_REACH = 10;

/**
 * What the speed buttons put in, with the curves of CSS of the same names. Projects keep the
 * numbers, so a preset that changes later leaves them as they are. No curve is an even speed.
 */
export const SPEED_PRESETS: Readonly<Record<"easeIn" | "easeOut" | "easeInOut", SpeedCurve>> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/**
 * What the code of a transition gets as `values`: one plain value for each of its properties, by
 * path, which people set. They have no keys: a transition goes from one side to the other, and
 * how it gets there over its time is its speed curve.
 */
export type TransitionValues = Readonly<Record<string, Value>>;

/** What a transition that comes with the editor is, as a description says it for any other. */
export interface TransitionSpec {
  readonly uses: readonly TransitionUse[];
  /** How long it is when it is put somewhere, in seconds, exactly. */
  readonly duration: string;
  /** How it goes when it is put somewhere, and when it takes the place of another. Even without. */
  readonly curve?: SpeedCurve;
  /** A speed curve that goes past 0 and 1 is used as it is. Otherwise it stops there. */
  readonly overshoot?: boolean;
  /**
   * What people can set for it, besides how long it takes and how it gets along, such as which way
   * a wipe goes. Each has a default, which is what a transition gets that does not say. None of
   * them can have keys. A transition of a project or a library declares its own the same way.
   */
  readonly properties?: readonly PropertySpec[];
}

/** Which way something goes on the picture: the way the picture moves, or the edge does. */
export const DIRECTIONS: readonly string[] = ["left", "right", "up", "down"];

/** Which way a transition goes, with the way it goes when nobody says. */
const direction = (fallback: string): PropertySpec => ({
  path: "direction",
  type: "choice",
  options: DIRECTIONS,
  default: fallback,
  animatable: false,
});

/**
 * The transitions that come with the editor, by what they change and by name, which is what projects
 * keep. What each of them looks like is part of the format, see the project format, and their code
 * gets the values of their properties. Their names come from the interface texts, by type and use.
 */
export const BUILT_IN_TRANSITIONS: Readonly<
  Record<TransitionMedia, Readonly<Record<string, TransitionSpec>>>
> = {
  picture: {
    fade: { uses: TRANSITION_USES, duration: "0.5" },
    /**
     * Through a plain color. `hold` is the share of the time that is nothing but the color: in the
     * middle of a join, at the start of an enter and at the end of an exit.
     */
    dip: {
      uses: TRANSITION_USES,
      duration: "0.5",
      properties: [
        { path: "color", type: "color", default: "#000000", animatable: false },
        {
          path: "hold",
          type: "number",
          unit: "ratio",
          default: 0,
          min: 0,
          max: 0.9,
          animatable: false,
        },
      ],
    },
    /** The soft edge is a share of the short side of the picture. */
    wipe: {
      uses: TRANSITION_USES,
      duration: "0.5",
      properties: [
        direction("right"),
        {
          path: "softness",
          type: "number",
          unit: "ratio",
          default: 0.02,
          min: 0,
          max: 0.5,
          animatable: false,
        },
      ],
    },
    push: {
      uses: TRANSITION_USES,
      duration: "0.5",
      overshoot: true,
      properties: [direction("left")],
    },
  },
  sound: {
    fade: { uses: TRANSITION_USES, duration: "0.2" },
    "fade-linear": { uses: TRANSITION_USES, duration: "0.2" },
  },
};

const NO_PROPERTIES: readonly PropertySpec[] = [];

/** What people can set for a transition, in the order they see it. */
export const propertiesOf = (spec: TransitionSpec): readonly PropertySpec[] =>
  spec.properties ?? NO_PROPERTIES;

/** A built-in transition by what it changes and its name, or nothing for one there is not. */
export function builtInTransition(
  media: TransitionMedia,
  type: string | undefined,
): TransitionSpec | undefined {
  const own = BUILT_IN_TRANSITIONS[media];
  return type !== undefined && Object.hasOwn(own, type) ? own[type] : undefined;
}

/**
 * What the code of a transition gets: each of its properties as the transition sets it, or else its
 * default. A number past the limits counts as the limit, and anything else that a property cannot
 * take counts as its default, as `transitionValueProblems` tells. What no property has is left out.
 */
export function transitionValuesOf(
  spec: TransitionSpec,
  given: Readonly<Record<string, unknown>> | undefined,
): TransitionValues {
  const values: Record<string, Value> = {};
  for (const property of propertiesOf(spec)) {
    const value = given && Object.hasOwn(given, property.path) ? given[property.path] : undefined;
    if (typeof value === "number" && (property.type === "number" || property.type === "angle")) {
      const fallback = typeof property.default === "number" ? property.default : 0;
      values[property.path] = Number.isFinite(value)
        ? Math.min(Math.max(value, property.min ?? -Infinity), property.max ?? Infinity)
        : fallback;
    } else if (value !== undefined && !specValueProblem(property, value)) {
      values[property.path] = value as Value;
    } else if (property.default !== undefined) {
      values[property.path] = property.default;
    }
  }
  return values;
}

/**
 * What is wrong with what a transition sets, in words: a property it does not have, or a value one
 * cannot take. Empty when nothing is. Values are plain: no property of a transition has keys.
 */
export function transitionValueProblems(
  spec: TransitionSpec,
  type: string,
  given: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const problems: string[] = [];
  const properties = propertiesOf(spec);
  for (const [path, value] of Object.entries(given ?? {})) {
    const property = properties.find((each) => each.path === path);
    if (!property) {
      problems.push(`转场 ${type} 没有这个属性：${path}`);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "keys" in value) {
      problems.push(`转场的属性不能打关键帧：${path}`);
      continue;
    }
    const problem = specValueProblem(property, value, path);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** Every picture transition that comes with the editor. */
const PICTURES = ["fade", "dip", "wipe", "push"];

/**
 * What this editor does so far. The format has the rest already, so that a project can have it: it
 * stays as it is, and the problems of the project say that it does nothing yet.
 */
export const SUPPORTED_TRANSITIONS: Readonly<
  Record<TransitionMedia, Readonly<Record<TransitionUse, readonly string[]>>>
> = {
  picture: { enter: PICTURES, exit: PICTURES, join: PICTURES },
  sound: { enter: [], exit: [], join: [] },
};

/** How a transition says what it is. One of `type`, `transition`, or `library` with `resource`. */
export interface TransitionRef {
  readonly type?: string | undefined;
  readonly transition?: string | undefined;
  readonly library?: string | undefined;
  readonly resource?: string | undefined;
  /** What it sets for its properties. */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
}

/** Why there is no telling what a transition is. */
export type TransitionMissing =
  | { readonly reason: "unknown"; readonly type: string }
  /** A name with a dot comes from a plugin, and none is installed. */
  | { readonly reason: "plugin"; readonly type: string }
  /** Transitions of the project itself are not there yet. */
  | { readonly reason: "project"; readonly transition: string }
  /** Nor transitions of libraries. */
  | { readonly reason: "library"; readonly library: string; readonly resource: string }
  /** It cannot go there, such as one that only goes between clips put at the start of one. */
  | { readonly reason: "use"; readonly type: string; readonly use: TransitionUse }
  /** It is not for this, such as one for sound on a picture. */
  | { readonly reason: "media"; readonly type: string; readonly media: TransitionMedia };

export type TransitionFound =
  | {
      readonly kind: "built-in";
      readonly type: string;
      readonly spec: TransitionSpec;
      /** What its code gets: what the transition sets, and the defaults for the rest. */
      readonly values: TransitionValues;
    }
  | { readonly kind: "missing"; readonly why: TransitionMissing };

const OTHER_MEDIA: Readonly<Record<TransitionMedia, TransitionMedia>> = {
  picture: "sound",
  sound: "picture",
};

/** What a transition is, for what it changes and where it is. */
export function findTransition(
  ref: TransitionRef,
  media: TransitionMedia,
  use: TransitionUse,
): TransitionFound {
  const missing = (why: TransitionMissing): TransitionFound => ({ kind: "missing", why });
  const { type } = ref;
  if (type === undefined) {
    if (ref.transition !== undefined) {
      return missing({ reason: "project", transition: ref.transition });
    }
    return missing({ reason: "library", library: ref.library ?? "", resource: ref.resource ?? "" });
  }
  if (type.includes(".")) return missing({ reason: "plugin", type });
  const own = BUILT_IN_TRANSITIONS[media];
  const spec = Object.hasOwn(own, type) ? own[type] : undefined;
  if (!spec) {
    const elsewhere = Object.hasOwn(BUILT_IN_TRANSITIONS[OTHER_MEDIA[media]], type);
    return missing(elsewhere ? { reason: "media", type, media } : { reason: "unknown", type });
  }
  if (!spec.uses.includes(use)) return missing({ reason: "use", type, use });
  return { kind: "built-in", type, spec, values: transitionValuesOf(spec, ref.values) };
}

/** Whether this editor shows or plays what was found, there. See `SUPPORTED_TRANSITIONS`. */
export const isSupported = (
  found: TransitionFound,
  media: TransitionMedia,
  use: TransitionUse,
): boolean => found.kind === "built-in" && SUPPORTED_TRANSITIONS[media][use].includes(found.type);

/** What people call transitions by where they are. */
export const TRANSITION_USE_NAMES: Readonly<Record<TransitionUse, string>> = {
  enter: "入转场",
  exit: "出转场",
  join: "衔接转场",
};

const MEDIA_NAMES: Readonly<Record<TransitionMedia, string>> = { picture: "画面", sound: "声音" };

/** Why there is no telling what a transition is, in words. */
export function describeMissing(why: TransitionMissing): string {
  switch (why.reason) {
    case "unknown":
      return `没有这个转场：${why.type}`;
    case "plugin":
      return `没有安装提供这个转场的插件：${why.type}`;
    case "project":
      return `这一版还不能用项目里的转场：${why.transition}`;
    case "library":
      return `这一版还不能用素材库里的转场：${why.library} 的 ${why.resource}`;
    case "use":
      return `转场 ${why.type} 不能用作${TRANSITION_USE_NAMES[why.use]}`;
    case "media":
      return `转场 ${why.type} 不能用在${MEDIA_NAMES[why.media]}上`;
  }
}

/** That this editor does not do a transition yet, in words. See `SUPPORTED_TRANSITIONS`. */
export function describeUnsupported(
  type: string,
  media: TransitionMedia,
  use: TransitionUse,
): string {
  if (media === "sound") return `这一版的编辑器还不能播放声音的${TRANSITION_USE_NAMES[use]}`;
  return `这一版的编辑器还不能显示${TRANSITION_USE_NAMES[use]} ${type}`;
}

/** What a track holds, for its transitions. Captions are pictures too, once they get drawn. */
export const mediaOfTrack = (kind: string): TransitionMedia =>
  kind === "audio" ? "sound" : "picture";

/**
 * How long a transition at the start or end of a clip lasts: as long as it says, and never longer
 * than the clip. Its progress still goes from 0 to 1. An enter and an exit that overlap take turns:
 * what the exit starts from is what the enter made.
 */
export function edgeLength(duration: Rational, clipDuration: Rational): Rational {
  return compare(duration, clipDuration) > 0 ? clipDuration : duration;
}

/** Where a join is around its cut: half before and half after it, all before, or all after. */
export type JoinAlign = "center" | "before" | "after";

export const JOIN_ALIGNS: readonly JoinAlign[] = ["center", "before", "after"];

const HALF = rational(1n, 2n);

/**
 * How much of a join is before its cut and how much after, as it says: the clip before the cut shows
 * on during what is after it, and the clip after the cut shows before it starts. A part that the
 * clip on its side is too short for gets shorter, see `JoinInEffect`.
 */
export function joinParts(
  duration: Rational,
  align: JoinAlign | undefined,
): readonly [before: Rational, after: Rational] {
  if (align === "before") return [duration, ZERO];
  if (align === "after") return [ZERO, duration];
  const half = multiply(duration, HALF);
  return [half, subtract(duration, half)];
}

/** Where a join is. */
export type JoinPlace =
  /** On the cut between its clips, at this moment on the timeline. */
  | { readonly kind: "cut"; readonly at: Rational }
  /** A side is not on the track. */
  | { readonly kind: "missing"; readonly clip: string }
  /**
   * A side is hidden, and then the join does nothing, as if it were not there: a clip that is only
   * in some versions is hidden in the master, and the master gets no transition from it.
   */
  | { readonly kind: "hidden"; readonly clip: string }
  /** Both sides are one clip. */
  | { readonly kind: "same" }
  /** The first clip does not end where the second one starts. */
  | { readonly kind: "apart" }
  /** Another join is on the same cut, and it comes first by id. */
  | { readonly kind: "taken"; readonly by: string };

/** The times of a clip, as files and the live project both keep them, and whether it shows. */
export interface ClipTimes {
  readonly start: string;
  readonly duration: string;
  readonly hidden?: boolean | undefined;
}

/** The two sides of a join. */
export interface JoinSides {
  readonly from: string;
  readonly to: string;
}

/**
 * Where the joins of a track are, by id. A join only does something on the cut between its two
 * clips, while both show. Two people and hand-written files can leave one elsewhere, and then it
 * stays, doing nothing, until somebody fixes it. Of two on one cut, the first by id is the one. The
 * problems of a project, its picture and the timeline all go by this, so they never disagree.
 */
export function placeJoins(
  joins: ReadonlyMap<string, JoinSides>,
  clipOf: (id: string) => ClipTimes | undefined,
): ReadonlyMap<string, JoinPlace> {
  const places = new Map<string, JoinPlace>();
  const cuts = new Map<string, string>();
  for (const id of [...joins.keys()].toSorted()) {
    const { from, to } = joins.get(id) as JoinSides;
    const before = clipOf(from);
    const after = clipOf(to);
    if (!before || !after) {
      places.set(id, { kind: "missing", clip: before ? to : from });
      continue;
    }
    if (before.hidden === true || after.hidden === true) {
      places.set(id, { kind: "hidden", clip: before.hidden === true ? from : to });
      continue;
    }
    if (from === to) {
      places.set(id, { kind: "same" });
      continue;
    }
    const at = add(parseTime(before.start), parseTime(before.duration));
    if (compare(at, parseTime(after.start)) !== 0) {
      places.set(id, { kind: "apart" });
      continue;
    }
    // A cut is a moment with a clip on each side, and either side can only go one way at a time.
    const keys = [`from ${from}`, `to ${to}`];
    const by = keys.map((key) => cuts.get(key)).find((other) => other !== undefined);
    if (by !== undefined) {
      places.set(id, { kind: "taken", by });
      continue;
    }
    for (const key of keys) cuts.set(key, id);
    places.set(id, { kind: "cut", at });
  }
  return places;
}
