import {
  BUILT_IN_PROPERTIES,
  Extrapolation,
  Handle,
  Id,
  Key,
  PropertyPath,
  PresetParams,
  PropertyValue,
  Spring,
  TIME_PATTERN,
  Time,
  Value,
  builtInEffect,
  compare,
  effectOfPath,
  isAnimation,
  normalizeTime,
  parameterOf,
  parseTime,
  subtract,
  toSeconds,
  type Animation,
  type Rational,
  ZERO,
  type ValueType,
} from "@animaquill/schema";
import { z } from "zod";
import {
  canShake,
  isNumeric,
  joinBezier,
  presetProblem,
  springOf,
  splitBezier,
  type Handles,
  type KeyPoint,
} from "./curve.ts";
import { fail } from "./draft.ts";
import {
  clipOffset,
  clipStart,
  effectsOf,
  entryOf,
  projectFrameRate,
  type ClipState,
  type ProjectState,
} from "./model.ts";
import { retimeKeys, type ClockFrames, type Retimed } from "./retime.ts";

/**
 * Whose property it is: a clip, a track of sound, which takes only `TRACK_PATHS` (its volume, its
 * pan and the parameters of its effects), or the master of the timeline (`MASTER_PATHS`). Keys of a
 * track and the master are on the timeline's time, from its start, as they have no clock.
 */
export const PropertyOwner = z.union([
  z.strictObject({ clip: Id }),
  z.strictObject({ track: Id }),
  z.strictObject({ master: z.literal(true) }),
]);
export type PropertyOwner = z.output<typeof PropertyOwner>;

/** What a track takes through `property.edit`: what the mix does with it. */
export const TRACK_PATHS: readonly string[] = ["audio.volume", "audio.pan", "effect.*"];

/** What the master takes: its volume, its safe limiter and the parameters of its effects. */
export const MASTER_PATHS: readonly string[] = [
  "audio.volume",
  "limit.on",
  "limit.ceiling",
  "effect.*",
];

/** Whether a path is one of a list of paths, where `effect.*` stands for every parameter of an effect. */
export const takesPath = (paths: readonly string[], path: string): boolean =>
  paths.includes(path) || (paths.includes("effect.*") && effectOfPath(path) !== undefined);

const Target = { owner: PropertyOwner, path: PropertyPath };

/**
 * How a key gets to the next one. A bezier says how it leaves, and how it arrives at the next. A
 * spring or a preset is all about the key it leaves; the names and what they take are those of the
 * project format, and a command takes only what can be worked out (see `eased`).
 */
export const KeyEase = z.discriminatedUnion("interp", [
  z.strictObject({ interp: z.literal("linear") }),
  z.strictObject({ interp: z.literal("hold") }),
  z.strictObject({ interp: z.literal("bezier"), out: Handle, in: Handle.optional() }),
  z.strictObject({ interp: z.literal("spring"), spring: Spring }),
  z.strictObject({
    interp: z.literal("preset"),
    preset: z.string().min(1),
    presetParams: PresetParams.optional(),
  }),
]);

export type KeyEase = z.output<typeof KeyEase>;

const KeyMove = z.strictObject({ from: Time, to: Time });

/** A reading of the clock of a clip, which for mapping one stretch onto another can be before it starts. */
const Reading = z
  .string()
  .regex(TIME_PATTERN, '时间要写成字符串，单位是秒，可以是负数，比如 "-0.5" 或 "1/30"')
  .overwrite(normalizeTime);

/** Shaking as `setNoise` writes it. What it leaves out stays as the shaking there has it. */
export const NoiseEdit = z.strictObject({
  amount: z.number(),
  frequency: z.number().positive().optional(),
  seed: z.number().int().optional(),
});

