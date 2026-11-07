import { CircleAlert, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Workbench } from "../workbench/workbench.ts";
import styles from "./ErrorPrompt.module.css";

/** Long enough to read the number, after which it only takes room. */
const SENT_STAYS_MS = 8000;

/**
 * Asks in the corner whether to send what went wrong. It takes the words from the workbench rather
 * than from React, so that it still works where everything else around it failed.
 */
export function ErrorPrompt({ workbench }: { workbench: Workbench }) {
  const { errors, t } = workbench;
  const { errors: caught, asking } = useSyncExternalStore(errors.subscribe, errors.getSnapshot);
  const [shown, setShown] = useState<number>();
  const [open, setOpen] = useState(false);
  if (asking && asking.id !== shown) {
    setShown(asking.id);
    setOpen(false);
  }
  const error = caught.find(({ id }) => id === shown);
  const status = error?.status;

  useEffect(() => {
    if (status !== "sent") return;
    const timer = setTimeout(() => setShown(undefined), SENT_STAYS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (!error || status === "declined" || status === "quiet") return null;
  const close = () => {
    if (status === "asking") errors.decline(error.id);
    setShown(undefined);
  };

  const title = t(
    status === "sent"
      ? "errors.sentTitle"
      : status === "failed"
        ? "errors.failedTitle"
        : "errors.ask",
  );

  return (
    <section className={styles.prompt} role="alertdialog" aria-label={title}>
      <header>
        <CircleAlert size={16} className={styles.icon} />
        <strong>{title}</strong>
        <button
          type="button"
          className={styles.close}
          aria-label={t("errors.close")}
          onClick={close}
        >
          <X size={14} />
        </button>
      </header>
      {status === "asking" || status === "sending" ? (
        <>
          <p>{t("errors.askNote")}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={status === "sending"}
              onClick={() => void errors.send(error.id)}
            >
              {t(status === "sending" ? "errors.sending" : "errors.send")}
            </button>
            <button type="button" disabled={status === "sending"} onClick={close}>
              {t("errors.decline")}
            </button>
            <button
              type="button"
              className={styles.link}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {t(open ? "errors.hide" : "errors.show")}
            </button>
          </div>
          {open && (
            <pre className={styles.report} aria-label={t("errors.content")} tabIndex={0}>
              {JSON.stringify(error.report, undefined, 2)}
            </pre>
          )}
        </>
      ) : (
        <p role="status">
          {status === "sent" ? t("errors.sent", { id: error.sentId }) : t("errors.sendFailed")}
        </p>
      )}
    </section>
  );
}
