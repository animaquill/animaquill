import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import styles from "./ChatPanel.module.css";
import { iconPathOf } from "./RefChip.tsx";
import { kindOfRef, linkOf, piecesOf, type ChatRef } from "./refs.ts";

/**
 * The box people write to AI in: text, and blocks for what they point at (`refs.ts`), each one
 * piece that the caret goes around and a backspace takes as a whole. Its value is the text as it is
 * kept, each block as its Markdown link. Pasted text comes in as text; pasted or dropped pictures go
 * to `onFiles`. Copied out, a block is what it says.
 */
export interface ChatInputHandle {
  /** Puts blocks where the caret is (else at the end), with a space after them, and focuses. */
  insert(refs: readonly ChatRef[]): void;
  focus(): void;
  readonly element: HTMLDivElement | null;
}

export interface ChatInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly placeholder: string;
  readonly label: string;
  /** Whether a block points at something that is no more. */
  readonly gone: (href: string) => boolean;
  readonly onPoint: (href: string | undefined) => void;
  readonly onOpen: (href: string) => void;
}

const CHIP = "data-href";

/** A block in the box: not editable, its label as its text, its link in its attributes. */
function chipOf(ref: ChatRef, gone: boolean): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.className = styles.chip ?? "";
  chip.setAttribute(CHIP, ref.href);
  chip.dataset.label = ref.label;
  chip.dataset.kind = kindOfRef(ref.href);
  chip.dataset.testid = "chat-chip";
  if (gone) chip.dataset.gone = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", styles.chipIcon ?? "");
  for (const d of iconPathOf(kindOfRef(ref.href))) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  chip.append(svg, document.createTextNode(ref.label));
  return chip;
}

const isChip = (node: Node | null | undefined): node is HTMLElement =>
  node instanceof HTMLElement && node.hasAttribute(CHIP);

/** The text of the box, or of a part of it, each block as its link (or its label, for copying). */
function serialize(root: Node, plain = false): string {
  let text = "";
  const walk = (node: Node, last: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (isChip(node)) {
      const ref = { label: node.dataset.label ?? "", href: node.getAttribute(CHIP) ?? "" };
      text += plain ? ref.label : linkOf(ref);
      return;
    }
    if (node.nodeName === "BR") {
      // The line break a browser keeps at the end of an editable box is none.
      if (!last) text += "\n";
      return;
    }
    const block = node.nodeName === "DIV" || node.nodeName === "P";
    if (block && text !== "" && !text.endsWith("\n")) text += "\n";
    const children = [...node.childNodes];
    children.forEach((child, index) => walk(child, last && index === children.length - 1));
  };
  const children = [...root.childNodes];
  children.forEach((child, index) => walk(child, index === children.length - 1));
  return text;
}

function render(root: HTMLElement, value: string, gone: (href: string) => boolean): void {
  root.replaceChildren(
    ...piecesOf(value).map((piece) =>
      "ref" in piece
        ? chipOf(piece.ref, gone(piece.ref.href))
        : document.createTextNode(piece.text),
    ),
  );
}

