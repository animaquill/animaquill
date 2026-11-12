import { aiTask, ProblemSet, type ProjectStore } from "@animaquill/core";
import { z } from "zod";
import { CallerState } from "../caller.ts";
import { AI_OPERATIONS } from "../schema.ts";
import { textKeys } from "../text-keys.ts";
import {
  DEFAULT_TEXTS,
  hashOf,
  systemPromptOf,
  type EditExample,
  type OperationExample,
  type TextValue,
} from "../texts/index.ts";
import { createToolset, DEFINITIONS } from "../toolset.ts";
import type { Tool, ToolHost } from "../types.ts";
import { hashOfPack, textsOf, withEdits } from "./apply.ts";
import {
  BUILTIN_PREFIX,
  MANIFEST,
  ManifestSchema,
  PACK_FORMAT,
  type CallSettings,
  type Manifest,
  type ModelPack,
  type PackEdit,
  type PackVariant,
} from "./format.ts";
import { hintsIn, type HintRule } from "./hints.ts";

/** What can be wrong with a pack, see `PackProblem`. */
export type PackProblemCode =
  /** There is no pack.json. */
  | "no-manifest"
  /** pack.json is not JSON. */
  | "not-json"
  /** It has scripts, which packs cannot have: they only declare. */
  | "scripts"
  /** A format of packs this version does not read. */
  | "format"
  /** A field the format does not have, such as a name of a tool or a schema. */
  | "unknown-field"
  /** A field of the wrong type or out of its range: `detail.message` says how. */
  | "invalid"
  /** Its id starts with "animaquill/", which is for AnimaQuill's own packs. */
  | "reserved-id"
  /** A file it names is not there, has the wrong kind or path, or is too large. */
  | "file-missing"
  | "file-path"
  | "file-type"
  | "file-size"
  /** All its files together are larger than a pack may be. */
  | "pack-size"
  /** A file is not UTF-8. */
  | "not-utf8"
  /** Characters that show differently from what a model reads, such as zero-width ones. */
  | "characters"
  /** Words for something the tools do not have, such as a tool or operation of another version. */
  | "unknown-key"
  /** Words name a tool, aq_…, that there is not. */
  | "unknown-tool"
  /** Words longer than they may be, or tools or a system prompt larger than they may be. */
  | "too-long"
  | "too-large"
  | "too-many-examples"
  /** An example does not fit the parameters of its operation. */
  | "example-invalid"
  /** An example does not run on the sample project. */
  | "example-fails"
  /** Long runs of empty lines or of spaces, which push words out of sight where people read them. */
  | "spacing"
  /** JSON nested deeper, or with more values, than any pack needs. */
  | "too-deep"
  /** A name or author that says it is AnimaQuill's own, which only built-in packs are. */
  | "reserved-name"
  /** A name or author with a space other than the plain one, or two in a row. */
  | "name-blank"
  /**
   * When loading: the default words a pack replaced changed with a new version of the tools, so its
   * words may say what is no longer so; those words are left out.
   */
  | "default-changed"
  /**
   * When loading: a pack that changes the guard or what the place says of itself lost some of its
   * words; it is not used until people install it again and see what it is now.
   */
  | "needs-review"
  /** The check itself failed: the pack is not used. */
  | "unexpected";

export interface PackProblem {
  readonly code: PackProblemCode;
  /** Where: a key of the words, a field of pack.json such as "variants[0].call", or a file. */
  readonly at: string;
  readonly detail?: Readonly<Record<string, string | number>>;
}

/** Words of a pack worth a look before installing it, see `HINT_RULES`. */
export interface PackHint {
  readonly at: string;
  readonly rules: readonly HintRule[];
}

export interface PackCheck {
  /** The pack, or nothing when it cannot be used. */
  readonly pack: ModelPack | undefined;
  /** Why it cannot be used: anything, when installing. */
  readonly problems: readonly PackProblem[];
  /**
   * When loading a pack that was installed before: words it has for what this version of the
   * tools does not have, which it goes without.
   */
  readonly dropped: readonly PackProblem[];
  readonly hints: readonly PackHint[];
}

/**
 * A file that was too large to read, with its size in bytes (or as much as was read of it before
 * it stopped): those who read a pack do not read such files whole, and the check says why.
 */
export interface PackFileTooLarge {
  readonly tooLarge: number;
}

