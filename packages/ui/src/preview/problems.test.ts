import type { ClipState, ProjectState } from "@animaquill/core";
import type { SceneProblem } from "@animaquill/scene";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import zhCN from "../i18n/zh-CN.json";
import { describeProblem, sceneClipName } from "./problems.ts";

const { t } = await createI18n();

const of = (problem: Omit<SceneProblem, "frame">) =>
  describeProblem(t as TFunction, { frame: 0, ...problem });

describe("what a problem says", () => {
  it("says where code went wrong", () => {
    expect(of({ kind: "error", message: "x is not defined", file: "a.js", line: 3 })).toBe(
      "代码出错：x is not defined（a.js 第 3 行）",
    );
    expect(of({ kind: "error", message: "oops" })).toBe("代码出错：oops");
  });

  it("leaves text from a project as it is", () => {
    expect(of({ kind: "error", message: "<b>&amp;" })).toBe("代码出错：<b>&amp;");
  });

  it("says what a code means, with what it is about", () => {
    expect(of({ kind: "api", code: "missing-asset", target: "logo" })).toBe(
      "这个素材场景拿不到：logo",
    );
    expect(of({ kind: "loader", code: "missing-file", target: "a.png" })).toBe("文件不在：a.png");
  });

  it("shows a code nobody knows yet as it is", () => {
    expect(of({ kind: "api", code: "from-the-future" })).toBe("from-the-future");
  });

  it("has words for every problem the runtime and the loader know of", () => {
    const known = Object.keys(zhCN.scene.problems.codes);
    expect(known).toEqual(
      expect.arrayContaining([
        "above-root",
        "bad-import-map",
        "bad-path",
        "bare-import",
        "base-tag",
        "canvas-layer",
        "capture-failed",
        "capture-timeout",
        "content-timeout",
        "css-import-cycle",
        "external-url",
        "focus",
        "frameset",
        "import-map-scopes",
        "missing-asset",
        "missing-entry",
        "missing-file",
        "slow-work",
        "too-many-problems",
        "top-layer",
        "unclosed-script",
        "worker-import-cycle",
        "worker-timing",
        "worklet",
      ]),
    );
  });
});

describe("what a clip is called", () => {
  const state = { scenes: { a: { name: "片头", entry: "index.html", runtime: 1 } } } as never;
  const clip = (extra: object) =>
    ({ id: "c", start: "0", duration: "1", track: "t", ...extra }) as ClipState;

  it("is what people named it", () => {
    const named = clip({ name: "我的片段", source: { kind: "scene", scene: "a" } });
    expect(sceneClipName(named, state as ProjectState, t as TFunction)).toBe("我的片段");
  });

  it("is what its scene is called", () => {
    const plain = clip({ source: { kind: "scene", scene: "a" } });
    expect(sceneClipName(plain, state as ProjectState, t as TFunction)).toBe("片头");
  });

  it("is at least something", () => {
    expect(sceneClipName(undefined, state as ProjectState, t as TFunction)).toBe("场景");
    const gone = clip({ source: { kind: "scene", scene: "nope" } });
    expect(sceneClipName(gone, state as ProjectState, t as TFunction)).toBe("场景");
  });
});
