import type { ToolCallEntry, ToolEntry } from "@animaquill/agent";
import { Check, ChevronDown, ChevronRight, LoaderCircle, Minus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { useOpened } from "./expanded.ts";
import {
  approvalText,
  argFields,
  heldWhy,
  toolErrorCode,
  toolSummary,
  type Names,
  type Say,
} from "./toolSummary.ts";
import { durationText } from "./turns.ts";

/** How many lines of a result show before "show all". */
const RESULT_LINES = 12;
/** A call quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;

/** What a change that did not happen says of why, opened, see `heldWhy`. */
const HELD_TEXT = {
  plan: "chat.toolText.held",
  declined: "chat.toolText.heldDeclined",
  afterDeclined: "chat.toolText.heldAfterDeclined",
  stopped: "chat.toolText.heldStopped",
} as const;

/** A command by its type, as people know it from the command system: the tools before these. */
const commandOf = (tool: string) => tool.replaceAll("_", ".");

/**
 * A call of a tool in one line: whether it runs, went through or failed, the tool in words, what
 * it was about, how long it took. Open, its arguments as "name: value" lines and what it gave AI;
 * a failure says why in words first. A failed one is red, and folded like the rest.
 */
export function ToolRow({
  call,
  result,
  running,
  names,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
  /** When it began, while it runs. */
  readonly running: number | undefined;
  readonly names: Names;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const why = heldWhy(result);
  const held = why !== undefined;
  const code = result && !result.ok && !held ? toolErrorCode(result) : undefined;
  const changedWhileAsked = result?.data?.changedWhileAsked === true;
  // Not open by itself where it failed: AI mostly reads again and goes on (chat-panel.md 5.3).
  const [open, setOpen] = useOpened(call.id, false);
  const now = useNow(running !== undefined);
  // To another conversation: by its name, as the result says it, else as AI wrote it.
  const to =
    call.name === "aq_send" || call.name === "aq_agents_notify"
      ? agentNameOf(result, call.args.to)
      : undefined;
  const doing =
    to !== undefined
      ? say(`chat.agents.doing.${call.name}`, { name: to })
      : say(`chat.tool.${call.name}`, { defaultValue: commandOf(call.name) });
  // What it does while it runs; what it did once done; that it did not happen, and why, where it
  // did not; that it did not work.
  const label =
    result === undefined
      ? doing
      : why
        ? say(`chat.heldStep.${why}`)
        : result.ok
          ? to !== undefined
            ? say(`chat.agents.done.${sentHow(call.name, result)}`, { name: to })
            : say(`chat.toolDone.${call.name}`, { defaultValue: commandOf(call.name) })
          : say("chat.failedStep", { name: doing });
  // Failed: why, in words, on the line itself; what it was about follows once open.
  const reason =
    result && !result.ok && !held
      ? say(`chat.toolErrors.${changedWhileAsked ? "changedWhileAsked" : (code ?? "other")}`, {
          defaultValue: say("chat.toolErrors.other", { code: code ?? "?" }),
          code: code ?? "?",
        })
      : undefined;
  // What people answered, where they allowed it, before the rest of the line.
  const answered = held ? undefined : approvalText(say, result);
  const summary =
    reason ??
    [answered, toolSummary(say, call, result, names)]
      .filter((part) => part !== undefined && part !== "")
      .join(" · ");
  const state =
    result === undefined
      ? running !== undefined
        ? "running"
        : "waiting"
      : result.ok
        ? "ok"
        : held
          ? "held"
          : "failed";
  const ms =
    result?.startedAt !== undefined
      ? result.at - result.startedAt
      : running !== undefined
        ? now - running
        : undefined;
  return (
    <div className={styles.tool} data-state={state} data-testid="chat-tool">
      <button
        type="button"
        className={styles.toolHead}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={styles.toolIcon}>
          {state === "ok" && <Check size={12} aria-label={t("chat.toolOk")} />}
          {state === "failed" && <X size={12} aria-label={t("chat.toolFailed")} />}
          {state === "held" && <Minus size={12} aria-label={t("chat.toolHeld")} />}
          {(state === "running" || state === "waiting") && (
            <LoaderCircle size={12} className={styles.spin} aria-label={t("chat.running")} />
          )}
        </span>
        <span className={styles.toolName} title={label}>
          {label}
        </span>
        <span className={styles.toolArgs} data-testid="chat-tool-summary" title={summary}>
          {summary}
        </span>
        {ms !== undefined && ms >= SHOWN_MS && (
          <span className={styles.toolMs}>{durationText(say, ms, true)}</span>
        )}
        <span className={styles.chevron}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && <ToolBody call={call} result={result} />}
    </div>
  );
}

function ToolBody({
  call,
  result,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const [all, setAll] = useState(false);
  const fields = argFields(call.args);
  const code = result && toolErrorCode(result);
  const why = heldWhy(result);
  // People changed the project while they were asked about this change (S-D4).
  const changedWhileAsked = result?.data?.changedWhileAsked === true;
  const lines = result?.text.split("\n") ?? [];
  const shown = all ? lines : lines.slice(0, RESULT_LINES);
  return (
    <div className={styles.toolBody} data-testid="chat-tool-body">
      {fields.length > 0 && (
        <dl className={styles.fields}>
          {fields.map((field) => (
            <div
              key={field.key}
              className={styles.field}
              data-multiline={field.multiline || undefined}
            >
              <dt>{field.key}：</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {why && (
        <p className={styles.muted} data-testid="chat-tool-held">
          {t(HELD_TEXT[why])}
        </p>
      )}
      {result && !result.ok && !why && (
        <>
          <p className={styles.toolError} data-testid="chat-tool-error">
            {t("chat.toolText.failed", {
              reason: say(
                `chat.toolErrors.${changedWhileAsked ? "changedWhileAsked" : (code ?? "other")}`,
                {
                  defaultValue: say("chat.toolErrors.other", { code: code ?? "?" }),
                  code: code ?? "?",
                },
              ),
            })}
          </p>
          <details className={styles.raw}>
            <summary>{t("chat.toolText.forAi")}</summary>
            <pre>{result.text}</pre>
          </details>
        </>
      )}
      {result?.ok && (
        <>
          <div className={styles.muted}>{t("chat.result")}</div>
          <pre>{shown.join("\n")}</pre>
          {lines.length > RESULT_LINES && (
            <button type="button" className={styles.more} onClick={() => setAll(!all)}>
              {all
                ? t("chat.toolText.showLess")
                : t("chat.toolText.showAll", { count: lines.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The name of another conversation a call was to, as its result says it, else as AI wrote it. */
function agentNameOf(result: ToolEntry | undefined, given: unknown): string {
  const to = result?.data?.to;
  if (
    typeof to === "object" &&
    to !== null &&
    typeof (to as { name?: unknown }).name === "string"
  ) {
    return (to as { name: string }).name;
  }
  return typeof given === "string" ? given.replace(/^aq:\/\/agent\//, "") : "";
}

/** How a message went, as the line of its step says: sent, a turn, waits for people… */
function sentHow(tool: string, result: ToolEntry): string {
  if (tool === "aq_agents_notify") return "notify";
  const outcome = result.data?.outcome as { sent?: string; until?: string } | undefined;
  return outcome?.sent === "waits" ? `waits.${outcome.until ?? "people"}` : "sent";
}