/** The files of a pack by their paths in it, pack.json among them. */
export type PackFiles = ReadonlyMap<string, string | Uint8Array | PackFileTooLarge>;

export interface CheckOptions {
  /**
   * "install" takes nothing that does not pass. "load" is for a pack installed before: words for
   * keys this version does not have, or that name a tool it does not have, are left out.
   */
  readonly mode?: "install" | "load";
  /** It is one of AnimaQuill's own, which may have an id with "animaquill/". */
  readonly builtin?: boolean;
  /** A project to run the examples on, dry: the sample project, in tests and for authors. */
  readonly sample?: () => ProjectStore;
  /**
   * When loading: the default words of the keys the pack changes, as `defaultsOf` had them when it
   * was installed.
   */
  readonly defaults?: Readonly<Record<string, string>>;
}

/** A hash of the default words of a key, to tell later whether they changed. */
export function defaultHash(key: string): string {
  return hashOf(JSON.stringify(DEFAULT_TEXTS[key] ?? null));
}

/** The default words of every key a pack changes, as hashes, to keep with it when it is installed. */
export function defaultsOf(pack: ModelPack): Readonly<Record<string, string>> {
  const keys = [...pack.edits, ...pack.variants.flatMap(({ extra }) => (extra ? [extra] : []))].map(
    ({ key }) => key,
  );
  return Object.fromEntries(keys.map((key) => [key, defaultHash(key)]));
}

/** How large a file of a pack and a whole pack may be, in bytes of UTF-8. */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_PACK_BYTES = 256 * 1024;
/** How long the system prompt may be, all its parts together, in characters. */
export const MAX_SYSTEM = 12_000;
/**
 * How long the list of tools may be with a pack, in characters of JSON: names, descriptions and
 * schemas. The default one takes about 52 000; this leaves a pack room for about 3 000 tokens more.
 */
export const MAX_LIST = 64_000;
/** How long one tool's description may be: what Claude Code loads of one. */
export const MAX_DESCRIPTION = 4_000;
/** How many examples one group may have, and how long one may be as JSON. */
export const MAX_EXAMPLES = 10;
export const MAX_EXAMPLE = 2_000;

/** How long the words of a key may be, as the pack and the default one together have them. */
export function limitOf(key: string): number {
  if (key.startsWith("system.")) return 4_000;
  if (/^tools\.[a-z_]+\.description$/.test(key)) return MAX_DESCRIPTION;
  if (/^ops\.[^.]+\.[^.]+\.summary$/.test(key)) return 200;
  if (/^ops\.[^.]+\.[^.]+\.description$/.test(key)) return 2_000;
  return 500;
}

/**
 * Characters a pack cannot have, by kind: controls other than tab and line feed, format characters
 * (zero-width ones, those that change the direction of writing, tags, the byte order mark), the
 * separators of lines and paragraphs, private use, and whatever Unicode says shows as nothing
 * (variation selectors, fillers, the grapheme joiner and more), with a few that show as nothing but
 * are not said to (the blank of Braille, the object replacement, a null note head). They can make
 * what people see when they install a pack differ from what the model reads, or carry words hidden
 * in what looks like one character.
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Default_Ignorable_Code_Point}\u2800\ufffc\u{1d159}]/u;
const ALLOWED_CONTROLS = new Set(["\n", "\t"]);

function hiddenIn(text: string): string | undefined {
  for (const char of text) {
    if (ALLOWED_CONTROLS.has(char)) continue;
    if (HIDDEN.test(char)) {
      const code = char.codePointAt(0) ?? 0;
      return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return undefined;
}

/** How many empty lines in a row, and how wide a run of blank (a tab is four), words may have. */
export const MAX_EMPTY_LINES = 2;
export const MAX_SPACES = 20;
/** A line with more blank than this, and more blank than characters to see, is mostly blank. */
export const MAX_LINE_BLANK = 60;
/** How many lines in a row may have one character to see or none. */
export const MAX_THIN_LINES = 10;

const SPACE = /\s/u;
const MARK = /\p{M}/u;

