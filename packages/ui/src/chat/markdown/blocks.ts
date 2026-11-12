// Adapted from pi-web (https://github.com/agegr/pi-web), lib/markdown-blocks.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_TAG = /<[A-Za-z!/?]/;
const INLINE_CODE = /`[^`]*`/g;

/**
 * Splits Markdown before top-level blocks that cannot belong to the block above, so that an answer
 * on its way renders block by block: finished blocks keep what they were parsed to, and only the
 * last one is parsed again as words come (parsing all of it with each piece made a long answer
 * quadratic). The pieces join back to the input.
 *
 * A split goes only after a blank line, before a line that starts at column 0 and is not a list
 * item: never inside a code fence or a `$$` block, never inside a loose list or an indented
 * continuation. Raw HTML may wrap blank lines, so nothing after the first line with a tag outside
 * inline code is split, nor is a document that opens with front matter. A rare miss only makes a
 * block larger or, at worst, renders one apart for a moment while it streams: the finished answer
 * is rendered whole.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (/^---[ \t]*\r?$/.test(lines[0] ?? "")) return [markdown];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inMath = false;
  let rawHtml = false;
  let afterBlank = false;

  for (const line of lines) {
    const blank = line.trim() === "";
    if (
      afterBlank &&
      !blank &&
      !fence &&
      !inMath &&
      !rawHtml &&
      current.length > 0 &&
      !/^[ \t]/.test(line) &&
      !LIST_ITEM.test(line)
    ) {
      blocks.push(current.join("\n") + "\n");
      current = [];
    }
    current.push(line);

    const fenceMatch = FENCE.exec(line);
    const opening = fenceMatch?.[1];
    if (opening) {
      const marker = opening[0] ?? "`";
      const size = opening.length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
    } else if (!fence) {
      const prose = line.replace(INLINE_CODE, "");
      if (HTML_TAG.test(prose)) rawHtml = true;
      if ((prose.match(/\$\$/g)?.length ?? 0) % 2 === 1) inMath = !inMath;
    }
    afterBlank = blank;
  }
  blocks.push(current.join("\n"));
  return blocks;
}
