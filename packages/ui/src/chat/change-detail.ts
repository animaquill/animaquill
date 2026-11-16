import {
  clipEnd,
  clipStart,
  compileChannel,
  deepEqual,
  entryOf,
  getIn,
  pathOfObject,
  sample,
  secondsOf,
  type BeforeAfter,
  type ClipState,
  type ProjectState,
  type TimelineState,
} from "@animaquill/core";
import {
  BUILT_IN_PROPERTIES,
  COLOR_PATTERN,
  TIME_PATTERN,
  isAnimation,
  parseTime,
  toSeconds,
  type PropertyValue,
  type Value,
  type ValueType,
} from "@animaquill/schema";
import type { TurnChange } from "./summary.ts";

/**
 * What one line of the card of a task shows when it opens (S-D1, the design of changes and gates,
 * section 1): each field it changed before and after, keys as two curves, code line by line, and
 * where the picture changed, the moment to show before and after. All from the undo log of the task
 * (`ProjectStore.beforeAfterOf`), which only this device has: without it a line does not open.
 */

export interface FieldDetail {
  /** As the tools name it: `duration`, `properties.opacity`, `enter.type`. */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface CodeDetail {
  readonly path: string;
  /** Undefined where the file was not there. */
  readonly before: string | undefined;
  readonly after: string | undefined;
  /** Too long to compare in the card: only in the code editor. */
  readonly large: boolean;
}

/** A moment of a timeline that shows what changed. */
export interface PictureAt {
  readonly timeline: string;
  readonly seconds: number;
}

export interface ChangeDetail {
  readonly fields: readonly FieldDetail[];
  readonly code?: CodeDetail;
  readonly picture?: PictureAt;
  /** The clock of the clip, in seconds, which its keys are on. */
  readonly clock?: { readonly from: number; readonly to: number };
}

/** Longer than this, code is compared in the code editor only. */
export const LARGE_TEXT = 200_000;

/** Fields of a clip that change nothing in the picture. */
const UNSEEN_FIELDS = new Set(["name", "link"]);

/** Tracks whose clips are in the picture. */
const SEEN_TRACKS = new Set(["video", "caption"]);

/** Where a field the tools named is in the object. Properties have dots in their names. */
function pathOfField(at: readonly string[], field: string): readonly string[] {
  if (field.startsWith("properties.")) return [...at, "properties", field.slice(11)];
  if (field.startsWith("effects.")) {
    const rest = field.slice(8);
    const dot = rest.indexOf(".");
    return dot < 0
      ? [...at, "effects", rest]
      : [...at, "effects", rest.slice(0, dot), rest.slice(dot + 1)];
  }
  return [...at, ...field.split(".")];
}

const clipsOf = (state: ProjectState, timeline: string) =>
  entryOf(state.timelines, timeline)?.clips ?? {};

/** Whether a clip is in the picture: on a track that shows. */
function isSeen(timeline: TimelineState | undefined, clip: ClipState): boolean {
  const track = timeline && entryOf(timeline.tracks, clip.track);
  return track !== undefined && SEEN_TRACKS.has(track.kind);
}

const middleOf = (clip: ClipState) => (toSeconds(clipStart(clip)) + toSeconds(clipEnd(clip))) / 2;

/** The first clip in the picture that shows a scene, on the timeline people look at first. */
function sceneMoment(
  states: readonly ProjectState[],
  scene: string,
  shown: string | undefined,
): PictureAt | undefined {
  for (const state of states) {
    const timelines = Object.keys(state.timelines).toSorted((a, b) =>
      a === shown ? -1 : b === shown ? 1 : 0,
    );
    for (const id of timelines) {
      const timeline = entryOf(state.timelines, id);
      const first = Object.values(timeline?.clips ?? {})
        .filter(
          (clip) =>
            clip.source.kind === "scene" &&
            (clip.source as { scene?: string }).scene === scene &&
            isSeen(timeline, clip),
        )
        .toSorted((a, b) => toSeconds(clipStart(a)) - toSeconds(clipStart(b)))[0];
      if (first) return { timeline: id, seconds: middleOf(first) };
    }
  }
  return undefined;
}

/** Where the picture shows what changed, if it does. */
function pictureOf(
  change: TurnChange,
  { before, after }: BeforeAfter,
  shown: string | undefined,
): PictureAt | undefined {
  const timeline = change.timeline;
  const either = [after, before];
  if (change.kind === "clip" && timeline !== undefined) {
    if (change.fields.length > 0 && change.fields.every(({ path }) => UNSEEN_FIELDS.has(path))) {
      return undefined;
    }
    for (const state of either) {
      const clip = entryOf(clipsOf(state, timeline), change.id);
      if (clip) {
        return isSeen(entryOf(state.timelines, timeline), clip)
          ? { timeline, seconds: middleOf(clip) }
          : undefined;
      }
    }
    return undefined;
  }
  if (change.kind === "join" && timeline !== undefined) {
    for (const state of either) {
      const line = entryOf(state.timelines, timeline);
      const join = entryOf(line?.joins, change.id);
      const from = join?.from === undefined ? undefined : entryOf(line?.clips, join.from);
      if (from)
        return isSeen(line, from) ? { timeline, seconds: toSeconds(clipEnd(from)) } : undefined;
    }
    return undefined;
  }
  if (change.kind === "scene") return sceneMoment(either, change.id, shown);
  if (change.kind === "file") {
    const scene = /^scenes\/([^/]+)\//.exec(change.id)?.[1];
    return scene === undefined ? undefined : sceneMoment(either, scene, shown);
  }
  return undefined;
}

/**
 * Whether a line has more to show than its sentence, before working any of it out: surely for code
 * and fields, maybe for what can be in the picture, which depends on where it is.
 */
export function mayOpen(change: TurnChange): "surely" | "maybe" | "never" {
  if (change.kind === "file") return "surely";
  if (change.change === "changed" && change.fields.some(({ path }) => path !== "position")) {
    return "surely";
  }
  return change.kind === "clip" || change.kind === "join" || change.kind === "scene"
    ? "maybe"
    : "never";
}

/**
 * What a line shows when it opens, or undefined where there is nothing beyond its sentence: a clip
 * on a track that is not in the picture that went away, say.
 */
export function detailOf(
  change: TurnChange,
  seen: BeforeAfter,
  shown?: string,
): ChangeDetail | undefined {
  const at = pathOfObject({
    kind: change.kind,
    id: change.id,
    ...(change.timeline !== undefined && { timeline: change.timeline }),
  });
  let code: CodeDetail | undefined;
  if (change.kind === "file") {
    const was = getIn(seen.before, at);
    const is = getIn(seen.after, at);
    const before = typeof was === "string" ? was : undefined;
    const after = typeof is === "string" ? is : undefined;
    if (before !== after) {
      const large = Math.max(before?.length ?? 0, after?.length ?? 0) > LARGE_TEXT;
      code = { path: change.id, before, after, large };
    }
  }
  const fields =
    change.kind === "file" || change.change !== "changed"
      ? []
      : change.fields.flatMap(({ path }): FieldDetail[] => {
          const where = pathOfField(at, path);
          const before = getIn(seen.before, where);
          const after = getIn(seen.after, where);
          return deepEqual(before, after) ? [] : [{ path, before, after }];
        });
  const picture = pictureOf(change, seen, shown);
  if (fields.length === 0 && !code && !picture) return undefined;
  const clip =
    change.kind === "clip" && change.timeline !== undefined
      ? (entryOf(clipsOf(seen.after, change.timeline), change.id) ??
        entryOf(clipsOf(seen.before, change.timeline), change.id))
      : undefined;
  const offset = clip?.offset === undefined ? 0 : toSeconds(parseTime(clip.offset));
  return {
    fields,
    ...(code && { code }),
    ...(picture && { picture }),
    ...(clip && {
      clock: { from: offset, to: offset + toSeconds(parseTime(clip.duration)) },
    }),
  };
}

/** How a value shows, the way the properties panel shows it. */
export type ValueShape =
  | { readonly kind: "none" }
  | { readonly kind: "time"; readonly seconds: number }
  | { readonly kind: "color"; readonly color: string }
  | { readonly kind: "boolean"; readonly on: boolean }
  | { readonly kind: "text"; readonly text: string };

/** Fields that hold a time: where a clip starts, how long it or a transition takes. */
const isTimeField = (path: string) => /(^|\.)(start|duration|offset)$/.test(path);

/** As long as a value of something else gets in one line. */
const MOST_CHARACTERS = 60;

const numberText = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * A value as it counts: a built-in property that is not there has its default, as the properties
 * panel shows it.
 */
export function valueOf(path: string, value: unknown): unknown {
  if (value !== undefined || !path.startsWith("properties.")) return value;
  const property = path.slice(11);
  return Object.hasOwn(BUILT_IN_PROPERTIES, property)
    ? BUILT_IN_PROPERTIES[property]?.default
    : undefined;
}

export function shapeOf(path: string, given: unknown): ValueShape {
  const value = valueOf(path, given);
  if (value === undefined || value === null) return { kind: "none" };
  if (typeof value === "boolean") return { kind: "boolean", on: value };
  if (typeof value === "number") return { kind: "text", text: numberText(value) };
  if (typeof value === "string") {
    if (isTimeField(path) && TIME_PATTERN.test(value)) {
      return { kind: "time", seconds: toSeconds(parseTime(value)) };
    }
    if (COLOR_PATTERN.test(value)) return { kind: "color", color: value };
    return { kind: "text", text: value };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return { kind: "text", text: value.map(numberText).join(", ") };
  }
  const text = JSON.stringify(value);
  return {
    kind: "text",
    text: text.length > MOST_CHARACTERS ? `${text.slice(0, MOST_CHARACTERS - 1)}…` : text,
  };
}

/** Whether a field has keys on either side. */
export const hasKeys = ({ before, after }: FieldDetail): boolean =>
  isAnimation(before as PropertyValue) || isAnimation(after as PropertyValue);

/** The values a property takes, keys or not. */
function valuesOf(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return isAnimation(value as PropertyValue)
    ? (value as { keys: readonly { value: unknown }[] }).keys.map((key) => key.value)
    : [value];
}

/** What a property of numbers is, so that its curve can be worked out; undefined for any other. */
function numericType({ path, before, after }: FieldDetail): ValueType | undefined {
  const values = [...valuesOf(valueOf(path, before)), ...valuesOf(valueOf(path, after))];
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "number" && Number.isFinite(value))) return "number";
  const [first] = values;
  if (!Array.isArray(first)) return undefined;
  const size = first.length;
  const isVector = values.every(
    (value) =>
      Array.isArray(value) &&
      value.length === size &&
      value.every((item) => typeof item === "number" && Number.isFinite(item)),
  );
  if (!isVector) return undefined;
  return size === 2 ? "vec2" : size === 3 ? "vec3" : size === 4 ? "vec4" : "numbers";
}

