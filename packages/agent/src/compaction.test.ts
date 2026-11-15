import { ProblemSet, ProjectStore, aiTask } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { CallerState, createToolset } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import { toolSpecsOf } from "./assistant.ts";
import { COMPACT_PROMPT, cutOf, fills, summaryMessage, transcriptOf } from "./compaction.ts";
import { Conversation, type TaskTarget } from "./conversation.ts";
import type {
  AssistantEntry,
  ChatEntry,
  SummaryEntry,
  ToolEntry,
  ToolPicture,
  UserEntry,
} from "./entries.ts";
import type { FakeEndpoint } from "./pi.ts";

/**
 * Making room in the context (mcp.md 8 "压缩" of AnimaQuill Cloud): once the last request took
 * 80 % of it, the same model sums up all but the last two turns with a fixed prompt, kept as an
 * entry of its own; nothing before changes, old pictures go as a line; where no summary comes, only
 * the old pictures go, and a conversation that still does not fit says so.
 */

const WINDOW = 10_000;

const picture = (name: string): ToolPicture => ({
  image: `sha256:${name.padEnd(64, "0").slice(0, 64)}`,
  type: "image/jpeg",
  width: 1024,
  height: 576,
  bytes: 1000,
  note: `[image 1: frame of timeline main at t=${name}, 1024×576]`,
  role: "frame",
  shot: 0,
});

const user = (text: string, task: string, at: number): UserEntry => ({
  role: "user",
  text,
  task,
  at,
});
const answer = (
  text: string,
  at: number,
  input: number,
  calls: AssistantEntry["calls"] = [],
): AssistantEntry => ({
  role: "assistant",
  text,
  calls,
  at,
  end: calls.length > 0 ? "tools" : "done",
  service: "fake",
  protocol: "faux",
  model: "fake",
  usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, window: WINDOW },
});
const looked = (call: string, at: number, t: string): ToolEntry => ({
  role: "tool",
  call,
  name: "aq_render_frames",
  ok: true,
  text: `rev x:1\nthe frame at t=${t}`,
  at,
  images: [picture(t)],
});

/** Three turns, the first with a picture AI looked at, the last answer at 85 % of the context. */
function history(input = 8_500): ChatEntry[] {
  const look = { id: "call_1", name: "aq_render_frames", args: { times: ["12"] } };
  return [
    user("把标题挪到中间偏下", "t1", 1),
    answer("", 2, 2_000, [look]),
    looked("call_1", 3, "12"),
    answer("挪好了，标题在 clip_title。", 4, 3_000),
    user("再把 Logo 缩小一点", "t2", 5),
    answer("Logo 缩小到 80%。", 6, 5_000),
    user("配乐有没有爆音？", "t3", 7),
    answer("有两处削波。", 8, input),
  ];
}

interface Heard {
  readonly role: string;
  readonly content: unknown;
}

function setUp(
  fake: FakeEndpoint["fake"],
  options: { readonly entries?: readonly ChatEntry[]; readonly compact?: boolean } = {},
) {
  const store = ProjectStore.create(createProject({ name: "压缩" }));
  const caller = new CallerState();
  let count = 3;
  const requests: Heard[][] = [];
  const conversation = new Conversation({
    newTask: () => `t${++count}`,
    onAnswer: () => caller.beginAnswer(),
    wait: async () => {},
    ...(options.entries && { entries: options.entries }),
    now: () => 100,
  });
  const endpoint: FakeEndpoint = {
    fake,
    window: WINDOW,
    heard: (messages) =>
      requests.push((messages as Heard[]).filter((message) => message.role !== "system")),
  };
  const target: TaskTarget = {
    endpoint,
    key: async () => undefined,
    maxToolCalls: 50,
    system: "test",
    compact: options.compact ?? true,
    pictures: { sees: true, read: async () => ({ data: "AAAA", mimeType: "image/jpeg" }) },
    tools: (task) =>
      toolSpecsOf(
        createToolset(
          { store: () => store, origin: () => aiTask(task), problems: () => new ProblemSet() },
          caller,
        ),
      ),
  };
  return { conversation, target, requests };
}

/** The words of a message as pi sends it, of all its parts. */
const wordsOf = (message: Heard | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .map((part: { type: string; text?: string }) =>
          part.type === "text" ? part.text : `<${part.type}>`,
        )
        .join("\n")
    : "";
};
const allWords = (messages: readonly Heard[] | undefined) =>
  (messages ?? []).map(wordsOf).join("\n");
const pictures = (messages: readonly Heard[] | undefined) =>
  JSON.stringify(messages ?? []).split('"type":"image"').length - 1;

const SUMMARY = "1. What the user wants: the title lower, the logo smaller.";

