import { GENERAL_FAILURES, type Operation } from "@animaquill/core";
import { z } from "zod";
import { answer, failed, fitted, type Call } from "../context.ts";
import { aiCode } from "../failures-en.ts";
import { HOWTO_PAGES, TYPE_PAGES, type ManualPage } from "../guide/pages.ts";
import { AI_OPERATIONS, DEFS_AT, fieldsOf, signatureOf, type Field } from "../schema.ts";
import { mostLike } from "../similar.ts";
import {
  PARAM,
  operationExamples,
  paramText,
  sentenceOf,
  textIn,
  textOf,
  type TextTable,
} from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";
import { GROUPS } from "./edit.ts";

/**
 * The manual: a page for each operation of aq_edit, made from the registry and the table of texts;
 * pages on the types that operations share and on how the editor does a kind of thing, which people
 * write (guide/pages.ts); and the project format and the scene runtime, one page for each section of
 * the two public documents (in Chinese, as they are written). The documents load only when a page
 * of them is asked for.
 */

interface Page {
  readonly topic: string;
  /** Other topics that find the page. */
  readonly also?: readonly string[];
  readonly title: string;
  readonly text: () => Promise<string> | string;
}

/** A topic of a heading: its words, in lower case, joined by -. */
const slugOf = (heading: string) =>
  heading.replaceAll("`", "").trim().toLowerCase().replaceAll(/\s+/g, "-");

