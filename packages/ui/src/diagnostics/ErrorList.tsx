import { Download, Send } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { CaughtError } from "./errors.ts";
import styles from "./DiagnosticsPanel.module.css";

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function ErrorRow({ error }: { error: CaughtError }) {
  const workbench = useWorkbench();
  const { errors } = workbench;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { id, status, count, source, name, message, sentId } = error;
  const canSend =
    errors.canSend && (status === "quiet" || status === "declined" || status === "failed");

  return (
    <li className={styles.error}>
      <div className={styles.errorLine}>
        <span className={styles.when}>{clock(error.at)}</span>
        <span>{t(`errors.source.${source}`)}</span>
        <span className={styles.detail} title={message}>
          {message ? t("errors.what", { name, message }) : name}
        </span>
        {count > 1 && <span className={styles.when}>{t("errors.times", { count })}</span>}
      </div>
      <div className={styles.actions}>
        <span className={status === "failed" ? styles.bad : styles.quietText} role="status">
          {t(`errors.status.${status}`, { id: sentId })}
        </span>
        {canSend && (
          <button type="button" onClick={() => void errors.send(id)}>
            <Send size={13} />
            {t(status === "failed" ? "errors.retry" : "errors.send")}
          </button>
        )}
        <button type="button" onClick={() => workbench.saveErrorReport(id)}>
          <Download size={13} />
          {t("diagnostics.save")}
        </button>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? "errors.hide" : "errors.show")}
        </button>
      </div>
      {open && (
        <pre aria-label={t("errors.content")} tabIndex={0}>
          {JSON.stringify(error.report, undefined, 2)}
        </pre>
      )}
    </li>
  );
}

/** What went wrong since the page opened, and what became of each report. */
export function ErrorList() {
  const { errors } = useWorkbench();
  const { t } = useTranslation();
  const { errors: caught } = useSyncExternalStore(errors.subscribe, errors.getSnapshot);
  return (
    <section className={styles.errors} aria-label={t("errors.title")}>
      <h3>{t("errors.heading", { count: caught.length })}</h3>
      {caught.length === 0 ? (
        <p className={styles.quiet}>{t("errors.none")}</p>
      ) : (
        <ul>
          {caught.map((error) => (
            <ErrorRow key={error.id} error={error} />
          ))}
        </ul>
      )}
    </section>
  );
}