describe("the prompt that asks for a summary", () => {
  it("is always the same words", () => {
    expect(COMPACT_PROMPT).toMatchSnapshot();
    expect(summaryMessage({ text: SUMMARY })).toMatchSnapshot();
  });
});

describe("where a summary cuts", () => {
  it("keeps the last two turns as they were", () => {
    const entries = history();
    expect(cutOf(entries)).toEqual({ through: 4 });
    expect(transcriptOf(entries, 4)).toBe(
      [
        "User: 把标题挪到中间偏下",
        'Assistant called aq_render_frames {"times":["12"]}',
        "Result of aq_render_frames (ok): [image 1: frame of timeline main at t=12, 1024×576 — the picture is left out]",
        "rev x:1",
        "the frame at t=12",
        "Assistant: 挪好了，标题在 clip_title。",
      ].join("\n"),
    );
  });

  it("keeps the last two answers of one long turn, with what people asked in it", () => {
    const entries: ChatEntry[] = [user("检查每个镜头", "t1", 1)];
    for (let index = 0; index < 4; index += 1) {
      const call = `call_${index}`;
      entries.push(
        answer("", 2 + index * 2, 1_000 * (index + 1), [
          { id: call, name: "aq_render_frames", args: {} },
        ]),
        looked(call, 3 + index * 2, String(index)),
      );
    }
    // Answers at 1, 3, 5 and 7: the cut is before the one at 5.
    expect(cutOf(entries)).toEqual({ through: 5, asked: "检查每个镜头" });
  });

  it("has nothing to cut in a short conversation, or right after a summary of the same", () => {
    expect(cutOf(history().slice(0, 6))).toBeUndefined();
    const summed: SummaryEntry = {
      role: "summary",
      kind: "summary",
      through: 4,
      text: SUMMARY,
      count: 4,
      before: 8_500,
      after: 3_000,
      window: WINDOW,
      by: "auto",
      at: 9,
    };
    expect(cutOf([...history(), summed])).toBeUndefined();
    // Right after it, no request said how full it is: it is not made again.
    expect(fills([...history(), summed])).toBe(false);
    expect(fills(history())).toBe(true);
    expect(fills(history(7_900))).toBe(false);
  });
});

