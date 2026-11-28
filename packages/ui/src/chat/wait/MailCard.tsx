import type { Mail } from "@animaquill/agent";
import { MessageSquareShare } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { MAX_ROUNDS } from "../relay.ts";
import { useSenderName } from "../turn/AgentMessage.tsx";
import { WaitCard } from "./WaitCard.tsx";
import styles from "./wait.module.css";

/**
 * What waits for people from other conversations, at the end of the conversation shown
 * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3 and 4): a message people want to be asked
 * about first ("先问我"), the card of each; and, where it answered others too many turns in a row,
 * the line that says it stopped, with "接着说". Only people's clicks answer these: no tool can.
 */
export function AgentWaits() {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const { mail, paused, conversation } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const running = useSyncExternalStore(
    conversation?.subscribe ?? noop,
    () => conversation?.running === true,
  );
  return (
    <>
      {paused && !running && (
        <p className={styles.paused} data-testid="chat-relay-paused">
          <span>{t("chat.agents.paused", { name: paused.name, count: MAX_ROUNDS })}</span>
          {" · "}
          <button
            type="button"
            className={styles.inlineButton}
            data-testid="chat-relay-go-on"
            onClick={() => chat.goOn()}
          >
            {t("chat.agents.goOn")}
          </button>
        </p>
      )}
      {mail[0] && <MailCard key={mail[0].id} mail={mail[0]} />}
    </>
  );
}

const noop = () => () => {};

function MailCard({ mail }: { readonly mail: Mail }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const name = useSenderName(mail.from);
  const title =
    mail.from.kind === "tool"
      ? t("chat.agents.leftTool", { name: mail.from.name, interpolation: { escapeValue: false } })
      : t("chat.agents.mailTitle", { name, interpolation: { escapeValue: false } });
  return (
    <WaitCard
      kind="question"
      icon={<MessageSquareShare size={13} aria-hidden />}
      title={title}
      said={title}
      testId="chat-mail-card"
      actions={[
        {
          id: "chat-mail-ignore",
          label: t("chat.agents.mailIgnore"),
          keys: "Escape",
          onAct: () => chat.answerMail(mail.id, false),
        },
        {
          id: "chat-mail-read",
          label: t("chat.agents.mailRead"),
          primary: true,
          keys: "Enter",
          onAct: () => chat.answerMail(mail.id, true),
        },
      ]}
    >
      <p className={styles.mailText}>{mail.text}</p>
    </WaitCard>
  );
}
