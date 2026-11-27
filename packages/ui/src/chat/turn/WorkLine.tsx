import type { Conversation, RunningTask, ToolEntry } from "@animaquill/agent";
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { useNow } from "../clock.ts";
import { useOpened } from "../expanded.ts";
import { ListenRow } from "../ListenRow.tsx";
import { LookRow, LookThumbs } from "../LookRow.tsx";
import { Markdown } from "../markdown/Markdown.tsx";
import { RefChip } from "../RefChip.tsx";
import { placesOf, summaryOf } from "../summary.ts";
import { useChatUi } from "../ui.ts";
import { ToolRow } from "../ToolRow.tsx";
import type { Names, Say } from "../toolSummary.ts";
import { durationText, type Step, type Turn } from "../turns.ts";
import { dollars, tokens, usageOf } from "../usage.ts";
import { liveThinking, liveThinkingSince, livePhase, useLive } from "../useLive.ts";
import { MessageStep } from "./AgentMessage.tsx";
import styles from "./turn.module.css";
import {
  LISTEN_TOOL,
  LOOK_TOOL,
  phaseKey,
  phaseOf,
  STEADY_MS,
  workDone,
  type Phase,
} from "./work.ts";

/** A link of the editor in what AI wrote: a block, as in people's words. */
const appLink = (href: string, label: string) => <RefChip chatRef={{ href, label }} />;

/** A thought quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;

/**
 * The work of a turn, in one line before its answer (docs/design/chat-panel.md of AnimaQuill Cloud,
 * 5.2): while it runs, what it does now and for how long; once done, "想了 8 秒 · 做了 5 步 · 改了 3
 * 处 · $0.04"; stopped, "停了 · 做了 3 步". A click opens the steps, one a line on a thin line,
 * also while it runs, as they come. Folded, the pictures AI looked at hang under it.
 */
export function WorkLine(props: {
  readonly turn: Turn;
  readonly running: RunningTask | undefined;
  readonly conversation: Conversation;
  readonly stopped: boolean;
  readonly names: Names;
  /** Where the answer had another model pack than the one before it. */
  readonly switches: readonly string[];
  readonly modelName: (model: string) => string;
}) {
  const { turn, running } = props;
  const { ai } = useWorkbench();
  // Where people want thinking in full, the steps of a turn that runs come open, to see it come.
  const expand = useSyncExternalStore(ai.subscribe, ai.getSnapshot).expandThinking;
  const [open, setOpen] = useOpened(`${turn.task}/process`, running !== undefined && expand);
  const looks = turn.steps.flatMap((step) =>
    step.kind === "tool" && step.call.name === LOOK_TOOL && step.result
      ? [{ call: step.call, result: step.result as ToolEntry }]
      : [],
  );
  return (
    <div className={styles.work} data-testid="chat-work-wrap">
      {running ? (
        <RunningHead
          running={running}
          conversation={props.conversation}
          names={props.names}
          open={open}
          onToggle={() => setOpen(!open)}
          changed={placesOf(summaryOf(turn.entries))}
        />
      ) : (
        <DoneHead
          turn={turn}
          opens={turn.steps.length > 0 || props.switches.length > 0}
          stopped={props.stopped}
          open={open}
          onToggle={() => setOpen(!open)}
          modelName={props.modelName}
        />
      )}
      {!open && looks.length > 0 && <LookThumbs looks={looks} onMore={() => setOpen(true)} />}
      {open && (
        <div className={styles.steps} data-testid="chat-steps">
          {props.switches.map((line) => (
            <p key={line} className={styles.stepNote} data-testid="chat-pack-switch">
              {line}
            </p>
          ))}
          {turn.steps.map((step) => (
            <StepView key={step.id} step={step} running={running} names={props.names} />
          ))}
          {running && <LiveThinking conversation={props.conversation} />}
        </div>
      )}
    </div>
  );
}

