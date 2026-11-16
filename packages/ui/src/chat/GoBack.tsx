import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { Tip } from "../app/Tip.tsx";
import { commandFailedText } from "../i18n/failures.ts";
import styles from "./ChatPanel.module.css";
import type { BackOutcome, BackPlan } from "./session.ts";

/** What "back to before this turn" shows under the message: the list, then what came of it. */
export type GoingBack =
  | { readonly plan: BackPlan }
  | { readonly outcome: Extract<BackOutcome, { done: true }>; readonly plan: BackPlan };

/**
 * The list of what going back to before a turn takes back, a line for each turn, and what came of
 * it once it went, with the way to do it all again. Not a dialog: it opens under the message, as
 * asking before sending again does.
 */
export function GoBack({
  going,
  running,
  onChange,
  onClose,
}: {
  readonly going: GoingBack;
  /** A task runs: nothing goes back or comes again until it is done. */
  readonly running: boolean;
  readonly onChange: (going: GoingBack) => void;
  readonly onClose: () => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const { plan } = going;

  if ("outcome" in going) {
    const { outcome } = going;
    return (
      <div className={styles.goBackDone} data-testid="chat-back-done">
        {outcome.failed ? (
          <Tip name={commandFailedText(t, outcome.failed.error)} usage="">
            <span tabIndex={0}>
              {t("chat.back.donePartly", { count: outcome.places, turn: outcome.failed.turn })}
            </span>
          </Tip>
        ) : (
          <span>{t("chat.back.done", { count: outcome.places })}</span>
        )}
        {outcome.taken.length > 0 && (
          <button
            type="button"
            className={styles.link}
            disabled={busy || running}
            onClick={() => {
              setBusy(true);
              void chat.redoBack(outcome.taken).finally(() => {
                setBusy(false);
                onClose();
              });
            }}
          >
            {t("chat.back.redo")}
          </button>
        )}
      </div>
    );
  }

  const turns = plan.rows.filter((row) => row.whyNot === undefined);
  return (
    <div className={styles.goBack} data-testid="chat-back">
      <p className={styles.goBackTitle}>
        {plan.places > 0
          ? t("chat.back.title", { turns: turns.length, count: plan.places })
          : t("chat.back.nothing")}
      </p>
      <ul className={styles.goBackRows}>
        {plan.rows.map((row) => (
          <li
            key={row.task}
            className={row.whyNot ? styles.goBackOff : undefined}
            aria-disabled={row.whyNot ? true : undefined}
            data-testid="chat-back-row"
          >
            <span className={styles.goBackLabel}>{chat.labelOf(row.task) ?? ""}</span>
            <span className={styles.goBackCount}>
              {t("chat.back.places", { count: row.places })}
            </span>
            {row.whyNot && (
              <Tip name={t(`chat.card.whyNot.${row.whyNot}`)} usage="">
                <span className={styles.goBackWhy} tabIndex={0} data-testid="chat-back-why">
                  <Info size={12} aria-label={t(`chat.card.whyNot.${row.whyNot}`)} />
                </span>
              </Tip>
            )}
          </li>
        ))}
      </ul>
      {plan.kept > 0 && (
        <p className={styles.goBackKept}>{t("chat.back.kept", { count: plan.kept })}</p>
      )}
      <div className={styles.goBackActions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || running || plan.places === 0}
          onClick={() => {
            setBusy(true);
            void chat
              .backTo(plan)
              .then((outcome) => {
                if (!outcome) onClose();
                else if (outcome.done) onChange({ outcome, plan });
                else onChange({ plan: outcome.plan });
              })
              .finally(() => setBusy(false));
          }}
        >
          {t("chat.back.go")}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          {t("chat.failure.cancel")}
        </button>
      </div>
    </div>
  );
}
