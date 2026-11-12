import type { WindowMemory } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { Drafts, draftKey, mergeRestored, quoteOf, quoteSeparator } from "./drafts.ts";

function memory(): WindowMemory & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: (key) => values.get(key),
    write: (key, value) => void values.set(key, value),
  };
}

describe("drafts", () => {
  it("are kept for each conversation of each project, in the memory of the window", () => {
    const window = memory();
    const drafts = new Drafts(window);
    drafts.write("p1", "a", "一半");
    drafts.write("p1", "b", "另一半");
    drafts.write("p2", "a", "别的项目");
    expect(window.values.get(draftKey("p1", "a"))).toBe("一半");
    // A reload: read from the memory again.
    const again = new Drafts(window);
    expect(again.read("p1", "a")).toBe("一半");
    expect(again.read("p1", "b")).toBe("另一半");
    expect(again.read("p2", "a")).toBe("别的项目");
    expect(again.read("p2", "b")).toBe("");
  });

  it("are cleared, and tell who listens only when they change", () => {
    const drafts = new Drafts(memory());
    let told = 0;
    drafts.subscribe(() => (told += 1));
    drafts.write("p", "a", "字");
    drafts.write("p", "a", "字");
    drafts.clear("p", "a");
    expect(drafts.read("p", "a")).toBe("");
    expect(told).toBe(2);
  });

  it("take back words that did not go out, ahead of what was typed since", () => {
    expect(mergeRestored("发出去的", "")).toBe("发出去的");
    expect(mergeRestored("", "新打的")).toBe("新打的");
    expect(mergeRestored("发出去的", "新打的")).toBe("发出去的\n\n新打的");
    // Already there: once is enough.
    expect(mergeRestored("发出去的", "发出去的")).toBe("发出去的");
    const drafts = new Drafts(undefined);
    drafts.write("p", "a", "新打的");
    drafts.restore("p", "a", "发出去的");
    expect(drafts.read("p", "a")).toBe("发出去的\n\n新打的");
  });

  it("take a quote as a paragraph of its own", () => {
    expect(quoteOf("  第一行\n第二行 ")).toBe("> 第一行\n> 第二行\n\n");
    expect(quoteSeparator("")).toBe("");
    expect(quoteSeparator("前面\n\n")).toBe("");
    expect(quoteSeparator("前面\n")).toBe("\n");
    expect(quoteSeparator("前面")).toBe("\n\n");
    const drafts = new Drafts(undefined);
    drafts.write("p", "a", "看这里");
    drafts.quote("p", "a", "回答里的一句");
    expect(drafts.read("p", "a")).toBe("看这里\n\n> 回答里的一句\n\n");
  });
});
