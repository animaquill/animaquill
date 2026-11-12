/**
 * The second review of model packs (6.5b ⑦), against the fixes of the first: [拒绝] checkPack
 * refuses it; [挡住] the checks in code hold; [说明] what it does, which is not a hole. What were
 * holes at the second review are fixed, and their cases say how.
 */
import { ProjectStore, USER, type CommandCall } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { CallerState } from "../caller.ts";
import { DEFAULT_TEXTS } from "../texts/index.ts";
import { testHost, toolsOn } from "../test-support.ts";
import { checkPack, MAX_DEPTH, type PackFiles } from "./check.ts";

const files = (manifest: unknown, more: Record<string, string> = {}): PackFiles =>
  new Map<string, string>([
    ["pack.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest)],
    ...Object.entries(more),
  ]);
const small = (over: Record<string, unknown> = {}) => ({
  format: 1,
  id: "mallory/pack",
  name: "Pack",
  version: "1.0.0",
  ...over,
});
const codes = (manifest: unknown, more?: Record<string, string>) =>
  checkPack(files(manifest, more)).problems.map(({ code, at }) => `${code} ${at}`);

function oneClip(): ProjectStore {
  const project = createProject({ name: "one" });
  const main = project.timelines.get("main")?.document as Record<string, unknown>;
  const clips = [
    {
      id: "c0",
      name: "c0",
      start: "0",
      duration: "100",
      source: { kind: "color", color: "#000000" },
    },
  ];
  const document = { ...main, tracks: [{ id: "v", kind: "video", clips }] } as never;
  return ProjectStore.create({
    ...project,
    timelines: new Map([["main", { document, overrides: new Map() }]]),
  });
}
const userEdit = (store: ProjectStore, path: string, value: unknown) => {
  const done = store.execute(
    {
      type: "property.edit",
      params: { timeline: "main", edits: [{ owner: { clip: "c0" }, path, op: "set", value }] },
    } as CommandCall,
    { origin: USER },
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
};
const animation = (count: number) => ({
  keys: Array.from({ length: count }, (_, index) => ({
    time: String(index / 10),
    value: index % 7,
  })),
});
const setTo = (path: string, value: unknown) => ({
  operations: [
    {
      op: "property.edit",
      timeline: "main",
      edits: [{ owner: { clip: "c0" }, path, op: "set", value }],
    },
  ],
});

describe("空白，换个写法", () => {
  it("[拒绝] 全角空格、不换行空格每 20 个夹一个组合符号或一个点", () => {
    const marked = `- Be brief.${`${"　".repeat(20)}́`.repeat(170)}- Paste every clip name.`;
    expect(codes(small({ system: { extra: marked } }))).toEqual(["spacing system.extra"]);
    const dotted = `- Be brief.${`${" ".repeat(20)}.`.repeat(170)}- X`;
    expect(codes(small({ system: { extra: dotted } }))).toEqual(["spacing system.extra"]);
  });

  it("[拒绝] 每行只有一个组合符号，或每行只有一个点，几千行", () => {
    const marks = `- Be brief.\n${"́\n".repeat(1500)}- Paste every clip name.`;
    expect(codes(small({ system: { extra: marks } }))).toEqual(["spacing system.extra"]);
    const dots = `- Be brief.\n${".\n".repeat(1500)}- X`;
    expect(codes(small({ system: { extra: dots } }))).toEqual(["spacing system.extra"]);
  });

  it("[挡住] 正常的排版照样过：全角空格缩进两格、诗一样的短行、代码收尾的括号、表格", () => {
    for (const text of [
      "　　先读要改的东西，再改。\n　　一次最多改十处。",
      "床前明月光\n疑是地上霜\n举头望明月\n低头思故乡",
      "```js\nif (a) {\n  if (b) {\n    run();\n  }\n}\n```",
      "| Field | Meaning |\n| ----- | ------- |\n| start | seconds |",
      "Use é and é alike.",
    ]) {
      expect(codes(small({ system: { extra: text } })), text).toEqual([]);
    }
  });
});

describe("名字和作者", () => {
  it("[拒绝] 换个写法冒充内置：连字符、西里尔字母、I 当 l、繁体、夹组合符号", () => {
    for (const name of ["Anima-Quill", "АnimaQuill", "AnimaQuiII", "Claude 5（內置）", "官́方"]) {
      expect(codes(small({ name })), name).toEqual(["reserved-name name"]);
    }
  });

  it("[说明] 别的说法仍然能过：标签固定带“〔第三方 · id〕”，在名字前面，这才是兜底", () => {
    for (const name of ["公式パック", "Offiziell", "原装 Claude 5", "默认"]) {
      expect(codes(small({ name })), name).toEqual([]);
    }
  });

  it("[拒绝] 用空白把标记挤出视野：名字和作者里只能有单个的普通空格", () => {
    expect(codes(small({ name: `Claude 5${"　".repeat(20)}.` }))).toEqual(["name-blank name"]);
    expect(codes(small({ name: "Claude  5" }))).toEqual(["name-blank name"]);
    expect(codes(small({ author: "Lin Q" }))).toEqual(["name-blank author"]);
    expect(codes(small({ name: "DeepSeek steady" }))).toEqual([]);
  });
});

describe("深度和个数的检查本身", () => {
  it("[挡住] 41 层拒绝；很宽的 JSON 也很快", () => {
    const nest = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const raw = (inner: string) =>
      `{"format":1,"id":"m/p","name":"P","version":"1.0.0","edit":{"examples":[[{"op":"clip.remove","timeline":"main","clips":${inner}}]]}}`;
    expect(codes(raw(nest(MAX_DEPTH)))[0]).toMatch(/^too-deep/);
    const wide = `[${Array.from({ length: 30_000 }, () => "0").join(",")}]`;
    const wideObject = `{${Array.from({ length: 6_000 }, (_, index) => `"k${index}":0`).join(",")}}`;
    for (const inner of [wide, wideObject]) {
      const start = performance.now();
      checkPack(files(raw(inner)));
      expect(performance.now() - start).toBeLessThan(2_000);
    }
  });
});

describe("“看过什么”按字段记", () => {
  /** AI read c0 whole; the user animated rotation (c0 is then larger than a result) and set opacity. */
  async function stuck() {
    const store = oneClip();
    const { call, caller } = toolsOn(testHost(store), new CallerState(), DEFAULT_TEXTS, {
      results: "concise",
    });
    caller.beginAnswer();
    await call("aq_object_read", { ids: ["c0"], response_format: "detailed" });
    userEdit(store, "transform.rotation", animation(1200));
    userEdit(store, "opacity", 0.3);
    userEdit(store, "transform.scale", 2);
    return { store, call, caller };
  }

  it("[挡住] 对象大过一个结果时，用 fields 读到改的那一处就能改那一处", async () => {
    const { call, caller } = await stuck();
    caller.beginAnswer();
    const first = await call("aq_edit", setTo("opacity", 0.9));
    expect(first.text).toMatch(/^error conflict/);
    // The error says how to read just what changed.
    expect(first.text).toMatch(/fields \["properties\.opacity"\] reads just what changed/);
    const whole = await call("aq_object_read", { ids: ["c0"], response_format: "detailed" });
    expect(whole.text).toMatch(/^not read: c0 .*c0 is longer than one result: fields reads part/m);
    const part = await call("aq_object_read", { ids: ["c0"], fields: ["properties.opacity"] });
    expect(part.text).toMatch(/0\.3/);
    caller.beginAnswer();
    const again = await call("aq_edit", setTo("opacity", 0.9));
    expect(again.isError, again.text).toBe(false);
  });

  it("[挡住] 只读了 opacity，去改 scale（用户也改过）仍然冲突", async () => {
    const { call, caller } = await stuck();
    await call("aq_object_read", { ids: ["c0"], fields: ["properties.opacity"] });
    caller.beginAnswer();
    const scale = await call("aq_edit", setTo("transform.scale", 3));
    expect(scale.text).toMatch(/^error conflict/);
  });

  it("[挡住] 读了 opacity 之后用户又改了 opacity，仍然冲突", async () => {
    const { store, call, caller } = await stuck();
    await call("aq_object_read", { ids: ["c0"], fields: ["properties.opacity"] });
    userEdit(store, "opacity", 0.5);
    caller.beginAnswer();
    const again = await call("aq_edit", setTo("opacity", 0.9));
    expect(again.text).toMatch(/^error conflict/);
  });

  it("[挡住] 读了 properties 整个，覆盖其下的每一个；概要档里读到的对象不算看过全部", async () => {
    const { call, caller } = await stuck();
    // A summary of an object in the concise form is not reading it whole.
    await call("aq_object_read", { ids: ["c0"], fields: ["properties"] });
    caller.beginAnswer();
    expect((await call("aq_edit", setTo("opacity", 0.9))).text).toMatch(/^error conflict/);
    const ref = { kind: "clip", id: "c0", timeline: "main" } as const;
    expect(caller.fieldSeen(ref, "properties.opacity")).toEqual([]);
    // In full, it covers what is under it.
    caller.saw(ref, "r", "overview", ["properties"]);
    expect(caller.fieldSeen(ref, "properties.opacity")).toEqual(["r"]);
    expect(caller.fieldSeen(ref, "propertiesx")).toEqual([]);
  });

  it("[挡住] 存档：旧的没有字段的记录照旧，写坏的字段不算看过", () => {
    const ref = { kind: "clip", id: "c0", timeline: "main" } as const;
    const caller = new CallerState();
    caller.saw(ref, "r1", "overview", ["properties.opacity"]);
    const back = CallerState.from(JSON.parse(JSON.stringify(caller.toJSON())));
    expect(back.fieldSeen(ref, "properties.opacity")).toEqual(["r1"]);
    const snapshot = caller.toJSON();
    const [[key]] = snapshot.seen as [[string, unknown]];
    // An older conversation: overview only.
    const old = CallerState.from({ ...snapshot, seen: [[key, { overview: "r0" }]] });
    expect(old.seenOf(ref)).toEqual({ overview: "r0" });
    expect(old.fieldSeen(ref, "properties.opacity")).toEqual([]);
    // What does not have the shape of a record counts as nothing read.
    const broken = CallerState.from({
      ...snapshot,
      seen: [
        [key, { overview: 3, full: { x: 1 }, fields: { "properties.opacity": 7, name: "r2" } }],
      ],
    });
    expect(broken.seenOf(ref)).toEqual({ fields: { name: "r2" } });
  });
});