/**
 * One change to one property. Times are readings of the clock of the clip, like the keys themselves.
 *
 * - `write` is what a control does: with keys it writes a key at `time`, otherwise it changes the value.
 * - `setKey` writes a key, also on a property that had none.
 * - `removeKey` takes one away. The last one leaves its value behind.
 * - `moveKey` moves keys together, so that one can go where another one leaves. A key that stays where
 *   one lands goes. They take their easing along.
 * - `setInterp` says how keys get to the next one, which for a bezier also goes for how it arrives.
 * - `putKeys` puts whole keys in, instead of what is at those moments. A plain value gives way.
 * - `setExtend` says what the value does before the first key and after the last one.
 * - `setNoise` shakes the value, or stops it with null. A property without keys gets one at the first
 *   frame of the clip, as the format has shaking on keys.
 * - `retimeKeys` maps `from` onto `to` for some keys, exactly: stretching, squeezing, moving, and
 *   reversing when the order turns around. With `frames` they go to the nearest frame. See retime.ts.
 * - `set` replaces the whole property, `clear` takes it away.
 */
export const PropertyEdit = z.discriminatedUnion("op", [
  z.strictObject({ ...Target, op: z.literal("write"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("setKey"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("removeKey"), time: Time }),
  z.strictObject({ ...Target, op: z.literal("moveKey"), moves: z.array(KeyMove).min(1) }),
  z.strictObject({
    ...Target,
    op: z.literal("setInterp"),
    times: z.array(Time).min(1),
    ease: KeyEase,
  }),
  z.strictObject({ ...Target, op: z.literal("putKeys"), keys: z.array(Key).min(1) }),
  z
    .strictObject({
      ...Target,
      op: z.literal("setExtend"),
      before: Extrapolation.optional(),
      after: Extrapolation.optional(),
    })
    .refine(({ before, after }) => before !== undefined || after !== undefined, {
      message: "setExtend 至少要写 before 或 after",
    }),
  z.strictObject({ ...Target, op: z.literal("setNoise"), noise: NoiseEdit.nullable() }),
  z.strictObject({
    ...Target,
    op: z.literal("retimeKeys"),
    times: z.array(Time).min(1),
    from: z.tuple([Reading, Reading]),
    to: z.tuple([Reading, Reading]),
    frames: z.literal(true).optional(),
  }),
  z.strictObject({ ...Target, op: z.literal("set"), value: PropertyValue }),
  z.strictObject({ ...Target, op: z.literal("clear") }),
]);

export type PropertyEdit = z.output<typeof PropertyEdit>;

type Owned<E, O> = E extends unknown ? Omit<E, "owner"> & { readonly owner: O } : never;

/** An edit of a property of a clip, which is what the editor's controls and trials make. */
export type ClipPropertyEdit = Owned<PropertyEdit, { readonly clip: string }>;

/** Whether an edit is about a clip, rather than a track or the master. */
export const isClipEdit = (edit: PropertyEdit): edit is ClipPropertyEdit => "clip" in edit.owner;

type WithoutTarget<T> = T extends unknown ? Omit<T, "owner" | "path"> : never;

/** What an edit does to a value, wherever that value is. */
export type ValueEdit = WithoutTarget<PropertyEdit>;

/** The first key at or after a moment. */
export function firstKeyFrom(keys: readonly Key[], moment: Rational): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare(parseTime((keys[middle] as Key).time), moment) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

export const isAt = (key: Key | undefined, moment: Rational): key is Key =>
  key !== undefined && compare(parseTime(key.time), moment) === 0;

const DEFAULT_ARRIVAL = [1, 1] as const;

/** A key as a point of its curve, when it is a number there. */
function pointOf({ time, value }: Key): KeyPoint | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? { time: toSeconds(parseTime(time)), value }
    : undefined;
}

/** The handles of the bezier that leaves a key, or undefined when it does not leave as one. */
function bezierFrom(from: Key, to: Key): Handles | undefined {
  if (from.interp !== "bezier" || !from.out) return undefined;
  const [x2, y2] = to.in ?? DEFAULT_ARRIVAL;
  return [from.out[0], from.out[1], x2, y2];
}

/** How a key arrives, without writing what it would do anyway, give or take what floats lose. */
function arrivingAs(key: Key, [x, y]: readonly [number, number]): Key {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12;
  if (key.in === undefined && near(x, DEFAULT_ARRIVAL[0]) && near(y, DEFAULT_ARRIVAL[1]))
    return key;
  return { ...key, in: [x, y] };
}

/**
 * A key that goes in keeps what a bezier looks like where it holds the value that was there, and
 * bends it where it holds another one, as far as `splitBezier` can. Everywhere else a new key is
 * linear, and the keys around it stay as they are, so that taking it away again leaves what was there.
 */
function keysWith(keys: readonly Key[], index: number, added: Key): readonly Key[] {
  const before = keys[index - 1];
  const after = keys[index];
  const handles = before && after ? bezierFrom(before, after) : undefined;
  const points = before && after ? [pointOf(before), pointOf(after), pointOf(added)] : [];
  const [from, to, at] = points;
  const halves = handles && from && to && at ? splitBezier(from, to, handles, at) : undefined;
  if (!before || !after || !halves) return keys.toSpliced(index, 0, added);
  const [x1, y1, x2, y2] = halves.before;
  const [x3, y3, x4, y4] = halves.after;
  return keys.toSpliced(
    index - 1,
    2,
    { ...before, out: [x1, y1] },
    { ...added, in: [x2, y2], interp: "bezier", out: [x3, y3] },
    arrivingAs(after, [x4, y4]),
  );
}

/** The keys without one, which takes the bezier that was cut there back to what it was before. */
function keysWithout(keys: readonly Key[], index: number): readonly Key[] {
  const before = keys[index - 1];
  const key = keys[index] as Key;
  const after = keys[index + 1];
  const left = before ? bezierFrom(before, key) : undefined;
  const right = after ? bezierFrom(key, after) : undefined;
  const points = before && after ? [pointOf(before), pointOf(key), pointOf(after)] : [];
  const [from, middle, to] = points;
  const joined =
    left && right && from && middle && to ? joinBezier(from, middle, to, left, right) : undefined;
  if (!before || !after || !joined) return keys.toSpliced(index, 1);
  const [x1, y1, x2, y2] = joined;
  return keys.toSpliced(index - 1, 3, { ...before, out: [x1, y1] }, arrivingAs(after, [x2, y2]));
}

/** A key that is there keeps how it goes on, so changing its value does not change the easing. */
function withKey(animation: Animation, time: string, value: Value): Animation {
  const moment = parseTime(time);
  const { keys } = animation;
  const index = firstKeyFrom(keys, moment);
  const there = keys[index];
  return {
    ...animation,
    keys: isAt(there, moment)
      ? keys.with(index, { ...there, value })
      : (keysWith(keys, index, { time, value }) as Key[]),
  };
}

function indexOfKey(keys: readonly Key[], time: string): number {
  const moment = parseTime(time);
  const index = firstKeyFrom(keys, moment);
  return isAt(keys[index], moment) ? index : fail("not-found", { kind: "key", id: time });
}

function withoutKey(value: PropertyValue | undefined, time: string): PropertyValue {
  const keys = value !== undefined && isAnimation(value) ? value.keys : [];
  const index = indexOfKey(keys, time);
  if (keys.length === 1) return (keys[index] as Key).value;
  return { ...(value as Animation), keys: keysWithout(keys, index) as Key[] };
}

/** New keys among those that stay. Where one comes down on a key that stays, the new one is what is left. */
function placed(staying: readonly Key[], added: readonly Key[]): readonly Key[] {
  const timed = added
    .map((key) => ({ key, moment: parseTime(key.time) }))
    .toSorted((a, b) => compare(a.moment, b.moment));
  const keys: Key[] = [];
  let from = 0;
  timed.forEach(({ key, moment }, index) => {
    const previous = timed[index - 1];
    if (previous && compare(previous.moment, moment) === 0) {
      fail("invalid-value", { rule: "key-taken", time: key.time });
    }
    const at = firstKeyFrom(staying, moment);
    for (let next = from; next < at; next += 1) keys.push(staying[next] as Key);
    keys.push(key);
    from = isAt(staying[at], moment) ? at + 1 : at;
  });
  for (let next = from; next < staying.length; next += 1) keys.push(staying[next] as Key);
  return keys;
}

function withKeysMoved(
  animation: Animation | undefined,
  moves: readonly z.output<typeof KeyMove>[],
): Animation {
  const keys = animation?.keys ?? [];
  const leaving = new Set<number>();
  const moved = moves.map(({ from, to }) => {
    const index = indexOfKey(keys, from);
    if (leaving.has(index)) fail("invalid-value", { rule: "key-moved-twice", time: from });
    leaving.add(index);
    return { ...(keys[index] as Key), time: to };
  });
  const staying = keys.filter((_key, index) => !leaving.has(index));
  return { ...(animation as Animation), keys: placed(staying, moved) as Key[] };
}

/**
 * A spring or a preset that a file has goes linearly when it cannot be worked out, and is a problem.
 * A command is stricter: it does not write one.
 */
function checkEase(ease: KeyEase): void {
  if (ease.interp === "spring" && !springOf(ease.spring)) {
    fail("invalid-value", { rule: "preset-params", ease: "spring" });
  }
  if (ease.interp !== "preset") return;
  const problem = presetProblem(ease);
  if (problem === "unknown") fail("invalid-value", { rule: "unknown-preset", preset: ease.preset });
  if (problem !== undefined) fail("invalid-value", { rule: "preset-params", ease: ease.preset });
}

/** Without what says how a key goes on, as when a new way of going on replaces it. */
export function withoutEase(key: Key): Key {
  const {
    interp: _interp,
    out: _out,
    preset: _preset,
    presetParams: _presetParams,
    spring: _spring,
    ...rest
  } = key;
  return rest;
}

/** Only what is about how a key goes on: how it arrives is about the stretch before it. */
function eased(key: Key, ease: KeyEase): Key {
  const rest = withoutEase(key);
  switch (ease.interp) {
    case "linear":
      return rest;
    case "hold":
      return { ...rest, interp: "hold" };
    case "bezier":
      return { ...rest, interp: "bezier", out: ease.out };
    case "spring":
      return { ...rest, interp: "spring", spring: ease.spring };
    case "preset":
      return {
        ...rest,
        interp: "preset",
        preset: ease.preset,
        ...(ease.presetParams && { presetParams: ease.presetParams }),
      };
  }
}

function arriving(key: Key, ease: KeyEase): Key {
  const { in: _in, ...rest } = key;
  return ease.interp === "bezier" && ease.in ? { ...rest, in: ease.in } : rest;
}

function withEase(
  animation: Animation | undefined,
  times: readonly string[],
  ease: KeyEase,
): Animation {
  checkEase(ease);
  const keys = [...(animation?.keys ?? [])];
  for (const time of times) {
    const index = indexOfKey(keys, time);
    keys[index] = eased(keys[index] as Key, ease);
    const next = keys[index + 1];
    if (next) keys[index + 1] = arriving(next, ease);
  }
  return { ...(animation as Animation), keys };
}

const NO_KEYS: Animation = { keys: [] };

/** What `setExtend` and `setNoise` need to know of the property, besides its value. */
export interface EditContext {
  readonly path: string;
  /** The reading of the clock of the clip at its first frame, where a first key goes. */
  readonly firstFrame: string;
  /** The seed of shaking that does not say one, the same for the same clip and path. */
  readonly seed: number;
  /** What the property holds, when that is known without running a scene. */
  readonly type?: ValueType | undefined;
  /** What it is without a value of its own, when that is known. */
  readonly fallback?: Value | undefined;
  /** The frames of the project on the clock of the clip, when there is a project. */
  readonly frames?: ClockFrames | undefined;
}

/** Seeds that people can read and type. */
const SEEDS = 1_000_000;

/** A seed from the clip and the path (FNV-1a), so that the same call gives the same shaking. */
export function seedOf(clip: string, path: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${clip} ${path}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) as number), 0x01000193);
  }
  return (hash >>> 0) % SEEDS;
}

