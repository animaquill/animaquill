import type { Conversation, RunningTask } from "@animaquill/agent";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import type { Say } from "./toolSummary.ts";
import { durationText } from "./turns.ts";
import { livePhase, useLive } from "./useLive.ts";

/** How long without a word from the service before the chat says it went quiet. */
export const QUIET_MS = 60_000;

/** The status code a failure has in its words, such as 429. */
const codeIn = (message: string) => /\b(429|5\d\d)\b/.exec(message)?.[1];

/**
 * What the task does now, in one line above the input, with how long the turn runs: waiting for the
 * model, thinking, writing, running a tool, or waiting to try again after a busy service. When the
 * service says nothing for a minute while no tool runs, it says so, with a way to wait on or stop.
 */
export function RunState({
  conversation,
  running,
}: {
  readonly conversation: Conversation;
  readonly running: RunningTask;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const now = useNow(true);
  const phase = useLive(conversation.live, livePhase);
  const [waitedOn, setWaitedOn] = useState(0);
  const { tool, retry } = running;
  let label: string;
  if (retry) {
    const code = codeIn(retry.failure.message);
    const reason = say(`chat.retryReason.${retry.failure.kind}`);
    label = t("chat.phase.retry", {
      reason: code ? `${reason}（${code}）` : reason,
      attempt: retry.attempt,
      of: retry.of,
      seconds: Math.max(0, Math.ceil((retry.at - now) / 1000)),
    });
  } else if (tool) {
    const name = say(`chat.tool.${tool.name}`, { defaultValue: tool.name });
    const operations = Array.isArray(tool.args.operations) ? tool.args.operations.length : 0;
    label =
      tool.name === "aq_edit" && operations > 0
        ? t("chat.phase.toolOps", { name, count: operations })
        : t("chat.phase.tool", { name });
  } else {
    label = say(`chat.phase.${phase}`);
  }
  const heard = Math.max(conversation.live.getState().heardAt, waitedOn);
  const quiet = !tool && !retry && heard > 0 && now - heard >= QUIET_MS;
  return (
    <div
      className={styles.phase}
      data-testid="chat-phase"
      data-state={retry ? "retry" : quiet ? "quiet" : "running"}
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      {quiet ? (
        <>
          <span className={styles.phaseText}>
            {t("chat.phase.quiet", { seconds: Math.floor((now - heard) / 1000) })}
          </span>
          <button type="button" onClick={() => setWaitedOn(Date.now())}>
            {t("chat.phase.keepWaiting")}
          </button>
          <button type="button" onClick={() => conversation.stop()}>
            {t("chat.stop")}
          </button>
        </>
      ) : (
        <span className={styles.phaseText}>{label}</span>
      )}
      <span className={styles.phaseTime}>{durationText(say, now - running.startedAt)}</span>
    </div>
  );
}
