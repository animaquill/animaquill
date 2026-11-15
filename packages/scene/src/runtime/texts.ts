import { TEXT_LIMITS, type SceneText } from "../protocol.ts";

/**
 * The text a scene shows on the frame it is on, for AI to read what is on the picture: each element
 * with words of its own, with the box of those words in CSS pixels of the page, which is the clip
 * box (`viewOf`). What is hidden, transparent or out of the page is left out. Only the first few, so
 * that a page full of text costs little; how many more there were is said.
 */

const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

/** The words of an element of its own, not those of the elements in it, on one line. */
function ownWords(element: Element): string {
  let words = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) words += node.textContent ?? "";
  }
  return words.replaceAll(/\s+/g, " ").trim();
}

/** Whether nothing of an element shows, as far as its style says. */
function isHidden(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0;
}

/** The box of the words of an element of its own, as laid out now. */
function boxOfWords(element: Element): DOMRect | undefined {
  const range = document.createRange();
  let box: { left: number; top: number; right: number; bottom: number } | undefined;
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    box = box
      ? {
          left: Math.min(box.left, rect.left),
          top: Math.min(box.top, rect.top),
          right: Math.max(box.right, rect.right),
          bottom: Math.max(box.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return box && new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
}

export function measureTexts(root: Element | null = document.body): {
  readonly texts: SceneText[];
  readonly more: boolean;
} {
  const texts: SceneText[] = [];
  let more = false;
  if (!root) return { texts, more };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      SKIPPED.has((node as Element).tagName) || isHidden(node as Element)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const visit = (element: Element) => {
    const words = ownWords(element);
    if (!words) return;
    const box = boxOfWords(element);
    if (!box) return;
    if (texts.length >= TEXT_LIMITS.count) {
      more = true;
      return;
    }
    texts.push({
      text: words.slice(0, TEXT_LIMITS.characters),
      x: Math.round(box.x * 10) / 10,
      y: Math.round(box.y * 10) / 10,
      width: Math.round(box.width * 10) / 10,
      height: Math.round(box.height * 10) / 10,
    });
  };
  visit(root);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    visit(node as Element);
    if (more) break;
  }
  return { texts, more };
}