/** What a property of a clip is, as far as the format, its effects and the manifest of its scene or sound say. */
function specOf(state: ProjectState | undefined, clip: ClipState, path: string) {
  if (Object.hasOwn(BUILT_IN_PROPERTIES, path)) return BUILT_IN_PROPERTIES[path];
  const of = effectOfPath(path);
  if (of) {
    const effect = effectsOf(clip).find(({ id }) => id === of.effect);
    const spec = effect?.type === undefined ? undefined : builtInEffect(effect.type);
    return spec && parameterOf(spec, of.parameter);
  }
  if (!path.startsWith("param.") || !state) return undefined;
  const { scene, sound } = clip.source as { readonly scene?: unknown; readonly sound?: unknown };
  const manifest =
    clip.source.kind === "scene" && typeof scene === "string"
      ? entryOf(state.scenes, scene)
      : clip.source.kind === "sound" && typeof sound === "string"
        ? entryOf(state.sounds, sound)
        : undefined;
  const id = path.slice("param.".length);
  const params: readonly { id: string; type: ValueType; default?: Value | undefined }[] =
    manifest?.params ?? [];
  const param = params.find((one) => one.id === id);
  return param && { type: param.type, default: param.default };
}

/** What an edit of a property of a clip needs to know, besides its value. */
export function editContextOf(
  state: ProjectState | undefined,
  clip: ClipState,
  path: string,
): EditContext {
  const spec = specOf(state, clip, path);
  const frames: ClockFrames | undefined = state && {
    rate: parseTime(projectFrameRate(state.manifest)),
    shift: subtract(clipOffset(clip), clipStart(clip)),
  };
  return {
    path,
    firstFrame: clip.offset ?? "0",
    seed: seedOf(clip.id, path),
    ...(spec && { type: spec.type, fallback: spec.default }),
    ...(frames && { frames }),
  };
}

