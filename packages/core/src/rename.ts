import {
  Id,
  PropertyPath,
  isAnimation,
  type Animation,
  type PropertyValue,
  type Value,
} from "@animaquill/schema";
import { z } from "zod";
import { fail } from "./draft.ts";

/** All properties under a path: `object.arm.*`. */
const WILDCARD = ".*";

export const isWildcard = (path: string): boolean => path.endsWith(WILDCARD);

/** A path, or all paths under one. */
const RenamedPath = z.union([
  PropertyPath,
  z
    .string()
    .refine(
      (path) => isWildcard(path) && PropertyPath.safeParse(path.slice(0, -WILDCARD.length)).success,
      "要写成属性路径，或者以 .* 结尾表示下面的全部属性，比如 object.arm.*",
    ),
]);

/**
 * Moves keys and values from one path to another, for when code renamed what they are about. A
 * change of unit can come along: what is stored becomes `value × scale + offset`, which only works
 * for numbers. Handles of keys are shares of the change between keys, so they stay as they are.
 */
export const PropertyRename = z
  .strictObject({
    owner: z.strictObject({ clip: Id }),
    from: RenamedPath,
    to: RenamedPath,
    scale: z
      .number()
      .refine((scale) => scale !== 0, "scale 不能是 0")
      .optional(),
    offset: z.number().optional(),
  })
  .refine(({ from, to }) => isWildcard(from) === isWildcard(to), {
    message: "from 和 to 要么都是一个属性，要么都以 .* 结尾",
    path: ["to"],
  });

export type PropertyRename = z.output<typeof PropertyRename>;

/** A linear change of unit. Without one, values move as they are. */
export interface Conversion {
  readonly scale?: number | undefined;
  readonly offset?: number | undefined;
}

const isConversion = ({ scale = 1, offset = 0 }: Conversion) => scale !== 1 || offset !== 0;

/** Which paths a rename moves, and where to, out of the paths that are there. */
export function movesOf(
  paths: Iterable<string>,
  { from, to }: Pick<PropertyRename, "from" | "to">,
): readonly (readonly [string, string])[] {
  if (!isWildcard(from)) {
    for (const path of paths) if (path === from) return [[from, to]];
    return [];
  }
  const under = from.slice(0, -1);
  const into = to.slice(0, -1);
  const moves: (readonly [string, string])[] = [];
  for (const path of paths) {
    if (path.startsWith(under)) moves.push([path, `${into}${path.slice(under.length)}`]);
  }
  return moves;
}

function convertedNumber(value: Value, { scale = 1, offset = 0 }: Conversion): Value {
  if (typeof value === "number") return value * scale + offset;
  if (Array.isArray(value)) return value.map((part) => part * scale + offset);
  return fail("invalid-value", { rule: "scale-numbers-only" });
}

/** A value in another unit. Random shaking is as large as the value, so it scales along. */
export function convertedValue(value: PropertyValue, conversion: Conversion): PropertyValue {
  if (!isConversion(conversion)) return value;
  if (!isAnimation(value)) return convertedNumber(value, conversion);
  const { scale = 1 } = conversion;
  const animation: Animation = {
    ...value,
    keys: value.keys.map((key) => ({ ...key, value: convertedNumber(key.value, conversion) })),
  };
  const { modifiers } = value;
  if (!modifiers) return animation;
  return {
    ...animation,
    modifiers: modifiers.map((modifier) => ({
      ...modifier,
      amount: modifier.amount * Math.abs(scale),
    })),
  };
}

/** What takes a change of unit back. */
export function inverseOf({ scale = 1, offset = 0 }: Conversion): Conversion {
  return isConversion({ scale, offset }) ? { scale: 1 / scale, offset: -offset / scale } : {};
}
