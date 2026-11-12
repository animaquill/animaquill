import { ProjectStore, type ProjectProblem, type ProjectState } from "@animaquill/core";
import { createProject, type Project, type Timeline } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { Dialogs } from "../workbench/dialogs.ts";
import { OutputDifferences } from "./output.ts";

const t = (await createI18n()).t as TFunction;

function stateWith(clips: readonly object[]): ProjectState {
  const created = createProject({ name: "导出" });
  const tracks = [{ id: "v", kind: "video", clips }] as Timeline["tracks"];
  const document: Timeline = { name: "主线", sections: [{ id: "s", duration: "30" }], tracks };
  const project: Project = {
    ...created,
    timelines: new Map([["main", { document, overrides: new Map() }]]),
  };
  return ProjectStore.create(project).getState();
}

const red = (id: string, more: object = {}) => ({
  id,
  name: id,
  start: "0",
  duration: "5",
  source: { kind: "color", color: "#ff0000" },
  ...more,
});

function setup() {
  const dialogs = new Dialogs();
  const shown: ProjectProblem[] = [];
  const check = new OutputDifferences({ dialogs, t, goTo: (problem) => shown.push(problem) });
  return { dialogs, check, shown };
}

const query = { timeline: "main", part: "both" } as const;

describe("asking before an export", () => {
  it("asks nothing when the export is what the project says", async () => {
    const { dialogs, check } = setup();
    const heard = vi.fn();
    dialogs.subscribe(heard);
    expect(await check.confirm(stateWith([red("红")]), query)).toBe(true);
    // Neither does what the project has that changes nothing of this export.
    const hidden = stateWith([red("红", { draft: true, hidden: true })]);
    expect(await check.confirm(hidden, query)).toBe(true);
    expect(heard).not.toHaveBeenCalled();
  });

  it("lists what would be otherwise, each line going there, and exports only when people say", async () => {
    const { dialogs, check, shown } = setup();
    const state = stateWith([red("想法", { draft: true })]);
    const asking = check.confirm(state, query);
    const dialog = dialogs.getSnapshot();
    if (dialog?.kind !== "confirm") throw new Error("No dialog");
    expect(dialog).toMatchObject({ title: "导出的视频会和项目不一样", confirm: "仍然导出" });
    expect(dialog.danger).toBeUndefined();
    const [line] = dialog.details?.[0]?.items ?? [];
    if (typeof line !== "object") throw new Error("No line to go to");
    expect(line.label).toBe("想法：这是样片，本来不该进成片，这一版的编辑器还照常显示和导出它");
    line.show();
    expect(shown.map(({ code }) => code)).toEqual(["unsupported-draft"]);
    dialogs.answer(false);
    expect(await asking).toBe(false);
    const again = check.confirm(state, query);
    dialogs.answer(true);
    expect(await again).toBe(true);
  });

  it("says how many more there are than it lists", async () => {
    const { dialogs, check } = setup();
    const clips = Array.from({ length: 40 }, (_, index) => red(`c${index}`, { draft: true }));
    const asking = check.confirm(stateWith(clips), query);
    const dialog = dialogs.getSnapshot();
    if (dialog?.kind !== "confirm") throw new Error("No dialog");
    const items = dialog.details?.[0]?.items ?? [];
    expect(items).toHaveLength(31);
    expect(items.at(-1)).toBe("还有 10 处没有列出，在问题选项卡里能看到全部");
    dialogs.answer(false);
    await asking;
  });
});
