import type { Conversation, RunningTask, TaskOutcome } from "@animaquill/agent";
import { failureOf } from "@animaquill/agent";
import { ChevronDown, ChevronRight, Lightbulb } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ChangeCard } from "./ChangeCard.tsx";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { useOpened } from "./expanded.ts";
import { failureText } from "./failure.ts";
import { Markdown } from "./markdown/Markdown.tsx";
import { summaryOf } from "./summary.ts";
import { ToolRow } from "./ToolRow.tsx";
import type { Names, Say } from "./toolSummary.ts";
import { durationText, type Step, type Turn } from "./turns.ts";
import { dollars, tokens, usageOf } from "./usage.ts";
import { liveText, liveThinking, liveThinkingSince, useLive } from "./useLive.ts";

/** A thought quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;

/**
 * One turn of the chat: what people said; the process of AI, folded once the turn is done into one
 * line that says how much thinking and how many tools it took (a failed call stays out, open); the
 * answer, as Markdown; the card of what it changed; and a line of what it took. A turn that runs
 * shows each step as it comes and the words on their way.
 */
export function TurnView({
  turn,
  running,
  conversation,
  outcome,
  latest,
  maxToolCalls,
  switches,
  names,
  modelName,
}: {
  readonly turn: Turn;
  readonly running: RunningTask | undefined;
  readonly conversation: Conversation;
  readonly outcome: TaskOutcome | undefined;
  /** It is the newest task, which can be tried again, go on, or have its question answered. */
  readonly latest: boolean;
  readonly maxToolCalls: number;
  /** The line before an answer that had another model pack than the one before it. */
  readonly switches: readonly string[];
  readonly names: Names;
  readonly modelName: (model: string) => string;
}) {
  const shown = outcome ?? (running ? undefined : keptOutcome(turn));
  const question = latest && !running ? questionOf(turn) : undefined;
  return (
    <div className={styles.task} data-testid="chat-task" data-running={running ? "" : undefined}>
      <div className={styles.user} data-testid="chat-user">
        {turn.user.text}
      </div>
      {switches.map((line) => (
        <p key={line} className={styles.muted} data-testid="chat-pack-switch">
          {line}
        </p>
      ))}
      {running ? (
        <>
          {turn.steps.map((step) => (
            <StepView key={step.id} step={step} running={running} names={names} />
          ))}
          <LiveView conversation={conversation} />
        </>
      ) : (
        turn.steps.length > 0 && <ProcessView turn={turn} names={names} />
      )}
      {turn.answer !== undefined && (
        <div className={styles.answer} data-testid="chat-answer">
          <Markdown text={turn.answer} />
        </div>
      )}
      {shown && (
        <OutcomeView
          outcome={shown}
          task={turn.task}
          latest={latest}
          maxToolCalls={maxToolCalls}
          changed={summaryOf(turn.entries).changes.length}
        />
      )}
      {question && <QuestionView question={question} />}
      <ChangeCard task={turn.task} entries={turn.entries} running={running !== undefined} />
      {!running && <UsageLine turn={turn} modelName={modelName} />}
    </div>
  );
}

/** The process of a turn that is done: one line, open to all of it. A failed call shows anyway. */
function ProcessView({ turn, names }: { readonly turn: Turn; readonly names: Names }) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const [open, setOpen] = useOpened(`${turn.task}/process`, false);
  const parts = [
    t("chat.process.title"),
    ...(turn.thoughts > 0 ? [t("chat.process.thinking", { count: turn.thoughts })] : []),
    ...(turn.tools > 0 ? [t("chat.process.tools", { count: turn.tools })] : []),
    ...(turn.failed > 0 ? [t("chat.process.failed", { count: turn.failed })] : []),
    ...(turn.ms !== undefined ? [durationText(say, turn.ms, true)] : []),
  ];
  const failed = turn.steps.filter(
    (step) => step.kind === "tool" && step.result && !step.result.ok,
  );
  return (
    <div className={styles.process} data-testid="chat-process">
      <button
        type="button"
        className={styles.processHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{parts.join(" · ")}</span>
      </button>
      <div className={styles.steps}>
        {(open ? turn.steps : failed).map((step) => (
          <StepView key={step.id} step={step} running={undefined} names={names} />
        ))}
      </div>
    </div>
  );
}

