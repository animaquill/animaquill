import type { ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { testHost, toolsOn } from "./test-support.ts";
import { PLAN_FIRST } from "./tool.ts";
import { DEFINITIONS, WRITE_TOOLS } from "./toolset.ts";
import type { ToolResult } from "./types.ts";

/**
 * "先出方案" (docs/design/changes-and-gates.md of AnimaQuill Cloud, 3): while people asked for a plan
 * first, no tool changes the project, whatever it is called with. The gate is one, in `makeTool`, by
 * whether a tool writes; these tests are what keeps it there.
 */

const codeOf = (result: ToolResult | undefined) => /^error ([a-z-]+)/.exec(result?.text ?? "")?.[1];

const marker = (name: string, extra: Record<string, unknown> = {}) => ({
  operations: [{ op: "marker.add", timeline: "main", time: "7", name }],
  ...extra,
});

/** Calls of each tool that changes the project, as a model may write them: right and wrong. */
const CALLS: Readonly<Record<string, readonly unknown[]>> = {
  aq_edit: [
    marker("Plan"),
    marker("Plan", { dry_run: true }),
    marker("Plan", { request_id: "r1" }),
    marker("Plan", { request_id: "r1", dry_run: true }),
    marker("Plan", { base_revision: "nonsense" }),
    { operations: [{ op: "clip.remove", timeline: "main", clip: "nobody" }] },
    { operations: "[]" },
    {},
    undefined,
    "aq_edit",
  ],
  aq_file_edit: [
    { path: "code/plan.js", edits: [{ old_text: "a", new_text: "b" }] },
    { path: "code/plan.js", edits: [{ old_text: "a", new_text: "b" }], request_id: "r2" },
    {},
  ],
  aq_file_write: [
    { path: "code/plan.js", text: "export const plan = 1;\n" },
    { path: "code/plan.js", text: "export const plan = 1;\n", request_id: "r3" },
    { path: "../outside.js", text: "x" },
    {},
  ],
};

describe("plan first", () => {
  it("knows the tools that change the project: aq_edit, aq_file_edit, aq_file_write", () => {
    expect([...WRITE_TOOLS].toSorted()).toEqual(Object.keys(CALLS).toSorted());
  });

  it.each([...WRITE_TOOLS])(
    "%s answers plan-first to any call, writes nothing, and holds nothing back",
    async (name) => {
      const host = testHost();
      host.plan = true;
      const { call, tools, caller } = toolsOn(host);
      const store = host.store() as ProjectStore;
      const revision = store.revisionId;
      const files = store.exportFiles().files;
      // Each tool that changes the project, even one this table does not know yet, with nothing.
      for (const args of [...(CALLS[name] ?? []), {}]) {
        caller.beginAnswer();
        expect(tools.get(name)?.validate(args)?.text).toBe(PLAN_FIRST);
        const result = await call(name, args);
        expect(result.text, JSON.stringify(args)).toBe(PLAN_FIRST);
        expect(result.isError).toBe(true);
        // The same again, as a model sends it twice.
        expect((await call(name, args)).text).toBe(PLAN_FIRST);
      }
      expect(store.revisionId).toBe(revision);
      expect(store.exportFiles().files).toEqual(files);
      // Nothing is held back: the answer goes on reading, and hands over its plan.
      expect(caller.answer.failedWrite).toBeFalsy();
      expect((await call("aq_timeline_read", {})).isError).toBe(false);
      const plan = await call("aq_propose", {
        kind: "plan",
        title: "Intro",
        steps: [{ text: "Logo fades in", from: "0", to: "4" }],
      });
      expect(plan.isError).toBe(false);
    },
  );

  it("gives no result kept from before the switch, by request_id", async () => {
    const host = testHost();
    const { call } = toolsOn(host);
    const store = host.store() as ProjectStore;
    const written = await call("aq_edit", marker("Kept", { request_id: "same" }));
    expect(written.isError).toBe(false);
    const wrote = await call("aq_file_write", {
      path: "code/kept.js",
      text: "export const kept = 1;\n",
      request_id: "file",
    });
    expect(wrote.isError).toBe(false);
    // Sent again with the same request_id, it would give the same result back without running.
    expect((await call("aq_edit", marker("Kept", { request_id: "same" }))).text).toBe(written.text);
    host.plan = true;
    const revision = store.revisionId;
    expect((await call("aq_edit", marker("Kept", { request_id: "same" }))).text).toBe(PLAN_FIRST);
    expect(
      (
        await call("aq_file_write", {
          path: "code/kept.js",
          text: "export const kept = 1;\n",
          request_id: "file",
        })
      ).text,
    ).toBe(PLAN_FIRST);
    expect(store.revisionId).toBe(revision);
  });

  it("leaves every other tool as it is, aq_propose and aq_render_frames too", async () => {
    const host = testHost();
    host.plan = true;
    const { call } = toolsOn(host);
    for (const { name } of DEFINITIONS.filter(({ writes }) => writes !== true)) {
      expect(codeOf(await call(name, {})), name).not.toBe("plan-first");
    }
  });

  it("asks the host for each call: off again, changes go", async () => {
    const host = testHost();
    host.plan = true;
    const { call, caller } = toolsOn(host);
    expect((await call("aq_edit", marker("Later"))).text).toBe(PLAN_FIRST);
    host.plan = false;
    caller.beginAnswer();
    expect((await call("aq_edit", marker("Later"))).isError).toBe(false);
  });
});

describe("aq_propose with kind plan", () => {
  const plan = {
    kind: "plan",
    title: "片头 30 秒",
    steps: [
      { text: "黑底淡入 logo，低音起", from: "0", to: "4" },
      { text: "三张产品图依次推进", from: "4", to: "12" },
      { text: "标题逐字弹出" },
    ],
    length: "30",
    style: "冷色、干净",
  };

  it("shows the plan, ends the turn, and gives the plan to the chat", async () => {
    const { call } = toolsOn();
    const result = await call("aq_propose", plan);
    expect(result.isError).toBe(false);
    expect(result.terminate).toBe(true);
    expect(result.data?.plan).toEqual(plan);
    expect(result.text).toContain("The plan is shown to the user");
  });

  it("is one per answer, with a question too", async () => {
    const { call } = toolsOn();
    await call("aq_propose", plan);
    const again = await call("aq_propose", {
      kind: "question",
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }],
    });
    expect(codeOf(again)).toBe("one-at-a-time");
  });

  it.each([
    [{ kind: "plan", steps: plan.steps }, 'title: required with kind "plan"'],
    [{ kind: "plan", title: "x" }, 'steps: required with kind "plan"'],
    [{ ...plan, steps: [] }, "steps"],
    [{ ...plan, steps: Array.from({ length: 21 }, () => ({ text: "x" })) }, "steps"],
    [{ ...plan, question: "Which?" }, 'question: goes only with kind "question"'],
    [{ ...plan, steps: [{ text: "x", from: "5", to: "2" }] }, "steps.0: from has to be before to"],
    [{ ...plan, steps: [{ text: "x", from: "soon" }] }, "from"],
    [{ ...plan, title: "x".repeat(81) }, "title"],
    [
      {
        kind: "question",
        question: "Which?",
        options: [{ label: "A" }, { label: "B" }],
        title: "x",
      },
      'title: goes only with kind "plan"',
    ],
    [{ kind: "question", question: "Which?" }, 'options: required with kind "question"'],
    [{ kind: "experience" }, "kind"],
  ])("refuses %j", async (args, line) => {
    const { call } = toolsOn();
    const result = await call("aq_propose", args);
    expect(codeOf(result)).toBe("invalid-params");
    expect(result.text).toContain(line);
  });
});
