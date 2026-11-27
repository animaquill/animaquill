import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import styles from "./ChatPanel.module.css";
import { triggerAt, type Trigger } from "./input/slash.ts";
import { iconPathOf } from "./RefChip.tsx";
import { kindOfRef, linkOf, piecesOf, type ChatRef, type Piece } from "./refs.ts";

/**
 * The box people write to AI in: text, and blocks for what they point at (`refs.ts`), each one
 * piece that the caret goes around and a backspace takes as a whole. Its value is the text as it is
 * kept, each block as its Markdown link. What goes in goes through the editing commands of the
 * browser, so that Ctrl+Z takes back a block as it does words. Pasted text comes in as text, and
 * blocks copied from the box as blocks again (`CHAT_TYPE`); pasted pictures go to `onFiles`, and
 * dropped ones to the chat around it. Copied out, a block is what it says.
 */
export interface ChatInputHandle {
  /** Puts blocks where the caret is (else at the end), with a space after them, and focuses. */
  insert(refs: readonly ChatRef[]): void;
  focus(): void;
  /** Puts text where the caret is, as typed: "@" from "+", which opens its menu. */
  type(text: string): void;
  /**
   * What `/` or `@` started where the caret is, replaced by blocks (with a space after them), or
   * taken away where nothing comes instead: one step to take back, as typing is.
   */
  complete(refs: readonly ChatRef[]): void;
  readonly element: HTMLDivElement | null;
}

/** What `/` or `@` started where the caret is, and where on the screen, for its menu. */
export interface BoxTrigger extends Trigger {
  /** Where its `/` or `@` is in the box: the same while people type on after it. */
  readonly start: number;
  /** Where its `/` or `@` is on the screen. */
  readonly rect: DOMRect;
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
  readonly onFocus?: () => void;
  /** The caret went into or out of what `/` or `@` started, or it changed. */
  readonly onTrigger?: (trigger: BoxTrigger | undefined) => void;
  /** Ids for the menu of `/` and `@`, which is the box's: its list, and the option chosen in it. */
  readonly completes?: { readonly list: string; readonly active: string } | undefined;
  /** Where there is more than one box: the one people write new messages in is "chat-input". */
  readonly testId?: string;
}

const CHIP = "data-href";

/** The type of what the box copies besides plain text: its value, blocks as their links. */
export const CHAT_TYPE = "text/x-animaquill-chat";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

/** Pieces as the HTML the box takes in: text, line breaks and blocks. */
function htmlOf(pieces: readonly Piece[]): string {
  return pieces
    .map((piece) =>
      "ref" in piece
        ? chipOf(piece.ref, false).outerHTML
        : escapeHtml(piece.text).replace(/\n/g, "<br>"),
    )
    .join("");
}

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

/** The run of text the caret is in, how far into it, and all of the box up to it. */
function caretIn(
  root: HTMLElement,
): { readonly node: Text; readonly offset: number; readonly whole: string } | undefined {
  const selection = document.getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return undefined;
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
  if (!(node instanceof Text) || !root.contains(node)) return undefined;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return { node, offset, whole: serialize(holder) };
}

