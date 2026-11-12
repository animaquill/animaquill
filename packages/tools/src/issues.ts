import { z } from "zod";
import { didYouMean } from "./similar.ts";

/**
 * What zod finds wrong with parameters, in English that says how to write them: the place, what it
 * has to be and, for a name that is almost right, which one was meant. The format writes some of
 * its rules in Chinese for people; they have their English here.
 */

/** What the rules of the format and of the operations say, in English, by their own words. */
const RULES: Readonly<Record<string, string>> = {
  "只能用英文字母、数字、下划线和连字符，不能以符号开头":
    "an id: letters, digits, _ and -, starting with a letter or digit, at most 64 characters",
  "语言要写成 zh-CN 这样的标记": 'a language tag such as "zh-CN"',
  "要写成 blur 或 plugin.effect 这样的名称": 'a name such as "blur" or "plugin.effect"',
  "颜色要写成 #rrggbb 或 #rrggbbaa": 'a color such as "#rrggbb" or "#rrggbbaa"',
  "只支持 https 地址": "an https address",
  '时间要写成字符串，单位是秒，比如 "12.5" 或 "1001/30000"':
    'a time: seconds as a string, such as "12.5" or "1001/30000"',
  '帧率要写成字符串，比如 "30" 或 "30000/1001"':
    'a frame rate as a string, such as "30" or "30000/1001"',
  "帧率要大于 0": "a frame rate above 0",
  时间不能是负数: "a time of 0 or more",
  "时长要大于 0": "a length above 0",
  标签不能重复: "tags without repeats",
  "要写成 sha256-…": 'a hash such as "sha256-…"',
  "要写成 Git 提交的十六进制编号": "a Git commit, in hexadecimal",
  参数名不能有空格和点: "a parameter name without spaces or dots",
  "关键帧要按时间从小到大排列，同一时刻只能有一个":
    "keys in order of their time, at most one at a time",
  "贝塞尔关键帧要有 out 手柄": 'an "out" handle, for a key with interp "bezier"',
  "预设关键帧要写 preset 名称": 'a "preset" name, for a key with interp "preset"',
  "弹簧关键帧要写 spring 参数": 'the "spring" values, for a key with interp "spring"',
  "属性路径要写成 transform.x 这样，用点分隔，每一段只能用英文字母、数字、下划线和连字符":
    'a property path such as "transform.x": parts of letters, digits, _ and -, joined by dots',
  "scope 至少要有 language 或 format": "a scope with a language or a format",
  "要写 enter 或 exit": "enter or exit, or both",
  "要写 enabled、start 或 end": "enabled, start or end",
  "scale 不能是 0": "a scale other than 0",
  "from 和 to 要么都是一个属性，要么都以 .* 结尾":
    'from and to both one property, or both ending in ".*"',
  "只能写 scenes、sounds、code 里的代码文件": "a code file under scenes/, sounds/ or code/",
  这个名字的文件不会跟项目走: "no file or folder whose name starts with a dot, nor node_modules",
  文件要放在场景或声音的文件夹里: "a file inside the folder of a scene or a sound",
  "场景要写 scene，或者同时写 library 和 resource": "scene, or both library and resource",
  "声音要写 sound，或者同时写 library 和 resource": "sound, or both library and resource",
  "转场要写 type、transition，或者同时写 library 和 resource":
    "type or transition, or both library and resource",
};

