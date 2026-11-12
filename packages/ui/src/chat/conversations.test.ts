import type { ChatEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import {
  askingIn,
  byDay,
  changesIn,
  cleanTitle,
  firstWords,
  searchChats,
} from "./conversations.ts";

const at = (text: string) => new Date(text).getTime();
const user = (text: string, task = "t1"): ChatEntry => ({ role: "user", text, at: 0, task });
const answer = (text: string): ChatEntry => ({
  role: "assistant",
  text,
  calls: [],
  at: 0,
  end: "done",
  service: "anthropic",
  protocol: "anthropic-messages",
  model: "m",
});

describe("the list of conversations", () => {
  it("groups them by day: today, yesterday, earlier, newest first", () => {
    const now = at("2026-11-12T10:00:00");
    const chats = [
      { id: "old", updatedAt: at("2026-11-08T12:00:00") },
      { id: "morning", updatedAt: at("2026-11-12T08:00:00") },
      { id: "late", updatedAt: at("2026-11-11T23:59:00") },
      { id: "midnight", updatedAt: at("2026-11-12T00:00:00") },
      { id: "dawn", updatedAt: at("2026-11-11T00:00:00") },
    ];
    expect(byDay(chats, now).map((group) => [group.day, group.chats.map(({ id }) => id)])).toEqual([
      ["today", ["morning", "midnight"]],
      ["yesterday", ["late", "dawn"]],
      ["earlier", ["old"]],
    ]);
    expect(byDay([], now)).toEqual([]);
  });

  it("says how much AI changed, and whether it waits for an answer", () => {
    const edit = (id: string): ChatEntry => ({
      role: "tool",
      call: id,
      name: "aq_edit",
      ok: true,
      text: "",
      at: 0,
      data: { changes: [{ kind: "marker", id, change: "added", timeline: "main" }] },
    });
    const propose: ChatEntry = {
      role: "tool",
      call: "q",
      name: "aq_propose",
      ok: true,
      text: "",
      at: 0,
    };
    const entries = [user("一", "t1"), edit("m1"), edit("m2"), user("二", "t2"), edit("m1")];
    expect(changesIn(entries)).toBe(3);
    expect(askingIn(entries)).toBe(false);
    expect(askingIn([...entries, propose])).toBe(true);
    expect(askingIn([...entries, propose, user("选第一个", "t3")])).toBe(false);
  });

  it("finds words in titles, what people said and what AI answered, any case, as written", () => {
    const chats = [
      {
        summary: { id: "a", title: "字幕", updatedAt: 1 },
        entries: [user("把 Subtitle 往上挪一点", "t1"), answer("字幕挪好了（+12px）")],
      },
      {
        summary: { id: "b", title: "开场 (a+b)", updatedAt: 2 },
        entries: [user("开场放慢一点", "t2")],
      },
    ];
    expect(searchChats(chats, "subtitle")).toEqual([
      {
        id: "a",
        title: "字幕",
        updatedAt: 1,
        task: "t1",
        before: "把 ",
        match: "Subtitle",
        after: " 往上挪一点",
      },
    ]);
    // Only the title has it.
    expect(searchChats(chats, "(a+b)")).toMatchObject([{ id: "b", match: "(a+b)" }]);
    expect(searchChats(chats, "+12px")).toMatchObject([{ id: "a", match: "+12px" }]);
    expect(searchChats(chats, "  ")).toEqual([]);
    expect(searchChats(chats, "没有的")).toEqual([]);
  });

  it("has a title: the first words, then the one the model wrote, made fit", () => {
    expect(firstWords([user("> 引用的话\n把开场放慢一点\n还有别的")], 40)).toBe("把开场放慢一点");
    expect(firstWords([user("很长".repeat(30))], 10)).toBe("很长很长很长很长很长");
    expect(firstWords([], 40)).toBe("");
    expect(cleanTitle("标题：「调整开场节奏」。", 40)).toBe("调整开场节奏");
    expect(cleanTitle('Title: "Slower opening"\nmore', 40)).toBe("Slower opening");
    expect(cleanTitle("**加字幕**", 40)).toBe("加字幕");
    expect(cleanTitle("  \n", 40)).toBeUndefined();
  });
});
