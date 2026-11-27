import { ArrowUp, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "../../app/Tip.tsx";
import styles from "./input.module.css";

/**
 * What the round button of the box does now: nothing to send (it puts the caret in the box), send,
 * stop the task that runs, queue what was typed while it runs, or, while a change waits for people,
 * not allow it and send what was typed to AI with that ("不允许，并告诉 AI 怎么改").
 */
export type SendState = "empty" | "ready" | "stop" | "queue" | "decline";

export function sendStateOf(running: boolean, hasSomething: boolean, declining = false): SendState {
  if (declining && hasSomething) return "decline";
  if (running) return hasSomething ? "queue" : "stop";
  return hasSomething ? "ready" : "empty";
}

/**
 * One round button in one place (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): faint while
 * there is nothing to send, never greyed out as if it could not be pressed; ↑ to send; ■ to stop
 * while a task runs; ↑ with "排" on it to queue what was typed meanwhile.
 */
export function SendButton(props: {
  readonly state: SendState;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onEmpty: () => void;
  /** The keys that send, for its tip. */
  readonly keys: string;
}) {
  const { t } = useTranslation();
  const { state } = props;
  const label =
    state === "stop"
      ? t("chat.stop")
      : state === "queue"
        ? t("chat.compose.queue")
        : state === "decline"
          ? t("chat.compose.decline")
          : t("chat.send");
  // Nothing to send: still a button (it puts the caret in the box), and those who listen hear why.
  const said = state === "empty" ? t("chat.compose.sendEmpty") : label;
  return (
    <Tip name={label} usage="" shortcut={state === "stop" ? "Esc" : props.keys}>
      <button
        type="button"
        className={styles.send}
        data-state={state}
        data-testid="chat-send"
        aria-label={said}
        // The box keeps its caret and what is selected in it.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (state === "stop") props.onStop();
          else if (state === "empty") props.onEmpty();
          else props.onSend();
        }}
      >
        {state === "stop" ? (
          <Square size={11} fill="currentColor" aria-hidden />
        ) : (
          <ArrowUp size={15} strokeWidth={2.4} aria-hidden />
        )}
        {state === "queue" && (
          <span className={styles.badge} aria-hidden>
            {t("chat.compose.queueBadge")}
          </span>
        )}
      </button>
    </Tip>
  );
}