/** The line while the turn runs: what it does now, for how long; what it waits on, in colour. */
function RunningHead(props: {
  readonly running: RunningTask;
  readonly conversation: Conversation;
  readonly names: Names;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly changed: number;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const { looks, chat } = useWorkbench();
  const ui = useChatUi();
  const look = useSyncExternalStore(looks.subscribe, looks.getSnapshot);
  const { approvals } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const live = useLive(props.conversation.live, livePhase);
  const now = useNow(true);
  const [waitedOn, setWaitedOn] = useState(0);
  const { running } = props;
  const pending = approvals.find(({ task }) => task === running.task);
  const newest = phaseOf(say, {
    running,
    live,
    heardAt: Math.max(props.conversation.live.getState().heardAt, waitedOn),
    look,
    approving: pending ? placesOf(summaryOf([toolEntryOf(pending)])) : undefined,
    now,
    names: props.names,
  });
  // Each state stays a moment before the next one shows: quick steps do not flicker by, and the
  // last one is never lost.
  const key = phaseKey(newest);
  const latest = useRef(newest);
  useEffect(() => {
    latest.current = newest;
  });
  const [held, setHeld] = useState<
    { readonly key: string; readonly phase: Phase; readonly since: number } | undefined
  >();
  useEffect(() => {
    if (held?.key === key) return;
    const take = () =>
      setHeld({ key: phaseKey(latest.current), phase: latest.current, since: Date.now() });
    const left = held ? held.since + STEADY_MS - Date.now() : 0;
    const timer = setTimeout(take, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [key, held]);
  const phase = held && held.key !== key ? held.phase : newest;
  const whole = phase.tail ? `${phase.text} · ${phase.tail}` : phase.text;
  return (
    <div
      className={styles.head}
      data-testid="chat-work"
      data-state={phase.kind}
      data-tone={phase.tone}
    >
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={props.open}
        title={whole}
        onClick={props.onToggle}
      >
        <span className={styles.icon} aria-hidden>
          {phase.tone === "warn" ? (
            <TriangleAlert size={12} />
          ) : (
            <LoaderCircle size={12} className={styles.spin} />
          )}
        </span>
        <span className={styles.text} data-testid="chat-work-text">
          {phase.text}
          {props.changed > 0 && ` · ${t("chat.work.changed", { count: props.changed })}`}
        </span>
        {/* A countdown is what an ellipsis never takes away. */}
        {phase.tail && (
          <span className={styles.tail} data-testid="chat-work-tail">
            {phase.tail}
          </span>
        )}
        <span className={styles.grow} />
        <span className={styles.time} aria-hidden data-testid="chat-work-time">
          {durationText(say, now - running.startedAt)}
        </span>
        <span className={styles.chevron} aria-hidden>
          {props.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {phase.kind === "approve" && (
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            aria-label={t("chat.phase.toWait")}
            title={t("chat.phase.toWait")}
            data-testid="chat-work-to-wait"
            onClick={() => ui.scrollToWait(running.task)}
          >
            <ArrowDown size={12} aria-hidden />
          </button>
        </span>
      )}
      {phase.kind === "quiet" && (
        <span className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => setWaitedOn(Date.now())}>
            {t("chat.phase.keepWaiting")}
          </button>
          <button type="button" className={styles.action} onClick={() => props.conversation.stop()}>
            {t("chat.stop")}
          </button>
        </span>
      )}
      {/* What it does, said once each time it changes, not with each second. */}
      <span className={styles.live} aria-live="polite">
        {phase.said}
      </span>
    </div>
  );
}

/** A change waiting for people, as the card of changes would count it. */
function toolEntryOf(pending: {
  readonly id: string;
  readonly request: { readonly tool: string; readonly changes: readonly unknown[] };
}): ToolEntry {
  return {
    role: "tool",
    call: pending.id,
    name: pending.request.tool,
    ok: true,
    text: "",
    at: 0,
    data: { changes: pending.request.changes },
  };
}

/** The line of a turn that is over. */
function DoneHead(props: {
  readonly turn: Turn;
  /** There are steps, or lines of the model pack, to open to. */
  readonly opens: boolean;
  readonly stopped: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly modelName: (model: string) => string;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const { turn } = props;
  const places = placesOf(summaryOf(turn.entries));
  const done = workDone(say, turn, places, props.stopped);
  const usage = usageOf(turn.entries);
  const names = turn.models.map(props.modelName);
  const model =
    names.length > 1
      ? t("chat.models", { from: names.slice(0, -1).join(" → "), to: names.at(-1) })
      : names[0];
  const detail = [
    model,
    ...(usage.answers > 0
      ? [
          t("chat.work.tokens", {
            input: tokens(usage.input + usage.cacheRead + usage.cacheWrite),
            output: tokens(usage.output),
            cacheRead: tokens(usage.cacheRead),
          }),
        ]
      : []),
    ...(turn.ms !== undefined ? [durationText(say, turn.ms, true)] : []),
  ]
    .filter(Boolean)
    .join(" · ");
  const parts = [
    ...(props.stopped ? [t("chat.work.stopped")] : []),
    done.time,
    done.steps,
    done.changed,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0 && !done.failed && usage.cost === undefined) return null;
  // The whole line and what it took, on pointing at it: also where it has no price, or is narrow.
  const whole = [
    [...parts, ...(done.failed ? [done.failed] : [])].join(" · "),
    detail,
    ...(usage.cost !== undefined ? [dollars(usage.cost)] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={styles.head}
      data-testid="chat-work"
      data-state={props.stopped ? "stopped" : "done"}
    >
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={props.open}
        disabled={!props.opens}
        title={whole}
        onClick={props.onToggle}
      >
        <span className={styles.icon} aria-hidden>
          {props.stopped ? <Square size={10} fill="currentColor" /> : <Sparkles size={12} />}
        </span>
        <span className={styles.text} data-testid="chat-work-text">
          {parts.join(" · ")}
        </span>
        {/* What did not work is never what an ellipsis takes away. */}
        {done.failed && (
          <span className={styles.failed} data-testid="chat-work-failed">
            {parts.length > 0 ? "· " : ""}
            {done.failed}
          </span>
        )}
        <span className={styles.grow} />
        {usage.cost !== undefined && (
          <span className={styles.cost} data-testid="chat-work-cost">
            {dollars(usage.cost)}
          </span>
        )}
        {props.opens && (
          <span className={styles.chevron} aria-hidden>
            {props.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {/* What it took, for the one who asks: on the line, not the second one there was before. */}
      <span className={styles.srOnly} data-testid="chat-work-detail">
        {detail}
        {usage.cost !== undefined && ` · ${dollars(usage.cost)}`}
      </span>
    </div>
  );
}

/** One step: a thought, words between tools, or a call of a tool, in the past tense once done. */
export const StepView = memo(function StepView({
  step,
  running,
  names,
}: {
  readonly step: Step;
  readonly running: RunningTask | undefined;
  readonly names: Names;
}) {
  const runningSince = (id: string) =>
    running?.tool?.id === id ? running.tool.startedAt : undefined;
  switch (step.kind) {
    case "thinking":
      return <ThinkingStep id={step.id} text={step.text} ms={step.ms} />;
    case "said":
      return <SaidStep id={step.id} text={step.text} />;
    case "message":
      return <MessageStep id={step.id} from={step.from} text={step.text} />;
    case "tool":
      if (step.call.name === LOOK_TOOL) {
        return (
          <LookRow
            call={step.call}
            result={step.result}
            running={runningSince(step.call.id)}
            names={names}
          />
        );
      }
      if (step.call.name === LISTEN_TOOL) {
        return (
          <ListenRow
            call={step.call}
            result={step.result}
            running={runningSince(step.call.id)}
            names={names}
          />
        );
      }
      return (
        <ToolRow
          call={step.call}
          result={step.result}
          running={runningSince(step.call.id)}
          names={names}
        />
      );
  }
});

/** What the model thought: its first line, open to all of it. */
function ThinkingStep({
  id,
  text,
  ms,
}: {
  readonly id: string;
  readonly text: string;
  readonly ms: number | undefined;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const say = t as unknown as Say;
  // Open from the start where people want thinking in full, see `AiSettings.expandThinking`.
  const expand = useSyncExternalStore(ai.subscribe, ai.getSnapshot).expandThinking;
  const [open, setOpen] = useOpened(id, expand);
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className={styles.step} data-testid="chat-thinking">
      <button
        type="button"
        className={styles.stepHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Lightbulb size={12} aria-hidden className={styles.stepIcon} />
        <span className={styles.stepName}>{t("chat.work.thinking")}</span>
        <span className={styles.stepSummary}>{first}</span>
        {ms !== undefined && ms >= SHOWN_MS && (
          <span className={styles.stepTime}>{durationText(say, ms, true)}</span>
        )}
      </button>
      {open && <div className={styles.stepBody}>{text}</div>}
    </div>
  );
}

/** Words of the model between two tools: a line, open to all of it as Markdown. */
function SaidStep({ id, text }: { readonly id: string; readonly text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useOpened(id, false);
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className={styles.step} data-testid="chat-said-step">
      <button
        type="button"
        className={styles.stepHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MessageSquare size={12} aria-hidden className={styles.stepIcon} />
        <span className={styles.stepName}>{t("chat.work.said")}</span>
        {!open && <span className={styles.stepSummary}>{first}</span>}
      </button>
      {open && (
        <div className={styles.saidBody} data-testid="chat-said">
          <Markdown text={text} renderAppLink={appLink} />
        </div>
      )}
    </div>
  );
}

/** The thinking on its way, as the last step while the steps are open. */
function LiveThinking({ conversation }: { readonly conversation: Conversation }) {
  const { ai } = useWorkbench();
  const expand = useSyncExternalStore(ai.subscribe, ai.getSnapshot).expandThinking;
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const thinking = useLive(conversation.live, liveThinking);
  const since = useLive(conversation.live, liveThinkingSince);
  const now = useNow(since !== undefined);
  if (thinking.trim() === "") return null;
  const last =
    thinking
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1) ?? "";
  return (
    <div className={styles.step} data-testid="chat-thinking" data-live="">
      <div className={styles.stepHead}>
        <Lightbulb size={12} aria-hidden className={styles.stepIcon} />
        <span className={styles.stepName}>{t("chat.work.thinkingNow")}</span>
        <span className={styles.stepSummary}>{expand ? "" : last}</span>
        {since !== undefined && (
          <span className={styles.stepTime}>{durationText(say, now - since)}</span>
        )}
      </div>
      {expand && <div className={styles.stepBody}>{thinking}</div>}
    </div>
  );
}
