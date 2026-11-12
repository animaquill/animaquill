import type { ToolCallEntry, ToolEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { plainTranslate } from "../i18n/failures.ts";
import {
  argFields,
  timeText,
  toolErrorCode,
  toolSummary,
  type Names,
  type Say,
} from "./toolSummary.ts";

const say: Say = (key, options) => {
  const text = plainTranslate(key, options);
  return text === key && typeof options?.defaultValue === "string" ? options.defaultValue : text;
};
const names: Names = {
  timeline: (id) => (id === undefined || id === "main" ? "正片" : undefined),
  object: (id) => ({ clip_open: "开场", clip_city: "城市" })[id],
};
const call = (name: string, args: Record<string, unknown>): ToolCallEntry => ({
  id: "c",
  name,
  args,
});
const result = (data: Record<string, unknown>, ok = true, text = ""): ToolEntry => ({
  role: "tool",
  call: "c",
  name: "x",
  ok,
  text,
  at: 0,
  data,
});
const line = (name: string, args: Record<string, unknown>, done?: ToolEntry) =>
  toolSummary(say, call(name, args), done, names);

describe("the line of a call of a tool", () => {
  it("says what each of the twelve tools did, without JSON", () => {
    expect(line("aq_project_status", {})).toBe("");
    expect(line("aq_selection_read", {})).toBe("");
    expect(line("aq_timeline_read", { from: "50", to: "62" })).toBe("正片 0:50–1:02");
    expect(line("aq_timeline_read", { timeline: "tl_b", tracks: ["v1", "v2"] })).toBe(
      "tl_b · 2 条轨道",
    );
    expect(line("aq_object_read", { ids: ["clip_open"] })).toBe("「开场」");
    expect(line("aq_object_read", { ids: ["clip_open", "clip_city", "clip_x"] })).toBe(
      "「开场」、「城市」 等 3 个",
    );
    expect(line("aq_search", { query: "标题", kinds: ["clip"] })).toBe("「标题」 · 片段");
    expect(line("aq_file_read", { path: "scenes/title/main.js" })).toBe("main.js");
    expect(line("aq_guide", { topic: "ops/clip.move" })).toBe("ops/clip.move");
    expect(
      line("aq_edit", { summary: "加黑场和淡出", operations: [{ op: "clip.add" }, { op: "x" }] }),
    ).toBe("加黑场和淡出 · 2 个操作");
    expect(line("aq_edit", { dry_run: true, operations: [{ op: "clip.add" }] })).toBe(
      "试运行 · 1 个操作",
    );
    const lines = result({
      changes: [{ kind: "file", id: "f", lines: { added: 12, removed: 3 } }],
    });
    expect(line("aq_file_edit", { path: "scenes/title/main.js" }, lines)).toBe("main.js +12 −3 行");
    expect(line("aq_file_write", { path: "code/util.js" }, lines)).toBe("util.js +12 −3 行");
    expect(line("aq_check_run", {}, result({ problems: [{}, {}, {}] }))).toBe("3 个问题");
    expect(line("aq_check_run", {}, result({ problems: [] }))).toBe("通过");
    expect(line("aq_check_run", {})).toBe("");
    expect(line("aq_propose", { question: "标题用哪种颜色？冷一点还是暖一点？" })).toBe(
      "标题用哪种颜色？",
    );
    expect(line("project_overview", {})).toBe("");
  });

  it("writes times of the tools as people read them", () => {
    expect([timeText("0"), timeText("75.5"), timeText("1:20"), timeText(undefined)]).toEqual([
      "0:00",
      "1:15.5",
      "1:20",
      undefined,
    ]);
  });

  it("shows arguments as name and value, an operation by its name and object", () => {
    const fields = argFields({
      summary: "加黑场",
      operations: [
        { op: "clip.add", track: "v1", start: "0" },
        { op: "clip.update", id: "clip_open", properties: { opacity: 0 } },
      ],
      dry_run: false,
      base: { a: 1 },
    });
    expect(fields).toEqual([
      { key: "summary", value: "加黑场", multiline: false },
      { key: "operations", value: "clip.add v1\nclip.update clip_open", multiline: true },
      { key: "dry_run", value: "false", multiline: false },
      { key: "base", value: '{"a":1}', multiline: false },
    ]);
  });

  it("reads the code of an error from the result", () => {
    expect(toolErrorCode(result({}, false, "error conflict: the user changed clip_title"))).toBe(
      "conflict",
    );
    expect(toolErrorCode(result({}, true, "error conflict"))).toBeUndefined();
  });
});
