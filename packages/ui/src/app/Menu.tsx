import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Fragment,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import styles from "./Menu.module.css";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  /** One choice among several, which this is or is not. */
  readonly selected?: boolean;
  /** Something on or off on its own. */
  readonly checked?: boolean;
  /**
   * A tick that only says how things are, such as a panel being open, in words that screen readers
   * read after the label. Choosing the item does not take it away, so it is no checkbox.
   */
  readonly ticked?: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** It takes something away, which shows. */
  readonly danger?: boolean;
  /** A few words on its right, such as how many it is about, or why it cannot be chosen. */
  readonly note?: string;
  /**
   * A menu of its own, which opens beside it, or in place of the menu where there is no room:
   * `run` is not called then. Only in menus that open at the pointer, see `PopupMenu`.
   */
  readonly items?: readonly (readonly MenuItem[])[];
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

/** A click this soon after a menu took the place of another is the second of a double click. */
const QUIET_MS = 500;
const QUIET_PX = 6;

/** A click, as the second of a double click, where the first was and right after it. */
interface Quiet {
  readonly until: number;
  readonly x: number;
  readonly y: number;
}

const isQuiet = (quiet: Quiet | undefined, event: MouseEvent | globalThis.MouseEvent) =>
  quiet !== undefined &&
  performance.now() < quiet.until &&
  Math.abs(event.clientX - quiet.x) <= QUIET_PX &&
  Math.abs(event.clientY - quiet.y) <= QUIET_PX;

interface MenuListProps {
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
  readonly className?: string | undefined;
  readonly hidden?: boolean;
  readonly onClose: () => void;
  /**
   * Opens the menu of an item that has one, from a click or a key (`byKey`); undefined closes the
   * one that is open.
   */
  readonly onSubmenu?: (item: MenuItem, from: HTMLElement, byKey: boolean) => void;
  /** The mouse rests on an item, one with a menu or not. */
  readonly onHover?: (item: MenuItem, from: HTMLElement) => void;
  readonly onPointerEnter?: () => void;
  /** The item whose menu is open. */
  readonly opened?: string | undefined;
  /** Leaves this menu for the one it came from, as ArrowLeft does in a menu of an item. */
  readonly onBack?: () => void;
  /** A row on top that leads back, in a menu that took the place of the one it came from. */
  readonly back?: string | undefined;
  /** Where and until when a click is the second of a double click on what this replaced. */
  readonly quiet?: Quiet | undefined;
}

