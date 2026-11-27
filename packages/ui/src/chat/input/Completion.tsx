import type { LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./input.module.css";

/** One thing the menu of `/` or `@` can put in, or one more of a group to show. */
export interface CompletionOption {
  readonly key: string;
  /** What it is of, for tests and styles: a command, "now", a kind of the project, "more". */
  readonly kind: string;
  readonly icon: LucideIcon | undefined;
  readonly label: string;
  /** What it does, after its name, quieter: a command's words, how many more. */
  readonly note?: string | undefined;
  /** Why it cannot be chosen now, which it says instead of its note. */
  readonly why?: string | undefined;
}

export interface CompletionGroup {
  readonly key: string;
  /** Its heading: the kind of what it has. Commands have none. */
  readonly name: string | undefined;
  readonly options: readonly CompletionOption[];
}

/** The id of an option in the list, for `aria-activedescendant` of the box. */
export const optionId = (list: string, index: number): string => `${list}-${index}`;

/**
 * The menu of `/` and `@` (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): close to where
 * they were typed, over the line (under it where there is no room). The focus stays in the box, which
 * goes through it with ↑ ↓ and picks with Enter or Tab; the pointer picks too, and the caret stays.
 */
export function Completion(props: {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly CompletionGroup[];
  /** Said where nothing is found. */
  readonly empty: ReactNode;
  readonly active: number;
  /** Where `/` or `@` is on the screen. */
  readonly at: DOMRect;
  /** What the menu goes in, which it is placed in. */
  readonly within: HTMLElement | null;
  readonly onActive: (index: number) => void;
  readonly onPick: (index: number) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>();
  const { at, within } = props;
  // Placed again as it changes size: what is found changes how tall it is.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element || !within) return;
    const placeIt = () => {
      const card = within.getBoundingClientRect();
      const panel = within.closest('[data-testid="chat"]')?.getBoundingClientRect() ?? card;
      const height = element.scrollHeight;
      const width = element.offsetWidth;
      const left = Math.round(Math.max(0, Math.min(at.left - card.left - 4, card.width - width)));
      // Over the line it was typed on, as menus of words do; under it where there is no room.
      const above = at.top - panel.top - 8;
      const below = panel.bottom - at.bottom - 8;
      const under = height > above && below > above;
      const maxHeight = Math.round(Math.max(80, Math.min(300, under ? below : above)));
      setPlace(
        under
          ? { left, top: Math.round(at.bottom - card.top + 4), maxHeight }
          : { left, bottom: Math.round(card.bottom - at.top + 4), maxHeight },
      );
    };
    placeIt();
    const observer = new ResizeObserver(placeIt);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [at, within]);
  useLayoutEffect(() => {
    menu.current
      ?.querySelector(`#${CSS.escape(optionId(props.id, props.active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.active, props.id]);

  // Where each group starts among all the options, which go by one count.
  const starts = props.groups.reduce<number[]>(
    (all, _group, groupAt) => [
      ...all,
      (all[groupAt - 1] ?? 0) + (props.groups[groupAt - 1]?.options.length ?? 0),
    ],
    [],
  );
  return (
    <div
      ref={menu}
      className={styles.complete}
      style={place ?? { visibility: "hidden" }}
      data-testid="chat-complete"
      // The caret stays in the box: a click picks, it does not move the focus.
      onPointerDown={(event) => event.preventDefault()}
    >
      {props.groups.length === 0 ? (
        <p className={styles.completeEmpty} role="status">
          {props.empty}
        </p>
      ) : (
        <div id={props.id} role="listbox" aria-label={props.label}>
          {props.groups.map((group, groupAt) => (
            <div
              key={group.key}
              role="group"
              aria-label={group.name}
              className={styles.completeGroup}
            >
              {group.name && (
                <div className={styles.completeHead} aria-hidden>
                  {group.name}
                </div>
              )}
              {group.options.map((option, optionAt) => {
                const index = (starts[groupAt] ?? 0) + optionAt;
                const Icon = option.icon;
                return (
                  <div
                    key={option.key}
                    id={optionId(props.id, index)}
                    role="option"
                    aria-selected={index === props.active}
                    aria-disabled={option.why !== undefined || undefined}
                    className={styles.completeOption}
                    data-testid="chat-complete-option"
                    data-kind={option.kind}
                    onPointerMove={() => {
                      if (index !== props.active) props.onActive(index);
                    }}
                    onClick={() => props.onPick(index)}
                  >
                    {Icon ? (
                      <Icon size={13} aria-hidden className={styles.completeIcon} />
                    ) : (
                      <span className={styles.completeIcon} aria-hidden />
                    )}
                    <span className={styles.completeLabel}>{option.label}</span>
                    {(option.why ?? option.note) && (
                      <span className={styles.completeNote}>{option.why ?? option.note}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
