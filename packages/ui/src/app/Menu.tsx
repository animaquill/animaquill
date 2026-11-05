import { Check } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import styles from "./Menu.module.css";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  readonly selected?: boolean;
}

interface MenuProps {
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
}

const itemsIn = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
];

export function Menu({ label, groups }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    itemsIn(root.current)[0]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const list = itemsIn(root.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = {
      ArrowDown: (index + 1) % list.length,
      ArrowUp: (index - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      list[next]?.focus();
    } else if (event.key === "Escape") {
      close();
    }
  };

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={button}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {groups.map((group, index) => (
            <Fragment key={group[0]?.id ?? index}>
              {index > 0 && <div className={styles.separator} role="separator" />}
              {group.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.item}
                  role={item.selected === undefined ? "menuitem" : "menuitemradio"}
                  {...(item.selected === undefined ? {} : { "aria-checked": item.selected })}
                  tabIndex={-1}
                  onClick={() => {
                    item.run();
                    close();
                  }}
                >
                  <span className={styles.mark}>{item.selected && <Check size={14} />}</span>
                  {item.label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
