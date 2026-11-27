import { MessageCircleQuestion } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import type { Question } from "./question.ts";
import { WaitCard } from "./WaitCard.tsx";
import styles from "./wait.module.css";

/**
 * A question of AI (docs/design/chat-panel.md of AnimaQuill Cloud, 6.2): what it asks, and its
 * answers in a row, what each means on hovering. A pick goes as the next message; people can also
 * answer in the box of the chat, which says so. With the focus on the card, ← and → go from answer
 * to answer, Enter sends the one that has it.
 */
export function QuestionCard({ question }: { readonly question: Question }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-question-option"]',
      ),
    ];
    if (options.length === 0) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next =
      at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length;
    event.preventDefault();
    options[next]?.focus();
  };
  return (
    <WaitCard
      kind="question"
      icon={<MessageCircleQuestion size={13} aria-hidden />}
      title={t("chat.question.title")}
      said={`${t("chat.question.title")}：${question.question}`}
      testId="chat-question"
      onKeyDown={onKeyDown}
    >
      <p className={styles.question}>{question.question}</p>
      <div className={styles.options} role="group" aria-label={question.question}>
        {question.options.map(({ label, detail }) => {
          const button = (
            <button
              key={label}
              type="button"
              className={`${styles.button} ${styles.option}`}
              data-testid="chat-question-option"
              onClick={() => void chat.send(label)}
            >
              {label}
              {/* What it means: on hovering, and for those who listen with it. */}
              {detail && <span className={styles.srOnly}>：{detail}</span>}
            </button>
          );
          return detail ? (
            <Tip key={label} name={detail} usage="">
              {button}
            </Tip>
          ) : (
            button
          );
        })}
      </div>
    </WaitCard>
  );
}
