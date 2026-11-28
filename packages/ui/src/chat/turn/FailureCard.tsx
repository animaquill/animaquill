import type { TaskOutcome } from "@animaquill/agent";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  // Another tab has the conversation: here it is only to read.
  const elsewhere = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().elsewhere);
  // Trying again after the task changed something asks first: take that back, or keep it. With
  // the relay, the service goes through it only once people chose.
  const [asking, setAsking] = useState<"retry" | "relay">();
  const first = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const backToRetry = useRef(false);
  useEffect(() => {
    if (asking) first.current?.focus();
    else if (backToRetry.current) {
      backToRetry.current = false;
      card.current?.querySelector<HTMLElement>('[data-testid="chat-failure-retry"]')?.focus();
    }
  }, [asking]);
  const service = chat.modelNow()?.service;
  const { advice, detail, reason, refusal } = failureText(t, outcome.failure, {
    relayed: outcome.relayed === true,
    canRelay: ai.canRelay,
    service: service?.name,
  });
  const throughRelay = () => {
    if (service) ai.update(service.id, { route: "relay" });
  };
  const retry = (how: "retry" | "relay" = "retry") => {
    if (changed > 0 && chat.undoState(task) === "undo") {
      setAsking(how);
      return;
    }
    if (how === "relay") throughRelay();
    void chat.retry();
  };
  const settings = () =>
    workbench.openSettings({ group: "models", depth: 2, service: service?.id });
  // Straight to a service the browser could not reach: through the relay of the platform instead.
  const canUseRelay =
    reason === "network" &&
    ai.canRelay &&
    outcome.relayed !== true &&
    service !== undefined &&
    service.route !== "relay";
  const button = (id: string, label: string, run: () => void, main = false) => (
    <button
      key={id}
      type="button"
      className={main ? styles.primary : undefined}
      data-testid={id}
      onClick={run}
    >
      {label}
    </button>
  );
  const retryButton = (main: boolean) =>
    button("chat-failure-retry", t("chat.failure.retry"), () => retry(), main);
  const otherModel = (main: boolean) =>
    button("chat-failure-model", t("chat.failure.otherModel"), () => ui.openModels(), main);
  const actions = (): readonly ReactNode[] => {
    switch (reason) {
      case "contextFull":
        // Too long for its model even with room made: a new conversation goes on from its summary.
        return [button("chat-fresh", t("chat.failure.fresh"), () => chat.continueFresh(), true)];
      case "key":
        return [
          button("chat-failure-key", t("chat.failure.key"), settings, true),
          retryButton(false),
        ];
      case "notFound":
      case "quota":
        return [otherModel(true), retryButton(false)];
      case "rate":
      case "server":
        return [retryButton(true), otherModel(false)];
      case "network":
        return canUseRelay
          ? [
              button("chat-failure-relay", t("chat.failure.useRelay"), () => retry("relay"), true),
              retryButton(false),
            ]
          : [retryButton(true), otherModel(false)];
      case "relay":
        // What the relay refused, and the one thing that helps, as the line over the box has it.
        if (refusal === "signedOut" && workbench.account)
          return [
            button(
              "chat-failure-sign-in",
              t("chat.failure.signIn"),
              () => void workbench.signIn(),
              true,
            ),
            retryButton(false),
          ];
        if (
          refusal === "badTarget" ||
          refusal === "unreachable" ||
          refusal === "redirect" ||
          refusal === "blocked"
        )
          return [
            button("chat-failure-address", t("chat.failure.checkAddress"), settings, true),
            retryButton(false),
          ];
        if (refusal === "off" && service)
          return [
            button(
              "chat-failure-direct",
              t("chat.failure.useDirect"),
              () => {
                ai.update(service.id, { route: "direct" });
                retry();
              },
              true,
            ),
            retryButton(false),
          ];
        return [retryButton(true)];
      default:
        return [
          retryButton(true),
          otherModel(false),
          // What a service says of pictures it does not take is no failure of its own kind.
          ...(pictures
            ? [
                button(
                  "chat-resend-without-pictures",
                  t("chat.failure.withoutPictures"),
                  () => void chat.resendWithoutPictures(),
                ),
              ]
            : []),
        ];
    }
  };
  return (
    <div
      className={styles.failure}
      role="alert"
      data-testid="chat-failure"
      ref={card}
      data-kind={reason}
      data-refusal={refusal}
    >
      <p className={styles.failureText}>
        <CircleAlert size={14} aria-hidden className={styles.failureIcon} />
        <span>{advice}</span>
      </p>
      {latest &&
        !elsewhere &&
        (asking ? (
          <div className={styles.failureActions} role="group" data-testid="chat-retry-confirm">
            <button
              ref={first}
              type="button"
              className={styles.primary}
              onClick={() => {
                if (asking === "relay") throughRelay();
                setAsking(undefined);
                void chat.undoTask(task).then(() => chat.retry());
              }}
            >
              {t("chat.failure.undoThenRetry", { count: changed })}
            </button>
            <button
              type="button"
              onClick={() => {
                if (asking === "relay") throughRelay();
                setAsking(undefined);
                void chat.retry();
              }}
            >
              {t("chat.failure.retryOn")}
            </button>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => {
                backToRetry.current = true;
                setAsking(undefined);
              }}
            >
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