/**
 * Where words have more blank than writing needs, so that what comes after it would be out of
 * sight in the install dialog. Blank is any space of Unicode, and a combining mark with nothing to
 * sit on (at the start of a line, or after blank), which shows as next to nothing. Refused: a run
 * of blank wider than `MAX_SPACES`; more than `MAX_EMPTY_LINES` lines in a row with nothing to see;
 * a line mostly blank (`MAX_LINE_BLANK`); more than `MAX_THIN_LINES` lines in a row with one
 * character to see at most. An indent of two wide spaces, short lines of verse and closing braces
 * of code pass. The detail of a problem says what was found and what may be.
 */
function spacingIn(text: string): Readonly<Record<string, number>> | undefined {
  const limits = {
    maxLines: MAX_EMPTY_LINES,
    maxSpaces: MAX_SPACES,
    maxThinLines: MAX_THIN_LINES,
  };
  const lines = text.split("\n");
  // The end of the last line is no line of its own.
  if (lines.at(-1) === "") lines.pop();
  let empty = 0;
  let thin = 0;
  for (const line of lines) {
    let run = 0;
    let blank = 0;
    let seen = 0;
    let onCharacter = false;
    for (const char of line) {
      const mark = MARK.test(char);
      if (SPACE.test(char) || (mark && !onCharacter)) {
        const width = char === "\t" ? 4 : 1;
        run += width;
        blank += width;
        onCharacter = false;
        if (run > MAX_SPACES) return { spaces: run, ...limits };
      } else if (!mark) {
        // A mark on a character goes with it.
        seen += 1;
        run = 0;
        onCharacter = true;
      }
    }
    if (blank > MAX_LINE_BLANK && blank > seen) return { sparse: blank, ...limits };
    empty = seen === 0 ? empty + 1 : 0;
    if (empty > MAX_EMPTY_LINES) return { emptyLines: empty, ...limits };
    thin = seen <= 1 ? thin + 1 : 0;
    if (thin > MAX_THIN_LINES) return { thinLines: thin, ...limits };
  }
  return undefined;
}

/** How deep JSON of a pack may nest, and how many values it may have. */
export const MAX_DEPTH = 40;
export const MAX_VALUES = 50_000;

/** Whether JSON nests no deeper than a pack may, counted without recursion. */
function shapeFits(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  let values = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    values += 1;
    if (depth > MAX_DEPTH || values > MAX_VALUES) return false;
    if (typeof node !== "object" || node === null) continue;
    for (const inner of Array.isArray(node) ? node : Object.values(node)) {
      stack.push([inner, depth + 1]);
    }
  }
  return true;
}

/** Letters of other scripts that look like Latin ones, as the Latin ones. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries(
  [..."АВЕКМНОРСТУХаеорсухІіЈјΑΒΕΖΗΙΚΜΝΟΡΤΥΧοιν"].map((char, index) => [
    char,
    "ABEKMHOPCTYXaeopcyxIiJjABEZHIKMNOPTYXoiv"[index] as string,
  ]),
);

/**
 * A name as it reads, for comparing what it says: compatible forms, no combining marks, letters
 * of other scripts that look Latin as Latin, lower case, without spaces and punctuation, and the
 * letters easy to take for one another (i, l, 1, |; o, 0) as one.
 */
const folded = (text: string) =>
  [...text.normalize("NFKC").replace(/\p{M}/gu, "")]
    .map((char) => LOOKALIKES[char] ?? char)
    .join("")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/[il1|]/g, "l")
    .replace(/0/g, "o");

/** Words in a name or author that say a pack is AnimaQuill's own, folded as names are. */
const RESERVED_WORDS = [
  "animaquill",
  "builtin",
  "official",
  "内置",
  "內置",
  "内建",
  "內建",
  "官方",
  "自带",
  "自帶",
].map(folded);
const reservedIn = (text: string) => {
  const name = folded(text);
  return RESERVED_WORDS.some((word) => name.includes(word));
};

/**
 * Whether a name or author has blank that could push what the editor writes after it out of
 * sight: any space but the plain one, or two of them in a row.
 */
const blankIn = (text: string) => /[^\S ]| {2}/u.test(text);

let keysOfPacks: ReadonlyMap<string, "text" | "examples"> | undefined;

/**
 * The keys a pack can have words for, from the tools as they are: every key of the table but how
 * aq_edit lays out its list, the errors of operations and the fields of their results in the
 * manual. Those are part of what tools give back, which no pack changes.
 */