function StepView({
  step,
  running,
  names,
}: {
  readonly step: Step;
  readonly running: RunningTask | undefined;
  readonly names: Names;
}) {
  switch (step.kind) {
    case "thinking":
      return <ThinkingRow id={step.id} text={step.text} ms={step.ms} />;
    case "said":
      return (
        <div className={styles.said} data-testid="chat-said">
          <Markdown text={step.text} />
        </div>
      );
    case "tool":
      return (
        <ToolRow
          call={step.call}
          result={step.result}
          running={running?.tool?.id === step.call.id ? running.tool.startedAt : undefined}
          names={names}
        />
      );
  }
}

/** What the model said of its thinking: its first line and how long, open to all of it. */
function ThinkingRow({
  id,
  text,
  ms,
}: {
  readonly id: string;
  readonly text: string;
  readonly ms: number | undefined;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const [open, setOpen] = useOpened(id, false);
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className={styles.thinking} data-testid="chat-thinking">
      <button
        type="button"
        className={styles.thinkingHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Lightbulb size={12} aria-hidden="true" />
        <span className={styles.thinkingLabel}>{t("chat.thinkingLine")}</span>
        <span className={styles.thinkingFirst}>{first}</span>
        {ms !== undefined && ms >= SHOWN_MS && (
          <span className={styles.toolMs}>{durationText(say, ms, true)}</span>
        )}
      </button>
      {open && <div className={styles.thinkingText}>{text}</div>}
    </div>
  );
}

/**
 * The answer on its way: what the model thinks, by its last line with the time going, and what it
 * writes, as Markdown that parses only its last block again. Only this draws with each piece.
 */
function LiveView({ conversation }: { readonly conversation: Conversation }) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const text = useLive(conversation.live, liveText);
  const thinking = useLive(conversation.live, liveThinking);
  const since = useLive(conversation.live, liveThinkingSince);
  const now = useNow(since !== undefined);
  const last =
    thinking
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1) ?? "";
  return (
    <>
      {thinking.trim() !== "" && (
        <div className={styles.thinking} data-testid="chat-thinking" data-live="">
          <div className={styles.thinkingHead}>
            <Lightbulb size={12} aria-hidden="true" />
            <span className={styles.thinkingLabel}>{t("chat.thinkingLine")}</span>
            <span className={styles.thinkingFirst}>{last}</span>
            {since !== undefined && (
              <span className={styles.toolMs}>{durationText(say, now - since)}</span>
            )}
          </div>
        </div>
      )}
      {text !== "" && (
        <div className={styles.answer} data-testid="chat-live" aria-live="polite">
          <Markdown text={text} streaming />
        </div>
      )}
    </>
  );
}

