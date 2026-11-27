import type { Conversation, RunningTask, TaskOutcome } from "@animaquill/agent";
import { failureOf } from "@animaquill/agent";
import { ChevronRight, PenLine } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { TaskApproval } from "./ApprovalCard.tsx";
import { ChangeCard } from "./ChangeCard.tsx";
import styles from "./ChatPanel.module.css";
import { useOpened } from "./expanded.ts";
import { planOf, plansIn } from "./plan.ts";
import { PlanCard } from "./PlanCard.tsx";
import { plainOf } from "./refs.ts";
import { placesOf, summaryOf } from "./summary.ts";
import type { Names } from "./toolSummary.ts";
import type { Turn } from "./turns.ts";
import { AnswerView, LiveAnswer } from "./turn/AnswerView.tsx";
import { FailureCard } from "./turn/FailureCard.tsx";
import turnStyles from "./turn/turn.module.css";
import { UserBubble } from "./turn/UserBubble.tsx";
import { WorkLine } from "./turn/WorkLine.tsx";

/**
 * One turn of the chat (docs/design/chat-panel.md of AnimaQuill Cloud, 5): what people said; the
 * work of AI in one line, open to its steps (`WorkLine`), which says what it does while it runs;
 * the answer, the largest words of the chat, on its way while it runs; how it ended where that
 * calls for a word, a failure as a card of what to do; and the card of what it changed. A turn
 * people edited and sent again folds into one line under the new one, open to all of it.
 */
export function TurnView(props: {
  readonly turn: Turn;
  readonly running: RunningTask | undefined;
  /** A task of the conversation runs, this one or another. */
  readonly busy: boolean;
  readonly conversation: Conversation;
  readonly outcome: TaskOutcome | undefined;
  /** It is the newest task, which can be tried again, go on, or have its question answered. */
  readonly latest: boolean;
  readonly maxToolCalls: number;
  /** The line before an answer that had another model pack than the one before it. */
  readonly switches: readonly string[];
  readonly names: Names;
  readonly modelName: (model: string) => string;
  /** People edited its message and sent it again, as a later turn. */
  readonly rewritten: boolean;
  /** A new conversation was copied from this turn. */
  readonly onForked: () => void;
}) {
  const [open, setOpen] = useOpened(`${props.turn.task}/rewritten`, false);
  if (!props.rewritten) return <TurnBody {...props} />;
  return (
    <div
      className={`${styles.task} ${turnStyles.fold}`}
      data-testid="chat-task"
      data-task={props.turn.task}
      data-rewritten=""
    >
      <RewrittenLine turn={props.turn} open={open} onToggle={() => setOpen(!open)} />
      {open && <TurnBody {...props} inner />}
    </div>
  );
}

