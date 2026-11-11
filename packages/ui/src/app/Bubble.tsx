import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Bubble.module.css";

const GAP = 8;
const MARGIN = 6;

interface BubbleProps {
  /** What it belongs to. */
  readonly anchor: DOMRect;
  readonly title: string;
  readonly onClose: () => void;
  /** For a bubble with more in it than the usual width takes. */
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/**
 * A small window that points at what opened it, as the items of the status bar in VS Code have. It
 * goes away with Escape or a click elsewhere, and the focus goes back to where it was.
 */
export function Bubble({ anchor, title, onClose, className, children }: BubbleProps) {
  const root = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);

  useLayoutEffect(() => {
    closing.current = onClose;
  });

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const middle = anchor.left + anchor.width / 2;
    const left = Math.min(Math.max(middle - width / 2, MARGIN), innerWidth - width - MARGIN);
    element.style.left = `${left}px`;
    // Above what it belongs to, unless the window ends there.
    const fitsAbove = anchor.top - GAP - height >= MARGIN;
    element.style.bottom = fitsAbove ? `${innerHeight - anchor.top + GAP}px` : "auto";
    element.style.top = fitsAbove ? "auto" : `${anchor.bottom + GAP}px`;
    element.dataset["side"] = fitsAbove ? "above" : "below";
    element.style.setProperty("--arrow", `${middle - left}px`);
  }, [anchor]);

  useEffect(() => {
    const opener = document.activeElement;
    const first = root.current?.querySelector<HTMLElement>(
      "[data-autofocus], input, button:not(:disabled)",
    );
    // Without anything to press yet, the bubble itself, so that Escape closes it.
    (first ?? root.current)?.focus();
    if (first instanceof HTMLInputElement) first.select();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closing.current();
    };
    // What had the focus in here can lose it without anything else getting it, as a button that
    // cannot be pressed any more once it was: Escape closes the bubble all the same.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      const isLost =
        active === null ||
        active === document.body ||
        (active instanceof HTMLButtonElement &&
          active.disabled &&
          root.current?.contains(active) === true);
      if (isLost) closing.current();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={root}
      className={className ? `${styles.bubble} ${className}` : styles.bubble}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") closing.current();
      }}
    >
      <h3 className={styles.title}>{title}</h3>
      {children}
    </div>,
    document.body,
  );
}
