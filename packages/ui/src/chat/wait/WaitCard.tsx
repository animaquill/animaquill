import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Tip } from "../../app/Tip.tsx";
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

/**
 * What waits for people (docs/design/chat-panel.md of AnimaQuill Cloud, 6): a change to allow, a
 * question, a plan, all one card, the last thing of its turn. It takes the focus as it shows where
 * people are in the chat and not writing there, or nowhere: never from another panel of the editor,
 * nor from words they are typing. With the focus on it, Enter does the main button and Esc the one
 * that says no; on a button of it, Enter is that button.
 */
export function WaitCard(props: {
  readonly kind: "approve" | "question" | "plan";
  readonly icon: ReactNode;
  readonly title: ReactNode;
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
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const active = document.activeElement as HTMLElement | null;
    const free = active === null || active === document.body;
    const inChat =
      active?.closest('[data-testid="chat"]') === element.closest('[data-testid="chat"]');
    const typing =
      active?.getAttribute("role") === "textbox" && (active.textContent ?? "").trim() !== "";
    if (free || (inChat && !typing)) element.focus({ preventScroll: true });
  }, []);
  const actions = props.actions ?? [];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.nativeEvent.isComposing) return;
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
    >
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
