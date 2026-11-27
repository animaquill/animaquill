import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

/**
 * A menu that opens from a button of the input box, as the menus of desktops: a click of the mouse
 * keeps the caret in the box, Enter, Space or ↓ on the button goes into it on its first item, ↑ and
 * ↓ go round what can be chosen, Home and End to the ends, Esc closes back to the button (or, with
 * the caret still in the box, just closes it, and does not stop the task), a click elsewhere closes it.
 */
export interface BoxMenu {
  readonly open: boolean;
  readonly wrapRef: RefObject<HTMLDivElement | null>;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  /**
   * Opens it, with the focus in it (from the keyboard) or left where it is (the mouse). Opened by a
   * key of the box, the focus goes back to the box (`back`), not to the button.
   */
  readonly show: (focus: boolean, back?: HTMLElement | null) => void;
  readonly close: (back?: boolean) => void;
  readonly onButtonClick: (event: MouseEvent) => void;
  readonly onButtonKeyDown: (event: KeyboardEvent) => void;
  readonly onMenuKeyDown: (event: KeyboardEvent) => void;
  /** After an item was chosen: closed, the focus back on the button where it was in the menu. */
  readonly chosen: () => void;
}

const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

export function useBoxMenu(): BoxMenu {
  const [open, setOpen] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const backTo = useRef<HTMLElement | null>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])];

  useEffect(() => {
    if (open && focusIn) wrap.current?.querySelector<HTMLButtonElement>(ITEMS)?.focus();
  }, [open, focusIn]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    // Opened with the mouse, the caret stays in the box: Esc there closes it too, and only it.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || wrap.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const show = (focus: boolean, back: HTMLElement | null = null) => {
    backTo.current = back;
    setFocusIn(focus);
    setOpen(true);
  };
  const close = (back = false) => {
    setOpen(false);
    if (back) (backTo.current ?? button.current)?.focus();
  };
  return {
    open,
    wrapRef: wrap,
    buttonRef: button,
    show,
    close,
    onButtonClick: (event) => {
      if (open) close();
      else show(event.detail === 0);
    },
    onButtonKeyDown: (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show(true);
    },
    onMenuKeyDown: (event) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const go = (index: number) => list[(index + list.length) % list.length]?.focus();
      if (event.key === "ArrowDown") go(at + 1);
      else if (event.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(-1);
      else if (event.key === "Escape") close(true);
      else if (event.key === "Tab") setOpen(false);
      else return;
      if (event.key !== "Tab") {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    chosen: () => {
      const inside = wrap.current?.contains(document.activeElement) === true;
      setOpen(false);
      if (inside) (backTo.current ?? button.current)?.focus();
    },
  };
}
