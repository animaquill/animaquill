import type { ChatEntry } from "@animaquill/agent";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdown/blocks.ts";
import MarkdownBody from "./markdown/MarkdownBody.tsx";
import { othersOfTurn, problemsOfTurn, summaryOf } from "./summary.ts";
import { groupsOf, turnOf } from "./turns.ts";
import { contextOf, usageOf } from "./usage.ts";

/**
 * A long conversation stays quick to open and to stream into: 200 turns of tools and answers with
 * lists and tables, as GPT models write them. The limits leave room for a busy machine; they are
 * there to catch a step back of ten times, such as parsing the whole of an answer with each piece.
 */
const TURNS = 200;

const ANSWER = [
  "开场三个片段都拉长了 20%，字幕跟着往后对齐：",
  "",
  "- 「开场」2:00 → 2:12",
  "- 字幕「欢迎」挪到 `0:02/12`",
  "",
  "| 片段 | 之前 | 之后 |",
  "| --- | --- | --- |",
  "| 开场 | 2:00 | 2:12 |",
  "| 城市 | 2:00 | 2:12 |",
  "",
  "第一次写入时字幕和「标题」重叠了，我改了顺序再写的。",
].join("\n");

function conversation(): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const at = turn * 60_000;
    entries.push({ role: "user", text: `第 ${turn} 轮`, at, task: `t${turn}` });
    for (let step = 0; step < 6; step += 1) {
      const id = `t${turn}-c${step}`;
      entries.push({
        role: "assistant",
        text: "",
        thinking: "先看看时间轴。",
        calls: [
          { id, name: "aq_edit", args: { summary: "拉长", operations: [{ op: "clip.update" }] } },
        ],
        at: at + step * 1000,
        end: "tools",
        service: "anthropic",
        protocol: "anthropic-messages",
        model: "claude-opus-5",
        usage: {
          input: 12_000,
          output: 400,
          cacheRead: 30_000,
          cacheWrite: 0,
          cost: 0.01,
          window: 200_000,
        },
      });
      entries.push({
        role: "tool",
        call: id,
        name: "aq_edit",
        ok: true,
        text: "done: 1 operation as one step",
        at: at + step * 1000 + 300,
        data: {
          summary: "拉长",
          changes: [
            {
              kind: "clip",
              id: `clip_${step}`,
              timeline: "main",
              change: "changed",
              fields: [{ path: "duration", before: "2", after: "2.4" }],
            },
          ],
          others: [{ who: "user", kind: "clip", id: "clip_title", fields: ["start"] }],
        },
      });
    }
    entries.push({
      role: "assistant",
      text: ANSWER,
      calls: [],
      at: at + 7000,
      end: "done",
      service: "anthropic",
      protocol: "anthropic-messages",
      model: "claude-opus-5",
    });
  }
  return entries;
}

describe("a conversation of 200 turns", () => {
  it("opens quickly: its turns, their cards and what it took", () => {
    const entries = conversation();
    const started = performance.now();
    const turns = groupsOf(entries).map((group) => turnOf(group.user, group.entries));
    for (const turn of turns) {
      summaryOf(turn.entries);
      othersOfTurn(turn.entries);
      problemsOfTurn(turn.entries);
      usageOf(turn.entries);
    }
    usageOf(entries);
    contextOf(entries);
    const data = performance.now() - started;
    const rendering = performance.now();
    for (const turn of turns)
      renderToStaticMarkup(createElement(MarkdownBody, { text: turn.answer ?? "" }));
    const markdown = performance.now() - rendering;
    console.info(
      `200 turns: ${data.toFixed(0)} ms for the data, ${markdown.toFixed(0)} ms for the answers`,
    );
    expect(turns).toHaveLength(TURNS);
    expect(data).toBeLessThan(500);
    expect(markdown).toBeLessThan(3000);
  });

  it("streams an answer by parsing only its last block again", () => {
    const long = Array.from({ length: 20 }, () => ANSWER).join("\n\n");
    // What a block was parsed to stays, as `memo` keeps it in the page.
    const parsed = new Map<string, string>();
    const parse = (block: string) => {
      const known = parsed.get(block);
      if (known !== undefined) return known;
      const html = renderToStaticMarkup(createElement(MarkdownBody, { text: block }));
      parsed.set(block, html);
      return html;
    };
    const started = performance.now();
    for (let end = 20; end <= long.length; end += 20) {
      const blocks = splitMarkdownBlocks(long.slice(0, end));
      for (const block of blocks) parse(block);
    }
    const ms = performance.now() - started;
    console.info(`streaming ${long.length} characters in pieces of 20: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
  });
});