/** What the format says about values, as `specValueProblem` and the checks of documents word it. */
const PATTERNS: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [/^(.+) 要写成数字$/, ([, path]) => `${path} has to be a number`],
  [/^(.+) 不能小于 (.+)$/, ([, path, min]) => `${path} cannot be less than ${min}`],
  [/^(.+) 不能大于 (.+)$/, ([, path, max]) => `${path} cannot be more than ${max}`],
  [/^(.+) 要写成 true 或 false$/, ([, path]) => `${path} has to be true or false`],
  [
    /^(.+) 只能是：(.+)$/,
    ([, path, options]) => `${path} has to be one of ${options?.replaceAll("、", ", ")}`,
  ],
  [/^(.+) 要写成文字$/, ([, path]) => `${path} has to be a string`],
  [/^(.+) 要写成素材引用$/, ([, path]) => `${path} has to be an asset reference`],
  [/^(.+) 要写成 #rrggbb 或 #rrggbbaa$/, ([, path]) => `${path} has to be a color "#rrggbb"`],
  [/^(.+) 要写成 (\d+) 个数字$/, ([, path, count]) => `${path} has to be ${count} numbers`],
  [/^(.+) 要写成 一组 个数字$/, ([, path]) => `${path} has to be an array of numbers`],
  [/^(.+) 不能打关键帧$/, ([, path]) => `${path} cannot have keys`],
  [/^(?:效果 )?ID 重复：(.+)$/, ([, id]) => `the id ${id} is there twice`],
  [
    /^(\w+) 轨道不能放 (.+) 片段$/,
    ([, track, kind]) => `a ${track} track cannot hold a ${kind} clip`,
  ],
];

/** Chinese, which no text for AI should have but what the project itself holds. */
export const HAS_CHINESE = /[㐀-鿿　-〿＀-￯]/;

/** A rule of the format in English, or an English word for it when there is none. */
export function englishRule(message: string): string {
  const known = RULES[message];
  if (known !== undefined) return `has to be ${known}`;
  for (const [pattern, word] of PATTERNS) {
    const match = message.match(pattern);
    if (match) return word(match);
  }
  return HAS_CHINESE.test(message) ? "does not fit the project format" : message;
}

/** Parameters that are times, which have to be strings. */
const TIMES = new Set(["start", "end", "at", "duration", "time", "offset", "from", "to"]);

/** The schema at a place of parameters, where one can be told, for the names that fit there. */
function schemaAt(schema: z.ZodType, path: readonly PropertyKey[]): z.ZodType | undefined {
  let node: z.ZodType | undefined = schema;
  for (const key of path) {
    node = unwrap(node);
    if (!node) return undefined;
    if (node instanceof z.ZodObject) node = (node.shape as Record<string, z.ZodType>)[String(key)];
    else if (node instanceof z.ZodArray) node = node.element as z.ZodType;
    else if (node instanceof z.ZodRecord) node = node.valueType as z.ZodType;
    else return undefined;
  }
  return unwrap(node);
}

function unwrap(schema: z.ZodType | undefined): z.ZodType | undefined {
  let node = schema;
  for (let depth = 0; node && depth < 10; depth += 1) {
    const def = (node as { def?: { type?: string; innerType?: z.ZodType; in?: z.ZodType } }).def;
    if (def?.innerType) node = def.innerType;
    else if (def?.type === "pipe" && def.in) node = def.in;
    else break;
  }
  return node;
}

/** The names an object takes at a place, for saying which ones there are. */
export function namesAt(schema: z.ZodType, path: readonly PropertyKey[]): readonly string[] {
  const node = schemaAt(schema, path);
  return node instanceof z.ZodObject ? Object.keys(node.shape) : [];
}

/** The type of a value, as an error says what came instead. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "string") return `the string ${JSON.stringify(value.slice(0, 40))}`;
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let node = input;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** Where in parameters, as JSON paths read: `clips[0].start`. */
export function placeOf(path: readonly PropertyKey[], prefix = ""): string {
  let place = prefix;
  for (const key of path) {
    place += typeof key === "number" ? `[${key}]` : place === "" ? String(key) : `.${String(key)}`;
  }
  return place;
}

/** One thing wrong with parameters, as one line. */
/** What a parameter that is missing looks like, for the ones most often left out. */
const SUCH_AS: Readonly<Record<string, string>> = {
  source: '{"kind":"color","color":"#3366ff"}',
  start: '"0"',
  duration: '"2.5"',
  time: '"1.5"',
  timeline: '"main"',
};

