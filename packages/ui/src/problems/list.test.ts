import { describe, expect, it, vi } from "vitest";
import { ProblemList, severityOf } from "./list.ts";

const said = (text: string, line?: number) => ({
  severity: "error" as const,
  text,
  file: "scenes/a/index.html",
  origin: "片段",
  ...(line === undefined ? {} : { line }),
});

const texts = (list: ProblemList) => list.getSnapshot().problems.map(({ text }) => text);

describe("the list of problems", () => {
  it("lists what a scene says, with how many of each kind", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了", 3));
    list.noteScene("c", "1", { ...said("提醒", 1), severity: "warning" });
    const { errors, warnings, problems } = list.getSnapshot();
    expect([errors, warnings]).toEqual([1, 1]);
    expect(problems.map(({ line }) => line)).toEqual([1, 3]);
  });

  it("says something once, however many clips run into it", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了", 3));
    list.noteScene("c", "1", said("坏了", 3));
    list.noteScene("d", "1", said("坏了", 3));
    expect(texts(list)).toEqual(["坏了"]);
  });

  it("forgets what a state of a scene said when it is gone", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("旧的"));
    list.noteScene("c", "2", said("新的"));
    list.keepRevisions(new Map([["c", "2"]]));
    expect(texts(list)).toEqual(["新的"]);
  });

  it("keeps a problem for as long as one of its clips still shows that state", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了"));
    list.noteScene("d", "1", said("坏了"));
    list.keepRevisions(new Map([["d", "1"]]));
    expect(texts(list)).toEqual(["坏了"]);
    list.keepRevisions(new Map());
    expect(texts(list)).toEqual([]);
  });

  it("keeps the problems of a scene that only went out of reach", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了"));
    list.keepRevisions(new Map([["c", "1"]]));
    expect(texts(list)).toEqual(["坏了"]);
  });

  it("tells nobody when nothing changed", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了"));
    const heard = vi.fn();
    list.subscribe(heard);
    list.noteScene("c", "1", said("坏了"));
    list.keepRevisions(new Map([["c", "1"]]));
    list.setFile("a.js", []);
    list.clearImport();
    expect(heard).not.toHaveBeenCalled();
  });

  it("has a limit, because a project can say anything", () => {
    const list = new ProblemList();
    for (let index = 0; index < 600; index += 1) list.noteScene("c", "1", said(`第 ${index} 个`));
    expect(list.getSnapshot().problems).toHaveLength(500);
  });

  it("drops a scene that stopped when it runs again, or its clip is gone", () => {
    const list = new ProblemList();
    list.noteStopped("c", { severity: "error", text: "卡死了", origin: "片段" });
    list.noteStopped("d", { severity: "error", text: "也卡死了", origin: "片段" });
    list.noteStopped("c", undefined);
    expect(texts(list)).toEqual(["也卡死了"]);
    list.keepRevisions(new Map());
    expect(texts(list)).toEqual([]);
  });

  it("replaces what it knows of a file, and nothing else", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("运行时"));
    list.setFile("scenes/a/x.js", [{ ...said("语法", 1), file: "scenes/a/x.js" }]);
    list.setFile("scenes/a/x.js", [{ ...said("别的", 1), file: "scenes/a/x.js" }]);
    expect(texts(list).toSorted()).toEqual(["别的", "运行时"].toSorted());
    list.setFile("scenes/a/x.js", []);
    expect(texts(list)).toEqual(["运行时"]);
  });

  it("keeps what an import said until people clear it", () => {
    const list = new ProblemList();
    list.noteImport([{ severity: "warning", text: "素材没带来", origin: "导入" }]);
    list.keepRevisions(new Map());
    expect(list.getSnapshot().imported).toBe(true);
    list.clearImport();
    expect(list.getSnapshot()).toMatchObject({ imported: false, problems: [] });
  });

  it("starts over with another project", () => {
    const list = new ProblemList();
    list.noteScene("c", "1", said("坏了"));
    list.noteImport([said("没带来")]);
    list.setFile("a.js", [said("语法")]);
    list.clear();
    expect(list.getSnapshot()).toMatchObject({ problems: [], errors: 0, imported: false });
    // What was there does not come back with the next thing that changes.
    list.noteScene("c", "1", said("新的"));
    expect(texts(list)).toEqual(["新的"]);
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

  it("has what is wrong with properties, which is all of that at once", () => {
    const list = new ProblemList();
    let heard = 0;
    list.subscribe(() => (heard += 1));
    const orphan = { severity: "warning" as const, text: "没人认领", origin: "片段" };
    list.setProperties([orphan]);
    expect(texts(list)).toEqual(["没人认领"]);
    list.setProperties([orphan]);
    expect(heard).toBe(1);
    list.setProperties([]);
    expect(texts(list)).toEqual([]);
    list.setProperties([orphan]);
    list.clear();
    expect(texts(list)).toEqual([]);
  });

  it("gets the newest action of a problem that reads the same", () => {
    const list = new ProblemList();
    const run = vi.fn();
    const problem = (go: () => void) => ({
      severity: "warning" as const,
      text: "改名了",
      origin: "片段",
      action: { label: "迁移", run: go },
    });
    list.setProperties([problem(() => {})]);
    list.setProperties([problem(run)]);
    list.getSnapshot().problems[0]?.action?.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
