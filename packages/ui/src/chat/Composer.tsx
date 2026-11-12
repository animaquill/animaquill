import { CornerUpLeft, SendHorizontal, Square, X } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { ModelPicker, ReasoningPicker } from "./ModelPicker.tsx";

/** How many lines the input box grows to, and starts with. */
const MIN_ROWS = 2;
const MAX_ROWS = 10;

/**
 * Where people write to AI: a box that grows with what they write (2 to 10 lines), whose draft is
 * kept for each conversation in the memory of the window; under it the model and how hard it
 * reasons, and send, or stop while a task runs. Enter sends, Shift+Enter is a new line, nothing
 * goes while an input method composes. While a task runs Enter queues the message for after it;
 * queued messages show above the box, to take back.
 */
export function Composer(props: {
  /** Something went out: the list follows the newest again. */
  readonly onSent: () => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const conversation = snapshot.conversation;
  useSyncExternalStore(
    conversation?.subscribe ?? noop,
    conversation?.getSnapshot ?? (() => undefined),
  );
  const running = conversation?.running === true;
  const project = chat.projectKey;
  const id = snapshot.id;
  const read = useCallback(
    () => (project === undefined || id === undefined ? "" : chat.drafts.read(project, id)),
    [chat, project, id],
  );
  const text = useSyncExternalStore(chat.drafts.subscribe, read);
  const write = (value: string) => {
    if (project !== undefined && id !== undefined) chat.drafts.write(project, id, value);
  };

  // The box grows with its lines, up to ten, then scrolls.
  const box = useRef<HTMLTextAreaElement>(null);
  const measured = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || measured.current === element.value) return;
    measured.current = element.value;
    const style = getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 16;
    const edges =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    element.style.height = "auto";
    const wanted = Math.min(
      MAX_ROWS * line + edges,
      Math.max(MIN_ROWS * line + edges, element.scrollHeight + 1),
    );
    element.style.height = `${wanted}px`;
  });

  const send = () => {
    if (!text.trim()) return;
    write("");
    props.onSent();
    if (running) chat.queue(text);
    else void chat.send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && running) {
      event.preventDefault();
      chat.stop();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const takeBack = (index: number) => {
    const queued = chat.unqueue(index);
    if (queued !== undefined && project !== undefined && id !== undefined) {
      chat.drafts.restore(project, id, queued);
      box.current?.focus();
    }
  };

  return (
    <div className={styles.compose}>
      {snapshot.queued.length > 0 && (
        <div className={styles.queued} data-testid="chat-queued">
          {snapshot.queued.map((queued, index) => (
            <div key={`${index}/${queued}`} className={styles.queuedItem}>
              <span className={styles.queuedText} title={queued}>
                {t("chat.compose.queued", { text: queued })}
              </span>
              {!running && index === 0 && (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    const next = chat.unqueue(0);
                    if (next !== undefined) {
                      props.onSent();
                      void chat.send(next);
                    }
                  }}
                >
                  {t("chat.compose.sendNow")}
                </button>
              )}
              <button
                type="button"
                className={styles.icon}
                aria-label={t("chat.compose.edit")}
                title={t("chat.compose.edit")}
                onClick={() => takeBack(index)}
              >
                <CornerUpLeft size={12} aria-hidden />
              </button>
              <button
                type="button"
                className={styles.icon}
                aria-label={t("chat.compose.drop")}
                title={t("chat.compose.drop")}
                onClick={() => chat.unqueue(index)}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        data-testid="chat-input"
        aria-label={t("chat.placeholder")}
        placeholder={running ? t("chat.compose.whileRunning") : t("chat.placeholder")}
        value={text}
        rows={MIN_ROWS}
        onChange={(event) => write(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.controls}>
        <ModelPicker />
        <ReasoningPicker />
        <span className={styles.grow} />
        {running && text.trim() !== "" && (
          <button type="button" data-testid="chat-queue" onClick={send}>
            {t("chat.compose.queue")}
          </button>
        )}
        {running ? (
          <button
            type="button"
            className={styles.stop}
            aria-label={t("chat.stop")}
            onClick={() => chat.stop()}
          >
            <Square size={12} /> <span className={styles.buttonText}>{t("chat.stop")}</span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.send}
            aria-label={t("chat.send")}
            disabled={!text.trim()}
            onClick={send}
          >
            <SendHorizontal size={12} className={styles.narrowIcon} />
            <span className={styles.buttonText}>{t("chat.send")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const noop = () => () => {};
