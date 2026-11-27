import { Pencil, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { plainOf } from "../refs.ts";
import type { Queued } from "../session.ts";
import styles from "./input.module.css";

/** More queued messages than this fold into "还有 N 条". */
const SHOWN = 3;

/**
 * The messages that go after the task that runs, over the box (docs/design/chat-panel.md of
 * AnimaQuill Cloud, 3.4), one small card each, in the order they go: "现在发" for the first while
 * nothing runs, ✎ takes it back into the box to change it, × takes it back.
 */
export function QueueList(props: {
  readonly queued: readonly Queued[];
  readonly running: boolean;
  readonly onSendNow: () => void;
  readonly onEdit: (index: number) => void;
  readonly onDrop: (index: number) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const { queued } = props;
  if (queued.length === 0) return null;
  const shown = all ? queued : queued.slice(0, SHOWN);
  return (
    <div className={styles.queued} data-testid="chat-queued">
      {shown.map((message, index) => {
        const text = plainOf(message.text);
        const pictures = message.images?.length ?? 0;
        return (
          <div
            key={`${index}/${message.text}`}
            className={styles.queuedItem}
            data-testid="chat-queued-item"
          >
            <span className={styles.queuedText} title={text}>
              {t("chat.compose.queued", { text, interpolation: { escapeValue: false } })}
              {pictures > 0 && ` · ${t("chat.pictures.count", { count: pictures })}`}
            </span>
            {!props.running && index === 0 && (
              <button
                type="button"
                className={styles.textButton}
                data-testid="chat-queued-now"
                onClick={props.onSendNow}
              >
                {t("chat.compose.sendNow")}
              </button>
            )}
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("chat.compose.edit")}
              title={t("chat.compose.edit")}
              data-testid="chat-queued-edit"
              onClick={() => props.onEdit(index)}
            >
              <Pencil size={12} aria-hidden />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("chat.compose.drop")}
              title={t("chat.compose.drop")}
              data-testid="chat-queued-drop"
              onClick={() => props.onDrop(index)}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        );
      })}
      {queued.length > SHOWN && (
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-queued-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? t("chat.compose.queuedLess")
            : t("chat.compose.queuedMore", { count: queued.length - SHOWN })}
        </button>
      )}
    </div>
  );
}