/**
 * What an edit of a property of a track or the master needs to know: its keys are on the timeline's
 * time, from its start, so its first frame is 0 and its frames are those of the project from there.
 * `effects` are its effects, whose parameters it has.
 */
export function trackEditContextOf(
  state: ProjectState | undefined,
  track: string,
  path: string,
  effects: readonly { readonly id: string; readonly type: string }[] = [],
): EditContext {
  const of = effectOfPath(path);
  const listed = of && effects.find(({ id }) => id === of.effect);
  const spec = Object.hasOwn(BUILT_IN_PROPERTIES, path)
    ? BUILT_IN_PROPERTIES[path]
    : listed
      ? (() => {
          const effect = builtInEffect(listed.type);
          return effect && of && parameterOf(effect, of.parameter);
        })()
      : undefined;
  const frames: ClockFrames | undefined = state && {
    rate: parseTime(projectFrameRate(state.manifest)),
    shift: ZERO,
  };
  return {
    path,
    firstFrame: "0",
    seed: seedOf(track, path),
    ...(spec && { type: spec.type, fallback: spec.default }),
    ...(frames && { frames }),
  };
}

const valuesIn = (value: PropertyValue | undefined): readonly Value[] => {
  if (value === undefined) return [];
  return isAnimation(value) ? value.keys.map((key) => key.value) : [value];
};