/** What a turn took, in a line: the model, tokens in and out, the cost, how long. */
function UsageLine({
  turn,
  modelName,
}: {
  readonly turn: Turn;
  readonly modelName: (model: string) => string;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const usage = usageOf(turn.entries);
  if (turn.models.length === 0) return null;
  const names = turn.models.map(modelName);
  const model =
    names.length > 1
      ? t("chat.models", { from: names.slice(0, -1).join(" → "), to: names.at(-1) })
      : names[0];
  const parts = [
    <span key="model" className={styles.usageModel}>
      {model}
    </span>,
    ...(usage.answers > 0
      ? [
          <span
            key="tokens"
            title={t("chat.usage.detail", {
              input: tokens(usage.input),
              output: tokens(usage.output),
              cacheRead: tokens(usage.cacheRead),
              cacheWrite: tokens(usage.cacheWrite),
            })}
          >
            {t("chat.usage.in", { n: tokens(usage.input + usage.cacheRead + usage.cacheWrite) })}{" "}
            {t("chat.usage.out", { n: tokens(usage.output) })}
          </span>,
        ]
      : []),
    ...(usage.cost !== undefined
      ? [
          <span key="cost" className={styles.usageCost}>
            {dollars(usage.cost)}
          </span>,
        ]
      : []),
    ...(turn.ms !== undefined ? [<span key="ms">{durationText(say, turn.ms, true)}</span>] : []),
  ];
  return (
    <p className={styles.usageLine} data-testid="chat-usage">
      {parts}
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

/**
 * How a task ended, where it calls for a word: stopped, at the limit of tools (with a way to go on),
 * cut short, or failed: what to do about it first, then what can be done right here (try again, the
 * settings, another model, the relay), what the service said folded away.
 */
function OutcomeView({
  outcome,
  task,
  latest,
  maxToolCalls,
  changed,
}: {
  readonly outcome: TaskOutcome;
  readonly task: string;
  readonly latest: boolean;
  readonly maxToolCalls: number;
  /** How many places the task changed so far, which trying again goes on from. */
  readonly changed: number;
}) {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  switch (outcome.end) {
    case "stopped":
      return (
        <p className={styles.notice} data-testid="chat-stopped">
          {t("chat.stopped")}
        </p>
      );
    case "limit":
      return (
        <div className={styles.notice} data-testid="chat-limit">
          <span>{t("chat.limit", { count: maxToolCalls })}</span>
          {latest && (
            <button type="button" onClick={() => void chat.send(t("chat.continueMessage"))}>
              {t("chat.continue")}
            </button>
          )}
        </div>
      );
    case "length":
      return <p className={styles.notice}>{t("chat.length")}</p>;
    case "failed": {
      const { advice, detail } = failureText(t, outcome.failure, {
        relayed: outcome.relayed === true,
        canRelay: ai.canRelay,
      });
      const kind = outcome.failure?.kind ?? "other";
      const service = ai.defaultModel()?.service;
      const settings = () =>
        workbench.openSettings({ page: "models", depth: 2, service: service?.id });
      const relay =
        kind === "network" &&
        ai.canRelay &&
        outcome.relayed !== true &&
        service !== undefined &&
        service.route !== "relay";
      const retry = () => {
        if (changed > 0 && chat.undoState(task) === "undo") setAsking(true);
        else void chat.retry();
      };
      return (
        <div className={styles.failure} role="alert" data-testid="chat-failure">
          <p>{advice}</p>
          {latest && (
            <div className={styles.actions}>
              {(kind === "key" || kind === "notFound") && (
                <button type="button" className={styles.primary} onClick={settings}>
                  {t("chat.failure.settings")}
                </button>
              )}
              {relay && (
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => {
                    ai.update(service.id, { route: "relay" });
                    void chat.retry();
                  }}
                >
                  {t("chat.failure.useRelay")}
                </button>
              )}
              <button type="button" onClick={retry}>
                {t("chat.failure.retry")}
              </button>
              {kind !== "network" && (
                <button
                  type="button"
                  onClick={() => workbench.openSettings({ page: "models", depth: 1 })}
                >
                  {t("chat.failure.otherModel")}
                </button>
              )}
            </div>
          )}
          {asking && (
            <div className={styles.confirm} data-testid="chat-retry-confirm">
              <p>{t("chat.failure.retryChanged", { count: changed })}</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    chat.undoTask(task);
                    void chat.retry();
                  }}
                >
                  {t("chat.failure.undoThenRetry")}
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
                <button type="button" onClick={() => setAsking(false)}>
                  {t("chat.failure.cancel")}
                </button>
              </div>
            </div>
          )}
          {detail && (
            <details className={styles.raw}>
              <summary>{t("chat.failure.details")}</summary>
              <p className={styles.muted}>{detail}</p>
            </details>
          )}
        </div>
      );
    }
    default:
      return null;
  }
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