/** The items of a menu, and moving through them with the keyboard. */
const MenuList = forwardRef<HTMLDivElement, MenuListProps>(function MenuList(
  {
    label,
    groups,
    className,
    hidden,
    onClose,
    onSubmenu,
    onHover,
    onPointerEnter,
    opened,
    onBack,
    back,
    quiet,
  },
  ref,
) {
  const { t } = useTranslation();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = itemsIn(event.currentTarget);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = {
      ArrowDown: (index + 1) % list.length,
      ArrowUp: index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      list[next]?.focus();
    } else if (event.key === "Escape" || (event.key === "ArrowLeft" && onBack)) {
      event.preventDefault();
      if (onBack) onBack();
      else onClose();
    }
  };

  return (
    <div
      ref={ref}
      className={`${styles.menu} ${className ?? ""}`}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      hidden={hidden}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.preventDefault()}
      onPointerEnter={onPointerEnter}
    >
      {back !== undefined && (
        <>
          <button
            type="button"
            className={`${styles.item} ${styles.back}`}
            role="menuitem"
            aria-description={t("menu.back")}
            tabIndex={-1}
            data-menu-back=""
            onClick={(event) => {
              if (!isQuiet(quiet, event)) onBack?.();
            }}
          >
            <span className={styles.mark}>
              <ChevronLeft size={14} aria-hidden />
            </span>
            <span className={styles.label}>{back}</span>
          </button>
          <div className={styles.separator} role="separator" />
        </>
      )}
      {groups.map((group, index) => (
        <Fragment key={group[0]?.id ?? index}>
          {index > 0 && <div className={styles.separator} role="separator" />}
          {group.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.danger ? `${styles.item} ${styles.danger}` : styles.item}
              role={roleOf(item)}
              {...((item.selected ?? item.checked) === undefined
                ? {}
                : { "aria-checked": item.selected ?? item.checked })}
              {...(item.ticked !== undefined && { "aria-description": item.ticked })}
              {...(item.shortcut ? { "aria-keyshortcuts": item.shortcut } : {})}
              tabIndex={-1}
              disabled={item.disabled === true}
              {...(item.items && {
                "aria-haspopup": "menu" as const,
                "aria-expanded": opened === item.id,
              })}
              data-open={opened === item.id ? "" : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType !== "mouse") return;
                // One place in the menu, for the mouse and the keys alike, as in a desktop's menus.
                if (!event.currentTarget.disabled)
                  event.currentTarget.focus({ preventScroll: true });
                onHover?.(item, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (!item.items || (event.key !== "ArrowRight" && event.key !== "Enter")) return;
                event.preventDefault();
                event.stopPropagation();
                onSubmenu?.(item, event.currentTarget, true);
              }}
              onClick={(event) => {
                if (isQuiet(quiet, event)) return;
                if (item.items) {
                  // Space, or a reader's click, comes with no count of clicks.
                  onSubmenu?.(item, event.currentTarget, event.detail === 0);
                  return;
                }
                item.run();
                onClose();
              }}
            >
              <span className={styles.mark}>
                {(item.selected ?? item.checked ?? item.ticked !== undefined) && (
                  <Check size={14} />
                )}
              </span>
              <span className={styles.label}>{item.label}</span>
              {item.note && <span className={styles.note}>{item.note}</span>}
              {item.shortcut && (
                <kbd className={styles.shortcut} aria-hidden="true">
                  {item.shortcut}
                </kbd>
              )}
              {item.items && <ChevronRight size={14} aria-hidden className={styles.more} />}
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

/** How long the mouse rests on an item before its menu opens, or the one open closes. */
const HOVER_MS = 150;
/** The gap between a menu and the one of its item, and between a menu and the window's edge. */
const GAP = 2;
const EDGE = 4;

/** After a click that opened a menu in place, where its second click would be. */
const quietFrom = (how: Opened["how"], at: { readonly x: number; readonly y: number }) =>
  how === "click" ? { until: performance.now() + QUIET_MS, ...at } : undefined;

interface Opened {
  readonly item: MenuItem;
  readonly from: HTMLElement;
  /** From a key its first item takes the focus; the mouse passing by opens it only beside. */
  readonly how: "key" | "click" | "hover";
  /**
   * In place of the menu it came from, one level in, with a row on top that leads back: where there
   * is no room beside it, as on a phone, so that it never lies over the item that opened it.
   */
  readonly inPlace: boolean;
}

/**
 * A menu that opens at the pointer, for right clicks. It stays inside the window.
 *
 * The menu of an item opens beside it, as the mouse rests on the item or as it is clicked. Where the
 * window has no room for it on either side, it takes the place of the menu instead, and only a click
 * or a key opens it, never the pointer passing by: what is under the pointer does not change by
 * itself.
 */
export function PopupMenu({ label, groups, x, y, onClose }: PopupMenuProps) {
  const holder = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState<Opened>();
  /** No room beside this menu for the menu of an item. */
  const [narrow, setNarrow] = useState(false);
  const [quiet, setQuiet] = useState<Quiet>();
  const down = useRef({ x: 0, y: 0 });
  useEffect(() => () => clearTimeout(timer.current), []);
  // The second click of a double click that opened a menu in place lands where the item was, which
  // may now be past its end: it does nothing there either, rather than close the menus.
  useEffect(() => {
    if (quiet === undefined) return;
    const swallow = (event: globalThis.MouseEvent) => {
      if (!isQuiet(quiet, event) || holder.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const kinds = [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "dblclick",
    ] as const;
    for (const kind of kinds) addEventListener(kind, swallow, true);
    return () => {
      for (const kind of kinds) removeEventListener(kind, swallow, true);
    };
  }, [quiet]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    // Not its own item, as when React runs this twice to check it.
    if (!holder.current?.contains(document.activeElement)) opener.current = document.activeElement;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(Math.min(x, innerWidth - width - EDGE), EDGE);
    element.style.left = `${left}px`;
    element.style.top = `${Math.max(Math.min(y, innerHeight - height - EDGE), EDGE)}px`;
    // A menu of an item is at least as wide as a menu is at the least, which is about this one.
    const room = Math.max(innerWidth - left - width - GAP - EDGE, left - GAP - EDGE);
    setNarrow(room < width);
    itemsIn(element)[0]?.focus();
  }, [x, y]);

  // The menu of an item: to its right, or to its left where the window ends, or in place.
  useLayoutEffect(() => {
    const element = sub.current;
    const root = list.current;
    if (!element || !root || !open) return;
    const { width, height } = element.getBoundingClientRect();
    if (open.inPlace) {
      // Where the menu is, which is hidden now and has no box.
      const [left, top] = [parseFloat(root.style.left), parseFloat(root.style.top)];
      element.style.left = `${Math.max(Math.min(left, innerWidth - width - EDGE), EDGE)}px`;
      element.style.top = `${Math.max(Math.min(top, innerHeight - height - EDGE), EDGE)}px`;
      const first = itemsIn(element)[1];
      if (open.how === "key" && first) first.focus();
      else element.focus();
      return;
    }
    const beside = root.getBoundingClientRect();
    const right = beside.right + GAP;
    const left = beside.left - width - GAP;
    if (right + width > innerWidth - EDGE && left < EDGE) {
      // No room after all, which only its size tells: in place, from a click or a key; from the
      // mouse passing by, not at all. Before it is painted, so it is never seen beside.
      if (open.how !== "hover") element.focus();
      // oxlint-disable-next-line react/set-state-in-effect -- measured, see above
      setNarrow(true);
      // oxlint-disable-next-line react/set-state-in-effect -- measured, see above
      setQuiet(quietFrom(open.how, down.current));
      // oxlint-disable-next-line react/set-state-in-effect -- measured, see above
      setOpen(open.how === "hover" ? undefined : { ...open, inPlace: true });
      return;
    }
    element.style.left = `${right + width > innerWidth - EDGE ? left : right}px`;
    const from = open.from.getBoundingClientRect();
    element.style.top = `${Math.max(Math.min(from.top - EDGE, innerHeight - height - EDGE), EDGE)}px`;
    if (open.how === "key") itemsIn(element)[0]?.focus();
  }, [open]);

  const close = () => {
    onClose();
    if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
  };

  const show = (item: MenuItem, from: HTMLElement, byKey: boolean) => {
    clearTimeout(timer.current);
    const how = byKey ? "key" : "click";
    if (narrow) {
      // What holds the focus goes away: the focus waits in the menus until the new one is there.
      holder.current?.focus();
      setQuiet(quietFrom(how, down.current));
      setOpen({ item, from, how, inPlace: true });
      return;
    }
    if (item.id === open?.item.id && !byKey) return;
    setOpen({ item, from, how, inPlace: false });
  };

  const hover = (item: MenuItem, from: HTMLElement) => {
    if (narrow || open?.inPlace) return;
    clearTimeout(timer.current);
    if (!item.items && !open) return;
    if (item.id === open?.item.id) return;
    timer.current = setTimeout(
      () => setOpen(item.items && { item, from, how: "hover", inPlace: false }),
      HOVER_MS,
    );
  };

  const back = () => {
    if (!open) return;
    const { from } = open;
    holder.current?.focus();
    flushSync(() => setOpen(undefined));
    from.focus();
  };

  return createPortal(
    <div
      ref={holder}
      className={styles.holder}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        down.current = { x: event.clientX, y: event.clientY };
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <MenuList
        ref={list}
        className={styles.popup}
        label={label}
        groups={groups}
        hidden={open?.inPlace === true}
        onClose={close}
        opened={open?.item.id}
        onSubmenu={show}
        onHover={hover}
      />
      {open?.item.items && (
        <MenuList
          ref={sub}
          className={styles.popup}
          label={open.item.label}
          groups={open.item.items}
          onClose={close}
          onBack={back}
          back={open.inPlace ? open.item.label : undefined}
          onPointerEnter={() => clearTimeout(timer.current)}
          quiet={open.inPlace ? quiet : undefined}
        />
      )}
    </div>,
    document.body,
  );
}
