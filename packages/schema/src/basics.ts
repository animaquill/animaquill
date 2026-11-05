import { z } from "zod";
import { TIME_PATTERN, compare, normalizeTime, parseTime, ZERO } from "./time.ts";

declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

/**
 * A stable name for something in a project. Ids also become folder names, and project files come
 * from other people, so an id can never leave its folder: no dots, no slashes.
 */
export const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "只能用英文字母、数字、下划线和连字符，不能以符号开头")
  .max(64);

/** A language tag such as zh-CN. Also a file name, so the same rule applies. */
export const LanguageId = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "语言要写成 zh-CN 这样的标记");

/** The name of something added by a plugin: a dot keeps it apart from what is built in. */
export const ExtensionName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/, "要写成 blur 或 plugin.effect 这样的名称");

export const Color = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "颜色要写成 #rrggbb 或 #rrggbbaa")
  .overwrite((color) => color.toLowerCase());

/** Only https: Git would run a command for an ext:: address, and projects are not trusted. */
export const HttpsUrl = z.string().regex(/^https:\/\/\S+$/, "只支持 https 地址");

/** A file inside the project or library. It can never point outside. */
export const RelativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "要写成项目内的相对路径，不能用 ..、反斜杠或绝对路径",
  );

const isNotNegative = (time: string) =>
  !TIME_PATTERN.test(time) || compare(parseTime(time), ZERO) >= 0;
const isPositive = (time: string) => !TIME_PATTERN.test(time) || compare(parseTime(time), ZERO) > 0;

const anyTime = z
  .string()
  .regex(TIME_PATTERN, '时间要写成字符串，单位是秒，比如 "12.5" 或 "1001/30000"')
  .overwrite(normalizeTime);

/** Frames per second, as exact as a time, for rates such as 30000/1001. */
export const Rate = z
  .string()
  .regex(TIME_PATTERN, '帧率要写成字符串，比如 "30" 或 "30000/1001"')
  .overwrite(normalizeTime)
  .refine(isPositive, "帧率要大于 0");

/** A moment or length in seconds. See time.ts. */
export const Time = anyTime.refine(isNotNegative, "时间不能是负数");
export const Duration = anyTime.refine(isPositive, "时长要大于 0");

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;

/** A new id such as clip_x7k2m9q4ab. Long enough for many people and AI tasks working at once. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let suffix = "";
  for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${suffix}`;
}

/** Things in time order, which is how people and AI tools read them. */
export function sortByTime<T extends { readonly id: string }>(
  items: T[],
  timeOf: (item: T) => string,
): T[] {
  if (!items.every((item) => TIME_PATTERN.test(timeOf(item)))) return items;
  return items.toSorted(
    (a, b) => compare(parseTime(timeOf(a)), parseTime(timeOf(b))) || a.id.localeCompare(b.id),
  );
}

export const sortById = <T extends { readonly id: string }>(items: T[]): T[] =>
  items.toSorted((a, b) => a.id.localeCompare(b.id));

/** Sorts the keys of a map, so that a file does not change just because of insertion order. */
export function sortKeys<T>(map: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(map).toSorted()) sorted[key] = map[key] as T;
  return sorted;
}
