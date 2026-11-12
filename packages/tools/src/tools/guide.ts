import { GENERAL_FAILURES, type Operation } from "@animaquill/core";
import { z } from "zod";
import { answer, failed, fitted, MAX_RESULT, type Call } from "../context.ts";
import { aiCode } from "../failures-en.ts";
import { AI_OPERATIONS, operationsParameter, signatureOf } from "../schema.ts";
import { mostLike } from "../similar.ts";
import { PARAM, operationExamples, paramText, textOf, type TextTable } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";

/**
 * The manual: a page for each operation of aq_edit, made from the registry, and the project format
 * and the scene runtime, one page for each section of the two public documents (in Chinese, as
 * they are written). The documents load only when a page of them is asked for.
 */

interface Page {
  readonly topic: string;
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

/** The page of one operation: what it takes, gives back and can fail with, and its examples. */
function operationPage(op: Operation, texts: TextTable): string {
  const summary = textOf(texts, `ops.${op.name}.summary`);
  const schema = operationsParameter(texts) as {
    items: {
      anyOf: { properties: Record<string, { description?: string }>; required: string[] }[];
    };
  };
  const branch = schema.items.anyOf.find(
    (each) => (each.properties.op as { const?: string }).const === op.name,
  );
  const params = Object.entries(branch?.properties ?? {})
    .filter(([name]) => name !== "op")
    .map(([name, value]) => {
      const required = branch?.required.includes(name) ? "required" : "optional";
      return `- ${name} (${required}): ${value.description ?? paramText(texts, op.name, name) ?? ""}`;
    });
  const result = JSON.stringify(
    z.toJSONSchema(op.result, { io: "output", unrepresentable: "any" }),
    (key, value: unknown) =>
      ["$schema", "pattern", "maxLength", "readOnly", "additionalProperties"].includes(key)
        ? undefined
        : value,
  );
  const returns =
    result === "{}"
      ? "Returns nothing besides the list of changes."
      : `Returns, besides the list of changes (ids it makes are under "created"): ${result}`;
  const failures = [...new Set([...op.failures, ...GENERAL_FAILURES].map(aiCode))];
  return [
    `# ${op.name}`,
    "",
    `${summary[0]?.toUpperCase()}${summary.slice(1)}.`,
    "",
    `Signature: ${signatureOf(op.name)}`,
    "",
    "Parameters:",
    ...params,
    "",
    returns,
    "",
    `Errors it can give: ${failures.join(", ")}`,
    "",
    "Examples (illustrative; their ids come from a sample project):",
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

const made = new WeakMap<TextTable, readonly Page[]>();

/** Every page, the operations first. */
async function allPages(texts: TextTable): Promise<readonly Page[]> {
  const known = made.get(texts);
  if (known) return known;
  const { PROJECT_FORMAT, SCENE_RUNTIME } = await import("../guide/texts.ts");
  const pages = [
    ...AI_OPERATIONS.map((op) => ({
      topic: `ops/${op.name}`,
      title: textOf(texts, `ops.${op.name}.summary`),
      text: () => operationPage(op, texts),
    })),
    ...sectionsOf(PROJECT_FORMAT, "format").map(({ topic, title, body }) => ({
      topic,
      title: `project format: ${ENGLISH[topic] ?? ""} (${title})`,
      text: () => body,
    })),
    ...sectionsOf(SCENE_RUNTIME, "scene-runtime").map(({ topic, title, body }) => ({
      topic,
      title: `scene runtime: ${ENGLISH[topic] ?? ""} (${title})`,
      text: () => body,
    })),
  ];
  made.set(texts, pages);
  return pages;
}

/** A page in parts that fit in one result: `topic`, `topic:2` and on. */
function partOf(text: string, topic: string, part: number): { text: string; more: boolean } {
  const size = MAX_RESULT - 1000;
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
      const page = all.find((each) => each.topic === topic);
      if (!page) {
        const similar = mostLike(
          topic,
          all.map((each) => each.topic),
        );
        const hint = similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : "";
        return failed(
          `error not-found: no topic ${JSON.stringify(topic)}.${hint} aq_guide without arguments lists them.`,
        );
      }
      const part = Math.max(1, Number.parseInt(number, 10) || 1);
      const { text, more } = partOf(await page.text(), topic, part);
      return answer(call, [
        `topic ${topic}${part > 1 ? ` part ${part}` : ""}`,
        text,
        ...(more ? [`more: aq_guide topic "${topic}:${part + 1}"`] : []),
      ]);
    }
    if (args.query !== undefined) {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const found: string[] = [];
      for (const page of all) {
        const text = (await page.text()).toLowerCase();
        const title = `${page.topic} ${page.title}`.toLowerCase();
        if (!words.every((word) => text.includes(word) || title.includes(word))) continue;
        const line =
          (await page.text())
            .split("\n")
            .find((each) => each.toLowerCase().includes(words[0] ?? "")) ?? "";
        found.push(`${page.topic}: ${line.trim().slice(0, 160)}`);
        if (found.length >= 10) break;
      }
      return answer(call, found.length > 0 ? found : ["nothing found: try fewer or other words"]);
    }
    return answer(call, [
      fitted([
        "topics (the format and scene runtime pages are in Chinese; search them with Chinese words too, such as 关键帧 for keyframe):",
        ...all.map((page) => `${page.topic} — ${page.title}`),
      ]),
    ]);
  },
};