function caretToEnd(root: HTMLElement): void {
  const selection = document.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The block right before (or after) a collapsed caret, which a backspace (delete) takes whole. */
function chipBeside(root: HTMLElement, before: boolean): HTMLElement | undefined {
  const selection = document.getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return undefined;
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
  if (!root.contains(node)) return undefined;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = node.textContent?.length ?? 0;
    if (before && offset === 0) {
      const sibling = node.previousSibling;
      return isChip(sibling) ? sibling : undefined;
    }
    if (!before && offset === length) {
      const sibling = node.nextSibling;
      return isChip(sibling) ? sibling : undefined;
    }
    return undefined;
  }
  const sibling = node.childNodes[before ? offset - 1 : offset];
  return isChip(sibling) ? sibling : undefined;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(props, ref) {
    const box = useRef<HTMLDivElement>(null);
    /** What the box said last, so that its own changes do not draw it again under the caret. */
    const said = useRef<string | undefined>(undefined);
    const { value, onChange, gone } = props;

    useLayoutEffect(() => {
      const root = box.current;
      if (!root || said.current === value) return;
      const focused = document.activeElement === root;
      render(root, value, gone);
      said.current = value;
      if (focused) caretToEnd(root);
    });
    // Blocks of what was deleted meanwhile go grey.
    useLayoutEffect(() => {
      const root = box.current;
      if (!root) return;
      for (const chip of root.querySelectorAll<HTMLElement>(`[${CHIP}]`)) {
        const off = gone(chip.getAttribute(CHIP) ?? "");
        if (off !== chip.hasAttribute("data-gone")) chip.toggleAttribute("data-gone", off);
      }
    });

    const changed = () => {
      const root = box.current;
      if (!root) return;
      const next = serialize(root);
      said.current = next;
      onChange(next);
    };

    useImperativeHandle(ref, () => ({
      get element() {
        return box.current;
      },
      focus: () => box.current?.focus(),
      insert: (refs) => {
        const root = box.current;
        if (!root || refs.length === 0) return;
        root.focus();
        const selection = document.getSelection();
        let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
        if (!range || !root.contains(range.commonAncestorContainer)) {
          caretToEnd(root);
          range = document.getSelection()?.getRangeAt(0);
        }
        if (!range) return;
        range.deleteContents();
        const parts: Node[] = [];
        refs.forEach((each, index) => {
          if (index > 0) parts.push(document.createTextNode(" "));
          parts.push(chipOf(each, false));
        });
        // A space before a block that would touch a word, and one after to type on.
        const before = range.startContainer;
        const char =
          before.nodeType === Node.TEXT_NODE
            ? (before.textContent ?? "").charAt(range.startOffset - 1)
            : "";
        if (char !== "" && !/\s/.test(char)) parts.unshift(document.createTextNode(" "));
        const after = document.createTextNode(" ");
        parts.push(after);
        const fragment = document.createDocumentFragment();
        fragment.append(...parts);
        range.insertNode(fragment);
        const caret = document.createRange();
        caret.setStart(after, 1);
        caret.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(caret);
        changed();
      },
    }));

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      const root = box.current;
      if (
        root &&
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.nativeEvent.isComposing
      ) {
        const chip = chipBeside(root, event.key === "Backspace");
        if (chip) {
          event.preventDefault();
          chip.remove();
          changed();
          return;
        }
      }
      props.onKeyDown(event);
    };

    const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
      const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
      event.preventDefault();
      if (files.length > 0) {
        props.onFiles(files);
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      // As text, which the box keeps on its undo.
      if (text) document.execCommand("insertText", false, text);
    };

    const onCopy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const holder = document.createElement("div");
      holder.append(selection.getRangeAt(0).cloneContents());
      event.preventDefault();
      event.clipboardData.setData("text/plain", serialize(holder, true));
      if (cut) {
        selection.getRangeAt(0).deleteContents();
        changed();
      }
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
      const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      props.onFiles(files);
    };

    const pointed = (target: EventTarget) =>
      target instanceof Element ? target.closest<HTMLElement>(`[${CHIP}]`) : null;

    return (
      <div
        ref={box}
        className={styles.input}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={props.label}
        data-placeholder={props.placeholder}
        data-empty={value === "" ? "" : undefined}
        data-testid="chat-input"
        tabIndex={0}
        spellCheck={false}
        onInput={changed}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCopy={(event) => onCopy(event, false)}
        onCut={(event) => onCopy(event, true)}
        onDragOver={(event) => {
          if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
            event.preventDefault();
          }
        }}
        onDrop={onDrop}
        onPointerOver={(event) =>
          props.onPoint(pointed(event.target)?.getAttribute(CHIP) ?? undefined)
        }
        onPointerLeave={() => props.onPoint(undefined)}
        onClick={(event) => {
          const chip = pointed(event.target);
          if (chip && !chip.hasAttribute("data-gone")) props.onOpen(chip.getAttribute(CHIP) ?? "");
        }}
      />
    );
  },
);