export function packKeys(): ReadonlyMap<string, "text" | "examples"> {
  keysOfPacks ??= new Map(
    textKeys()
      .filter(({ key }) => !key.startsWith("edit.") || key === "edit.examples")
      .filter(({ key }) => !/^ops\.[^.]+\.[^.]+\.(errors|fields)\./.test(key))
      .map(({ key, kind }) => [key, kind]),
  );
  return keysOfPacks;
}

/** The decoder of the platform: the tools have no types of the page or of Node.js. */
const Decoder = (
  globalThis as unknown as {
    readonly TextDecoder: new (
      label: string,
      options: { readonly fatal: boolean },
    ) => { decode(bytes: Uint8Array): string };
  }
).TextDecoder;

/** How many bytes a text takes in UTF-8. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const TOOL_NAMES: ReadonlySet<string> = new Set(DEFINITIONS.map(({ name }) => name));
const AI_NAMES: ReadonlySet<string> = new Set(AI_OPERATIONS.map(({ name }) => name));

/** The names of tools some words have, aq_…, that are not tools. */
function unknownTools(text: string): readonly string[] {
  return [...new Set(text.match(/\baq_[A-Za-z0-9_]+/g) ?? [])].filter(
    (name) => !TOOL_NAMES.has(name),
  );
}

