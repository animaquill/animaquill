import type { ToolEntry } from "@animaquill/agent";
import { aiTask } from "@animaquill/core";
import { ShieldQuestion } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { ChangesView } from "../ChangeCard.tsx";
import type { PendingApproval } from "../session.ts";
import { placesOf, summaryOf } from "../summary.ts";
import { useChatUi } from "../ui.ts";
import { WaitCard } from "./WaitCard.tsx";

/**
 * The change a task waits to make while people want to be asked first ("AI 改项目前先问我", S-D4;
 * docs/design/chat-panel.md of AnimaQuill Cloud, 6.1), the last thing of its turn: each place as it
 * would be once written, each row opening to before and after as on the card of changes, and three
 * answers: not allowed (Esc), all of this turn, allowed (Enter). What people type meanwhile in the
 * box of the chat does not allow it and goes to AI with it (`ChatSession.declineWith`). The first
 * change of the task that waits; the next one shows once this one is answered.
 */
export function TaskApproval({ task }: { readonly task: string }) {
  const { chat } = useWorkbench();
  const { approvals } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const pending = approvals.find((each) => each.task === task);
  return pending ? <ApprovalCard key={pending.id} pending={pending} /> : null;
}

function ApprovalCard({ pending }: { readonly pending: PendingApproval }) {
  const { chat } = useWorkbench();
  const ui = useChatUi();
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
  return (
    <WaitCard
      kind="approve"
      icon={<ShieldQuestion size={13} aria-hidden />}
      title={t("chat.approve.title", { count: placesOf(summary) })}
      testId="chat-approve"
      onKeyDown={(event) => {
        // Words typed at the card go to the box, where they do not allow it and go to AI.
        const typed = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (typed && event.target === event.currentTarget) ui.focusInput();
      }}
      actions={[
        {
          id: "chat-approve-no",
          label: t("chat.approve.no"),
          keys: "Escape",
          onAct: () => chat.answerApproval(id, "no"),
        },
        {
          id: "chat-approve-task",
          label: t("chat.approve.task"),
          onAct: () => chat.answerApproval(id, "task"),
        },
        {
          id: "chat-approve-once",
          label: t("chat.approve.once"),
          primary: true,
          keys: "Enter",
          onAct: () => chat.answerApproval(id, "once"),
        },
      ]}
    >
      <ChangesView
        task={task}
        said={summary.said}
        changes={summary.changes}
        seen={seen}
        origin={`${aiTask(task)}#ask#${id}`}
      />
    </WaitCard>
  );
}