/** Where in the parameters an issue is, as zod paths have it. */
type Where = readonly PropertyKey[];

/**
 * Of the branches of a union that all failed, the one the parameters were most likely meant for:
 * the one that got furthest into them, then the one with the fewest faults.
 */
function likeliest(errors: readonly (readonly z.core.$ZodIssue[])[]): readonly z.core.$ZodIssue[] {
  let best: readonly z.core.$ZodIssue[] = [];
  let bestDepth = -1;
  for (const branch of errors) {
    const depth = Math.max(...branch.map((issue) => issue.path.length));
    if (depth > bestDepth || (depth === bestDepth && branch.length < best.length)) {
      best = branch;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * One thing wrong with parameters, as one line or a few: where, and how it should be. `hidden`
 * names parameters AI does not see, by their dotted paths, which no hint offers.
 */
export function issueLine(
  issue: z.core.$ZodIssue,
  schema: z.ZodType,
  input: unknown,
  prefix = "",
  hidden: readonly string[] = [],
  base: Where = [],
): string {
  const path: Where = [...base, ...issue.path];
  const place = placeOf(path, prefix) || "the parameters";
  if (issue.code === "unrecognized_keys") {
    const at = path.map(String).join(".");
    const names = namesAt(schema, path).filter(
      (name) => !hidden.includes(at === "" ? name : `${at}.${name}`),
    );
    return issue.keys
      .map((key) => {
        const meant = didYouMean(key, names);
        const hint = meant ? `; did you mean "${meant}"?` : "";
        const listed = names.length > 0 ? ` Parameters here: ${names.join(", ")}.` : "";
        return `${place}: unknown parameter "${key}"${hint}${listed}`;
      })
      .join("\n  ");
  }
  const given = valueAt(input, path);
  const last = path.at(-1);
  if (given === undefined) {
    const example = typeof last === "string" ? SUCH_AS[last] : undefined;
    return `${place}: missing${example ? `; such as ${example}` : ""}`;
  }
  if (issue.code === "invalid_type") {
    const isTime = typeof last === "string" && TIMES.has(last) && issue.expected === "string";
    const expected = isTime ? 'a time: seconds as a string, such as "12.5"' : issue.expected;
    return `${place}: expected ${expected}, got ${typeOf(given)}`;
  }
  if (issue.code === "invalid_value") {
    const options = issue.values.map((value) => JSON.stringify(value)).join(" or ");
    return `${place}: expected ${options}, got ${typeOf(given)}`;
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    return `${place}: ${issue.message.replace(/^Too (small|big): /, "")}`;
  }
  if (issue.code === "invalid_union") {
    const { discriminator, options } = issue as {
      discriminator?: string;
      options?: readonly unknown[];
    };
    if (discriminator !== undefined && options && options.length > 0) {
      // Zod puts the discriminator at the end of the path, or not, by version: take either.
      const atKey = path.at(-1) === discriminator;
      const value = atKey ? given : (given as Record<string, unknown> | null)?.[discriminator];
      const where = placeOf(atKey ? path : [...path, discriminator], prefix);
      const names = options.map((option) => String(option));
      const meant = typeof value === "string" ? didYouMean(value, names) : undefined;
      const hint = meant ? `; did you mean "${meant}"?` : "";
      const listed = names.map((name) => JSON.stringify(name)).join(", ");
      if (value === undefined) return `${where}: missing; one of ${listed}`;
      return `${where}: expected one of ${listed}, got ${typeOf(value)}${hint}`;
    }
    const branch = likeliest(issue.errors);
    if (branch.length === 0) return `${place}: does not fit any of the shapes it can have`;
    return branch
      .slice(0, 3)
      .map((inner) => issueLine(inner, schema, input, prefix, hidden, path))
      .join("\n  ");
  }
  return `${place}: ${englishRule(issue.message)}`;
}
