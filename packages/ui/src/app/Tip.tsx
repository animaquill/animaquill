import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Tip.module.css";

/** Long enough not to flash up while the mouse passes by. */
const SHOW_DELAY_MS = 350;
const GAP = 6;
const MARGIN = 4;

interface TipProps {
  readonly name: string;
  /** One short sentence about what it is for. */
  readonly usage: string;
  readonly shortcut?: string | undefined;
  readonly children: ReactNode;
}

/** Says what a control is and how to use it, so that an icon does not have to explain itself. */
export function Tip({ name, usage, shortcut, children }: TipProps) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const box = useRef<HTMLDivElement>(null);

  const showLater = (element: Element) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnchor(element.getBoundingClientRect()), SHOW_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setAnchor(undefined);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  // Below the control when there is room, always inside the window.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !anchor) return;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.min(Math.max(anchor.left, MARGIN), innerWidth - width - MARGIN);
    const below = anchor.bottom + GAP;
    const top = below + height > innerHeight ? anchor.top - height - GAP : below;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [anchor]);

  return (
    <span
      className={styles.host}
      onPointerEnter={(event) => {
        const target = event.currentTarget.firstElementChild;
        if (target) showLater(target);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
    >
      {children}
      {anchor &&
        createPortal(
          <div ref={box} className={styles.tip} role="tooltip">
            <div className={styles.head}>
              <strong>{name}</strong>
              {shortcut && <kbd>{shortcut}</kbd>}
            </div>
            <div>{usage}</div>
          </div>,
          document.body,
        )}
    </span>
  );
}