/** What `/` or `@` started where the caret is, see `triggerAt`. */
function triggerIn(
  root: HTMLElement,
): (BoxTrigger & { readonly node: Text; readonly offset: number }) | undefined {
  const caret = caretIn(root);
  if (!caret) return undefined;
  const { node, offset, whole } = caret;
  const found = triggerAt(whole, (node.textContent ?? "").slice(0, offset));
  if (!found) return undefined;
  const range = document.createRange();
  range.setStart(node, offset - found.length);
  range.setEnd(node, offset - found.length + 1);
  const rect = range.getBoundingClientRect();
  return { ...found, node, offset, start: whole.length - found.length, rect };
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(props, ref) {
    const box = useRef<HTMLDivElement>(null);
    /** What the box said last, so that its own changes do not draw it again under the caret. */
    const said = useRef<string | undefined>(undefined);
    // An input method composes now: what it has is not words yet. Blocks that come meanwhile
    // wait for it, so that they land after the words and not among the letters it shows.
    const composing = useRef(false);
    const waiting = useRef<Piece[][]>([]);
    const { value, onChange, gone, onTrigger } = props;
    const told = useRef<string | undefined>(undefined);
    // Words pasted in are not typed: no menu for them, until something is typed, a key or the
    // pointer moves on.
    const pasted = useRef(false);
    const pasting = useRef(false);
    /** Says what `/` or `@` started where the caret is now, once it changed. */
    const lookRef = useRef(() => {});
    lookRef.current = () => {
      const root = box.current;
      // What an input method composes is not written yet: the menu waits for it as it is.
      if (!onTrigger || !root || composing.current) return;
      const found =
        document.activeElement === root && !pasted.current ? triggerIn(root) : undefined;
      const key = found && `${found.kind}/${found.start}/${found.query}`;
      if (key === told.current) return;
      told.current = key;
      onTrigger(
        found && {
          kind: found.kind,
          query: found.query,
          length: found.length,
          start: found.start,
          rect: found.rect,
        },
      );
    };
    // The caret moves by typing, keys, the mouse: the menu follows it, and goes as the box loses it.
    useEffect(() => {
      const look = () => lookRef.current();
      document.addEventListener("selectionchange", look);
      return () => document.removeEventListener("selectionchange", look);
    }, []);

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

    /** Puts pieces where the caret is in the box, else at its end, as one step to take back. */
    const put = (pieces: readonly Piece[]) => {
      const root = box.current;
      if (!root || pieces.length === 0) return;
      if (composing.current) {
        waiting.current.push([...pieces]);
        return;
      }
      root.focus();
      const selection = document.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      if (!range || !root.contains(range.commonAncestorContainer)) caretToEnd(root);
      document.execCommand("insertHTML", false, htmlOf(pieces));
      changed();
    };

    /** Blocks where the caret is, or over what is selected in the box, see `insert`. */
    const insertRefs = (refs: readonly ChatRef[]) => {
      const root = box.current;
      if (!root || refs.length === 0) return;
      root.focus();
      const selection = document.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      // A space before a block that would touch a word, and one after to type on.
      const before =
        range &&
        root.contains(range.startContainer) &&
        range.startContainer.nodeType === Node.TEXT_NODE
          ? (range.startContainer.textContent ?? "").charAt(range.startOffset - 1)
          : "";
      const pieces: Piece[] = [];
      if (before !== "" && !/\s/.test(before)) pieces.push({ text: " " });
      refs.forEach((each, index) => {
        if (index > 0) pieces.push({ text: " " });
        pieces.push({ ref: each });
      });
      pieces.push({ text: " " });
      put(pieces);
    };

    useImperativeHandle(ref, () => ({
      get element() {
        return box.current;
      },
      focus: () => box.current?.focus(),
      insert: insertRefs,
      type: (text) => {
        const root = box.current;
        if (!root) return;
        root.focus();
        const caret = caretIn(root);
        // After a word, a space first: "@" starts a block only after one.
        const before = caret ? caret.whole.slice(-1) : serialize(root).slice(-1);
        put([{ text: before !== "" && !/\s/.test(before) ? ` ${text}` : text }]);
      },
      complete: (refs) => {
        const root = box.current;
        const found = root && triggerIn(root);
        if (!found) return;
        // What `/` or `@` started, selected: what comes instead of it replaces it, as typing does.
        const range = document.createRange();
        range.setStart(found.node, found.offset - found.length);
        range.setEnd(found.node, found.offset);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (refs.length > 0) {
          insertRefs(refs);
          return;
        }
        document.execCommand("delete");
        changed();
      },
    }));

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      pasted.current = false;
      const root = box.current;
      const typing = event.nativeEvent.isComposing || event.keyCode === 229 || composing.current;
      if (root && (event.key === "Backspace" || event.key === "Delete") && !typing) {
        const chip = chipBeside(root, event.key === "Backspace");
        if (chip) {
          // Selected and deleted as the browser does it, so that Ctrl+Z brings it back.
          event.preventDefault();
          const range = document.createRange();
          range.selectNode(chip);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand("delete");
          changed();
          return;
        }
      }
      // No bold or italic: the box holds words, not formatting.
      if ((event.ctrlKey || event.metaKey) && /^[biu]$/i.test(event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" && event.shiftKey && !typing) {
        event.preventDefault();
        document.execCommand("insertLineBreak");
        changed();
        return;
      }
      // Keys while an input method composes are its own: Enter picks a word, it sends nothing.
      if (typing) return;
      props.onKeyDown(event);
    };

    const pasteIn = (event: ClipboardEvent<HTMLDivElement>) => {
      const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
      event.preventDefault();
      if (files.length > 0) {
        props.onFiles(files);
        return;
      }
      // Blocks copied from the box come back as blocks; anything else as its text.
      const own = event.clipboardData.getData(CHAT_TYPE);
      if (own) {
        put(piecesOf(own));
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      if (text) put([{ text }]);
    };

    const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
      pasted.current = true;
      pasting.current = true;
      lookRef.current();
      try {
        pasteIn(event);
      } finally {
        pasting.current = false;
      }
    };

    const onCopy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const holder = document.createElement("div");
      holder.append(selection.getRangeAt(0).cloneContents());
      event.preventDefault();
      event.clipboardData.setData("text/plain", serialize(holder, true));
      event.clipboardData.setData(CHAT_TYPE, serialize(holder));
      if (cut) {
        document.execCommand("delete");
        changed();
      }
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
      // Pictures go to the chat around the box; text dropped in comes in as text, where it lands.
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) return;
      const text = event.dataTransfer.getData("text/plain");
      event.preventDefault();
      if (!text) return;
      const at = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (at) {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(at);
      }
      put([{ text }]);
    };

    const pointed = (target: EventTarget) =>
      target instanceof Element ? target.closest<HTMLElement>(`[${CHIP}]`) : null;

    return (
      <div
        ref={box}
        className={styles.input}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={props.label}
        aria-autocomplete={props.completes ? "list" : undefined}
        aria-controls={props.completes?.list}
        aria-activedescendant={props.completes?.active}
        data-placeholder={props.placeholder}
        data-empty={value === "" ? "" : undefined}
        data-testid={props.testId ?? "chat-input"}
        data-panel-focus=""
        tabIndex={0}
        spellCheck={false}
        onInput={() => {
          // Typed, not pasted: what `/` or `@` starts has its menu again.
          if (!pasting.current) pasted.current = false;
          changed();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          changed();
          const pieces = waiting.current.flat();
          waiting.current = [];
          if (pieces.length > 0) put(pieces);
          lookRef.current();
        }}
        onBlur={() => lookRef.current()}
        onKeyDown={onKeyDown}
        onFocus={props.onFocus}
        onPaste={onPaste}
        onCopy={(event) => onCopy(event, false)}
        onCut={(event) => onCopy(event, true)}
        onDrop={onDrop}
        onPointerOver={(event) =>
          props.onPoint(pointed(event.target)?.getAttribute(CHIP) ?? undefined)
        }
        onPointerLeave={() => props.onPoint(undefined)}
        onPointerDown={() => {
          pasted.current = false;
        }}
        onClick={(event) => {
          const chip = pointed(event.target);
          if (chip && !chip.hasAttribute("data-gone")) props.onOpen(chip.getAttribute(CHIP) ?? "");
        }}
      />
    );
  },
);
