import { Check } from "lucide-react";
import {
  Fragment,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Menu.module.css";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  /** One choice among several, which this is or is not. */
  readonly selected?: boolean;
  /** Something on or off on its own. */
  readonly checked?: boolean;
  readonly shortcut?: string;
  readonly disabled?: boolean;
}

interface MenuProps {
  readonly label: string;
  /** What the button shows, when that is more than the label. The label still names it. */
  readonly trigger?: ReactNode;
  readonly triggerClassName?: string | undefined;
  /** Which edge of the button the menu lines up with. The end, near the end of the window. */
  readonly align?: "start" | "end";
  /** Asked when the menu opens, so that what is possible right now is what it shows. */
  readonly groups: () => readonly (readonly MenuItem[])[];
}

const roleOf = (item: MenuItem) => {
  if (item.selected !== undefined) return "menuitemradio";
  return item.checked === undefined ? "menuitem" : "menuitemcheckbox";
};

const itemsIn = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []),
];

interface MenuListProps {
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
  readonly className?: string | undefined;
  readonly onClose: () => void;
}

/** The items of a menu, and moving through them with the keyboard. */
const MenuList = forwardRef<HTMLDivElement, MenuListProps>(function MenuList(
  { label, groups, className, onClose },
  ref,
) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = itemsIn(event.currentTarget);
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
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className={`${styles.menu} ${className ?? ""}`}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.preventDefault()}
    >
      {groups.map((group, index) => (
        <Fragment key={group[0]?.id ?? index}>
          {index > 0 && <div className={styles.separator} role="separator" />}
          {group.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.item}
              role={roleOf(item)}
              {...((item.selected ?? item.checked) === undefined
                ? {}
                : { "aria-checked": item.selected ?? item.checked })}
              {...(item.shortcut ? { "aria-keyshortcuts": item.shortcut } : {})}
              tabIndex={-1}
              disabled={item.disabled === true}
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <span className={styles.mark}>
                {(item.selected ?? item.checked) && <Check size={14} />}
              </span>
              <span className={styles.label}>{item.label}</span>
              {item.shortcut && (
                <kbd className={styles.shortcut} aria-hidden="true">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
});

export function Menu({ label, trigger, triggerClassName, align, groups }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) itemsIn(root.current)[0]?.focus();
  }, [open]);

  // Losing the focus covers clicks anywhere, including in an iframe, and other windows.
  const closeOnLeaving = (event: FocusEvent) => {
    if (!root.current?.contains(event.relatedTarget)) setOpen(false);
  };

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className={styles.root} ref={root} onBlur={closeOnLeaving}>
      <button
        ref={button}
        type="button"
        className={`${styles.trigger} ${triggerClassName ?? ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(trigger !== undefined && { "aria-label": label })}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? label}
      </button>
      {open && (
        <MenuList
          label={label}
          groups={groups()}
          className={align === "end" ? styles.end : undefined}
          onClose={close}
        />
      )}
    </div>
  );
}

interface PopupMenuProps {
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
  /** Where it opens, in pixels from the top left of the window. */
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}

/** A menu that opens at the pointer, for right clicks. It stays inside the window. */
export function PopupMenu({ label, groups, x, y, onClose }: PopupMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    opener.current = document.activeElement;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(Math.min(x, innerWidth - width - 4), 4)}px`;
    element.style.top = `${Math.max(Math.min(y, innerHeight - height - 4), 4)}px`;
    itemsIn(element)[0]?.focus();
  }, [x, y]);

  const close = () => {
    onClose();
    if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <MenuList ref={list} className={styles.popup} label={label} groups={groups} onClose={close} />
    </div>,
    document.body,
  );
}
