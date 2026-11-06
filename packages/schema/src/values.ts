import { z } from "zod";
import { Id, RelativePath, Time, sortKeys } from "./basics.ts";
import { isKnownProperty, propertyValueProblem } from "./properties.ts";
import { compare, parseTime } from "./time.ts";

/** A file of the project, by its entry in assets.json, or a file of a linked library. */
export const MediaRef = z.union([
  z.strictObject({ asset: Id }),
  z.strictObject({ library: Id, path: RelativePath }),
]);

/** Text from the string tables, so that it can be translated. */
export const StringRef = z.strictObject({ string: z.string().min(1) });

/** A plain value, such as a position, a color or a choice. */
export const Value = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number()),
  StringRef,
  MediaRef,
]);

/** As in CSS: time has to go forwards, so x stays within the segment, and y can overshoot. */
const Handle = z.tuple([z.number().min(0).max(1), z.number()]);

/** How a value changes from one key to the next. Times are on the clock of the clip: see `offset`. */
export const Key = z
  .strictObject({
    time: Time,
    value: Value,
    interp: z.enum(["linear", "bezier", "hold", "spring", "preset"]).optional(),
    /** Bezier handle leaving this key, as in CSS: x and y relative to the segment. */
    out: Handle.optional(),
    /** Bezier handle arriving at this key. */
    in: Handle.optional(),
    tangent: z.enum(["auto", "aligned", "broken"]).optional(),
    preset: z.string().min(1).optional(),
    spring: z
      .strictObject({
        stiffness: z.number().positive(),
        damping: z.number().nonnegative(),
        mass: z.number().positive().optional(),
      })
      .optional(),
  })
  .superRefine((key, context) => {
    const needs = (field: "out" | "preset" | "spring", message: string) => {
      if (key[field] === undefined) context.addIssue({ code: "custom", path: [field], message });
    };
    if (key.interp === "bezier") needs("out", "贝塞尔关键帧要有 out 手柄");
    if (key.interp === "preset") needs("preset", "预设关键帧要写 preset 名称");
    if (key.interp === "spring") needs("spring", "弹簧关键帧要写 spring 参数");
  });

const Extrapolation = z.enum(["hold", "loop", "pingpong", "continue"]);

/** Random shaking on top of the keys. The seed is required: rendering has to be repeatable. */
export const Modifier = z.strictObject({
  type: z.literal("noise"),
  amount: z.number(),
  frequency: z.number().positive().optional(),
  seed: z.number().int(),
});

export const Animation = z
  .strictObject({
    keys: z.array(Key).min(1),
    before: Extrapolation.optional(),
    after: Extrapolation.optional(),
    modifiers: z.array(Modifier).optional(),
  })
  .superRefine(({ keys }, context) => {
    keys.forEach((key, index) => {
      const previous = keys[index - 1];
      if (previous && compare(parseTime(previous.time), parseTime(key.time)) >= 0) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "time"],
          message: "关键帧要按时间从小到大排列，同一时刻只能有一个",
        });
      }
    });
  });

/** A property holds one value, or keys that change it over time. */
export const PropertyValue = z.union([Value, Animation]);

/**
 * One part of a path has the characters of an id. It cannot be a name that means something to a
 * JavaScript object, because the content of a project is not to be trusted.
 */
const PATH_PART = "(?!(?:constructor|prototype)(?:\\.|$))[A-Za-z0-9][A-Za-z0-9_-]*";

/**
 * Where a property lives. Built-in ones are listed in properties.ts. The others come from what a
 * clip contains: "param.title", "object.arm.x", "object.rig.arm_l.rotation", "element.logo.opacity".
 * A path holds stable ids only, no display names and no hierarchy: it is the key of the stored
 * values, so renaming something or giving it a new parent must not change it.
 */
export const PropertyPath = z
  .string()
  .regex(
    new RegExp(`^${PATH_PART}(?:\\.${PATH_PART})*$`),
    "属性路径要写成 transform.x 这样，用点分隔，每一段只能用英文字母、数字、下划线和连字符",
  );

/** Sorted, so that a file only changes when a value does. */
export const Properties = z.record(PropertyPath, PropertyValue).overwrite(sortKeys);

/** Whether a property changes over time. A list of numbers is a value, and it has `keys` too. */
export const isAnimation = (value: z.output<typeof PropertyValue>): value is Animation =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "keys" in value;

/** The plain values of a property, whether it has keys or not. */
const valuesOf = (value: z.output<typeof PropertyValue>) =>
  isAnimation(value) ? value.keys.map((key) => key.value) : [value];

/** Finds misspelled names and impossible values, for one property. */
export function checkProperty(
  path: string,
  value: z.output<typeof PropertyValue> | undefined,
  report: (message: string) => void,
): void {
  if (!isKnownProperty(path)) {
    report(`没有这个属性：${path}。场景参数写成 param.名称`);
    return;
  }
  if (value === undefined) return;
  for (const item of valuesOf(value)) {
    const problem = propertyValueProblem(path, item);
    if (problem) report(problem);
  }
}

/** Properties of clips, tracks and buses, which the editor knows. Effects define their own. */
export const KnownProperties = Properties.superRefine((properties, context) => {
  for (const [path, value] of Object.entries(properties)) {
    checkProperty(path, value, (message) => {
      context.addIssue({ code: "custom", path: [path], message });
    });
  }
});

export type Value = z.output<typeof Value>;
export type Key = z.output<typeof Key>;
export type Animation = z.output<typeof Animation>;
export type PropertyValue = z.output<typeof PropertyValue>;
export type Properties = z.output<typeof Properties>;
export type MediaRef = z.output<typeof MediaRef>;
