import type { ToolEntry } from "@animaquill/agent";
import { aiTask } from "@animaquill/core";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ChangesView } from "./ChangeCard.tsx";
import styles from "./ChatPanel.module.css";
import type { PendingApproval } from "./session.ts";
import { placesOf, summaryOf } from "./summary.ts";

/**
 * The change a task waits to make while people want to be asked first ("AI 改项目前先问我", S-D4),
 * under the steps of the task: the card of changes as it would be once written, each line opening
 * to before and after as on that card, and three answers. The first change of the task that waits;
 * the next one shows once this one is answered.
 */
export function TaskApproval({ task }: { readonly task: string }) {
  const { chat } = useWorkbench();
  const { approvals } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const pending = approvals.find((each) => each.task === task);
  return pending ? <ApprovalCard key={pending.id} pending={pending} /> : null;
}

function ApprovalCard({ pending }: { readonly pending: PendingApproval }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const { request, task, id } = pending;
  // As the card of the task will say it once written: from what the tool tells of the change.
  const summary = useMemo(() => {
    const told: ToolEntry = {
      role: "tool",
      call: id,
      name: request.tool,
      ok: true,
      text: "",
      at: 0,
      data: { changes: request.changes, ...(request.summary && { summary: request.summary }) },
    };
    return summaryOf([told]);
  }, [id, request]);
  const seen = useMemo(() => ({ before: request.before, after: request.after }), [request]);
  const title = t("chat.approve.title", { count: placesOf(summary) });
  return (
    <div
      className={`${styles.card} ${styles.approve}`}
      data-testid="chat-approve"
      role="group"
      aria-label={title}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{title}</span>
      </div>
      <ChangesView
        task={task}
        said={summary.said}
        changes={summary.changes}
        seen={seen}
        origin={`${aiTask(task)}#ask#${id}`}
      />
      <div className={styles.approveActions}>
        <button
          type="button"
          className={styles.primary}
          data-testid="chat-approve-once"
          onClick={() => chat.answerApproval(id, "once")}
        >
          {t("chat.approve.once")}
        </button>
        <button
          type="button"
          data-testid="chat-approve-task"
          onClick={() => chat.answerApproval(id, "task")}
        >
          {t("chat.approve.task")}
        </button>
        <button
          type="button"
          data-testid="chat-approve-no"
          onClick={() => chat.answerApproval(id, "no")}
        >
          {t("chat.approve.no")}
        </button>
      </div>
    </div>
  );
}