/** The sections of a document, by their second-level headings. */
function sectionsOf(
  document: string,
  prefix: string,
): readonly { topic: string; title: string; body: string }[] {
  const parts = document.split(/^## /m).slice(1);
  return parts.map((part) => {
    const title = part.slice(0, part.indexOf("\n")).trim();
    return { topic: `${prefix}/${slugOf(title)}`, title, body: `## ${part.trim()}` };
  });
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a parameter is, in a few words: its JSON type, its choices, or the shared type it is. */
function kindOf(schema: Node): string {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.slice(DEFS_AT.length);
    return `${name}, topic "types/${name}"`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((each) => JSON.stringify(each)).join(" | ");
  const choices = [...((schema.anyOf ?? []) as Node[]), ...((schema.oneOf ?? []) as Node[])];
  if (choices.length > 0) {
    const kinds = choices.map((choice) => (choice.type === "null" ? "null" : kindOf(choice)));
    return [...new Set(kinds)].join(" or ");
  }
  if (schema.type === "array") {
    const items = isNode(schema.items) ? kindOf(schema.items) : "value";
    return `list of ${items === "object" ? "objects" : items}`;
  }
  if (schema.type === "integer") return "whole number";
  return typeof schema.type === "string" ? schema.type : "value";
}

/** The words for a parameter, or a field inside one, on the page of its operation. */
function fieldText(texts: TextTable, op: string, field: Field): string {
  const manual = textIn(texts, `ops.${op}.fields.${field.path}`);
  const leaf = field.path.split(".").at(-1) ?? field.path;
  const schema = field.depth === 0 ? (field.schema.description as string | undefined) : undefined;
  const words = schema ?? paramText(texts, op, leaf) ?? "";
  if (manual === undefined) return words;
  // Words of the manual that go on from those of the schema say it all.
  const repeats = words === "" || manual.startsWith(words.replace(/\.$/, ""));
  return field.depth === 0 && !repeats ? `${words} ${manual}` : manual;
}

/** The page of one operation: what it does, takes, gives back and can fail with, and examples. */
function operationPage(op: Operation, texts: TextTable): string {
  const fields = fieldsOf(op.name, texts).map((field) => {
    const required = field.required ? "required" : "optional";
    const kind = kindOf(field.schema as Node);
    return `${"  ".repeat(field.depth)}- ${field.path} (${kind}, ${required}): ${fieldText(texts, op.name, field)}`;
  });
  const made = z.toJSONSchema(op.result, { io: "output", unrepresentable: "any" }) as Node;
  const makes = isNode(made.properties) && "id" in made.properties;
  const general: ReadonlySet<string> = new Set(GENERAL_FAILURES);
  const own = op.failures.filter((code) => !general.has(code));
  return [
    `# ${op.name}`,
    "",
    sentenceOf(textOf(texts, `ops.${op.name}.summary`)),
    "",
    textOf(texts, `ops.${op.name}.description`),
    "",
    `Shape: ${signatureOf(op.name)}`,
    "",
    "Parameters:",
    ...fields,
    "",
    makes
      ? 'Result: "created:" has the id it makes, and "changed:" a line for each object it changed.'
      : 'Result: "changed:" has a line for each object it changed.',
    "",
    own.length > 0 ? "Errors of its own:" : "Errors of its own: none.",
    ...own.map((code) => `- ${aiCode(code)}: ${textOf(texts, `ops.${op.name}.errors.${code}`)}`),
    'Errors that any batch can give, such as conflict, not-read and invalid-params: topic "howto/batches".',
    "",
    "Examples (illustrative; their ids come from a sample project, not from the open one):",
    ...operationExamples(texts, op.name).map(
      ({ title, params: example }) => `- ${title}: ${JSON.stringify({ op: op.name, ...example })}`,
    ),
  ].join("\n");
}

/** What the sections of the two documents are about, in English, for the table of contents and search. */
const ENGLISH: Readonly<Record<string, string>> = {
  "format/目录结构": "folder layout",
  "format/通用规则": "general rules: times, ids, world coordinates",
  "format/animaquill.json": "the project manifest",
  "format/时间轴":
    "timelines: sections, tracks, clips, transitions, joins, effects, properties and keyframes",
  "format/差异": "versions: overrides by language and format",
  "format/场景和声音": "scenes and sounds",
  "format/素材": "assets",
  "format/字符串表": "string tables, for translations",
  "format/库": "libraries",
  "format/批注": "notes",
  "format/校验和问题": "checks and problems",
  "format/导出和导入": "export and import",
  "format/版本和迁移": "format versions and migration",
  "scene-runtime/场景在哪里跑": "where scenes run",
  "scene-runtime/aq": "the aq object of scene code",
  "scene-runtime/可以打关键帧的对象": "objects whose properties have keyframes: registering them",
  "scene-runtime/时间": "time in scene code",
  "scene-runtime/做不到确定的事": "what cannot be the same every time",
  "scene-runtime/改了代码之后": "after code changes",
  "scene-runtime/限制": "limits",
  "scene-runtime/声音": "sound code",
};

/** How many pages a search lists. */
const MAX_FOUND = 10;

const made = new WeakMap<TextTable, readonly Page[]>();

/** The operations in the order of the description of aq_edit: by group. */
const BY_GROUP: readonly Operation[] = AI_OPERATIONS.toSorted(
  (a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group),
);

/** Every page: how-to pages first, then operations, types and the two documents. */
async function allPages(texts: TextTable): Promise<readonly Page[]> {
  const known = made.get(texts);
  if (known) return known;
  const { PROJECT_FORMAT, SCENE_RUNTIME } = await import("../guide/texts.ts");
  const written = (page: ManualPage): Page => ({ ...page, text: () => page.text });
  const pages = [
    ...HOWTO_PAGES.map(written),
    ...BY_GROUP.map((op) => ({
      topic: `ops/${op.name}`,
      title: textOf(texts, `ops.${op.name}.summary`),
      text: () => operationPage(op, texts),
    })),
    ...TYPE_PAGES.map(written),
    ...sectionsOf(PROJECT_FORMAT, "format").map(({ topic, title, body }) => ({
      topic,
      title: `${ENGLISH[topic] ?? ""} (${title})`,
      text: () => body,
    })),
    ...sectionsOf(SCENE_RUNTIME, "scene-runtime").map(({ topic, title, body }) => ({
      topic,
      title: `${ENGLISH[topic] ?? ""} (${title})`,
      text: () => body,
    })),
  ];
  made.set(texts, pages);
  return pages;
}

/** The table of contents: the pages by part, one line each, with what each part has. */
function contents(pages: readonly Page[]): readonly string[] {
  const part = (prefix: string) => pages.filter(({ topic }) => topic.startsWith(prefix));
  const line = ({ topic, also, title }: Page) =>
    `${topic}${also ? ` (also ${also.join(", ")})` : ""} — ${title}`;
  return [
    'The manual of AnimaQuill. A topic is one page; topic "<topic>:2" is the next part of a long one; query searches titles and pages.',
    "",
    "How the editor does things (short pages):",
    ...part("howto/").map(line),
    "",
    "Operations of aq_edit (each page: what it does, parameters and the fields inside them, result, errors, examples):",
    ...part("ops/").map(line),
    "",
    "Types that operations share (fields and examples):",
    ...part("types/").map(line),
    "",
    "The project format (in Chinese; Chinese words find them too, such as 关键帧 for keyframe):",
    ...part("format/").map(line),
    "",
    "The scene runtime: what scene and sound code can use (in Chinese):",
    ...part("scene-runtime/").map(line),
  ];
}

/** A page in parts that fit in one result: `topic`, `topic:2` and on. */
function partOf(
  text: string,
  topic: string,
  part: number,
  max: number,
): { text: string; more: boolean } {
  const size = max - 1000;
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return { text: parts[part - 1] ?? "", more: part < parts.length };
}

const GuideParams = z.strictObject({
  topic: z.string().optional().describe(PARAM),
  query: z.string().optional().describe(PARAM),
});

export const guide: ToolDefinition<z.output<typeof GuideParams>> = {
  name: "aq_guide",
  title: "Read the manual",
  params: GuideParams,
  run: async (call: Call, args) => {
    const all = await allPages(call.texts);
    if (args.topic !== undefined) {
      const [topic = "", number = "1"] = args.topic.split(":");
      const page = all.find((each) => each.topic === topic || each.also?.includes(topic));
      if (!page) {
        const similar = mostLike(
          topic,
          all.flatMap((each) => [each.topic, ...(each.also ?? [])]),
        );
        const hint = similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : "";
        return failed(
          `error not-found: no topic ${JSON.stringify(topic)}.${hint} aq_guide without arguments lists them.`,
        );
      }
      const part = Math.max(1, Number.parseInt(number, 10) || 1);
      const { text, more } = partOf(await page.text(), topic, part, call.limits.result);
      return answer(call, [
        `topic ${topic}${part > 1 ? ` part ${part}` : ""}`,
        text,
        ...(more ? [`more: aq_guide topic "${topic}:${part + 1}"`] : []),
      ]);
    }
    if (args.query !== undefined) {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      // Pages whose topic or title has every word come first, then those that have them in the text.
      const titled: string[] = [];
      const inText: string[] = [];
      for (const page of all) {
        const text = (await page.text()).toLowerCase();
        const title = `${page.topic} ${(page.also ?? []).join(" ")} ${page.title}`.toLowerCase();
        const byTitle = words.every((word) => title.includes(word));
        if (!byTitle && !words.every((word) => text.includes(word) || title.includes(word))) {
          continue;
        }
        const line =
          (await page.text())
            .split("\n")
            .find((each) => each.toLowerCase().includes(words[0] ?? "")) ?? page.title;
        (byTitle ? titled : inText).push(`${page.topic}: ${line.trim().slice(0, 160)}`);
      }
      const found = [...titled, ...inText];
      const more =
        found.length > MAX_FOUND
          ? [`and ${found.length - MAX_FOUND} more pages; more words narrow the search`]
          : [];
      return answer(
        call,
        found.length > 0 ? [...found.slice(0, MAX_FOUND), ...more] : ["nothing found"],
      );
    }
    return answer(call, [fitted(contents(all), undefined, call.limits.result)]);
  },
};