/** One curve of the chart of keys: points as SVG has them. */
export interface ChartLine {
  readonly side: "before" | "after";
  readonly points: string;
}

export interface ChartDot {
  readonly side: "before" | "after";
  readonly x: number;
  readonly y: number;
}

export interface KeysChart {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly ChartLine[];
  readonly dots: readonly ChartDot[];
}

/** How many points a curve has: enough for the width of a card. */
const SAMPLES = 64;
const PAD = 4;

const keyTimes = (value: unknown): readonly number[] =>
  isAnimation(value as PropertyValue)
    ? (value as { keys: readonly { time: string }[] }).keys.map((key) => secondsOf(key.time))
    : [];

/**
 * Keys of numbers before and after, as two curves over the clock of the clip, each key a dot.
 * Undefined where the values are not numbers: those list their keys instead.
 */
export function keysChart(
  field: FieldDetail,
  clock: ChangeDetail["clock"],
  width = 240,
  height = 56,
): KeysChart | undefined {
  const type = numericType(field);
  if (!type) return undefined;
  const times = [...keyTimes(field.before), ...keyTimes(field.after)].filter(Number.isFinite);
  let from = Math.min(clock?.from ?? Infinity, ...times);
  let to = Math.max(clock?.to ?? -Infinity, ...times);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  if (to - from <= 0) {
    from -= 0.5;
    to += 0.5;
  }
  const sides = (["before", "after"] as const).flatMap((side) => {
    const value = valueOf(field.path, field[side]);
    const channel = compileChannel(value as PropertyValue | undefined, type);
    if (!channel) return [];
    const samples = Array.from({ length: SAMPLES }, (_, index) => {
      const time = from + ((to - from) * index) / (SAMPLES - 1);
      return [time, sample(channel, time)] as const;
    });
    const keys = isAnimation(value as PropertyValue)
      ? (value as { keys: readonly { time: string; value: Value }[] }).keys.map(
          (key) => [secondsOf(key.time), key.value] as const,
        )
      : [];
    return [{ side, samples, keys }];
  });
  const parts = (value: Value): readonly number[] =>
    typeof value === "number" ? [value] : (value as readonly number[]);
  const all = sides.flatMap(({ samples, keys }) =>
    [...samples, ...keys].flatMap(([, value]) => parts(value)),
  );
  let low = Math.min(...all);
  let high = Math.max(...all);
  if (high - low <= 0) {
    low -= 1;
    high += 1;
  }
  const x = (time: number) => PAD + ((time - from) / (to - from)) * (width - PAD * 2);
  const y = (value: number) => height - PAD - ((value - low) / (high - low)) * (height - PAD * 2);
  const round = (value: number) => Math.round(value * 10) / 10;
  const lines: ChartLine[] = [];
  const dots: ChartDot[] = [];
  for (const { side, samples, keys } of sides) {
    const count = parts(samples[0]?.[1] as Value).length;
    for (let part = 0; part < count; part++) {
      lines.push({
        side,
        points: samples
          .map(([time, value]) => `${round(x(time))},${round(y(parts(value)[part] as number))}`)
          .join(" "),
      });
      for (const [time, value] of keys) {
        dots.push({ side, x: round(x(time)), y: round(y(parts(value)[part] as number)) });
      }
    }
  }
  return { width, height, lines, dots };
}

/** The keys of a value as moments and values, for values that are not numbers. */
export function keysOf(
  value: unknown,
): readonly { readonly time?: number; readonly value: unknown }[] {
  if (value === undefined) return [];
  if (!isAnimation(value as PropertyValue)) return [{ value }];
  return (value as { keys: readonly { time: string; value: unknown }[] }).keys.map((key) => ({
    time: secondsOf(key.time),
    value: key.value,
  }));
}