describe("a conversation that fills up", () => {
  it("sums up all but the last two turns before the next request, and changes nothing before", async () => {
    const entries = history();
    const before = structuredClone(entries);
    const { conversation, target, requests } = setUp([{ text: SUMMARY }, { text: "好的。" }], {
      entries,
    });
    const outcome = await conversation.send("降 2 dB", target);
    expect(outcome).toEqual({ task: "t4", end: "done" });
    const now = conversation.getSnapshot().entries;
    // What was there is there as it was; the summary and the new turn come after it.
    expect(now.slice(0, entries.length)).toEqual(before);
    expect(now.map((entry) => entry.role).slice(entries.length)).toEqual([
      "user",
      "summary",
      "assistant",
    ]);
    const summary = now[entries.length + 1] as SummaryEntry;
    // The new message is one of the last two turns: the two before it are summed up.
    expect(summary).toMatchObject({
      kind: "summary",
      through: 6,
      text: SUMMARY,
      count: 6,
      before: 8_500,
      by: "auto",
    });
    expect(summary.after).toBeLessThan(8_500);
    // The summary was asked with the fixed prompt, of the first two turns only, without pictures.
    const asked = allWords(requests[0]);
    expect(asked.startsWith(COMPACT_PROMPT)).toBe(true);
    expect(asked).toContain("把标题挪到中间偏下");
    expect(asked).toContain("再把 Logo 缩小一点");
    expect(asked).not.toContain("配乐有没有爆音？");
    expect(pictures(requests[0])).toBe(0);
    // The request after it: the summary first, then the last two turns as they were.
    const sent = requests[1] ?? [];
    expect(wordsOf(sent[0])).toContain(SUMMARY);
    expect(allWords(sent)).not.toContain("把标题挪到中间偏下");
    expect(allWords(sent)).not.toContain("Logo 缩小到 80%。");
    expect(wordsOf(sent[0])).toContain("配乐有没有爆音？");
    expect(allWords(sent)).toContain("有两处削波。");
    expect(allWords(sent)).toContain("降 2 dB");
    // The picture AI looked at in the first turn went with the summary.
    expect(pictures(sent)).toBe(0);
  });

  it("does not make room by itself where the settings say not to", async () => {
    const { conversation, target, requests } = setUp([{ text: "好的。" }], {
      entries: history(),
      compact: false,
    });
    await conversation.send("降 2 dB", target);
    expect(conversation.getSnapshot().entries.some((entry) => entry.role === "summary")).toBe(
      false,
    );
    expect(allWords(requests[0])).toContain("把标题挪到中间偏下");
    expect(pictures(requests[0])).toBe(1);
  });

  it("makes room within one long task, keeping its last two answers and what people asked", async () => {
    const look = (t: string, input: number) => ({
      calls: [{ name: "aq_project_status", args: {} }],
      input,
      text: `看 ${t}`,
    });
    const { conversation, target, requests } = setUp([
      look("a", 2_000),
      look("b", 4_000),
      look("c", 6_000),
      look("d", 8_200),
      { text: SUMMARY },
      { text: "都看完了。", input: 3_000 },
    ]);
    const outcome = await conversation.send("检查每个镜头", target);
    expect(outcome).toEqual({ task: "t4", end: "done" });
    const entries = conversation.getSnapshot().entries;
    const at = entries.findIndex((entry) => entry.role === "summary");
    const summary = entries[at] as SummaryEntry;
    expect(summary).toMatchObject({ kind: "summary", asked: "检查每个镜头" });
    // Before the answer at "c": the answers at "c" and "d" go on as they were.
    expect((entries[summary.through] as AssistantEntry).text).toBe("看 c");
    expect(entries.at(-1)).toMatchObject({ role: "assistant", text: "都看完了。" });
    const sent = requests.at(-1) ?? [];
    expect(wordsOf(sent[0])).toContain(SUMMARY);
    expect(wordsOf(sent[0])).toContain("检查每个镜头");
    expect(allWords(sent)).not.toContain("看 a");
    expect(allWords(sent)).toContain("看 c");
    expect(allWords(sent)).toContain("看 d");
  });

  it("leaves out only the old pictures where no summary comes, then says the context is full", async () => {
    const { conversation, target, requests } = setUp(
      [{ error: "overloaded_error" }, { text: "好的。" }],
      { entries: history() },
    );
    await conversation.send("降 2 dB", target);
    const entries = conversation.getSnapshot().entries;
    const summary = entries.find((entry) => entry.role === "summary") as SummaryEntry;
    expect(summary).toMatchObject({ kind: "pictures", through: 6 });
    expect(summary.text).toBeUndefined();
    const sent = requests[1] ?? [];
    // Everything goes as it was, but the old picture goes as its line.
    expect(allWords(sent)).toContain("把标题挪到中间偏下");
    expect(pictures(sent)).toBe(0);
    expect(allWords(sent)).toContain("— not attached: left out to make room in the context]");

    // A request that does not fit: nothing to sum up in two turns, so the old picture goes; when
    // it still does not fit, the context is full, and the answer that failed says so.
    const tooLong = "prompt is too long: 12000 tokens > 10000 maximum";
    const full = setUp([{ error: tooLong }, { error: tooLong }], {
      entries: history(1_000).slice(0, 4),
    });
    const outcome = await full.conversation.send("再看一次", full.target);
    expect(outcome?.end).toBe("failed");
    expect(outcome?.failure?.kind).toBe("contextFull");
    const kept = full.conversation.getSnapshot().entries;
    expect(kept.map((entry) => entry.role).slice(4)).toEqual(["user", "summary", "assistant"]);
    expect(kept.at(-2)).toMatchObject({ kind: "pictures", through: 4 });
    expect(kept.at(-1)).toMatchObject({ end: "failed", error: tooLong });
  });

  it("makes room for a request that did not fit, and goes on", async () => {
    const { conversation, target } = setUp(
      [
        { error: "prompt is too long: 12000 tokens > 10000 maximum" },
        { text: SUMMARY },
        { text: "好的。" },
      ],
      { entries: history(1_000), compact: false },
    );
    const outcome = await conversation.send("降 2 dB", target);
    expect(outcome).toEqual({ task: "t4", end: "done" });
    const roles = conversation.getSnapshot().entries.map((entry) => entry.role);
    // The answer that did not fit is not kept: only the summary and the answer after it.
    expect(roles.slice(-3)).toEqual(["user", "summary", "assistant"]);
  });

  it("sums up when people ask, the same way", async () => {
    const { conversation, target } = setUp([{ text: SUMMARY }], { entries: history(1_000) });
    expect(conversation.compactable).toBe(true);
    expect(await conversation.compact(target)).toBe("summary");
    const last = conversation.getSnapshot().entries.at(-1);
    expect(last).toMatchObject({ role: "summary", by: "people", through: 4 });
    expect(conversation.getSnapshot().entries.slice(0, 8)).toEqual(history(1_000));
    expect(conversation.getSnapshot().running).toBeUndefined();
    expect(conversation.compactable).toBe(false);
  });
});
