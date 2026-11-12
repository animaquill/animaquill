import type { CommandFailure } from "@animaquill/core";
import { FAILURE_SAMPLES, INVALID_VALUE_SAMPLES } from "@animaquill/core/failure-samples";
import { describe, expect, it } from "vitest";
import { failureMessage, plainTranslate, translateWith } from "./failures.ts";
import { createI18n } from "./i18n.ts";

const of = (code: string, params: Readonly<Record<string, unknown>>, rest = {}) =>
  failureMessage({ code, params, ...rest } as CommandFailure);

describe("what failures say to people", () => {
  it.each([...FAILURE_SAMPLES, ...INVALID_VALUE_SAMPLES].map((sample) => [sample.code, sample]))(
    "has words for %s",
    async (_, sample) => {
      const text = failureMessage(sample as CommandFailure);
      expect(text.length).toBeGreaterThan(3);
      expect(text).not.toMatch(/^failures\.|\{\{|undefined/);
      const { t } = await createI18n();
      expect(failureMessage(sample as CommandFailure, translateWith(t))).toBe(text);
    },
  );

  /** What the commands said themselves before they said it with codes. */
  it.each([
    [of("not-found", { kind: "clip", id: "c9" }), "没有这个片段：c9"],
    [of("not-found", { kind: "effect", id: "fx", clip: "c1" }), "片段 c1 没有这个效果：fx"],
    [
      of("not-found", { kind: "effect", id: "x", why: { reason: "unknown", type: "x" } }),
      "没有这个效果：x",
    ],
    [of("id-taken", { kind: "track", id: "a", by: "track" }), "这个 ID 已经有轨道了：a"],
    [
      of("id-taken", { kind: "effect", id: "fx", by: "effect" }),
      "这个片段已经有这个 ID 的效果了：fx",
    ],
    [
      of("wrong-track", { trackKind: "audio", holds: "clip", sourceKind: "image" }),
      "audio 轨道不能放 image 片段",
    ],
    [of("overlap", { clips: [{ id: "c2", name: "片头" }] }), "这里已经有片段了：片头"],
    [
      of("overlap", { clips: [{ id: "a" }, { id: "b" }], moved: true }),
      "片段落在了同一个位置：a、b",
    ],
    [of("source-end", { clip: "c1" }), "已经到内容的结尾了：c1"],
    [of("transition-missing", { why: { reason: "unknown", type: "spin" } }), "没有这个转场：spin"],
    [
      of("transition-unsupported", { type: "fade", media: "sound", use: "enter" }),
      "这一版的编辑器还不能播放声音的入转场",
    ],
    [
      of("transition-unsupported", { type: "fade", media: "picture", use: "enter", caption: true }),
      "这一版的编辑器还不能显示字幕的转场",
    ],
    [
      of("transition-too-long", { why: "longest", longest: "0.4" }),
      "衔接转场太长，这里最长 0.4 秒",
    ],
    [
      of("asset-in-use", { asset: "a", by: "code", file: "code/a.js" }),
      "代码在用这个素材，要先改掉：code/a.js",
    ],
    [
      of("file-too-large", { path: "code/a.js", limit: 8 * 1024 ** 2 }),
      "文件不能超过 8 MiB：code/a.js",
    ],
    [of("not-in-use", { kind: "scene", id: "s" }), "没有片段在用这个场景：s"],
    [
      of("invalid-params", {
        issues: [{ path: "clips.0.start", issue: "x", message: "要写成字符串" }],
      }),
      "clips.0.start：要写成字符串",
    ],
    [of("invalid-value", { rule: "min", path: "opacity", min: 0 }), "opacity 不能小于 0"],
    [
      of("invalid-value", { rule: "replace-same", kind: "asset", id: "a" }),
      "换成的素材和原来的是同一个：a",
    ],
    [
      of("invalid-value", { rule: "format", path: "source.color", message: "颜色不对" }),
      "source.color：颜色不对",
    ],
    [
      of("undo-blocked", {}, { obstacle: "inUse" }),
      "这一步还被别的内容用着，或者用到的东西已经没了，已跳过",
    ],
    [of("user-only", { command: "project.setTags" }), "只有用户能运行这个命令：project.setTags"],
    [of("missing-updates", {}), "别的窗口的改动还没有收全，等一下再试。一直这样的话，刷新页面"],
  ])("says %s as before", (text, before) => {
    expect(text).toBe(before);
  });

  it("fills in texts without i18next the way it does", () => {
    expect(plainTranslate("failures.not-found.clip", { id: "c" })).toBe("没有这个片段：c");
    expect(plainTranslate("failures.no-such-text")).toBe("failures.no-such-text");
  });
});