/** Every string in a value, with where it is. */
function* stringsIn(value: unknown, at: string): Generator<[string, string]> {
  if (typeof value === "string") yield [at, value];
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringsIn(item, `${at}[${index}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const inner = at === "" ? key : `${at}.${key}`;
      yield [`${inner} (name)`, key];
      yield* stringsIn(item, inner);
    }
  }
}

/** A value with every string in NFC, keys too. */
function normalized(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.normalize("NFC"), normalized(item)]),
    );
  }
  return value;
}

const where = (path: readonly PropertyKey[]): string =>
  path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`,
    )
    .join("");

const OperationExamples = z.array(
  z.strictObject({ title: z.string().min(1).max(200), params: z.record(z.string(), z.unknown()) }),
);
const EditExamples = z.array(z.array(z.record(z.string(), z.unknown())));

/** A host for tools that only describe themselves and check parameters: nothing runs. */
const NO_HOST: ToolHost = {
  store: () => undefined,
  origin: () => aiTask("pack"),
  problems: () => new ProblemSet(),
};

/**
 * Checks a model pack and reads it, the same way wherever a pack comes in: when people install
 * one, whenever one installed before is loaded, when a task in the cloud gets one, and for
 * AnimaQuill's own packs in tests. It touches no network, page or key. See `PackProblemCode` for
 * what it refuses, and `PackHint` for what it only points out.
 */
export function checkPack(files: PackFiles, options: CheckOptions = {}): PackCheck {
  try {
    return checkedPack(files, options);
  } catch (error) {
    // Nothing a pack has may get through by making the check fail: then it is not used.
    return {
      pack: undefined,
      problems: [
        {
          code: "unexpected",
          at: MANIFEST,
          detail: { message: String((error as Error)?.message) },
        },
      ],
      dropped: [],
      hints: [],
    };
  }
}

function checkedPack(files: PackFiles, options: CheckOptions): PackCheck {
  const mode = options.mode ?? "install";
  const problems: PackProblem[] = [];
  const hints: PackHint[] = [];
  const done = (pack?: ModelPack, dropped: readonly PackProblem[] = []): PackCheck => ({
    pack,
    problems,
    dropped,
    hints,
  });
  const decoder = new Decoder("utf-8", { fatal: true });
  const used = new Map<string, number>();

  /** A file of the pack as text, with lines ended by \n and the byte order mark left out. */
  const read = (path: string, at: string): string | undefined => {
    const raw = files.get(path);
    if (raw === undefined) {
      problems.push({
        code: path === MANIFEST ? "no-manifest" : "file-missing",
        at,
        detail: { file: path },
      });
      return undefined;
    }
    if (typeof raw !== "string" && !ArrayBuffer.isView(raw)) {
      problems.push({
        code: "file-size",
        at,
        detail: { file: path, bytes: raw.tooLarge, max: MAX_FILE_BYTES },
      });
      return undefined;
    }
    let text: string;
    try {
      text = typeof raw === "string" ? raw : decoder.decode(raw);
    } catch {
      problems.push({ code: "not-utf8", at, detail: { file: path } });
      return undefined;
    }
    const bytes = typeof raw === "string" ? utf8Length(raw) : raw.length;
    used.set(path, bytes);
    if (bytes > MAX_FILE_BYTES) {
      problems.push({ code: "file-size", at, detail: { file: path, bytes, max: MAX_FILE_BYTES } });
      return undefined;
    }
    return text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  };

  const source = read(MANIFEST, MANIFEST);
  if (source === undefined) return done();
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    problems.push({
      code: "not-json",
      at: MANIFEST,
      detail: { message: (error as Error).message },
    });
    return done();
  }
  if (!shapeFits(json)) {
    problems.push({ code: "too-deep", at: MANIFEST, detail: { depth: MAX_DEPTH } });
    return done();
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    problems.push({
      code: "invalid",
      at: MANIFEST,
      detail: { message: "pack.json is one object" },
    });
    return done();
  }
  const record = json as Record<string, unknown>;
  if (Object.hasOwn(record, "scripts")) {
    problems.push({ code: "scripts", at: "scripts" });
    return done();
  }
  if (record.format !== PACK_FORMAT) {
    problems.push({ code: "format", at: "format", detail: { format: String(record.format) } });
    return done();
  }
  for (const [at, text] of stringsIn(json, "")) {
    // A record of the format keeps no such key: it would go into its prototype unseen.
    if (at.endsWith(" (name)") && ["__proto__", "constructor", "prototype"].includes(text)) {
      problems.push({ code: "unknown-field", at: at.slice(0, -" (name)".length) });
    }
    const found = hiddenIn(text);
    if (found) problems.push({ code: "characters", at, detail: { char: found } });
    const spacing = spacingIn(text);
    if (spacing) problems.push({ code: "spacing", at, detail: spacing });
  }
  const parsed = ManifestSchema.safeParse(normalized(json));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          problems.push({ code: "unknown-field", at: where([...issue.path, key]) });
        }
      } else {
        problems.push({
          code: "invalid",
          at: where(issue.path) || MANIFEST,
          detail: { message: issue.message },
        });
      }
    }
  }
  if (!parsed.success || problems.length > 0) return done();
  const manifest = parsed.data;
  if (!options.builtin && manifest.id.startsWith(BUILTIN_PREFIX)) {
    problems.push({ code: "reserved-id", at: "id" });
  }
  if (!options.builtin) {
    const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
    for (const [at, text] of [
      ["name", manifest.name],
      ["author", author ?? ""],
    ] as const) {
      if (reservedIn(text)) problems.push({ code: "reserved-name", at });
      if (blankIn(text)) problems.push({ code: "name-blank", at });
    }
  }

  /** Words, from the manifest or the file it names. */
  const textOf = (value: string | { readonly file: string }, at: string): string | undefined => {
    if (typeof value === "string") return value;
    const path = fileOf(value.file, at, [".md", ".txt"]);
    if (path === undefined) return undefined;
    const text = read(path, at);
    if (text === undefined) return undefined;
    const found = hiddenIn(text);
    if (found) {
      problems.push({ code: "characters", at, detail: { char: found, file: path } });
      return undefined;
    }
    const words = text.normalize("NFC").trimEnd();
    const spacing = spacingIn(words);
    if (spacing) {
      problems.push({ code: "spacing", at, detail: { ...spacing, file: path } });
      return undefined;
    }
    return words;
  };
  const fileOf = (path: string, at: string, kinds: readonly string[]): string | undefined => {
    const parts = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes(":") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      problems.push({ code: "file-path", at, detail: { file: path } });
      return undefined;
    }
    if (!kinds.some((kind) => path.toLowerCase().endsWith(kind)) || path === MANIFEST) {
      problems.push({ code: "file-type", at, detail: { file: path, kinds: kinds.join(" ") } });
      return undefined;
    }
    return path;
  };
  const examplesOf = (
    value: unknown,
    at: string,
    schema: typeof OperationExamples | typeof EditExamples,
  ): TextValue | undefined => {
    let list = value;
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "file" in value) {
      const path = fileOf(String((value as { file: unknown }).file), at, [".json"]);
      const text = path === undefined ? undefined : read(path, at);
      if (text === undefined) return undefined;
      const found = hiddenIn(text);
      if (found) {
        problems.push({ code: "characters", at, detail: { char: found, file: path ?? "" } });
        return undefined;
      }
      try {
        const fromFile = JSON.parse(text) as unknown;
        if (!shapeFits(fromFile)) {
          problems.push({ code: "too-deep", at, detail: { depth: MAX_DEPTH, file: path ?? "" } });
          return undefined;
        }
        for (const [place, words] of stringsIn(fromFile, "")) {
          const spacing = spacingIn(words);
          if (spacing) {
            problems.push({ code: "spacing", at: `${at} ${place}`, detail: spacing });
            return undefined;
          }
        }
        list = normalized(fromFile);
      } catch (error) {
        problems.push({
          code: "not-json",
          at,
          detail: { file: path ?? "", message: (error as Error).message },
        });
        return undefined;
      }
    }
    const checked = schema.safeParse(list);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        problems.push({
          code: "invalid",
          at: `${at}${where(issue.path) ? ` ${where(issue.path)}` : ""}`,
          detail: { message: issue.message },
        });
      }
      return undefined;
    }
    return checked.data as TextValue;
  };

  type TextEditValue =
    | string
    | { readonly file: string }
    | { readonly append: string | { readonly file: string } }
    | null;
  /** One edit of words, from what the manifest has for a key. */
  const textEdit = (key: string, value: TextEditValue): PackEdit | undefined => {
    if (value === null) return { key, how: "remove" };
    if (typeof value === "object" && "append" in value) {
      const text = textOf(value.append, key);
      return text === undefined ? undefined : { key, how: "append", value: text };
    }
    const text = textOf(value, key);
    return text === undefined ? undefined : { key, how: "set", value: text };
  };
  const examplesEdit = (
    key: string,
    value: unknown,
    schema: typeof OperationExamples | typeof EditExamples,
  ): PackEdit | undefined => {
    const append =
      typeof value === "object" && value !== null && !Array.isArray(value) && "append" in value;
    const list = examplesOf(append ? (value as { append: unknown }).append : value, key, schema);
    return list === undefined ? undefined : { key, how: append ? "append" : "set", value: list };
  };

  const edits: PackEdit[] = [];
  /** Edits under a name that is not a tool or an operation, whatever key they make up. */
  const misnamed = new Set<PackEdit>();
  let named = true;
  const push = (edit: PackEdit | undefined) => {
    if (!edit) return;
    edits.push(edit);
    if (!named) misnamed.add(edit);
  };
  for (const [part, value] of Object.entries(manifest.system ?? {})) {
    if (value !== undefined) push(textEdit(`system.${part}`, value));
  }
  for (const [tool, words] of Object.entries(manifest.tools ?? {})) {
    named = TOOL_NAMES.has(tool);
    if (words.description !== undefined)
      push(textEdit(`tools.${tool}.description`, words.description));
    for (const [path, value] of Object.entries(words.params ?? {})) {
      push(textEdit(`tools.${tool}.params.${path}`, value));
    }
  }
  for (const [op, words] of Object.entries(manifest.ops ?? {})) {
    named = AI_NAMES.has(op);
    if (words.summary !== undefined) push(textEdit(`ops.${op}.summary`, words.summary));
    if (words.description !== undefined) push(textEdit(`ops.${op}.description`, words.description));
    for (const [name, value] of Object.entries(words.params ?? {})) {
      push(textEdit(`ops.${op}.params.${name}`, value));
    }
    if (words.examples !== undefined)
      push(examplesEdit(`ops.${op}.examples`, words.examples, OperationExamples));
  }
  named = true;
  for (const [name, value] of Object.entries(manifest.params ?? {}))
    push(textEdit(`params.${name}`, value));
  for (const [name, value] of Object.entries(manifest.types ?? {}))
    push(textEdit(`types.${name}`, value));
  if (manifest.edit?.examples !== undefined)
    push(examplesEdit("edit.examples", manifest.edit.examples, EditExamples));
  const variants: PackVariant[] = [];
  for (const variant of manifest.variants ?? []) {
    const extra =
      variant.system?.extra === undefined
        ? undefined
        : textEdit("system.extra", variant.system.extra);
    if (extra === undefined && variant.system?.extra !== undefined) continue;
    variants.push({
      models: variant.models,
      call: (variant.call ?? {}) as CallSettings,
      ...(variant.results && { results: variant.results }),
      ...(extra && { extra }),
    });
  }
  const bytes = [...used.values()].reduce((sum, size) => sum + size, 0);
  if (bytes > MAX_PACK_BYTES)
    problems.push({ code: "pack-size", at: MANIFEST, detail: { bytes, max: MAX_PACK_BYTES } });
  if (problems.length > 0) return done();

  // What the words are about: keys the tools have, tools there are.
  const keys = packKeys();
  const droppable: PackProblem[] = [];
  const all = [...edits, ...variants.flatMap(({ extra }) => (extra ? [extra] : []))];
  const wrong = new Set<PackEdit>();
  for (const edit of all) {
    const kind = keys.get(edit.key);
    if (kind === undefined || misnamed.has(edit)) {
      droppable.push({ code: "unknown-key", at: edit.key });
      wrong.add(edit);
      continue;
    }
    if (edit.how === "remove") continue;
    const text = typeof edit.value === "string" ? edit.value : JSON.stringify(edit.value);
    for (const name of unknownTools(text)) {
      droppable.push({ code: "unknown-tool", at: edit.key, detail: { name } });
      wrong.add(edit);
    }
  }
  // Words that replace default words which changed since the pack was installed may say what is no
  // longer so, such as what a parameter means: they go. Words that go on after the default stay.
  for (const edit of all) {
    if (mode !== "load" || edit.how !== "set" || wrong.has(edit)) continue;
    const then = options.defaults?.[edit.key];
    if (then !== undefined && then !== defaultHash(edit.key)) {
      droppable.push({ code: "default-changed", at: edit.key });
      wrong.add(edit);
    }
  }
  if (mode === "install") problems.push(...droppable);
  // A pack that changes the guard or what the place says of itself was agreed to as a whole.
  else if (
    droppable.length > 0 &&
    all.some(({ key }) => key === "system.guard" || key === "system.host")
  ) {
    problems.push({ code: "needs-review", at: MANIFEST, detail: { count: droppable.length } });
    return done();
  }
  const kept = edits.filter((edit) => !wrong.has(edit));
  const keptVariants: readonly PackVariant[] = variants.map(({ extra, ...variant }) =>
    extra && !wrong.has(extra) ? { ...variant, extra } : variant,
  );

  // How long the words are, with the default ones they go on after; and the examples.
  const edit = createToolset(NO_HOST, new CallerState(), DEFAULT_TEXTS).find(
    ({ name }) => name === "aq_edit",
  ) as Tool;
  for (const one of [...kept, ...keptVariants.flatMap(({ extra }) => (extra ? [extra] : []))]) {
    const value = withEdits(DEFAULT_TEXTS, [one])[one.key];
    if (typeof value === "string") {
      const max = limitOf(one.key);
      if (value.length > max)
        problems.push({ code: "too-long", at: one.key, detail: { length: value.length, max } });
      continue;
    }
    if (!Array.isArray(value)) continue;
    if (value.length > MAX_EXAMPLES) {
      problems.push({
        code: "too-many-examples",
        at: one.key,
        detail: { count: value.length, max: MAX_EXAMPLES },
      });
    }
    const own = one.how === "remove" ? [] : (one.value as readonly unknown[]);
    for (const [index, example] of own.entries()) {
      const length = JSON.stringify(example).length;
      if (length > MAX_EXAMPLE) {
        problems.push({
          code: "too-long",
          at: `${one.key}[${index}]`,
          detail: { length, max: MAX_EXAMPLE },
        });
        continue;
      }
      const given = (example as Partial<OperationExample>).params;
      if (one.key !== "edit.examples" && given !== undefined && Object.hasOwn(given, "op")) {
        // Its operation is the one whose page it is on.
        problems.push({
          code: "example-invalid",
          at: `${one.key}[${index}]`,
          detail: { message: "params has op: the operation is the one the example is for" },
        });
        continue;
      }
      const operations =
        one.key === "edit.examples"
          ? (example as EditExample)
          : [
              {
                op: one.key.slice("ops.".length, -".examples".length),
                ...(example as OperationExample).params,
              },
            ];
      const invalid = edit.validate({ operations });
      if (invalid) {
        problems.push({
          code: "example-invalid",
          at: `${one.key}[${index}]`,
          detail: { message: invalid.text },
        });
        continue;
      }
      if (options.sample) {
        const store = options.sample();
        const calls = operations.map(({ op, ...params }) => ({ type: String(op), params }));
        const result = store.executeBatch(calls, { origin: aiTask("pack"), dryRun: true });
        if (!result.ok) {
          problems.push({
            code: "example-fails",
            at: `${one.key}[${index}]`,
            detail: { message: JSON.stringify(result) },
          });
        }
      }
    }
  }

  // What people should look at: words that ask for secrets, addresses, to ignore or hide, to send.
  // Only for words short enough to pass, which the rules read quickly.
  if (problems.length > 0) return done();
  for (const one of [...kept, ...keptVariants.flatMap(({ extra }) => (extra ? [extra] : []))]) {
    if (one.how === "remove") continue;
    const text = typeof one.value === "string" ? one.value : JSON.stringify(one.value);
    const rules = hintsIn(text);
    if (rules.length > 0) hints.push({ at: one.key, rules });
  }
  for (const [at, text] of [
    ["name", manifest.name],
    ["description", manifest.description ?? ""],
  ] as const) {
    const rules = hintsIn(text);
    if (rules.length > 0) hints.push({ at, rules });
  }
  if (problems.length > 0) return done();

  const author =
    manifest.author === undefined
      ? undefined
      : typeof manifest.author === "string"
        ? { name: manifest.author }
        : {
            name: manifest.author.name,
            ...(manifest.author.url !== undefined && { url: manifest.author.url }),
          };
  const body: Omit<ModelPack, "hash"> = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined && { description: manifest.description }),
    ...(author && { author }),
    ...(manifest.license !== undefined && { license: manifest.license }),
    ...(manifest.homepage !== undefined && { homepage: manifest.homepage }),
    builtin: options.builtin === true,
    models: manifest.models ?? [],
    call: (manifest.call ?? {}) as CallSettings,
    ...(manifest.results && { results: manifest.results }),
    variants: keptVariants,
    edits: kept,
  };
  const pack: ModelPack = { ...body, hash: hashOfPack(body) };

  // All of it together, for the models of each variant and the rest: the tools and the prompt.
  for (const variant of [undefined, ...pack.variants]) {
    const texts = textsOf(pack, variant);
    const results = variant?.results ?? pack.results ?? "standard";
    const tools = createToolset(NO_HOST, new CallerState(), texts, { results });
    const at = variant ? `variants[${pack.variants.indexOf(variant)}]` : "";
    for (const tool of tools) {
      if (tool.description.length > MAX_DESCRIPTION) {
        problems.push({
          code: "too-long",
          at: `tools.${tool.name}.description${at ? ` (${at})` : ""}`,
          detail: { length: tool.description.length, max: MAX_DESCRIPTION },
        });
      }
    }
    const list = JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ).length;
    if (list > MAX_LIST)
      problems.push({
        code: "too-large",
        at: at || "tools",
        detail: { length: list, max: MAX_LIST },
      });
    const prompt = systemPromptOf({ entry: "browser", texts }).length;
    if (prompt > MAX_SYSTEM)
      problems.push({
        code: "too-large",
        at: at || "system",
        detail: { length: prompt, max: MAX_SYSTEM },
      });
  }
  if (problems.length > 0) return done();
  return done(pack, mode === "load" ? droppable : []);
}

/** The files a pack.json names, to read them from where the pack is, in the order it names them. */
export function filesNamedIn(manifest: string): readonly string[] {
  let json: unknown;
  try {
    json = JSON.parse(manifest);
  } catch {
    return [];
  }
  // What the check refuses is not read either: a pack nested too deep has no files to read.
  if (!shapeFits(json)) return [];
  const found = new Set<string>();
  const stack: unknown[] = [json];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...value.toReversed());
    else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length === 1 && keys[0] === "file" && typeof record.file === "string") {
        found.add(record.file);
        continue;
      }
      stack.push(...Object.values(record).toReversed());
    }
  }
  return [...found];
}

/**
 * Whether a path a pack names can be a file of it: inside it, `/` between parts, of a kind a pack
 * may have. The check says why not; those who read files before it (such as `pack-check`) read
 * none that is not.
 */
export function isPackPath(path: string): boolean {
  const parts = path.split("/");
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !parts.some((part) => part === "" || part === "." || part === "..") &&
    /\.(md|txt|json)$/i.test(path) &&
    path !== MANIFEST
  );
}

/** The manifest as a pack has it, for a pack AnimaQuill makes in code. */
export type { Manifest };
