import {
  PROPERTY_CODES,
  ProjectStore,
  UNSUPPORTED_CODES,
  withId,
  type ProjectProblem,
  type ProjectState,
} from "@animaquill/core";
import { createProject, type Project, type Timeline } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { ProblemList, canGoTo, sceneProblem, severityOf } from "./list.ts";
import { describeProjectProblem, originOf } from "./words.ts";

const t = (await createI18n()).t as TFunction;

const error = (message: string, line?: number) =>
  sceneProblem(
    {
      kind: "error",
      message,
      file: "scenes/a/index.html",
      frame: 0,
      ...(line !== undefined && { line }),
    },
    { kind: "scene", id: "a" },
  );

function stateWith(tracks: Timeline["tracks"]): ProjectState {
  const created = createProject({ name: "问题" });
  const document: Timeline = { name: "主线", sections: [{ id: "s", duration: "30" }], tracks };
  const project: Project = {
    ...created,
    timelines: new Map([["main", { document, overrides: new Map() }]]),
  };
  return ProjectStore.create(project).getState();
}

const draft = (name?: string) =>
  stateWith([
    {
      id: "v",
      kind: "video",
      clips: [
        {
          id: "idea",
          start: "0",
          duration: "2",
          source: { kind: "color", color: "#000000" },
          draft: true,
          ...(name && { name }),
        },
      ],
    } as never,
  ]);

function listOf(state: () => ProjectState | undefined = () => undefined, fix = vi.fn()) {
  return new ProblemList({ t, state, fix });
}

const texts = (list: ProblemList) => list.getSnapshot().problems.map(({ text }) => text);

