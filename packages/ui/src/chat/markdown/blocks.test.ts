import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./blocks.ts";

describe("Markdown in blocks", () => {
  it("splits between paragraphs, headings and tables, and joins back to what it was", () => {
    const text = "# 标题\n\n第一段。\n\n- 一\n- 二\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n最后。";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.join("")).toBe(text);
    expect(blocks).toEqual([
      "# 标题\n\n",
      // A list item may belong to the list above: never a split before one.
      "第一段。\n\n- 一\n- 二\n\n",
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n",
      "最后。",
    ]);
  });

  it("never splits inside a code fence, a loose list or an indented line", () => {
    const fence = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后面。";
    expect(splitMarkdownBlocks(fence)).toEqual([
      "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "后面。",
    ]);
    const loose = "1. 一\n\n2. 二\n\n   接着二。";
    expect(splitMarkdownBlocks(loose)).toEqual([loose]);
  });

  it("keeps a fence that is still open as one block while it streams", () => {
    const open = "说明：\n\n```\n第一行\n\n第二行";
    const blocks = splitMarkdownBlocks(open);
    expect(blocks).toEqual(["说明：\n\n", "```\n第一行\n\n第二行"]);
  });

  it("does not split after raw HTML, which may wrap blank lines", () => {
    const html = "<details>\n\n里面\n\n</details>";
    expect(splitMarkdownBlocks(html)).toEqual([html]);
  });
});