const isNumbers = (value: Value) =>
  Array.isArray(value) && value.every((part) => typeof part === "number");

/** Whether values go on at the slope of their ends: numbers do, a type that is known says so. */
function goesOn(context: EditContext, values: readonly Value[]): boolean {
  if (context.type !== undefined) return isNumeric(context.type);
  return values.length > 0 && values.every((value) => typeof value === "number");
}

/** Whether shaking does something to values: numbers, angles and vectors. */
function shakes(context: EditContext, values: readonly Value[]): boolean {
  if (context.type !== undefined) return canShake(context.type);
  return (
    values.length > 0 && values.every((value) => typeof value === "number" || isNumbers(value))
  );
}

const needContext = (context: EditContext | undefined): EditContext => {
  if (!context) throw new Error("setExtend and setNoise need to know about the property");
  return context;
};

function withExtend(
  keyed: Animation | undefined,
  { before, after }: Pick<Animation, "before" | "after">,
  context: EditContext,
): Animation {
  const { path } = context;
  if (!keyed) return fail("invalid-value", { rule: "extend-needs-keys", path });
  if ((before === "continue" || after === "continue") && !goesOn(context, valuesIn(keyed))) {
    fail("invalid-value", { rule: "continue-needs-numbers", path });
  }
  const next: { -readonly [K in keyof Animation]: Animation[K] } = { ...keyed };
  for (const [side, mode] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (mode === undefined) continue;
    // Holding is what a value does anyway, so it is not written.
    if (mode === "hold") delete next[side];
    else next[side] = mode;
  }
  return next;
}

