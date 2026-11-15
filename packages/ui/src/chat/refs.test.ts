import { describe, expect, it } from "vitest";
import { linkOf, piecesOf, plainOf, shortName, textOf } from "./refs.ts";

describe("blocks and their links", () => {
  it("go to links and back, names with brackets and backslashes too", () => {
    const refs = [
      { label: "0:12/05", href: "aq://time?timeline=main&t=73/6" },
      { label: "片段「标题」", href: "aq://object/clip_7Hq2?timeline=main" },
      { label: "片段「a [b] \\c」", href: "aq://object/clip_x?timeline=main" },
      { label: "scene.html 12–18 行", href: "aq://file/scenes/intro/scene.html#L12-18" },
    ];
    const text = `把 ${linkOf(refs[1]!)} 挪到 ${linkOf(refs[0]!)}，${linkOf(refs[2]!)} 和 ${linkOf(refs[3]!)}。`;
    expect(linkOf(refs[2]!)).toBe("[片段「a \\[b\\] \\\\c」](aq://object/clip_x?timeline=main)");
    const pieces = piecesOf(text);
    expect(
      pieces.filter((piece) => "ref" in piece).map((piece) => "ref" in piece && piece.ref),
    ).toEqual([refs[1], refs[0], refs[2], refs[3]]);
    expect(textOf(pieces)).toBe(text);
    expect(plainOf(text)).toBe(
      "把 片段「标题」 挪到 0:12/05，片段「a [b] \\c」 和 scene.html 12–18 行。",
    );
  });

  it("are only links to the editor: others stay text", () => {
    const text = "看 [这里](https://example.com) 和 [x](aq://object/a)";
    expect(piecesOf(text)).toEqual([
      { text: "看 [这里](https://example.com) 和 " },
      { ref: { label: "x", href: "aq://object/a" } },
    ]);
  });

  it("show a long name cut", () => {
    expect(shortName("一二三四五六七八九十一二三四五六七")).toBe("一二三四五六七八九十一二三四五…");
    expect(shortName("短")).toBe("短");
  });
});
