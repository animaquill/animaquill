import { describe, expect, it } from "vitest";
import { commandOf, commandsFor, triggerAt } from "./slash.ts";

const ids = (query: string) => commandsFor(query).map((command) => command.id);

describe("commands of the input box", () => {
  it("are all there after the slash alone, and found by name, English, pinyin and its letters", () => {
    expect(ids("")).toEqual(["plan", "new", "compact", "frame", "rename"]);
    expect(ids("方")).toEqual(["plan"]);
    expect(ids("fa")).toEqual(["plan"]);
    expect(ids("fang")).toEqual(["plan"]);
    expect(ids("PLAN")).toEqual(["plan"]);
    expect(ids("xdh")).toEqual(["new"]);
    expect(ids("n")).toEqual(["new"]);
    expect(ids("ys")).toEqual(["compact"]);
    expect(ids("hm")).toEqual(["frame"]);
    expect(ids("重")).toEqual(["rename"]);
    expect(ids("cmm")).toEqual(["rename"]);
    expect(ids("你好")).toEqual([]);
  });

  it("go by a command written out in full, with what comes after it", () => {
    expect(commandOf("/新对话 做个片头")).toEqual({
      command: expect.objectContaining({ id: "new" }),
      rest: "做个片头",
    });
    expect(commandOf("、方案")?.command.id).toBe("plan");
    expect(commandOf("／compact")?.command.id).toBe("compact");
    expect(commandOf("/new\n第一行\n第二行")?.rest).toBe("第一行\n第二行");
    // Only the name or its English: a few letters are for finding it in the menu.
    expect(commandOf("/fa")).toBeUndefined();
    expect(commandOf("/方案吧")).toBeUndefined();
    expect(commandOf("把 /方案 打开")).toBeUndefined();
    expect(commandOf("、")).toBeUndefined();
  });
});

describe("what the caret is in", () => {
  it("is a command only at the start of the box, after /, ／ or 、 as Chinese input types it", () => {
    expect(triggerAt("/", "/")).toEqual({ kind: "slash", query: "", length: 1 });
    expect(triggerAt("、fa", "、fa")).toEqual({ kind: "slash", query: "fa", length: 3 });
    expect(triggerAt("／新", "／新")).toEqual({ kind: "slash", query: "新", length: 2 });
    expect(triggerAt("看 /", "看 /")).toBeUndefined();
    expect(triggerAt("/新对话 ", "/新对话 ")).toBeUndefined();
    expect(triggerAt("一、", "一、")).toBeUndefined();
  });

  it("is a block of the project after @ at the start, a space or a line break", () => {
    expect(triggerAt("@", "@")).toEqual({ kind: "at", query: "", length: 1 });
    expect(triggerAt("把 @片头", "把 @片头")).toEqual({ kind: "at", query: "片头", length: 3 });
    expect(triggerAt("第一行\n＠城", "第一行\n＠城")).toEqual({
      kind: "at",
      query: "城",
      length: 2,
    });
    expect(triggerAt("mail@example", "mail@example")).toBeUndefined();
    expect(triggerAt("@片头 挪一下", "@片头 挪一下")).toBeUndefined();
    // After a block, in a run of text of its own: what is before it counts.
    const link = "[片段「城市」](aq://object/clip_0?timeline=main)";
    expect(triggerAt(`${link} @`, " @")).toEqual({ kind: "at", query: "", length: 1 });
    expect(triggerAt(`${link}@`, "@")).toBeUndefined();
    expect(triggerAt(`@${"字".repeat(40)}`, `@${"字".repeat(40)}`)).toBeUndefined();
  });
});
