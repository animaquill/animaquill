import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Tip } from "../../app/Tip.tsx";
import { useChatUi } from "../ui.ts";
import styles from "./wait.module.css";

/** A button of a card that waits for people: its keys while the card has the focus. */
export interface WaitAction {
  readonly id: string;
  readonly label: string;
  readonly onAct: () => void;
  readonly primary?: boolean;
  /** Enter does it while the card itself has the focus (the main one); Esc, the one that says no. */
  readonly keys?: "Enter" | "Escape";
  readonly disabled?: boolean;
}

/** How long after a card shows, or gets the focus, Enter does nothing: a key meant for before. */
export const ENTER_AFTER_MS = 500;

/**
 * What waits for people (docs/design/chat-panel.md of AnimaQuill Cloud, 6): a change to allow, a
 * question, a plan, all one card, the last thing of its turn. It takes the focus only where people
 * are in the chat with nothing written in its box: never from another panel of the editor, nor from
 * words they are typing; where it does not, those who listen hear that it is there (`said`). With
 * the focus on it, Enter does the main button and Esc the one that says no; on a button of it, Enter
 * is that button. Enter is no answer for half a second after the card shows or gets the focus, nor
 * held down: a key pressed for what was there before never answers what came after. Words typed at
 * the card go to the box of the chat, where people write. A card that goes with the focus on it
 * gives the focus back to the box, so that the next one takes it.
 */
export function WaitCard(props: {
  readonly kind: "approve" | "question" | "plan";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  /** The title in words, said once to those who listen where the card does not take the focus. */
  readonly said?: string;
  /** The test id of what is in it, as before the cards were one (`chat-approve`, …). */
  readonly testId: string;
  readonly state?: string;
  readonly actions?: readonly WaitAction[];
  /** At the left of the foot, before the buttons. */
  readonly foot?: ReactNode;
  /** Keys of its own while the card has the focus, before Enter and Esc. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly children?: ReactNode;
}) {
  const ui = useChatUi();
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  /** From when Enter answers. */
  const enterFrom = useRef(0);
  const focused = useRef(false);
  const [announced, setAnnounced] = useState("");
  const { said } = props;
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    enterFrom.current = Date.now() + ENTER_AFTER_MS;
    const active = document.activeElement as HTMLElement | null;
    const chat = element.closest('[data-testid="chat"]');
    const inChat = active !== null && chat !== null && chat.contains(active);
    const typing =
      active?.getAttribute("role") === "textbox" && (active.textContent ?? "").trim() !== "";
    if (inChat && !typing) {
      element.focus({ preventScroll: true });
      return;
    }
    // Not in front of people: those who listen hear it, once.
    if (said === undefined) return;
    const timer = setTimeout(() => setAnnounced(said), 100);
    return () => clearTimeout(timer);
  }, [said]);
  // Gone with the focus on it: the box has it, where the next card takes it from.
  useEffect(
    () => () => {
      if (focused.current) ui.focusInput();
    },
    [ui],
  );
  const actions = props.actions ?? [];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.nativeEvent.isComposing) return;
    // Words typed at the card go to the box, where people write.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      ui.focusInput();
      return;
    }
    if (event.key === "Enter" && (event.repeat || Date.now() < enterFrom.current)) {
      event.preventDefault();
      return;
    }
    const keys = event.key === "Enter" ? "Enter" : event.key === "Escape" ? "Escape" : undefined;
    const action = keys && actions.find((each) => each.keys === keys && !each.disabled);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action.onAct();
  };
  return (
    <div
      ref={card}
      className={styles.card}
      data-testid="chat-wait"
      data-kind={props.kind}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && !focused.current)
          enterFrom.current = Math.max(enterFrom.current, Date.now() + ENTER_AFTER_MS);
        focused.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focused.current = false;
      }}
    >
      <span className={styles.srOnly} role="status">
        {announced}
      </span>
      <div className={styles.inner} data-testid={props.testId} data-state={props.state}>
        <div className={styles.head}>
          {props.icon}
          <span className={styles.title} id={titleId}>
            {props.title}
          </span>
        </div>
        <div className={styles.body}>{props.children}</div>
        {(actions.length > 0 || props.foot) && (
          <div className={styles.foot}>
            {props.foot ?? <span className={styles.grow} />}
            {actions.map((action) => (
              <Tip key={action.id} name={action.label} usage="" shortcut={keysName(action.keys)}>
                <button
                  type="button"
                  className={styles.button}
                  data-primary={action.primary || undefined}
                  data-testid={action.id}
                  disabled={action.disabled}
                  onClick={action.onAct}
                >
                  {action.label}
                </button>
              </Tip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const keysName = (keys: WaitAction["keys"]) =>
  keys === "Escape" ? "Esc" : keys === "Enter" ? "Enter" : undefined;
