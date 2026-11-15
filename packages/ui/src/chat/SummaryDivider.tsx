import type { SummaryEntry } from "@animaquill/agent";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";
import { tokens } from "./usage.ts";

/**
 * Where the earlier conversation was summed up for the model (mcp.md 8 "上下文"): a line across the
 * chat that says how many entries and about how many tokens, with the summary to read. People still
 * see everything before it, as it was; only the model gets the summary in its place.
 */
export function SummaryDivider({ entry }: { readonly entry: SummaryEntry }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const less = Math.max(0, entry.before - entry.after);
  const saved = tokens(less);
  return (
    <div className={styles.summed} data-testid="chat-summed" data-kind={entry.kind}>
      <span className={styles.summedLine} aria-hidden />
      <span className={styles.summedText}>
        {entry.kind === "summary" && entry.through === 0
          ? // A conversation that goes on from the summary of another: none of it is here.
            t("chat.summed.carried")
          : entry.kind === "summary"
            ? less > 0
              ? t("chat.summed.divider", { count: entry.count, saved })
              : t("chat.summed.dividerOnly", { count: entry.count })
            : less > 0
              ? t("chat.summed.pictures", { saved })
              : t("chat.summed.picturesOnly")}
        {entry.kind === "summary" && (
          <>
            {" · "}
            <button
              type="button"
              className={styles.link}
              data-testid="chat-summed-open"
              onClick={() => setOpen(true)}
            >
              {t("chat.summed.open")}
            </button>
          </>
        )}
      </span>
      <span className={styles.summedLine} aria-hidden />
      {open && <SummaryViewer entry={entry} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The summary as the model got it, to read: what it wrote, and what people asked, as they wrote it. */
function SummaryViewer({
  entry,
  onClose,
}: {
  readonly entry: SummaryEntry;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  // Open, it has the keyboard; closed, it gives it back to where it was.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => before?.focus();
  }, []);
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
  const title = t("chat.summed.title");
  return createPortal(
    <div
      className={styles.lookViewer}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="chat-summed-dialog"
      onClick={onClose}
      onKeyDown={keys}
    >
      <div
        ref={box}
        tabIndex={-1}
        className={`${styles.lookViewerBox} ${styles.summedBox}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.lookViewerHead}>
          <span>{title}</span>
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.summed.close")}
            onClick={onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className={styles.summedBody} data-testid="chat-summed-text">
          {entry.text}
        </div>
        {entry.asked !== undefined && (
          <>
            <div className={styles.muted}>{t("chat.summed.asked")}</div>
            <div className={styles.summedBody}>{entry.asked}</div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
