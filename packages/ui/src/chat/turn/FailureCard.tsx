import type { TaskOutcome } from "@animaquill/agent";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { failureText } from "../failure.ts";
import { useChatUi } from "../ui.ts";
import styles from "./turn.module.css";

/**
 * A turn that failed (docs/design/chat-panel.md of AnimaQuill Cloud, 7 "出错"): a red card with one
 * sentence of what went wrong and the way out of that very kind on buttons, what the service said
 * folded away. Only the newest turn has buttons. Tried again after it changed something, the
 * buttons become, in their place, taking that back first or going on from it.
 */
export function FailureCard({
  outcome,
  task,
  latest,
  changed,
  pictures,
}: {
  readonly outcome: TaskOutcome & { readonly end: "failed" };
  readonly task: string;
  readonly latest: boolean;
  /** How many places the task changed so far, which trying again goes on from. */
  readonly changed: number;
  /** The message had pictures, which the service may not have taken. */
  readonly pictures: boolean;
}) {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const ui = useChatUi();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [asking, setAsking] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) first.current?.focus();
  }, [asking]);
  const service = chat.modelNow()?.service;
  const { advice, detail, relay } = failureText(t, outcome.failure, {
    relayed: outcome.relayed === true,
    canRelay: ai.canRelay,
    service: service?.name,
  });
  const kind = relay ? "relay" : (outcome.failure?.kind ?? "other");
  const retry = () => {
    if (changed > 0 && chat.undoState(task) === "undo") setAsking(true);
    else void chat.retry();
  };
  // Straight to a service the browser could not reach: through the relay of the platform instead.
  const canUseRelay =
    kind === "network" &&
    ai.canRelay &&
    outcome.relayed !== true &&
    service !== undefined &&
    service.route !== "relay";
  const retryButton = (main: boolean) => (
    <button
      type="button"
      className={main ? styles.primary : undefined}
      data-testid="chat-failure-retry"
      onClick={retry}
    >
      {t("chat.failure.retry")}
    </button>
  );
  const actions = () => {
    switch (kind) {
      case "contextFull":
        // Too long for its model even with room made: a new conversation goes on from its summary.
        return (
          <button
            type="button"
            className={styles.primary}
            data-testid="chat-fresh"
            onClick={() => chat.continueFresh()}
          >
            {t("chat.failure.fresh")}
          </button>
        );
      case "key":
        return (
          <>
            <button
              type="button"
              className={styles.primary}
              data-testid="chat-failure-key"
              onClick={() =>
                workbench.openSettings({ group: "models", depth: 2, service: service?.id })
              }
            >
              {t("chat.failure.key")}
            </button>
            {retryButton(false)}
          </>
        );
      case "notFound":
        return (
          <>
            <button
              type="button"
              className={styles.primary}
              data-testid="chat-failure-model"
              onClick={() => ui.openModels()}
            >
              {t("chat.failure.otherModel")}
            </button>
            {retryButton(false)}
          </>
        );
      case "network":
        return canUseRelay ? (
          <>
            <button
              type="button"
              className={styles.primary}
              data-testid="chat-failure-relay"
              onClick={() => {
                ai.update(service.id, { route: "relay" });
                retry();
              }}
            >
              {t("chat.failure.useRelay")}
            </button>
            {retryButton(false)}
          </>
        ) : (
          retryButton(true)
        );
      default:
        return (
          <>
            {retryButton(true)}
            {/* What a service says of pictures it does not take is no failure of its own kind. */}
            {pictures && (kind === "other" || kind === "server") && (
              <button
                type="button"
                data-testid="chat-resend-without-pictures"
                onClick={() => void chat.resendWithoutPictures()}
              >
                {t("chat.failure.withoutPictures")}
              </button>
            )}
          </>
        );
    }
  };
  return (
    <div className={styles.failure} role="alert" data-testid="chat-failure" data-kind={kind}>
      <p className={styles.failureText}>
        <CircleAlert size={14} aria-hidden className={styles.failureIcon} />
        <span>{advice}</span>
      </p>
      {latest &&
        (asking ? (
          <div className={styles.failureActions} role="group" data-testid="chat-retry-confirm">
            <button
              ref={first}
              type="button"
              className={styles.primary}
              onClick={() => {
                setAsking(false);
                void chat.undoTask(task).then(() => chat.retry());
              }}
            >
              {t("chat.failure.undoThenRetry", { count: changed })}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void chat.retry();
              }}
            >
              {t("chat.failure.retryOn")}
            </button>
            <button type="button" className={styles.ghost} onClick={() => setAsking(false)}>
              {t("chat.failure.cancel")}
            </button>
          </div>
        ) : (
          <div className={styles.failureActions}>{actions()}</div>
        ))}
      {detail && (
        <details className={styles.failureDetail}>
          <summary>
            {t("chat.failure.details")}
            <ChevronRight size={11} aria-hidden className={styles.failureChevron} />
          </summary>
          <p>{detail}</p>
        </details>
      )}
    </div>
  );
}
