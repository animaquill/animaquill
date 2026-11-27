import type { Conversation } from "@animaquill/agent";
import { Copy, GitBranchPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import { Markdown } from "../markdown/Markdown.tsx";
import { RefChip } from "../RefChip.tsx";
import { plainOf } from "../refs.ts";
import { liveText, useLive } from "../useLive.ts";
import styles from "./turn.module.css";
import { useCopy } from "./UserBubble.tsx";

/** A link of the editor in what AI wrote: a block, as in people's words. */
const appLink = (href: string, label: string) => <RefChip chatRef={{ href, label }} />;

/**
 * The answer of a turn, the largest words of the chat (docs/design/chat-panel.md of AnimaQuill
 * Cloud, 5.4, 5.6), and on hovering it copying it and a new conversation from here, which goes on
 * after this turn.
 */
export function AnswerView(props: {
  readonly text: string;
  readonly task: string;
  readonly busy: boolean;
  readonly onForked: () => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const copy = useCopy();
  return (
    <div className={styles.answerWrap}>
      <div className={styles.answer} data-testid="chat-answer">
        <Markdown text={props.text} renderAppLink={appLink} />
      </div>
      <div className={styles.answerActions}>
        <Tip name={t("chat.answer.copy")} usage="">
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("chat.answer.copy")}
            data-testid="chat-answer-copy"
            onClick={() => copy(plainOf(props.text))}
          >
            <Copy size={13} aria-hidden />
          </button>
        </Tip>
        <Tip name={t("chat.answer.fork")} usage="">
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("chat.answer.fork")}
            data-testid="chat-answer-fork"
            disabled={props.busy}
            onClick={() => {
              chat.fork(props.task, "after");
              props.onForked();
            }}
          >
            <GitBranchPlus size={13} aria-hidden />
          </button>
        </Tip>
      </div>
    </div>
  );
}

/** The answer on its way, as Markdown that parses only its last block again. */
export function LiveAnswer({ conversation }: { readonly conversation: Conversation }) {
  const text = useLive(conversation.live, liveText);
  if (text === "") return null;
  return (
    <div className={styles.answer} data-testid="chat-live" aria-live="polite">
      <Markdown text={text} streaming renderAppLink={appLink} />
      <span className={styles.caret} aria-hidden />
    </div>
  );
}