/** The one line of a turn sent again edited: what it was, and whether its changes still stand. */
function RewrittenLine(props: {
  readonly turn: Turn;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const workbench = useWorkbench();
  const { chat } = workbench;
  const { t } = useTranslation();
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  const places = placesOf(summaryOf(props.turn.entries));
  const kept = places > 0 && chat.undoState(props.turn.task) === "undo";
  return (
    <button
      type="button"
      className={turnStyles.rewritten}
      aria-expanded={props.open}
      data-testid="chat-rewritten"
      onClick={props.onToggle}
    >
      <PenLine size={12} aria-hidden />
      <span className={turnStyles.rewrittenText}>
        {t("chat.user.rewritten")}
        {kept && ` · ${t("chat.user.rewrittenKept", { count: places })}`}
      </span>
      {/* Which message it was: its first words, the rest when it opens. */}
      <span className={turnStyles.rewrittenWords} aria-hidden>
        {plainOf(props.turn.user.text)}
      </span>
      <ChevronRight size={12} aria-hidden className={turnStyles.rewrittenChevron} />
    </button>
  );
}

function TurnBody({
  turn,
  running,
  busy,
  conversation,
  outcome,
  latest,
  maxToolCalls,
  switches,
  names,
  modelName,
  onForked,
  inner = false,
}: Parameters<typeof TurnView>[0] & { readonly inner?: boolean }) {
  const shown = outcome ?? (running ? undefined : keptOutcome(turn));
  const question = latest && !running ? questionOf(turn) : undefined;
  const body = (
    <>
      <UserBubble turn={turn} latest={latest} busy={busy} onForked={onForked} />
      {(running || turn.steps.length > 0 || turn.answerEntry || shown?.end === "stopped") && (
        <WorkLine
          turn={turn}
          running={running}
          conversation={conversation}
          stopped={shown?.end === "stopped"}
          names={names}
          switches={switches}
          modelName={modelName}
        />
      )}
      {running && <LiveAnswer conversation={conversation} />}
      {running && <TaskApproval task={turn.task} />}
      {turn.answer !== undefined && (
        <AnswerView text={turn.answer} task={turn.task} busy={busy} onForked={onForked} />
      )}
      {shown?.end === "failed" && (
        <FailureCard
          outcome={{ ...shown, end: "failed" }}
          task={turn.task}
          latest={latest}
          changed={placesOf(summaryOf(turn.entries))}
          pictures={(turn.user.images?.length ?? 0) > 0}
        />
      )}
      {shown && (shown.end === "limit" || shown.end === "length") && (
        <OutcomeLine end={shown.end} latest={latest} maxToolCalls={maxToolCalls} />
      )}
      {question && <QuestionView question={question} />}
      <TurnPlan turn={turn} conversation={conversation} busy={busy} running={running} />
      <ChangeCard task={turn.task} entries={turn.entries} running={running !== undefined} />
    </>
  );
  if (inner) return <div className={turnStyles.rewrittenBody}>{body}</div>;
  return (
    <div
      className={styles.task}
      data-testid="chat-task"
      data-task={turn.task}
      data-running={running ? "" : undefined}
    >
      {body}
    </div>
  );
}

/** A turn that ended at the limit of tools, or with its answer cut short: one line, and going on. */
function OutcomeLine(props: {
  readonly end: "limit" | "length";
  readonly latest: boolean;
  readonly maxToolCalls: number;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  return (
    <p
      className={turnStyles.outcome}
      data-testid={props.end === "limit" ? "chat-limit" : "chat-length"}
    >
      <span>
        {props.end === "limit" ? t("chat.limit", { count: props.maxToolCalls }) : t("chat.length")}
      </span>
      {props.latest && (
        <>
          {" · "}
          <button
            type="button"
            className={styles.link}
            onClick={() => void chat.send(t("chat.continueMessage"))}
          >
            {t("chat.continue")}
          </button>
        </>
      )}
    </p>
  );
}

/**
 * How an earlier task ended, as far as what was kept says: only a failure or a stop leave a mark.
 * The limit of tools does not, as its answer looks like any other.
 */
function keptOutcome(turn: Turn): TaskOutcome | undefined {
  const last = turn.entries.findLast((entry) => entry.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  if (last.end === "stopped") return { task: turn.task, end: "stopped" };
  if (last.end === "failed") {
    return { task: turn.task, end: "failed", failure: failureOf(last.error ?? "") };
  }
  return undefined;
}

/** The plan of a turn, where AI gave one (`aq_propose` kind "plan"), see `PlanCard`. */
function TurnPlan(props: {
  readonly turn: Turn;
  readonly conversation: Conversation;
  readonly busy: boolean;
  readonly running: RunningTask | undefined;
}) {
  const { turn } = props;
  const given = turn.entries.findLast(
    (entry) => entry.role === "tool" && planOf(entry) !== undefined,
  );
  if (given?.role !== "tool" || props.running) return null;
  const plan = planOf(given);
  const state = plansIn(props.conversation.getSnapshot().entries).get(given.call);
  if (!plan || !state) return null;
  return (
    <PlanCard
      call={given.call}
      plan={plan}
      state={state}
      timeline={turn.user.selection?.timeline}
      busy={props.busy}
    />
  );
}

/** A question AI asked with aq_propose, which the newest task can still have answered. */
interface Question {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly other: boolean;
}

function questionOf(turn: Turn): Question | undefined {
  const asked = turn.entries.findLast(
    (entry) => entry.role === "tool" && entry.name === "aq_propose" && entry.ok,
  );
  const data = asked?.role === "tool" ? asked.data?.question : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { question, options, allow_other: other } = data as Record<string, unknown>;
  if (typeof question !== "string" || !Array.isArray(options)) return undefined;
  const choices = options.flatMap((option: Record<string, unknown>) =>
    typeof option?.label === "string"
      ? [
          {
            label: option.label,
            ...(typeof option.detail === "string" && { detail: option.detail }),
          },
        ]
      : [],
  );
  return { question, options: choices, other: other !== false };
}

/** The question of AI, with its answers to pick: the pick goes as the next message. */
function QuestionView({ question }: { readonly question: Question }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.question} data-testid="chat-question" role="group">
      <div className={styles.muted}>{t("chat.question.title")}</div>
      <p className={styles.text}>{question.question}</p>
      <div className={styles.options}>
        {question.options.map(({ label, detail }) => (
          <button key={label} type="button" title={detail} onClick={() => void chat.send(label)}>
            {label}
            {detail && <span className={styles.muted}> · {detail}</span>}
          </button>
        ))}
      </div>
      {question.other && <p className={styles.muted}>{t("chat.question.other")}</p>}
    </div>
  );
}