type Noise = NonNullable<Animation["modifiers"]>[number];

function withNoise(
  value: PropertyValue | undefined,
  noise: z.output<typeof NoiseEdit> | null,
  context: EditContext,
): PropertyValue | undefined {
  const keyed = value !== undefined && isAnimation(value) ? value : undefined;
  const others = (keyed?.modifiers ?? []).filter((modifier) => modifier.type !== "noise");
  const had = keyed?.modifiers?.find((modifier): modifier is Noise => modifier.type === "noise");
  if (noise === null) {
    if (!keyed || !had) return value;
    const { modifiers: _modifiers, ...rest } = keyed;
    return others.length > 0 ? { ...rest, modifiers: others } : rest;
  }
  const { path } = context;
  const start = value ?? context.fallback;
  if (!shakes(context, valuesIn(start)))
    fail("invalid-value", { rule: "noise-needs-numbers", path });
  const frequency = noise.frequency ?? had?.frequency;
  const shaking: Noise = {
    type: "noise",
    amount: noise.amount,
    ...(frequency !== undefined && { frequency }),
    seed: noise.seed ?? had?.seed ?? context.seed,
  };
  const animation: Animation = keyed ?? {
    keys: [{ time: context.firstFrame, value: start as Value }],
  };
  return { ...animation, modifiers: [...others, shaking] };
}

/** What `retimeKeys` does to a value, with the keys that gave way. */
export function retimedValue(
  value: PropertyValue | undefined,
  edit: Extract<ValueEdit, { op: "retimeKeys" }>,
  context: EditContext | undefined,
): Retimed {
  const keyed = value !== undefined && isAnimation(value) ? value : undefined;
  return retimeKeys(keyed, edit, context?.path ?? "", context?.frames);
}

/**
 * What a property holds after an edit, and undefined when nothing is left of it. Previewing, trying
 * out and writing all come through here, so what people see is what gets saved. Fails when an edit
 * is about a key that is not there. `setExtend` and `setNoise` need `context` (`editContextOf`).
 */
export function applyEdit(
  value: PropertyValue | undefined,
  edit: ValueEdit,
  context?: EditContext,
): PropertyValue | undefined {
  const keyed = value !== undefined && isAnimation(value) ? value : undefined;
  switch (edit.op) {
    case "write":
      return keyed ? withKey(keyed, edit.time, edit.value) : edit.value;
    case "setKey":
      return withKey(keyed ?? NO_KEYS, edit.time, edit.value);
    case "removeKey":
      return withoutKey(value, edit.time);
    case "moveKey":
      return withKeysMoved(keyed, edit.moves);
    case "setInterp":
      return withEase(keyed, edit.times, edit.ease);
    case "putKeys":
      return { ...(keyed ?? NO_KEYS), keys: placed(keyed?.keys ?? [], edit.keys) as Key[] };
    case "setExtend":
      return withExtend(keyed, edit, needContext(context));
    case "setNoise":
      return withNoise(value, edit.noise, needContext(context));
    case "retimeKeys":
      return retimedValue(value, edit, context).value;
    case "set":
      return edit.value;
    case "clear":
      return undefined;
  }
}
