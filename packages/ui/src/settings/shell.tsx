import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./Settings.module.css";

/**
 * The shell that the settings and the project properties share (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 4.2 and 5.1): a dialog over whatever the window
 * shows, closed by Esc, ✕ or a press outside, which keeps what people are typing; where the window
 * is narrow it fills it and shows one level at a time, each a step of the browser's history.
 */

/** Below this they fill the window and show one level at a time (4.2). */
export const NARROW = "(max-width: 719px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const follow = () => setNarrow(query.matches);
    query.addEventListener("change", follow);
    follow();
    return () => query.removeEventListener("change", follow);
  }, []);
  return narrow;
}

/** How many steps of the browser's history a dialog has put on, by what each step says. */
const stepsNow = (key: string): number => {
  const state: unknown = history.state;
  const step =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)[key]
      : undefined;
  return typeof step === "number" ? step : 0;
};

/**
 * Takes the steps of a dialog off the history, as it closes: see `useLevelsInHistory`. Not as the
 * dialog goes away, which React also does to try it out.
 */
export function useNoStepsWhenClosed(key: string, shown: boolean): void {
  useEffect(() => {
    const steps = stepsNow(key);
    if (!shown && steps > 0) history.go(-steps);
  }, [key, shown]);
}

/** What goes up a level and closes: the place of a dialog, see `SettingsNav` and `ProjectNav`. */
export interface Levels {
  getSnapshot(): { readonly depth: number };
  back(): void;
  close(): void;
}

/**
 * Where a dialog is narrow, it and each level in are a step of the browser's history, so that its
 * back button goes up a level, as the "‹" does, and from the list of groups closes it. Each step
 * says how many there are up to it (under `key`), so that whatever moves the history, the dialog
 * follows what it says. Levels the dialog leaves in another way are taken off the history again.
 * (Not a modal `<dialog>`: browsers take going back in the history for closing one of those, and
 * the history would not move.)
 */
export function useLevelsInHistory(
  key: string,
  levels: Levels,
  narrow: boolean,
  depth: number,
): () => void {
  useEffect(() => {
    if (!narrow) return;
    const onPop = () => {
      const steps = stepsNow(key);
      if (steps === 0) return levels.close();
      while (levels.getSnapshot().depth > steps - 1) levels.back();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [key, narrow, levels]);

  useEffect(() => {
    const wanted = narrow ? depth + 1 : 0;
    const steps = stepsNow(key);
    if (steps > wanted) history.go(wanted - steps);
    for (let step = steps + 1; step <= wanted; step += 1) {
      const state: unknown = history.state;
      const base = typeof state === "object" && state !== null ? state : {};
      history.pushState({ ...base, [key]: step }, "");
    }
  }, [key, narrow, depth]);

  // The "‹": through the history where there is a step of it, so that both stay in step.
  return () => {
    if (stepsNow(key) > 1) history.back();
    else levels.back();
  };
}

/** Inputs where people type, which take what they typed when they lose the focus or on Enter. */
export const isTyping = (
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "range", "color", "file", "submit"].includes(element.type));

/**
 * The dialog itself: the dim behind it, the focus kept in it, Esc, Tab going round, and a press
 * outside that closes it unless something typed did not go in yet.
 */
export function DialogFrame(props: {
  readonly label: string;
  readonly testId: string;
  readonly narrow: boolean;
  readonly onClose: () => void;
  /** Where the focus goes as it opens, where it is wide: the dialog itself without one. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** A search box, whose own Esc empties it first, and whose typing is never kept back. */
  readonly searchBox?: RefObject<HTMLElement | null>;
  /** Tells the size and look apart, such as `properties`. */
  readonly kind?: string;
  readonly dialogRef?: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}) {
  const { onClose, narrow, initialFocus, searchBox } = props;
  const own = useRef<HTMLDivElement>(null);
  const dialog = props.dialogRef ?? own;
  /** The input people are typing in, and what it had when they began: see `dirty`. */
  const typing = useRef<{ element: Element; value: string } | undefined>(undefined);
  /** Whether the press that may close the dialog began outside of it. */
  const pressedOutside = useRef(false);

  /** What had the focus as the dialog opened: also through React trying the dialog out twice. */
  const [opener] = useState(() => document.activeElement);
  /** Set as the dialog goes: the focus may leave it then. */
  const leaving = useRef(false);

  // The focus goes in, and back to where it was as it closes. On a phone the keyboard would cover
  // it all, so there only the dialog.
  useLayoutEffect(() => {
    leaving.current = false;
    if (matchMedia(NARROW).matches || !initialFocus?.current) dialog.current?.focus();
    else initialFocus.current.focus();
    return () => {
      leaving.current = true;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only as it opens
  }, []);

  // The focus stays in the dialog, as in any dialog that is in the way of what is behind it: what
  // leaves it for the editor comes back. Dialogs over it, and the notifications, are not that.
  useEffect(() => {
    const keepFocus = (event: FocusEvent) => {
      const element = dialog.current;
      const target = event.target as Element | null;
      if (leaving.current || !element || !target || element.contains(target)) return;
      if (target.closest("dialog, [data-notifications]")) return;
      element.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => document.removeEventListener("focusin", keepFocus);
  }, [dialog]);

  /** Something typed that did not go in yet: a press outside does not throw it away. */
  const dirty = () => {
    const active = document.activeElement;
    const was = typing.current;
    return (
      isTyping(active) &&
      active !== searchBox?.current &&
      was?.element === active &&
      active.value !== was.value
    );
  };

  /** Esc closes it; what is open over it, or in it, such as a list or a recording, first. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return keepTabIn(event);
    // Enter takes what was typed, as losing the focus does: nothing is left to keep then.
    if (event.key === "Enter" && isTyping(event.target as Element)) {
      const target = event.target as HTMLInputElement;
      typing.current = { element: target, value: target.value };
      return;
    }
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ((event.target as Element).closest("dialog")) return;
    event.preventDefault();
    // Something typed that did not go in yet goes in first, as when the box loses the focus.
    const active = document.activeElement;
    if (dirty() && active instanceof HTMLElement) active.blur();
    else onClose();
  };
  /** Tab from the last thing in the dialog goes to the first, and the other way round. */
  const keepTabIn = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = dialog.current;
    if (!element) return;
    const all = [
      ...element.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((each) => !each.matches(":disabled") && each.offsetParent !== null);
    const first = all[0];
    const last = all.at(-1);
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === element)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        className={styles.backdrop}
        data-testid={`${props.testId}-backdrop`}
        onMouseDown={(event) => {
          // Something typed that did not go in yet keeps the dialog open, and the focus.
          pressedOutside.current = !dirty();
          if (!pressedOutside.current) event.preventDefault();
        }}
        onClick={() => {
          // A press that began and ended on the dim around the dialog.
          if (pressedOutside.current && !dirty()) onClose();
          pressedOutside.current = false;
        }}
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={styles.dialog}
        data-testid={props.testId}
        data-kind={props.kind}
        data-narrow={narrow ? "" : undefined}
        aria-label={props.label}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const target = event.target as Element;
          if (isTyping(target) && typing.current?.element !== target)
            typing.current = { element: target, value: target.value };
        }}
        onMouseDown={() => {
          pressedOutside.current = false;
        }}
      >
        {props.children}
      </div>
    </>
  );
}
