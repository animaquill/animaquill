import type { MessageFrom } from "@animaquill/agent";
import { MessageSquareShare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { useOpened } from "../expanded.ts";
import styles from "./turn.module.css";

/**
 * A message of another conversation of the project, or an AI tool on this computer
 * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 4): on the left, unlike what people said, with
 * who sent it on top, a click away from that conversation. It is no message of people's: there is
 * nothing to edit or send again.
 */
export function AgentBubble({ from, text }: { readonly from: MessageFrom; readonly text: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.agentWrap} data-testid="chat-agent-message" data-from={from.id}>
      <div className={styles.agentHead}>
        <MessageSquareShare size={12} aria-hidden />
        <Sender from={from} label={from.idle ? "chat.agents.idleFrom" : "chat.agents.from"} />
      </div>
      <div className={styles.agentText}>{text || t("chat.agents.nothingSaid")}</div>
    </div>
  );
}

/** Who sent it, by name: a conversation opens; an AI tool is only named. */
function Sender({
  from,
  label,
}: {
  readonly from: MessageFrom;
  readonly label: "chat.agents.idleFrom" | "chat.agents.from";
}) {
  const { chat, layout } = useWorkbench();
  const { t } = useTranslation();
  const text = t(label, { name: from.name, interpolation: { escapeValue: false } });
  if (from.kind === "tool") return <span>{text}</span>;
  return (
    <button
      type="button"
      className={styles.agentName}
      title={t("chat.agents.open")}
      onClick={() => {
        layout.openPanel("chat");
        void chat.open(from.id);
      }}
    >
      {text}
    </button>
  );
}

/** A message the task read on its way, as a step: who sent it, open to all of it. */
export function MessageStep({
  id,
  from,
  text,
}: {
  readonly id: string;
  readonly from: MessageFrom;
  readonly text: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useOpened(id, false);
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className={styles.step} data-testid="chat-message-step">
      <button
        type="button"
        className={styles.stepHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MessageSquareShare size={12} aria-hidden className={styles.stepIcon} />
        <span className={styles.stepName}>
          {t(from.idle ? "chat.agents.readIdle" : "chat.agents.read", {
            name: from.name,
            interpolation: { escapeValue: false },
          })}
        </span>
        {!open && <span className={styles.stepSummary}>{first}</span>}
      </button>
      {open && <div className={styles.stepBody}>{text}</div>}
    </div>
  );
}
