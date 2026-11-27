import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { changeLine, changeParts } from "./change-line.ts";
import type { TurnChange } from "./summary.ts";

const change = (given: Partial<TurnChange>): TurnChange => ({
  key: "clip\nmain\nclip_1",
  kind: "clip",
  id: "clip_1",
  timeline: "main",
  name: "标题",
  change: "changed",
  fields: [],
  ...given,
});

describe("a change in a row of the card, as its sentence says it", () => {
  it("lays out the object, the field and its value before and after", async () => {
    const { t } = await createI18n();
    const moved = change({ fields: [{ path: "start", before: "0:04.10", after: "0:04.50" }] });
    expect(changeParts(t, moved, undefined)).toEqual({
      object: "片段「标题」",
      what: "开头",
      before: "0:04.10",
      after: "0:04.50",
    });
    expect(changeLine(t, moved, undefined)).toBe("把片段「标题」的开头从 0:04.10 改成 0:04.50");
    // More fields: the first told, how many in all.
    const more = change({
      fields: [
        { path: "start", before: "1", after: "2" },
        { path: "duration", before: "5", after: "6" },
      ],
    });
    expect(changeParts(t, more, undefined).what).toBe("开头等 2 项");
    expect(changeLine(t, more, undefined)).toBe("把片段「标题」的开头从 1 改成 2等 2 项");
  });

  it("says what became of an object, a field set or cleared, a rename and lines of code", async () => {
    const { t } = await createI18n();
    expect(changeParts(t, change({ change: "added" }), undefined)).toEqual({
      object: "片段「标题」",
      what: "新加了",
    });
    // Not made yet, as people are asked about it.
    expect(changeParts(t, change({ change: "removed" }), undefined, true).what).toBe("删掉");
    expect(changeParts(t, change({ fields: [{ path: "note", after: "好" }] }), undefined)).toEqual({
      object: "片段「标题」",
      what: "备注",
      after: "好",
    });
    expect(
      changeParts(
        t,
        change({ fields: [{ path: "note", before: "好", after: "none" }] }),
        undefined,
      ),
    ).toEqual({ object: "片段「标题」", what: "备注", after: "去掉了" });
    // An object goes by the name it had before.
    const renamed = change({
      name: "片名",
      fields: [{ path: "name", before: "标题", after: "片名" }],
    });
    expect(changeParts(t, renamed, undefined)).toEqual({
      object: "片段「标题」",
      what: "名字",
      before: "标题",
      after: "片名",
    });
    const code: TurnChange = {
      key: "file\ncode/a.js",
      kind: "file",
      id: "code/a.js",
      change: "changed",
      fields: [],
      lines: { added: 6, removed: 2 },
    };
    expect(changeParts(t, code, undefined)).toEqual({
      object: "文件「code/a.js」",
      what: "代码",
      after: "+6 −2 行",
    });
    expect(changeLine(t, code, undefined)).toBe("改了文件「code/a.js」（+6 −2 行）");
  });
});