describe("the list of problems", () => {
  it("lists what a scene says, with how many of each kind", () => {
    const list = listOf();
    list.noteScene("c", "1", error("坏了", 3), "片段");
    list.noteScene(
      "c",
      "1",
      sceneProblem(
        { kind: "api", code: "focus", frame: 0, line: 1, file: "scenes/a/index.html" },
        undefined,
      ),
      "片段",
    );
    const { errors, warnings, problems } = list.getSnapshot();
    expect([errors, warnings]).toEqual([1, 1]);
    expect(problems.map(({ line }) => line)).toEqual([1, 3]);
    // Where it is has a column of its own, so the words leave it out.
    expect(problems[1]).toMatchObject({
      text: "代码出错：坏了",
      origin: "片段",
      file: "scenes/a/index.html",
      line: 3,
    });
  });

  it("says something once, however many clips run into it", () => {
    const list = listOf();
    list.noteScene("c", "1", error("坏了", 3), "一");
    list.noteScene("c", "1", error("坏了", 3), "一");
    list.noteScene("d", "1", error("坏了", 3), "二");
    expect(list.getSnapshot().problems.map(({ origin }) => origin)).toEqual(["一"]);
  });

  it("forgets what a state of a scene said when it is gone", () => {
    const list = listOf();
    list.noteScene("c", "1", error("旧的"), "片段");
    list.noteScene("c", "2", error("新的"), "片段");
    list.keepRevisions(new Map([["c", "2"]]));
    expect(texts(list)).toEqual(["代码出错：新的"]);
  });

  it("keeps a problem for as long as one of its clips still shows that state", () => {
    const list = listOf();
    list.noteScene("c", "1", error("坏了"), "片段");
    list.noteScene("d", "1", error("坏了"), "片段");
    list.keepRevisions(new Map([["d", "1"]]));
    expect(texts(list)).toEqual(["代码出错：坏了"]);
    list.keepRevisions(new Map());
    expect(texts(list)).toEqual([]);
  });

  it("tells nobody when nothing changed", () => {
    const list = listOf();
    list.noteScene("c", "1", error("坏了"), "片段");
    const heard = vi.fn();
    list.subscribe(heard);
    list.noteScene("c", "1", error("坏了"), "片段");
    list.keepRevisions(new Map([["c", "1"]]));
    list.setFile("a.js", []);
    list.clearImport();
    list.update();
    expect(heard).not.toHaveBeenCalled();
  });

  it("has a limit, because a project can say anything", () => {
    const list = listOf();
    for (let index = 0; index < 600; index += 1)
      list.noteScene("c", "1", error(`第 ${index} 个`), "片段");
    expect(list.getSnapshot().problems).toHaveLength(500);
  });

  it("drops a scene that stopped when it runs again, or its clip is gone", () => {
    const list = listOf();
    const stopped = (clip: string) =>
      withId({
        source: "runtime",
        severity: "error",
        code: "scene-stopped",
        params: { state: "stopped", reason: "silent" },
        subject: { kind: "clip", id: clip, timeline: "main" },
      });
    list.noteStopped("c", stopped("c"));
    list.noteStopped("d", stopped("d"));
    list.noteStopped("c", undefined);
    expect(list.getSnapshot().problems.map(({ problem }) => problem?.subject?.id)).toEqual(["d"]);
    expect(texts(list)).toEqual(["“d”卡死了，已经停止运行。"]);
    list.keepRevisions(new Map());
    expect(texts(list)).toEqual([]);
  });

  it("replaces what it knows of a file, and nothing else", () => {
    const list = listOf();
    const said = (text: string) => ({
      severity: "error" as const,
      text,
      file: "scenes/a/x.js",
      line: 1,
      origin: "代码编辑器",
    });
    list.noteScene("c", "1", error("运行时"), "片段");
    list.setFile("scenes/a/x.js", [said("语法")]);
    list.setFile("scenes/a/x.js", [said("别的")]);
    expect(texts(list).toSorted()).toEqual(["代码出错：运行时", "别的"].toSorted());
    list.setFile("scenes/a/x.js", []);
    expect(texts(list)).toEqual(["代码出错：运行时"]);
    expect(list.set.all().map(({ source }) => source)).toEqual(["runtime"]);
  });

  it("keeps what an import said until people clear it", () => {
    const list = listOf();
    list.noteImport([
      { severity: "warning", text: "素材没带来", origin: "导入", code: "asset-missing" },
    ]);
    list.keepRevisions(new Map());
    expect(list.getSnapshot()).toMatchObject({
      imported: true,
      problems: [{ text: "素材没带来", origin: "导入" }],
    });
    expect(list.set.all()[0]).toMatchObject({
      source: "import",
      code: "asset-missing",
      detail: "素材没带来",
    });
    list.clearImport();
    expect(list.getSnapshot()).toMatchObject({ imported: false, problems: [] });
  });

  it("keeps the newest action of what a folder says, which reads the same", () => {
    const list = listOf();
    const run = vi.fn();
    const said = (go: () => void) => ({
      severity: "error" as const,
      text: "等着",
      file: "a.json",
      origin: "外部文件",
      action: { label: "用编辑器的", run: go },
    });
    list.setFolder([said(() => {})]);
    list.setFolder([said(run)]);
    list.getSnapshot().problems[0]?.action?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("starts over with another project", () => {
    let state: ProjectState | undefined = draft();
    const list = listOf(() => state);
    list.update();
    list.noteScene("c", "1", error("坏了"), "片段");
    list.noteImport([{ severity: "warning", text: "没带来", origin: "导入" }]);
    list.setFile("a.js", [{ severity: "error", text: "语法", origin: "代码编辑器" }]);
    state = undefined;
    list.clear();
    expect(list.getSnapshot()).toMatchObject({ problems: [], errors: 0, imported: false });
    // What was there does not come back with the next thing that changes.
    list.noteScene("c", "1", error("新的"), "片段");
    expect(texts(list)).toEqual(["代码出错：新的"]);
  });

  it("has what the project tells by itself, in the words of now", () => {
    let state = draft();
    const list = listOf(() => state);
    list.update();
    expect(list.getSnapshot().problems).toMatchObject([
      {
        severity: "warning",
        text: "这是样片，本来不该进成片，这一版的编辑器还照常显示和导出它",
        origin: "纯色",
        problem: { code: "unsupported-draft", affectsOutput: "picture" },
      },
    ]);
    const heard = vi.fn();
    list.subscribe(heard);
    state = draft("想法");
    list.update();
    expect(heard).toHaveBeenCalledOnce();
    expect(list.getSnapshot().problems[0]?.origin).toBe("想法");
    state = stateWith([]);
    list.update();
    expect(list.getSnapshot().problems).toEqual([]);
  });

  it("runs what fixes a problem, as the step it is", () => {
    const fix = vi.fn();
    const list = listOf(() => undefined, fix);
    const renamed: ProjectProblem = withId({
      source: "properties",
      severity: "warning",
      code: "property-renamed",
      params: { from: "object.a.angle", to: "object.a.rotation" },
      fix: { type: "property.rename", params: { timeline: "main", renames: [] } },
    });
    list.set.report("runtime", "test", [renamed]);
    const [listed] = list.getSnapshot().problems;
    expect(listed?.action?.label).toBe("迁移");
    listed?.action?.run();
    expect(fix).toHaveBeenCalledWith(renamed.fix);
  });
});

describe("how bad a problem is", () => {
  it("is an error when code failed, and a warning otherwise", () => {
    expect(severityOf({ kind: "error" })).toBe("error");
    expect(severityOf({ kind: "rejection" })).toBe("error");
    expect(severityOf({ kind: "blocked" })).toBe("warning");
    expect(severityOf({ kind: "api" })).toBe("warning");
    expect(severityOf({ kind: "loader" })).toBe("warning");
    expect(severityOf({ kind: "resource" })).toBe("warning");
  });
});

describe("the words of a problem", () => {
  const about = (code: string, params: ProjectProblem["params"] = {}) =>
    describeProjectProblem(
      t,
      withId({ source: "unsupported", severity: "warning", code, params }),
      undefined,
      "片段",
    );

  it("are there in Chinese for every code that the project alone tells", () => {
    const params: Record<string, ProjectProblem["params"]> = {
      "unsupported-audio-effect": { where: "clip", count: 1 },
      "unsupported-audio-property": { property: "audio.pan" },
      "property-mismatch": { path: "x", type: "number" },
    };
    for (const code of [...UNSUPPORTED_CODES, ...PROPERTY_CODES]) {
      const words = about(code, params[code] ?? { problem: "object-id" });
      expect(words, code).not.toContain(code);
      expect(words, code).not.toContain("problems.");
      expect(words, code).toMatch(/[一-鿿]/);
    }
    for (const where of ["clip", "track", "mix"]) {
      expect(about("unsupported-audio-effect", { where, count: 2 })).not.toContain("problems.");
    }
    for (const property of ["audio.pan", "audio.pitch", "audio.preservePitch", "time.speed"]) {
      expect(about("unsupported-audio-property", { property })).not.toContain(
        property.slice(0, 0) + "problems.",
      );
    }
  });

  it("say what it is about with the names of the project", () => {
    expect(about("unsupported-audio-property", { property: "audio.pan" })).toBe(
      "声像（audio.pan）这一版还不生效，预览和导出里都是没有它的样子",
    );
    expect(about("unsupported-library", { library: "<库>" })).toBe(
      "用到了库“<库>”里的内容，这一版还不能取库里的东西，预览和导出里没有它",
    );
  });

  it("go to a file or to what the problem is about, or nowhere", () => {
    const listed = { id: "", severity: "warning", text: "", origin: "" } as const;
    expect(canGoTo(listed)).toBe(false);
    expect(canGoTo({ ...listed, file: "a.js" })).toBe(true);
    const problem = withId({
      source: "unsupported",
      severity: "warning",
      code: "x",
      params: {},
      subject: { kind: "track", id: "v", timeline: "main" },
    });
    expect(canGoTo({ ...listed, problem })).toBe(true);
    expect(originOf(t, problem, stateWith([{ id: "v", kind: "video", clips: [] } as never]))).toBe(
      "视频 1",
    );
  });
});
